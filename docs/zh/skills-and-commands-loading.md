# Claude Code 自定义命令与技能加载机制

> 基于 Claude Code v2.1.88 源码分析

## 概述

Claude Code 的技能（Skills）与自定义命令（Custom Commands）系统是一套分层的、可插拔的架构。技能本质上是 Markdown 文件，通过 YAML frontmatter 声明元数据，由运行时加载并注入到 Claude 的对话上下文中。

系统支持 **5 类来源**的技能/命令：

| 来源 | `loadedFrom` 标识 | 说明 |
|------|-------------------|------|
| 内置技能（Bundled） | `bundled` | 编译进 CLI 二进制，随 CLI 发布 |
| 用户/项目技能 | `skills` | `~/.claude/skills/` 或 `.claude/skills/` 目录下的 Markdown 文件 |
| 插件技能（Plugin） | `plugin` | 安装的插件提供的技能 |
| 内置插件技能（Builtin Plugin） | `bundled` | 可由用户开关的内置插件技能 |
| MCP 技能 | `mcp` | MCP Server 工具自动生成的技能 |

---

## 一、核心类型定义

**文件：`src/types/command.ts`**

### `PromptCommand`（第 25–57 行）

技能的核心类型，表示一个可执行的提示命令：

```typescript
// src/types/command.ts:25
export type PromptCommand = {
  type: 'prompt'
  progressMessage: string
  contentLength: number          // 技能内容字符数，用于 token 估算
  argNames?: string[]
  allowedTools?: string[]        // 该技能允许使用的工具列表
  model?: string                 // 覆盖模型选择
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  pluginInfo?: { pluginManifest, repository }
  hooks?: HooksSettings          // 技能调用时注册的 Hooks
  skillRoot?: string             // 技能根目录（用于 CLAUDE_PLUGIN_ROOT 环境变量）
  context?: 'inline' | 'fork'   // 执行上下文：内联 or 子 Agent
  agent?: string                 // fork 时使用的 Agent 类型
  effort?: EffortValue           // token 预算
  paths?: string[]               // 条件可见性的 glob 模式（匹配文件时才激活）
  getPromptForCommand(args, context): Promise<ContentBlockParam[]>
}
```

### `CommandBase`（第 175–203 行）

所有命令的公共基类：

```typescript
// src/types/command.ts:175
type CommandBase = {
  name: string
  description: string
  aliases?: string[]
  isEnabled?: () => boolean
  isHidden?: boolean
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  whenToUse?: string
  version?: string
  userFacingName?: () => string
}
```

---

## 二、启动时初始化

**文件：`src/main.tsx`**（第 1943–1956 行）

Claude Code 启动时，在并行加载命令之前，先同步注册所有内置技能和插件：

```typescript
// src/main.tsx:1947
// Register bundled skills/plugins before kicking getCommands() — they're
// await points, so the parallel getCommands() memoized an empty list.
initBuiltinPlugins();   // 注册内置插件技能
initBundledSkills();    // 注册内置编译技能

// 异步加载所有命令（memoized）
const commandsPromise = getCommands(preSetupCwd);
```

### 内置技能初始化

**文件：`src/skills/bundled/index.ts`**（第 24–79 行）

```typescript
// src/skills/bundled/index.ts:24
export function initBundledSkills(): void {
  registerUpdateConfigSkill()   // /update-config
  registerKeybindingsSkill()    // /keybindings-help
  registerVerifySkill()         // /verify
  registerDebugSkill()          // /debug
  registerLoremIpsumSkill()
  registerSkillifySkill()
  registerRememberSkill()
  registerSimplifySkill()
  registerBatchSkill()
  registerStuckSkill()
  // 特性门控技能（feature flags）
  if (feature('KAIROS') || feature('KAIROS_DREAM')) { registerDreamSkill() }
  if (feature('AGENT_TRIGGERS')) { registerLoopSkill() }
  // ...
}
```

### 内置技能注册机制

**文件：`src/skills/bundledSkills.ts`**（第 44–107 行）

```typescript
// src/skills/bundledSkills.ts:45
const bundledSkills: Command[] = []  // 内部注册表

// src/skills/bundledSkills.ts:54
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  // 若技能带有 files（参考文件），在首次调用时惰性解压到磁盘
  // 解压目录通过 getBundledSkillExtractDir(name) 获取
  // 构造 Command 对象并推入 bundledSkills 数组
}

// src/skills/bundledSkills.ts:107
export function getBundledSkills(): Command[] {
  return [...bundledSkills]  // 返回副本防止外部修改
}
```

