# Prompt Cache 原理：为什么命中缓存可以节省计算？

> 本文分两部分：
> 1. **底层原理**：KV Cache 与 Transformer 推理机制
> 2. **Claude Code 实现**：动静态分区设计与源码分析

---

## 一、底层原理：KV Cache

### 1.1 Transformer 推理的计算瓶颈

每次调用 LLM，模型需要对输入的每一个 token 计算 **Attention**：

```
Attention(Q, K, V) = softmax(QK^T / √d) · V
```

对于输入序列中的每个 token，都要计算它与**所有其他 token** 的关联权重。这个操作的计算量是 **O(n²)**，n 是 token 数量。

system prompt 有 10,000 tokens，对话历史有 5,000 tokens，每轮推理都要把这 15,000 tokens 全部重新算一遍——这是主要的计算开销。

### 1.2 KV Cache 的原理

Transformer 每一层都会把每个 token 变换成 **Key 向量**和 **Value 向量**（K/V）。计算 Attention 时需要用到所有已有 token 的 K/V。

关键洞察：**只要输入内容不变，同一个 token 在同一个位置上，每次算出来的 K/V 完全一样**。重新计算是纯粹的浪费。

Anthropic 服务端把 prompt 的 K/V 向量存下来：

```
第一次请求（cache miss）：
  计算 system prompt 所有 token 的 K/V → 存到显存/内存
  计算 Attention → 输出
  耗时：正常推理时间

第二次请求（cache hit，system prompt 未变）：
  直接读取已存的 K/V，跳过重新计算这步
  只计算新增 token（对话新内容）的 K/V
  耗时：大幅缩短
```

### 1.3 为什么必须是"前缀"

KV Cache 只能缓存**从头开始的连续前缀**，不能缓存中间某段。

原因是 Attention 的**因果掩码（causal mask）**：每个 token 只能看到它之前的 token。token 的 K/V 值依赖于它的位置和前面所有 token 的上下文。如果前面某个 token 变了，后面所有 token 的 K/V 全都失效，必须重算。

```
system prompt（静态）| 动态内容 | 对话历史
─────────────────────────────────────────→ 时间方向

如果动态内容变了：
  静态部分的 KV Cache ✅ 还有效（前面没变）
  动态内容之后的 KV Cache ❌ 全部失效（前缀变了）
```

这正是 Claude Code 把静态内容放前面、动态内容放后面的根本原因。

### 1.4 费用为什么只有 1/10

Prompt caching 的计费分两种：

| 类型 | 含义 | 费用 |
|------|------|------|
| `cache_creation_input_tokens` | 第一次建立缓存，完整计算 K/V | 正常 input 价格（或略高） |
| `cache_read_input_tokens` | 命中缓存，从存储读取 K/V | 约正常 input 的 **1/10** |

1/10 这个比例对应的是：从存储读 K/V 的带宽成本，远低于重新做矩阵乘法的算力成本。

> **本质一句话**：prompt caching 就是把 Transformer 推理中最贵的矩阵乘法（计算 K/V）的结果缓存起来，命中时直接读内存，省掉重复的 GPU 算力。

---

## 二、Claude Code 实现：动静态分区设计

### 2.1 问题：动态内容夹在中间会破坏缓存

system prompt 里有些内容每次都一样（静态），有些每次都会变（动态）：

```
静态（进程内永不变）：
  - "You are Claude Code..." 身份介绍
  - 任务执行指南、工具使用规范、风格规范等

动态（每会话或每轮变化）：
  - 当前启用的技能/工具列表
  - 记忆内容（MEMORY.md，文件可能被修改）
  - 环境信息（日期、平台、shell）
  - MCP 服务器指令（服务器连接/断开时变化）
```

如果把动态内容夹在静态内容中间，动态内容一变，后面所有静态内容的缓存就全失效——等于白缓存。

### 2.2 解决方案：边界标记

在静态段末尾插入一个边界标记，把 prompt 切成两段：

