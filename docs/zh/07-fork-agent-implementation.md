# ForkAgent 实现原理与上下文隔离机制

> 基于 Claude Code v2.1.88 源码的详尽技术分析。

---

## 目录

1. [什么是 ForkAgent](#1-什么是-forkagent)
2. [功能门控与启用条件](#2-功能门控与启用条件)
3. [触发路径：如何决定走 Fork](#3-触发路径如何决定走-fork)
4. [上下文继承：消息数组的构建](#4-上下文继承消息数组的构建)
5. [上下文隔离：子 Agent 的 ToolUseContext](#5-上下文隔离子-agent-的-toolUseContext)
6. [Prompt Cache 共享策略](#6-prompt-cache-共享策略)
7. [防递归机制](#7-防递归机制)
8. [强制异步与输出文件机制](#8-强制异步与输出文件机制)
9. [完成通知：XML 结构与注入](#9-完成通知xml-结构与注入)
10. [Worktree 隔离（可选）](#10-worktree-隔离可选)
11. [完整生命周期图](#11-完整生命周期图)
12. [Fork vs 普通 Subagent 对比](#12-fork-vs-普通-subagent-对比)
13. [关键文件索引](#13-关键文件索引)

---

## 1. 什么是 ForkAgent

ForkAgent（fork subagent）是 Claude Code 中一种特殊的子 Agent 执行模式，与普通 subagent 的根本区别在于：

| | Fork Agent | 普通 Subagent |
|--|--|--|
| 消息历史 | **继承父 Agent 的完整对话历史** | 从零开始，无历史 |
| 系统提示 | 复用父 Agent 的渲染字节 | 子 Agent 自己构建 |
| Prompt | 简短的"指令"（directive） | 需要完整背景说明 |
| 工具输出 | 写入 `outputFile`，**不进父上下文** | 所有输出可见 |

设计目标：当中间工具输出（大量 Read/Bash/Grep 调用的原始结果）不需要保留在父 Agent 上下文时，用 Fork 来执行，从而保持父 Agent 的上下文干净。

---

## 2. 功能门控与启用条件

**`src/tools/AgentTool/forkSubagent.ts:32`**

```typescript
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {      // Bun 编译时功能门控
    if (isCoordinatorMode()) return false   // 与协调者模式互斥
    if (getIsNonInteractiveSession()) return false  // 非交互式会话不启用
    return true
  }
  return false
}
```

三个条件全部满足才启用：
1. `feature('FORK_SUBAGENT')` 为 true（Bun 编译时常量，外部构建中为 false）
2. 不在协调者模式（协调者有自己的编排模型）
3. 是交互式会话（非交互式 = SDK 调用，fork 的 `<task-notification>` 回调机制不适用）

---

## 3. 触发路径：如何决定走 Fork

**`src/tools/AgentTool/AgentTool.tsx:322`**

```typescript
// 路由逻辑：
// - subagent_type 有值：使用指定类型（显式优先）
// - subagent_type 省略 + 功能门控开：走 fork 路径（effectiveType = undefined）
// - subagent_type 省略 + 功能门控关：默认 general-purpose
const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType)
const isForkPath = effectiveType === undefined

let selectedAgent: AgentDefinition
if (isForkPath) {
  // 递归防护（双重检测）
  if (
    toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}` ||
    isInForkChild(toolUseContext.messages)
  ) {
    throw new Error('Fork is not available inside a forked worker. Complete your task directly using your tools.')
  }
  selectedAgent = FORK_AGENT  // 使用合成的 FORK_AGENT 定义
} else {
  // 普通路径：在已注册的 agent 列表中查找
  selectedAgent = agents.find(agent => agent.agentType === effectiveType)
}
```

**`FORK_AGENT` 合成定义（`forkSubagent.ts:60`）：**

```typescript
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,  // 'fork'
  tools: ['*'],                    // 接收父 Agent 的全部工具（useExactTools=true）
  maxTurns: 200,
  model: 'inherit',                // 继承父 Agent 的模型（缓存复用关键）
  permissionMode: 'bubble',        // 权限提示冒泡到父终端
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',       // 不使用自己的系统提示，由父传入
} satisfies BuiltInAgentDefinition
```

---

## 4. 上下文继承：消息数组的构建

Fork 与普通 Agent 最核心的区别在于传给 API 的消息数组。

### 4.1 系统提示的处理

**`AgentTool.tsx:495`**

```typescript
if (isForkPath) {
  if (toolUseContext.renderedSystemPrompt) {
    // 优先：直接使用父 Agent 已渲染的字节
    forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
  } else {
    // 回退：重新计算（可能因 GrowthBook 状态变化而与父字节不同）
    forkParentSystemPrompt = buildEffectiveSystemPrompt({ ... })
  }
  promptMessages = buildForkedMessages(prompt, assistantMessage)
} else {
  // 普通路径：子 Agent 构建自己的系统提示
  enhancedSystemPrompt = await enhanceSystemPromptWithEnvDetails([agentPrompt], ...)
  promptMessages = [createUserMessage({ content: prompt })]
}
```

**为什么传字节而非重新计算？**

注释说明（`forkSubagent.ts:56`）：
> Reconstructing by re-calling getSystemPrompt() can diverge (GrowthBook cold→warm) and bust the prompt cache; threading the rendered bytes is byte-exact.

GrowthBook 功能标志在父 Agent turn 开始到 fork 启动之间可能发生 cold→warm 的状态翻转，导致重新计算的系统提示字节与父不同，破坏 prompt cache。

### 4.2 消息数组的构建

**`forkSubagent.ts:107` `buildForkedMessages()`**

```typescript
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,  // 父 Agent 当前轮的完整 assistant 消息
): MessageType[] {

  // 1. 克隆父 Agent 的完整 assistant 消息
  //    保留所有内容块：thinking、text、以及所有 tool_use block
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],  // 浅克隆，不修改原数据
    },
  }

  // 2. 收集所有 tool_use block（包括其他并行 fork 的调用）
  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

  // 3. 为每个 tool_use 构建占位符 tool_result
  //    关键：所有 fork 使用完全相同的占位符文本！
  const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [{ type: 'text' as const, text: FORK_PLACEHOLDER_RESULT }],
  }))

  // 4. 构建单条 user 消息：所有占位符 tool_result + 当前 fork 的 directive
  //    只有最后的 directive 文本块在各 fork 之间不同
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      { type: 'text' as const, text: buildChildMessage(directive) },
    ],
  })

  // 最终结构：[...父历史, assistant(所有tool_use), user(占位符results + directive)]
  return [fullAssistantMessage, toolResultMessage]
}
```

**传给 API 的完整消息数组结构：**

```
[父 turn 1: user message]
[父 turn 1: assistant message]
[父 turn 2: user message]
[父 turn 2: assistant message]
...
[父当前轮: assistant message]  ← 包含所有 tool_use block（含其他并行 fork 的调用）
[user message]                 ← tool_result(fork1="Fork started..."),
                                  tool_result(fork2="Fork started..."),
                                  text("<fork-boilerplate>...Your directive: <任务>")