---

## 三、命令加载主流程

### 3.1 `getCommands()` — 公开入口

**文件：`src/commands.ts`**（第 476–517 行）

```typescript
// src/commands.ts:476
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)  // memoized
  const dynamicSkills = getDynamicSkills()         // 文件操作中发现的动态技能

  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )

  // 将动态技能插入到内置命令之前（按优先级排序）
  // ...
}
```

### 3.2 `loadAllCommands()` — 聚合加载（memoized）

**文件：`src/commands.ts`**（第 449–469 行）

```typescript
// src/commands.ts:449
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),        // 所有技能（并行加载 5 个来源）
    getPluginCommands(),   // 插件提供的 slash 命令
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])

  // 合并顺序决定优先级（前面的先被 findCommand 匹配）
  return [
    ...bundledSkills,        // 1. 内置技能
    ...builtinPluginSkills,  // 2. 内置插件技能
    ...skillDirCommands,     // 3. 用户/项目技能
    ...workflowCommands,     // 4. Workflow 命令
    ...pluginCommands,       // 5. 插件命令
    ...pluginSkills,         // 6. 插件技能
    ...COMMANDS(),           // 7. 内置 slash 命令（/help、/compact 等）
  ]
})
```

### 3.3 `getSkills()` — 技能聚合

**文件：`src/commands.ts`**（第 353–398 行）

```typescript
// src/commands.ts:353
async function getSkills(cwd: string): Promise<{
  skillDirCommands: Command[]
  pluginSkills: Command[]
  bundledSkills: Command[]
  builtinPluginSkills: Command[]
}> {
  const [skillDirCommands, pluginSkills] = await Promise.all([
    getSkillDirCommands(cwd),  // 用户/项目技能（从磁盘加载）
    getPluginSkills(),         // 插件技能
  ])
  const bundledSkills = getBundledSkills()             // 已在启动时注册
  const builtinPluginSkills = getBuiltinPluginSkillCommands()
  return { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills }
}
```

---

## 四、用户/项目技能加载

### 4.1 目录发现

**文件：`src/skills/loadSkillsDir.ts`**（第 639–715 行）

```typescript
// src/skills/loadSkillsDir.ts:639
export const getSkillDirCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const userSkillsDir    = join(getClaudeConfigHomeDir(), 'skills')   // ~/.claude/skills/
    const managedSkillsDir = join(getManagedFilePath(), '.claude', 'skills')  // 管理员配置
    const projectSkillsDirs = getProjectDirsUpToHome('skills', cwd)    // .claude/skills/（向上查找）
    const additionalDirs   = getAdditionalDirectoriesForClaudeMd()      // --add-dir 参数

    // 并行加载所有来源（互相独立，无共享状态）
    const [managedSkills, userSkills, projectSkillsNested, additionalSkillsNested, legacyCommands] =
      await Promise.all([
        loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),
        loadSkillsFromSkillsDir(userSkillsDir, 'userSettings'),
        Promise.all(projectSkillsDirs.map(dir => loadSkillsFromSkillsDir(dir, 'projectSettings'))),
        Promise.all(additionalDirs.map(dir => loadSkillsFromSkillsDir(join(dir, '.claude', 'skills'), 'projectSettings'))),
        loadSkillsFromCommandsDir(cwd),  // 兼容旧版 /commands/ 目录
      ])
    // ...
  }
)
```

**支持的目录结构：**

```
~/.claude/skills/           ← 用户全局技能
  my-skill/
    SKILL.md                ← 必须是目录格式，单文件 .md 不支持

.claude/skills/             ← 项目级技能（向上查找直到 home 目录）
  project-skill/
    SKILL.md
    assets/                 ← 可选参考文件

.claude/commands/           ← 旧版兼容（支持单文件格式）
  my-cmd.md                 ← 单文件格式
  my-cmd/
    SKILL.md                ← 目录格式
```

### 4.2 `loadSkillsFromSkillsDir()` — 单目录加载

**文件：`src/skills/loadSkillsDir.ts`**（第 407–480 行）

