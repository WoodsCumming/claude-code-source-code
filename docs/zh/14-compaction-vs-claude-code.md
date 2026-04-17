# 上下文压缩机制深度对比：OpenClaw vs Claude Code

> 本文基于两个项目的实际源码分析：
> - OpenClaw：`src/agents/pi-embedded-runner/`、`src/agents/pi-extensions/`
> - Claude Code：`src/services/compact/`（源码路径 `/Users/wuchangming/code/mt/claude-code-source-code`）
>
> 所有引用均标注精确文件路径和行号。

---

## 1. 背景：共同的物理约束

两个系统都基于 Claude 模型，面对同一个硬约束：上下文窗口有限（Claude 3.5/3.7 Sonnet 200K tokens，Claude Opus 4 200K tokens）。随着对话轮次增加、工具调用结果积累，历史消息填满上下文，最终触发 API 的 `prompt_too_long` 错误。

**压缩的本质**：用 LLM 将旧历史消息"摘要化"，替换为简短摘要，腾出空间让对话继续，同时尽量保留关键信息。

两者的核心摘要逻辑相同——都是调用 Claude 模型生成结构化摘要——但**触发机制、分层策略、摘要内容、失败处理**存在根本性差异。

---

## 2. 架构全景对比

### Claude Code：四层压缩体系

```
Layer 0: Microcompact（微压缩）
  ├── 时间触发（Time-based）：距上次对话 ≥ N 分钟，清除旧工具结果
  └── Cached MC（API cache editing）：通过 API 指令删除缓存中的旧工具结果（ant-only）

Layer 1: Session Memory Compaction（会话记忆压缩）
  └── 实验性：从结构化记忆文件提取摘要，无需调用 LLM

Layer 2: Auto-Compact（自动全量压缩）
  └── Token 超阈值时，调用 Sonnet 生成 9 段结构化摘要

Layer 3: Manual /compact（手动压缩）
  └── 用户主动触发，支持自定义指令和局部压缩
```

### OpenClaw：三层压缩体系

```
Layer 0: Context Pruning（上下文修剪）
  ├── Soft Trim：保留工具结果头尾，截断中间（基于缓存 TTL）
  └── Hard Clear：直接替换为占位符（上下文使用率 > 50%）

Layer 1: SDK Auto-Compaction（SDK 自动压缩）
  └── Pi SDK 触发，由 compactionSafeguardExtension 接管，生成增强摘要

Layer 2: Overflow Compaction（溢出压缩）
  └── API 返回 context overflow 后，最多重试 3 次
      └── Fallback: Tool Result Truncation（工具结果截断）
```

---

## 3. 触发机制详解

### 3.1 Claude Code 的触发机制

#### 阈值计算（`autoCompact.ts:33-91`）

```typescript
// 有效上下文窗口 = 模型窗口 - 为摘要输出预留的 token 数
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,  // 20,000 tokens（p99.99 摘要输出为 17,387 tokens）
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  // 支持环境变量覆盖：CLAUDE_CODE_AUTO_COMPACT_WINDOW
  return contextWindow - reservedTokensForSummary
}

// 自动压缩触发阈值 = 有效窗口 - 13,000 tokens 安全边距
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  // 13,000
}
```

**实际阈值示例**（Claude Sonnet，200K 窗口）：
- 有效窗口：200,000 - 20,000 = 180,000 tokens
- 自动压缩触发：180,000 - 13,000 = **167,000 tokens**（约 83.5%）
- 警告 UI 显示：167,000 - 20,000 = **147,000 tokens**（约 73.5%）
- 阻塞限制：180,000 - 3,000 = **177,000 tokens**（约 88.5%）

#### 触发防护（`autoCompact.ts:163-244`）

```typescript
export async function shouldAutoCompact(...): Promise<boolean> {
  // 1. 递归防护：session_memory 和 compact 是 forked agent，会死锁
  if (querySource === 'session_memory' || querySource === 'compact') return false
  // 2. Context Collapse 模式防护（ant-only）：90% commit / 95% blocking 流程接管
  if (feature('CONTEXT_COLLAPSE') && isContextCollapseEnabled()) return false
  // 3. Reactive Compact 模式：抑制主动压缩，等 API 返回 prompt_too_long
  if (feature('REACTIVE_COMPACT') && ...) return false
  // 4. 用户配置和环境变量检查
  if (!isAutoCompactEnabled()) return false
  // 5. Token 计数比对
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  return tokenCount >= getAutoCompactThreshold(model)
}
```

