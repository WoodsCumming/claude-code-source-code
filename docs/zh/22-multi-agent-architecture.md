# Claude Code 多 Agent 交互架构详解

> 版本：Claude Code v2.1.88 | 文档日期：2026-06-04

---

## 目录

1. [整体架构概述](#1-整体架构概述)
2. [Agent 类型分类](#2-agent-类型分类)
3. [核心数据结构](#3-核心数据结构)
4. [通信协议](#4-通信协议)
5. [AgentTool 执行流程](#5-agenttool-执行流程)
6. [runAgent 核心函数](#6-runagent-核心函数)
7. [工具权限系统](#7-工具权限系统)
8. [隔离与上下文管理](#8-隔离与上下文管理)
9. [任务状态机](#9-任务状态机)
10. [生命周期与资源清理](#10-生命周期与资源清理)
11. [In-Process Teammate 体系](#11-in-process-teammate-体系)
12. [完整调用链路图](#12-完整调用链路图)

---

## 1. 整体架构概述

Claude Code 的多 Agent 系统允许主 Agent（父 Agent）派生子 Agent，后者在独立上下文中执行任务。整个系统围绕 `AgentTool`（`src/tools/AgentTool/AgentTool.tsx`）展开，执行核心是 `runAgent()` 异步生成器（`src/tools/AgentTool/runAgent.ts`）。

### 1.1 架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│                     主 REPL (React Ink TUI)                     │
│         screens/REPL.tsx — 交互终端循环，管理全局 AppState         │
└──────────────────────────────┬──────────────────────────────────┘
                               │ 用户 prompt
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Query Loop (services/api/claude.ts)          │
│    getSystemContext() → getTools() → streaming API call         │
│    工具结果作为下一轮 user message 返回，循环直到 stop_reason=end_turn │
└──────────────────────────────┬──────────────────────────────────┘
                               │ 工具调用：Agent(...)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     AgentTool.call()                            │
│   AgentTool.tsx — 路由决策：SubAgent / ForkAgent / Teammate      │
└──────┬───────────────────────┼──────────────────────────────────┘
       │                       │                    │
       ▼                       ▼                    ▼
  SubAgent              ForkAgent            InProcess Teammate
  runAgent()            runAgent()           spawnInProcessTeammate()
  独立系统提示            继承父系统提示         AsyncLocalStorage 隔离
  独立工具池              复用父工具池            独立会话循环
  同步或异步              强制异步              独立 AbortController
```

### 1.2 三大 Agent 模式对比

| 维度 | SubAgent | ForkAgent | InProcess Teammate |
|------|----------|-----------|-------------------|
| **触发方式** | `Agent(subagent_type="xxx")` | `Agent()` 省略类型（门控开） | `Agent(name="x", team_name="y")` |
| **消息历史** | 空（只有 prompt） | 继承父 Agent 完整历史 | 独立对话历史 |
| **系统提示** | `getAgentSystemPrompt()` 新建 | 父 Agent 渲染字节（cache hit） | `getAgentSystemPrompt()` 新建 |
| **工具池** | `resolveAgentTools()` 过滤 | `useExactTools=true`，复用父工具数组 | `resolveAgentTools()` 过滤 |
| **模型** | 可指定不同模型 | 强制 `'inherit'`（保证 cache hit） | 可指定不同模型 |
| **执行方式** | 同步或异步 | 强制异步 | 同步驱动（独立循环） |
| **Prompt Cache** | 独立缓存 | 字节相同 → 命中父缓存 | 独立缓存 |
| **AbortController** | 同步共享父；异步独立 | 独立，不链接父 | 独立，有独立"当前 turn"控制器 |
| **权限弹窗** | 同步可弹；异步不弹 | 不弹（bubble 模式冒泡到父终端） | 可弹（共享父终端） |
| **递归防护** | `ALL_AGENT_DISALLOWED_TOOLS` | `querySource` + 消息扫描双重检测 | 队友不能派生队友（call() 检查） |

---

## 2. Agent 类型分类

### 2.1 SubAgent（标准子 Agent）

最基础的 Agent 类型。父 Agent 通过 `Agent(subagent_type="reviewer", prompt="...")` 明确指定类型后派生。

**特点：**
- 从零构建系统提示和消息历史
- 工具池经 `resolveAgentTools()` 过滤，与父 Agent 工具池隔离
- 可同步（阻塞父 Agent）或异步（后台运行）
- 支持前置 hooks、技能预加载、专属 MCP 服务器
- 在 CLAUDE.md 和 gitStatus 方面 Explore/Plan 类型有特殊优化（省略以节省 token）

### 2.2 ForkAgent（Fork 子 Agent）

实验性功能（功能门控 `isForkSubagentEnabled()`），`Agent()` 省略 `subagent_type` 时触发。

**设计目标：** 最大化 prompt cache 命中率，降低并行子 Agent 的 API 成本。

**特点：**
- 继承父 Agent 完整对话历史（`forkContextMessages`）
- 使用父 Agent 的渲染字节作为系统提示（`override.systemPrompt`），保证缓存前缀一致
- 复用父 Agent 的工具数组引用（`useExactTools = true`），跳过 `resolveAgentTools()`
- 强制异步执行
- 递归防护：`querySource` 检测（compaction 稳定）+ 消息扫描（fallback）

### 2.3 InProcess Teammate（进程内队友）

多 Agent 群体（Swarm）模式下的对等 Agent（功能门控 `isAgentSwarmsEnabled()`），由 `spawnInProcessTeammate()` 创建。

**特点：**
- 在同一 Node.js 进程内运行，通过 `AsyncLocalStorage` 实现上下文隔离
- 身份格式：`agentName@teamName`（如 `researcher@my-team`）
- 支持 plan 模式审批流程（`awaitingPlanApproval`）
- 独立 AbortController，不受父 Agent ESC 影响
- 邮箱（mailbox）机制支持队友间异步通信
- UI 消息历史上限 50 条（`TEAMMATE_MESSAGES_UI_CAP`），防内存泄漏

---

## 3. 核心数据结构

### 3.1 AgentToolInput（Agent 工具调用参数）

```typescript
// src/tools/AgentTool/AgentTool.tsx:132
// 完整输入类型，结合 baseInputSchema + multiAgentInputSchema + isolation 扩展
type AgentToolInput = z.infer<ReturnType<typeof baseInputSchema>> & {

  // ─── 基础参数 ──────────────────────────────────────────────

  /** 任务的简短描述（3-5 词），显示在 UI spinner 上 */
  description: string

  /** 子 Agent 要执行的完整任务 prompt */
  prompt: string

  /**
   * 指定 Agent 类型（不填时走 ForkAgent 路径）。
   * 类型名必须匹配 agentDefinitions.activeAgents 中某个 agentType 字段。
   */
  subagent_type?: string

  /**
   * 可选模型覆盖。
   * 优先级：此参数 > Agent 定义的 model 字段 > 继承父 Agent 模型
   */
  model?: 'sonnet' | 'opus' | 'haiku'

  /**
   * 是否后台运行。
   * true  → 立即返回 async_launched，子 Agent 在后台独立运行
   * false → 同步阻塞父 Agent，等待子 Agent 完成后返回结果
   */
  run_in_background?: boolean

  // ─── Swarm 多 Agent 参数（功能门控 isAgentSwarmsEnabled）──

  /** 队友名称，提供此参数且 team_name 有效时走 Teammate 分支 */
  name?: string

  /** 团队名称（可从上下文继承） */
  team_name?: string

  /**
   * 权限模式覆盖。
   * 'plan' → 队友必须进入 plan 模式审批后才能实施
   */
  mode?: PermissionMode

  // ─── 隔离参数 ──────────────────────────────────────────────

  /**
   * 隔离模式：
   * "worktree" → createAgentWorktree() 创建临时 git worktree
   * "remote"   → teleportToRemote()，在远程 CCR 环境运行（仅 ant 内部）
   */
  isolation?: 'worktree' | 'remote'

  /**
   * 工作目录覆盖（KAIROS 模式专用），与 isolation: "worktree" 互斥。
   * 设置后 runWithCwdOverride() 在此路径内执行所有文件/Shell 操作。
   */
  cwd?: string
}
```

### 3.2 AgentToolResult（Agent 执行结果）

```typescript
// src/tools/AgentTool/agentToolUtils.ts:283
// 由 agentToolResultSchema() Zod schema 验证
export type AgentToolResult = {
  /** 子 Agent 的唯一 ID（UUID 格式，与 LocalAgentTaskState.agentId 对应） */
  agentId: string

  /** Agent 类型（如 "general-purpose", "reviewer"，用于 UI 显示和遥测） */
  agentType?: string

  /** 最终输出的文本内容块数组（从最后一条 assistant 消息提取） */
  content: Array<{ type: 'text'; text: string }>

  /** 总工具调用次数（统计所有 assistant 消息中的 tool_use 块） */
  totalToolUseCount: number

  /** 执行总耗时（毫秒，从 startTime 到 finalizeAgentTool 调用时刻） */
  totalDurationMs: number

  /** 最后一轮 API 响应的 token 总数 */
  totalTokens: number

  /** 最后一轮 API 响应的详细 token 用量统计 */
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number | null
    cache_read_input_tokens: number | null
    server_tool_use: {
      web_search_requests: number
      web_fetch_requests: number
    } | null
    service_tier: 'standard' | 'priority' | 'batch' | null
    cache_creation: {
      ephemeral_1h_input_tokens: number  // 1 小时 ephemeral cache 创建量
      ephemeral_5m_input_tokens: number  // 5 分钟 ephemeral cache 创建量
    } | null
  }
}
```

### 3.3 AgentTool 全量输出类型

```typescript
// src/tools/AgentTool/AgentTool.tsx

// ── 同步完成输出 ──────────────────────────────────────────────
type SyncOutput = AgentToolResult & {
  status: 'completed'
  prompt: string  // 原始 prompt（透传给父 Agent）
}

// ── 异步启动输出（立即返回，子 Agent 后台运行）──────────────────
type AsyncOutput = {
  status: 'async_launched'
  /** 子 Agent ID，可传给 SendMessage({to: agentId}) */
  agentId: string
  description: string
  prompt: string
  /**
   * 输出文件路径（符号链接 → sidechain transcript JSONL）。
   * 父 Agent 可通过 Read(outputFile) 读取实时进度。
   */
  outputFile: string
  /** 调用方是否有 Read/Bash 工具可读取输出文件 */
  canReadOutputFile?: boolean
}

// ── 队友派生输出（内部类型，不在公开 schema 中）──────────────────
type TeammateSpawnedOutput = {
  status: 'teammate_spawned'
  prompt: string
  teammate_id: string  // tmux pane ID（历史字段）
  agent_id: string     // "agentName@teamName"
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string  // 历史字段（进程内队友不使用 tmux）
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}

// ── 远程启动输出（仅 ant 内部）────────────────────────────────
export type RemoteLaunchedOutput = {
  status: 'remote_launched'
  taskId: string
  sessionUrl: string  // CCR 会话 URL
  description: string
  prompt: string
  outputFile: string
}
```

### 3.4 LocalAgentTaskState（异步 Agent 任务状态）

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx:116
export type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent'

  // ─── 身份 ─────────────────────────────────────────────────

  agentId: string    // UUID，与 AgentToolResult.agentId 对应
  prompt: string     // 原始 prompt
  agentType: string  // Agent 类型名（如 "general-purpose"）

  /** 使用的 Agent 定义（含 frontmatter，如 tools/model/hooks 等） */
  selectedAgent?: AgentDefinition

  // ─── 运行时（不序列化到磁盘）──────────────────────────────

  abortController?: AbortController
  /** cleanup registry 的反注册函数，agent 完成时调用 */
  unregisterCleanup?: () => void

  // ─── 结果 ─────────────────────────────────────────────────

  error?: string
  result?: AgentToolResult

  // ─── 进度追踪 ────────────────────────────────────────────

  progress?: AgentProgress

  /** 是否已成功拉取过输出（防重复读取） */
  retrieved: boolean

  /** Agent 消息历史（仅供面板视图使用，非完整历史） */
  messages?: Message[]

  /** 上次上报给父 Agent 的工具调用计数（计算增量通知用） */
  lastReportedToolCount: number

  /** 上次上报给父 Agent 的 token 计数 */
  lastReportedTokenCount: number

  /**
   * 是否已后台化。
   * false = 前台运行（Agent 正被主动"查看"，面板展示中）
   * true  = 后台运行（默认状态，registerAsyncAgent 时立即设为 true）
   */
  isBackgrounded: boolean

  /**
   * 跨轮次挂起的消息队列（SendMessage 中途注入）。
   * 在工具轮次边界排空，以 user message 形式注入 query() 循环。
   */
  pendingMessages: string[]

  /**
   * UI 是否持有此任务（retain=true 阻止驱逐）。
   * 与 viewingAgentTaskId 不同：retain 是"持有"，后者是"查看"。
   * retain=true 时清除 evictAfter 截止时间。
   */
  retain: boolean

  /** 是否已从磁盘 JSONL bootstrap 消息（每个 retain 周期一次，一次性）*/
  diskLoaded: boolean

  /**
   * 面板可见性截止时间（毫秒时间戳）。
   * undefined = 无截止（运行中或被 retain）
   * timestamp = 超过后隐藏面板并可 GC
   * 在终态转换时设置为 Date.now() + PANEL_GRACE_MS（10s）
   */
  evictAfter?: number
}
```

### 3.5 AgentProgress（进度追踪）

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx:33
export type AgentProgress = {
  toolUseCount: number            // 累计工具调用次数
  tokenCount: number              // 累计 token 数（最后一轮响应）
  lastActivity?: ToolActivity     // 最近一次工具活动
  recentActivities?: ToolActivity[] // 最近 N 次工具活动（环形缓冲，MAX_RECENT_ACTIVITIES=5）
  summary?: string                // 后台摘要服务生成的进度摘要文本
}

export type ToolActivity = {
  toolName: string    // 工具名称（如 "Bash", "Read"）
  description?: string // 活动描述（如文件路径、Shell 命令片段）
  /** 是否为只读操作（Read/cat 等），用于区分进度条颜色/图标 */
  isRead?: boolean
}
```

### 3.6 InProcessTeammateTaskState（进程内队友任务状态）

```typescript
// src/tasks/InProcessTeammateTask/types.ts:22
export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'

  /**
   * 队友身份（平铺数据，对应 TeammateContext 的 AsyncLocalStorage 结构）。
   * 存为普通数据在 AppState 中，不是 AsyncLocalStorage 的引用。
   */
  identity: TeammateIdentity

  prompt: string
  model?: string
  selectedAgent?: AgentDefinition  // 若队友使用了特定 Agent 定义

  // ─── 运行时（不序列化）──────────────────────────────────

  abortController?: AbortController          // 终止整个队友
  currentWorkAbortController?: AbortController // 仅终止当前 turn（不杀死队友）
  unregisterCleanup?: () => void

  // ─── Plan 模式审批 ───────────────────────────────────────

  /** 正在等待用户审批计划 */
  awaitingPlanApproval: boolean

  /**
   * 此队友独立的权限模式，可通过 Shift+Tab 独立切换（不影响其他队友）。
   */
  permissionMode: PermissionMode

  // ─── 状态 ────────────────────────────────────────────────

  error?: string
  result?: AgentToolResult  // 队友完成后的最终结果

  progress?: AgentProgress

  /**
   * 对话历史（仅用于 UI 放大视图，上限 TEAMMATE_MESSAGES_UI_CAP=50 条）。
   * 超出后丢弃最旧的条目（appendCappedMessage）。
   * 完整历史存于磁盘 transcript JSONL。
   */
  messages?: Message[]

  /** 正在执行的工具 ID 集合（用于 transcript 视图的动画效果） */
  inProgressToolUseIDs?: Set<string>

  /**
   * 用户查看队友 transcript 时键入的消息队列。
   * 由 injectUserMessageToTeammate() 追加，队友循环在轮次边界排空。
   */
  pendingUserMessages: string[]

  // ─── UI ──────────────────────────────────────────────────

  spinnerVerb?: string    // 随机 spinner 动词（如 "thinking", "coding"）
  pastTenseVerb?: string  // 完成后显示的过去时动词

  // ─── 生命周期 ────────────────────────────────────────────

  /** 队友循环是否处于空闲状态（等待任务中） */
  isIdle: boolean

  /** 是否已请求优雅关闭 */
  shutdownRequested: boolean

  /**
   * 空闲回调列表。
   * Leader 等待队友完成 turn 时注册，队友进入 isIdle 时调用，避免轮询。
   */
  onIdleCallbacks?: Array<() => void>

  // ─── 进度增量追踪 ────────────────────────────────────────

  lastReportedToolCount: number   // 上次向 Leader 报告时的工具调用数
  lastReportedTokenCount: number  // 上次向 Leader 报告时的 token 数
}
```

### 3.7 TeammateIdentity（队友身份）

```typescript
// src/tasks/InProcessTeammateTask/types.ts:13
export type TeammateIdentity = {
  /** 完整 Agent ID，格式："agentName@teamName"，如 "researcher@my-team" */
  agentId: string

  /** Agent 名称（不含 @teamName 部分），如 "researcher" */
  agentName: string

  teamName: string
  color?: string  // UI 显示颜色（16 进制或 CSS 颜色名）

  /** 是否要求进入 plan 模式才能实施（来自 AgentTool 的 mode="plan" 参数） */
  planModeRequired: boolean

  /** 父 session ID（Leader 的 sessionId），用于 transcript 关联和 Perfetto 追踪 */
  parentSessionId: string
}
```

### 3.8 ResolvedAgentTools（工具解析结果）

```typescript
// src/tools/AgentTool/agentToolUtils.ts:62
export type ResolvedAgentTools = {
  /** true 表示 tools=undefined 或 tools=['*']，允许全部可用工具 */
  hasWildcard: boolean

  /** frontmatter tools 白名单中存在且通过验证的工具名列表 */
  validTools: string[]

  /** frontmatter tools 白名单中指定但当前不可用的工具名（用于警告日志）*/
  invalidTools: string[]

  /** 最终解析出的工具实例数组，传给 runAgent 的 availableTools 参数 */
  resolvedTools: Tools

  /**
   * Agent(worker, researcher) 语法解析出的可用 Agent 类型列表。
   * 非空时限制此 Agent 只能派生 allowedAgentTypes 中的子 Agent 类型。
   */
  allowedAgentTypes?: string[]
}
```

### 3.9 InProcessSpawnConfig / InProcessSpawnOutput

```typescript
// src/utils/swarm/spawnInProcess.ts:59 / 77

/** spawnInProcessTeammate 的入参 */
export type InProcessSpawnConfig = {
  name: string            // 队友显示名，如 "researcher"
  teamName: string        // 所属团队名
  prompt: string          // 初始任务 prompt
  color?: string          // UI 颜色（可选）
  planModeRequired: boolean // 是否要求 plan 模式审批
  model?: string          // 可选模型覆盖
}

/** spawnInProcessTeammate 的返回值 */
export type InProcessSpawnOutput = {
  success: boolean
  agentId: string         // "name@teamName" 格式
  taskId?: string         // AppState.tasks 中的 key
  abortController?: AbortController
  teammateContext?: ReturnType<typeof createTeammateContext>
  error?: string
}
```

---

## 4. 通信协议

### 4.1 同步子 Agent 协议

父 Agent 阻塞，等待子 Agent 完成。适用于短时、依赖父 Agent 结果的任务。

```
父 Agent Query Loop turn
│
│  模型输出 tool_use: Agent(subagent_type="reviewer", ...)
│                        │
│             AgentTool.call({ run_in_background: false })
│                        │
│             [直接 await runAgent() 同步执行]
│                        │
│             ┌──────────┴──────────┐
│             │  子 Agent 执行循环   │
│             │  query() streaming  │
│             │  工具调用 → 结果      │
│             │  多轮 turn           │
│             └──────────┬──────────┘
│                        │ 完成
│             finalizeAgentTool()
│                        │ 提取文本、统计 token、发遥测
│                        ▼
│             { status: 'completed', content: [...], ... }
│                        │
│             [父 Agent 收到工具结果，继续本 turn]
```

**关键特性：**
- 父 Agent 的 `abortController` 与子 Agent **共享**（ESC 立即取消两者）
- 父 Agent 的 `setAppState` 直接传递（子 Agent 的 hooks/todos 可更新父 UI）
- 可以弹出权限确认对话框（`shouldAvoidPermissionPrompts = false`）
- 无 `<task-notification>`，直接返回 `SyncOutput`

### 4.2 异步子 Agent 协议

父 Agent 立即返回，子 Agent 在后台独立运行。适用于长时、可并行的任务。

```
父 Agent Query Loop turn
│
│  AgentTool.call({ run_in_background: true })
│         │
│         ├─► 1. registerAsyncAgent()        [同步，登记任务]
│         │      └─► AppState.tasks[agentId] = { status:'running', ... }
│         │
│         ├─► 2. void runAsyncAgentLifecycle()  [fire-and-forget，异步]
│         │         │
│         │         └─► [后台独立运行，不阻塞父 Agent]
│         │
│         ▼ 3. 立即返回
│  { status: 'async_launched', agentId: 'abc', outputFile: '/path/...' }
│
│  [父 Agent 继续处理，可做其他工作]
│  ...
│  [父 Agent 的后续 turn 收到 user message 中的 <task-notification>]
│
│  后台（异步）：
│  runAsyncAgentLifecycle()
│       │
│       ├─► runAgent()（子 Agent 完整循环）
│       │       │ 每条消息 → updateAgentProgress()
│       │       │ 更新 AppState.tasks[agentId].progress
│       │       │
│       │       ▼ 完成/失败
│       ├─► completeAgentTask() 或 failAgentTask()
│       │       └─► AppState.tasks[agentId].status = 'completed'
│       │
│       └─► enqueueAgentNotification()
│               └─► 向父 Agent 的 query 循环注入：
│
│  <task-notification>
│  Task completed: research-task
│  Agent ID: abc123-...
│  Status: completed
│  Duration: 45.2s
│  Tool uses: 12
│
│  Output:
│  [子 Agent 的最终文本输出]
│  </task-notification>
```

**关键特性：**
- 子 Agent 有**独立的** `AbortController`（不链接父 Agent，ESC 不取消后台子 Agent）
- `setAppState` 是 no-op（异步 Agent 不能直接更新父 UI，通过 `rootSetAppState` 写根状态）
- 不弹权限对话框（`shouldAvoidPermissionPrompts = true`）
- 工具池受 `ASYNC_AGENT_ALLOWED_TOOLS` 白名单限制

### 4.3 ForkAgent 并行缓存协议

ForkAgent 的核心设计目标是让多个并行子 Agent 共享同一段 prompt cache 前缀，大幅降低 API 成本。

```
父 Agent turn（模型同一 assistant 消息输出多个 tool_use）
│
│  assistant: [
│    { type:'tool_use', id:'tu1', name:'Agent', input:{prompt:'task1'} },
│    { type:'tool_use', id:'tu2', name:'Agent', input:{prompt:'task2'} },
│    { type:'tool_use', id:'tu3', name:'Agent', input:{prompt:'task3'} },
│  ]
│
│  AgentTool.call() × 3
│         │
│         ├─► buildForkedMessages(prompt='task1', assistantMessage)
│         │     [
│         │       ...父历史,
│         │       assistant(tu1+tu2+tu3),           ← 三个 Fork 相同
│         │       user([
│         │         tool_result(tu1, "Fork started"), ← 占位符相同
│         │         tool_result(tu2, "Fork started"), ← 占位符相同
│         │         tool_result(tu3, "Fork started"), ← 占位符相同
│         │         <fork-boilerplate>task1指令</fork-boilerplate> ← Fork1 独有
│         │       ])
│         │     ]
│         │
│         ├─► buildForkedMessages(prompt='task2', assistantMessage)
│         │     [...相同的父历史和占位符... + Fork2 指令]
│         │
│         └─► buildForkedMessages(prompt='task3', assistantMessage)
│               [...相同的父历史和占位符... + Fork3 指令]
│
│  [三个 Fork 并行向 Anthropic API 发送请求]
│  [前缀字节完全相同 → 三个请求共享一份 prompt cache]
│  [每个 Fork 只额外支付自己的 <fork-boilerplate> 部分的 token]
│
│  [三个 Fork 各自在后台完成，通过 <task-notification> 通知父 Agent]
```

**缓存一致性保证：**
1. **系统提示**：使用父 Agent 的 `renderedSystemPrompt`（已渲染的字节，不重新计算）
2. **消息历史**：相同的父历史（`filterIncompleteToolCalls` 处理后）
3. **占位符文本**：所有 Fork 的 tool_result 内容相同（`"Fork started — processing in background"`）
4. **工具定义**：`useExactTools=true`，直接引用父工具数组（不经 `resolveAgentTools` 重新序列化）

### 4.4 SendMessage 路由协议

异步 Agent 可以通过 `name` 参数注册名称，后续支持通过 `SendMessage({to: name})` 向其注入消息。

```typescript
// 1. 注册阶段（AgentTool.call()，异步路径）
if (name) {
  rootSetAppState(prev => {
    const next = new Map(prev.agentNameRegistry)
    // 建立 name → agentId 映射
    next.set(name, asAgentId(asyncAgentId))
    return { ...prev, agentNameRegistry: next }
  })
}

// 2. 消息注入阶段（SendMessageTool 处理）
// SendMessage({to: "researcher", message: "..."})
//   → 查找 AppState.agentNameRegistry.get("researcher")
//   → 得到 agentId
//   → queuePendingMessage(taskId, message, setAppState)

// 3. 排空阶段（子 Agent 执行循环）
// 在每个工具轮次边界，子 Agent 检查 pendingMessages 队列
// 有消息时注入为 user message，子 Agent 可以"看到"并响应
```

---

## 5. AgentTool 执行流程

### 5.1 完整路由决策（`AgentTool.call()`）

```typescript
// src/tools/AgentTool/AgentTool.tsx:277
async call(input: AgentToolInput, toolUseContext, canUseTool, assistantMessage, onProgress?)
```

```
Step 1: 基础权限与可用性检查
├── team_name 但 !isAgentSwarmsEnabled() → 抛错：plan 不支持
├── isTeammate() + name → 抛错：队友不能派生队友（Swarm 结构是平级的）
└── isInProcessTeammate() + run_in_background=true → 抛错：进程内队友不能派生异步子 Agent

Step 2: 多 Agent 路由判断
├── resolveTeamName(team_name, appState) → 解析有效团队名
└── teamName + name 都存在 → 走 spawnTeammate() 分支（Swarm 模式）

Step 3: SubAgent vs ForkAgent 路由
├── effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : 'general-purpose')
├── isForkPath = (effectiveType === undefined)
│
├── ForkAgent 路径：
│   ├── 递归防护 1：toolUseContext.options.querySource === 'agent:builtin:fork' → 抛错
│   ├── 递归防护 2：isInForkChild(toolUseContext.messages) 消息扫描 → 抛错
│   └── selectedAgent = FORK_AGENT
│
└── SubAgent 路径：
    ├── filterDeniedAgents() 过滤被权限规则拒绝的 Agent 类型
    ├── allAgents.find(a => a.agentType === effectiveType) → 找到 Agent 定义
    ├── 未找到但存在于拒绝列表 → 抛错：被权限规则拒绝
    └── 完全未找到 → 抛错：Agent 类型不存在（列出可用类型）

Step 4: MCP 服务器可用性检查（requiredMcpServers）
├── 若 Agent 定义了 requiredMcpServers，检查对应 MCP 服务器是否已连接
├── 有 pending 状态的必需服务器 → 轮询等待，最多 30 秒
│   （每 500ms 检查一次，早退条件：发现失败的必需服务器）
└── 缺少必需服务器的工具 → 抛错（提示用 /mcp 配置）

Step 5: 工具池组装（与父 Agent 工具池独立）
├── workerPermissionContext = { ...appState.toolPermissionContext,
│                               mode: selectedAgent.permissionMode ?? 'acceptEdits' }
└── workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools)

Step 6: 隔离环境创建
├── effectiveIsolation = isolation ?? selectedAgent.isolation
├── 'worktree' → createAgentWorktree(`agent-${agentId.slice(0,8)}`)
└── 'remote'  → checkRemoteAgentEligibility() + teleportToRemote()（ant 内部）

Step 7: 系统提示准备
├── ForkAgent：forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
│             （回退：重新计算 buildEffectiveSystemPrompt）
└── SubAgent：enhancedSystemPrompt = await enhanceSystemPromptWithEnvDetails(
                selectedAgent.getSystemPrompt({ toolUseContext }), ...)

Step 8: Prompt 消息准备
├── ForkAgent：promptMessages = buildForkedMessages(prompt, assistantMessage)
└── SubAgent：promptMessages = [createUserMessage({ content: prompt })]

Step 9: 执行模式决策
│  shouldRunAsync = (
│    run_in_background === true   ||  // 用户显式指定
│    selectedAgent.background === true ||  // Agent 定义要求后台
│    isCoordinator                ||  // 协调者模式
│    isForkSubagentEnabled()      ||  // Fork 实验（强制全部异步）
│    appState.kairosEnabled       ||  // KAIROS 自主模式
│    proactiveModule?.isProactiveActive()
│  ) && !isBackgroundTasksDisabled
│
├── shouldRunAsync = true → 异步路径
│   ├── registerAsyncAgent()
│   ├── void runWithAgentContext(...runAsyncAgentLifecycle(...))
│   └── 立即返回 { status: 'async_launched', ... }
│
└── shouldRunAsync = false → 同步路径
    ├── runWithAgentContext(...runAgent(...))
    ├── 收集 agentMessages
    ├── finalizeAgentTool()
    └── 返回 { status: 'completed', content: [...], ... }
```

### 5.2 异步生命周期（`runAsyncAgentLifecycle`）

```typescript
// 在 AgentTool.tsx 中定义，通过 void fire-and-forget 调用
void runWithAgentContext(asyncAgentContext, () =>
  wrapWithCwd(() =>
    runAsyncAgentLifecycle({
      taskId,
      abortController: agentBackgroundTask.abortController!,
      // makeStream 是 runAgent 的工厂函数，支持 onCacheSafeParams 回调
      makeStream: onCacheSafeParams => runAgent({
        ...runAgentParams,
        override: { ...runAgentParams.override, agentId, abortController },
        onCacheSafeParams  // 后台摘要服务通过此回调获取缓存安全参数
      }),
      metadata,
      description,
      toolUseContext,
      rootSetAppState,
      agentIdForCleanup: asyncAgentId,
      // 启用后台摘要（Coordinator 或 Fork 模式时开启）
      enableSummarization: isCoordinator || isForkSubagentEnabled(),
      getWorktreeResult: cleanupWorktreeIfNeeded
    })
  )
)
```

**`runAsyncAgentLifecycle` 内部职责：**
1. 调用 `makeStream()`（即 `runAgent()`），迭代 Agent 循环产出的消息
2. 每条消息后调用 `updateAgentProgress()`，更新 `LocalAgentTaskState.progress`
3. 可选启动后台摘要服务（`startAgentSummarization`），定期生成进度摘要
4. 捕获 `AbortError` → 调用 `killAsyncAgent()`
5. 捕获其他错误 → 调用 `failAgentTask(error)`
6. 正常完成 → 调用 `completeAgentTask(finalizeAgentTool(...))`
7. 调用 `enqueueAgentNotification()` 将完成通知推入父 Agent 的消息队列
8. 调用 `cleanupWorktreeIfNeeded()` 处理 worktree

---

## 6. runAgent 核心函数

### 6.1 函数签名

```typescript
// src/tools/AgentTool/runAgent.ts:290
export async function* runAgent({
  agentDefinition,         // Agent 的完整定义（frontmatter + getSystemPrompt 函数）
  promptMessages,          // 初始消息（SubAgent: [user msg]；ForkAgent: [历史+占位符+指令]）
  toolUseContext,          // 父 Agent 的工具上下文（含 messages、options、getAppState 等）
  canUseTool,              // 工具使用权限检查函数（来自父 Agent）
  isAsync,                 // 是否异步执行（影响权限弹窗、AbortController、工具过滤）
  canShowPermissionPrompts,// 覆盖 !isAsync 默认值（in-process teammate 异步但可弹窗）
  forkContextMessages,     // ForkAgent 专用：父 Agent 的完整消息历史
  querySource,             // 查询来源标识（如 'agent:builtin:fork'，用于递归检测）
  override,                // 覆盖参数：{ userContext, systemContext, systemPrompt, abortController, agentId }
  model,                   // 模型覆盖（SubAgent 可指定；ForkAgent 传 undefined 继承父模型）
  maxTurns,                // 最大 turn 数（默认：agentDefinition.maxTurns；ForkAgent: 200 硬编码）
  preserveToolUseResults,  // 是否保留工具结果（进程内队友需要，用于 UI 放大视图）
  availableTools,          // 预计算的工具池（由 AgentTool.call() 组装，避免循环依赖）
  allowedTools,            // 工具权限白名单（指定时替换 session 级规则，防止父权限泄漏）
  onCacheSafeParams,       // 回调：构建完系统提示后触发，供后台摘要服务 fork 对话
  contentReplacementState, // 工具结果替换状态（resume 场景，确保替换决策一致）
  useExactTools,           // true=跳过 resolveAgentTools()，直接用 availableTools（ForkAgent）
  worktreePath,            // worktree 路径（持久化到 metadata，供 resume 恢复 cwd）
  description,             // 任务描述（持久化到 metadata，供完成通知显示）
  transcriptSubdir,        // transcript 分组子目录（Workflow 的 runId 分组用）
  onQueryProgress,         // 每次 query() 产出消息时的回调（检测长时间无响应）
}: {...}): AsyncGenerator<Message, void>
```

### 6.2 内部执行序列（详细注释）

```typescript
// ─── 阶段 1: 初始化 ────────────────────────────────────────────

// 1.1 解析最终使用的模型
// 优先级：override.model > agentDefinition.model > 父 Agent 模型 > plan 模式强制 haiku
const resolvedAgentModel = getAgentModel(
  agentDefinition.model,
  toolUseContext.options.mainLoopModel,
  model,
  permissionMode,
)

// 1.2 生成或使用覆盖的 agentId
const agentId = override?.agentId ?? createAgentId()  // createAgentId() 产生 UUID

// 1.3 设置 transcript 子目录分组（Workflow 用）
if (transcriptSubdir) {
  setAgentTranscriptSubdir(agentId, transcriptSubdir)
}

// 1.4 注册 Perfetto 追踪（可视化 Agent 层次树）
if (isPerfettoTracingEnabled()) {
  const parentId = toolUseContext.agentId ?? getSessionId()  // 父节点 ID
  registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
}

// ─── 阶段 2: 消息历史组装 ──────────────────────────────────────

// 2.1 准备上下文消息（fork 时继承父历史，否则为空）
const contextMessages: Message[] = forkContextMessages
  ? filterIncompleteToolCalls(forkContextMessages)  // 过滤孤立 tool_use（防 API 错误）
  : []

const initialMessages: Message[] = [...contextMessages, ...promptMessages]
// SubAgent:  initialMessages = [user(prompt)]
// ForkAgent: initialMessages = [...父历史, assistant(tool_uses), user(占位符+指令)]

// 2.2 文件状态缓存策略
const agentReadFileState = forkContextMessages !== undefined
  ? cloneFileStateCache(toolUseContext.readFileState)         // ForkAgent：克隆父缓存（prompt cache 一致性）
  : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE) // SubAgent：全新缓存（4MB 限制）

// ─── 阶段 3: 上下文信息获取 ────────────────────────────────────

// 3.1 并发获取 userContext（CLAUDE.md）和 systemContext（git status、CWD 等）
// 两者均为 memoize 缓存，实际调用成本极低（O(1)）
const [baseUserContext, baseSystemContext] = await Promise.all([
  override?.userContext ?? getUserContext(),
  override?.systemContext ?? getSystemContext(),
])

// 3.2 按 Agent 类型决定是否省略 CLAUDE.md（节省 token）
// Explore/Plan 是只读搜索 Agent，不执行 CLAUDE.md 中的操作规则
const shouldOmitClaudeMd =
  agentDefinition.omitClaudeMd &&           // Agent 定义标记为可省略
  !override?.userContext &&                  // 没有显式 override
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
// 效果：Explore/Plan 省略 claudeMd，节省 ~5-15 Gtok/周（fleet 级别测量值）

// 3.3 按 Agent 类型决定是否省略 gitStatus
// Explore/Plan 执行 git status 获取更新鲜的信息，父 Agent 的 gitStatus 是死重量
const resolvedSystemContext =
  agentDefinition.agentType === 'Explore' || agentDefinition.agentType === 'Plan'
    ? systemContextNoGit    // 省略，节省 ~1-3 Gtok/周
    : baseSystemContext

// ─── 阶段 4: 权限上下文构建 ────────────────────────────────────

// 4.1 构建 agentGetAppState 闭包（按需覆盖父 AppState 中的权限字段）
const agentGetAppState = () => {
  const state = toolUseContext.getAppState()
  let toolPermissionContext = state.toolPermissionContext

  // 4.1.1 权限模式覆盖（优先级：父的 bypassPermissions/acceptEdits/auto > Agent 定义）
  if (agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(feature('TRANSCRIPT_CLASSIFIER') && state.toolPermissionContext.mode === 'auto')) {
    toolPermissionContext = { ...toolPermissionContext, mode: agentPermissionMode }
  }

  // 4.1.2 异步 Agent 禁止弹权限对话框（bubble 模式例外：冒泡到父终端）
  const shouldAvoidPrompts = canShowPermissionPrompts !== undefined
    ? !canShowPermissionPrompts
    : agentPermissionMode === 'bubble' ? false : isAsync
  if (shouldAvoidPrompts) {
    toolPermissionContext = { ...toolPermissionContext, shouldAvoidPermissionPrompts: true }
  }

  // 4.1.3 后台 Agent 但可弹窗时，先等待自动化检查（classifier/hooks）
  // 避免不必要地打断用户，只在自动化检查无法决策时才弹窗
  if (isAsync && !shouldAvoidPrompts) {
    toolPermissionContext = { ...toolPermissionContext, awaitAutomatedChecksBeforeDialog: true }
  }

  // 4.1.4 工具权限白名单（指定 allowedTools 时替换 session 级规则）
  // 重要：保留 cliArg 级规则（SDK --allowedTools 参数），只替换 session 级
  if (allowedTools !== undefined) {
    toolPermissionContext = {
      ...toolPermissionContext,
      alwaysAllowRules: {
        cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,  // 保留 SDK 级权限
        session: [...allowedTools],  // 仅使用显式指定的工具
      },
    }
  }

  // 4.1.5 努力值覆盖（Agent 定义的 effort 字段）
  const effortValue = agentDefinition.effort !== undefined ? agentDefinition.effort : state.effortValue

  return { ...state, toolPermissionContext, effortValue }
}

// ─── 阶段 5: 工具和系统提示 ────────────────────────────────────

// 5.1 最终工具数组
const resolvedTools = useExactTools
  ? availableTools   // ForkAgent：直接引用父工具数组（避免重新序列化，保证 cache hit）
  : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

// 5.2 系统提示（二选一）
const agentSystemPrompt = override?.systemPrompt
  ? override.systemPrompt    // ForkAgent：父 Agent 的渲染字节（保证缓存前缀一致）
  : asSystemPrompt(await getAgentSystemPrompt(  // SubAgent：调用 Agent 定义构建
      agentDefinition,
      toolUseContext,
      resolvedAgentModel,
      additionalWorkingDirectories,
      resolvedTools,
    ))

// 5.3 AbortController 策略
const agentAbortController = override?.abortController
  ? override.abortController           // 明确覆盖（如 in-process teammate）
  : isAsync
    ? new AbortController()            // 异步：独立，不链接父（ESC 不影响）
    : toolUseContext.abortController   // 同步：共享父（ESC 立即取消两者）

// ─── 阶段 6: SubAgent 专有初始化（ForkAgent 跳过）────────────────

// 6.1 执行 SubagentStart hooks（用户配置的 Agent 启动前钩子）
const additionalContexts: string[] = []
for await (const hookResult of executeSubagentStartHooks(agentId, agentDefinition.agentType, agentAbortController.signal)) {
  additionalContexts.push(...(hookResult.additionalContexts ?? []))
}
// 6.2 将 hook 上下文注入为 isMeta=true 的 user message（与 UserPromptSubmit hooks 格式一致）
if (additionalContexts.length > 0) {
  initialMessages.push(createAttachmentMessage({
    type: 'hook_additional_context',
    content: additionalContexts,
    hookName: 'SubagentStart',
    toolUseID: randomUUID(),
    hookEvent: 'SubagentStart',
  }))
}

// 6.3 注册 frontmatter hooks（isAgent=true 将 Stop → SubagentStop）
// 只有管理员信任的 source 或未开启 plugin-only 限制时才注册
if (agentDefinition.hooks && hooksAllowedForThisAgent) {
  registerFrontmatterHooks(
    rootSetAppState,
    agentId,
    agentDefinition.hooks,
    `agent '${agentDefinition.agentType}'`,
    true,  // isAgent: 将 Stop hooks 转为 SubagentStop，确保 hook 在正确事件触发
  )
}

// 6.4 预加载 frontmatter skills（并发加载所有声明的 skills）
// skills 字段格式：['skill-name', 'plugin:skill-name']
if (skillsToPreload.length > 0) {
  const loaded = await Promise.all(validSkills.map(async ({ skill }) => ({
    content: await skill.getPromptForCommand('', toolUseContext)
  })))
  // 每个 skill 注入为一条 isMeta=true 的 user message
  for (const { content } of loaded) {
    initialMessages.push(createUserMessage({ content: [...metadata, ...content], isMeta: true }))
  }
}

// 6.5 初始化 Agent 专属 MCP 服务器
// 字符串引用（"server-name"）→ 引用已有连接（不清理）
// 对象定义（{name: config}）→ 新建连接（Agent 结束时清理）
const { clients: mergedMcpClients, tools: agentMcpTools, cleanup: mcpCleanup }
  = await initializeAgentMcpServers(agentDefinition, toolUseContext.options.mcpClients)
// 合并 Agent 专属 MCP 工具到工具池（dedup by name）
const allTools = agentMcpTools.length > 0
  ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
  : resolvedTools

// ─── 阶段 7: 构建子 Agent 的 ToolUseContext ─────────────────────

// agentOptions 包含子 Agent 的完整配置
const agentOptions: ToolUseContext['options'] = {
  isNonInteractiveSession: useExactTools
    ? toolUseContext.options.isNonInteractiveSession  // ForkAgent：继承
    : isAsync ? true : (toolUseContext.options.isNonInteractiveSession ?? false),
  tools: allTools,
  commands: [],  // SubAgent 不使用 slash commands
  mainLoopModel: resolvedAgentModel,
  thinkingConfig: useExactTools
    ? toolUseContext.options.thinkingConfig   // ForkAgent：继承（保证 API 前缀字节相同）
    : { type: 'disabled' as const },          // SubAgent：禁用 thinking（控制 token 成本）
  mcpClients: mergedMcpClients,
  ...(useExactTools && { querySource }),  // ForkAgent 需要 querySource 用于递归防护
  // 其他字段省略...
}

const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,
  agentId,
  agentType: agentDefinition.agentType,
  messages: initialMessages,
  readFileState: agentReadFileState,
  abortController: agentAbortController,
  getAppState: agentGetAppState,
  shareSetAppState: !isAsync,     // 同步 Agent 共享父 setAppState；异步 no-op
  shareSetResponseLength: true,   // 同步/异步都贡献响应长度指标
})

// ─── 阶段 8: 持久化初始状态 ────────────────────────────────────

// 初始消息批量记录（fire-and-forget，失败不阻塞）
void recordSidechainTranscript(initialMessages, agentId).catch(...)

// 写入 Agent 元数据（agentType、worktreePath、description）
void writeAgentMetadata(agentId, { agentType, worktreePath, description }).catch(...)

// ─── 阶段 9: 主查询执行循环 ────────────────────────────────────

let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

try {
  for await (const message of query({
    messages: initialMessages,
    systemPrompt: agentSystemPrompt,
    userContext: resolvedUserContext,    // 可能已省略 CLAUDE.md（Explore/Plan）
    systemContext: resolvedSystemContext, // 可能已省略 gitStatus（Explore/Plan）
    canUseTool,
    toolUseContext: agentToolUseContext,
    querySource,
    maxTurns: maxTurns ?? agentDefinition.maxTurns,
  })) {
    onQueryProgress?.()  // 通知调用方有活跃输出（防超时误判）

    // 9.1 stream_event：转发 TTFT 指标给父 Agent 的 metrics 面板
    if (message.type === 'stream_event' && message.event.type === 'message_start' && message.ttftMs != null) {
      toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
      continue  // 不 yield，不记录
    }

    // 9.2 attachment：转发（含 max_turns_reached 信号）
    if (message.type === 'attachment') {
      if (message.attachment.type === 'max_turns_reached') {
        logForDebugging(`[Agent: ${agentType}] Reached max turns (${message.attachment.maxTurns})`)
        break
      }
      yield message  // 透传给调用方（如 structured_output attachment）
      continue
    }

    // 9.3 可录消息（assistant/user/progress/compact_boundary）：记录 + yield
    if (isRecordableMessage(message)) {
      // 增量记录（O(1) per message，不重写整个文件）
      await recordSidechainTranscript([message], agentId, lastRecordedUuid)
      if (message.type !== 'progress') {
        lastRecordedUuid = message.uuid  // 更新链式追踪 UUID
      }
      yield message  // 产出给 runAsyncAgentLifecycle 或同步调用方
    }
  }

  // 9.4 正常结束后检查是否被中止
  if (agentAbortController.signal.aborted) {
    throw new AbortError()
  }

  // 9.5 内置 Agent 的完成回调（仅 built-in Agent 有 callback 字段）
  if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
    agentDefinition.callback()
  }

} finally {
  // 阶段 10: 资源清理（见第 10 节）
}
```

### 6.3 `getAgentSystemPrompt` 函数

```typescript
// src/tools/AgentTool/runAgent.ts:1008
// SubAgent 专用，ForkAgent 不调用此函数（使用父 Agent 渲染字节）
async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]>
```

**构建步骤：**

```
1. agentDefinition.getSystemPrompt({ toolUseContext })
   └─ 返回 Agent 定义中声明的系统提示字符串（frontmatter 的 description/instructions）

2. enhanceSystemPromptWithEnvDetails(prompts, resolvedAgentModel, additionalWorkingDirectories, enabledToolNames)
   追加环境信息块，包含：
   ├─ "Agent threads always have their cwd reset between bash calls..."（绝对路径提醒）
   ├─ "In your final response, share file paths (always absolute)..."
   ├─ "For clear communication with the user the assistant MUST avoid using emojis."
   ├─ "Do not use a colon before tool calls..."
   └─ <env>...</env> 标签块：
       ├─ Working directory (cwd)
       ├─ Platform (darwin/linux/win32)
       ├─ Shell (bash/zsh/powershell)
       ├─ Model name (resolved)
       └─ Knowledge cutoff date

3. 错误时回退到 DEFAULT_AGENT_PROMPT（通用 Agent 提示）：
   "You are an agent for Claude Code...
    Complete the task fully—don't gold-plate, but don't leave it half-done.
    When you complete the task, respond with a concise report..."
```

---

## 7. 工具权限系统

### 7.1 工具过滤层次（`filterToolsForAgent`）

```typescript
// src/tools/AgentTool/agentToolUtils.ts:87
function filterToolsForAgent({
  tools,          // 候选工具数组（父 Agent 的工具池）
  isBuiltIn,      // Agent 是否为内置 Agent（built-in 获得更宽松的权限）
  isAsync,        // 是否异步执行（true 时应用 ASYNC 白名单）
  permissionMode, // 权限模式（plan 模式对 ExitPlanMode 有特殊处理）
}: {...}): Tools
```

**过滤优先级（从高到低）：**

```
优先级 1：MCP 工具（mcp__ 前缀） → 始终允许
           └─ MCP 工具不受任何内置工具过滤规则约束

优先级 2：ExitPlanMode + plan 模式 → 始终允许
           └─ 处于 plan 模式的 Agent（进程内队友）必须能退出 plan 模式

优先级 3：ALL_AGENT_DISALLOWED_TOOLS（所有 SubAgent 禁止）：
           ├─ TaskOutput       — 防止子 Agent 递归读取任务输出
           ├─ ExitPlanMode     — Plan 模式是主线程抽象（优先级 2 特例除外）
           ├─ EnterPlanMode    — 同上
           ├─ Agent            — 外部用户禁止嵌套 Agent 调用（ant 内部用户允许）
           ├─ AskUserQuestion  — SubAgent 不能直接与终端用户交互
           └─ TaskStop         — 需要主线程任务状态，SubAgent 不能操作

优先级 4：CUSTOM_AGENT_DISALLOWED_TOOLS（非内置 Agent 额外禁止）：
           └─ [ant 内部特定工具，外部发布版本不涉及]

优先级 5：isAsync=true 时：只允许 ASYNC_AGENT_ALLOWED_TOOLS 白名单：
           ├─ Read, WebSearch, TodoWrite, Grep, WebFetch, Glob
           ├─ Bash, PowerShell, Edit, Write, NotebookEdit
           ├─ Skill, SyntheticOutput, ToolSearch
           ├─ EnterWorktree, ExitWorktree
           └─ 进程内队友（isAgentSwarmsEnabled + isInProcessTeammate）额外允许：
               ├─ Agent（派生同步子 Agent）
               └─ TaskCreate, TaskGet, TaskUpdate, TaskList（任务协调）
```

### 7.2 `resolveAgentTools` 完整流程

```typescript
// src/tools/AgentTool/agentToolUtils.ts:139
// 注意：ForkAgent 使用 useExactTools=true 完全跳过此函数
function resolveAgentTools(
  agentDefinition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'source' | 'permissionMode'>,
  availableTools: Tools,  // workerTools（独立于父 Agent 工具池的重新组装版本）
  isAsync = false,
  isMainThread = false,   // 主线程跳过 filterToolsForAgent（已由 useMergedTools 组装）
): ResolvedAgentTools
```

**四步过滤流程：**

```
Step 1: 基础过滤（filterToolsForAgent）
│   isMainThread=true → 跳过（主线程工具池由 useMergedTools() 管理）
│   isMainThread=false → 应用 ALL_AGENT_DISALLOWED_TOOLS + ASYNC_AGENT_ALLOWED_TOOLS
└─► filteredAvailableTools

Step 2: 应用 disallowedTools 黑名单
│   解析每个 toolSpec："ToolName(pattern)" → toolName
│   构建 disallowedToolSet（O(1) 查找集合）
└─► allowedAvailableTools（filteredAvailableTools 减去黑名单）

Step 3: 通配符判断
│   tools=undefined 或 tools=['*'] → hasWildcard=true
│   直接返回 allowedAvailableTools 作为 resolvedTools
└─► 若无通配符，进入 Step 4

Step 4: 按白名单精确匹配
    for toolSpec in agentDefinition.tools:
        toolName = 解析 toolSpec
        if toolName === AGENT_TOOL_NAME:
            若有 ruleContent → 解析 allowedAgentTypes（"worker, researcher" → ["worker", "researcher"]）
            非主线程 → 跳过工具解析（Agent 被 filterToolsForAgent 排除了）
            主线程 → 正常解析
        tool = availableToolMap.get(toolName)
        if tool:  → validTools.push() + resolved.push()
        else:     → invalidTools.push()（记录警告）

返回：{ hasWildcard, validTools, invalidTools, resolvedTools, allowedAgentTypes }
```

### 7.3 WorkerTools 独立组装

```typescript
// src/tools/AgentTool/AgentTool.tsx:663
// 重要：与父 Agent 的运行时工具限制完全独立

// 使用 Agent 定义的 permissionMode（默认 acceptEdits）
const workerPermissionContext = {
  ...appState.toolPermissionContext,
  mode: selectedAgent.permissionMode ?? 'acceptEdits'  // 不继承父 Agent 的当前 mode
}

// 独立组装工具池（从全局 appState.mcp.tools 重新组装）
const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools)
```

**为何独立组装？**
- 父 Agent 可能在 plan 模式下（无 FileEdit 工具），但子 Agent 应有完整工具集
- 父 Agent 的临时权限覆盖不应泄漏到子 Agent
- 每个子 Agent 有自己的 `permissionMode`，需要独立的工具集合

---

## 8. 隔离与上下文管理

### 8.1 AbortController 策略

| Agent 类型 | AbortController 策略 | ESC 行为 |
|-----------|---------------------|---------|
| 同步 SubAgent | 共享父 `toolUseContext.abortController` | ESC 立即取消父+子 |
| 异步 SubAgent | `new AbortController()`（独立，不链接父） | ESC 不影响后台子 Agent |
| ForkAgent | `new AbortController()`（独立） | ESC 不影响 Fork 子 Agent |
| InProcess Teammate | `createAbortController()`（独立） | 独立控制（Leader ESC 不影响） |

**子 AbortController 模式（`registerAsyncAgent` 的 `parentAbortController` 参数）：**

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx:501
const abortController = parentAbortController
  ? createChildAbortController(parentAbortController)  // 子控制器：父 abort 时自动 abort
  : createAbortController()                             // 独立控制器
```

进程内队友调用 `registerAsyncAgent` 时传入父的 `abortController`，创建子控制器，使队友在 Leader 中止时自动中止。

### 8.2 文件状态缓存策略

```typescript
// src/tools/AgentTool/runAgent.ts:419
const agentReadFileState = forkContextMessages !== undefined
  // ForkAgent：克隆父缓存，保证 contentReplacementState 决策一致
  // （相同文件哈希 → 相同替换决策 → API 请求前缀字节相同 → prompt cache 命中）
  ? cloneFileStateCache(toolUseContext.readFileState)
  // SubAgent：全新缓存（4MB 上限），独立于父 Agent 的文件读取历史
  : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
```

### 8.3 setAppState 路由策略

```
父 Agent
│ toolUseContext.setAppState       → 主 REPL 的 setState（真实更新 UI）
│ toolUseContext.setAppStateForTasks → 同上（若存在）
│
├─► 同步 SubAgent
│   │ agentToolUseContext.setAppState = 共享父的 setAppState
│   │ agentToolUseContext.setAppStateForTasks = 父的 setAppStateForTasks
│   └─► SubAgent 的 hooks/todos 可直接更新父 UI
│
└─► 异步 SubAgent
    │ agentToolUseContext.setAppState = no-op 函数
    │ agentToolUseContext.setAppStateForTasks = 父的 setAppStateForTasks（根状态）
    └─► SubAgent 不能更新父 UI，但可通过 rootSetAppState 写 tasks/todos 等根状态
```

**`rootSetAppState` 获取逻辑：**

```typescript
// src/tools/AgentTool/runAgent.ts:380
// 嵌套异步 Agent 时，toolUseContext.setAppState 已经是 no-op
// setAppStateForTasks 始终指向根 AppState（主 REPL 的 setState）
const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
```

### 8.4 Worktree 隔离

```typescript
// src/tools/AgentTool/AgentTool.tsx:680
if (effectiveIsolation === 'worktree') {
  // 以 agentId 前 8 位作为 slug（唯一且简短）
  const slug = `agent-${earlyAgentId.slice(0, 8)}`
  worktreeInfo = await createAgentWorktree(slug)
}
```

**`createAgentWorktree` vs `createWorktreeForSession` 关键差异：**

| 维度 | `createWorktreeForSession` | `createAgentWorktree` |
|------|--------------------------|----------------------|
| 调用者 | `EnterWorktreeTool`（用户触发） | `AgentTool`（程序触发） |
| Session 管理 | 设置 `currentWorktreeSession` | 不设置（Agent worktree 无 session） |
| 恢复已有 | 直接复用 | 复用并 bump mtime（防被周期清理误删） |
| 结束处理 | `ExitWorktreeTool` | `cleanupWorktreeIfNeeded()` |
| 退出时机 | 用户主动退出 | Agent 完成时自动处理 |

**Worktree 清理逻辑：**
```typescript
const cleanupWorktreeIfNeeded = async () => {
  if (!worktreeInfo) return {}

  if (worktreeInfo.hookBased) {
    // Hook 创建的 worktree（外部 VCS 系统）→ 始终保留
    return { worktreePath }
  }

  if (worktreeInfo.headCommit) {
    const changed = await hasWorktreeChanges(worktreePath, headCommit)
    if (!changed) {
      // 无变更 → 删除 worktree（节省磁盘空间）
      await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot)
      // 清除 metadata 中的 worktreePath（防 resume 使用已删除目录）
      void writeAgentMetadata(asAgentId(earlyAgentId), { agentType, description })
      return {}
    }
  }

  // 有变更 → 保留 worktree，父 Agent 可后续合并
  logForDebugging(`Agent worktree has changes, keeping: ${worktreePath}`)
  return { worktreePath, worktreeBranch }
}
```

### 8.5 Sidechain Transcript（附链 Transcript）

每个 Agent 的消息都会记录到独立的 JSONL 文件，支持 resume 和 UI 展示。

```typescript
// 路径格式：~/.claude/projects/<base64-cwd>/subagents/<agentId>.jsonl
// （可选分组）~/.claude/projects/<hash>/subagents/workflows/<runId>/<agentId>.jsonl

// 初始消息批量记录（含历史消息）
void recordSidechainTranscript(initialMessages, agentId)

// 循环中增量追加（O(1) per message，链式 uuid 追踪）
await recordSidechainTranscript([message], agentId, lastRecordedUuid)

// 异步 Agent 输出文件：符号链接 → sidechain transcript JSONL
// 父 Agent 可通过 Read(outputFile) 读取实时进度
void initTaskOutputAsSymlink(agentId, getAgentTranscriptPath(asAgentId(agentId)))
```

---

## 9. 任务状态机

### 9.1 LocalAgentTask 状态机

```
       ┌─────────────────────────────────────────┐
       │              注册阶段                     │
       │  registerAsyncAgent()                    │
       │  status: 'running'                       │
       │  isBackgrounded: true（立即后台化）         │
       └──────────────────┬──────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │ 进度更新       │ SendMessage    │ 后台化/恢复
          ▼               ▼               ▼
    updateAgentProgress  pendingMessages  isBackgrounded 切换
    toolUseCount++       push message     retain 设置
    tokenCount 更新       （轮次边界排空）   evictAfter 设置
          │
          ├───────────────────────────────────────┐
          │ 成功                                   │ 失败              │ 中止
          ▼                                       ▼                   ▼
  completeAgentTask()                     failAgentTask()      killAsyncAgent()
  status: 'completed'                     status: 'failed'     status: 'killed'
  result = AgentToolResult                error = message      abortController.abort()
  evictAfter = now + 10s（!retain 时）
          │
          │ evictAfter 超时 && !retain
          ▼
     [GC 驱逐]
     updateTaskState → status: 'deleted'（逻辑删除）
```

### 9.2 InProcessTeammateTask 状态机

```
spawnInProcessTeammate()
       │ status: 'running'
       │ isIdle: false（初始有任务）
       ▼
┌──────────────────┐
│    执行 turn      │◄────────────────────────────────────┐
│  runAgent() 循环  │                                     │
└────────┬─────────┘                                     │
         │ turn 完成                                      │
         ▼                                               │
┌──────────────────┐                                     │
│  isIdle: true    │  等待下一个任务                       │
│  触发 onIdle     │◄── pendingUserMessages 到来 ─────────┘
│  回调通知 Leader  │
└────────┬─────────┘
         │
         ├── plan 模式需要审批
         │      awaitingPlanApproval: true
         │      [等待用户批准/拒绝]
         │
         ├── shutdownRequested = true
         │      [优雅等待当前 turn 完成后退出]
         │
         ├── abortController.abort()（强制终止）
         │      status: 'killed'
         │
         └── 完成所有工作
                status: 'completed'
                result = AgentToolResult
```

### 9.3 任务类型判断函数

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx:149
export function isLocalAgentTask(task: unknown): task is LocalAgentTaskState {
  return typeof task === 'object' && task !== null
    && 'type' in task && task.type === 'local_agent'
}

/**
 * 判断 LocalAgentTask 是否应在面板中显示（而非 spinner pill）。
 * 所有非 main-session 类型的 local_agent 任务都在面板中显示。
 * 这是面板/pill 过滤器的唯一权威断言——若此谓词变更，所有过滤器都必须同步更新。
 */
export function isPanelAgentTask(t: unknown): t is LocalAgentTaskState {
  return isLocalAgentTask(t) && t.agentType !== 'main-session'
}

// src/tasks/InProcessTeammateTask/types.ts:78
export function isInProcessTeammateTask(task: unknown): task is InProcessTeammateTaskState {
  return typeof task === 'object' && task !== null
    && 'type' in task && task.type === 'in_process_teammate'
}
```

---

## 10. 生命周期与资源清理

### 10.1 `runAgent` finally 块（完整资源清理）

```typescript
// src/tools/AgentTool/runAgent.ts:907
// 无论正常完成、中止（AbortError）还是其他错误，finally 块都会执行
} finally {

  // ① 清理 Agent 专属 MCP 服务器
  //    只清理 inline 定义（对象语法）的服务器，字符串引用的服务器是共享的不清理
  await mcpCleanup()

  // ② 清理 frontmatter hooks
  //    clearSessionHooks 移除所有以 agentId 为作用域的 hooks
  if (agentDefinition.hooks) {
    clearSessionHooks(rootSetAppState, agentId)
  }

  // ③ 清理 prompt cache 跟踪状态
  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    cleanupAgentTracking(agentId)
  }

  // ④ 释放文件状态缓存内存
  //    对 ForkAgent 而言，这是一份克隆的父缓存，可能较大
  agentToolUseContext.readFileState.clear()

  // ⑤ 释放消息数组内存
  //    ForkAgent 的 initialMessages 包含完整父历史，释放可降低 GC 压力
  //    尤其在 Whale session（数百个并发 Agent）中效果显著
  initialMessages.length = 0

  // ⑥ 从 Perfetto 追踪注册表移除
  //    防止层次树中出现僵尸节点
  unregisterPerfettoAgent(agentId)

  // ⑦ 清理 transcript 子目录映射
  clearAgentTranscriptSubdir(agentId)

  // ⑧ 清理 todos 条目（防 AppState 内存泄漏）
  //    每个调用过 TodoWrite 的 subagent 都在 AppState.todos 留下一个 key
  //    Whale session（292 agents）中这些孤立 key 会累积到数 GB
  rootSetAppState(prev => {
    if (!(agentId in prev.todos)) return prev
    const { [agentId]: _removed, ...todos } = prev.todos
    return { ...prev, todos }
  })

  // ⑨ 杀死 Agent 启动的后台 bash 任务
  //    防止 `run_in_background` Shell 循环在 Agent 结束后变成 PPID=1 僵尸进程
  killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)

  // ⑩ 清理 Monitor 任务（功能门控）
  if (feature('MONITOR_TOOL')) {
    killMonitorMcpTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
  }
}
```

### 10.2 `finalizeAgentTool` 函数

```typescript
// src/tools/AgentTool/agentToolUtils.ts:299
export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number           // Date.now() 在 AgentTool.call() 开始时记录
    agentType: string
    isAsync: boolean
  },
): AgentToolResult {
  // 1. 获取最后一条 assistant 消息
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)

  // 2. 提取文本内容（过滤 type='text' 块）
  //    若最后消息为纯 tool_use（循环中途退出），向上回溯找最近有文本的消息
  let content = lastAssistantMessage.message.content.filter(b => b.type === 'text')
  if (content.length === 0) {
    for (let i = agentMessages.length - 1; i >= 0; i--) {
      const m = agentMessages[i]
      if (m.type !== 'assistant') continue
      const textBlocks = m.message.content.filter(b => b.type === 'text')
      if (textBlocks.length > 0) { content = textBlocks; break }
    }
  }

  // 3. 统计 token 和工具调用次数
  const totalTokens = getTokenCountFromUsage(lastAssistantMessage.message.usage)
  const totalToolUseCount = countToolUses(agentMessages)

  // 4. 发送遥测事件（tengu_agent_tool_completed）
  logEvent('tengu_agent_tool_completed', {
    agent_type: agentType,
    model: resolvedAgentModel,
    prompt_char_count: prompt.length,
    response_char_count: content.length,
    assistant_message_count: agentMessages.length,
    total_tool_uses: totalToolUseCount,
    duration_ms: Date.now() - startTime,
    total_tokens: totalTokens,
    is_built_in_agent: isBuiltInAgent,
    is_async: isAsync,
  })

  // 5. 发送 cache eviction hint（提示推断层驱逐此 Agent 的 cache chain）
  const lastRequestId = lastAssistantMessage.requestId
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope: 'subagent_end',
      last_request_id: lastRequestId,
    })
  }

  // 6. 返回 AgentToolResult
  return {
    agentId,
    agentType,
    content,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message.usage,
  }
}
```

---

## 11. In-Process Teammate 体系

### 11.1 `spawnInProcessTeammate` 完整实现

```typescript
// src/utils/swarm/spawnInProcess.ts:104
export async function spawnInProcessTeammate(
  config: InProcessSpawnConfig,
  context: SpawnContext,
): Promise<InProcessSpawnOutput> {
  const { name, teamName, prompt, color, planModeRequired, model } = config
  const { setAppState } = context

  // 1. 生成确定性 agentId（"name@teamName" 格式）
  const agentId = formatAgentId(name, teamName)  // 如 "researcher@my-team"
  const taskId = generateTaskId('in_process_teammate')

  try {
    // 2. 创建独立 AbortController（不链接父，Leader ESC 不影响队友）
    const abortController = createAbortController()

    // 3. 获取父 session ID（用于 transcript 关联和 Perfetto 追踪）
    const parentSessionId = getSessionId()

    // 4. 构建 TeammateIdentity（存为 AppState 中的平铺数据）
    const identity: TeammateIdentity = {
      agentId,
      agentName: name,
      teamName,
      color,
      planModeRequired,
      parentSessionId,
    }

    // 5. 创建 TeammateContext（AsyncLocalStorage 的存储值）
    //    runWithTeammateContext(context, fn) 执行时，fn 内部的 AsyncLocalStorage.getStore() 返回此值
    const teammateContext = createTeammateContext({
      agentId, agentName: name, teamName, color,
      planModeRequired, parentSessionId, abortController,
    })

    // 6. Perfetto 追踪（可视化 Agent 层次：parentSessionId → agentId）
    if (isPerfettoTracingEnabled()) {
      registerPerfettoAgent(agentId, name, parentSessionId)
    }

    // 7. 构造 InProcessTeammateTaskState（初始状态）
    const description = `${name}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`
    const taskState: InProcessTeammateTaskState = {
      ...createTaskStateBase(taskId, 'in_process_teammate', description, context.toolUseId),
      type: 'in_process_teammate',
      status: 'running',
      identity,
      prompt,
      model,
      abortController,
      awaitingPlanApproval: false,
      spinnerVerb: sample(getSpinnerVerbs()),      // 随机 spinner 动词
      pastTenseVerb: sample(TURN_COMPLETION_VERBS), // 完成后显示的过去时动词
      permissionMode: planModeRequired ? 'plan' : 'default',
      isIdle: false,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      pendingUserMessages: [],
      messages: [],  // UI 消息历史（初始为空，appendCappedMessage 追加）
    }

    // 8. 注册清理回调（进程退出时优雅中止）
    const unregisterCleanup = registerCleanup(async () => {
      abortController.abort()  // 中止 Agent 循环
      // task 状态由执行循环检测到 abort 后自行更新
    })
    taskState.unregisterCleanup = unregisterCleanup

    // 9. 注册任务到 AppState（UI 可立即看到此任务）
    registerTask(taskState, setAppState)

    return {
      success: true,
      agentId,
      taskId,
      abortController,
      teammateContext,
    }
  } catch (error) {
    return { success: false, agentId, error: errorMessage(error) }
  }
}
```

### 11.2 AsyncLocalStorage 隔离机制

```
进程内（同一 Node.js 进程）