```typescript
// src/skills/loadSkillsDir.ts:407
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SettingSource,
): Promise<SkillWithPath[]> {
  const entries = await fs.readdir(basePath)

  return Promise.all(entries.map(async (entry) => {
    // 只支持目录格式：skill-name/SKILL.md
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return null

    const skillDirPath  = join(basePath, entry.name)
    const skillFilePath = join(skillDirPath, 'SKILL.md')
    const content       = await fs.readFile(skillFilePath, { encoding: 'utf-8' })

    const { frontmatter, content: markdownContent } = parseFrontmatter(content, skillFilePath)
    const skillName = entry.name
    const parsed    = parseSkillFrontmatterFields(frontmatter, markdownContent, skillName)
    const paths     = parseSkillPaths(frontmatter)

    return {
      skill: createSkillCommand({
        ...parsed,
        skillName,
        markdownContent,
        source,
        baseDir: skillDirPath,
        loadedFrom: 'skills',
        paths,
      }),
      filePath: skillFilePath,
    }
  }))
}
```

### 4.3 去重（基于文件真实路径）

**文件：`src/skills/loadSkillsDir.ts`**（第 726–775 行）

通过 `realpath()` 解析符号链接，避免同一文件被多个来源重复加载：

```typescript
// src/skills/loadSkillsDir.ts:729
const fileIds = await Promise.all(
  allSkillsWithPaths.map(({ filePath }) => getFileIdentity(filePath))
)

const seenFileIds = new Map<string, SettingSource | ...>()
for (let i = 0; i < allSkillsWithPaths.length; i++) {
  const fileId = fileIds[i]
  if (seenFileIds.has(fileId)) {
    // 跳过重复（日志记录哪个来源先加载）
    continue
  }
  seenFileIds.set(fileId, skill.source)
  deduplicatedSkills.push(skill)
}
```

### 4.4 条件技能（Conditional Skills）

**文件：`src/skills/loadSkillsDir.ts`**（第 777–796 行）

带有 `paths` frontmatter 的技能仅在匹配的文件被操作时才激活（不进入默认命令列表）：

```typescript
// src/skills/loadSkillsDir.ts:777
for (const skill of deduplicatedSkills) {
  if (skill.type === 'prompt' && skill.paths?.length > 0
      && !activatedConditionalSkillNames.has(skill.name)) {
    // 存储为条件技能，等待文件操作触发
    conditionalSkills.set(skill.name, skill)
  } else {
    unconditionalSkills.push(skill)
  }
}
```

---

## 五、Frontmatter 解析

### 5.1 `parseSkillFrontmatterFields()` — 解析 frontmatter 字段

**文件：`src/skills/loadSkillsDir.ts`**（第 185–265 行）

支持的 frontmatter 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | 技能描述 |
| `user-invocable` | boolean | 用户是否可通过 `/name` 调用（默认 true） |
| `allowed-tools` | string/string[] | 限制可用工具列表 |
| `arguments` | string/string[] | 声明参数名（用于 `$arg1` 替换） |
| `argument-hint` | string | 参数提示文本 |
| `when_to_use` | string | 模型使用指导 |
| `model` | string | 覆盖模型（opus/sonnet/haiku/inherit） |
| `effort` | string/int | token 预算（min/max 或 1-8） |
| `context` | 'fork' | 以子 Agent 运行 |
| `agent` | string | fork 时使用的 Agent 类型 |
| `hooks` | object | 技能调用时注册的 Hooks |
| `paths` | string/string[] | 条件激活的 glob 模式 |
| `name` | string | 显示名称（覆盖目录名） |
| `version` | string | 技能版本号 |

```typescript
// src/skills/loadSkillsDir.ts:185
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
): {
  displayName, description, allowedTools, argumentNames,
  userInvocable, model, effort, hooks, executionContext, agent, ...
} {
  // user-invocable 默认为 true
  const userInvocable = frontmatter['user-invocable'] === undefined
    ? true
    : parseBooleanFrontmatter(frontmatter['user-invocable'])

  // model: 'inherit' → undefined（使用全局默认）
  const model = frontmatter.model === 'inherit' ? undefined : ...

  return { ... }
}
```

### 5.2 `createSkillCommand()` — 构造 Command 对象

**文件：`src/skills/loadSkillsDir.ts`**（第 270–401 行）

