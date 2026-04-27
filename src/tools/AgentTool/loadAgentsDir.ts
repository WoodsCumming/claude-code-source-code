import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { z } from 'zod/v4'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  type McpServerConfig,
  McpServerConfigSchema,
} from '../../services/mcp/types.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  EFFORT_LEVELS,
  type EffortValue,
  parseEffortValue,
} from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { parsePositiveIntFromFrontmatter } from '../../utils/frontmatterParser.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  loadMarkdownFilesForSubdir,
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
} from '../../utils/markdownConfigLoader.js'
import {
  PERMISSION_MODES,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import {
  clearPluginAgentCache,
  loadPluginAgents,
} from '../../utils/plugins/loadPluginAgents.js'
import { HooksSchema, type HooksSettings } from '../../utils/settings/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import {
  AGENT_COLORS,
  type AgentColorName,
  setAgentColor,
} from './agentColorManager.js'
import { type AgentMemoryScope, loadAgentMemoryPrompt } from './agentMemory.js'
import {
  checkAgentMemorySnapshot,
  initializeFromSnapshot,
} from './agentMemorySnapshot.js'
import { getBuiltInAgents } from './builtInAgents.js'

// Type for MCP server specification in agent definitions
// Can be either a reference to an existing server by name, or an inline definition as { [name]: config }
export type AgentMcpServerSpec =
  | string // Reference to existing server by name (e.g., "slack")
  | { [name: string]: McpServerConfig } // Inline definition as { name: config }

// Zod schema for agent MCP server specs
const AgentMcpServerSpecSchema = lazySchema(() =>
  z.union([
    z.string(), // Reference by name
    z.record(z.string(), McpServerConfigSchema()), // Inline as { name: config }
  ]),
)

// Zod schemas for JSON agent validation
// Note: HooksSchema is lazy so the circular chain AppState -> loadAgentsDir -> settings/types
// is broken at module load time
const AgentJsonSchema = lazySchema(() =>
  z.object({
    description: z.string().min(1, 'Description cannot be empty'),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    prompt: z.string().min(1, 'Prompt cannot be empty'),
    model: z
      .string()
      .trim()
      .min(1, 'Model cannot be empty')
      .transform(m => (m.toLowerCase() === 'inherit' ? 'inherit' : m))
      .optional(),
    effort: z.union([z.enum(EFFORT_LEVELS), z.number().int()]).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    mcpServers: z.array(AgentMcpServerSpecSchema()).optional(),
    hooks: HooksSchema().optional(),
    maxTurns: z.number().int().positive().optional(),
    skills: z.array(z.string()).optional(),
    initialPrompt: z.string().optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    background: z.boolean().optional(),
    isolation: (process.env.USER_TYPE === 'ant'
      ? z.enum(['worktree', 'remote'])
      : z.enum(['worktree'])
    ).optional(),
  }),
)

const AgentsJsonSchema = lazySchema(() =>
  z.record(z.string(), AgentJsonSchema()),
)

// Base type with common fields for all agents
// ! Agent 的配置结构
/**
 * 关键字段说明：

字段	SubAgent 含义	ForkAgent 对应
tools	指定工具列表，['*'] = 全部	不使用（useExactTools=true，直接继承父工具池）
omitClaudeMd	Explore/Plan 省略 CLAUDE.md 节省 token	不适用（继承父 userContext）
maxTurns	限制 turn 数，防止无限循环	200（FORK_AGENT 硬编码）
permissionMode	可覆盖父 Agent 的权限模式	'bubble'（冒泡到父终端）
background	true 时始终异步运行	始终异步（forceAsync）
model	可指定不同模型	'inherit'（强制继承父模型）
hooks	frontmatter 定义的生命周期 hooks	不支持
skills	启动时预加载的 skill 内容	不支持
mcpServers	Agent 专属 MCP 服务器	不支持（继承父工具池）
 */
