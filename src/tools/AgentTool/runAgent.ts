import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

/**
 * Initialize agent-specific MCP servers
 * Agents can define their own MCP servers in their frontmatter that are additive
 * to the parent's MCP clients. These servers are connected when the agent starts
 * and cleaned up when the agent finishes.
 *
 * @param agentDefinition The agent definition with optional mcpServers
 * @param parentClients MCP clients inherited from parent context
 * @returns Merged clients (parent + agent-specific), agent MCP tools, and cleanup function
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // If no agent-specific servers defined, return parent clients as-is
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  // When MCP is locked to plugin-only, skip frontmatter MCP servers for
  // USER-CONTROLLED agents only. Plugin, built-in, and policySettings agents
  // are admin-trusted — their frontmatter MCP is part of the admin-approved
  // surface. Blocking them (as the first cut did) breaks plugin agents that
  // legitimately need MCP, contradicting "plugin-provided always loads."
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // Track which clients were newly created (inline definitions) vs. shared from parent
  // Only newly created clients should be cleaned up when the agent finishes
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // Reference by name - look up in existing MCP configs
      // This uses the memoized connectToServer, so we may get a shared client
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // Inline definition as { [name]: config }
      // These are agent-specific servers that should be cleaned up
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // Connect to the server
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // Fetch tools if connected
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // Create cleanup function for agent-specific servers
  // Only clean up newly created clients (inline definitions), not shared/referenced ones
  // Shared clients (referenced by string name) are memoized and used by the parent context
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // Return merged clients (parent + agent-specific) and agent tools
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * Type guard to check if a message from query() is a recordable Message type.
 * Matches the types we want to record: assistant, user, progress, or system compact_boundary.
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

// !
/**
 *  参数差异
参数	SubAgent	ForkAgent
forkContextMessages	undefined	父 Agent 的完整消息历史
useExactTools	undefined（false）	true
override.systemPrompt	undefined（自行构建）	父 Agent 的渲染字节
availableTools	workerTools（重新组装）	toolUseContext.options.tools（父工具池）
model	可指定（AgentTool.tsx:610 传入）	undefined（继承父模型）
isAsync	可同步可异步	强制 true 
 */
