# ToolSearchTool 设计文档：工具延迟加载与动态发现

> 基于 Claude Code v2.1.88 源码，含函数级代码注释与完整架构说明

---

## 目录

1. [核心问题：工具太多怎么办？](#1-核心问题工具太多怎么办)
2. [整体架构](#2-整体架构)
3. [延迟工具判断：isDeferredTool](#3-延迟工具判断isdeferredtool)
4. [工具搜索模式与启用条件](#4-工具搜索模式与启用条件)
5. [ToolSearchTool 核心实现](#5-toolsearchtool-核心实现)
6. [关键词搜索算法：searchToolsWithKeywords](#6-关键词搜索算法searchtoolswithkeywords)
7. [结果格式：tool_reference 块](#7-结果格式tool_reference-块)
8. [已发现工具追踪：extractDiscoveredToolNames](#8-已发现工具追踪extractdiscoveredtoolnames)
9. [增量通知机制：getDeferredToolsDelta](#9-增量通知机制getdeferredtoolsdelta)
10. [关键常量与配置](#10-关键常量与配置)

---

## 1. 核心问题：工具太多怎么办？

Claude Code 支持 MCP 服务器，每个 MCP 服务器可能暴露数十甚至上百个工具。如果把所有工具的完整描述（名称 + 参数 Schema + 描述文本）都放进系统提示，会产生巨大的 token 开销：

- 一个 MCP 工具描述平均约 500-2000 字符
- 10 个 MCP 服务器 × 20 个工具 = 200 个工具，可能消耗上万 token
- 这些 token 出现在每次 API 调用中，即使大多数工具本次根本不会被用到

**解决方案：工具延迟加载（Deferred Tool Loading）**

```
传统方式：                    延迟加载方式：
┌─────────────────────┐      ┌─────────────────────┐
│ 系统提示             │      │ 系统提示             │
│  Tool A (完整 Schema)│      │  ToolSearch (完整)   │
│  Tool B (完整 Schema)│      │  [deferred tool 名称]│
│  Tool C (完整 Schema)│      │                     │
│  ...200 个工具...   │      │ 按需加载：           │
└─────────────────────┘      │ ToolSearch("database")│
  每次调用消耗 10K+ token    │  → mcp__postgres__query│
                             └─────────────────────┘
                               绝大多数调用只需几百 token
```

---

## 2. 整体架构

```
初始化阶段（main.tsx / query.ts）
  │
  ├── isToolSearchEnabled() ────────────── toolSearch.ts
  │   ├── 检查模型是否支持 tool_reference
  │   ├── 检查 ENABLE_TOOL_SEARCH 环境变量
  │   └── tst-auto 模式：检查延迟工具 token 是否超阈值
  │
  ├── 构建 API 请求时：
  │   ├── isDeferredTool(t) 为 true 的工具 → defer_loading: true
  │   └── 只发送工具名，不发送完整 Schema
  │
  └── 在 <system-reminder> 或 <available-deferred-tools> 中通告工具名列表

运行时（模型执行阶段）
  │
  ├── 模型调用 ToolSearch({ query: "database" })
  │
  ├── ToolSearchTool.call()
  │   ├── select: 前缀 → 直接按名称查找
  │   └── 关键词 → searchToolsWithKeywords()
  │       ├── 精确名称匹配（快速路径）
  │       ├── MCP 前缀匹配
  │       └── 加权关键词评分
  │
  ├── 返回 tool_reference 块（而非文本）
  │   └── { type: 'tool_reference', tool_name: 'mcp__postgres__query' }
  │
  └── API 服务端展开 tool_reference → 模型获得完整 Schema，可直接调用工具

压缩阶段（compact.ts）
  └── 压缩前扫描 extractDiscoveredToolNames()
      └── 将已发现工具名存入 compactMetadata.preCompactDiscoveredTools
          （压缩后不再有 tool_reference 消息，但工具仍需保持可用）
```

---

## 3. 延迟工具判断：isDeferredTool

**文件**：`src/tools/ToolSearchTool/prompt.ts:62`

```typescript
/**
 * 判断一个工具是否应该被延迟加载（不在初始 API 请求中发送完整 Schema）。
 *
 * 判断逻辑（按优先级）：
 *   1. alwaysLoad === true → 永远不延迟（MCP 工具可通过 _meta['anthropic/alwaysLoad'] 选择退出）
 *   2. isMcp === true → 总是延迟（MCP 工具都是工作流相关的，按需加载）
 *   3. 工具名 === ToolSearch → 永远不延迟（模型需要它来加载其他工具）
 *   4. FORK_SUBAGENT 模式下的 AgentTool → 不延迟（第一轮必须可用）
 *   5. KAIROS/KAIROS_BRIEF 下的 BriefTool → 不延迟（主要通信渠道）
 *   6. KAIROS 下的 SendUserFileTool → 不延迟（文件传输通信渠道）
 *   7. shouldDefer === true → 延迟
 *   8. 其他 → 不延迟
 */
export function isDeferredTool(tool: Tool): boolean {
  // 优先级最高：MCP 工具通过 _meta['anthropic/alwaysLoad'] 选择退出延迟
  if (tool.alwaysLoad === true) return false

  // MCP 工具总是延迟（工作流相关，不是每次都需要）
  if (tool.isMcp === true) return true

  // ToolSearch 自身不延迟——模型需要它来加载其他工具
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // Fork 子 Agent 模式：AgentTool 第一轮必须可用，不能等 ToolSearch
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    const m = require('../AgentTool/forkSubagent.js')
    if (m.isForkSubagentEnabled()) return false
  }

  // KAIROS 系列：BriefTool 是主要通信渠道，必须立即可用
  if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && BRIEF_TOOL_NAME && tool.name === BRIEF_TOOL_NAME) {
    return false
  }

  // KAIROS: SendUserFileTool（REPLBridge 激活时）不延迟
  if (feature('KAIROS') && SEND_USER_FILE_TOOL_NAME && tool.name === SEND_USER_FILE_TOOL_NAME && isReplBridgeActive()) {
    return false
  }

  // 工具自身声明延迟
  return tool.shouldDefer === true
}
```

---

## 4. 工具搜索模式与启用条件

**文件**：`src/utils/toolSearch.ts`

### 4.1 三种模式

```typescript
/**
 * ToolSearchMode 三种模式：
 *   'tst'      - 总是启用（所有 MCP + shouldDefer 工具都延迟加载）
 *   'tst-auto' - 自动模式（延迟工具 token 超过阈值时才启用）
 *   'standard' - 禁用（所有工具内联在系统提示中）
 *
 * 环境变量 ENABLE_TOOL_SEARCH 控制模式：
 *   未设置           → tst（默认：总是延迟 MCP 工具）
 *   true             → tst
 *   auto / auto:N    → tst-auto（N 为阈值百分比，默认 10%）
 *   false            → standard
 *   auto:0           → tst（0% 阈值 = 总是启用）
 *   auto:100         → standard（100% 阈值 = 永不启用）
 */
export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

export function getToolSearchMode(): ToolSearchMode {
  // Kill switch：CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 强制 standard 模式
  // 用于不支持 tool_reference beta 的代理网关
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return 'standard'
  }

  const value = process.env.ENABLE_TOOL_SEARCH
  const autoPercent = value ? parseAutoPercentage(value) : null

  if (autoPercent === 0) return 'tst'        // auto:0 = 总是启用
  if (autoPercent === 100) return 'standard'  // auto:100 = 禁用
  if (isAutoToolSearchMode(value)) return 'tst-auto'

  if (isEnvTruthy(value)) return 'tst'
  if (isEnvDefinedFalsy(value)) return 'standard'
  return 'tst'  // 默认：tst
}
```

### 4.2 乐观检查 vs 确定性检查

```typescript
/**
 * 乐观检查（快速，同步）：工具搜索"可能"启用。
 * 用于：
 * - 决定是否把 ToolSearchTool 加入基础工具列表
 * - 是否在消息中保留 tool_reference 字段
 *
 * 只有在 standard 模式（明确禁用）或第三方代理 URL 时返回 false。
 * 不检查模型兼容性、不检查阈值。
 *
 * 第三方代理处理逻辑（toolSearch.ts:299）：
 *   第三方代理通常不支持 tool_reference beta header，默认禁用。
 *   但若用户明确设置了 ENABLE_TOOL_SEARCH，表示代理支持，强制启用。
 */
export function isToolSearchEnabledOptimistic(): boolean {
  const mode = getToolSearchMode()
  if (mode === 'standard') return false

  // 未明确配置 + 使用了非官方 Anthropic 地址 → 禁用（代理可能不支持 beta）
  if (!process.env.ENABLE_TOOL_SEARCH && getAPIProvider() === 'firstParty' && !isFirstPartyAnthropicBaseUrl()) {
    return false
  }

  return true
}

/**
 * 确定性检查（异步，包含所有条件）：工具搜索"确实"启用。
 * 用于：实际 API 调用前的最终判断。
 *
 * 检查项：
 *   1. 模型是否支持 tool_reference（Haiku 不支持）
 *   2. ToolSearchTool 是否在可用工具列表中（可能被 disallowedTools 排除）
 *   3. tst-auto 模式：延迟工具 token 是否超过阈值
 */
export async function isToolSearchEnabled(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
): Promise<boolean> {
  // Haiku 系列不支持 tool_reference 块
  if (!modelSupportsToolReference(model)) return false

  // ToolSearchTool 可能被 disallowedTools 排除
  if (!isToolSearchToolAvailable(tools)) return false

  const mode = getToolSearchMode()
  switch (mode) {
    case 'tst': return true
    case 'tst-auto': {
      const { enabled } = await checkAutoThreshold(tools, getToolPermissionContext, agents, model)
      return enabled
    }
    case 'standard': return false
  }
}
```

### 4.3 自动模式阈值计算

```typescript
// toolSearch.ts
const DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10  // 10% 上下文窗口

/**
 * 计算自动模式的 token 阈值。
 * 阈值 = 模型上下文窗口 × 配置百分比
 * 例如 200K 上下文 × 10% = 20,000 token 阈值
 */
function getAutoToolSearchTokenThreshold(model: string): number {
  const contextWindow = getContextWindowForModel(model, getMergedBetas(model))
  return Math.floor(contextWindow * (getAutoToolSearchPercentage() / 100))
}

/**
 * 检查是否超过自动启用阈值。
 * 优先使用精确 token 计数 API（memoized，工具集合变化时失效）；
 * API 不可用时回退到字符数启发式估算（每 token 约 2.5 字符）。
 */
async function checkAutoThreshold(tools, getToolPermissionContext, agents, model) {
  // 精确计数（同一工具集只调用一次 token 计数 API）
  const deferredToolTokens = await getDeferredToolTokenCount(tools, getToolPermissionContext, agents, model)
  if (deferredToolTokens !== null) {
    const threshold = getAutoToolSearchTokenThreshold(model)
    return { enabled: deferredToolTokens >= threshold, ... }
  }

  // 回退：字符数估算（每 token 约 2.5 字符）
  const chars = await calculateDeferredToolDescriptionChars(tools, ...)
  const charThreshold = getAutoToolSearchCharThreshold(model)  // = token阈值 × 2.5
  return { enabled: chars >= charThreshold, ... }
}
```

---

## 5. ToolSearchTool 核心实现

**文件**：`src/tools/ToolSearchTool/ToolSearchTool.ts:323`

### 5.1 输入/输出 Schema

```typescript
// ToolSearchTool.ts:21
export const inputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe(
      'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
    ),
    max_results: z.number().optional().default(5).describe(
      'Maximum number of results to return (default: 5)',
    ),
  }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    matches: z.array(z.string()),             // 匹配到的工具名列表
    query: z.string(),                        // 原始查询
    total_deferred_tools: z.number(),         // 当前延迟工具总数
    pending_mcp_servers: z.array(z.string()).optional(), // 还在连接中的 MCP 服务器名
  }),
)
```

### 5.2 call 方法主流程

```typescript
// ToolSearchTool.ts:347
async call(input, { options: { tools }, getAppState }) {
  const { query, max_results = 5 } = input

  // 仅从工具列表中筛选延迟工具（已加载的工具不需要搜索）
  const deferredTools = tools.filter(isDeferredTool)

  // 延迟工具集合变化时清除描述缓存（工具名列表排序后比较内容指纹）
  maybeInvalidateCache(deferredTools)

  // select: 前缀 → 直接按名称精确查找（支持逗号分隔批量）
  // 例：select:Read,Edit,Grep → 同时加载 3 个工具
  const selectMatch = query.match(/^select:(.+)$/i)
  if (selectMatch) {
    const requested = selectMatch[1]!.split(',').map(s => s.trim()).filter(Boolean)
    const found: string[] = []
    for (const toolName of requested) {
      const tool = findToolByName(deferredTools, toolName) ?? findToolByName(tools, toolName)
      if (tool && !found.includes(tool.name)) found.push(tool.name)
    }
    // 即使工具已加载（在 tools 中但不在 deferredTools 中），也返回
    // "选择一个已加载的工具"是无害操作，让模型不需要重试
    return buildSearchResult(found, query, deferredTools.length)
  }

  // 关键词搜索
  const matches = await searchToolsWithKeywords(query, deferredTools, tools, max_results)

  // 无匹配时附带正在连接的 MCP 服务器列表（帮助模型理解为何找不到工具）
  if (matches.length === 0) {
    const pending = getAppState().mcp.clients.filter(c => c.type === 'pending').map(s => s.name)
    return buildSearchResult(matches, query, deferredTools.length, pending.length > 0 ? pending : undefined)
  }

  return buildSearchResult(matches, query, deferredTools.length)
}
```

---

## 6. 关键词搜索算法：searchToolsWithKeywords

**文件**：`src/tools/ToolSearchTool/ToolSearchTool.ts:204`

### 6.1 完整搜索流程

```
输入: query = "database read +postgres"
  ↓
1. 快速路径：精确名称匹配（queryLower === tool.name.toLowerCase()）
   → 命中则立即返回，无需评分

2. MCP 前缀匹配：query 以 "mcp__" 开头
   → "mcp__postgres" 直接匹配所有 mcp__postgres_* 工具

3. 解析查询词：
   - 必选词（+前缀）: ["postgres"]
   - 可选词: ["database", "read"]
   - 全部评分词: ["postgres", "database", "read"]

4. 必选词过滤：每个工具必须在名称/描述中包含所有必选词
   → 不含 "postgres" 的工具直接排除

5. 对剩余工具逐一评分（并行，Promise.all）：
   对每个查询词：
   - 工具名部分精确匹配: +10 分（MCP: +12）
   - 工具名部分子串包含: +5 分（MCP: +6）
   - 工具名全名子串（兜底）: +3 分
   - searchHint 词边界匹配: +4 分
   - 描述词边界匹配: +2 分

6. 过滤 score=0 的工具，按分数降序排序，返回 top-N
```

### 6.2 工具名解析：parseToolName

```typescript
// ToolSearchTool.ts:133
/**
 * 将工具名拆解为可搜索的词组。
 *
 * MCP 工具名格式：mcp__server__action_name
 *   → parts: ["server", "action", "name"]（去前缀，双下划线和单下划线都拆分）
 *   → full: "server action name"
 *   → isMcp: true（MCP 工具评分加权更高）
 *
 * 普通工具名格式：FileEditTool / file_edit_tool
 *   → parts: ["file", "edit", "tool"]（CamelCase 拆分 + 下划线拆分）
 *   → full: "file edit tool"
 *   → isMcp: false
 */
function parseToolName(name: string): { parts: string[]; full: string; isMcp: boolean } {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    // mcp__postgres__execute_query → ["postgres", "execute", "query"]
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  // FileEditTool → ["file", "edit", "tool"]
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // CamelCase 拆分
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return { parts, full: parts.join(' '), isMcp: false }
}
```

### 6.3 正则预编译优化：compileTermPatterns

```typescript
// ToolSearchTool.ts:168
/**
 * 预编译所有查询词的词边界正则表达式。
 * 在外层循环统一编译，避免 工具数 × 查询词数 次重复编译。
 *
 * 使用词边界 \b 避免误匹配：
 *   "read" 不应匹配 "already"（已在词中间）
 *   "sql" 应匹配 "sql_query"（词边界）
 */
function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>()
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
    }
  }
  return patterns
}
```

### 6.4 工具描述缓存

```typescript
// ToolSearchTool.ts:66
/**
 * 获取工具描述文本（按工具名 memoize）。
 * 工具描述包含参数说明和功能描述，用于关键词搜索评分。
 *
 * 缓存策略：
 * - memoize 按工具名缓存（同一工具多次搜索只获取一次描述）
 * - 延迟工具集合变化时，调用 maybeInvalidateCache() 清除所有缓存
 *   （工具集合变化 = 新 MCP 服务器连接/断开）
 * - 缓存 key 只用工具名，不包含 tools 数组引用（引用变化频繁）
 */
const getToolDescriptionMemoized = memoize(
  async (toolName: string, tools: Tools): Promise<string> => {
    const tool = findToolByName(tools, toolName)
    if (!tool) return ''
    // 以"匿名"权限上下文调用 tool.prompt()，获取完整描述文本
    return tool.prompt({
      getToolPermissionContext: async () => ({ mode: 'default', ... }),
      tools,
      agents: [],
    })
  },
  (toolName: string) => toolName,  // 缓存 key 只用工具名
)

/**
 * 延迟工具集合变化时清除描述缓存。
 * 缓存 key = 所有延迟工具名排序后拼接（内容指纹）。
 * 每次搜索调用前检查，保证缓存与当前工具集一致。
 */
function maybeInvalidateCache(deferredTools: Tools): void {
  const currentKey = getDeferredToolsCacheKey(deferredTools)  // 工具名排序后 join(',')
  if (cachedDeferredToolNames !== currentKey) {
    getToolDescriptionMemoized.cache.clear?.()
    cachedDeferredToolNames = currentKey
  }
}
```

---

## 7. 结果格式：tool_reference 块

**文件**：`src/tools/ToolSearchTool/ToolSearchTool.ts:485`

ToolSearchTool 的返回值不是普通文本，而是 **`tool_reference` 块**——这是 Anthropic API 的 beta 特性，API 服务端会将其展开为完整的工具 Schema：

```typescript
/**
 * 将搜索结果序列化为 API 可接受的 tool_result 格式。
 *
 * 有匹配时：返回 tool_reference 块数组
 *   { type: 'tool_result', content: [{ type: 'tool_reference', tool_name: 'mcp__postgres__query' }] }
 *   API 服务端展开 tool_reference → 模型上下文中出现完整的工具 Schema
 *   模型随即可以直接调用该工具，就像工具一开始就在系统提示中一样
 *
 * 无匹配时：返回文本说明
 *   "No matching deferred tools found"
 *   若有正在连接的 MCP 服务器，附加：
 *   "Some MCP servers are still connecting: [server1, server2]. Try searching again."
 */
mapToolResultToToolResultBlockParam(content: Output, toolUseID: string): ToolResultBlockParam {
  if (content.matches.length === 0) {
    let text = 'No matching deferred tools found'
    if (content.pending_mcp_servers?.length > 0) {
      text += `. Some MCP servers are still connecting: ${content.pending_mcp_servers.join(', ')}. Try searching again.`
    }
    return { type: 'tool_result', tool_use_id: toolUseID, content: text }
  }

  return {
    type: 'tool_result',
    tool_use_id: toolUseID,
    content: content.matches.map(name => ({
      type: 'tool_reference' as const,
      tool_name: name,
    })),
  } as unknown as ToolResultBlockParam
  // as unknown：tool_reference 是 beta 类型，SDK 类型定义暂不包含
}
```

**为什么用 `tool_reference` 而不是直接返回 Schema 文本？**

1. **服务端展开**：API 在服务端保证格式与初始工具列表完全一致，不依赖客户端文本解析
2. **缓存效率**：`tool_reference` 指向服务端缓存的工具定义，避免重复传输大量文本
3. **权限控制**：服务端可统一检查工具访问权限

---

## 8. 已发现工具追踪：extractDiscoveredToolNames

**文件**：`src/utils/toolSearch.ts:545`

```typescript
/**
 * 从消息历史中提取所有已通过 ToolSearch 发现的工具名。
 *
 * 背景：
 *   延迟工具在被 ToolSearch 搜索并返回 tool_reference 之前，
 *   不包含在每次 API 调用的工具列表中。
 *   但一旦模型通过 ToolSearch 发现了某工具，后续 API 调用也应该
 *   包含该工具的完整 Schema，否则模型会在调用时遇到"工具不存在"错误。
 *
 * 扫描方式：
 *   遍历所有 user 消息中的 tool_result 块，找出包含 tool_reference 的内容
 *   → tool_reference.tool_name 就是已发现的工具名
 *
 * 压缩处理：
 *   压缩（compactConversation）会替换掉含 tool_reference 的历史消息，
 *   但在压缩边界标记（compact_boundary）中保存了 preCompactDiscoveredTools，
 *   此函数读取该字段恢复已发现工具集。
 *
 * @returns 已发现工具名的 Set（含压缩前携带的工具）
 */
export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  const discoveredTools = new Set<string>()

  for (const msg of messages) {
    // 压缩边界：读取压缩前保存的已发现工具
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const carried = msg.compactMetadata?.preCompactDiscoveredTools
      if (carried) {
        for (const name of carried) discoveredTools.add(name)
      }
      continue
    }

    if (msg.type !== 'user') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      // tool_reference 只出现在 tool_result 的 content 数组中
      // （即 ToolSearchTool 的返回值）
      if (isToolResultBlockWithContent(block)) {
        for (const item of block.content) {
          if (isToolReferenceWithName(item)) {
            discoveredTools.add(item.tool_name)
          }
        }
      }
    }
  }

  return discoveredTools
}
```

---

## 9. 增量通知机制：getDeferredToolsDelta

**文件**：`src/utils/toolSearch.ts:646`

```typescript
/**
 * 计算延迟工具池的增量变化（新增/移除），用于通知模型工具集合变化。
 *
 * 工作原理：
 *   扫描历史消息中的 deferred_tools_delta 附件，重建"已通告"工具集；
 *   与当前延迟工具池对比，计算差值。
 *
 * 调用场景（callSite 区分用于 BQ 分析）：
 *   - attachments_main:     主线程 getAttachments，prior=0 是 BUG
 *   - attachments_subagent: 子 Agent getAttachments，prior=0 是正常（新对话）
 *   - compact_full:         压缩后重新通告（传入 []），prior=0 正常
 *   - compact_partial:      部分压缩，取决于保留消息
 *   - reactive_compact:     响应式压缩
 *
 * 注意：
 *   工具从"延迟"变为"直接加载"（undeferred）时，不报告为 removed。
 *   因为工具仍然可用，只是现在通过系统提示而非 ToolSearch 提供。
 *   只有工具完全从工具池消失（MCP 服务器断开）时才报告为 removed。
 *
 * @returns DeferredToolsDelta | null（无变化时返回 null）
 */
export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
): DeferredToolsDelta | null {
  // 从消息历史重建已通告集合
  const announced = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'attachment' || msg.attachment.type !== 'deferred_tools_delta') continue
    for (const n of msg.attachment.addedNames) announced.add(n)
    for (const n of msg.attachment.removedNames) announced.delete(n)
  }

  const deferred = tools.filter(isDeferredTool)
  const deferredNames = new Set(deferred.map(t => t.name))
  const poolNames = new Set(tools.map(t => t.name))

  // 新增：当前有延迟但未通告
  const added = deferred.filter(t => !announced.has(t.name))

  // 移除：已通告但不再是延迟工具，且已从工具池完全消失
  const removed: string[] = []
  for (const n of announced) {
    if (deferredNames.has(n)) continue    // 仍是延迟工具，不处理
    if (!poolNames.has(n)) removed.push(n) // 完全消失了（MCP 服务器断开）
    // 若仍在 pool 但不是 deferred（已直接加载），静默跳过
  }

  if (added.length === 0 && removed.length === 0) return null

  return {
    addedNames: added.map(t => t.name).sort(),
    addedLines: added.map(formatDeferredToolLine).sort(),
    removedNames: removed.sort(),
  }
}
```

---

## 10. 关键常量与配置

### 10.1 环境变量

| 变量 | 默认值 | 说明 |
|-----|--------|-----|
| `ENABLE_TOOL_SEARCH` | 未设置（= tst） | 工具搜索模式控制 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 未设置 | Kill switch，强制 standard 模式 |

`ENABLE_TOOL_SEARCH` 取值含义：

| 取值 | 模式 | 行为 |
|-----|------|-----|
| 未设置 | tst | 总是延迟 MCP 工具（默认） |
| `true` | tst | 总是延迟 |
| `false` | standard | 禁用，所有工具内联 |
| `auto` | tst-auto | 按 10% 阈值自动判断 |
| `auto:N` | tst-auto | 按 N% 阈值自动判断（0-100） |
| `auto:0` | tst | 等价于 true |
| `auto:100` | standard | 等价于 false |

### 10.2 GrowthBook Feature Flags

| 标志 | 说明 |
|-----|-----|
| `tengu_tool_search_unsupported_models` | 不支持 tool_reference 的模型模式列表（默认 `['haiku']`） |
| `tengu_glacier_2xr` | 启用 delta 通知机制（deferred_tools_delta 附件） |

### 10.3 评分权重

| 匹配类型 | 普通工具 | MCP 工具 |
|---------|---------|---------|
| 工具名词组精确匹配 | 10 分 | 12 分（MCP 服务器名更重要） |
| 工具名词组子串包含 | 5 分 | 6 分 |
| 工具名全名子串兜底 | 3 分 | 3 分 |
| searchHint 词边界匹配 | 4 分 | 4 分 |
| 描述文本词边界匹配 | 2 分 | 2 分 |

### 10.4 自动模式阈值

| 参数 | 值 | 说明 |
|-----|---|-----|
| `DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE` | 10% | 默认阈值（上下文窗口的 10%） |
| `CHARS_PER_TOKEN` | 2.5 | 字符数到 token 的估算比例（回退用） |

---

## 11. 源文件索引

| 文件 | 职责 |
|-----|-----|
| `src/tools/ToolSearchTool/ToolSearchTool.ts` | 工具主实现：搜索算法、call 方法、缓存管理 |
| `src/tools/ToolSearchTool/prompt.ts` | `isDeferredTool()` 判断逻辑、工具描述文本 |
| `src/tools/ToolSearchTool/constants.ts` | 工具名常量 `TOOL_SEARCH_TOOL_NAME = 'ToolSearch'` |
| `src/utils/toolSearch.ts` | 工具搜索启用条件、模式判断、已发现工具追踪、delta 通知 |