```typescript
// src/constants/prompts.ts:114
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// src/constants/prompts.ts:595-612
return [
  // ── 静态段（边界之前，全局缓存）────────────────
  getSimpleIntroSection(),       // "You are Claude Code..."
  getSimpleSystemSection(),
  getSimpleDoingTasksSection(),
  getActionsSection(),
  getUsingYourToolsSection(),
  getSimpleToneAndStyleSection(),
  getOutputEfficiencySection(),

  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,  // ← 分界线

  // ── 动态段（边界之后，不缓存）──────────────────
  ...resolvedDynamicSections,      // 技能列表、记忆、环境信息等
]
```

### 2.3 分区切割：`splitSysPromptPrefix()`

`src/utils/api.ts:321` 读取边界标记，把 prompt 切成不同 `cacheScope` 的 blocks：

```typescript
// src/utils/api.ts:80
export type CacheScope = 'global' | 'org'
export type SystemPromptBlock = {
  text: string
  cacheScope: CacheScope | null  // null = 不缓存
}
```

**全局缓存模式**（直连 api.anthropic.com，`src/utils/api.ts:308-313`）：

```
block 1: attribution header        → cacheScope: null    不缓存（每次变）
block 2: "You are Claude Code..."  → cacheScope: null    identity prefix 单独处理
block 3: 静态段（边界之前）         → cacheScope: 'global' ← 跨用户全局缓存！
block 4: 动态段（边界之后）         → cacheScope: null    不缓存
```

**有 MCP 工具时降级**（`src/services/api/claude.ts:1212`）：

MCP 工具的 schema 是用户私有的，不能全局共享，整个 system prompt 降级为 `org` 级缓存：

```typescript
const needsToolBasedCacheMarker =
  useGlobalCacheFeature &&
  filteredTools.some(t => t.isMcp === true && !willDefer(t))
// → 有 MCP 工具时，skipGlobalCacheForSystemPrompt=true，全部用 org scope
```

### 2.4 转为 API 参数：`buildSystemPromptBlocks()`

`src/services/api/claude.ts:3268` 把 blocks 转为带 `cache_control` 的 `TextBlockParam[]` 发给 API：

```typescript
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: { skipGlobalCacheForSystemPrompt?: boolean; querySource?: QuerySource },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => ({
    type: 'text' as const,
    text: block.text,
    ...(enablePromptCaching && block.cacheScope !== null && {
      cache_control: getCacheControl({
        scope: block.cacheScope,   // 'global' 或 'org'
        querySource: options?.querySource,
      }),
    }),
  }))
}
```

`getCacheControl()` 的返回值（`src/services/api/claude.ts:358`）：

```typescript
export function getCacheControl({ scope, querySource }) {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),  // 1h TTL（订阅用户）
    ...(scope === 'global' && { scope }),                  // global scope
  }
}
```

### 2.5 两级缓存范围

| `cacheScope` | 共享范围 | 使用条件 | 命中率 |
|---|---|---|---|
| `'global'` | 跨所有用户 | 直连 api.anthropic.com | 极高（全球共享） |
| `'org'` | 同一组织内 | 3P 提供商或有 MCP 工具 | 中等 |
| `null` | 不缓存 | attribution header、动态段 | — |

全局缓存的条件（`src/utils/betas.ts:227`）：

```typescript
export function shouldUseGlobalCacheScope(): boolean {
  return (
    getAPIProvider() === 'firstParty' &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}
```

### 2.6 TTL：5 分钟 vs 1 小时

缓存有两种 TTL（`src/services/api/claude.ts:393-434`）：

- **默认 5 分钟**：标准缓存 TTL
- **1 小时**：仅对 Anthropic 员工或 claude.ai 订阅用户且未超额时启用

1 小时 TTL 的资格在会话开始时**锁定**（`src/services/api/claude.ts:403`），防止中途超额导致 TTL 切换从而破坏缓存——每次 TTL 变化约损失 20K tokens 的缓存。

同理，Beta header（AFK 模式、fast mode 等）也在首次发送后锁定（`src/services/api/claude.ts:1407`），防止 mid-session 切换破坏 cache key。