/**
 * 
 * SubAgent vs ForkAgent 全面对比
    维度	SubAgent	ForkAgent
    触发方式	Agent(subagent_type="xxx") 显式指定	Agent() 省略 subagent_type（功能门控开）
    消息历史	从零开始，只有用户 prompt	继承父 Agent 的完整对话历史
    系统提示	getAgentSystemPrompt()（Agent 自己的提示 + 环境信息）	父 Agent 的渲染字节（字节精确，保证 cache hit）
    提示类型	完整背景说明（需解释任务背景）	指令式（<fork-boilerplate> + directive）
    工具池	resolveAgentTools()（过滤 + 黑/白名单）	useExactTools=true（父工具池直接引用）
    模型	可指定不同模型（model 字段）	强制 'inherit'（继承父模型）
    thinking 配置	禁用（{ type: 'disabled' }）	继承父配置（保证 cache hit）
    文件状态缓存	全新缓存（createFileStateCacheWithSizeLimit）	克隆父缓存（保证相同 replacement 决策）
    CLAUDE.md	重新获取（Explore/Plan 可省略）	通过继承的系统提示已包含
    gitStatus	重新获取（Explore/Plan 省略）	通过继承的系统提示已包含
    执行方式	可同步（阻塞父）或异步（后台）	强制异步（forceAsync = true）
    AbortController	同步：共享父；异步：新建不链接	新建不链接父（后台独立运行）
    setAppState	同步：共享父；异步：no-op	始终 no-op
    权限提示	同步：可弹窗；异步：不弹窗	'bubble' 模式：冒泡到父终端
    allowedTools	可通过 allowedTools 参数限制工具权限	不支持
    SubagentStart hooks	支持（执行用户配置的 hooks）	不支持
    frontmatter hooks	支持（Agent 定义中的 hooks）	不支持
    skills 预加载	支持（frontmatter skills 字段）	不支持
    Agent 专属 MCP	支持（frontmatter mcpServers 字段）	不支持（继承父工具池）
    Prompt Cache	独立缓存，无法复用父缓存	字节相同 → 命中父缓存
    querySource	不写入 options	写入 options（防递归 fork 检测）
    递归防护	ALL_AGENT_DISALLOWED_TOOLS（外部用户禁止 AgentTool）	双重检测：querySource + <fork-boilerplate> 标签扫描
    完成通知	同步：直接返回；异步：<task-notification> XML	始终 <task-notification> XML
    资源清理	完整清理（MCP、hooks、缓存、todos、bash 任务）	相同（通过同一 finally 块）
    transcript 记录	recordSidechainTranscript()（每条消息）	相同
    maxTurns	agentDefinition.maxTurns（可配置）	200（硬编码）
 */
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** Whether this agent can show permission prompts. Defaults to !isAsync.
   * Set to true for in-process teammates that run async but share the terminal. */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** Preserve toolUseResult on messages for subagents with viewable transcripts */
  preserveToolUseResults?: boolean
  /** Precomputed tool pool for the worker agent. Computed by the caller
   * (AgentTool.tsx) to avoid a circular dependency between runAgent and tools.ts.
   * Always contains the full tool pool assembled with the worker's own permission
   * mode, independent of the parent's tool restrictions. */
  availableTools: Tools
  /** Tool permission rules to add to the agent's session allow rules.
   * When provided, replaces ALL allow rules so the agent only has what's
   * explicitly listed (parent approvals don't leak through). */
  allowedTools?: string[]
  /** Optional callback invoked with CacheSafeParams after constructing the agent's
   * system prompt, context, and tools. Used by background summarization to fork
   * the agent's conversation for periodic progress summaries. */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** Replacement state reconstructed from a resumed sidechain transcript so
   * the same tool results are re-replaced (prompt cache stability). When
   * omitted, createSubagentContext clones the parent's state. */
  contentReplacementState?: ContentReplacementState
  /** When true, use availableTools directly without filtering through
   * resolveAgentTools(). Also inherits the parent's thinkingConfig and
   * isNonInteractiveSession instead of overriding them. Used by the fork
   * subagent path to produce byte-identical API request prefixes for
   * prompt cache hits. */
  useExactTools?: boolean
  /** Worktree path if the agent was spawned with isolation: "worktree".
   * Persisted to metadata so resume can restore the correct cwd. */
  worktreePath?: string
  /** Original task description from AgentTool input. Persisted to metadata
   * so a resumed agent's notification can show the original description. */
  description?: string
  /** Optional subdirectory under subagents/ to group this agent's transcript
   * with related ones (e.g. workflows/<runId> for workflow subagents). */
  transcriptSubdir?: string
  /** Optional callback fired on every message yielded by query() — including
   * stream_event deltas that runAgent otherwise drops. Use to detect liveness
   * during long single-block streams (e.g. thinking) where no assistant
   * message is yielded for >60s. */
  onQueryProgress?: () => void
}): AsyncGenerator<Message, void> {
  // Track subagent usage for feature discovery

  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // Always-shared channel to the root AppState store. toolUseContext.setAppState
  // is a no-op when the *parent* is itself an async agent (nested async→async),
  // so session-scoped writes (hooks, bash tasks) must go through this instead.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

  const agentId = override?.agentId ? override.agentId : createAgentId()

  // Route this agent's transcript into a grouping subdirectory if requested
  // (e.g. workflow subagents write to subagents/workflows/<runId>/).
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // Register agent in Perfetto trace for hierarchy visualization
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // Log API calls path for subagents (ant-only)
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[Subagent ${agentDefinition.agentType}] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}`,
    )
  }

  // Handle message forking for context sharing
  // Filter out incomplete tool calls from parent messages to avoid API errors
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)  // ! // ForkAgent：过滤父历史
    : []  // ! // SubAgent：空数组
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]
  // ! SubAgent：   initialMessages = [用户 prompt 消息]
  // ! ForkAgent：  initialMessages = [父历史..., assistant(tool_uses), user(placeholders + directive)]

  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState) // ! // ForkAgent：克隆父缓存
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE) // ! // SubAgent：全新缓存
  // ! SubAgent 使用全新的文件状态缓存，不继承父 Agent 的文件读取历史。这意味着 SubAgent 看到的文件内容与父 Agent 独立，不会受父 Agent 已读文件的影响。

  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),  // ! // 重新获取 CLAUDE.md
    override?.systemContext ?? getSystemContext(),  // ! 重新获取 git status
  ])

  // Read-only agents (Explore, Plan) don't act on commit/PR/lint rules from
  // CLAUDE.md — the main agent has full context and interprets their output.
  // Dropping claudeMd here saves ~5-15 Gtok/week across 34M+ Explore spawns.
  // Explicit override.userContext from callers is preserved untouched.
  // Kill-switch defaults true; flip tengu_slim_subagent_claudemd=false to revert.
  // ! // Explore/Plan：省略 CLAUDE.md（节省 ~5-15 Gtok/week）
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd
    : baseUserContext

  // Explore/Plan are read-only search agents — the parent-session-start
  // gitStatus (up to 40KB, explicitly labeled stale) is dead weight. If they
  // need git info they run `git status` themselves and get fresh data.
  // Saves ~1-3 Gtok/week fleet-wide.
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  // ! // Explore/Plan：省略 gitStatus（节省 ~1-3 Gtok/week）
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit
      : baseSystemContext
  /**
   * SubAgent 重新调用 getUserContext() 和 getSystemContext()（两者都是 memoize，实际上是缓存命中），但 Explore/Plan 等只读 Agent 会主动省略 CLAUDE.md 和 gitStatus，避免浪费 token。
   * ForkAgent 通过 override.systemPrompt（父渲染字节）已经包含了 userContext 和 systemContext 的内容，不需要重新获取。
   */

  // Override permission mode if agent defines one
  // However, don't override if parent is in bypassPermissions or acceptEdits mode - those should always take precedence
  // For async agents, also set shouldAvoidPermissionPrompts since they can't show UI
  const agentPermissionMode = agentDefinition.permissionMode
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // Override permission mode if agent defines one (unless parent is bypassPermissions, acceptEdits, or auto)
    // ! // 1. 覆盖权限模式（除非父是 bypassPermissions/acceptEdits/auto）
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // Set flag to auto-deny prompts for agents that can't show UI
    // Use explicit canShowPermissionPrompts if provided, otherwise:
    //   - bubble mode: always show prompts (bubbles to parent terminal)
    //   - default: !isAsync (sync agents show prompts, async agents don't)
    // ! // 2. 异步 Agent 不弹权限对话框（ForkAgent 的 bubble 模式例外）
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // For background agents that can show prompts, await automated checks
    // (classifier, permission hooks) before showing the permission dialog.
    // Since these are background agents, waiting is fine — the user should
    // only be interrupted when automated checks can't resolve the permission.
    // This applies to bubble mode (always) and explicit canShowPermissionPrompts.
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // Scope tool permissions: when allowedTools is provided, use them as session rules.
    // IMPORTANT: Preserve cliArg rules (from SDK's --allowedTools) since those are
    // explicit permissions from the SDK consumer that should apply to all agents.
    // Only clear session-level rules from the parent to prevent unintended leakage.
    // ! // 3. 工具权限白名单（allowedTools 参数）
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // Preserve SDK-level permissions from --allowedTools
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // Use the provided allowedTools as session-level permissions
          session: [...allowedTools],
        },
      }
    }

    // Override effort level if agent defines one
    // ! // 4. 努力值覆盖
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  // !
  /**
   * 与 ForkAgent 的对比：
ForkAgent 使用 override.systemPrompt = toolUseContext.renderedSystemPrompt（父 Agent 的渲染字节）
SubAgent 调用 getAgentSystemPrompt() 构建全新的系统提示
   */
  const agentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
          resolvedTools,
        ),
      )

  // Determine abortController:
  // - Override takes precedence
  // - Async agents get a new unlinked controller (runs independently)
  // - Sync agents share parent's controller
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // Execute SubagentStart hooks and collect additional context
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // Add SubagentStart hook context as a user message (consistent with SessionStart/UserPromptSubmit)
  /**
   * Hook 上下文（SubagentStart/UserPromptSubmit）→ messages（isMeta）
来源： src/tools/AgentTool/runAgent.ts:546

if (additionalContexts.length > 0) {
  const contextMessage = createAttachmentMessage({
    type: 'hook_additional_context',
    content: additionalContexts,
    hookName: 'SubagentStart',
    ...
  })
  initialMessages.push(contextMessage)
}
用户配置的 hooks（如 UserPromptSubmit、SubagentStart）返回的附加上下文，以 <system-reminder> 包裹注入 user messages。
   */
  // ! // 将 hook 上下文注入为 user message（isMeta: true）
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

  // Register agent's frontmatter hooks (scoped to agent lifecycle)
  // Pass isAgent=true to convert Stop hooks to SubagentStop (since subagents trigger SubagentStop)
  // Same admin-trusted gate for frontmatter hooks: under ["hooks"] alone
  // (skills/agents not locked), user agents still load — block their
  // frontmatter-hook REGISTRATION here where source is known, rather than
  // blanket-blocking all session hooks at execution time (which would
  // also kill plugin agents' hooks).
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent - converts Stop to SubagentStop
      // ! // isAgent=true，将 Stop hooks 转换为 SubagentStop
    )
  }

  // Preload skills from agent frontmatter
  // ! SubAgent 专有，ForkAgent 不支持：
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // Filter valid skills and warn about missing ones
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // Resolve the skill name, trying multiple strategies:
      // 1. Exact match (hasCommand checks name, userFacingName, aliases)
      // 2. Fully-qualified with agent's plugin prefix (e.g., "my-skill" → "plugin:my-skill")
      // 3. Suffix match on ":skillName" for plugin-namespaced skills
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // Load all skill contents concurrently and add to initial messages
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    // ! 解析 skill 名称（支持精确匹配、插件前缀、后缀匹配）并发加载所有 skill 内容
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    // ! // 注入为 initialMessages 的 user message（isMeta: true）
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // Add command-message metadata so the UI shows which skill is loading
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // Initialize agent-specific MCP servers (additive to parent's servers)
  // ! SubAgent 专有：
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )

  // Merge agent MCP tools with resolved agent tools, deduplicating by name.
  // resolvedTools is already deduplicated (see resolveAgentTools), so skip
  // the spread + uniqBy overhead when there are no agent-specific MCP tools.
  // ! // 合并 Agent 专属 MCP 工具到工具池
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // Build agent-specific options
  const agentOptions: ToolUseContext['options'] = {
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession  // ! / ForkAgent：继承
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,  // ! // SubAgent：resolveAgentTools 过滤后的工具
    commands: [], // ! // SubAgent 不使用 slash commands
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    // For fork children (useExactTools), inherit thinking config to match the
    // parent's API request prefix for prompt cache hits. For regular
    // sub-agents, disable thinking to control output token costs.
    // ! // ForkAgent：继承父 thinkingConfig（保证 API 请求前缀字节相同）
    // ! // SubAgent：禁用 thinking（控制 token 成本）
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // Fork children (useExactTools path) need querySource on context.options
    // for the recursive-fork guard at AgentTool.tsx call() — it checks
    // options.querySource === 'agent:builtin:fork'. This survives autocompact
    // (which rewrites messages, not context.options). Without this, the guard
    // reads undefined and only the message-scan fallback fires — which
    // autocompact defeats by replacing the fork-boilerplate message.
    // ! // ForkAgent 专用：将 querySource 写入 options，用于递归 fork 检测
    ...(useExactTools && { querySource }),
  }

  // Create subagent context using shared helper
  // - Sync agents share setAppState, setResponseLength, abortController with parent
  // - Async agents are fully isolated (but with explicit unlinked abortController)
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // Sync agents share these callbacks with parent
    shareSetAppState: !isAsync, // ! // 同步 SubAgent 共享父的 
    shareSetResponseLength: true, // Both sync and async contribute to response metrics
    // ! // 同步/异步都贡献响应长度指标
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // Preserve tool use results for subagents with viewable transcripts (in-process teammates)
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // Expose cache-safe params for background summarization (prompt cache sharing)
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // Record initial messages before the query loop starts, plus the agentType
  // so resume can route correctly when subagent_type is omitted. Both writes
  // are fire-and-forget — persistence failure shouldn't block the agent.
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`Failed to record sidechain transcript: ${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))

  // Track the last recorded message UUID for parent chain continuity
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,  // ! // SubAgent：自己构建的系统提示
      userContext: resolvedUserContext, // ! // 可能省略 CLAUDE.md
      systemContext: resolvedSystemContext, // ! // 可能省略 gitStatus
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
    })) {
      onQueryProgress?.()
      // Forward subagent API request starts to parent's metrics display
      // so TTFT/OTPS update during subagent execution.
      // ! // 转发 stream_event 的 TTFT 指标给父 Agent
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_start' &&
        message.ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
        continue
      }

      // Yield attachment messages (e.g., structured_output) without recording them
      if (message.type === 'attachment') {
        // Handle max turns reached signal from query.ts
        if (message.attachment.type === 'max_turns_reached') {
          logForDebugging(
            `[Agent
: $
{
  agentDefinition.agentType
}
] Reached max turns limit ($
{
  message.attachment.maxTurns
}
)`,
          )
          break
        }
        yield message
        continue
      }

      // ! // 记录到 sidechain transcript
      if (isRecordableMessage(message)) {
        // Record only the new message with correct parent (O(1) per message)
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`Failed to record sidechain transcript: ${err}`),
        )
        if (message.type !== 'progress') {
          lastRecordedUuid = message.uuid
        }
        yield message
      }
    }

    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // Run callback if provided (only built-in agents have callbacks)
    // ! SubAgent 完成后的回调（仅内置 Agent）：
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
  } finally {
    // ! runAgent.ts:831-874 — finally 块确保资源清理：
    // Clean up agent-specific MCP servers (runs on normal completion, abort, or error)
    await mcpCleanup()  // ! // 清理 Agent 专属 MCP 服务器
    // Clean up agent's session hooks
    if (agentDefinition.hooks) {
      // ! // 清理 frontmatter hooks
      clearSessionHooks(rootSetAppState, agentId)
    }
    // Clean up prompt cache tracking state for this agent
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      // ! // 清理 prompt cache 跟踪状态
      cleanupAgentTracking(agentId)
    }
    // Release cloned file state cache memory
    // ! // 释放文件状态缓存内存
    agentToolUseContext.readFileState.clear()
    // Release the cloned fork context messages
    // ! // 释放消息数组内存
    initialMessages.length = 0
    // ! // 释放 Perfetto 追踪注册
    // Release perfetto agent registry entry
    unregisterPerfettoAgent(agentId)
    // Release transcript subdir mapping
    // ! // 清理 transcript 子目录映射
    clearAgentTranscriptSubdir(agentId)
    // Release this agent's todos entry. Without this, every subagent that
    // called TodoWrite leaves a key in AppState.todos forever (even after all
    // items complete, the value is [] but the key stays). Whale sessions
    // spawn hundreds of agents; each orphaned key is a small leak that adds up.
    rootSetAppState(prev => { // ! // 清理 todos 条目（防内存泄漏）
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // Kill any background bash tasks this agent spawned. Without this, a
    // `run_in_background` shell loop (e.g. test fixture fake-logs.sh) outlives
    // the agent as a PPID=1 zombie once the main session eventually exits.
    // ! // 杀死 Agent 启动的后台 bash 任务
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (feature('MONITOR_TOOL')) {
      const mcpMod =
        require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js')
      mcpMod.killMonitorMcpTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

/**
 * Filters out assistant messages with incomplete tool calls (tool uses without results).
 * This prevents API errors when sending messages with orphaned tool calls.
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // Build a set of tool use IDs that have results
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // Filter out assistant messages that contain tool calls without results
  return messages.filter(message => {
    if (message?.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        // Check if this assistant message has any tool uses without results
        const hasIncompleteToolCall = content.some(
          block =>
            block.type === 'tool_use' &&
            block.id &&
            !toolUseIdsWithResults.has(block.id),
        )
        // Exclude messages with incomplete tool calls
        return !hasIncompleteToolCall
      }
    }
    // Keep all non-assistant messages and assistant messages without tool calls
    return true
  })
}

// ! src/tools/AgentTool/runAgent.ts:921
// ! SubAgent 有自己独立的系统提示，通过 getAgentSystemPrompt() 构建：
async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  try {
    // ! // 调用 Agent 定义的 getSystemPrompt()
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    // ! // 追加环境信息（CWD、平台、模型等）
    /**
     * Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task.
  Include code snippets only when the exact text is load-bearing...
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls...

<环境信息（computeEnvInfo）：CWD、平台、Shell、模型名、知识截止日期等>
     */
    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  } catch (_error) {
    // ! // 回退到默认 Agent 提示
    /**
     * You are an agent for Claude Code, Anthropic's official CLI for Claude.
Given the user's message, you should use the tools available to complete the task.
Complete the task fully—don't gold-plate, but don't leave it half-done.
When you complete the task, respond with a concise report covering what was done and any key findings
— the caller will relay this to the user, so it only needs the essentials.
     */
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  }
}

/**
 * Resolve a skill name from agent frontmatter to a registered command name.
 *
 * Plugin skills are registered with namespaced names (e.g., "my-plugin:my-skill")
 * but agents reference them with bare names (e.g., "my-skill"). This function
 * tries multiple resolution strategies:
 *
 * 1. Exact match via hasCommand (name, userFacingName, aliases)
 * 2. Prefix with agent's plugin name (e.g., "my-skill" → "my-plugin:my-skill")
 * 3. Suffix match — find any command whose name ends with ":skillName"
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. Direct match
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. Try prefixing with the agent's plugin name
  // Plugin agents have agentType like "pluginName:agentName"
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. Suffix match — find a skill whose name ends with ":skillName"
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}