```

---

## 5. 上下文隔离：子 Agent 的 ToolUseContext

`ToolUseContext` 是贯穿整个 Agent 执行的核心上下文对象，包含工具列表、权限状态、文件缓存、React 状态更新回调等。Fork 子 Agent 的隔离通过 `createSubagentContext()` 实现。

**`src/utils/forkedAgent.ts:345` `createSubagentContext()`**

```typescript
export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext {

  // ── AbortController：新建子控制器，链接父控制器 ──────────────────────────
  // 父取消会传播到子；子完成不影响父
  const abortController =
    overrides?.abortController ??
    (overrides?.shareAbortController
      ? parentContext.abortController
      : createChildAbortController(parentContext.abortController))

  // ── getAppState：包装后台任务不弹权限对话框 ──────────────────────────────
  const getAppState: ToolUseContext['getAppState'] = overrides?.getAppState
    ? overrides.getAppState
    : overrides?.shareAbortController
      ? parentContext.getAppState
      : () => {
          const state = parentContext.getAppState()
          // 后台任务设置此标志，避免弹出权限确认对话框
          if (state.toolPermissionContext.shouldAvoidPermissionPrompts) return state
          return {
            ...state,
            toolPermissionContext: {
              ...state.toolPermissionContext,
              shouldAvoidPermissionPrompts: true,  // ← 关键：不弹窗
            },
          }
        }

  return {
    // ── 克隆（独立副本）────────────────────────────────────────────────────
    readFileState: cloneFileStateCache(
      overrides?.readFileState ?? parentContext.readFileState,
    ),
    // 文件读取缓存独立克隆：
    // - 子 Agent 读文件不影响父 Agent 的缓存
    // - 克隆而非新建：fork 继承父的历史消息，其中包含父的 tool_use_id，
    //   克隆状态能做出相同的 replacement 决策 → 相同的 wire prefix → cache hit

    nestedMemoryAttachmentTriggers: new Set<string>(),  // 重置
    loadedNestedMemoryPaths: new Set<string>(),          // 重置
    dynamicSkillDirTriggers: new Set<string>(),          // 重置
    discoveredSkillNames: new Set<string>(),             // 重置
    toolDecisions: undefined,

    contentReplacementState:
      overrides?.contentReplacementState ??
      (parentContext.contentReplacementState
        ? cloneContentReplacementState(parentContext.contentReplacementState)
        : undefined),

    // ── AbortController ────────────────────────────────────────────────────
    abortController,

    // ── AppState 访问 ──────────────────────────────────────────────────────
    getAppState,

    // setAppState：默认 no-op，子 Agent 无法修改父 Agent 的 React 状态
    setAppState: overrides?.shareSetAppState ? parentContext.setAppState : () => {},

    // setAppStateForTasks：例外！必须到达 root store，否则后台 bash 任务
    // 无法注册，成为 PPID=1 的僵尸进程
    setAppStateForTasks:
      parentContext.setAppStateForTasks ?? parentContext.setAppState,

    // 异步子 Agent 有自己的 denial tracking（因为 setAppState 是 no-op）
    localDenialTracking: overrides?.shareSetAppState
      ? parentContext.localDenialTracking
      : createDenialTrackingState(),

    // ── 其他 mutation 回调：全部 no-op ────────────────────────────────────
    setInProgressToolUseIDs: () => {},
    setResponseLength: overrides?.shareSetResponseLength
      ? parentContext.setResponseLength
      : () => {},
    updateFileHistoryState: () => {},

    // UI 回调：undefined（子 Agent 不能控制父 UI）
    addNotification: undefined,
    setToolJSX: undefined,
    setStreamMode: undefined,
    setSDKStatus: undefined,
    openMessageSelector: undefined,

    // ── 共享（不可变数据）──────────────────────────────────────────────────
    options: overrides?.options ?? parentContext.options,
    messages: overrides?.messages ?? parentContext.messages,  // 只读引用

    // ── 新建 ID ────────────────────────────────────────────────────────────
    agentId: overrides?.agentId ?? createAgentId(),
    queryTracking: {
      chainId: randomUUID(),
      depth: (parentContext.queryTracking?.depth ?? -1) + 1,  // 深度 +1
    },
  }
}
```

**隔离维度总结：**

| 字段 | 策略 | 原因 |
|------|------|------|
| `readFileState` | 克隆 | 子 Agent 的文件读取缓存独立，不影响父 |
| `setAppState` | no-op | 子 Agent 无法修改父 Agent 的 React 状态 |
| `setAppStateForTasks` | 共享 root | 后台 bash 任务需要注册到 root store |
| `setInProgressToolUseIDs` | no-op | 子 Agent 不更新父 UI 的进行中状态 |
| `setResponseLength` | no-op | 子 Agent 不计入父的响应长度 |
| UI 回调 | undefined | 子 Agent 不操控父 UI |
| `abortController` | 新建子控制器 | 父取消传播到子；子不影响父 |
| `shouldAvoidPermissionPrompts` | true | 后台任务不弹权限对话框 |
| `nestedMemoryAttachmentTriggers` | 重置 | 不继承父的运行时发现状态 |
| `agentId` | 新建 | 独立身份，通知路由唯一 |
| `queryTracking.depth` | +1 | 深度追踪，防止无限递归 |

---

## 6. Prompt Cache 共享策略

Fork 的核心价值之一是最大化 prompt cache 命中率。Anthropic API 的 cache key 由以下部分组成：系统提示 + 工具列表 + 模型 + 消息前缀 + thinking 配置。

### 6.1 系统提示字节相同

传父 Agent 的 `renderedSystemPrompt`（已渲染字节），而非重新调用 `getSystemPrompt()`。

### 6.2 工具数组字节相同

**`runAgent.ts:500`**

```typescript
const resolvedTools = useExactTools
  ? availableTools          // fork 路径：直接使用父 Agent 的工具数组引用
  : resolveAgentTools(...)  // 普通路径：重新过滤
