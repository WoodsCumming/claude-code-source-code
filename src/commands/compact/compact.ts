import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { notifyCompaction } from '../../services/api/promptCacheBreakDetection.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  ERROR_MESSAGE_USER_ABORT,
  mergeHookInstructions,
} from '../../services/compact/compact.js'
import { suppressCompactWarning } from '../../services/compact/compactWarningState.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { trySessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js'
import { setLastSummarizedMessageId } from '../../services/SessionMemory/sessionMemoryUtils.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { executePreCompactHooks } from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js'
import {
  buildEffectiveSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPrompt.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('../../services/compact/reactiveCompact.js') as typeof import('../../services/compact/reactiveCompact.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export const call: LocalCommandCall = async (args, context) => {
  const { abortController } = context
  let { messages } = context

  // REPL keeps snipped messages for UI scrollback — project so the compact
  // model doesn't summarize content that was intentionally removed.
  messages = getMessagesAfterCompactBoundary(messages)

  if (messages.length === 0) {
    throw new Error('No messages to compact')
  }

  const customInstructions = args.trim()
  /**
   * ! 总结：三层压缩的选择逻辑
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
    * ! 核心设计哲学：能不调用 LLM 就不调用，必须调用时复用缓存，调用后精确重建上下文。
   */

  try {
    // Try session memory compaction first if no custom instructions
    // (session memory compaction doesn't support custom instructions)
    // ! // 优先：SM 压缩
    // ! 不需要调用摘要模型，直接使用已经提取好的 Session Memory 作为对话摘要。
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(
        messages,
        context.agentId,
      )
      if (sessionMemoryResult) {
        getUserContext.cache.clear?.()
        runPostCompactCleanup()
        // Reset cache read baseline so the post-compact drop isn't flagged
        // as a break. compactConversation does this internally; SM-compact doesn't.
        if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
          notifyCompaction(
            context.options.querySource ?? 'compact',
            context.agentId,
          )
        }
        markPostCompaction()
        // Suppress warning immediately after successful compaction
        suppressCompactWarning()

        return {
          type: 'compact',
          compactionResult: sessionMemoryResult,
          displayText: buildDisplayText(context),
        }
      }
    }

    // Reactive-only mode: route /compact through the reactive path.
    // Checked after session-memory (that path is cheap and orthogonal).
    // ! 
    /**
     * 
PTL 紧急降级：Prompt Too Long
当压缩后仍然超出 token 限制（PROMPT_TOO_LONG 错误），系统会进入紧急降级路径：
Reactive Compact：reactiveCompactOnPromptTooLong() 尝试更激进的压缩
截断重试：如果 reactive 也失败，truncateHeadForPTLRetry() 直接截断最早的消息
放弃并报错
Reactive Compact 目前在反编译版本中是 stub（isReactiveOnlyMode() → false），表明这是 Anthropic 内部的实验性功能。
     */
    // ! // 次选：Reactive 压缩
    if (reactiveCompact?.isReactiveOnlyMode()) {
      return await compactViaReactive(
        messages,
        context,
        customInstructions,
        reactiveCompact,
      )
    }

    // Fall back to traditional compaction
    // Run microcompact first to reduce tokens before summarization
    // ! // 兜底：传统 API 摘要
    // ! 当 SM 压缩不可用时，系统回退到传统方式：调用 AI 模型生成对话摘要。
    const microcompactResult = await microcompactMessages(messages, context)
    const messagesForCompact = microcompactResult.messages

    // ! // → 调用 AI 模型生成摘要
    // ! LLM摘要主入口
    const result = await compactConversation(
      messagesForCompact,
      context,
      await getCacheSharingParams(context, messagesForCompact),
      false,
      customInstructions,
      false,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)

    // Suppress the "Context left until auto-compact" warning after successful compaction
    suppressCompactWarning()

    getUserContext.cache.clear?.()
    runPostCompactCleanup()

    return {
      type: 'compact',
      compactionResult: result,
      displayText: buildDisplayText(context, result.userDisplayMessage),
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error('Compaction canceled.')
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE)) {
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    } else {
      logError(error)
      throw new Error(`Error during compaction: ${error}`)
    }
  }
}

async function compactViaReactive(
  messages: Message[],
  context: ToolUseContext,
  customInstructions: string,
  reactive: NonNullable<typeof reactiveCompact>,
): Promise<{
  type: 'compact'
  compactionResult: CompactionResult
  displayText: string
}> {
  context.onCompactProgress?.({
    type: 'hooks_start',
    hookType: 'pre_compact',
  })
  context.setSDKStatus?.('compacting')

  try {
    // Hooks and cache-param build are independent — run concurrently.
    // getCacheSharingParams walks all tools to build the system prompt;
    // pre-compact hooks spawn subprocesses. Neither depends on the other.
    const [hookResult, cacheSafeParams] = await Promise.all([
      executePreCompactHooks(
        { trigger: 'manual', customInstructions: customInstructions || null },
        context.abortController.signal,
      ),
      getCacheSharingParams(context, messages),
    ])
    const mergedInstructions = mergeHookInstructions(
      customInstructions,
      hookResult.newCustomInstructions,
    )

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

    const outcome = await reactive.reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParams,
      { customInstructions: mergedInstructions, trigger: 'manual' },
    )

    if (!outcome.ok) {
      // The outer catch in `call` translates these: aborted → "Compaction
      // canceled." (via abortController.signal.aborted check), NOT_ENOUGH →
      // re-thrown as-is, everything else → "Error during compaction: …".
      switch (outcome.reason) {
        case 'too_few_groups':
          throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
        case 'aborted':
          throw new Error(ERROR_MESSAGE_USER_ABORT)
        case 'exhausted':
        case 'error':
        case 'media_unstrippable':
          throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
      }
    }

    // Mirrors the post-success cleanup in tryReactiveCompact, minus
    // resetMicrocompactState — processSlashCommand calls that for all
    // type:'compact' results.
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup()
    suppressCompactWarning()
    getUserContext.cache.clear?.()

    // reactiveCompactOnPromptTooLong runs PostCompact hooks but not PreCompact
    // — both callers (here and tryReactiveCompact) run PreCompact outside so
    // they can merge its userDisplayMessage with PostCompact's here. This
    // caller additionally runs it concurrently with getCacheSharingParams.
    const combinedMessage =
      [hookResult.userDisplayMessage, outcome.result.userDisplayMessage]
        .filter(Boolean)
        .join('\n') || undefined

    return {
      type: 'compact',
      compactionResult: {
        ...outcome.result,
        userDisplayMessage: combinedMessage,
      },
      displayText: buildDisplayText(context, combinedMessage),
    }
  } finally {
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_end' })
    context.setSDKStatus?.(null)
  }
}

function buildDisplayText(
  context: ToolUseContext,
  userDisplayMessage?: string,
): string {
  const upgradeMessage = getUpgradeMessage('tip')
  const expandShortcut = getShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  const dimmed = [
    ...(context.options.verbose
      ? []
      : [`(${expandShortcut} to see full summary)`]),
    ...(userDisplayMessage ? [userDisplayMessage] : []),
    ...(upgradeMessage ? [upgradeMessage] : []),
  ]
  return chalk.dim('Compacted ' + dimmed.join('\n'))
}

async function getCacheSharingParams(
  context: ToolUseContext,
  forkContextMessages: Message[],
): Promise<{
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}> {
  const appState = context.getAppState()
  const defaultSysPrompt = await getSystemPrompt(
    context.options.tools,
    context.options.mainLoopModel,
    Array.from(
      appState.toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    context.options.mcpClients,
  )
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}
