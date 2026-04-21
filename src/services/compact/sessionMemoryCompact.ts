/**
 * EXPERIMENT: Session memory compaction
 */

import type { AgentId } from '../../types/ids.js'
import type { HookResultMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  isCompactBoundaryMessage,
} from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { extractDiscoveredToolNames } from '../../utils/toolSearch.js'
import {
  getDynamicConfig_BLOCKS_ON_INIT,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../analytics/growthbook.js'
import { logEvent } from '../analytics/index.js'
import {
  isSessionMemoryEmpty,
  truncateSessionMemoryForCompact,
} from '../SessionMemory/prompts.js'
import {
  getLastSummarizedMessageId,
  getSessionMemoryContent,
  waitForSessionMemoryExtraction,
} from '../SessionMemory/sessionMemoryUtils.js'
import {
  annotateBoundaryWithPreservedSegment,
  buildPostCompactMessages,
  type CompactionResult,
  createPlanAttachmentIfNeeded,
} from './compact.js'
import { estimateMessageTokens } from './microCompact.js'
import { getCompactUserSummaryMessage } from './prompt.js'

/**
 * Configuration for session memory compaction thresholds
 */
export type SessionMemoryCompactConfig = {
  /** Minimum tokens to preserve after compaction */
  minTokens: number
  /** Minimum number of messages with text blocks to keep */
  minTextBlockMessages: number
  /** Maximum tokens to preserve after compaction (hard cap) */
  maxTokens: number
}

// Default configuration values (exported for use in tests)
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
}

// Current configuration (starts with defaults)
let smCompactConfig: SessionMemoryCompactConfig = {
  ...DEFAULT_SM_COMPACT_CONFIG,
}

// Track whether config has been initialized from remote
let configInitialized = false

/**
 * Set the session memory compact configuration
 */
export function setSessionMemoryCompactConfig(
  config: Partial<SessionMemoryCompactConfig>,
): void {
  smCompactConfig = {
    ...smCompactConfig,
    ...config,
  }
}

/**
 * Get the current session memory compact configuration
 */
export function getSessionMemoryCompactConfig(): SessionMemoryCompactConfig {
  return { ...smCompactConfig }
}

/**
 * Reset config state (useful for testing)
 */
export function resetSessionMemoryCompactConfig(): void {
  smCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG }
  configInitialized = false
}

/**
 * Initialize configuration from remote config (GrowthBook).
 * Only fetches once per session - subsequent calls return immediately.
 */
async function initSessionMemoryCompactConfig(): Promise<void> {
  if (configInitialized) {
    return
  }
  configInitialized = true

  // Load config from GrowthBook, merging with defaults
  const remoteConfig = await getDynamicConfig_BLOCKS_ON_INIT<
    Partial<SessionMemoryCompactConfig>
  >('tengu_sm_compact_config', {})

  // Only use remote values if they are explicitly set (positive numbers)
  // This ensures sensible defaults aren't overridden by zero values
  const config: SessionMemoryCompactConfig = {
    minTokens:
      remoteConfig.minTokens && remoteConfig.minTokens > 0
        ? remoteConfig.minTokens
        : DEFAULT_SM_COMPACT_CONFIG.minTokens,
    minTextBlockMessages:
      remoteConfig.minTextBlockMessages && remoteConfig.minTextBlockMessages > 0
        ? remoteConfig.minTextBlockMessages
        : DEFAULT_SM_COMPACT_CONFIG.minTextBlockMessages,
    maxTokens:
      remoteConfig.maxTokens && remoteConfig.maxTokens > 0
        ? remoteConfig.maxTokens
        : DEFAULT_SM_COMPACT_CONFIG.maxTokens,
  }
  setSessionMemoryCompactConfig(config)
}

/**
 * Check if a message contains text blocks (text content for user/assistant interaction)
 */
export function hasTextBlocks(message: Message): boolean {
  if (message.type === 'assistant') {
    const content = message.message.content
    return content.some(block => block.type === 'text')
  }
  if (message.type === 'user') {
    const content = message.message.content
    if (typeof content === 'string') {
      return content.length > 0
    }
    if (Array.isArray(content)) {
      return content.some(block => block.type === 'text')
    }
  }
  return false
}

/**
 * Check if a message contains tool_result blocks and return their tool_use_ids
 */
function getToolResultIds(message: Message): string[] {
  if (message.type !== 'user') {
    return []
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return []
  }
  const ids: string[] = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Check if a message contains tool_use blocks with any of the given ids
 */
function hasToolUseWithIds(message: Message, toolUseIds: Set<string>): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block => block.type === 'tool_use' && toolUseIds.has(block.id),
  )
}