### 2.7 `getSessionSpecificGuidanceSection()` 为什么必须在边界之后

`src/constants/prompts.ts:343` 的注释解释了这个设计决策：

```typescript
/**
 * Session-variant guidance that would fragment the cacheScope:'global'
 * prefix if placed before SYSTEM_PROMPT_DYNAMIC_BOUNDARY. Each conditional
 * here is a runtime bit that would otherwise multiply the Blake2b prefix
 * hash variants (2^N). See PR #24490, #24171 for the same bug class.
 */
function getSessionSpecificGuidanceSection(
  enabledTools: Set<string>,
  skillToolCommands: Command[],
): string | null {
```

这段内容依赖运行时状态（哪些工具启用、有哪些技能），每个用户的值都不同。如果放在边界之前，会产生 2^N 种不同的静态前缀，全局缓存命中率趋近于零。

---

## 三、完整请求链路

```
Claude Code 构建请求
  system: [
    { text: "x-anthropic-billing-header...",  cache_control: null },
    { text: "You are Claude Code...",          cache_control: null },
    { text: "静态段 ~8,000 tokens",            cache_control: { type:'ephemeral', scope:'global' } },
    { text: "动态段 ~3,000 tokens",            (无 cache_control) },
  ]
  messages: [对话历史]

            ↓

Anthropic 服务端
  ┌─ 检查"静态段"的 KV Cache
  │   ├─ cache hit  → 直接读取 K/V 向量，跳过矩阵乘法
  │   │              计费：cache_read（约 1/10 价格）
  │   └─ cache miss → 正常计算，存储 K/V
  │                  计费：正常 input 价格
  │
  └─ 对"动态段"和"对话历史"正常计算（每次都算）

            ↓

返回结果 + usage:
  {
    cache_read_input_tokens: 8000,    ← 这部分省了 90% 费用
    cache_creation_input_tokens: 0,
    input_tokens: 3000 + 对话历史,    ← 这部分正常计费
    output_tokens: ...
  }
```

**全局缓存的额外收益**：静态 system prompt 对所有 Claude Code 用户完全一样。Anthropic 在服务端只保存一份全局 KV Cache，所有用户共享：

```
用户 A 第一次请求 → cache miss → 计算并存储 KV Cache（全局）
用户 B 第一次请求 → cache hit  → 直接读取用户 A 建立的缓存
用户 C 第一次请求 → cache hit  → 同上
全球所有 Claude Code 用户 → 几乎永远 cache hit
```

---

## 四、关键文件索引

| 文件 | 符号 | 行号 | 说明 |
|------|------|------|------|
| `src/constants/prompts.ts` | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | 114 | 静动态分界标记 |
| `src/constants/prompts.ts` | `getSessionSpecificGuidanceSection()` | 352 | 必须在边界之后的动态段 |
| `src/constants/prompts.ts` | `getSystemPrompt()` 中的边界插入 | 612 | `shouldUseGlobalCacheScope()` 时插入边界 |
| `src/utils/api.ts` | `CacheScope` | 80 | `'global' \| 'org'` 类型定义 |
| `src/utils/api.ts` | `SystemPromptBlock` | 81 | `{ text, cacheScope }` 类型 |
| `src/utils/api.ts` | `splitSysPromptPrefix()` | 321 | 按边界切割 prompt，分配 cacheScope |
| `src/utils/betas.ts` | `shouldUseGlobalCacheScope()` | 227 | 是否启用 global scope（仅 1P） |
| `src/services/api/claude.ts` | `getCacheControl()` | 358 | 构建 `cache_control` 参数 |
| `src/services/api/claude.ts` | `should1hCacheTTL()` | 393 | 1h TTL 资格判断（订阅用户） |
| `src/services/api/claude.ts` | `needsToolBasedCacheMarker` | 1212 | MCP 工具存在时降级为 org scope |
| `src/services/api/claude.ts` | `buildSystemPromptBlocks()` | 3268 | 转为带 `cache_control` 的 `TextBlockParam[]` |