#### 熔断机制（`autoCompact.ts:62-70`）

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
// 背景：BQ 2026-03-10 统计显示，1,279 个会话有 50+ 次连续失败（最高 3,272 次），
// 每天浪费约 25 万次 API 调用。熔断后停止重试。
```

### 3.2 OpenClaw 的触发机制

#### 预防性修剪（`context-pruning/settings.ts:48-65`）

```typescript
export const DEFAULT_CONTEXT_PRUNING_SETTINGS = {
  mode: "cache-ttl",
  ttlMs: 5 * 60 * 1000,      // 缓存 TTL：5 分钟
  keepLastAssistants: 3,      // 保护最近 3 个 assistant 轮次
  softTrimRatio: 0.3,         // 软修剪触发：上下文使用 30%
  hardClearRatio: 0.5,        // 硬清除触发：上下文使用 50%
  minPrunableToolChars: 50_000, // 最小可修剪工具结果字符数
  softTrim: { maxChars: 4_000, headChars: 1_500, tailChars: 1_500 },
  hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
}
```

**触发条件**：距上次缓存刷新超过 TTL（5 分钟），且工具结果超过 50,000 字符。仅支持 Anthropic provider（利用 prompt cache 机制）。

#### 溢出响应（`run.ts:511`）

```typescript
const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3  // 溢出后最多压缩 3 次
let overflowCompactionAttempts = 0
let toolResultTruncationAttempted = false
```

---

## 4. 微压缩：Claude Code 独有机制

Claude Code 有一套轻量级的**微压缩（Microcompact）**系统，在不触发全量摘要的情况下释放上下文空间。OpenClaw 没有对应机制。

### 4.1 时间触发微压缩（`microCompact.ts:431-546`）

```typescript
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  const gapMinutes = (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (gapMinutes < config.gapThresholdMinutes) return null  // 未达到时间阈值
  return { gapMinutes, config }
}
```

**逻辑**：距上次 assistant 消息超过阈值分钟时，直接清除 `COMPACTABLE_TOOLS` 中最旧的工具结果（保留最近 N 条），替换为占位符 `[Old tool result content cleared]`。

**设计原因**：缓存已冷（超时），重写 prompt 时无论如何都会 cache miss，此时直接清除旧内容比 cache editing 更合适。

### 4.2 Cached Microcompact（`microCompact.ts:281-408`，ant-only）

```typescript
if (feature('CACHED_MICROCOMPACT')) {
  // 通过 API 的 cache_edits 指令删除旧 tool_result，不修改本地消息内容
  // 保留 prompt cache prefix，避免 cache miss
  return await cachedMicrocompactPath(messages, querySource)
}
```

**可压缩工具集**（`microCompact.ts:42-52`）：

```typescript
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,    // Read  — 文件内容可重新读取
  ...SHELL_TOOL_NAMES,    // Bash  — 命令输出可重新执行
  GREP_TOOL_NAME,         // Grep  — 搜索结果可重新搜索
  GLOB_TOOL_NAME,         // Glob  — 文件列表可重新获取
  WEB_SEARCH_TOOL_NAME,   // WebSearch
  WEB_FETCH_TOOL_NAME,    // WebFetch
  FILE_EDIT_TOOL_NAME,    // Edit  — diff 可重新生成
  FILE_WRITE_TOOL_NAME,   // Write
  // AgentTool、SkillTool 等不在此列 — 其结果不可轻易重现
])
```

**关键区别**：Cached MC 不修改本地消息，通过 API 层的 `cache_edits` 指令实现，cache prefix 保持不变，避免 cache miss。

---

## 5. 全量压缩：核心算法对比

### 5.1 Claude Code 的全量压缩流程（`compact.ts:391-700`）

```
compactConversation()
  │
  ├── 1. executePreCompactHooks()      — hook 可注入自定义指令
  │
  ├── 2. streamCompactSummary()        — 流式调用 Sonnet 生成摘要
  │   ├── 发送全部历史消息 + 9 段摘要 prompt
  │   ├── prompt_too_long → truncateHeadForPTLRetry() 截断最旧 API 轮次，重试（最多 3 次）
  │   └── 返回 <analysis>...</analysis><summary>...</summary> 格式
  │
  ├── 3. 并行生成 Post-Compact 附件（Promise.all）
  │   ├── createPostCompactFileAttachments()  — 恢复最近读取的文件（最多 5 个，50K token 预算）
  │   ├── createAsyncAgentAttachmentsIfNeeded() — 恢复异步 Agent 结果
  │   ├── createPlanAttachmentIfNeeded()      — 恢复计划文件（Plan Mode）
  │   ├── createSkillAttachmentIfNeeded()     — 恢复已调用的技能（25K token 预算）
  │   ├── getDeferredToolsDeltaAttachment()   — 重新宣告可用工具列表
  │   ├── getAgentListingDeltaAttachment()    — 重新宣告可用 Agent 列表
  │   └── getMcpInstructionsDeltaAttachment() — 重新宣告 MCP 指令
  │
  ├── 4. processSessionStartHooks()    — 恢复 CLAUDE.md 等会话启动上下文
  │
  ├── 5. createCompactBoundaryMessage()— 创建压缩边界标记（含 pre-compact token 数）
  │
  └── 6. 返回 CompactionResult
        ├── boundaryMarker
        ├── summaryMessages（摘要文本）
        ├── attachments（恢复的文件/技能/工具）
        └── hookResults