/**
 * Adjust the start index to ensure we don't split tool_use/tool_result pairs
 * or thinking blocks that share the same message.id with kept assistant messages.
 *
 * If ANY message we're keeping contains tool_result blocks, we need to
 * include the preceding assistant message(s) that contain the matching tool_use blocks.
 *
 * Additionally, if ANY assistant message in the kept range has the same message.id
 * as a preceding assistant message (which may contain thinking blocks), we need to
 * include those messages so they can be properly merged by normalizeMessagesForAPI.
 *
 * This handles the case where streaming yields separate messages per content block
 * (thinking, tool_use, etc.) with the same message.id but different uuids. If the
 * startIndex lands on one of these streaming messages, we need to look at ALL kept
 * messages for tool_results, not just the first one.
 *
 * Example bug scenarios this fixes:
 *
 * Tool pair scenario:
 *   Session storage (before compaction):
 *     Index N:   assistant, message.id: X, content: [thinking]
 *     Index N+1: assistant, message.id: X, content: [tool_use: ORPHAN_ID]
 *     Index N+2: assistant, message.id: X, content: [tool_use: VALID_ID]
 *     Index N+3: user, content: [tool_result: ORPHAN_ID, tool_result: VALID_ID]
 *
 *   If startIndex = N+2:
 *     - Old code: checked only message N+2 for tool_results, found none, returned N+2
 *     - After slicing and normalizeMessagesForAPI merging by message.id:
 *       msg[1]: assistant with [tool_use: VALID_ID]  (ORPHAN tool_use was excluded!)
 *       msg[2]: user with [tool_result: ORPHAN_ID, tool_result: VALID_ID]
 *     - API error: orphan tool_result references non-existent tool_use
 *
 * Thinking block scenario:
 *   Session storage (before compaction):
 *     Index N:   assistant, message.id: X, content: [thinking]
 *     Index N+1: assistant, message.id: X, content: [tool_use: ID]
 *     Index N+2: user, content: [tool_result: ID]
 *
 *   If startIndex = N+1:
 *     - Without this fix: thinking block at N is excluded
 *     - After normalizeMessagesForAPI: thinking block is lost (no message to merge with)
 *
 *   Fixed code: detects that message N+1 has same message.id as N, adjusts to N.
 */
// ! API 要求每个 tool_result 都有对应的 tool_use，反之亦然。如果压缩恰好切在一条 tool_result 消息处，会导致 API 报错。
// ! 流式传输会将一个 assistant 消息拆分为多条存储记录（thinking、tool_use 等各有独立 uuid 但共享 message.id），这增加了边界情况的复杂度。
// ! 为什么需要这个函数：Claude API 要求每个 tool_result 必须有对应的 tool_use，且 thinking 块需要与同一 message.id 的工具调用合并。简单按索引切割会破坏这些不变量。
export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex
  }

  let adjustedIndex = startIndex

  // Step 1: Handle tool_use/tool_result pairs
  // Collect tool_result IDs from ALL messages in the kept range
  // ! Step 1: 向前扫描，找到所有被保留消息中 tool_result 引用的 tool_use
  // 收集保留范围内所有 tool_result 的 ID
  // 若有 tool_result 缺少对应的 tool_use，向前扩展 startIndex 直到包含该 tool_use
  const allToolResultIds: string[] = []
  for (let i = startIndex; i < messages.length; i++) {
    allToolResultIds.push(...getToolResultIds(messages[i]!))
  }

  if (allToolResultIds.length > 0) {
    // Collect tool_use IDs already in the kept range
    const toolUseIdsInKeptRange = new Set<string>()
    for (let i = adjustedIndex; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolUseIdsInKeptRange.add(block.id)
          }
        }
      }
    }

    // Only look for tool_uses that are NOT already in the kept range
    const neededToolUseIds = new Set(
      allToolResultIds.filter(id => !toolUseIdsInKeptRange.has(id)),
    )

    // Find the assistant message(s) with matching tool_use blocks
    // ! Step 2: 向前扫描，找到与被保留 assistant 消息共享 message.id 的 thinking block
    // 收集保留范围内所有 assistant 消息的 message.id
    // 若前面有相同 message.id 的 assistant 消息（含 thinking 块），向前扩展
    // 原因：normalizeMessagesForAPI 按 message.id 合并消息，缺少 thinking 块会导致丢失
    for (let i = adjustedIndex - 1; i >= 0 && neededToolUseIds.size > 0; i--) {
      const message = messages[i]!
      if (hasToolUseWithIds(message, neededToolUseIds)) {
        adjustedIndex = i
        // Remove found tool_use_ids from the set
        if (
          message.type === 'assistant' &&
          Array.isArray(message.message.content)
        ) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && neededToolUseIds.has(block.id)) {
              neededToolUseIds.delete(block.id)
            }
          }
        }
      }
    }
  }

  // Step 2: Handle thinking blocks that share message.id with kept assistant messages
  // Collect all message.ids from assistant messages in the kept range
  const messageIdsInKeptRange = new Set<string>()
  for (let i = adjustedIndex; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.message.id) {
      messageIdsInKeptRange.add(msg.message.id)
    }
  }

  // Look backwards for assistant messages with the same message.id that are not in the kept range
  // These may contain thinking blocks that need to be merged by normalizeMessagesForAPI
  for (let i = adjustedIndex - 1; i >= 0; i--) {
    const message = messages[i]!
    if (
      message.type === 'assistant' &&
      message.message.id &&
      messageIdsInKeptRange.has(message.message.id)
    ) {
      // This message has the same message.id as one in the kept range
      // Include it so thinking blocks can be properly merged
      adjustedIndex = i
    }
  }

  return adjustedIndex
}