export type BaseAgentDefinition = {
  agentType: string // ! // Agent 类型名，如 'Explore'、'general-purpose'
  whenToUse: string // ! // 何时使用的描述（显示在 Agent 工具描述中）
  tools?: string[]  // ! // 允许的工具列表，['*'] 表示全部
  disallowedTools?: string[]  // ! // 明确禁止的工具列表
  skills?: string[] // Skill names to preload (parsed from comma-separated frontmatter)
  // ! // 启动时预加载的 skill 名称列表
  mcpServers?: AgentMcpServerSpec[] // MCP servers specific to this agent
  // ! // Agent 专属的 MCP 服务器
  hooks?: HooksSettings // Session-scoped hooks registered when agent starts
  // ! // Agent 生命周期 hooks
  color?: AgentColorName
  // ! // UI 显示颜色
  model?: string
  // ! // 模型覆盖（'inherit' 继承父 Agent）
  effort?: EffortValue
  // ! // 计算力级别
  permissionMode?: PermissionMode
  // ! // 权限模式覆盖
  maxTurns?: number // Maximum number of agentic turns before stopping
  // ! // 最大 turn 数限制
  filename?: string // Original filename without .md extension (for user/project/managed agents)
  baseDir?: string
  criticalSystemReminder_EXPERIMENTAL?: string // Short message re-injected at every user turn
  // ! // 每个 user turn 都重新注入的关键提醒
  requiredMcpServers?: string[] // MCP server name patterns that must be configured for agent to be available
  // ! // 必须存在的 MCP 服务器
  background?: boolean // Always run as background task when spawned
  // ! // 是否始终以后台任务运行
  initialPrompt?: string // Prepended to the first user turn (slash commands work)
  // ! // 第一个 user turn 前追加的提示
  memory?: AgentMemoryScope // Persistent memory scope
  // ! // 持久化记忆范围
  isolation?: 'worktree' | 'remote' // Run in an isolated git worktree, or remotely in CCR (ant-only)
  // ! // 隔离模式
  pendingSnapshotUpdate?: { snapshotTimestamp: string }
  /** Omit CLAUDE.md hierarchy from the agent's userContext. Read-only agents
   * (Explore, Plan) don't need commit/PR/lint guidelines — the main agent has
   * full CLAUDE.md and interprets their output. Saves ~5-15 Gtok/week across
   * 34M+ Explore spawns. Kill-switch: tengu_slim_subagent_claudemd. */
  omitClaudeMd?: boolean
  // ! // 是否省略 CLAUDE.md（Explore/Plan 用，节省 token）
}

// Built-in agents - dynamic prompts only, no static systemPrompt field
export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: 'built-in'
  callback?: () => void // ! // 完成后的回调（仅内置 Agent 有）
  getSystemPrompt: (params: {
    toolUseContext: Pick<ToolUseContext, 'options'>
  }) => string
  // ! // ↑ 内置 Agent 需要 toolUseContext 来动态生成提示
}

// Custom agents from user/project/policy settings - prompt stored via closure
// ! // 自定义 Agent（用户/项目/策略设置）（loadAgentsDir.ts:146）
export type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: SettingSource
  filename?: string
  baseDir?: string
}

// Plugin agents - similar to custom but with plugin metadata, prompt stored via closure
// ! // 插件 Agent（loadAgentsDir.ts:154）
export type PluginAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'plugin'
  filename?: string
  plugin: string
}

// Union type for all agent types
export type AgentDefinition =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | PluginAgentDefinition

// Type guards for runtime type checking
export function isBuiltInAgent(
  agent: AgentDefinition,
): agent is BuiltInAgentDefinition {
  return agent.source === 'built-in'
}

export function isCustomAgent(
  agent: AgentDefinition,
): agent is CustomAgentDefinition {
  return agent.source !== 'built-in' && agent.source !== 'plugin'
}

export function isPluginAgent(
  agent: AgentDefinition,
): agent is PluginAgentDefinition {
  return agent.source === 'plugin'
}

export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  failedFiles?: Array<{ path: string; error: string }>
  allowedAgentTypes?: string[]
}

