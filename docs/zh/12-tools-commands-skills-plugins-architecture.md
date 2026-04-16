# Claude Code：工具、命令、技能、插件的代码实现对比

> 基于 Claude Code v2.1.88 源码分析

---

## 概览

Claude Code 有四个核心扩展概念，它们在抽象层次、调用方式、执行机制上各不相同：

| 概念 | 核心文件 | 本质 | 调用者 |
|------|---------|------|-------|
| **Tool（工具）** | `src/Tool.ts` | TypeScript 接口，模型可调用的原子能力 | Claude 模型（API 层） |
| **Command（命令）** | `src/types/command.ts` | 用户可输入的 slash 命令，3 种子类型 | 用户（`/name`）或模型（技能类型） |
| **Skill（技能）** | `src/skills/` | Markdown 格式的 PromptCommand，是 Command 的子集 | 用户（`/name`）或模型（SkillTool） |
| **Plugin（插件）** | `src/types/plugin.ts` | 可安装的技能/命令/MCP 服务器包 | 用户安装后自动注入 |

---

## 一、Tool（工具）

工具是 Claude 能直接调用的**原子执行能力**，是整个系统的最底层。

### 1.1 类型定义

**文件：`src/Tool.ts`**

```typescript
// src/Tool.ts:362
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  readonly name: string
  readonly inputSchema: Input          // Zod schema，定义 Claude 传参格式
  readonly inputJSONSchema?: ToolInputJSONSchema  // MCP 工具用 JSON Schema
  outputSchema?: z.ZodType<unknown>
  maxResultSizeChars: number           // 结果超限时持久化到磁盘
  readonly strict?: boolean            // 严格模式（API 层参数校验）
  readonly shouldDefer?: boolean       // 是否延迟加载（ToolSearch 机制）
  readonly alwaysLoad?: boolean        // 始终加载，不延迟
  searchHint?: string                  // 关键词提示，供 ToolSearch 匹配
  isMcp?: boolean                      // 是否为 MCP 工具
  isLsp?: boolean                      // 是否为 LSP 工具

  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  prompt(options): Promise<string>     // 注入 system prompt 的工具说明
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>

  // 状态判断
  isEnabled(): boolean
  isConcurrencySafe(input): boolean    // 是否可并发执行
  isReadOnly(input): boolean           // 是否只读（影响权限检查）
  isDestructive?(input): boolean       // 是否不可逆（删除/覆盖/发送）

  // 渲染（React Ink TUI）
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progressMessages, options): React.ReactNode
  mapToolResultToToolResultBlockParam(content, toolUseID): ToolResultBlockParam

  // 安全
  toAutoClassifierInput(input): unknown  // 提供给安全分类器的摘要
  preparePermissionMatcher?(input): Promise<(pattern: string) => boolean>
  backfillObservableInput?(input): void  // 在 hook/transcript 可见前补全字段
}
```

### 1.2 buildTool() 工厂函数

**文件：`src/Tool.ts`**（第 784–793 行）

```typescript
// src/Tool.ts:784
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,       // 注入安全默认值
    userFacingName: () => def.name,
    ...def,                 // 用户定义覆盖默认值
  } as BuiltTool<D>
}
```

**默认值**（`src/Tool.ts:757`）：

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,      // fail-closed：默认不可并发
  isReadOnly: () => false,             // fail-closed：默认有写操作
  isDestructive: () => false,
  checkPermissions: () => Promise.resolve({ behavior: 'allow', updatedInput }),
  toAutoClassifierInput: () => '',     // 默认跳过安全分类器
  userFacingName: () => '',
}
```

### 1.3 实际工具示例：BashTool

**文件：`src/tools/BashTool/BashTool.tsx`**（第 447 行）

```typescript
// src/tools/BashTool/BashTool.tsx:447
export const BashTool = buildTool({
  name: 'Bash',
  searchHint: 'execute shell commands',
  maxResultSizeChars: 30_000,
  strict: true,

  // 只读判断：基于命令约束分析
  isReadOnly(input) {
    const result = checkReadOnlyConstraints(input, commandHasAnyCd(input.command))
    return result.behavior === 'allow'
  },

  // 安全分类器：直接返回命令字符串
  toAutoClassifierInput(input) {
    return input.command
  },

  // 权限匹配器：解析复合命令，防止 "ls && git push" 绕过 git 权限
  async preparePermissionMatcher({ command }) {
    const parsed = await parseForSecurity(command)
    if (parsed.kind !== 'simple') return () => true  // fail-safe
    const subcommands = parsed.commands.map(c => c.argv.join(' '))
    return pattern => subcommands.some(cmd => matchWildcardPattern(pattern, cmd))
  },

  // 输入校验：阻止阻塞性 sleep 命令
  async validateInput(input) {
    const sleepPattern = detectBlockedSleepPattern(input.command)
    if (sleepPattern !== null) return { result: false, message: `Blocked: ${sleepPattern}` }
    return { result: true }
  },

  // 权限检查：委托给 bashToolHasPermission()
  async checkPermissions(input, context) {
    return bashToolHasPermission(input, context)
  },

  // 结果序列化（返回给 Claude API）
  mapToolResultToToolResultBlockParam({ stdout, stderr, ... }, toolUseID) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: ... }
  },
})
```

### 1.4 工具注册与组装

**文件：`src/tools.ts`**

```typescript
// src/tools.ts:194
export function getAllBaseTools(): Tools {
  return [
    AgentTool,        // 子 Agent 委派
    BashTool,         // Shell 命令执行
    GlobTool,         // 文件名模式匹配
    GrepTool,         // 内容搜索
    FileReadTool,     // 文件读取
    FileEditTool,     // 文件编辑
    FileWriteTool,    // 文件写入
    WebFetchTool,     // 网页抓取
    WebSearchTool,    // 网络搜索
    SkillTool,        // 技能调用（元工具）
    TaskCreateTool,   // 任务管理
    // ... 40+ 工具
    // 特性门控工具（feature flags）
    ...(feature('AGENT_TRIGGERS') ? cronTools : []),
    ...(feature('WEB_BROWSER_TOOL') ? [WebBrowserTool] : []),
  ]
}