```

**图像处理**（`compact.ts:146-201`）：压缩前剥离所有图片块，替换为 `[image]` 文本标记，避免摘要请求本身触发 prompt_too_long。

### 5.2 OpenClaw 的全量压缩流程（`compact.ts:247-744`）

```
compactEmbeddedPiSessionDirect()
  │
  ├── 1. 解析模型 + API key（可独立于主 agent 的 auth profile）
  │
  ├── 2. 重建完整 system prompt（含技能、渠道能力、工具提示等）
  │
  ├── 3. acquireSessionWriteLock()     — 获取会话文件写锁（防并发冲突）
  │
  ├── 4. 修复历史消息
  │   ├── repairSessionFileIfNeeded()
  │   ├── sanitizeSessionHistory()
  │   ├── limitHistoryTurns()
  │   └── sanitizeToolUseResultPairing()  — 修复孤立 tool_result
  │
  ├── 5. hookRunner.runBeforeCompaction()  — 触发 before_compaction 插件钩子
  │
  ├── 6. compactWithSafetyTimeout(() => session.compact())
  │   └── 300 秒硬超时（Pi SDK 内部压缩）
  │   
  │   ↑ 若使用 compactionSafeguardExtension（session_before_compact 事件）：
  │   ├── pruneHistoryForContextShare()  — 历史预算管理（丢弃最旧块）
  │   ├── summarizeInStages()            — 分阶段摘要（分块→各块摘要→合并）
  │   ├── formatToolFailuresSection()    — 附加工具失败记录
  │   ├── formatFileOperations()         — 附加文件操作记录
  │   └── readWorkspaceContextForSummary() — 附加 AGENTS.md 关键规则
  │
  ├── 7. hookRunner.runAfterCompaction()  — 触发 after_compaction 插件钩子
  │
  └── 8. 写入会话 JSONL 文件（compaction entry）
```

---

## 6. 摘要内容对比

这是两者最核心的差异之一。

### 6.1 Claude Code 的 9 段摘要结构（`prompt.ts:77-159`）

```
1. Primary Request and Intent  — 用户的所有明确请求（完整捕获）
2. Key Technical Concepts      — 技术概念、框架、技术栈
3. Files and Code Sections     — 检查/修改/创建的文件，含完整代码片段
4. Errors and Fixes            — 错误及修复，含用户反馈
5. Problem Solving             — 已解决问题和进行中的调试
6. All User Messages           — 所有非工具结果的用户消息（完整保留，追踪意图变化）
7. Pending Tasks               — 明确被要求的待办任务
8. Current Work                — 压缩前正在进行的工作（含文件名和代码片段）
9. Optional Next Step          — 下一步行动（含原文引用，防止任务漂移）
```

**设计亮点**：
- 第 6 段完整保留所有用户消息，防止意图漂移
- 第 9 段要求引用原文，防止任务漂移
- `<analysis>` scratchpad 块仅用于推理，最终被 `formatCompactSummary()` 去除（`prompt.ts:332-358`）

**工具禁用双重保障**（`prompt.ts:23-30, 288-291`）：

```typescript
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
// 设计原因：Sonnet 4.6+ adaptive thinking 有时尝试调用工具
// 若被拒绝，maxTurns:1 下无文本输出 → 流式回退（2.79% 概率）
// 加此前缀后失败率降至 0.01%`