/*
合并逻辑在 getActiveAgentsFromList() 中：按 agentType 去重，后者覆盖前者。这意味着你可以在 .claude/agents/ 中放一个 Explore.md 来完全替换内置的 Explore Agent。
*/
// ---
// # === 必需字段 ===
// name: "reviewer"                    # Agent 标识（agentType）
// description: "Code review specialist, read-only analysis"
// 
// # === 工具控制 ===
// tools: "Read,Glob,Grep,Bash"        # 允许的工具列表（逗号分隔）
// disallowedTools: "Write,Edit"       # 显式禁止的工具
// 
// # === 模型配置 ===
// model: "haiku"                      # 指定模型（或 "inherit" 继承主线程）
// effort: "high"                      # 推理努力程度：low/medium/high 或整数
// 
// # === 行为控制 ===
// maxTurns: 10                        # 最大 agentic 轮次
// permissionMode: "plan"              # 权限模式：plan/bypassPermissions 等
// background: true                    # 始终作为后台任务运行
// initialPrompt: "/search TODO"       # 首轮用户消息前缀（支持斜杠命令）
// 
// # === 隔离与持久化 ===
// isolation: "worktree"               # 在独立 git worktree 中运行
// memory: "project"                   # 持久记忆范围：user/project/local
// 
// # === MCP 服务器 ===
// mcpServers:
//   - "slack"                         # 引用已配置的 MCP 服务器
//   - database:                       # 内联定义
//       command: "npx"
//       args: ["mcp-db"]
// 
// # === Hooks ===
// hooks:
//   PreToolUse:
//     - command: "audit-log.sh"
//       timeout: 5000
// 
// # === Skills ===
// skills: "code-review,security-review"  # 预加载的 skills（逗号分隔）
// 
// # === 显示 ===
// color: "blue"                       # 终端中的 Agent 颜色标识
// ---
// 
// 你是代码审查专家。你的职责是...
// 
// （正文内容 = system prompt）
/*

字段解析细节
tools：通过 parseAgentToolsFromFrontmatter() 解析，支持逗号分隔字符串或数组
model: "inherit"：使用主线程的模型（区分大小写，只有小写 “inherit” 有效）
memory：启用后自动注入 Write/Edit/Read 工具（即使 tools 未包含），并在 system prompt 末尾追加 memory 指令
isolation: "remote"：仅在 Anthropic 内部可用（USER_TYPE === 'ant'），外部构建只支持 worktree
background：true 使 Agent 始终在后台运行，主线程不等待结果
*/
export function getActiveAgentsFromList(
  allAgents: AgentDefinition[],
): AgentDefinition[] {
  const builtInAgents = allAgents.filter(a => a.source === 'built-in')
  const pluginAgents = allAgents.filter(a => a.source === 'plugin')
  const userAgents = allAgents.filter(a => a.source === 'userSettings')
  const projectAgents = allAgents.filter(a => a.source === 'projectSettings')
  const managedAgents = allAgents.filter(a => a.source === 'policySettings')
  const flagAgents = allAgents.filter(a => a.source === 'flagSettings')

  const agentGroups = [
    builtInAgents,
    pluginAgents,
    userAgents,
    projectAgents,
    flagAgents,
    managedAgents,
  ]

  const agentMap = new Map<string, AgentDefinition>()

  for (const agents of agentGroups) {
    for (const agent of agents) {
      agentMap.set(agent.agentType, agent)
    }
  }

  return Array.from(agentMap.values())
}

/**
 * Checks if an agent's required MCP servers are available.
 * Returns true if no requirements or all requirements are met.
 * @param agent The agent to check
 * @param availableServers List of available MCP server names (e.g., from mcp.clients)
 */
export function hasRequiredMcpServers(
  agent: AgentDefinition,
  availableServers: string[],
): boolean {
  if (!agent.requiredMcpServers || agent.requiredMcpServers.length === 0) {
    return true
  }
  // Each required pattern must match at least one available server (case-insensitive)
  return agent.requiredMcpServers.every(pattern =>
    availableServers.some(server =>
      server.toLowerCase().includes(pattern.toLowerCase()),
    ),
  )
}

/**
 * Filters agents based on MCP server requirements.
 * Only returns agents whose required MCP servers are available.
 * @param agents List of agents to filter
 * @param availableServers List of available MCP server names
 */
export function filterAgentsByMcpRequirements(
  agents: AgentDefinition[],
  availableServers: string[],
): AgentDefinition[] {
  return agents.filter(agent => hasRequiredMcpServers(agent, availableServers))
}