MainSession AsyncLocalStorage: undefined（主线程无队友上下文）
│
├─► spawnInProcessTeammate("researcher", "my-team", ...)
│   └─ createTeammateContext({ agentId: "researcher@my-team", ... })
│      → TeammateContext 对象（含 agentId、teamName、mailbox 等）
│
├─► runWithTeammateContext(teammateContext, async () => {
│     // ★ 此闭包内的所有代码（及其 await 链）：
│     // AsyncLocalStorage.getStore() === teammateContext
│     // isInProcessTeammate() → true
│     // getCurrentTeammateContext()?.agentId → "researcher@my-team"
│     //
│     await runAgent({ ... })  // 完整 Agent 循环
│       └─► query() → 工具调用 → 结果
│             ↓
│           队友执行任务（独立会话）
│   })
│
├─► runWithTeammateContext(另一个 context, async () => {
│     // 另一个队友的独立上下文
│   })
│
└─► 主线程（AsyncLocalStorage.getStore() === undefined）
    isInProcessTeammate() → false
    主线程 REPL 照常运行
```

### 11.3 队友消息传递（`injectUserMessageToTeammate`）

```typescript
// src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx:68
export function injectUserMessageToTeammate(
  taskId: string,
  message: string,
  setAppState: SetAppState,
): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    // 只接受运行中或空闲的队友（不接受终态）
    if (isTerminalTaskStatus(task.status)) {
      logForDebugging(`Dropping message for teammate task ${taskId}: status is "${task.status}"`)
      return task
    }
    return {
      ...task,
      // ① 加入 pendingUserMessages 队列（队友执行循环在轮次边界排空）
      pendingUserMessages: [...task.pendingUserMessages, message],
      // ② 同时加入 UI 消息历史（用户立即在 UI 中看到）
      messages: appendCappedMessage(
        task.messages,
        createUserMessage({ content: message }),
      ),
    }
  })
}
```

**`appendCappedMessage` 函数（防内存泄漏）：**

```typescript
// src/tasks/InProcessTeammateTask/types.ts:108
// 上限 TEAMMATE_MESSAGES_UI_CAP = 50 条（防 Whale session 内存爆炸）
export function appendCappedMessage<T>(prev: readonly T[] | undefined, item: T): T[] {
  if (!prev || prev.length === 0) return [item]
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    // 丢弃最旧的条目（FIFO），保持数组长度不超过上限
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  return [...prev, item]
}
```

---

## 12. 完整调用链路图

### 12.1 同步 SubAgent 调用链

```
用户输入 prompt
    │
    ▼ screens/REPL.tsx → main.tsx → handlePromptSubmit()
    │
    ▼ services/api/claude.ts：query() 主循环
    │ 调用 Anthropic API（streaming）
    │ 模型输出 tool_use: Agent(subagent_type="reviewer", prompt="...")
    │
    ▼ AgentTool.call()           [AgentTool.tsx:277]
    │ ✓ Swarm 权限检查
    │ ✓ 路由：SubAgent 路径（subagent_type 已指定）
    │ ✓ filterDeniedAgents → 找到 "reviewer" Agent 定义
    │ ✓ 检查 requiredMcpServers（如有）
    │ ✓ 组装 workerTools（permissionMode='acceptEdits'）
    │ ✓ 构建系统提示（selectedAgent.getSystemPrompt + enhanceWithEnvDetails）
    │ shouldRunAsync = false → 同步路径
    │
    ▼ runAgent()                 [runAgent.ts:290]
    │ 初始化 agentId、注册 Perfetto
    │ initialMessages = [user(prompt)]
    │ agentReadFileState = new FileStateCache()
    │ 获取 userContext（CLAUDE.md）、systemContext（git status）
    │ 构建 agentGetAppState 闭包
    │ resolveAgentTools() → resolvedTools
    │ getAgentSystemPrompt() → agentSystemPrompt
    │ agentAbortController = 共享父 abortController
    │ 执行 SubagentStart hooks → additionalContexts → 注入 initialMessages
    │ 注册 frontmatter hooks（isAgent=true）
    │ 初始化 Agent 专属 MCP（如有）
    │ createSubagentContext()
    │ recordSidechainTranscript(initialMessages, agentId)
    │
    ▼ query()                    [query.ts]
    │ streaming API 调用（子 Agent 的完整会话）
    │ 多轮 turn：模型 → 工具调用 → 工具结果 → 继续
    │ yield Message（assistant/user/progress/...）
    │
    ▼ runAgent for-await 循环
    │ 每条 Message → recordSidechainTranscript + yield
    │
    ▼ AgentTool.call() 收集 agentMessages
    │
    ▼ finalizeAgentTool()        [agentToolUtils.ts:299]
    │ 提取最终文本内容
    │ 统计 token 和工具调用次数
    │ logEvent('tengu_agent_tool_completed', ...)
    │ logEvent('tengu_cache_eviction_hint', ...)
    │
    ▼ 返回 { status: 'completed', content: [...], ... }
    │
    ▼ query() 主循环收到工具结果
    │ 作为 user message 注入，继续下一轮 API 调用
    │
    ▼ 父 Agent 基于子 Agent 结果继续执行
