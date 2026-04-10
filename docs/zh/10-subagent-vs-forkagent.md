# SubAgent 实现原理及与 ForkAgent 的对比

> 基于 Claude Code v2.1.88 源码的详尽技术分析。

---

## 目录

1. [SubAgent 概述](#1-subagent-概述)
2. [AgentDefinition：Agent 的配置结构](#2-agentdefinition-agent-的配置结构)
3. [工具解析：resolveAgentTools](#3-工具解析-resolveagenttools)
4. [系统提示构建：getAgentSystemPrompt](#4-系统提示构建-getagentsystemprompt)
5. [runAgent：SubAgent 执行核心](#5-runagent-subagent-执行核心)
6. [上下文隔离：createSubagentContext 的调用差异](#6-上下文隔离-createsubagentcontext-的调用差异)
7. [同步 vs 异步 SubAgent](#7-同步-vs-异步-subagent)
8. [SubAgent 的生命周期与资源清理](#8-subagent-的生命周期与资源清理)
9. [SubAgent vs ForkAgent 全面对比](#9-subagent-vs-forkagent-全面对比)
10. [关键文件索引](#10-关键文件索引)

---

## 1. SubAgent 概述

SubAgent（普通子 Agent）是 Claude Code 中通过 `Agent(subagent_type="xxx")` 显式指定类型来启动的子 Agent。与 ForkAgent（省略 `subagent_type`）的根本区别在于：

- **SubAgent**：从零开始，有自己独立的系统提示，消息历史为空（只有用户 prompt），通过完整的背景说明与父 Agent 通信
- **ForkAgent**：继承父 Agent 的完整消息历史和系统提示字节，通过简短的"指令"驱动

SubAgent 的执行核心在 `runAgent()` 函数（`src/tools/AgentTool/runAgent.ts:248`），由 `AgentTool.tsx` 的 `call()` 方法调用。

---

## 2. AgentDefinition：Agent 的配置结构

**`src/tools/AgentTool/loadAgentsDir.ts:106`**

所有 Agent（内置、插件、用户自定义）共享同一个基础类型 `BaseAgentDefinition`：

```typescript
// loadAgentsDir.ts:106
export type BaseAgentDefinition = {
  agentType: string           // Agent 类型名，如 'Explore'、'general-purpose'
  whenToUse: string           // 何时使用的描述（显示在 Agent 工具描述中）
  tools?: string[]            // 允许的工具列表，['*'] 表示全部
  disallowedTools?: string[]  // 明确禁止的工具列表
  skills?: string[]           // 启动时预加载的 skill 名称列表
  mcpServers?: AgentMcpServerSpec[]  // Agent 专属的 MCP 服务器
  hooks?: HooksSettings       // Agent 生命周期 hooks
  color?: AgentColorName      // UI 显示颜色
  model?: string              // 模型覆盖（'inherit' 继承父 Agent）
  effort?: EffortValue        // 计算力级别
  permissionMode?: PermissionMode  // 权限模式覆盖
  maxTurns?: number           // 最大 turn 数限制
  background?: boolean        // 是否始终以后台任务运行
  initialPrompt?: string      // 第一个 user turn 前追加的提示
  memory?: AgentMemoryScope   // 持久化记忆范围
  isolation?: 'worktree' | 'remote'  // 隔离模式
  omitClaudeMd?: boolean      // 是否省略 CLAUDE.md（Explore/Plan 用，节省 token）
  requiredMcpServers?: string[]  // 必须存在的 MCP 服务器
  criticalSystemReminder_EXPERIMENTAL?: string  // 每个 user turn 都重新注入的关键提醒
}
```

**三种 Agent 来源的类型差异：**

```typescript
// 内置 Agent（loadAgentsDir.ts:136）
export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: 'built-in'
  callback?: () => void       // 完成后的回调（仅内置 Agent 有）
  getSystemPrompt: (params: { toolUseContext: Pick<ToolUseContext, 'options'> }) => string
  // ↑ 内置 Agent 需要 toolUseContext 来动态生成提示
}

// 自定义 Agent（用户/项目/策略设置）（loadAgentsDir.ts:146）
export type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string   // 无参数，提示内容存储在闭包中
  source: SettingSource
}

// 插件 Agent（loadAgentsDir.ts:154）
export type PluginAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'plugin'
  plugin: string
}
```

**关键字段说明：**

| 字段 | SubAgent 含义 | ForkAgent 对应 |
|------|--------------|---------------|
| `tools` | 指定工具列表，`['*']` = 全部 | 不使用（useExactTools=true，直接继承父工具池） |
| `omitClaudeMd` | Explore/Plan 省略 CLAUDE.md 节省 token | 不适用（继承父 userContext） |
| `maxTurns` | 限制 turn 数，防止无限循环 | 200（FORK_AGENT 硬编码） |
| `permissionMode` | 可覆盖父 Agent 的权限模式 | `'bubble'`（冒泡到父终端） |
| `background` | true 时始终异步运行 | 始终异步（forceAsync） |
| `model` | 可指定不同模型 | `'inherit'`（强制继承父模型） |
| `hooks` | frontmatter 定义的生命周期 hooks | 不支持 |
| `skills` | 启动时预加载的 skill 内容 | 不支持 |
| `mcpServers` | Agent 专属 MCP 服务器 | 不支持（继承父工具池） |

---

## 3. 工具解析：resolveAgentTools

**`src/tools/AgentTool/agentToolUtils.ts:122`**

SubAgent 的工具池通过 `resolveAgentTools()` 从父 Agent 的工具池中过滤得到：

```typescript
// agentToolUtils.ts:122
export function resolveAgentTools(
  agentDefinition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'source' | 'permissionMode'>,
  availableTools: Tools,   // 父 Agent 的工具池（workerTools，按 bubble 权限模式重新组装）
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {

  // Step 1: 基础过滤（ALL_AGENT_DISALLOWED_TOOLS + ASYNC_AGENT_ALLOWED_TOOLS）
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
      })

  // Step 2: 应用 disallowedTools 黑名单
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !disallowedToolSet.has(tool.name),
  )

  // Step 3: 若 tools = undefined 或 ['*']，返回全部过滤后的工具
  if (hasWildcard) {
    return { hasWildcard: true, resolvedTools: allowedAvailableTools, ... }
  }

  // Step 4: 按 tools 白名单精确匹配
  // 特殊处理：Agent(worker, researcher) 语法提取 allowedAgentTypes
  // 特殊处理：ExitPlanMode 工具在 plan 模式下允许
  for (const toolSpec of agentTools) {
    const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)
    if (toolName === AGENT_TOOL_NAME && ruleContent) {
      allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
    }
    const tool = availableToolMap.get(toolName)
    if (tool) resolved.push(tool)
  }
}
```

### 工具过滤规则（`filterToolsForAgent`，`agentToolUtils.ts:70`）

**`ALL_AGENT_DISALLOWED_TOOLS`（`constants/tools.ts:36`）** — 所有 SubAgent 都不能使用：
- `TaskOutput`（防递归）
- `ExitPlanMode`、`EnterPlanMode`（Plan 模式是主线程抽象）
- `AgentTool`（外部用户禁止，防递归；ant 用户允许嵌套 Agent）
- `AskUserQuestion`（SubAgent 不能直接与用户交互）
- `TaskStop`（需要主线程任务状态）

**`ASYNC_AGENT_ALLOWED_TOOLS`（`constants/tools.ts:55`）** — 异步 SubAgent 只能使用这些工具：
```
FileRead, WebSearch, TodoWrite, Grep, WebFetch, Glob,
Bash/PowerShell, FileEdit, FileWrite, NotebookEdit,
Skill, SyntheticOutput, ToolSearch, EnterWorktree, ExitWorktree
```

**注意：** ForkAgent 使用 `useExactTools=true`，完全绕过 `resolveAgentTools()`，直接使用父 Agent 的工具数组引用（`runAgent.ts:500-502`）。

---

## 4. 系统提示构建：getAgentSystemPrompt

**`src/tools/AgentTool/runAgent.ts:921`**

SubAgent 有自己独立的系统提示，通过 `getAgentSystemPrompt()` 构建：

```typescript
// runAgent.ts:921
async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  try {
    // 调用 Agent 定义的 getSystemPrompt()
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    // 追加环境信息（CWD、平台、模型等）
    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  } catch (_error) {
    // 回退到默认 Agent 提示
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  }
}
```

**`enhanceSystemPromptWithEnvDetails`（`prompts.ts:794`）** 在 Agent 提示末尾追加：

```
Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task.
  Include code snippets only when the exact text is load-bearing...
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls...

<环境信息（computeEnvInfo）：CWD、平台、Shell、模型名、知识截止日期等>
```

**`DEFAULT_AGENT_PROMPT`（`prompts.ts:792`）** — 回退提示：
```
You are an agent for Claude Code, Anthropic's official CLI for Claude.
Given the user's message, you should use the tools available to complete the task.
Complete the task fully—don't gold-plate, but don't leave it half-done.
When you complete the task, respond with a concise report covering what was done and any key findings
— the caller will relay this to the user, so it only needs the essentials.
```

**与 ForkAgent 的对比：**
- ForkAgent 使用 `override.systemPrompt = toolUseContext.renderedSystemPrompt`（父 Agent 的渲染字节）
- SubAgent 调用 `getAgentSystemPrompt()` 构建全新的系统提示

---

## 5. runAgent：SubAgent 执行核心

**`src/tools/AgentTool/runAgent.ts:248`**

`runAgent()` 是所有 Agent（SubAgent 和 ForkAgent 均通过此函数执行）的核心，但两者传入的参数有显著差异。

### 5.1 参数差异

| 参数 | SubAgent | ForkAgent |
|------|---------|-----------|
| `forkContextMessages` | `undefined` | 父 Agent 的完整消息历史 |
| `useExactTools` | `undefined`（false） | `true` |
| `override.systemPrompt` | `undefined`（自行构建） | 父 Agent 的渲染字节 |
| `availableTools` | `workerTools`（重新组装） | `toolUseContext.options.tools`（父工具池） |
| `model` | 可指定（`AgentTool.tsx:610` 传入） | `undefined`（继承父模型） |
| `isAsync` | 可同步可异步 | 强制 true |

### 5.2 消息数组构建（`runAgent.ts:368-373`）

```typescript
// runAgent.ts:368
const contextMessages: Message[] = forkContextMessages
  ? filterIncompleteToolCalls(forkContextMessages)  // ForkAgent：过滤父历史
  : []                                               // SubAgent：空数组

const initialMessages: Message[] = [...contextMessages, ...promptMessages]
// SubAgent：   initialMessages = [用户 prompt 消息]
// ForkAgent：  initialMessages = [父历史..., assistant(tool_uses), user(placeholders + directive)]
```

### 5.3 文件状态缓存（`runAgent.ts:375-378`）

```typescript
// runAgent.ts:375
const agentReadFileState =
  forkContextMessages !== undefined
    ? cloneFileStateCache(toolUseContext.readFileState)  // ForkAgent：克隆父缓存
    : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)  // SubAgent：全新缓存
```

**SubAgent 使用全新的文件状态缓存**，不继承父 Agent 的文件读取历史。这意味着 SubAgent 看到的文件内容与父 Agent 独立，不会受父 Agent 已读文件的影响。

### 5.4 userContext / systemContext 处理（`runAgent.ts:380-410`）

```typescript
// runAgent.ts:380
const [baseUserContext, baseSystemContext] = await Promise.all([
  override?.userContext ?? getUserContext(),   // 重新获取 CLAUDE.md
  override?.systemContext ?? getSystemContext(), // 重新获取 git status
])

// Explore/Plan：省略 CLAUDE.md（节省 ~5-15 Gtok/week）
const shouldOmitClaudeMd =
  agentDefinition.omitClaudeMd &&
  !override?.userContext &&
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)

// Explore/Plan：省略 gitStatus（节省 ~1-3 Gtok/week）
const resolvedSystemContext =
  agentDefinition.agentType === 'Explore' || agentDefinition.agentType === 'Plan'
    ? systemContextNoGit
    : baseSystemContext
```

**SubAgent 重新调用 `getUserContext()` 和 `getSystemContext()`**（两者都是 memoize，实际上是缓存命中），但 Explore/Plan 等只读 Agent 会主动省略 CLAUDE.md 和 gitStatus，避免浪费 token。

**ForkAgent 通过 `override.systemPrompt`（父渲染字节）已经包含了 userContext 和 systemContext 的内容**，不需要重新获取。

### 5.5 权限模式处理（`runAgent.ts:415-498`）

```typescript
// runAgent.ts:415
const agentPermissionMode = agentDefinition.permissionMode
const agentGetAppState = () => {
  const state = toolUseContext.getAppState()
  let toolPermissionContext = state.toolPermissionContext

  // 1. 覆盖权限模式（除非父是 bypassPermissions/acceptEdits/auto）
  if (agentPermissionMode && ...) {
    toolPermissionContext = { ...toolPermissionContext, mode: agentPermissionMode }
  }

  // 2. 异步 Agent 不弹权限对话框（ForkAgent 的 bubble 模式例外）
  const shouldAvoidPrompts =
    canShowPermissionPrompts !== undefined
      ? !canShowPermissionPrompts
      : agentPermissionMode === 'bubble'
        ? false      // bubble 模式：允许弹窗（冒泡到父终端）
        : isAsync    // 其他异步：不弹窗

  // 3. 工具权限白名单（allowedTools 参数）
  if (allowedTools !== undefined) {
    toolPermissionContext = {
      ...toolPermissionContext,
      alwaysAllowRules: {
        cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
        session: [...allowedTools],  // 覆盖会话级权限
      },
    }
  }

  // 4. 努力值覆盖
  const effortValue = agentDefinition.effort ?? state.effortValue

  return { ...state, toolPermissionContext, effortValue }
}
```

### 5.6 SubagentStart Hooks（`runAgent.ts:530-569`）

SubAgent 专有，ForkAgent 不执行：

```typescript
// runAgent.ts:530
const additionalContexts: string[] = []
for await (const hookResult of executeSubagentStartHooks(
  agentId,
  agentDefinition.agentType,
  agentAbortController.signal,
)) {
  if (hookResult.additionalContexts?.length > 0) {
    additionalContexts.push(...hookResult.additionalContexts)
  }
}

// 将 hook 上下文注入为 user message（isMeta: true）
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
```

### 5.7 Frontmatter Hooks 注册（`runAgent.ts:572-590`）

SubAgent 专有：

```typescript
// runAgent.ts:582
if (agentDefinition.hooks && hooksAllowedForThisAgent) {
  registerFrontmatterHooks(
    rootSetAppState,
    agentId,
    agentDefinition.hooks,
    `agent '${agentDefinition.agentType}'`,
    true, // isAgent=true，将 Stop hooks 转换为 SubagentStop
  )
}
```

### 5.8 Skills 预加载（`runAgent.ts:592-661`）

SubAgent 专有，ForkAgent 不支持：

```typescript
// runAgent.ts:592
const skillsToPreload = agentDefinition.skills ?? []
if (skillsToPreload.length > 0) {
  // 解析 skill 名称（支持精确匹配、插件前缀、后缀匹配）
  // 并发加载所有 skill 内容
  const loaded = await Promise.all(
    validSkills.map(async ({ skillName, skill }) => ({
      skillName,
      skill,
      content: await skill.getPromptForCommand('', toolUseContext),
    })),
  )
  // 注入为 initialMessages 的 user message（isMeta: true）
  for (const { skillName, skill, content } of loaded) {
    initialMessages.push(createUserMessage({
      content: [{ type: 'text', text: metadata }, ...content],
      isMeta: true,
    }))
  }
}
```

### 5.9 Agent 专属 MCP 服务器（`runAgent.ts:663-679`）

SubAgent 专有：

```typescript
// runAgent.ts:663
const { clients: mergedMcpClients, tools: agentMcpTools, cleanup: mcpCleanup }
  = await initializeAgentMcpServers(agentDefinition, toolUseContext.options.mcpClients)

// 合并 Agent 专属 MCP 工具到工具池
const allTools = agentMcpTools.length > 0
  ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
  : resolvedTools
```

### 5.10 agentOptions 构建（`runAgent.ts:682-710`）

```typescript
// runAgent.ts:682
const agentOptions: ToolUseContext['options'] = {
  isNonInteractiveSession: useExactTools
    ? toolUseContext.options.isNonInteractiveSession  // ForkAgent：继承
    : isAsync ? true : (toolUseContext.options.isNonInteractiveSession ?? false),

  tools: allTools,         // SubAgent：resolveAgentTools 过滤后的工具
  commands: [],            // SubAgent 不使用 slash commands
  mainLoopModel: resolvedAgentModel,

  // ForkAgent：继承父 thinkingConfig（保证 API 请求前缀字节相同）
  // SubAgent：禁用 thinking（控制 token 成本）
  thinkingConfig: useExactTools
    ? toolUseContext.options.thinkingConfig
    : { type: 'disabled' as const },

  mcpClients: mergedMcpClients,
  agentDefinitions: toolUseContext.options.agentDefinitions,

  // ForkAgent 专用：将 querySource 写入 options，用于递归 fork 检测
  ...(useExactTools && { querySource }),
}
```

### 5.11 createSubagentContext 调用（`runAgent.ts:715-729`）

```typescript
// runAgent.ts:715
const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,
  agentId,
  agentType: agentDefinition.agentType,
  messages: initialMessages,
  readFileState: agentReadFileState,
  abortController: agentAbortController,
  getAppState: agentGetAppState,
  shareSetAppState: !isAsync,         // 同步 SubAgent 共享父的 setAppState
  shareSetResponseLength: true,        // 同步/异步都贡献响应长度指标
  criticalSystemReminder_EXPERIMENTAL: agentDefinition.criticalSystemReminder_EXPERIMENTAL,
  contentReplacementState,
})
```

### 5.12 query() 调用（`runAgent.ts:763-772`）

```typescript
// runAgent.ts:763
for await (const message of query({
  messages: initialMessages,
  systemPrompt: agentSystemPrompt,          // SubAgent：自己构建的系统提示
  userContext: resolvedUserContext,          // 可能省略 CLAUDE.md
  systemContext: resolvedSystemContext,      // 可能省略 gitStatus
  canUseTool,
  toolUseContext: agentToolUseContext,
  querySource,
  maxTurns: maxTurns ?? agentDefinition.maxTurns,
})) {
  // 转发 stream_event 的 TTFT 指标给父 Agent
  if (message.type === 'stream_event' && message.event.type === 'message_start') {
    toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
    continue
  }
  // 记录到 sidechain transcript
  if (isRecordableMessage(message)) {
    await recordSidechainTranscript([message], agentId, lastRecordedUuid)
    yield message
  }
}
```

---

## 6. 上下文隔离：createSubagentContext 的调用差异

**`src/utils/forkedAgent.ts:345`**（两者均调用此函数，但参数不同）

| 字段 | SubAgent（`isAsync=false`） | SubAgent（`isAsync=true`） | ForkAgent |
|------|---------------------------|--------------------------|-----------|
| `readFileState` | `createFileStateCacheWithSizeLimit()`（全新） | 同左 | `cloneFileStateCache()`（克隆父） |
| `abortController` | 共享父的（`toolUseContext.abortController`） | 新建（`new AbortController()`，不链接父） | 新建（不链接父） |
| `setAppState` | 共享父的（`shareSetAppState: true`） | no-op（`shareSetAppState: false`） | no-op |
| `setResponseLength` | 共享（`shareSetResponseLength: true`） | 共享（同左） | no-op |
| `getAppState` | 包装（权限模式覆盖） | 同左 + `shouldAvoidPermissionPrompts: true` | 同左 |
| `messages` | `[用户 prompt]` | 同左 | `[父历史..., directive]` |
| `thinkingConfig` | `{ type: 'disabled' }` | 同左 | 继承父的配置 |
| `querySource` | 不写入 options | 同左 | 写入 options（防递归检测） |

**关键差异：**

1. **文件状态缓存**：SubAgent 使用全新缓存（与父完全独立），ForkAgent 克隆父缓存（保证相同的 replacement 决策 → cache hit）
2. **AbortController**：同步 SubAgent 共享父的（用户 ESC 立即取消），异步 SubAgent 和 ForkAgent 都新建（后台独立运行）
3. **setAppState**：同步 SubAgent 共享父的（可更新 UI 状态），异步 SubAgent 和 ForkAgent 都是 no-op

---

## 7. 同步 vs 异步 SubAgent

SubAgent 可以同步（阻塞父 Agent）或异步（后台运行）执行，由以下条件决定（`AgentTool.tsx:567`）：

```typescript
// AgentTool.tsx:557-567
const forceAsync = isForkSubagentEnabled()  // Fork 实验：强制全部异步

const shouldRunAsync = (
  run_in_background === true ||       // 用户显式指定
  selectedAgent.background === true || // Agent 定义要求后台
  isCoordinator ||                     // 协调者模式
  forceAsync ||                        // Fork 实验开启
  assistantForceAsync ||               // KAIROS 模式
  (proactiveModule?.isProactiveActive() ?? false)
) && !isBackgroundTasksDisabled
```

### 同步 SubAgent 特点
- `isAsync = false`
- 父 Agent 阻塞等待 SubAgent 完成
- 共享父的 `setAppState`（可更新 UI）
- 共享父的 `abortController`（ESC 立即取消）
- 可以显示权限提示对话框（`shouldAvoidPermissionPrompts = false`）
- 不生成 `<task-notification>`，直接返回结果

### 异步 SubAgent 特点
- `isAsync = true`
- 父 Agent 立即返回，SubAgent 后台运行
- `setAppState` 是 no-op（不能更新父 UI）
- 新建 AbortController（不链接父，ESC 不取消）
- 不弹权限对话框（`shouldAvoidPermissionPrompts = true`）
- 完成后通过 `<task-notification>` XML 通知父 Agent
- 工具池受 `ASYNC_AGENT_ALLOWED_TOOLS` 限制

---

## 8. SubAgent 的生命周期与资源清理

**`runAgent.ts:831-874`** — `finally` 块确保资源清理：

```typescript
// runAgent.ts:831
} finally {
  await mcpCleanup()                    // 清理 Agent 专属 MCP 服务器
  if (agentDefinition.hooks) {
    clearSessionHooks(rootSetAppState, agentId)  // 清理 frontmatter hooks
  }
  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    cleanupAgentTracking(agentId)       // 清理 prompt cache 跟踪状态
  }
  agentToolUseContext.readFileState.clear()  // 释放文件状态缓存内存
  initialMessages.length = 0           // 释放消息数组内存
  unregisterPerfettoAgent(agentId)     // 释放 Perfetto 追踪注册
  clearAgentTranscriptSubdir(agentId)  // 清理 transcript 子目录映射
  rootSetAppState(prev => {            // 清理 todos 条目（防内存泄漏）
    const { [agentId]: _removed, ...todos } = prev.todos
    return { ...prev, todos }
  })
  killShellTasksForAgent(agentId, ...)  // 杀死 Agent 启动的后台 bash 任务
}
```

SubAgent 完成后的回调（仅内置 Agent）：

```typescript
// runAgent.ts:828
if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
  agentDefinition.callback()
}
```

---

## 9. SubAgent vs ForkAgent 全面对比

| 维度 | SubAgent | ForkAgent |
|------|---------|-----------|
| **触发方式** | `Agent(subagent_type="xxx")` 显式指定 | `Agent()` 省略 `subagent_type`（功能门控开） |
| **消息历史** | 从零开始，只有用户 prompt | 继承父 Agent 的完整对话历史 |
| **系统提示** | `getAgentSystemPrompt()`（Agent 自己的提示 + 环境信息） | 父 Agent 的渲染字节（字节精确，保证 cache hit） |
| **提示类型** | 完整背景说明（需解释任务背景） | 指令式（`<fork-boilerplate>` + directive） |
| **工具池** | `resolveAgentTools()`（过滤 + 黑/白名单） | `useExactTools=true`（父工具池直接引用） |
| **模型** | 可指定不同模型（`model` 字段） | 强制 `'inherit'`（继承父模型） |
| **thinking 配置** | 禁用（`{ type: 'disabled' }`） | 继承父配置（保证 cache hit） |
| **文件状态缓存** | 全新缓存（`createFileStateCacheWithSizeLimit`） | 克隆父缓存（保证相同 replacement 决策） |
| **CLAUDE.md** | 重新获取（Explore/Plan 可省略） | 通过继承的系统提示已包含 |
| **gitStatus** | 重新获取（Explore/Plan 省略） | 通过继承的系统提示已包含 |
| **执行方式** | 可同步（阻塞父）或异步（后台） | 强制异步（`forceAsync = true`） |
| **AbortController** | 同步：共享父；异步：新建不链接 | 新建不链接父（后台独立运行） |
| **setAppState** | 同步：共享父；异步：no-op | 始终 no-op |
| **权限提示** | 同步：可弹窗；异步：不弹窗 | `'bubble'` 模式：冒泡到父终端 |
| **allowedTools** | 可通过 `allowedTools` 参数限制工具权限 | 不支持 |
| **SubagentStart hooks** | 支持（执行用户配置的 hooks） | 不支持 |
| **frontmatter hooks** | 支持（Agent 定义中的 hooks） | 不支持 |
| **skills 预加载** | 支持（frontmatter `skills` 字段） | 不支持 |
| **Agent 专属 MCP** | 支持（frontmatter `mcpServers` 字段） | 不支持（继承父工具池） |
| **Prompt Cache** | 独立缓存，无法复用父缓存 | 字节相同 → 命中父缓存 |
| **querySource** | 不写入 options | 写入 options（防递归 fork 检测） |
| **递归防护** | `ALL_AGENT_DISALLOWED_TOOLS`（外部用户禁止 AgentTool） | 双重检测：querySource + `<fork-boilerplate>` 标签扫描 |
| **完成通知** | 同步：直接返回；异步：`<task-notification>` XML | 始终 `<task-notification>` XML |
| **资源清理** | 完整清理（MCP、hooks、缓存、todos、bash 任务） | 相同（通过同一 finally 块） |
| **transcript 记录** | `recordSidechainTranscript()`（每条消息） | 相同 |
| **maxTurns** | `agentDefinition.maxTurns`（可配置） | 200（硬编码） |

---

## 10. 关键文件索引

| 文件 | 关键行号 | 内容 |
|------|---------|------|
| `src/tools/AgentTool/runAgent.ts` | L248 `runAgent()` | SubAgent 执行核心函数 |
| | L368 | 消息数组构建（SubAgent vs ForkAgent 分叉点） |
| | L375 | 文件状态缓存选择（新建 vs 克隆） |
| | L380 | userContext/systemContext 获取 |
| | L390 | omitClaudeMd 处理 |
| | L404 | omitGitStatus 处理（Explore/Plan） |
| | L415 | 权限模式覆盖逻辑 |
| | L500 | 工具池选择（`useExactTools` 分叉） |
| | L508 | `getAgentSystemPrompt()` 调用 |
| | L524 | AbortController 选择（同步/异步/fork） |
| | L530 | SubagentStart hooks 执行 |
| | L572 | frontmatter hooks 注册 |
| | L592 | skills 预加载 |
| | L663 | Agent 专属 MCP 服务器初始化 |
| | L682 | agentOptions 构建 |
| | L715 | `createSubagentContext()` 调用 |
| | L763 | `query()` 调用 |
| | L831 | finally 资源清理 |
| | L881 | `filterIncompleteToolCalls()` |
| | L921 | `getAgentSystemPrompt()` |
| `src/tools/AgentTool/agentToolUtils.ts` | L70 `filterToolsForAgent()` | 基础工具过滤 |
| | L122 `resolveAgentTools()` | 工具池解析（白/黑名单） |
| | L508 `runAsyncAgentLifecycle()` | 异步生命周期管理 |
| `src/tools/AgentTool/loadAgentsDir.ts` | L106 `BaseAgentDefinition` | Agent 基础配置类型 |
| | L136 `BuiltInAgentDefinition` | 内置 Agent 类型 |
| | L146 `CustomAgentDefinition` | 自定义 Agent 类型 |
| `src/constants/tools.ts` | L36 `ALL_AGENT_DISALLOWED_TOOLS` | 所有 SubAgent 禁用工具 |
| | L48 `CUSTOM_AGENT_DISALLOWED_TOOLS` | 自定义 Agent 禁用工具 |
| | L55 `ASYNC_AGENT_ALLOWED_TOOLS` | 异步 Agent 允许工具白名单 |
| `src/constants/prompts.ts` | L792 `DEFAULT_AGENT_PROMPT` | SubAgent 默认提示 |
| | L794 `enhanceSystemPromptWithEnvDetails()` | 追加环境信息到 Agent 提示 |
| `src/tools/AgentTool/forkSubagent.ts` | L32 `isForkSubagentEnabled()` | ForkAgent 功能门控 |
| | L60 `FORK_AGENT` | ForkAgent 合成定义 |
| | L107 `buildForkedMessages()` | ForkAgent 消息数组构建 |
| | L171 `buildChildMessage()` | ForkAgent directive 模板 |
| `src/utils/forkedAgent.ts` | L345 `createSubagentContext()` | 上下文隔离核心（SubAgent/ForkAgent 共用） |
| `src/tools/AgentTool/AgentTool.tsx` | L322 | SubAgent/ForkAgent 路由分叉 |
| | L495 | 系统提示构建分叉 |
| | L557 | `forceAsync` 逻辑 |
| | L603 | `runAgentParams` 组装 |
| | L686 | 异步启动 `runAsyncAgentLifecycle()` |