```

`useExactTools = true` 时，fork 子 Agent 使用父 Agent 工具数组的同一引用，序列化后字节完全相同。

**为什么不用 `workerTools`？**

注释（`AgentTool.tsx:611`）解释：
> workerTools is rebuilt under permissionMode 'bubble' which differs from the parent's mode, so its tool-def serialization diverges and breaks cache at the first differing tool.

`bubble` 权限模式会改变工具描述的序列化结果，导致 cache miss。

### 6.3 模型相同

`FORK_AGENT.model = 'inherit'`，继承父 Agent 的模型。不同模型无法共享 cache。

### 6.4 Thinking 配置相同

**`runAgent.ts:682`**

```typescript
thinkingConfig: useExactTools
  ? toolUseContext.options.thinkingConfig  // fork：继承父的 thinking 配置
  : { type: 'disabled' as const },          // 普通子 Agent：禁用 thinking
```

### 6.5 tool_result 占位符文本相同

所有并行 fork 的 `tool_result` 使用完全相同的文本 `'Fork started — processing in background'`。

```
并行 fork 1 的消息前缀：
  [...父历史, assistant(tool_use_A, tool_use_B, tool_use_C),
   user(result_A="Fork started...", result_B="Fork started...", result_C="Fork started...",
        text="<fork-boilerplate>...directive: 研究模块A")]