// src/tools.ts:275
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)
  return allowedTools.filter((_, i) => allowedTools[i].isEnabled())
}

// src/tools.ts:350
export function assembleToolPool(permissionContext, mcpTools): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  // 内置工具排序在前（保证 prompt cache 稳定性），MCP 工具追加在后
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

### 1.5 Tool 执行流程

```
Claude 输出 ToolUse block
  ↓
validateInput(input, context)         [可选，工具自定义校验]
  ↓ 通过
checkPermissions(input, context)      [工具级权限，委托给 permissions.ts]
  ↓ 通过
call(input, context, canUseTool, parentMessage, onProgress)
  ↓
mapToolResultToToolResultBlockParam(output, toolUseID)  → ToolResultBlockParam
  ↓
renderToolResultMessage(output, ...)  → React.ReactNode  [TUI 渲染]
```

---

## 二、Command（命令）

命令是用户可通过 `/name` 输入的 slash 命令，是 Claude Code 的交互入口。

### 2.1 类型定义

**文件：`src/types/command.ts`**

```typescript
// src/types/command.ts:216
export type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

#### CommandBase（第 186–214 行）

所有命令的公共基类：

```typescript
// src/types/command.ts:186
export type CommandBase = {
  name: string
  description: string
  availability?: CommandAvailability[]  // 'claude-ai' | 'console'（认证限制）
  isEnabled?: () => boolean             // 运行时开关（feature flags、env 检查）
  isHidden?: boolean                    // 隐藏于 typeahead/help
  aliases?: string[]
  isMcp?: boolean
  argumentHint?: string                 // 参数提示文本（灰色显示）
  whenToUse?: string                    // 模型调用指导
  version?: string
  disableModelInvocation?: boolean      // 禁止模型调用此命令
  userInvocable?: boolean               // 用户是否可 /name 调用
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  kind?: 'workflow'                     // workflow 类型标记（自动完成时显示徽章）
  immediate?: boolean                   // 立即执行，不等待队列停止点
  isSensitive?: boolean                 // 参数从会话历史中脱敏
  userFacingName?: () => string
}
```

### 2.2 三种 Command 子类型

#### 子类型 1：PromptCommand（第 25–67 行）

**Markdown 驱动的 LLM 提示命令**，也是 Skill 的底层类型：

```typescript
// src/types/command.ts:25
export type PromptCommand = {
  type: 'prompt'
  progressMessage: string              // 执行时的进度提示文本
  contentLength: number                // 内容字符数（token 估算）
  argNames?: string[]                  // 声明的参数名（$arg1 替换）
  allowedTools?: string[]              // 该命令允许的工具列表
  model?: string                       // 覆盖模型
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  context?: 'inline' | 'fork'         // 执行上下文
  agent?: string                       // fork 时的 Agent 类型
  effort?: EffortValue                 // token 预算
  paths?: string[]                     // 条件激活 glob 模式
  hooks?: HooksSettings
  skillRoot?: string                   // 技能根目录
  getPromptForCommand(args, context): Promise<ContentBlockParam[]>
}
```

**示例：`/commit` 命令**（`src/commands/commit.ts`）

```typescript
const command = {
  type: 'prompt',
  name: 'commit',
  description: 'Create a git commit',
  allowedTools: ['Bash(git add:*)', 'Bash(git status:*)', 'Bash(git commit:*)'],
  progressMessage: 'creating commit',
  source: 'builtin',
  async getPromptForCommand(_args, context) {
    const promptContent = getPromptContent()  // 构造 Markdown 提示内容
    const finalContent = await executeShellCommandsInPrompt(promptContent, ...)
    return [{ type: 'text', text: finalContent }]
  },
}
```

#### 子类型 2：LocalCommand（第 84–88 行）

**纯 TypeScript 命令**，通过懒加载模块实现，返回文本结果：

```typescript
// src/types/command.ts:84
type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<LocalCommandModule>  // 懒加载，避免启动时加载重型依赖
}

// 模块形状
export type LocalCommandModule = {
  call: (args: string, context: LocalJSXCommandContext) => Promise<LocalCommandResult>
}

// 返回类型
export type LocalCommandResult =
  | { type: 'text'; value: string }
  | { type: 'compact'; compactionResult: CompactionResult; displayText?: string }
  | { type: 'skip' }
```

**示例：`/compact` 命令**（`src/commands/compact/index.ts`）

```typescript
const compact = {
  type: 'local',
  name: 'compact',
  description: 'Clear conversation history but keep a summary in context.',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  argumentHint: '<optional custom summarization instructions>',
  load: () => import('./compact.js'),  // 懒加载实现文件
}
```

#### 子类型 3：LocalJSXCommand（第 154–162 行）

**交互式 UI 命令**，返回 React 组件渲染到 TUI：

```typescript
// src/types/command.ts:154
type LocalJSXCommand = {
  type: 'local-jsx'
  load: () => Promise<LocalJSXCommandModule>  // 懒加载
}

