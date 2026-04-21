# Claude Code 上下文压缩机制深度解析

> 基于 Claude Code v2.1.88 源码，含函数级注释与行号对照

---

## 目录

1. [核心问题：为什么不调用摘要模型？](#1-核心问题为什么不调用摘要模型)
2. [压缩机制全景图](#2-压缩机制全景图)
3. [Layer 1：微压缩（Microcompact）](#3-layer-1微压缩microcompact)
4. [Layer 2：会话记忆压缩（Session Memory Compact）](#4-layer-2会话记忆压缩session-memory-compact)
5. [Layer 3：全量摘要压缩（compactConversation）](#5-layer-3全量摘要压缩compactconversation)
6. [自动压缩触发机制（autoCompactIfNeeded）](#6-自动压缩触发机制autocompactifneeded)
7. [Prompt Cache 共享：摘要请求复用缓存前缀](#7-prompt-cache-共享摘要请求复用缓存前缀)
8. [压缩后的上下文重建](#8-压缩后的上下文重建)
9. [Token 阈值体系](#9-token-阈值体系)
10. [摘要提示词设计](#10-摘要提示词设计)

---

## 1. 核心问题：为什么不调用摘要模型？

"不调用摘要模型"这个说法需要修正：**Claude Code 确实调用 LLM 生成摘要**，但它通过三个层次的机制，尽量在不调用 LLM 的情况下完成压缩：

| 压缩层次 | 是否调用 LLM | 原理 |
|---------|------------|------|
| 微压缩（Microcompact） | **否** | 直接清除/替换旧工具结果文本 |
| 会话记忆压缩（Session Memory） | **否** | 使用后台异步提取的记忆文件替换历史 |
| 全量摘要压缩（compactConversation） | **是** | 调用同一模型（非独立摘要模型）生成摘要 |

关键设计：全量摘要使用的是**主对话模型本身**（如 claude-sonnet），而非独立的小摘要模型，且通过 `runForkedAgent` 复用主对话的 **Prompt Cache 前缀**，大幅降低摘要请求的 token 费用。

---

## 2. 压缩机制全景图

```
用户发起新轮次请求
        │
        ▼
microcompactMessages()                    ← src/services/compact/microCompact.ts
  ├── maybeTimeBasedMicrocompact()         ← 时间触发：直接清除旧工具结果（不调用 LLM）
  ├── cachedMicrocompactPath()             ← Cached MC：通过 API cache_edits 删除（不调用 LLM）
  └── 无变化（外部用户）
        │
        ▼
autoCompactIfNeeded()                     ← src/services/compact/autoCompact.ts
  ├── shouldAutoCompact()                  ← token 计数 >= 阈值？
  ├── trySessionMemoryCompaction()         ← 会话记忆压缩（不调用 LLM）
  └── compactConversation()               ← 全量摘要压缩（调用 LLM）
        │
        ▼
压缩结果 CompactionResult
  ├── boundaryMarker                       ← 压缩边界标记
  ├── summaryMessages                      ← 摘要文本（作为 user 消息注入）
  ├── messagesToKeep                       ← 保留的原始消息（会话记忆路径）
  ├── attachments                          ← 恢复的文件/技能/工具
  └── hookResults                          ← CLAUDE.md 等会话启动上下文
```

---

## 3. Layer 1：微压缩（Microcompact）

**文件**：`src/services/compact/microCompact.ts`

微压缩是最轻量的压缩层，**完全不调用 LLM**，通过两种策略清除旧工具结果。

### 3.1 可压缩工具集合（第 42-52 行）

```typescript
// microCompact.ts:42-52
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,   // Read  — 文件内容可重新读取
  ...SHELL_TOOL_NAMES,   // Bash  — 命令输出可重新执行
  GREP_TOOL_NAME,        // Grep  — 搜索结果可重新搜索
  GLOB_TOOL_NAME,        // Glob  — 文件列表可重新获取
  WEB_SEARCH_TOOL_NAME,  // WebSearch
  WEB_FETCH_TOOL_NAME,   // WebFetch
  FILE_EDIT_TOOL_NAME,   // Edit  — 编辑结果（diff）可重新生成
  FILE_WRITE_TOOL_NAME,  // Write
  // 注意：AgentTool、SkillTool 等不在此列 — 其结果不可轻易重现
])
```

设计原则：只清除**可重现**的工具结果。Agent 结果、技能输出等不可轻易重现的内容不被清除。

### 3.2 时间触发微压缩（第 437-552 行）

```typescript
// microCompact.ts:437-461
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  // 要求显式 main-thread querySource（undefined 不触发，防止分析调用误触发）
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  // 找最后一条 assistant 消息
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) { return null }

  // 计算空闲时长
  const gapMinutes =
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000

  // 未达到时间阈值
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}
```

**触发逻辑**（第 468-552 行）：
1. 找到最后一条 assistant 消息的时间戳
2. `gapMinutes = (Date.now() - lastAssistant.timestamp) / 60_000`
3. 若 `gapMinutes >= config.gapThresholdMinutes`，触发时间微压缩
4. 清除 `COMPACTABLE_TOOLS` 中最旧的工具结果（保留最近 `keepRecent` 条）
5. 替换内容为 `'[Old tool result content cleared]'`（第 37 行常量）

**设计原因**：缓存已冷（超时后 Prompt Cache 失效），重写 prompt 时无论如何都会 cache miss，此时直接清除旧内容比 cache editing 更合适。同时调用 `resetMicrocompactState()` 防止 Cached MC 尝试 cache_edit 已不存在的条目。

### 3.3 Cached 微压缩（第 316-410 行）

```typescript
// microCompact.ts:316-410
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()
  const config = mod.getCachedMCConfig()

  // 第一步：收集可压缩工具的 ID
  const compactableToolIds = new Set(collectCompactableToolIds(messages))

  // 第二步：按 user 消息分组注册工具结果
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      const groupIds: string[] = []
      for (const block of message.message.content) {
        if (
          block.type === 'tool_result' &&
          compactableToolIds.has(block.tool_use_id) &&
          !state.registeredTools.has(block.tool_use_id)
        ) {
          mod.registerToolResult(state, block.tool_use_id)
          groupIds.push(block.tool_use_id)
        }
      }
      mod.registerToolMessage(state, groupIds)
    }
  }

  // 第三步：决定要删除哪些工具结果
  const toolsToDelete = mod.getToolResultsToDelete(state)

  if (toolsToDelete.length > 0) {
    // 创建 cache_edits 块，在 API 层删除（不修改本地消息！）
    const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
    if (cacheEdits) {
      pendingCacheEdits = cacheEdits  // 存入待发送队列
    }
    // ...返回原始消息，不做任何修改
    return {
      messages,  // 本地消息不变！
      compactionInfo: {
        pendingCacheEdits: {
          trigger: 'auto',
          deletedToolIds: toolsToDelete,
          baselineCacheDeletedTokens: baseline,
        },
      },
    }
  }
  return { messages }
}
```

**关键区别**：Cached MC **不修改本地消息**，通过 API 层的 `cache_edits` 指令实现删除，Prompt Cache prefix 保持不变，避免 cache miss。这是 `apiMicrocompact.ts` 中定义的 API 原生上下文管理机制的客户端实现。

### 3.4 API 原生上下文管理（apiMicrocompact.ts）

```typescript
// apiMicrocompact.ts:64-155
export function getAPIContextManagement(options?: {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
}): ContextManagementConfig | undefined {
  const strategies: ContextEditStrategy[] = []

  // 策略1：清除旧 thinking 块（保留最近 N 个 thinking turns）
  if (hasThinking && !isRedactThinkingActive) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: clearAllThinking ? { type: 'thinking_turns', value: 1 } : 'all',
    })
  }

  // 策略2：清除旧 tool_result 内容（ant-only，需环境变量启用）
  if (useClearToolResults) {
    strategies.push({
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: triggerThreshold },  // 触发阈值
      clear_at_least: { type: 'input_tokens', value: triggerThreshold - keepTarget },
      clear_tool_inputs: TOOLS_CLEARABLE_RESULTS,  // 指定哪些工具的结果可被清除
    })
  }

  return strategies.length > 0 ? { edits: strategies } : undefined
}
```

两种 API 原生策略：
- `clear_thinking_20251015`：清除旧的 thinking 块（extended thinking 模式下）
- `clear_tool_uses_20250919`：当 input_tokens 超过阈值时，清除旧工具结果

---

## 4. Layer 2：会话记忆压缩（Session Memory Compact）

**文件**：`src/services/compact/sessionMemoryCompact.ts`

这是**完全不调用 LLM 的压缩路径**。它依赖后台异步运行的 Session Memory 提取机制（`src/services/SessionMemory/`），该机制在对话过程中持续提取并更新结构化记忆文件。

### 4.1 触发条件检查（第 403-432 行）

```typescript
// sessionMemoryCompact.ts:403-432
export function shouldUseSessionMemoryCompaction(): boolean {
  // 环境变量覆盖（测试/eval 使用）
  if (isEnvTruthy(process.env.ENABLE_CLAUDE_CODE_SM_COMPACT)) { return true }
  if (isEnvTruthy(process.env.DISABLE_CLAUDE_CODE_SM_COMPACT)) { return false }

  // 需要同时启用两个 GrowthBook 功能标志
  const sessionMemoryFlag = getFeatureValue_CACHED_MAY_BE_STALE('tengu_session_memory', false)
  const smCompactFlag = getFeatureValue_CACHED_MAY_BE_STALE('tengu_sm_compact', false)
  return sessionMemoryFlag && smCompactFlag  // 两者均为 true 才启用
}
```

### 4.2 保留消息范围计算（第 324-397 行）

```typescript
// sessionMemoryCompact.ts:324-397
export function calculateMessagesToKeepIndex(
  messages: Message[],
  lastSummarizedIndex: number,
): number {
  const config = getSessionMemoryCompactConfig()
  // 默认配置：minTokens=10,000、minTextBlockMessages=5、maxTokens=40,000

  // 从 lastSummarizedMessageId 之后开始
  let startIndex = lastSummarizedIndex >= 0
    ? lastSummarizedIndex + 1
    : messages.length  // 没有已摘要消息 → 初始不保留任何消息

  // 计算当前保留范围的 token 数和文本消息数
  let totalTokens = 0
  let textBlockMessageCount = 0
  for (let i = startIndex; i < messages.length; i++) {
    totalTokens += estimateMessageTokens([messages[i]!])
    if (hasTextBlocks(messages[i]!)) { textBlockMessageCount++ }
  }

  // 已超过最大 token 上限，直接返回
  if (totalTokens >= config.maxTokens) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // 已满足最小要求，直接返回
  if (totalTokens >= config.minTokens && textBlockMessageCount >= config.minTextBlockMessages) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // 向前扩展，直到满足最小要求或达到最大 token 上限
  const floor = messages.findLastIndex(m => isCompactBoundaryMessage(m))
  const floorIndex = floor === -1 ? 0 : floor + 1
  for (let i = startIndex - 1; i >= floorIndex; i--) {
    totalTokens += estimateMessageTokens([messages[i]!])
    if (hasTextBlocks(messages[i]!)) { textBlockMessageCount++ }
    startIndex = i

    if (totalTokens >= config.maxTokens) { break }
    if (totalTokens >= config.minTokens && textBlockMessageCount >= config.minTextBlockMessages) { break }
  }

  // 调整索引，避免拆分 tool_use/tool_result 对
  return adjustIndexToPreserveAPIInvariants(messages, startIndex)
}
```

### 4.3 API 不变量保持（第 232-314 行）

```typescript
// sessionMemoryCompact.ts:232-314
export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
): number {
  // 步骤1：处理 tool_use/tool_result 对
  // 收集保留范围内所有 tool_result 的 ID
  // 若有 tool_result 缺少对应的 tool_use，向前扩展 startIndex 直到包含该 tool_use

  // 步骤2：处理 thinking 块
  // 收集保留范围内所有 assistant 消息的 message.id
  // 若前面有相同 message.id 的 assistant 消息（含 thinking 块），向前扩展
  // 原因：normalizeMessagesForAPI 按 message.id 合并消息，缺少 thinking 块会导致丢失
  ...
}
```

**为什么需要这个函数**：Claude API 要求每个 `tool_result` 必须有对应的 `tool_use`，且 thinking 块需要与同一 `message.id` 的工具调用合并。简单按索引切割会破坏这些不变量。

### 4.4 主函数（第 527-643 行）

```typescript
// sessionMemoryCompact.ts:527-643
export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: AgentId,
  autoCompactThreshold?: number,
): Promise<CompactionResult | null> {
  if (!shouldUseSessionMemoryCompaction()) { return null }

  await initSessionMemoryCompactConfig()
  await waitForSessionMemoryExtraction()  // 等待后台记忆提取完成

  const lastSummarizedMessageId = getLastSummarizedMessageId()
  const sessionMemory = await getSessionMemoryContent()

  if (!sessionMemory) { return null }  // 无记忆文件
  if (await isSessionMemoryEmpty(sessionMemory)) { return null }  // 记忆文件为空模板

  // 找到已摘要消息的位置
  let lastSummarizedIndex: number
  if (lastSummarizedMessageId) {
    lastSummarizedIndex = messages.findIndex(msg => msg.uuid === lastSummarizedMessageId)
    if (lastSummarizedIndex === -1) { return null }  // 找不到边界，回退到全量压缩
  } else {
    // 恢复会话场景：记忆存在但不知道边界 → 保留所有消息
    lastSummarizedIndex = messages.length - 1
  }

  // 计算保留范围
  const startIndex = calculateMessagesToKeepIndex(messages, lastSummarizedIndex)
  const messagesToKeep = messages
    .slice(startIndex)
    .filter(m => !isCompactBoundaryMessage(m))  // 过滤旧边界标记

  // 执行会话启动 hooks（恢复 CLAUDE.md 等）
  const hookResults = await processSessionStartHooks('compact', { model: getMainLoopModel() })

  // 直接用记忆内容构建 CompactionResult，不调用 LLM！
  const compactionResult = createCompactionResultFromSessionMemory(
    messages,
    sessionMemory,   // 后台异步提取的记忆文件内容
    messagesToKeep,  // 保留的原始消息
    hookResults,
    transcriptPath,
    agentId,
  )

  // 检查压缩后是否仍超过阈值（若超过则回退到全量压缩）
  const postCompactTokenCount = estimateMessageTokens(buildPostCompactMessages(compactionResult))
  if (autoCompactThreshold !== undefined && postCompactTokenCount >= autoCompactThreshold) {
    return null  // 让调用方回退到 compactConversation
  }

  return { ...compactionResult, postCompactTokenCount, truePostCompactTokenCount: postCompactTokenCount }
}
```

**优势**：
- 无需调用 LLM，节省 API 费用
- 保留最近原始消息（无摘要失真）
- Token 节省约 70-80%

---

## 5. Layer 3：全量摘要压缩（compactConversation）

**文件**：`src/services/compact/compact.ts`

当前两层无法处理时，调用 LLM 生成结构化摘要。

### 5.1 主函数入口（第 392-796 行）

```typescript
// compact.ts:392-796
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult> {
  // 1. 执行 PreCompact hooks（可注入自定义指令）
  const hookResult = await executePreCompactHooks(
    { trigger: isAutoCompact ? 'auto' : 'manual', customInstructions: customInstructions ?? null },
    context.abortController.signal,
  )
  // 合并 hook 注入的指令与用户自定义指令
  customInstructions = mergeHookInstructions(customInstructions, hookResult.newCustomInstructions)

  // 2. 构建摘要请求
  const compactPrompt = getCompactPrompt(customInstructions)  // 9 段摘要结构
  const summaryRequest = createUserMessage({ content: compactPrompt })

  // 3. 流式调用模型生成摘要（含 prompt_too_long 重试循环）
  let messagesToSummarize = messages
  for (;;) {
    summaryResponse = await streamCompactSummary({
      messages: messagesToSummarize,
      summaryRequest,
      ...
    })
    summary = getAssistantMessageText(summaryResponse)

    // 摘要成功 → 退出循环
    if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break

    // prompt_too_long → 截断最旧 API 轮次，重试（最多 3 次）
    const truncated = truncateHeadForPTLRetry(messagesToSummarize, summaryResponse)
    if (!truncated) throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
    messagesToSummarize = truncated
  }

  // 4. 清空文件读取缓存（压缩后重新读取）
  context.readFileState.clear()
  context.loadedNestedMemoryPaths?.clear()

  // 5. 并行生成压缩后的附件
  const [fileAttachments, asyncAgentAttachments] = await Promise.all([
    createPostCompactFileAttachments(preCompactReadFileState, context, POST_COMPACT_MAX_FILES_TO_RESTORE),
    createAsyncAgentAttachmentsIfNeeded(context),
  ])

  // 6. 追加其他必要附件
  const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
  const skillAttachment = createSkillAttachmentIfNeeded(context.agentId)
  // 重新宣告工具列表、Agent 列表、MCP 指令...

  // 7. 执行 SessionStart hooks（恢复 CLAUDE.md 等）
  const hookMessages = await processSessionStartHooks('compact', { model: context.options.mainLoopModel })

  // 8. 创建压缩边界标记
  const boundaryMarker = createCompactBoundaryMessage(
    isAutoCompact ? 'auto' : 'manual',
    preCompactTokenCount ?? 0,
    messages.at(-1)?.uuid,
  )

  // 9. 返回 CompactionResult
  return {
    boundaryMarker,
    summaryMessages,   // 摘要文本（作为 user 消息注入）
    attachments: postCompactFileAttachments,
    hookResults: hookMessages,
    preCompactTokenCount,
    truePostCompactTokenCount,
    compactionUsage,
  }
}
```

### 5.2 prompt_too_long 重试机制（第 246-294 行）

```typescript
// compact.ts:246-294
export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null {
  // 去除上次重试添加的合成标记
  const input = messages[0]?.type === 'user' &&
    messages[0].isMeta &&
    messages[0].message.content === PTL_RETRY_MARKER
    ? messages.slice(1)
    : messages

  // 按 API 轮次分组
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null  // 无法再截断

  // 根据 tokenGap 精确计算需丢弃的轮次数
  const tokenGap = getPromptTooLongTokenGap(ptlResponse)
  let dropCount: number
  if (tokenGap !== undefined) {
    let acc = 0
    dropCount = 0
    for (const g of groups) {
      acc += roughTokenCountEstimationForMessages(g)
      dropCount++
      if (acc >= tokenGap) break  // 累积到足够 token 就停止
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))  // 无法解析时丢弃 20%
  }

  dropCount = Math.min(dropCount, groups.length - 1)  // 至少保留一组
  const sliced = groups.slice(dropCount).flat()

  // 若截断后首条是 assistant 消息，补一个合成 user 标记（API 要求首条为 user）
  if (sliced[0]?.type === 'assistant') {
    return [createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }), ...sliced]
  }
  return sliced
}
```

### 5.3 图片剥离（第 147-202 行）

```typescript
// compact.ts:147-202
export function stripImagesFromMessages(messages: Message[]): Message[] {
  // 将 image 块替换为 '[image]' 文本标记
  // 将 document 块替换为 '[document]' 文本标记
  // 递归处理 tool_result 内部的嵌套图片
  // 原因：图片会导致摘要请求本身触发 prompt_too_long
}
```

### 5.4 局部压缩（第 806-1140 行）

```typescript
// compact.ts:806-1140
export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from',
): Promise<CompactionResult> {
  // direction = 'from'：压缩 pivotIndex 之后的消息，保留之前的（保留头部）
  // direction = 'up_to'：压缩 pivotIndex 之前的消息，保留之后的（保留尾部）

  const messagesToSummarize = direction === 'up_to'
    ? allMessages.slice(0, pivotIndex)
    : allMessages.slice(pivotIndex)

  const messagesToKeep = direction === 'up_to'
    ? allMessages.slice(pivotIndex).filter(m =>
        m.type !== 'progress' &&
        !isCompactBoundaryMessage(m) &&
        !(m.type === 'user' && m.isCompactSummary)
      )
    : allMessages.slice(0, pivotIndex).filter(m => m.type !== 'progress')
  ...
}
```

---

## 6. 自动压缩触发机制（autoCompactIfNeeded）

**文件**：`src/services/compact/autoCompact.ts`

### 6.1 Token 阈值计算（第 34-100 行）

```typescript
// autoCompact.ts:34-51
export function getEffectiveContextWindowSize(model: string): number {
  // 有效上下文窗口 = 模型窗口 - 为摘要输出预留的 token 数
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,  // 20,000 tokens（p99.99 摘要输出为 17,387 tokens）
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  // 支持环境变量覆盖：CLAUDE_CODE_AUTO_COMPACT_WINDOW
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

// autoCompact.ts:81-100
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  // 减去 13,000 安全边距
}
```

**以 Claude Sonnet（200K 窗口）为例**：
```
模型窗口：        200,000 tokens
有效窗口：        200,000 - 20,000 = 180,000 tokens
自动压缩触发：    180,000 - 13,000 = 167,000 tokens（约 83.5%）
警告 UI 显示：    167,000 - 20,000 = 147,000 tokens（约 73.5%）
阻塞限制：        180,000 - 3,000  = 177,000 tokens（约 88.5%）
```

### 6.2 shouldAutoCompact 守卫（第 172-258 行）

```typescript
// autoCompact.ts:172-258
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  snipTokensFreed = 0,
): Promise<boolean> {
  // 守卫1：递归防护（session_memory 和 compact 是 forked agent，会死锁）
  if (querySource === 'session_memory' || querySource === 'compact') { return false }

  // 守卫2：Context Collapse 模式防护（ant-only）
  // 90% commit / 95% blocking 流程接管，autocompact 会与之竞争

  // 守卫3：Reactive Compact 模式（等 API 返回 prompt_too_long）

  // 守卫4：用户配置和环境变量检查（DISABLE_COMPACT、DISABLE_AUTO_COMPACT）

  // 守卫5：Token 计数比对
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(tokenCount, model)
  return isAboveAutoCompactThreshold
}
```

### 6.3 熔断机制（第 260-374 行）

```typescript
// autoCompact.ts:260-374
export async function autoCompactIfNeeded(...): Promise<...> {
  // 熔断：连续失败 >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES(3) 时停止重试
  // 背景：BQ 2026-03-10 数据显示有 1,279 个会话连续失败 50+ 次（最多 3,272 次），
  //       浪费约 250K API 调用/天
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  // 先尝试 Session Memory 压缩（轻量，不调用 LLM）
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) { return { wasCompacted: true, compactionResult: sessionMemoryResult } }

  // 回退到全量摘要压缩（调用 LLM）
  try {
    const compactionResult = await compactConversation(messages, toolUseContext, ...)
    return { wasCompacted: true, compactionResult, consecutiveFailures: 0 }
  } catch (error) {
    const nextFailures = (tracking?.consecutiveFailures ?? 0) + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      // 熔断触发，记录日志
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
```

---

## 7. Prompt Cache 共享：摘要请求复用缓存前缀

**文件**：`src/services/compact/compact.ts`，第 1174-1434 行

这是"不调用摘要模型"的关键设计——即使需要 LLM，也通过复用 Prompt Cache 大幅降低费用。

```typescript
// compact.ts:1174-1286
async function streamCompactSummary({
  messages,
  summaryRequest,
  appState,
  context,
  preCompactTokenCount,
  cacheSafeParams,
}): Promise<AssistantMessage> {
  // 实验验证（2026 年 1 月）：
  // - false 路径（不共享缓存）：98% cache miss
  // - 每天浪费约 38B token（约占 fleet cache_creation 的 0.76%）
  // - 主要集中在 ephemeral 环境（CCR/GHA/SDK）和 3P providers
  const promptCacheSharingEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_compact_cache_prefix',
    true,  // 默认启用
  )

  if (promptCacheSharingEnabled) {
    try {
      // runForkedAgent 发送与主对话完全相同的 cache key 参数
      // （system、tools、model、messages prefix、thinking config）
      // 摘要请求 = 主对话历史 + summaryRequest（新增的 user 消息）
      // 前缀部分命中缓存 → 只有新增的摘要 prompt 需要计费
      const result = await runForkedAgent({
        promptMessages: [summaryRequest],   // 只追加摘要请求
        cacheSafeParams,                    // 包含主对话的完整 cache key
        canUseTool: createCompactCanUseTool(),  // 禁止工具调用
        querySource: 'compact',
        forkLabel: 'compact',
        maxTurns: 1,
        skipCacheWrite: true,  // 不写入新缓存（避免污染主对话缓存）
        overrides: { abortController: context.abortController },
      })
      // 成功则直接返回，跳过流式路径
      const assistantMsg = getLastAssistantMessage(result.messages)
      if (assistantMsg && !assistantMsg.isApiErrorMessage) {
        return assistantMsg
      }
    } catch (error) {
      // 失败则回退到流式路径
    }
  }

  // 流式回退路径（cache sharing 失败或禁用时）
  // 注意：此路径可以安全设置 maxOutputTokensOverride，
  // 因为不共享缓存，不需要保持 thinking config 一致
  const streamingGen = queryModelWithStreaming({
    messages: normalizeMessagesForAPI(
      stripImagesFromMessages(
        stripReinjectedAttachments([
          ...getMessagesAfterCompactBoundary(messages),
          summaryRequest,
        ]),
      ),
      context.options.tools,
    ),
    systemPrompt: asSystemPrompt(['You are a helpful AI assistant tasked with summarizing conversations.']),
    thinkingConfig: { type: 'disabled' as const },  // 摘要时禁用 thinking
    tools: [FileReadTool],  // 摘要时只允许 FileRead（通常也被 canUseTool 禁止）
    ...
  })
  ...
}
```

**为什么不能在 forked agent 路径设置 maxOutputTokens**（代码注释，第 1219-1225 行）：
> DO NOT set maxOutputTokens here. The fork piggybacks on the main thread's prompt cache by sending identical cache-key params. Setting maxOutputTokens would clamp budget_tokens via Math.min(budget, maxOutputTokens-1) in claude.ts, creating a thinking config mismatch that invalidates the cache.

---

## 8. 压缩后的上下文重建

压缩完成后，系统需要将关键上下文重新注入，否则模型会"失忆"。

### 8.1 文件附件恢复（compact.ts:1453-1504）

```typescript
// compact.ts:1453-1504
export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages: Message[] = [],
): Promise<AttachmentMessage[]> {
  // 跳过已在保留消息中存在的文件（避免重复注入）
  const preservedReadPaths = collectReadToolFilePaths(preservedMessages)

  // 按时间戳倒序，取最近读取的 maxFiles 个文件
  const recentFiles = Object.entries(readFileState)
    .map(([filename, state]) => ({ filename, ...state }))
    .filter(file =>
      !shouldExcludeFromPostCompactRestore(file.filename, toolUseContext.agentId) &&
      !preservedReadPaths.has(expandPath(file.filename))
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxFiles)  // POST_COMPACT_MAX_FILES_TO_RESTORE = 5

  // 重新读取文件内容（获取最新版本）
  const results = await Promise.all(
    recentFiles.map(async file => {
      const attachment = await generateFileAttachment(
        file.filename,
        { ...toolUseContext, fileReadingLimits: { maxTokens: POST_COMPACT_MAX_TOKENS_PER_FILE } },
        // POST_COMPACT_MAX_TOKENS_PER_FILE = 5,000
        ...
      )
      return attachment ? createAttachmentMessage(attachment) : null
    }),
  )

  // Token 预算过滤（总预算 POST_COMPACT_TOKEN_BUDGET = 50,000）
  let usedTokens = 0
  return results.filter((result): result is AttachmentMessage => {
    if (result === null) { return false }
    const attachmentTokens = roughTokenCountEstimation(jsonStringify(result))
    if (usedTokens + attachmentTokens <= POST_COMPACT_TOKEN_BUDGET) {
      usedTokens += attachmentTokens
      return true
    }
    return false
  })
}
```

### 8.2 技能附件恢复（compact.ts:1535-1581）

```typescript
// compact.ts:1535-1581
export function createSkillAttachmentIfNeeded(agentId?: string): AttachmentMessage | null {
  const invokedSkills = getInvokedSkillsForAgent(agentId)
  if (invokedSkills.size === 0) { return null }

  // 按调用时间倒序（最近调用的优先保留）
  let usedTokens = 0
  const skills = Array.from(invokedSkills.values())
    .sort((a, b) => b.invokedAt - a.invokedAt)
    .map(skill => ({
      name: skill.skillName,
      path: skill.skillPath,
      // 每个技能最多 5K tokens（保留头部，通常是使用说明）
      content: truncateToTokens(skill.content, POST_COMPACT_MAX_TOKENS_PER_SKILL),
    }))
    .filter(skill => {
      const tokens = roughTokenCountEstimation(skill.content)
      if (usedTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) { return false }
      // 总预算 POST_COMPACT_SKILLS_TOKEN_BUDGET = 25,000
      usedTokens += tokens
      return true
    })

  return createAttachmentMessage({ type: 'invoked_skills', skills })
}
```

### 8.3 完整重建顺序（compact.ts:335-343）

```typescript
// compact.ts:335-343
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,     // 1. 压缩边界标记（含 pre-compact token 数）
    ...result.summaryMessages, // 2. 摘要文本（作为 user 消息）
    ...(result.messagesToKeep ?? []), // 3. 保留的原始消息（会话记忆路径）
    ...result.attachments,     // 4. 恢复的文件/技能/工具/Agent 列表/MCP 指令
    ...result.hookResults,     // 5. CLAUDE.md 等会话启动上下文
  ]
}
```

---

## 9. Token 阈值体系

| 常量 | 值 | 文件:行号 | 含义 |
|-----|---|---------|-----|
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | autoCompact.ts:30 | 为摘要输出预留 |
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | autoCompact.ts:64 | 自动压缩安全边距 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | autoCompact.ts:65 | 警告 UI 显示阈值 |
| `ERROR_THRESHOLD_BUFFER_TOKENS` | 20,000 | autoCompact.ts:66 | 错误阈值 |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | autoCompact.ts:67 | 手动 /compact 边距 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | autoCompact.ts:72 | 熔断阈值 |
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | compact.ts:122 | 压缩后最多恢复文件数 |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | compact.ts:124 | 文件恢复总 token 预算 |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | compact.ts:125 | 单文件 token 上限 |
| `POST_COMPACT_MAX_TOKENS_PER_SKILL` | 5,000 | compact.ts:130 | 单技能 token 上限 |
| `POST_COMPACT_SKILLS_TOKEN_BUDGET` | 25,000 | compact.ts:131 | 技能恢复总 token 预算 |
| `MAX_COMPACT_STREAMING_RETRIES` | 2 | compact.ts:132 | 流式摘要失败重试次数 |
| `MAX_PTL_RETRIES` | 3 | compact.ts:229 | prompt_too_long 重试次数 |
| `SM_COMPACT_MIN_TOKENS` | 10,000 | sessionMemoryCompact.ts:58 | 会话记忆压缩最小保留 token |
| `SM_COMPACT_MIN_TEXT_MESSAGES` | 5 | sessionMemoryCompact.ts:59 | 会话记忆压缩最小文本消息数 |
| `SM_COMPACT_MAX_TOKENS` | 40,000 | sessionMemoryCompact.ts:60 | 会话记忆压缩最大保留 token |

---

## 10. 摘要提示词设计

**文件**：`src/services/compact/prompt.ts`

### 10.1 防工具调用前缀（第 23-30 行）

```typescript
// prompt.ts:23-30
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`
```

**设计原因**（代码注释，第 12-21 行）：Sonnet 4.6+ adaptive thinking 模型有时会在摘要时尝试调用工具。若工具调用被拒绝，`maxTurns: 1` 下无文本输出，会回退到流式路径（约 2.79% 概率）。将此段放在最前面并明确说明后果，可将失败率从 2.79% 降至 0.01%。

### 10.2 分析-摘要双阶段结构（第 36-49 行）

```typescript
// prompt.ts:36-49
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags...

1. Chronologically analyze each message and section of the conversation...
   - The user's explicit requests and intents
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback...
2. Double-check for technical accuracy and completeness...`
```

`<analysis>` 块是一个**思考草稿区**，`formatCompactSummary()` 函数（第 332-358 行）会在摘要注入上下文前将其去除，只保留 `<summary>` 内容。

### 10.3 9 段摘要结构（第 77-159 行）

| 段落 | 内容 | 设计意图 |
|-----|-----|---------|
| 1. Primary Request and Intent | 用户所有明确请求 | 完整捕获，防止任务漂移 |
| 2. Key Technical Concepts | 技术概念、框架、技术栈 | 保留领域知识 |
| 3. Files and Code Sections | 检查/修改/创建的文件，含完整代码片段 | 保留代码上下文 |
| 4. Errors and Fixes | 错误及修复，含用户反馈 | 防止重蹈覆辙 |
| 5. Problem Solving | 已解决的问题和进行中的调试 | 保留调试状态 |
| **6. All User Messages** | **所有非工具结果的用户消息（完整保留）** | **追踪意图变化，最关键** |
| 7. Pending Tasks | 明确被要求的待办任务 | 任务连续性 |
| 8. Current Work | 压缩前正在进行的工作（含文件名和代码片段） | 恢复工作状态 |
| **9. Optional Next Step** | **下一步行动（含原文引用，防止任务漂移）** | **防止任务漂移** |

### 10.4 摘要包装为用户消息（第 361-398 行）

```typescript
// prompt.ts:361-398
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)  // 去除 <analysis> 块

  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`

  if (transcriptPath) {
    // 告知模型可以读取完整记录（如需要精确代码片段等）
    baseSummary += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
  }

  if (suppressFollowUpQuestions) {
    // 自动压缩时：直接继续，不询问用户
    return `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`
  }

  return baseSummary
}
```

摘要被包装成一条 **user 消息**（`isCompactSummary: true`）注入上下文，而非 system prompt。这样模型能以"接收方"的视角读取摘要，与正常对话流保持一致。

---

## 总结：三层压缩的选择逻辑

```
每次请求前：
  microcompactMessages()
    ├── 时间触发（缓存已冷）→ 直接清除旧工具结果，替换为占位符
    └── Cached MC（缓存温热）→ 通过 API cache_edits 删除，不修改本地消息

Token 超过阈值时：
  autoCompactIfNeeded()
    ├── trySessionMemoryCompaction()
    │     ├── 有记忆文件 + 知道边界 → 用记忆替换历史，保留最近消息（不调用 LLM）
    │     └── 条件不满足 → null
    └── compactConversation()
          ├── runForkedAgent（复用 Prompt Cache 前缀）→ 生成 9 段结构化摘要
          ├── prompt_too_long → truncateHeadForPTLRetry() 截断重试（最多 3 次）
          └── 压缩后重建：文件(5个/50K) + 技能(25K) + 工具列表 + CLAUDE.md
```

核心设计哲学：**能不调用 LLM 就不调用，必须调用时复用缓存，调用后精确重建上下文**。