```

### 12.2 异步 SubAgent 调用链

```
AgentTool.call()             shouldRunAsync = true
    │
    ├─► 1. registerAsyncAgent()
    │      initTaskOutputAsSymlink(agentId, transcriptPath)
    │      new AbortController()（独立）
    │      taskState = { status:'running', isBackgrounded:true, ... }
    │      registerCleanup(() => killAsyncAgent(...))
    │      registerTask(taskState, setAppState)
    │      → AppState.tasks[agentId] = taskState
    │
    ├─► 2. rootSetAppState(name → agentId)（若 name 参数提供）
    │
    ├─► 3. void runWithAgentContext(...runAsyncAgentLifecycle({
    │          makeStream: (onCacheSafeParams) => runAgent({
    │            ...runAgentParams,
    │            override: { agentId, abortController },
    │            onCacheSafeParams
    │          }),
    │          enableSummarization: ...,
    │          getWorktreeResult: cleanupWorktreeIfNeeded,
    │          ...
    │      }))
    │      └─ [fire-and-forget：异步后台运行，不阻塞父 Agent]
    │
    ▼ 4. 立即返回
    { status: 'async_launched', agentId: 'xxx', outputFile: '/path/xxx.jsonl', ... }
    │
    ▼ 父 Agent 继续其 Query Loop turn...