const NO_TOOLS_TRAILER = `REMINDER: Do NOT call any tools...`
```

**Post-Compact 文件恢复**（`compact.ts:541-594`）：
- 最多恢复最近读取的 **5 个文件**，总预算 **50,000 tokens**，单文件上限 **5,000 tokens**
- 重新宣告可用工具列表、Agent 列表、MCP 指令（避免压缩后模型忘记工具）
- 恢复已调用的技能，总预算 **25,000 tokens**，单技能上限 **5,000 tokens**

### 6.2 OpenClaw 的摘要内容（`compaction-safeguard.ts:196-381`）

OpenClaw 的摘要通过 `compactionSafeguardExtension` 在 Pi SDK 的 `session_before_compact` 事件中增强：

```typescript
// 核心摘要（Pi SDK 生成）
const historySummary = await summarizeInStages({ messages, model, ... })

// 附加工具失败记录（compaction-safeguard.ts:206-210）
const toolFailures = collectToolFailures([...messagesToSummarize, ...turnPrefixMessages])
summary += formatToolFailuresSection(toolFailures)
// 格式：
// ## Tool Failures
// - read_file (exitCode=1): permission denied
// - bash: command not found: npm

// 附加文件操作记录（compaction-safeguard.ts:204-205）
const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps)
summary += formatFileOperations(readFiles, modifiedFiles)
// 格式：
// <read-files>
// src/agents/compaction.ts
// </read-files>
// <modified-files>
// src/gateway/auth.ts
// </modified-files>

// 附加工作区关键规则（compaction-safeguard.ts:358-362）
const workspaceContext = await readWorkspaceContextForSummary()
// 从 AGENTS.md 提取 "Session Startup" 和 "Red Lines" 章节（最多 2000 字符）
summary += workspaceContext
```

**历史预算管理**（`compaction-safeguard.ts:253-309`）：
```typescript
// 若新内容 token 数超过历史预算（contextWindow × maxHistoryShare × SAFETY_MARGIN）
// 先对旧历史执行 pruneHistoryForContextShare，丢弃最旧的消息块
// 被丢弃的消息块会被单独摘要化，作为 previousSummary 传入主摘要
const pruned = pruneHistoryForContextShare({
  messages: messagesToSummarize,
  maxContextTokens: contextWindowTokens,
  maxHistoryShare: 0.5,  // 历史最多占 50%
  parts: 2,
})
// 丢弃部分单独摘要，作为 droppedSummary
droppedSummary = await summarizeInStages({ messages: pruned.droppedMessagesList, ... })
```

---

## 7. 失败处理对比

### Claude Code 的失败处理

**prompt_too_long 重试**（`compact.ts:458-498`）：
```typescript
for (;;) {
  summaryResponse = await streamCompactSummary(...)
  if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break
  // 截断最旧 API 轮次（按 tokenGap 精确计算需丢弃的轮次数）
  const truncated = ptlAttempts <= MAX_PTL_RETRIES  // 最多 3 次
    ? truncateHeadForPTLRetry(messagesToSummarize, summaryResponse)
    : null
  if (!truncated) throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
  messagesToSummarize = truncated
}
```

**熔断**（`autoCompact.ts:264-270`）：
```typescript
if (tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
  return { wasCompacted: false }  // 停止重试，不再浪费 API 调用
}
```

**最终放弃**：向用户显示错误消息，需手动 `/compact` 或 `/clear`。

### OpenClaw 的失败处理

**压缩失败保留历史**（`compaction-safeguard.ts:372-379`）：
```typescript
} catch (error) {
  log.warn(`Compaction summarization failed; cancelling compaction to preserve history: ${...}`)
  return { cancel: true }  // 取消压缩，保留原始历史（宁可 overflow 也不丢失信息）
}
```

**三级降级摘要**（`compaction.ts:208-273`）：
```
1. 完整摘要（全部消息）
2. 部分摘要（跳过超大消息，附注跳过说明）
3. 纯文字说明（消息数量 + 无法摘要的原因）
```

**工具结果截断兜底**（`run.ts:771-816`）：
```typescript
// 压缩无法解决时的最后手段：单条工具结果体积过大
if (!toolResultTruncationAttempted) {
  const hasOversized = sessionLikelyHasOversizedToolResults(...)
  if (hasOversized) {
    const truncResult = await truncateOversizedToolResultsInSession({
      sessionFile, contextWindowTokens, ...
    })
    // 直接修改 JSONL 会话文件，截断超大工具结果
    if (truncResult.truncated) continue  // 重试 agent
  }
}
```

---

## 8. 会话记忆压缩（Claude Code 独有实验性功能）

Claude Code 有一个实验性的**会话记忆压缩**路径（`sessionMemoryCompact.ts`），在自动压缩前优先尝试：

```typescript
export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: AgentId,
  autoCompactThreshold?: number,
): Promise<CompactionResult | null> {
  // 条件：tengu_session_memory + tengu_sm_compact 均启用
  // 条件：会话记忆文件存在且非空模板
  // 条件：无 custom instructions（会话记忆不支持自定义摘要指令）
  
  // 从 lastSummarizedMessageId 开始，向后计算保留消息范围
  // 限制：minTokens=10,000、minTextBlockMessages=5、maxTokens=40,000
  // 直接返回 CompactionResult，不调用 LLM
}
```

**优势**：
- 无需调用 LLM，节省 API 费用
- 保留原始消息（无摘要失真）
- Token 节省约 70-80%

OpenClaw **没有**对应机制。

---

## 9. 并发安全与 Lane 系统

### Claude Code

单进程单线程（Bun 运行时），同一时间只有一个 agent 运行，无并发问题。压缩时整个 agent 暂停。

**递归防护**（`autoCompact.ts:174-177`）：
```typescript
// session_memory 和 compact 是 forked agent，若触发自动压缩会死锁
if (querySource === 'session_memory' || querySource === 'compact') return false
```

### OpenClaw

多会话并发，通过 Lane 系统防止死锁：

```typescript
// compact.ts:247（Direct 版本，Lane 内调用）
export async function compactEmbeddedPiSessionDirect(params) {
  // 直接执行，不再入队，防止死锁
}