并行 fork 2 的消息前缀：
  [...父历史, assistant(tool_use_A, tool_use_B, tool_use_C),
   user(result_A="Fork started...", result_B="Fork started...", result_C="Fork started...",
        text="<fork-boilerplate>...directive: 研究模块B")]
```

两者只有最后的 `directive` 文本不同，前缀字节完全相同，命中同一 cache entry。

---

## 7. 防递归机制

Fork 子 Agent 的工具池中保留了 `Agent` 工具（为了工具定义字节相同），因此需要在运行时阻止递归 fork。

### 7.1 双重检测（`AgentTool.tsx:332`）

```typescript
if (
  // 检测 1：querySource（抗 autocompact，因为 querySource 在 options 中，不在消息里）
  toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}` ||
  // 检测 2：消息历史扫描（兜底，防止 querySource 未被正确传递的情况）
  isInForkChild(toolUseContext.messages)
) {
  throw new Error('Fork is not available inside a forked worker...')
}
```

**为什么需要两个检测？**

注释（`AgentTool.tsx:326`）：
> Primary check is querySource (compaction-resistant — set on context.options at spawn time, survives autocompact's message rewrite). Message-scan fallback catches any path where querySource wasn't threaded.

autocompact 会重写消息历史（压缩旧消息），可能删除 `<fork-boilerplate>` 标签，导致消息扫描失效。`querySource` 存储在 `options` 中，不受消息重写影响。

### 7.2 querySource 的设置

**`runAgent.ts:688`**

```typescript
// Fork 子 Agent 的 options 中写入 querySource，供递归检测使用
...(useExactTools && { querySource }),
// 其中 querySource = 'agent:builtin:fork'
```

### 7.3 消息历史扫描（`forkSubagent.ts:78`）

```typescript
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),  // 检测 '<fork-boilerplate>'
    )
  })
}
```

### 7.4 Fork 子 Agent 收到的 directive（`forkSubagent.ts:171`）

`buildChildMessage()` 生成的内容同时充当行为指令和检测标记：

```typescript
export function buildChildMessage(directive: string): string {
  return `<fork-boilerplate>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT — that's for the parent.
   You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope.
8. Keep your report under 500 words unless the directive specifies otherwise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</fork-boilerplate>

Your directive: ${directive}`
}
```

`<fork-boilerplate>` 标签既是给模型的行为指令（规则 1-10），也是 `isInForkChild()` 检测的标记。

---

## 8. 强制异步与输出文件机制

### 8.1 强制异步

**`AgentTool.tsx:557`**

```typescript
// Fork 实验：强制所有 spawn 都异步执行
// 目的：统一使用 <task-notification> 交互模型
const forceAsync = isForkSubagentEnabled()

const shouldRunAsync = (
  run_in_background === true ||
  selectedAgent.background === true ||
  isCoordinator ||
  forceAsync ||           // ← fork 实验强制所有 spawn 异步
  assistantForceAsync ||
  (proactiveModule?.isProactiveActive() ?? false)
) && !isBackgroundTasksDisabled
```

所有 fork spawn 都是后台任务，不仅仅是 fork 自身——启用 fork 实验后，所有 Agent 调用都变为异步。

### 8.2 异步启动（`AgentTool.tsx:686`）

```typescript
if (shouldRunAsync) {
  const asyncAgentId = earlyAgentId
  const agentBackgroundTask = registerAsyncAgent({
    agentId: asyncAgentId,
    description,
    prompt,
    selectedAgent,
    setAppState: rootSetAppState,
    // 不链接父的 AbortController：后台 Agent 应在用户按 ESC 后继续运行
    toolUseId: toolUseContext.toolUseId
  })

  // void：立即返回，不等待
  void runWithAgentContext(asyncAgentContext, () =>
    wrapWithCwd(() => runAsyncAgentLifecycle({
      taskId: agentBackgroundTask.agentId,
      abortController: agentBackgroundTask.abortController!,
      makeStream: onCacheSafeParams => runAgent({ ...runAgentParams, ... }),
      ...
    }))
  )

  // 父 Agent 立即收到轻量结果
  return {
    data: {
      isAsync: true as const,
      status: 'async_launched' as const,
      agentId: agentBackgroundTask.agentId,
      description,
      prompt,
      outputFile: getTaskOutputPath(agentBackgroundTask.agentId),  // fork 的输出文件路径
      canReadOutputFile  // 父 Agent 是否有能力读取该文件
    }
  }
}
```

**父 Agent 的上下文只增加这一条轻量结果。Fork 子 Agent 的所有工具调用（Read、Bash、Edit...）全部写入 `outputFile`，不进入父上下文。**

### 8.3 输出文件路径

**`src/utils/task/diskOutput.ts:72`**

```typescript
export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`)
}
```

路径格式：`~/.claude/tasks/<taskId>.output`

---

## 9. 完成通知：XML 结构与注入

### 9.1 异步生命周期（`agentToolUtils.ts:508`）

```typescript
export async function runAsyncAgentLifecycle({ taskId, makeStream, ... }) {
  const agentMessages: MessageType[] = []
  try {
    // 1. 运行 query 循环，收集所有消息
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
      updateAsyncAgentProgress(taskId, getProgressUpdate(tracker), rootSetAppState)
    }

    // 2. 聚合结果
    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)

    // 3. 先标记任务完成（让 TaskOutput(block=true) 立即解除阻塞）
    completeAsyncAgent(agentResult, rootSetAppState)

    // 4. 提取最终文本
    let finalMessage = extractTextContent(agentResult.content, '\n')

    // 5. 清理 worktree（如有）
    const worktreeResult = await getWorktreeResult()

    // 6. 发送通知
    enqueueAgentNotification({
      taskId, description, status: 'completed',
      finalMessage, usage: {...}, ...worktreeResult
    })
  } catch (error) {
    // 错误/中止时也发送通知
    enqueueAgentNotification({ taskId, description, status: 'failed'/'killed', ... })
  }
}
```

### 9.2 通知构建（`LocalAgentTask.tsx:197`）

```typescript
export function enqueueAgentNotification({ taskId, description, status, finalMessage, usage, worktreePath, ... }) {
  // 原子检查防重复通知
  let shouldEnqueue = false
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.notified) return task
    shouldEnqueue = true
    return { ...task, notified: true }
  })
  if (!shouldEnqueue) return

  // 中止任何活跃的 speculation（后台任务状态变化，预测结果可能过时）
  abortSpeculation(setAppState)

  const outputPath = getTaskOutputPath(taskId)

  // 构建 XML 通知消息
  const message = `<task-notification>
<task-id>${taskId}</task-id>
<tool-use-id>${toolUseId}</tool-use-id>
<output-file>${outputPath}</output-file>
<status>${status}</status>
<summary>${summary}</summary>
<result>${finalMessage}</result>
<usage>
  <total_tokens>${usage.totalTokens}</total_tokens>
  <tool_uses>${usage.toolUses}</tool_uses>
  <duration_ms>${usage.durationMs}</duration_ms>
</usage>
<worktree>
  <worktreePath>${worktreePath}</worktreePath>
  <worktreeBranch>${worktreeBranch}</worktreeBranch>
</worktree>
</task-notification>`

  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}