export type LocalJSXCommandCall = (
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
) => Promise<React.ReactNode>
```

**示例：`/help` 命令**（`src/commands/help/index.ts`）

```typescript
const help = {
  type: 'local-jsx',
  name: 'help',
  description: 'Show help and available commands',
  load: () => import('./help.js'),  // 返回 React 组件
}
```

### 2.3 内置命令注册

**文件：`src/commands.ts`**（第 258–346 行）

```typescript
// src/commands.ts:258
const COMMANDS = memoize((): Command[] => [
  clear, compact, config, context, cost, diff, doctor,
  help, ide, init, keybindings, login, logout, mcp,
  memory, model, permissions, plan, review, resume,
  session, skills, status, theme, usage, vim,
  // 特性门控命令
  ...(proactive ? [proactive] : []),
  ...(briefCommand ? [briefCommand] : []),
  ...(workflowsCmd ? [workflowsCmd] : []),
  // 内部命令（仅 Anthropic 员工）
  ...(process.env.USER_TYPE === 'ant' ? INTERNAL_ONLY_COMMANDS : []),
])
```

### 2.4 命令可用性过滤

**文件：`src/commands.ts`**（第 422–448 行）

```typescript
// 可用性：认证类型限制（静态）
export type CommandAvailability = 'claude-ai' | 'console'

// 启用状态：运行时动态检查（feature flags、env 等）
// isEnabled() 每次调用都重新执行，不缓存
```

---

## 三、Skill（技能）

技能是 **PromptCommand 的特殊形式**，通过 Markdown 文件定义，是系统的主要扩展点。

### 3.1 技能与 PromptCommand 的关系

```
PromptCommand（类型）
  ├─ 内置 PromptCommand（source: 'builtin'）← /commit、/review 等，TypeScript 实现
  └─ Skill（source: 'skills' | 'bundled' | 'plugin' | 'mcp'）← Markdown 实现
```

两者共享同一个 `PromptCommand` 类型，区别在于：
- 内置 PromptCommand：`getPromptForCommand()` 由 TypeScript 代码直接构造
- Skill：`getPromptForCommand()` 读取并处理 Markdown 文件内容

### 3.2 Skill 的 Markdown 格式

```markdown
---
description: 技能描述（可选，否则从正文提取第一段）
user-invocable: true          # 用户可 /name 调用（默认 true）
allowed-tools: Bash, Read     # 限制可用工具
arguments: arg1, arg2         # 声明 $arg1/$arg2 变量
argument-hint: <arg>          # 参数提示文本
when_to_use: "..."            # 模型调用时机指导
model: opus                   # 覆盖模型（opus/sonnet/haiku/inherit）
effort: max                   # token 预算
context: fork                 # 执行上下文（fork = 子 Agent）
agent: general-purpose        # fork 时的 Agent 类型
hooks:                        # 技能调用时注册的 Hooks
  pre_skill: "..."
paths: src/**/*.ts            # 条件激活（仅在操作匹配文件时可见）
version: "1.0.0"
---

# 技能正文（Markdown）

## 使用方式
$ARGUMENTS 或 $arg1 会被替换为用户传入的参数