/**
 * Check for and initialize agent memory from project snapshots.
 * For agents with memory enabled, copies snapshot to local if no local memory exists.
 * For agents with newer snapshots, logs a debug message (user prompt TODO).
 */
async function initializeAgentMemorySnapshots(
  agents: CustomAgentDefinition[],
): Promise<void> {
  await Promise.all(
    agents.map(async agent => {
      if (agent.memory !== 'user') return
      const result = await checkAgentMemorySnapshot(
        agent.agentType,
        agent.memory,
      )
      switch (result.action) {
        case 'initialize':
          logForDebugging(
            `Initializing ${agent.agentType} memory from project snapshot`,
          )
          await initializeFromSnapshot(
            agent.agentType,
            agent.memory,
            result.snapshotTimestamp!,
          )
          break
        case 'prompt-update':
          agent.pendingSnapshotUpdate = {
            snapshotTimestamp: result.snapshotTimestamp!,
          }
          logForDebugging(
            `Newer snapshot available for ${agent.agentType} memory (snapshot: ${result.snapshotTimestamp})`,
          )
          break
      }
    }),
  )
}

export const getAgentDefinitionsWithOverrides = memoize(
  async (cwd: string): Promise<AgentDefinitionsResult> => {
    // Simple mode: skip custom agents, only return built-ins
    if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const builtInAgents = getBuiltInAgents()
      return {
        activeAgents: builtInAgents,
        allAgents: builtInAgents,
      }
    }

    try {
      const markdownFiles = await loadMarkdownFilesForSubdir('agents', cwd)
      /*
      1. 加载 Markdown 文件
        ├── loadMarkdownFilesForSubdir('agents', cwd)
        │   ├── ~/.claude/agents/*.md  （用户级，source = 'userSettings'）
        │   ├── .claude/agents/*.md    （项目级，source = 'projectSettings'）
        │   └── managed/policy sources （策略级，source = 'policySettings'）
      */

      /*
        │
        └── 每个 .md 文件：
            ├── 解析 YAML frontmatter
            ├── 正文作为 system prompt
            ├── 校验必需字段（name, description）
            ├── 静默跳过无 frontmatter 的 .md 文件（可能是参考文档）
            └── 解析失败 → 记录到 failedFiles，不阻塞其他 Agent
      */
      const failedFiles: Array<{ path: string; error: string }> = []
      const customAgents = markdownFiles
        .map(({ filePath, baseDir, frontmatter, content, source }) => {
          const agent = parseAgentFromMarkdown(
            filePath,
            baseDir,
            frontmatter,
            content,
            source,
          )
          if (!agent) {
            // Skip non-agent markdown files silently (e.g., reference docs
            // co-located with agent definitions). Only report errors for files
            // that look like agent attempts (have a 'name' field in frontmatter).
            if (!frontmatter['name']) {
              return null
            }
            const errorMsg = getParseError(frontmatter)
            failedFiles.push({ path: filePath, error: errorMsg })
            logForDebugging(
              `Failed to parse agent from ${filePath}: ${errorMsg}`,
            )
            logEvent('tengu_agent_parse_error', {
              error:
                errorMsg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              location:
                source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return null
          }
          return agent
        })
        .filter(agent => agent !== null)

      // Kick off plugin agent loading concurrently with memory snapshot init —
      // loadPluginAgents is memoized and takes no args, so it's independent.
      // Join both so neither becomes a floating promise if the other throws.
      /*
      2. 并行加载 Plugin Agents
        └── loadPluginAgents() → memoized
      */
      let pluginAgentsPromise = loadPluginAgents()
      /*
      3. 初始化 Memory Snapshots（如果 AGENT_MEMORY_SNAPSHOT 启用）
        └── initializeAgentMemorySnapshots()
      */
      if (feature('AGENT_MEMORY_SNAPSHOT') && isAutoMemoryEnabled()) {
        const [pluginAgents_] = await Promise.all([
          pluginAgentsPromise,
          initializeAgentMemorySnapshots(customAgents),
        ])
        pluginAgentsPromise = Promise.resolve(pluginAgents_)
      }
      const pluginAgents = await pluginAgentsPromise

      const builtInAgents = getBuiltInAgents()

      const allAgentsList: AgentDefinition[] = [
        ...builtInAgents,
        ...pluginAgents,
        ...customAgents,
      ]

      /*
      4. 合并 Built-in + Plugin + Custom
        └── getActiveAgentsFromList() → 按 agentType 去重，后者覆盖前者
      */
      const activeAgents = getActiveAgentsFromList(allAgentsList)

      /*
      5. 分配颜色
        └── setAgentColor(agentType, color) → 终端 UI 中区分不同 Agent
      */
      // Initialize colors for all active agents
      for (const agent of activeAgents) {
        if (agent.color) {
          setAgentColor(agent.agentType, agent.color)
        }
      }

      return {
        activeAgents,
        allAgents: allAgentsList,
        failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`Error loading agent definitions: ${errorMessage}`)
      logError(error)
      // Even on error, return the built-in agents
      const builtInAgents = getBuiltInAgents()
      return {
        activeAgents: builtInAgents,
        allAgents: builtInAgents,
        failedFiles: [{ path: 'unknown', error: errorMessage }],
      }
    }
  },
)

export function clearAgentDefinitionsCache(): void {
  getAgentDefinitionsWithOverrides.cache.clear?.()
  clearPluginAgentCache()
}

/**
 * Helper to determine the specific parsing error for an agent file
 */
function getParseError(frontmatter: Record<string, unknown>): string {
  const agentType = frontmatter['name']
  const description = frontmatter['description']

  if (!agentType || typeof agentType !== 'string') {
    return 'Missing required "name" field in frontmatter'
  }

  if (!description || typeof description !== 'string') {
    return 'Missing required "description" field in frontmatter'
  }

  return 'Unknown parsing error'
}

/**
 * Parse hooks from frontmatter using the HooksSchema
 * @param frontmatter The frontmatter object containing potential hooks
 * @param agentType The agent type for logging purposes
 * @returns Parsed hooks settings or undefined if invalid/missing
 */
function parseHooksFromFrontmatter(
  frontmatter: Record<string, unknown>,
  agentType: string,
): HooksSettings | undefined {
  if (!frontmatter.hooks) {
    return undefined
  }

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(
      `Invalid hooks in agent '${agentType}': ${result.error.message}`,
    )
    return undefined
  }
  return result.data
}