// compact.ts:751（带 Lane 的版本，Lane 外调用）
export async function compactEmbeddedPiSession(params) {
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => compactEmbeddedPiSessionDirect(params))
  )
}

// 写锁防止多进程并发修改同一会话文件
const sessionLock = await acquireSessionWriteLock({
  sessionFile: params.sessionFile,
  maxHoldMs: resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 300_000 }),
})
```

---

## 10. 可配置性对比

### Claude Code 的配置项

**用户设置**：
- `autoCompactEnabled`：是否启用自动压缩（默认 true）

**环境变量**：
```
DISABLE_COMPACT                    — 禁用所有压缩
DISABLE_AUTO_COMPACT               — 只禁用自动压缩（手动 /compact 仍可用）
CLAUDE_CODE_AUTO_COMPACT_WINDOW    — 覆盖自动压缩窗口大小
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE    — 按百分比覆盖触发阈值
CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE — 覆盖阻塞限制
```

**特性开关**（GrowthBook，ant-only）：
```
tengu_compact_cache_prefix  — 摘要请求复用 prompt cache
tengu_cached_microcompact   — API cache editing 路径
tengu_session_memory        — 会话记忆功能
tengu_sm_compact            — 会话记忆压缩
tengu_slate_heron           — 时间触发微压缩配置
REACTIVE_COMPACT            — 响应式压缩（抑制主动压缩）
CONTEXT_COLLAPSE            — 上下文折叠模式
```

### OpenClaw 的配置项

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl",           // "off" | "cache-ttl"
        ttl: "5m",                   // 缓存 TTL（支持 duration 字符串）
        keepLastAssistants: 3,       // 保护最近 N 个 assistant 轮次
        softTrimRatio: 0.3,          // 软修剪触发比例
        hardClearRatio: 0.5,         // 硬清除触发比例
        minPrunableToolChars: 50000, // 最小可修剪工具结果字符数
        softTrim: {
          maxChars: 4000,
          headChars: 1500,
          tailChars: 1500,
        },
        hardClear: {
          enabled: true,
          placeholder: "[Old tool result content cleared]",
        },
      },
      compaction: {
        mode: "safeguard",           // "default" | "safeguard"
      },
    },
  },
}
```

