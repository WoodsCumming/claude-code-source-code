// Union of all concrete task state types
// Use this for components that need to work with any task type

import type { DreamTaskState } from './DreamTask/DreamTask.js'
import type { InProcessTeammateTaskState } from './InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from './LocalShellTask/guards.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from './MonitorMcpTask/MonitorMcpTask.js'
import type { RemoteAgentTaskState } from './RemoteAgentTask/RemoteAgentTask.js'

/**
    任务类型全景
    支撑多 Agent 协作的是 7 种任务类型（src/tasks/types.ts）：
    任务类型	运行位置	状态管理	适用场景
    LocalAgentTask	本地子进程	LocalAgentTaskState	标准子 Agent 任务
    LocalShellTask	本地 shell	LocalShellTaskState	后台 shell 命令
    InProcessTeammateTask	同进程内	InProcessTeammateTaskState	轻量级进程内队友
    RemoteAgentTask	远程服务器	RemoteAgentTaskState	分布式 Agent（CCR）
    DreamTask	后台静默	DreamTaskState	后台自主整理记忆
    LocalWorkflowTask	本地	LocalWorkflowTaskState	工作流编排
    MonitorMcpTask	本地	MonitorMcpTaskState	MCP 监控任务

    InProcessTeammateTask 与 LocalAgentTask 的关键差异：前者共享进程的内存空间和基础设施状态（如 MCP 连接池），但有独立的对话上下文和工具权限；后者是完全隔离的子进程，启动开销更大但更安全。
 */

export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

// Task types that can appear in the background tasks indicator
export type BackgroundTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

/**
 * Check if a task should be shown in the background tasks indicator.
 * A task is considered a background task if:
 * 1. It is running or pending
 * 2. It has been explicitly backgrounded (not a foreground task)
 */
export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') {
    return false
  }
  // Foreground tasks (isBackgrounded === false) are not yet "background tasks"
  if ('isBackgrounded' in task && task.isBackgrounded === false) {
    return false
  }
  return true
}