/**
 * Parses agent definition from JSON data
 */
export function parseAgentFromJson(
  name: string,
  definition: unknown,
  source: SettingSource = 'flagSettings',
): CustomAgentDefinition | null {
  try {
    const parsed = AgentJsonSchema().parse(definition)

    let tools = parseAgentToolsFromFrontmatter(parsed.tools)

    // If memory is enabled, inject Write/Edit/Read tools for memory access
    if (isAutoMemoryEnabled() && parsed.memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    const disallowedTools =
      parsed.disallowedTools !== undefined
        ? parseAgentToolsFromFrontmatter(parsed.disallowedTools)
        : undefined

    const systemPrompt = parsed.prompt

    const agent: CustomAgentDefinition = {
      agentType: name,
      whenToUse: parsed.description,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      getSystemPrompt: () => {
        if (isAutoMemoryEnabled() && parsed.memory) {
          return (
            systemPrompt + '\n\n' + loadAgentMemoryPrompt(name, parsed.memory)
          )
        }
        return systemPrompt
      },
      source,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
      ...(parsed.permissionMode
        ? { permissionMode: parsed.permissionMode }
        : {}),
      ...(parsed.mcpServers && parsed.mcpServers.length > 0
        ? { mcpServers: parsed.mcpServers }
        : {}),
      ...(parsed.hooks ? { hooks: parsed.hooks } : {}),
      ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
      ...(parsed.skills && parsed.skills.length > 0
        ? { skills: parsed.skills }
        : {}),
      ...(parsed.initialPrompt ? { initialPrompt: parsed.initialPrompt } : {}),
      ...(parsed.background ? { background: parsed.background } : {}),
      ...(parsed.memory ? { memory: parsed.memory } : {}),
      ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
    }

    return agent
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agent '${name}' from JSON: ${errorMessage}`)
    logError(error)
    return null
  }
}

/**
 * Parses multiple agents from a JSON object
 */
export function parseAgentsFromJson(
  agentsJson: unknown,
  source: SettingSource = 'flagSettings',
): AgentDefinition[] {
  try {
    const parsed = AgentsJsonSchema().parse(agentsJson)
    return Object.entries(parsed)
      .map(([name, def]) => parseAgentFromJson(name, def, source))
      .filter((agent): agent is CustomAgentDefinition => agent !== null)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agents from JSON: ${errorMessage}`)
    logError(error)
    return []
  }
}