/**
 * Calculate the starting index for messages to keep after compaction.
 * Starts from lastSummarizedMessageId, then expands backwards to meet minimums:
 * - At least config.minTokens tokens
 * - At least config.minTextBlockMessages messages with text blocks
 * Stops expanding if config.maxTokens is reached.
 * Also ensures tool_use/tool_result pairs are not split.
 */
// ! 保留消息范围计算
/**
 * 这个算法确保压缩后保留的消息窗口满足：
至少 10,000 token（有上下文深度）
至少 5 条包含文本的消息（有对话连续性）
最多 40,000 token（不会太大又触发下一次压缩）
 */
// ! Session Memory Compact — 无 API 调用的压缩
export function calculateMessagesToKeepIndex(
  messages: Message[],
  lastSummarizedIndex: number,
): number {
  if (messages.length === 0) {
    return 0
  }

  // ! // 默认配置：minTokens=10,000、minTextBlockMessages=5、maxTokens=40,000
  const config = getSessionMemoryCompactConfig()

  // Start from the message after lastSummarizedIndex
  // If lastSummarizedIndex is -1 (not found) or messages.length (no summarized id),
  // we start with no messages kept
  // ! // 从 lastSummarizedMessageId 之后开始
  let startIndex =
    lastSummarizedIndex >= 0 ? lastSummarizedIndex + 1 : messages.length  // ! // 没有已摘要消息 → 初始不保留任何消息

  // Calculate current tokens and text-block message count from startIndex to end
  // ! // 计算当前保留范围的 token 数和文本消息数
  let totalTokens = 0
  let textBlockMessageCount = 0
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!
    totalTokens += estimateMessageTokens([msg])
    if (hasTextBlocks(msg)) {
      textBlockMessageCount++
    }
  }

  // Check if we already hit the max cap
  // ! // 已超过最大 token 上限，直接返回
  if (totalTokens >= config.maxTokens) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // Check if we already meet both minimums
  // ! // 已满足最小要求，直接返回
  if (
    totalTokens >= config.minTokens &&
    textBlockMessageCount >= config.minTextBlockMessages
  ) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // Expand backwards until we meet both minimums or hit max cap.
  // Floor at the last boundary: the preserved-segment chain has a disk
  // discontinuity there (att[0]→summary shortcut from dedup-skip), which
  // would let the loader's tail→head walk bypass inner preserved messages
  // and then prune them. Reactive compact already slices at the boundary
  // via getMessagesAfterCompactBoundary; this is the same invariant.
  const idx = messages.findLastIndex(m => isCompactBoundaryMessage(m))
  // ! // 向前扩展，直到满足最小要求或达到最大 token 上限
  const floor = idx === -1 ? 0 : idx + 1
  for (let i = startIndex - 1; i >= floor; i--) {
    const msg = messages[i]!
    const msgTokens = estimateMessageTokens([msg])
    totalTokens += msgTokens
    if (hasTextBlocks(msg)) {
      textBlockMessageCount++
    }
    startIndex = i

    // Stop if we hit the max cap
    if (totalTokens >= config.maxTokens) {
      break
    }

    // Stop if we meet both minimums
    if (
      totalTokens >= config.minTokens &&
      textBlockMessageCount >= config.minTextBlockMessages
    ) {
      break
    }
  }

  // Adjust for tool pairs
  // ! // 调整索引，避免拆分 tool_use/tool_result 对
  return adjustIndexToPreserveAPIInvariants(messages, startIndex)
}