```

### 9.3 XML 标签常量（`src/constants/xml.ts`）

```typescript
export const TASK_NOTIFICATION_TAG = 'task-notification'  // L28
export const TASK_ID_TAG = 'task-id'                       // L29
export const TOOL_USE_ID_TAG = 'tool-use-id'               // L30
export const OUTPUT_FILE_TAG = 'output-file'               // L32
export const STATUS_TAG = 'status'                         // L33
export const SUMMARY_TAG = 'summary'                       // L34
export const WORKTREE_TAG = 'worktree'                     // L36
export const WORKTREE_PATH_TAG = 'worktreePath'            // L37
export const WORKTREE_BRANCH_TAG = 'worktreeBranch'        // L38
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate'     // L63
export const FORK_DIRECTIVE_PREFIX = 'Your directive: '    // L66
```

通知以 **user-role 消息**注入父 Agent 的下一轮对话。父 Agent 看到的是 fork 的最终报告（`<result>` 字段），而不是过程中的工具调用输出。

---

## 10. Worktree 隔离（可选）

当用户传入 `isolation: 'worktree'` 时，fork 子 Agent 在独立的 git worktree 中运行。

### 10.1 Worktree 创建（`AgentTool.tsx:590`）

```typescript
if (effectiveIsolation === 'worktree') {
  const slug = `agent-${earlyAgentId.slice(0, 8)}`
  worktreeInfo = await createAgentWorktree(slug)
  // 创建 .claude/worktrees/<slug>/ 目录，同一仓库的独立工作副本
}
```

### 10.2 路径转换说明（`forkSubagent.ts:205`）

```typescript
export function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}.
You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative
file structure, separate working copy. Paths in the inherited context refer to the parent's working
directory; translate them to your worktree root. Re-read files before editing if the parent may have
modified them since they appear in the context. Your changes stay in this worktree and will not affect
the parent's files.`
}
```

**`AgentTool.tsx:598`**

```typescript
// fork + worktree：追加路径转换说明到 promptMessages
if (isForkPath && worktreeInfo) {
  promptMessages.push(createUserMessage({
    content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath)
  }))
}
```

### 10.3 Worktree 清理

任务完成后，检测是否有文件变更：
- 无变更 → 自动删除 worktree
- 有变更 → 保留，并在通知中包含 `<worktree>` 信息

---

## 11. 完整生命周期图

```
父 Agent 当前轮
│
├─ 调用 Agent(prompt="研究X", subagent_type=undefined)
│   AgentTool.tsx:322
│
├─ isForkSubagentEnabled() = true
│   effectiveType = undefined → isForkPath = true
│
├─ 递归防护检测（双重）
│   AgentTool.tsx:332
│
├─ selectedAgent = FORK_AGENT
│
├─ forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
│   AgentTool.tsx:496  （父的渲染字节，字节精确）
│
├─ promptMessages = buildForkedMessages(prompt, assistantMessage)
│   forkSubagent.ts:107
│   → [fullAssistantMsg, userMsg(placeholders + directive)]
│
├─ forceAsync = true（强制异步）
│   AgentTool.tsx:557
│
├─ worktreeInfo = createAgentWorktree()（如有 isolation='worktree'）
│
├─ registerAsyncAgent({agentId, description, prompt, ...})
│   → 创建 LocalAgentTaskState，status: 'running'
│   AgentTool.tsx:688
│
├─ void runWithAgentContext(asyncAgentContext, () =>
│       runAsyncAgentLifecycle({...}))  ← 立即返回，不等待
│   AgentTool.tsx:733
│
└─ 返回父 Agent:
   { isAsync: true, status: 'async_launched',
     outputFile: '~/.claude/tasks/<agentId>.output' }
   AgentTool.tsx:754
   ↑ 父上下文只增加这一条轻量结果

         ↓ 后台异步执行（与父 Agent 并发）

         runAsyncAgentLifecycle()
         agentToolUtils.ts:508
         │
         ├─ for await (message of runAgent({
         │     agentDefinition: FORK_AGENT,
         │     promptMessages,              // 含父历史 + directive
         │     override: { systemPrompt: forkParentSystemPrompt },  // 父的字节
         │     availableTools: parentTools, // useExactTools=true
         │     forkContextMessages: parentMessages,
         │     querySource: 'agent:builtin:fork',
         │     ...
         │   })) {
         │     agentMessages.push(message)
         │     recordSidechainTranscript([message], agentId)  // 写 outputFile
         │     updateAsyncAgentProgress(...)
         │   }
         │   runAgent.ts（使用 createSubagentContext 的隔离上下文）
         │
         ├─ agentResult = finalizeAgentTool(agentMessages, taskId, metadata)
         │
         ├─ completeAsyncAgent(agentResult, rootSetAppState)
         │   → task.status = 'completed'（立即解除 TaskOutput 阻塞）
         │
         ├─ worktreeResult = await cleanupWorktreeIfNeeded()
         │
         └─ enqueueAgentNotification({taskId, status:'completed', finalMessage, ...})
             LocalAgentTask.tsx:197
             → 构建 XML，加入消息队列

         ↓ 父 Agent 下一轮（用户输入或自动重入）

         消息循环注入 user-role 消息：
         <task-notification>
           <task-id>xxx</task-id>
           <output-file>~/.claude/tasks/xxx.output</output-file>
           <status>completed</status>
           <summary>Agent "研究X" completed</summary>
           <result>
             Scope: 研究模块X的架构
             Result: 发现...
             Key files: src/foo/bar.ts:42
           </result>
           <usage>...</usage>
         </task-notification>

         ↑ 父 Agent 只看到 fork 的最终报告，
           不看 fork 过程中的任何工具调用输出