```typescript
// src/skills/loadSkillsDir.ts:270
export function createSkillCommand({ skillName, markdownContent, ... }): Command {
  return {
    type: 'prompt',
    name: skillName,
    // ...
    async getPromptForCommand(args, toolUseContext) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      // 1. 替换 $arg1/$arg2 等参数占位符
      finalContent = substituteArguments(finalContent, args, true, argumentNames)

      // 2. 替换 ${CLAUDE_SKILL_DIR} 为技能目录路径
      if (baseDir) {
        finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
      }

      // 3. 替换 ${CLAUDE_SESSION_ID}
      finalContent = finalContent.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

      // 4. 执行 !`command` 内联 shell 命令（MCP 技能除外，不信任远程内容）
      if (loadedFrom !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(finalContent, ...)
      }

      return [{ type: 'text', text: finalContent }]
    },
  }
}
```

---

## 六、插件技能加载

### 6.1 `getPluginSkills()` — 插件技能加载

**文件：`src/utils/plugins/loadPluginCommands.ts`**（第 840–944 行）

```typescript
// src/utils/plugins/loadPluginCommands.ts:840
export const getPluginSkills = memoize(async (): Promise<Command[]> => {
  const { enabled } = await loadAllPluginsCacheOnly()

  // 并行处理所有已启用插件
  const perPluginSkills = await Promise.all(
    enabled.map(async (plugin): Promise<Command[]> => {
      const loadedPaths = new Set<string>()  // 防止插件内重复
      const pluginSkills: Command[] = []

      // 从默认 skills/ 目录加载
      if (plugin.skillsPath) {
        const skills = await loadSkillsFromDirectory(
          plugin.skillsPath, plugin.name, plugin.source, plugin.manifest, plugin.path, loadedPaths
        )
        pluginSkills.push(...skills)
      }

      // 从 manifest 声明的额外路径加载
      if (plugin.skillsPaths) {
        const pathResults = await Promise.all(
          plugin.skillsPaths.map(skillPath => loadSkillsFromDirectory(...))
        )
        pluginSkills.push(...pathResults.flat())
      }

      return pluginSkills
    })
  )
  return perPluginSkills.flat()
})
```

### 6.2 `createPluginCommand()` — 构造插件命令

**文件：`src/utils/plugins/loadPluginCommands.ts`**（第 218–414 行）

插件命令支持 `${CLAUDE_PLUGIN_ROOT}` 变量替换，命令名格式为 `{plugin-name}:{namespace}:{command-name}`：

```typescript
// src/utils/plugins/loadPluginCommands.ts:218
function createPluginCommand(commandName, file, sourceName, pluginManifest, pluginPath, isSkill) {
  // 在 allowed-tools 中替换 ${CLAUDE_PLUGIN_ROOT} 为插件实际路径
  const substitutedAllowedTools = substitutePluginVariables(rawAllowedTools, {
    path: pluginPath,
    source: sourceName,
  })
  // ...
}
```

### 6.3 内置插件技能

**文件：`src/plugins/builtinPlugins.ts`**（第 28–160 行）

```typescript
// src/plugins/builtinPlugins.ts:28
export function registerBuiltinPlugin(definition: BuiltinPluginDefinition): void {
  // 存入 BUILTIN_PLUGINS map
}

// src/plugins/builtinPlugins.ts:108
export function getBuiltinPluginSkillCommands(): Command[] {
  const { enabled } = getBuiltinPlugins()
  // 将启用的内置插件的 BundledSkillDefinition 转换为 Command
  // src/plugins/builtinPlugins.ts:132
  // function skillDefinitionToCommand(definition): Command { ... }
}
```

---

## 七、MCP 技能

**文件：`src/skills/mcpSkillBuilders.ts`**（第 33–43 行）

MCP 技能在 MCP Server 连接时动态生成，使用与磁盘技能相同的工厂函数：

```typescript
// src/skills/mcpSkillBuilders.ts:33
export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  // 存储 createSkillCommand 和 parseSkillFrontmatterFields 供 MCP 客户端使用
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  return builders
}
```

MCP 技能通过 `context.getAppState().mcp.commands` 获取，`loadedFrom: 'mcp'`，名称格式为 `mcp__server__prompt`。

---

## 八、命令查找

**文件：`src/commands.ts`**（第 688–727 行）

```typescript
// src/commands.ts:688
export function findCommand(
  commandName: string,
  commands: Command[]
): Command | undefined {
  return commands.find(
    _ =>
      _.name === commandName ||
      getCommandName(_) === commandName ||  // userFacingName() 回退到 name
      _.aliases?.includes(commandName)
  )
}

// src/commands.ts:704
export function getCommand(commandName: string, commands: Command[]): Command {
  const command = findCommand(commandName, commands)
  if (!command) throw new ReferenceError(...)
  return command
}
```

---

## 九、技能执行流程