!`git status`  ← 执行 shell 命令并将输出注入到提示中
${CLAUDE_SKILL_DIR}  ← 替换为技能目录路径
${CLAUDE_SESSION_ID}  ← 替换为当前会话 ID
```

### 3.3 Skill 的 5 个来源（loadedFrom）

| `loadedFrom` | `source` | 存储位置 | 加载时机 |
|---|---|---|---|
| `bundled` | `bundled` | 编译进 CLI 二进制 | 启动时 `initBundledSkills()` |
| `skills` | `userSettings`/`projectSettings`/`policySettings` | `~/.claude/skills/` 或 `.claude/skills/` | 首次 `getCommands()` 时 |
| `plugin` | `plugin` | `~/.claude/plugins/*/skills/` | 首次 `getCommands()` 时 |
| `managed` | `policySettings` | 管理员配置路径 | 首次 `getCommands()` 时 |
| `mcp` | `mcp` | MCP Server 动态生成 | MCP 连接时 |

### 3.4 Skill 内容处理（getPromptForCommand）

**文件：`src/skills/loadSkillsDir.ts`**（第 344–400 行）

```typescript
// src/skills/loadSkillsDir.ts:366
async getPromptForCommand(args, toolUseContext) {
  let finalContent = baseDir
    ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
    : markdownContent

  // 1. 替换 $arg1/$arg2 等参数占位符
  finalContent = substituteArguments(finalContent, args, true, argumentNames)

  // 2. 替换 ${CLAUDE_SKILL_DIR} → 技能目录绝对路径
  if (baseDir) {
    finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
  }

  // 3. 替换 ${CLAUDE_SESSION_ID} → 当前会话 ID
  finalContent = finalContent.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

  // 4. 执行 !`command` 内联 shell 命令（MCP 技能不执行，防止远程代码注入）
  if (loadedFrom !== 'mcp') {
    finalContent = await executeShellCommandsInPrompt(finalContent, ...)
  }

  return [{ type: 'text', text: finalContent }]
}
```

### 3.5 SkillTool：模型调用技能的桥梁

**文件：`src/tools/SkillTool/SkillTool.ts`**（第 331 行）

SkillTool 是一个**元工具（meta-tool）**，它让 Claude 模型能够调用技能：

```typescript
// 模型输出：
{ type: 'tool_use', name: 'Skill', input: { skill: 'commit', args: 'fix bug' } }

// SkillTool.call() 执行路径（第 580 行）：
async call({ skill, args }, context, ...) {
  const commandName = skill.startsWith('/') ? skill.substring(1) : skill
  const commands = await getAllCommands(context)   // 第 81 行
  const command = findCommand(commandName, commands)

  recordSkillUsage(commandName)  // 记录使用频率，用于排序

  if (command?.context === 'fork') {
    return executeForkedSkill(...)   // 第 122 行：子 Agent 隔离执行
  }

  // inline 执行：展开技能内容
  const processedCommand = await processPromptSlashCommand(commandName, args, commands, context)
  // 注入 allowedTools、model 覆盖、effort 覆盖到 modifiedContext
}
```

**结果序列化**（第 843–862 行）：

```typescript
mapToolResultToToolResultBlockParam(result, toolUseID) {
  if (result.status === 'forked') {
    return { content: `Skill "${result.commandName}" completed (forked execution).\n\nResult:\n${result.result}` }
  }
  // inline：返回启动消息，实际技能内容已注入到消息流
  return { content: `Launching skill: ${result.commandName}` }
}
```

---

## 四、Plugin（插件）

插件是**可安装的技能/命令/服务包**，通过 Marketplace 分发。

### 4.1 类型定义

**文件：`src/types/plugin.ts`**

#### BuiltinPluginDefinition（第 18–35 行）

内置插件（随 CLI 发布，用户可开关）：

```typescript
// src/types/plugin.ts:18
export type BuiltinPluginDefinition = {
  name: string
  description: string
  version?: string
  skills?: BundledSkillDefinition[]     // 提供的技能
  hooks?: HooksSettings                 // 提供的 Hooks
  mcpServers?: Record<string, McpServerConfig>  // 提供的 MCP 服务器
  isAvailable?: () => boolean           // 是否可用（基于系统能力）
  defaultEnabled?: boolean              // 默认启用状态
}
```

#### LoadedPlugin（第 48–70 行）

已安装并加载的插件的运行时表示：

```typescript
// src/types/plugin.ts:48
export type LoadedPlugin = {
  name: string
  manifest: PluginManifest             // 解析后的 plugin.json
  path: string                         // 本地安装路径
  source: string                       // 来源标识符
  repository: string                   // 仓库标识符
  enabled?: boolean
  isBuiltin?: boolean                  // 是否为内置插件
  sha?: string                         // Git commit SHA（版本固定）
  commandsPath?: string                // 命令目录路径
  commandsPaths?: string[]             // 额外命令目录
  agentsPath?: string                  // Agent 定义目录
  skillsPath?: string                  // 技能目录路径
  skillsPaths?: string[]               // 额外技能目录
  hooksConfig?: HooksSettings          // Hooks 配置
  mcpServers?: Record<string, McpServerConfig>
  lspServers?: Record<string, LspServerConfig>
  settings?: Record<string, unknown>
}
```

### 4.2 PluginManifest 结构（plugin.json）

**文件：`src/utils/plugins/schemas.ts`**（第 884–898 行）

```typescript
// src/utils/plugins/schemas.ts:884
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    ...PluginManifestMetadataSchema().shape,      // name, version, description, author...
    ...PluginManifestHooksSchema().partial().shape,    // hooks
    ...PluginManifestCommandsSchema().partial().shape, // commands
    ...PluginManifestAgentsSchema().partial().shape,   // agents
    ...PluginManifestSkillsSchema().partial().shape,   // skills
    ...PluginManifestOutputStylesSchema().partial().shape,
    ...PluginManifestChannelsSchema().partial().shape, // channels (stable/beta)
    ...PluginManifestMcpServerSchema().partial().shape, // mcpServers
    ...PluginManifestLspServerSchema().partial().shape, // lspServers
    ...PluginManifestSettingsSchema().partial().shape,
    ...PluginManifestUserConfigSchema().partial().shape,
  }),
)

// src/utils/plugins/schemas.ts:1653
export type PluginManifest = z.infer<ReturnType<typeof PluginManifestSchema>>
```

**plugin.json 示例**：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My plugin description",
  "skills": "skills/",
  "commands": "commands/",
  "hooks": "hooks.json",
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}
```

### 4.3 Marketplace 来源类型

**文件：`src/utils/plugins/schemas.ts`**（第 906–1043 行）

```typescript
// 支持 7 种 Marketplace 来源
z.discriminatedUnion('source', [
  z.object({ source: 'url', url: string }),           // 直接 URL
  z.object({ source: 'github', repo: string, ref?: string }),  // GitHub 仓库
  z.object({ source: 'git', url: string, ref?: string }),      // 任意 Git 仓库
  z.object({ source: 'npm', package: string }),        // NPM 包
  z.object({ source: 'file', path: string }),          // 本地文件
  z.object({ source: 'directory', path: string }),     // 本地目录
  z.object({ source: 'settings', name: string, plugins: [...] }),  // settings.json 内联
])
```

### 4.4 插件加载流程

**文件：`src/utils/plugins/loadPluginCommands.ts`**

```
用户安装插件
  ↓
~/.claude/plugins/<marketplace>/<plugin-name>/
  ├─ plugin.json          ← PluginManifest
  ├─ skills/
  │   └─ my-skill/
  │       └─ SKILL.md
  ├─ commands/
  │   └─ my-command.md
  └─ hooks.json
  ↓
getPluginSkills()  [第 840 行，memoized]
  ├─ loadAllPluginsCacheOnly()  → LoadedPlugin[]
  └─ 对每个已启用插件并行：
      ├─ loadSkillsFromDirectory(plugin.skillsPath, ...)
      └─ 创建 Command（loadedFrom: 'plugin', source: 'plugin'）
  ↓
命令名格式：{plugin-name}:{namespace}:{command-name}
${CLAUDE_PLUGIN_ROOT} 变量替换为插件安装路径
```

### 4.5 内置插件注册

**文件：`src/plugins/builtinPlugins.ts`**（第 28–131 行）

```typescript
// src/plugins/builtinPlugins.ts:28
export function registerBuiltinPlugin(definition: BuiltinPluginDefinition): void {
  BUILTIN_PLUGINS.set(definition.name, definition)
}

// src/plugins/builtinPlugins.ts:108
export function getBuiltinPluginSkillCommands(): Command[] {
  const { enabled } = getBuiltinPlugins()
  return enabled.flatMap(plugin =>
    (plugin.skills ?? []).map(skillDef => skillDefinitionToCommand(skillDef))
  )
}

// src/plugins/builtinPlugins.ts:135
function skillDefinitionToCommand(definition: BundledSkillDefinition): Command {
  // 将 BundledSkillDefinition 转换为 Command（与 registerBundledSkill 相同逻辑）
}
```

---

## 五、四者的核心区别

### 5.1 抽象层次

```
Plugin（插件）
  └─ 包含多个 Skill / Command / MCP Server
       └─ Skill（技能）= PromptCommand（Markdown 实现）
            └─ Command（命令）= PromptCommand | LocalCommand | LocalJSXCommand
                 └─ Tool（工具）= 模型可调用的原子能力
```

### 5.2 实现方式对比

| 维度 | Tool | Command（PromptCommand） | Command（LocalCommand） | Command（LocalJSXCommand） | Skill | Plugin |
|------|------|------------------------|------------------------|---------------------------|-------|--------|
| **实现语言** | TypeScript | TypeScript（构造 Markdown） | TypeScript | TypeScript + React | Markdown | 多文件包 |
| **调用者** | Claude 模型 | 用户/模型 | 用户 | 用户 | 用户/模型 | N/A（安装后激活） |
| **调用方式** | API ToolUse block | `/name args` | `/name args` | `/name args` | `/name args` 或 `Skill(name)` | 安装后自动注入 |
| **执行位置** | 当前 Agent 上下文 | inline 或 fork | 当前进程 | 当前进程 | inline 或 fork | 按内容决定 |
| **返回值** | `ToolResult<Output>` | `SlashCommandResult` | `LocalCommandResult` | `React.ReactNode` | `SlashCommandResult` | N/A |
| **权限检查** | `validateInput` + `checkPermissions` | SkillTool 权限 | N/A | N/A | SkillTool 权限 | 安装时确认 |
| **可扩展性** | 仅内置或 MCP | 仅内置 | 仅内置 | 仅内置 | 用户可自定义 | 第三方可发布 |
| **生命周期** | 每次 API 调用组装 | 启动时加载，memoized | 启动时加载 | 启动时加载 | 首次调用时加载 | 安装时加载 |

### 5.3 注册/发现机制对比

| | Tool | 内置 Command | Skill（磁盘） | Plugin |
|--|------|-------------|--------------|--------|
| **注册方式** | `getAllBaseTools()` 静态列表 | `COMMANDS()` 静态列表 | 扫描 `~/.claude/skills/` | 扫描 `~/.claude/plugins/` |
| **发现时机** | 进程启动时 | 进程启动时 | 首次 `getCommands()` | 首次 `getCommands()` |
| **缓存策略** | 每次 `getTools()` 过滤 | `memoize()` 全局 | `memoize(cwd)` 按目录 | `memoize()` 全局 |
| **热更新** | 不支持 | 不支持 | `clearCommandMemoizationCaches()` | `clearPluginCommandCache()` |

### 5.4 权限模型对比

| | Tool | Skill（via SkillTool） | LocalCommand | Plugin |
|--|------|----------------------|--------------|--------|
| **权限检查点** | `validateInput` + `checkPermissions` | `SkillTool.validateInput` | 无 | 安装时用户确认 |
| **自动允许条件** | `buildTool` 默认允许 | 仅有安全属性（`SAFE_SKILL_PROPERTIES`，第 875 行） | 始终允许 | 用户启用后允许 |
| **安全分类器** | `toAutoClassifierInput()` | 无 | 无 | 无 |
| **工具限制** | 无 | `allowedTools` frontmatter | 无 | `allowed-tools` 字段 |

---

## 六、关键文件索引

### Tool 相关

| 文件 | 关键内容 | 行号 |
|------|----------|------|
| `src/Tool.ts` | `Tool<Input, Output>` 类型定义 | 362–700 |
| `src/Tool.ts` | `ToolUseContext` 类型定义 | 158–306 |
| `src/Tool.ts` | `ToolDef` 类型（buildTool 参数） | 721–726 |
| `src/Tool.ts` | `TOOL_DEFAULTS` 默认值 | 757–769 |
| `src/Tool.ts` | `buildTool()` 工厂函数 | 784–793 |
| `src/tools.ts` | `getAllBaseTools()` 工具列表 | 194–252 |
| `src/tools.ts` | `getTools()` 权限过滤 | 275–331 |
| `src/tools.ts` | `assembleToolPool()` MCP 合并 | 350–372 |
| `src/tools/BashTool/BashTool.tsx` | BashTool 完整实现 | 447–700+ |
| `src/tools/BashTool/BashTool.tsx` | `validateInput()` | 555–569 |
| `src/tools/BashTool/BashTool.tsx` | `checkPermissions()` | 570–572 |
| `src/tools/SkillTool/SkillTool.ts` | `SkillTool`（元工具） | 331–869 |
| `src/tools/SkillTool/SkillTool.ts` | `getAllCommands()` | 81–94 |
| `src/tools/SkillTool/SkillTool.ts` | `executeForkedSkill()` | 122–289 |
| `src/tools/SkillTool/SkillTool.ts` | `call()` 主执行逻辑 | 580–841 |
| `src/tools/SkillTool/SkillTool.ts` | `SAFE_SKILL_PROPERTIES` | 875–910 |

### Command 相关

| 文件 | 关键内容 | 行号 |
|------|----------|------|
| `src/types/command.ts` | `PromptCommand` 类型 | 25–67 |
| `src/types/command.ts` | `LocalCommand` 类型 | 84–88 |
| `src/types/command.ts` | `LocalJSXCommand` 类型 | 154–162 |
| `src/types/command.ts` | `CommandBase` 类型 | 186–214 |
| `src/types/command.ts` | `Command` 联合类型 | 216–217 |
| `src/commands.ts` | `COMMANDS()` 内置命令列表 | 258–346 |
| `src/commands.ts` | `getCommands()` 公开入口 | 486–528 |
| `src/commands.ts` | `findCommand()` 查找 | 706–716 |
| `src/commands/commit.ts` | PromptCommand 示例 | 1–90 |
| `src/commands/compact/index.ts` | LocalCommand 示例 | 1–15 |
| `src/commands/help/index.ts` | LocalJSXCommand 示例 | 1–10 |

### Skill 相关

| 文件 | 关键内容 | 行号 |
|------|----------|------|
| `src/skills/bundled/index.ts` | `initBundledSkills()` | 24–79 |
| `src/skills/bundledSkills.ts` | `BundledSkillDefinition` 类型 | 16–42 |
| `src/skills/bundledSkills.ts` | `registerBundledSkill()` | 54–107 |
| `src/skills/bundledSkills.ts` | `getBundledSkills()` | 107–113 |
| `src/skills/loadSkillsDir.ts` | `parseSkillFrontmatterFields()` | 204–226 |
| `src/skills/loadSkillsDir.ts` | `createSkillCommand()` | 292–427 |
| `src/skills/loadSkillsDir.ts` | `loadSkillsFromSkillsDir()` | 434–508 |
| `src/skills/loadSkillsDir.ts` | `getSkillDirCommands()` | 687–1144 |
| `src/skills/mcpSkillBuilders.ts` | `registerMCPSkillBuilders()` | 33–43 |

### Plugin 相关

| 文件 | 关键内容 | 行号 |
|------|----------|------|
| `src/types/plugin.ts` | `BuiltinPluginDefinition` 类型 | 18–35 |
| `src/types/plugin.ts` | `LoadedPlugin` 类型 | 48–70 |
| `src/types/plugin.ts` | `PluginError` 错误类型 | 101–283 |
| `src/utils/plugins/schemas.ts` | `PluginManifestSchema` | 884–898 |
| `src/utils/plugins/schemas.ts` | `MarketplaceSourceSchema` | 906–1043 |
| `src/utils/plugins/schemas.ts` | `PluginManifest` 类型导出 | 1653 |
| `src/plugins/builtinPlugins.ts` | `registerBuiltinPlugin()` | 28–36 |
| `src/plugins/builtinPlugins.ts` | `getBuiltinPluginSkillCommands()` | 108–131 |
| `src/plugins/builtinPlugins.ts` | `skillDefinitionToCommand()` | 135–162 |
| `src/utils/plugins/loadPluginCommands.ts` | `getPluginSkills()` | 846–951 |
| `src/utils/plugins/loadPluginCommands.ts` | `createPluginCommand()` | 218–413 |
| `src/utils/plugins/loadPluginCommands.ts` | `getPluginCommands()` | 414–679 |

---

## 七、Skill vs Plugin：为什么有了 Skill 还需要 Plugin？

这是理解整个扩展体系的核心问题。**Skill 解决的是"给 Claude 一段指令"，Plugin 解决的是"给 Claude Code 安装一套能力"**。

### 7.1 Skill 能做什么，做不到什么

Skill 本质上是一段 Markdown 文本，`getPromptForCommand()` 展开后注入对话上下文。它的边界非常清晰：

**能做的：**
- 给 Claude 一段结构化的任务指令
- 限制该任务可用的工具（`allowed-tools` frontmatter）
- 在 fork 模式下以独立子 Agent 运行
- 通过 `!command` 在提示中嵌入 shell 命令的输出
- 声明参数（`$arg1`）、指定模型（`model: opus`）、设定 token 预算（`effort: max`）

**做不到的：**
- 安装并启动一个外部进程（如 TypeScript Language Server）
- 向 Claude 注册全新的工具（MCP tool）
- 在每个工具调用前后执行自定义拦截逻辑（Hooks）
- 声明用户可配置项（API key、路径等）并安全存储敏感值
- 依赖另一个 Skill/Plugin
- 打包成可发布的版本化单元供他人安装
- 定义新的 Agent 类型（带有专属系统提示和工具集的 Sub-Agent）

### 7.2 Plugin 比 Skill 多出的 6 种能力

Plugin 是一个**目录包**，通过 `.claude-plugin/plugin.json` 声明其提供的所有能力。一个 Plugin 可以同时包含多种组件：

#### 能力 1：MCP 服务器（`mcpServers`）

**文件：`src/utils/plugins/schemas.ts:543`，`src/utils/plugins/mcpPluginIntegration.ts`**

Plugin 可以启动外部进程并通过 MCP 协议向 Claude 注册**全新的工具**。这是 Skill 根本无法做到的：

```json
// plugin.json
{
  "mcpServers": {
    "my-db-server": {
      "command": "node",
      "args": ["./server.js"],
      "env": { "DB_URL": "${user_config.DATABASE_URL}" }
    }
  }
}
```

加载时序（`src/utils/plugins/mcpPluginIntegration.ts`）：
```
Plugin 启用
  → loadMcpServersFromPlugin()
  → 将 MCP 服务器配置合并进 appState.mcp
  → Claude Code 连接 MCP 服务器
  → 服务器暴露的工具出现在 Claude 的工具列表中
```

#### 能力 2：LSP 服务器（`lspServers`）

**文件：`src/utils/plugins/schemas.ts:797`，`src/utils/plugins/lspPluginIntegration.ts`**

Plugin 可以启动 Language Server Protocol 服务器，为特定文件类型提供语言智能（跳转、补全、诊断等）：

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact" }
    }
  }
}
```

#### 能力 3：全局 Hooks（`hooks`）

**文件：`src/utils/plugins/loadPluginHooks.ts`，`src/utils/plugins/schemas.ts:328`**

Plugin 可以注册**全局生命周期钩子**，拦截 Claude Code 的所有工具调用、会话事件等。Skill 的 `hooks` 字段只在该 Skill 被调用时生效；Plugin 的 Hooks 在整个会话期间持续生效：

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "audit-logger $CLAUDE_TOOL_INPUT" }] }],
    "PostToolUse": [...],
    "SessionStart": [...],
    "SessionEnd": [...]
  }
}
```

支持的 Hook 事件（`src/utils/plugins/loadPluginHooks.ts:31`）：

```
PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied,
Notification, UserPromptSubmit, SessionStart, SessionEnd,
Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact, PermissionRequest, Setup,
TeammateIdle, TaskCreated, TaskCompleted,
Elicitation, ElicitationResult, ConfigChange,
WorktreeCreate, WorktreeRemove, InstructionsLoaded,
CwdChanged, FileChanged
```

#### 能力 4：用户配置项（`userConfig`）

**文件：`src/utils/plugins/schemas.ts:587`，`src/utils/plugins/pluginOptionsStorage.ts`**

Plugin 可以声明用户需要填写的配置项（如 API key、路径），在启用时弹出配置对话框，并安全存储：

```json
{
  "userConfig": {
    "DATABASE_URL": {
      "type": "string",
      "title": "Database URL",
      "description": "PostgreSQL connection string",
      "required": true
    },
    "API_KEY": {
      "type": "string",
      "title": "API Key",
      "description": "Your service API key",
      "sensitive": true
    }
  }
}
```

存储分层（`src/utils/plugins/pluginOptionsStorage.ts:4`）：
- `sensitive: false` → 明文存入 `~/.claude/settings.json` 的 `pluginConfigs[pluginId].options`
- `sensitive: true` → 存入系统安全存储（macOS Keychain / `.credentials.json`）

配置值通过 `${user_config.KEY}` 在 MCP/LSP 配置和 Hook 命令中引用。

#### 能力 5：Agent 定义（`agents`）

**文件：`src/utils/plugins/loadPluginAgents.ts`，`src/utils/plugins/schemas.ts:460`**

Plugin 可以定义新的 **Agent 类型**（带有专属系统提示、工具集、颜色标识的 Sub-Agent），供 AgentTool 的 `subagent_type` 参数使用：

```
plugin/
  agents/
    code-reviewer.md    ← 定义 "code-reviewer" agent 类型
    data-analyst.md     ← 定义 "data-analyst" agent 类型
```

#### 能力 6：版本管理、依赖、Marketplace 分发

**文件：`src/utils/plugins/pluginLoader.ts:3009`，`src/utils/plugins/schemas.ts:274`**

Plugin 是一个可版本化、可发布的单元：

```json
{
  "name": "my-plugin",
  "version": "1.2.3",
  "dependencies": ["other-plugin@marketplace"],
  "repository": "https://github.com/org/my-plugin"
}
```

- **依赖声明**：`dependencies` 字段声明依赖的其他 Plugin，`verifyAndDemote()` 在加载时验证依赖是否满足（`src/utils/plugins/pluginLoader.ts:3189`）
- **Marketplace 分发**：通过 GitHub、NPM、Git URL、本地路径等多种来源安装
- **优先级合并**：session（`--plugin-dir`）> marketplace > builtin（`src/utils/plugins/pluginLoader.ts:3073`）
- **企业策略锁定**：管理员可通过 `policySettings.enabledPlugins` 强制启用/禁用特定 Plugin

### 7.3 Skill 与 Plugin 的本质区别

```
Skill（技能）
  ├─ 是什么：一段 Markdown 指令
  ├─ 作用对象：Claude 模型的上下文（对话层）
  ├─ 生命周期：被调用时展开，调用结束即消失
  ├─ 扩展粒度：单个任务的提示词
  └─ 存储位置：~/.claude/skills/<name>/SKILL.md

Plugin（插件）
  ├─ 是什么：一个目录包（含 plugin.json manifest）
  ├─ 作用对象：Claude Code 运行时（进程层）
  ├─ 生命周期：启用期间持续生效（Hooks、MCP Server 常驻）
  ├─ 扩展粒度：一套能力的组合（Skills + Hooks + MCP + LSP + Agents）
  └─ 存储位置：~/.claude/plugins/<marketplace>/<name>/
```

### 7.4 代码层面的对应关系

| 能力 | Skill 支持 | Plugin 支持 | 关键实现 |
|------|-----------|------------|---------|
| 给 Claude 一段指令 | ✅ Markdown 正文 | ✅ 通过 `skills/` 目录 | `createSkillCommand()` |
| 限制可用工具 | ✅ `allowed-tools` | ✅ 同上 | `parseSlashCommandToolsFromFrontmatter()` |
| 注册新工具（MCP） | ❌ | ✅ `mcpServers` | `mcpPluginIntegration.ts` |
| 启动 LSP 服务器 | ❌ | ✅ `lspServers` | `lspPluginIntegration.ts` |
| 全局生命周期 Hooks | ❌（仅调用时） | ✅ `hooks`（常驻） | `loadPluginHooks.ts` |
| 用户配置项 + 安全存储 | ❌ | ✅ `userConfig` | `pluginOptionsStorage.ts` |
| 定义新 Agent 类型 | ❌ | ✅ `agents/` | `loadPluginAgents.ts` |
| 版本管理 | ❌ | ✅ `version` + SHA 锁定 | `pluginLoader.ts` |
| 依赖声明 | ❌ | ✅ `dependencies` | `dependencyResolver.ts` |
| Marketplace 发布 | ❌ | ✅ GitHub/NPM/Git | `pluginLoader.ts:3096` |
| 企业策略管控 | 部分（`policySettings`） | ✅ 完整支持 | `mergePluginSources()` |

### 7.5 一句话总结

> **Skill 是内容（一段提示词），Plugin 是基础设施（一套运行时能力）。**
>
> 当你只需要给 Claude 写一段"怎么做某件事"的指令时，用 Skill。当你需要给 Claude Code 本身安装新工具、启动后台服务、拦截系统事件、或打包发布给团队时，用 Plugin。

---

## 八、Skill 与 Plugin 有共同基类吗？

**没有。两者是完全独立的类型体系，不存在任何共同基类或继承关系。**

### 8.1 三个核心类型各自独立

整个代码库全部使用 TypeScript `type` 定义，没有任何 `class` 继承：

```typescript
// src/skills/bundledSkills.ts:16
export type BundledSkillDefinition = {
  name: string
  description: string
  getPromptForCommand: (args, context) => Promise<ContentBlockParam[]>
  // ...
}

// src/types/plugin.ts:18
export type BuiltinPluginDefinition = {
  name: string
  description: string
  skills?: BundledSkillDefinition[]  // 包含 Skill，但不继承它
  hooks?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  // ...
}

// src/utils/plugins/schemas.ts:1653（Zod schema 推导）
export type PluginManifest = z.infer<ReturnType<typeof PluginManifestSchema>>
```

三者之间唯一的关联是**组合**：`BuiltinPluginDefinition.skills` 字段持有 `BundledSkillDefinition[]`，是"包含"而非"继承"。

### 8.2 两条独立的转换路径，最终汇聚到同一个 Command

两者都需要转换成运行时的 `Command` 对象才能被调用，但走的是**两条完全独立的函数**：

```
BundledSkillDefinition
  ──→  registerBundledSkill()          src/skills/bundledSkills.ts:56
  ──→  Command（推入 bundledSkills[]）

BuiltinPluginDefinition（含 skills 字段）
  ──→  getBuiltinPluginSkillCommands() src/plugins/builtinPlugins.ts:110
         └─ skillDefinitionToCommand() src/plugins/builtinPlugins.ts:135
  ──→  Command
```

`skillDefinitionToCommand()`（第 135–161 行）的实现是把 `BundledSkillDefinition` 的字段**逐一手动赋值**给 `Command` 对象，没有复用 `registerBundledSkill()` 的任何逻辑：

```typescript
// src/plugins/builtinPlugins.ts:135
function skillDefinitionToCommand(definition: BundledSkillDefinition): Command {
  return {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    allowedTools: definition.allowedTools ?? [],
    model: definition.model,
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled ?? (() => true),
    getPromptForCommand: definition.getPromptForCommand,
    // ...
  }
}
```

连转换函数都是重复写的——这是**刻意的平行独立设计**，不存在基类。

### 8.3 为什么不设计共同基类？

从代码注释可以看出一个关键区分（`src/plugins/builtinPlugins.ts:148`）：

```typescript
// 'bundled' not 'builtin' — 'builtin' in Command.source means hardcoded
// slash commands (/help, /clear). Using 'bundled' keeps these skills in
// the Skill tool's listing, analytics name logging, and prompt-truncation
// exemption. The user-toggleable aspect is tracked on LoadedPlugin.isBuiltin.
source: 'bundled',
```

`BundledSkillDefinition` 和 `BuiltinPluginDefinition` 在语义上属于不同层次：
- `BundledSkillDefinition`：描述**单个技能**的内容（提示词 + 元数据）
- `BuiltinPluginDefinition`：描述**一组能力的容器**（可包含多个技能 + Hooks + MCP 服务器）

强行提取公共基类会模糊这个语义边界，反而增加复杂度。两者最终都归一到 `Command` 类型，`Command` 才是它们共同的"输出格式"，而不是共同的"输入基类"。