```

---

## 12. Fork vs 普通 Subagent 对比

| 维度 | Fork Agent | 普通 Subagent |
|------|-----------|--------------|
| **触发方式** | 省略 `subagent_type`（功能门控开） | 指定 `subagent_type` |
| **消息历史** | 继承父的完整历史 | 从零开始 |
| **系统提示** | 父的渲染字节（字节精确） | 子自己的 `getSystemPrompt()` |
| **工具数组** | `useExactTools=true`（父的引用） | `resolveAgentTools()` 重新过滤 |
| **模型** | `inherit`（与父相同） | 可指定不同模型 |
| **Thinking 配置** | 继承父的配置 | 禁用（`{ type: 'disabled' }`） |
| **Prompt 类型** | 指令式（不需解释背景） | 完整说明（需要背景上下文） |
| **执行方式** | 强制异步（所有 spawn 都异步） | 可选同步/异步 |
| **工具输出可见性** | 写 `outputFile`，不进父上下文 | 全部输出可见 |
| **Cache 策略** | 字节相同 → 命中父缓存 | 独立缓存，无法复用父缓存 |
| **权限模式** | `bubble`（冒泡到父终端） | `acceptEdits` 或自定义 |
| **AbortController** | 新建，不链接父（后台独立运行） | 同步共享父；异步新建 |
| **递归 Fork** | 双重检测阻止 | 可嵌套 spawn |
| **Worktree 支持** | 支持（含路径转换说明） | 支持 |
| **完成回调** | `<task-notification>` XML 注入 | 同步直接返回 / 异步通知 |

---

## 13. 关键文件索引

| 文件 | 关键行号 | 内容 |
|------|---------|------|
| `src/tools/AgentTool/forkSubagent.ts` | L32 `isForkSubagentEnabled()` | 功能门控 |
| | L60 `FORK_AGENT` | 合成 Agent 定义 |
| | L78 `isInForkChild()` | 递归检测（消息扫描） |
| | L107 `buildForkedMessages()` | 消息数组构建，占位符策略 |
| | L171 `buildChildMessage()` | Fork 子 Agent 的 directive 模板 |
| | L205 `buildWorktreeNotice()` | Worktree 路径转换说明 |
| `src/tools/AgentTool/AgentTool.tsx` | L322 | Fork 路由逻辑 |
| | L332 | 递归防护（双重检测） |
| | L495 | 系统提示分支（传字节 vs 重新计算） |
| | L512 | `buildForkedMessages()` 调用 |
| | L557 | `forceAsync = isForkSubagentEnabled()` |
| | L622 | `useExactTools: true` |
| | L627 | `availableTools: parentTools`（工具数组共享） |
| | L630 | `forkContextMessages: parentMessages` |
| | L686 | 异步启动，`void runAsyncAgentLifecycle()` |
| | L754 | 返回 `async_launched` 结果 |
| `src/utils/forkedAgent.ts` | L57 `CacheSafeParams` 类型 | Cache 关键参数定义 |
| | L260 `SubagentContextOverrides` 类型 | 覆盖选项定义 |
| | L345 `createSubagentContext()` | **隔离机制核心** |
| | L489 `runForkedAgent()` | Fork 查询循环封装 |
| `src/tools/AgentTool/runAgent.ts` | L370 | `forkContextMessages` 处理 |
| | L500 | `useExactTools` → 工具数组选择 |
| | L668 | `isNonInteractiveSession` 继承 |
| | L682 | `thinkingConfig` 继承 |
| | L688 | `querySource` 写入 options（递归防护） |
| | L700 | `createSubagentContext()` 调用 |
| `src/tools/AgentTool/agentToolUtils.ts` | L508 `runAsyncAgentLifecycle()` | 异步生命周期，通知发送 |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | L197 `enqueueAgentNotification()` | 通知 XML 构建与入队 |
| `src/constants/xml.ts` | L28–38, L63–66 | XML 标签常量 |
| `src/utils/task/diskOutput.ts` | L72 `getTaskOutputPath()` | 输出文件路径 |