### 9.1 用户直接输入 `/skillname`

**文件：`src/utils/processUserInput/processSlashCommand.tsx`**

```
用户输入 "/commit fix bug"
  ↓
processSlashCommand()  [第 309 行]
  ↓
getMessagesForSlashCommand()  [第 525 行]
  ↓
processPromptSlashCommand("commit", "fix bug", commands, context)  [第 817 行]
  ↓
findCommand("commit", commands) → Command 对象
  ↓
getMessagesForPromptSlashCommand(command, "fix bug", context)  [第 827 行]
  ├─ 检查 context === 'fork'？
  │   YES → executeForkedSlashCommand()  [第 62 行]
  │         ├─ prepareForkedCommandContext()
  │         ├─ runAgent() 在子 Agent 中执行
  │         └─ 返回结果作为 UserMessage
  │   NO  → command.getPromptForCommand("fix bug", context)
  │         → 返回 [{ type: 'text', text: 技能内容 }]
  └─ 返回 { messages: [...], shouldQuery: true }
```

**Fork 模式执行**（第 62–295 行）：

```typescript
// src/utils/processUserInput/processSlashCommand.tsx:62
async function executeForkedSlashCommand(command, args, context, ...) {
  const agentId = createAgentId()
  const { skillContent, modifiedGetAppState, baseAgent, promptMessages } =
    await prepareForkedCommandContext(command, args, context)

  // KAIROS 模式：后台异步执行，立即返回
  if (feature('KAIROS') && kairosEnabled) {
    void (async () => { await runAgent(...) })()
    // 结果通过 enqueuePendingNotification 重新入队
    return { messages: [...], shouldQuery: false }
  }

  // 普通模式：同步等待子 Agent 完成
  const result = await runAgent(...)
  return { messages: [...], shouldQuery: true }
}
```

### 9.2 模型通过 SkillTool 调用

**文件：`src/tools/SkillTool/SkillTool.ts`**

```
模型输出 ToolUse:
  { type: 'tool_use', name: 'Skill', input: { skill: 'commit', args: 'fix bug' } }
  ↓
SkillTool.validateInput()  [第 447 行]
  ├─ 检查权限（getRuleByContentsForTool）
  └─ 只有安全属性的技能自动允许（SAFE_SKILL_PROPERTIES，第 875 行）
  ↓
SkillTool.call({ skill: 'commit', args: 'fix bug' }, context, ...)  [第 580 行]
  ├─ 去掉前导 '/' → commandName = 'commit'
  ├─ 检查是否为远程 canonical 技能（ant 内部实验性功能）
  ├─ getAllCommands(context)  [第 81 行]
  │   └─ getCommands() + MCP 技能合并
  ├─ findCommand('commit', commands)
  ├─ recordSkillUsage('commit')  ← 记录使用频率用于排序
  ├─ 检查 command.context === 'fork'？
  │   YES → executeForkedSkill()  [第 122 行]
  │   NO  → processPromptSlashCommand('commit', 'fix bug', ...)
  ├─ 提取 allowedTools、model、effort
  └─ 构造 modifiedContext（注入 allowedTools、model 覆盖、effort 覆盖）
  ↓
mapToolResultToToolResultBlockParam()  [第 843 行]
  ├─ fork 结果：返回 "Skill completed (forked execution).\n\nResult: ..."
  └─ inline 结果：返回 "Launching skill: commit"
```

**Fork 技能执行**（第 122–289 行）：

```typescript
// src/tools/SkillTool/SkillTool.ts:122
async function executeForkedSkill(command, commandName, args, context, ...) {
  const agentId = createAgentId()

  // 记录遥测事件
  logEvent('tengu_skill_tool_invocation', {
    command_name: sanitizedCommandName,
    execution_context: 'fork',
    invocation_trigger: queryDepth > 0 ? 'nested-skill' : 'claude-proactive',
    ...
  })

  // 通过 runAgent() 在子 Agent 中执行技能
  const result = await runAgent(...)
  return { status: 'forked', commandName, result }
}
```

---

## 十、缓存失效

**文件：`src/commands.ts`**（第 523–530 行）

```typescript
// src/commands.ts:523
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  // 注意：getSkillDirCommands 是单独的 memoize 层，需单独清除
}
```

缓存策略：
- `loadAllCommands`：按 `cwd` memoize，进程内有效
- `getSkillDirCommands`：按 `cwd` memoize
- `getPluginSkills` / `getPluginCommands`：无参数 memoize（全局单例）
- 内置技能：启动时注册，无需 memoize