/**
 * Check if we should use session memory for compaction
 * Uses cached gate values to avoid blocking on Statsig initialization
 */
export function shouldUseSessionMemoryCompaction(): boolean {
  // Allow env var override for eval runs and testing
  // ! // 环境变量覆盖（测试/eval 使用）
  if (isEnvTruthy(process.env.ENABLE_CLAUDE_CODE_SM_COMPACT)) {
    return true
  }
  if (isEnvTruthy(process.env.DISABLE_CLAUDE_CODE_SM_COMPACT)) {
    return false
  }

  // ! // 需要同时启用两个 GrowthBook 功能标志
  const sessionMemoryFlag = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_session_memory',
    false,
  )
  const smCompactFlag = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_sm_compact',
    false,
  )

  // ! // 两者均为 true 才启用
  const shouldUse = sessionMemoryFlag && smCompactFlag

  // Log flag states for debugging (ant-only to avoid noise in external logs)
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_sm_compact_flag_check', {
      tengu_session_memory: sessionMemoryFlag,
      tengu_sm_compact: smCompactFlag,
      should_use: shouldUse,
    })
  }

  return shouldUse
}

/**
 * Create a CompactionResult from session memory
 */
function createCompactionResultFromSessionMemory(
  messages: Message[],
  sessionMemory: string,
  messagesToKeep: Message[],
  hookResults: HookResultMessage[],
  transcriptPath: string,
  agentId?: AgentId,
): CompactionResult {
  const preCompactTokenCount = tokenCountFromLastAPIResponse(messages)

  const boundaryMarker = createCompactBoundaryMessage(
    'auto',
    preCompactTokenCount ?? 0,
    messages[messages.length - 1]?.uuid,
  )
  const preCompactDiscovered = extractDiscoveredToolNames(messages)
  if (preCompactDiscovered.size > 0) {
    boundaryMarker.compactMetadata.preCompactDiscoveredTools = [
      ...preCompactDiscovered,
    ].sort()
  }

  // Truncate oversized sections to prevent session memory from consuming
  // the entire post-compact token budget
  const { truncatedContent, wasTruncated } =
    truncateSessionMemoryForCompact(sessionMemory)

  let summaryContent = getCompactUserSummaryMessage(
    truncatedContent,
    true,
    transcriptPath,
    true,
  )

  if (wasTruncated) {
    const memoryPath = getSessionMemoryPath()
    summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${memoryPath}`
  }

  const summaryMessages = [
    createUserMessage({
      content: summaryContent,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
  ]

  const planAttachment = createPlanAttachmentIfNeeded(agentId)
  const attachments = planAttachment ? [planAttachment] : []

  return {
    boundaryMarker: annotateBoundaryWithPreservedSegment(
      boundaryMarker,
      summaryMessages[summaryMessages.length - 1]!.uuid,
      messagesToKeep,
    ),
    summaryMessages,
    attachments,
    hookResults,
    messagesToKeep,
    preCompactTokenCount,
    // SM-compact has no compact-API-call, so postCompactTokenCount (kept for
    // event continuity) and truePostCompactTokenCount converge to the same value.
    postCompactTokenCount: estimateMessageTokens(summaryMessages),
    truePostCompactTokenCount: estimateMessageTokens(summaryMessages),
  }
}

/**
 * Try to use session memory for compaction instead of traditional compaction.
 * Returns null if session memory compaction cannot be used.
 *
 * Handles two scenarios:
 * 1. Normal case: lastSummarizedMessageId is set, keep only messages after that ID
 * 2. Resumed session: lastSummarizedMessageId is not set but session memory has content,
 *    keep all messages but use session memory as the summary
 */
  // 条件：tengu_session_memory + tengu_sm_compact 均启用
  // 条件：会话记忆文件存在且非空模板
  // 条件：无 custom instructions（会话记忆不支持自定义摘要指令）
  
  // 从 lastSummarizedMessageId 开始，向后计算保留消息范围
  // 限制：minTokens=10,000、minTextBlockMessages=5、maxTokens=40,000
  // 直接返回 CompactionResult，不调用 LLM
  /**
   * ! 优势：
      无需调用 LLM，节省 API 费用
      保留原始消息（无摘要失真）
      Token 节省约 70-80%
   */
// ! Session Memory Compaction 主入口
export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: AgentId,
  autoCompactThreshold?: number,
): Promise<CompactionResult | null> {
  if (!shouldUseSessionMemoryCompaction()) {
    return null
  }

  // Initialize config from remote (only fetches once)
  await initSessionMemoryCompactConfig()

  // Wait for any in-progress session memory extraction to complete (with timeout)
  await waitForSessionMemoryExtraction()  // ! // 等待后台记忆提取完成

  const lastSummarizedMessageId = getLastSummarizedMessageId()
  const sessionMemory = await getSessionMemoryContent()

  // No session memory file exists at all
  // ! // 无记忆文件
  if (!sessionMemory) {
    logEvent('tengu_sm_compact_no_session_memory', {})
    return null
  }

  // Session memory exists but matches the template (no actual content extracted)
  // Fall back to legacy compact behavior
  // ! // 记忆文件为空模板
  if (await isSessionMemoryEmpty(sessionMemory)) {
    logEvent('tengu_sm_compact_empty_template', {})
    return null
  }

  try {
    // ! // 找到已摘要消息的位置
    let lastSummarizedIndex: number

    if (lastSummarizedMessageId) {
      // Normal case: we know exactly which messages have been summarized
      lastSummarizedIndex = messages.findIndex(
        msg => msg.uuid === lastSummarizedMessageId,
      )

      if (lastSummarizedIndex === -1) {
        // ! // 找不到边界，回退到全量压缩
        // The summarized message ID doesn't exist in current messages
        // This can happen if messages were modified - fall back to legacy compact
        // since we can't determine the boundary between summarized and unsummarized messages
        logEvent('tengu_sm_compact_summarized_id_not_found', {})
        return null
      }
    } else {
      // Resumed session case: session memory has content but we don't know the boundary
      // Set lastSummarizedIndex to last message so startIndex becomes messages.length (no messages kept initially)
      // ! // 恢复会话场景：记忆存在但不知道边界 → 保留所有消息
      lastSummarizedIndex = messages.length - 1
      logEvent('tengu_sm_compact_resumed_session', {})
    }

    // Calculate the starting index for messages to keep
    // This starts from lastSummarizedIndex, expands to meet minimums,
    // and adjusts to not split tool_use/tool_result pairs
    // ! // 计算保留范围
    const startIndex = calculateMessagesToKeepIndex(
      messages,
      lastSummarizedIndex,
    )
    // Filter out old compact boundary messages from messagesToKeep.
    // After REPL pruning, old boundaries re-yielded from messagesToKeep would
    // trigger an unwanted second prune (isCompactBoundaryMessage returns true),
    // discarding the new boundary and summary.
    const messagesToKeep = messages
      .slice(startIndex)
      .filter(m => !isCompactBoundaryMessage(m))  // ! // 过滤旧边界标记

    // Run session start hooks to restore CLAUDE.md and other context
    // ! // 执行会话启动 hooks（恢复 CLAUDE.md 等）
    const hookResults = await processSessionStartHooks('compact', {
      model: getMainLoopModel(),
    })

    // Get transcript path for the summary message
    const transcriptPath = getTranscriptPath()

    // ! // 直接用记忆内容构建 CompactionResult，不调用 LLM！
    const compactionResult = createCompactionResultFromSessionMemory(
      messages,
      sessionMemory,  // ! // 后台异步提取的记忆文件内容
      messagesToKeep, // ! // 保留的原始消息
      hookResults,
      transcriptPath,
      agentId,
    )

    // ! // 检查压缩后是否仍超过阈值（若超过则回退到全量压缩）
    // ! 重建压缩后的消息
    const postCompactMessages = buildPostCompactMessages(compactionResult)

    const postCompactTokenCount = estimateMessageTokens(postCompactMessages)

    // Only check threshold if one was provided (for autocompact)
    if (
      autoCompactThreshold !== undefined &&
      postCompactTokenCount >= autoCompactThreshold
    ) {
      logEvent('tengu_sm_compact_threshold_exceeded', {
        postCompactTokenCount,
        autoCompactThreshold,
      })
      // ! // 让调用方回退到 compactConversation
      return null
    }

    return {
      ...compactionResult,
      postCompactTokenCount,
      truePostCompactTokenCount: postCompactTokenCount,
    }
  } catch (error) {
    // Use logEvent instead of logError since errors here are expected
    // (e.g., file not found, path issues) and shouldn't go to error logs
    logEvent('tengu_sm_compact_error', {})
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(`Session memory compaction error: ${errorMessage(error)}`)
    }
    return null
  }
}