/**
 * Parses agent definition from markdown file data
 */
export function parseAgentFromMarkdown(
  filePath: string,
  baseDir: string,
  frontmatter: Record<string, unknown>,
  content: string,
  source: SettingSource,
): CustomAgentDefinition | null {
  try {
    const agentType = frontmatter['name']
    let whenToUse = frontmatter['description'] as string

    // Validate required fields — silently skip files without any agent
    // frontmatter (they're likely co-located reference documentation)
    if (!agentType || typeof agentType !== 'string') {
      return null
    }
    if (!whenToUse || typeof whenToUse !== 'string') {
      logForDebugging(
        `Agent file ${filePath} is missing required 'description' in frontmatter`,
      )
      return null
    }

    // Unescape newlines in whenToUse that were escaped for YAML parsing
    whenToUse = whenToUse.replace(/\\n/g, '\n')

    const color = frontmatter['color'] as AgentColorName | undefined
    const modelRaw = frontmatter['model']
    let model: string | undefined
    if (typeof modelRaw === 'string' && modelRaw.trim().length > 0) {
      const trimmed = modelRaw.trim()
      model = trimmed.toLowerCase() === 'inherit' ? 'inherit' : trimmed
    }

    // Parse background flag
    const backgroundRaw = frontmatter['background']

    if (
      backgroundRaw !== undefined &&
      backgroundRaw !== 'true' &&
      backgroundRaw !== 'false' &&
      backgroundRaw !== true &&
      backgroundRaw !== false
    ) {
      logForDebugging(
        `Agent file ${filePath} has invalid background value '${backgroundRaw}'. Must be 'true', 'false', or omitted.`,
      )
    }

    const background =
      backgroundRaw === 'true' || backgroundRaw === true ? true : undefined

    // Parse memory scope
    const VALID_MEMORY_SCOPES: AgentMemoryScope[] = ['user', 'project', 'local']
    const memoryRaw = frontmatter['memory'] as string | undefined
    let memory: AgentMemoryScope | undefined
    if (memoryRaw !== undefined) {
      if (VALID_MEMORY_SCOPES.includes(memoryRaw as AgentMemoryScope)) {
        memory = memoryRaw as AgentMemoryScope
      } else {
        logForDebugging(
          `Agent file ${filePath} has invalid memory value '${memoryRaw}'. Valid options: ${VALID_MEMORY_SCOPES.join(', ')}`,
        )
      }
    }

    // Parse isolation mode. 'remote' is ant-only; external builds reject it at parse time.
    type IsolationMode = 'worktree' | 'remote'
    const VALID_ISOLATION_MODES: readonly IsolationMode[] =
      process.env.USER_TYPE === 'ant' ? ['worktree', 'remote'] : ['worktree']
    const isolationRaw = frontmatter['isolation'] as string | undefined
    let isolation: IsolationMode | undefined
    if (isolationRaw !== undefined) {
      if (VALID_ISOLATION_MODES.includes(isolationRaw as IsolationMode)) {
        isolation = isolationRaw as IsolationMode
      } else {
        logForDebugging(
          `Agent file ${filePath} has invalid isolation value '${isolationRaw}'. Valid options: ${VALID_ISOLATION_MODES.join(', ')}`,
        )
      }
    }

    // Parse effort from frontmatter (supports string levels and integers)
    const effortRaw = frontmatter['effort']
    const parsedEffort =
      effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined

    if (effortRaw !== undefined && parsedEffort === undefined) {
      logForDebugging(
        `Agent file ${filePath} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
      )
    }

    // Parse permissionMode from frontmatter
    const permissionModeRaw = frontmatter['permissionMode'] as
      | string
      | undefined
    const isValidPermissionMode =
      permissionModeRaw &&
      (PERMISSION_MODES as readonly string[]).includes(permissionModeRaw)

    if (permissionModeRaw && !isValidPermissionMode) {
      const errorMsg = `Agent file ${filePath} has invalid permissionMode '${permissionModeRaw}'. Valid options: ${PERMISSION_MODES.join(', ')}`
      logForDebugging(errorMsg)
    }

    // Parse maxTurns from frontmatter
    const maxTurnsRaw = frontmatter['maxTurns']
    const maxTurns = parsePositiveIntFromFrontmatter(maxTurnsRaw)
    if (maxTurnsRaw !== undefined && maxTurns === undefined) {
      logForDebugging(
        `Agent file ${filePath} has invalid maxTurns '${maxTurnsRaw}'. Must be a positive integer.`,
      )
    }

    // Extract filename without extension
    const filename = basename(filePath, '.md')

    // Parse tools from frontmatter
    let tools = parseAgentToolsFromFrontmatter(frontmatter['tools'])

    // If memory is enabled, inject Write/Edit/Read tools for memory access
    if (isAutoMemoryEnabled() && memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    // Parse disallowedTools from frontmatter
    const disallowedToolsRaw = frontmatter['disallowedTools']
    const disallowedTools =
      disallowedToolsRaw !== undefined
        ? parseAgentToolsFromFrontmatter(disallowedToolsRaw)
        : undefined

    // Parse skills from frontmatter
    const skills = parseSlashCommandToolsFromFrontmatter(frontmatter['skills'])

    const initialPromptRaw = frontmatter['initialPrompt']
    const initialPrompt =
      typeof initialPromptRaw === 'string' && initialPromptRaw.trim()
        ? initialPromptRaw
        : undefined

    // Parse mcpServers from frontmatter using same Zod validation as JSON agents
    const mcpServersRaw = frontmatter['mcpServers']
    let mcpServers: AgentMcpServerSpec[] | undefined
    if (Array.isArray(mcpServersRaw)) {
      mcpServers = mcpServersRaw
        .map(item => {
          const result = AgentMcpServerSpecSchema().safeParse(item)
          if (result.success) {
            return result.data
          }
          logForDebugging(
            `Agent file ${filePath} has invalid mcpServers item: ${jsonStringify(item)}. Error: ${result.error.message}`,
          )
          return null
        })
        .filter((item): item is AgentMcpServerSpec => item !== null)
    }

    // Parse hooks from frontmatter
    const hooks = parseHooksFromFrontmatter(frontmatter, agentType)

    const systemPrompt = content.trim()
    const agentDef: CustomAgentDefinition = {
      baseDir,
      agentType: agentType,
      whenToUse: whenToUse,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(initialPrompt !== undefined ? { initialPrompt } : {}),
      ...(mcpServers !== undefined && mcpServers.length > 0
        ? { mcpServers }
        : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      /**
       * 这意味着：
          Markdown 正文 = 完整的 system prompt——不是追加，而是替换默认 prompt
          Memory 指令在 memory 启用时自动追加到末尾
          闭包延迟计算——memory 状态可能在文件加载后才变化
          对于 Built-in Agent，getSystemPrompt 接受 toolUseContext 参数，可以根据运行时状态（如是否使用嵌入式搜索工具）动态调整 prompt 内容。
       */
      getSystemPrompt: () => {  // ! Agent 的 system prompt 通过 getSystemPrompt() 闭包延迟生成：
        if (isAutoMemoryEnabled() && memory) {
          const memoryPrompt = loadAgentMemoryPrompt(agentType, memory)
          return systemPrompt + '\n\n' + memoryPrompt
        }
        return systemPrompt
      },
      source,
      filename,
      ...(color && typeof color === 'string' && AGENT_COLORS.includes(color)
        ? { color }
        : {}),
      ...(model !== undefined ? { model } : {}),
      ...(parsedEffort !== undefined ? { effort: parsedEffort } : {}),
      ...(isValidPermissionMode
        ? { permissionMode: permissionModeRaw as PermissionMode }
        : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(background ? { background } : {}),
      ...(memory ? { memory } : {}),
      ...(isolation ? { isolation } : {}),
    }
    return agentDef
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agent from ${filePath}: ${errorMessage}`)
    logError(error)
    return null
  }
}