---

## 11. 可观测性对比

### Claude Code

- **UI 通知**：压缩时显示进度（`onCompactProgress` 回调），完成后显示 token 数变化
- **事件日志**（Analytics）：`tengu_compact`、`tengu_compact_failed`、`tengu_compact_ptl_retry`、`tengu_cached_microcompact`、`tengu_time_based_microcompact`
- **调试日志**：`logForDebugging()` 输出阈值计算过程

### OpenClaw

**详细诊断日志**（`compact.ts:648-713`，`run.ts:693-698`）：
```
[compaction-diag] start runId=xxx sessionKey=xxx diagId=ovf-1a2b3c
  trigger=overflow provider=anthropic/claude-opus-4-6
  attempt=1 maxAttempts=3
  pre.messages=142 pre.historyTextChars=284000 pre.estTokens=71000
  contributors=[{"role":"toolResult","chars":180000},...]

[compaction-diag] end ... outcome=compacted reason=none
  durationMs=12340 retrying=false
  post.messages=3 post.historyTextChars=4200 post.estTokens=1050
  delta.messages=-139 delta.historyTextChars=-279800 delta.estTokens=-69950
```

**插件钩子**：`before_compaction`、`after_compaction` 允许第三方监控和介入压缩过程。

---

## 12. 综合对比表

| 维度 | Claude Code | OpenClaw |
|------|------------|---------|
| **压缩层数** | 4 层（Micro / SM / Auto / Manual） | 3 层（Pruning / SDK Auto / Overflow） |
| **触发方式** | 主动阈值（~83% 窗口）+ 时间触发 | 预防性 TTL + SDK 阈值 + 响应式 overflow |
| **微压缩** | 有（时间触发 + API cache editing） | 无（用 Context Pruning 替代） |
| **会话记忆压缩** | 有（实验性，无需 LLM） | 无 |
| **摘要结构** | 9 段固定结构（含用户消息完整保留） | Pi SDK 摘要 + 工具失败 + 文件操作 + 工作区规则 |
| **工具结果特殊处理** | COMPACTABLE_TOOLS 集合（可重现的工具） | 超大工具结果截断（直接改写 JSONL 文件） |
| **图片处理** | 压缩前剥离，替换为 `[image]` | 无特殊处理 |
| **Post-Compact 恢复** | 文件/技能/工具/Agent/MCP 全量恢复 | 无（依赖 system prompt 重建） |
| **压缩失败策略** | 截断最旧轮次重试 → 熔断 → 报错 | 保留历史（取消压缩）→ 三级降级 |
| **并发安全** | 单线程，无并发问题 | 写锁 + Lane 系统防死锁 |
| **超时保护** | 无独立超时 | 300 秒硬超时 |
| **插件钩子** | PreCompact / PostCompact hooks | before_compaction / after_compaction |
| **可配置项** | autoCompactEnabled + 环境变量 | 完整的 contextPruning 配置 |
| **诊断日志** | UI 通知 + Analytics 事件 | 详细结构化诊断日志 |

---

## 13. 设计哲学差异

**Claude Code** 的设计目标是**最大化上下文利用率 + 最小化用户感知中断**：
- 多层次压缩确保在 overflow 发生前就处理掉大部分上下文压力
- 微压缩（无需 LLM）优先于全量压缩，节省费用
- Post-Compact 文件/工具恢复确保压缩后模型立刻有完整工作上下文
- 摘要的 9 段结构专为编码场景设计，完整保留用户意图

**OpenClaw** 的设计目标是**多渠道长期运行的可靠性 + 信息不丢失**：
- 宁可 overflow 也不丢失历史（压缩失败时保留原始消息）
- 工具结果截断作为最后兜底，处理"单条工具结果撑爆上下文"的极端场景
- 摘要附加工具失败记录、文件操作记录和工作区规则，适合长时间运行的 agent
- 插件钩子允许第三方扩展压缩行为（如记忆后端、审计日志）
- Lane 系统支持多会话并发，每个会话独立压缩不互相阻塞