─── 后台（并行运行）──────────────────────────────────────

runAsyncAgentLifecycle()
    │
    ├─► for await message of runAgent():
    │     │ updateAgentProgress(message, ...)
    │     │ → AppState.tasks[agentId].progress 更新
    │     │ 启动后台摘要服务（可选）
    │     │
    │     │ 可能收到 pendingMessages（来自 SendMessage）
    │     │ → 注入为 user message
    │
    ├─► 完成：
    │     finalizeAgentTool(agentMessages, agentId, metadata)
    │     completeAgentTask(result, rootSetAppState)
    │     → AppState.tasks[agentId] = { status:'completed', result, evictAfter:now+10s }
    │
    ├─► 失败：
    │     failAgentTask(error, rootSetAppState)
    │     → AppState.tasks[agentId] = { status:'failed', error }
    │
    └─► enqueueAgentNotification()
            → 向父 Agent 的消息队列注入 <task-notification> XML
            → 父 Agent 在下一个空闲 turn 的 user message 中收到通知
```

### 12.3 ForkAgent 并行调用链（prompt cache 优化）

```
父 Agent turn
│ 模型在单条 assistant 消息中输出多个 tool_use:
│ [Agent(fork1), Agent(fork2), Agent(fork3)]
│
│ Query Loop 并行处理所有 tool_use
│         │
├── AgentTool.call(fork1)      ├── AgentTool.call(fork2)      ├── AgentTool.call(fork3)
│   isForkPath = true          │   isForkPath = true          │   isForkPath = true
│   ✓ 递归防护检查              │   ✓ 递归防护检查              │   ✓ 递归防护检查
│   selectedAgent = FORK_AGENT │   selectedAgent = FORK_AGENT │   selectedAgent = FORK_AGENT
│                              │                              │
│   buildForkedMessages():      │   buildForkedMessages():      │   buildForkedMessages():
│   [                          │   [                          │   [
│     ...父历史,               │     ...父历史（相同）,        │     ...父历史（相同）,
│     assistant([tu1,tu2,tu3]),│     assistant([tu1,tu2,tu3]),│     assistant([tu1,tu2,tu3]),
│     user([                   │     user([                   │     user([
│       result(tu1,"Fork..."), │       result(tu1,"Fork..."), │       result(tu1,"Fork..."),
│       result(tu2,"Fork..."), │       result(tu2,"Fork..."), │       result(tu2,"Fork..."),
│       result(tu3,"Fork..."), │       result(tu3,"Fork..."), │       result(tu3,"Fork..."),
│       <fork-boilerplate>     │       <fork-boilerplate>     │       <fork-boilerplate>
│       task1 指令             │       task2 指令             │       task3 指令
│     ])                       │     ])                       │     ])
│   ]                          │   ]                          │   ]
│                              │                              │
│   API Request:               │   API Request:               │   API Request:
│   系统提示=父渲染字节（相同）  │   系统提示=父渲染字节（相同） │   系统提示=父渲染字节（相同）
│   消息前缀=（相同）           │   消息前缀=（相同）           │   消息前缀=（相同）
│   ───────────────────────────│──────────────────────────────│──────────────────
│                              ▼ 三个请求共享同一 prompt cache 前缀
│                              → Cache Hit × 3（节省大量 input token 费用）
│
│   [三个 Fork 并行在后台运行]
│   [各自通过 <task-notification> 通知父 Agent]
│   [父 Agent 按任意顺序收到三条通知]
```

---

## 附录 A：关键常量

```typescript
// src/constants/tools.ts