---

## 十一、完整加载时序图

```
Claude Code 启动
  │
  ├─ [同步] initBuiltinPlugins()       → 注册内置插件技能到 BUILTIN_PLUGINS map
  ├─ [同步] initBundledSkills()        → 注册内置技能到 bundledSkills 数组
  │
  └─ [异步] getCommands(cwd)
       └─ loadAllCommands(cwd) [memoized]
            └─ Promise.all([
                 getSkills(cwd),
                 getPluginCommands(),
                 getWorkflowCommands(),
               ])
                 │
                 └─ getSkills(cwd)
                      └─ Promise.all([
                           getSkillDirCommands(cwd),  ← 磁盘扫描（并行 5 个来源）
                           getPluginSkills(),          ← 已安装插件扫描
                         ])
                         + getBundledSkills()          ← 从注册表读取（同步）
                         + getBuiltinPluginSkillCommands()

用户输入 "/skill args" 或模型调用 Skill 工具
  │
  ├─ findCommand(name, commands)       → 按 name/alias 查找
  ├─ command.getPromptForCommand(args) → 展开技能内容（替换变量/执行 shell）
  └─ 根据 context 字段决定执行方式：
       'fork'   → runAgent() 子 Agent 隔离执行
       'inline' → 内容注入当前对话上下文
```

---

## 十二、关键文件索引

| 文件 | 关键函数 | 行号 |
|------|----------|------|
| `src/types/command.ts` | `PromptCommand` 类型定义 | 25–57 |
| `src/types/command.ts` | `CommandBase` 类型定义 | 175–203 |
| `src/main.tsx` | 启动初始化（`initBundledSkills` + `getCommands`） | 1943–1956 |
| `src/commands.ts` | `getCommands()` 公开入口 | 476–517 |
| `src/commands.ts` | `loadAllCommands()` 聚合加载 | 449–469 |
| `src/commands.ts` | `getSkills()` 技能聚合 | 353–398 |
| `src/commands.ts` | `findCommand()` 命令查找 | 688–703 |
| `src/commands.ts` | `clearCommandMemoizationCaches()` | 523–530 |
| `src/skills/bundled/index.ts` | `initBundledSkills()` | 24–79 |
| `src/skills/bundledSkills.ts` | `registerBundledSkill()` | 54–107 |
| `src/skills/bundledSkills.ts` | `getBundledSkills()` | 107–113 |
| `src/skills/loadSkillsDir.ts` | `getSkillDirCommands()` 目录扫描 | 639–797 |
| `src/skills/loadSkillsDir.ts` | `loadSkillsFromSkillsDir()` 单目录加载 | 407–480 |
| `src/skills/loadSkillsDir.ts` | `parseSkillFrontmatterFields()` | 185–265 |
| `src/skills/loadSkillsDir.ts` | `createSkillCommand()` | 270–401 |
| `src/skills/mcpSkillBuilders.ts` | `registerMCPSkillBuilders()` | 33–43 |
| `src/plugins/builtinPlugins.ts` | `registerBuiltinPlugin()` | 28–36 |
| `src/plugins/builtinPlugins.ts` | `getBuiltinPluginSkillCommands()` | 108–131 |
| `src/utils/plugins/loadPluginCommands.ts` | `getPluginSkills()` | 840–944 |
| `src/utils/plugins/loadPluginCommands.ts` | `createPluginCommand()` | 218–413 |
| `src/utils/processUserInput/processSlashCommand.tsx` | `processPromptSlashCommand()` | 817–826 |
| `src/utils/processUserInput/processSlashCommand.tsx` | `getMessagesForPromptSlashCommand()` | 827–950+ |
| `src/utils/processUserInput/processSlashCommand.tsx` | `executeForkedSlashCommand()` | 62–295 |
| `src/tools/SkillTool/SkillTool.ts` | `getAllCommands()` | 81–94 |
| `src/tools/SkillTool/SkillTool.ts` | `executeForkedSkill()` | 122–289 |
| `src/tools/SkillTool/SkillTool.ts` | `SkillTool.call()` | 580–841 |
| `src/tools/SkillTool/SkillTool.ts` | `mapToolResultToToolResultBlockParam()` | 843–862 |
| `src/tools/SkillTool/SkillTool.ts` | `SAFE_SKILL_PROPERTIES` 权限白名单 | 875–910 |