// 所有 SubAgent（非主线程）禁止使用的工具
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  'TaskOutput',      // 防递归读取任务输出
  'ExitPlanMode',    // Plan 模式是主线程抽象（plan 模式队友特例除外）
  'EnterPlanMode',
  'Agent',           // 外部用户版本（ant 内部用户允许嵌套）
  'AskUserQuestion', // SubAgent 不能直接与终端用户交互
  'TaskStop',        // 需要主线程任务状态
])

// 异步 SubAgent 只能使用的工具白名单（防止后台 Agent 执行危险操作）
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  'Read',          // 文件读取
  'WebSearch',     // 网络搜索
  'TodoWrite',     // 任务列表
  'Grep',          // 文本搜索
  'WebFetch',      // 网络请求
  'Glob',          // 文件模式匹配
  'Bash',          // Shell 命令（仍需权限检查）
  'PowerShell',    // PowerShell 命令
  'Edit',          // 文件编辑
  'Write',         // 文件写入
  'NotebookEdit',  // Jupyter Notebook 编辑
  'Skill',         // Skill 执行
  'SyntheticOutput', // 结构化输出
  'ToolSearch',    // 工具搜索
  'EnterWorktree', // 进入 git worktree
  'ExitWorktree',  // 退出 git worktree
])

// 进程内队友额外允许的工具（在 ASYNC 白名单基础上）
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  'TaskCreate',    // 创建任务（协调用）
  'TaskGet',       // 读取任务
  'TaskUpdate',    // 更新任务
  'TaskList',      // 列出任务
])
```

## 附录 B：遥测事件

| 事件名 | 触发时机 | 关键字段 |
|--------|---------|---------|
| `tengu_agent_tool_selected` | `AgentTool.call()` 选定 Agent 后 | `agentType`, `model`, `source`, `isAsync`, `isFork`, `isBuiltIn` |
| `tengu_agent_tool_completed` | `finalizeAgentTool()` 完成时 | `agentType`, `model`, `duration_ms`, `total_tokens`, `total_tool_uses`, `prompt_char_count` |
| `tengu_cache_eviction_hint` | `finalizeAgentTool()` 完成时 | `scope='subagent_end'`, `last_request_id` |
| `tengu_agent_memory_loaded` | SubAgent 加载 `memory` 字段时 | `agentType`, `scope`, `source='subagent'` |

## 附录 C：相关源文件索引

| 文件路径 | 核心职责 |
|---------|---------|
| `src/tools/AgentTool/AgentTool.tsx` | `AgentTool` 定义、`call()` 方法、路由决策（SubAgent/Fork/Teammate） |
| `src/tools/AgentTool/runAgent.ts` | `runAgent()` 异步生成器、Agent 执行核心、资源清理 |
| `src/tools/AgentTool/agentToolUtils.ts` | `resolveAgentTools()`、`filterToolsForAgent()`、`finalizeAgentTool()`、`AgentToolResult` 类型 |
| `src/tools/AgentTool/loadAgentsDir.ts` | Agent 定义加载、`AgentDefinition` 接口 |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | 异步 Agent 任务管理：`registerAsyncAgent()`、`completeAgentTask()`、`updateAgentProgress()` |
| `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` | 进程内队友任务管理：消息注入、状态更新 |
| `src/tasks/InProcessTeammateTask/types.ts` | `InProcessTeammateTaskState`、`TeammateIdentity`、`appendCappedMessage()` |
| `src/utils/swarm/spawnInProcess.ts` | `spawnInProcessTeammate()` 实现 |
| `src/utils/forkedAgent.ts` | `createSubagentContext()`、`CacheSafeParams` 类型 |
| `src/utils/teammateContext.ts` | `TeammateContext` 的 AsyncLocalStorage 管理 |
| `src/constants/tools.ts` | `ALL_AGENT_DISALLOWED_TOOLS`、`ASYNC_AGENT_ALLOWED_TOOLS`、`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` |
| `src/utils/sessionStorage.ts` | `recordSidechainTranscript()`、`writeAgentMetadata()`、`initTaskOutputAsSymlink()` |
| `src/utils/telemetry/perfettoTracing.ts` | Agent 层次树的 Perfetto 追踪注册/注销 |
