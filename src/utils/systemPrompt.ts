import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { isEnvTruthy } from './envUtils.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

export { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

// Dead code elimination: conditional import for proactive mode.
// Same pattern as prompts.ts — lazy require to avoid pulling the module
// into non-proactive builds.
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

function isProactiveActive_SAFE_TO_CALL_ANYWHERE(): boolean {
  return proactiveModule?.isProactiveActive() ?? false
}

/**
 * Builds the effective system prompt array based on priority:
 * 0. Override system prompt (if set, e.g., via loop mode - REPLACES all other prompts)
 * 1. Coordinator system prompt (if coordinator mode is active)
 * 2. Agent system prompt (if mainThreadAgentDefinition is set)
 *    - In proactive mode: agent prompt is APPENDED to default (agent adds domain
 *      instructions on top of the autonomous agent prompt, like teammates do)
 *    - Otherwise: agent prompt REPLACES default
 * 3. Custom system prompt (if specified via --system-prompt)
 * 4. Default system prompt (the standard Claude Code prompt)
 *
 * Plus appendSystemPrompt is always added at the end if specified (except when override is set).
 */
// ! 在交互模式中，每次 turn 开始时，REPL 通过此函数决定最终使用哪个系统提示：
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,  // ! 当前激活的 agent 定义（可能为 undefined）
  toolUseContext,
  customSystemPrompt, // ! --system-prompt 参数（可能为 undefined）
  defaultSystemPrompt,  // ! getSystemPrompt() 的结果
  appendSystemPrompt, // ! --append-system-prompt 参数
  overrideSystemPrompt, // ! 
  /**
  循环模式覆盖（可能为 null）
})
│
├─ [优先级 0] overrideSystemPrompt 存在                  systemPrompt.ts:56
│   └─ return asSystemPrompt([overrideSystemPrompt])
│       └─ 完全替换，用于 loop 模式等特殊场景
│
├─ [优先级 1] feature('COORDINATOR_MODE') 且环境变量激活  systemPrompt.ts:62
│   └─ return asSystemPrompt([
│         getCoordinatorSystemPrompt(),   coordinatorMode.ts:111
│         appendSystemPrompt?,
│       ])
│
├─ [优先级 2] mainThreadAgentDefinition 存在              systemPrompt.ts:77
│   ├─ isBuiltInAgent → getSystemPrompt({ toolUseContext }) ← 内置 agent（需要 context）
│   └─ 自定义 agent → getSystemPrompt()                    ← 自定义 agent（无参数）
│
│   ├─ [子情况] Proactive/KAIROS 激活时                    systemPrompt.ts:103
│   │   └─ return asSystemPrompt([
│   │         ...defaultSystemPrompt,
│   │         `\n# Custom Agent Instructions\n${agentSystemPrompt}`,
│   │         appendSystemPrompt?,
│   │       ])
│   │       ← agent 指令追加到默认提示（不替换）
│   │
│   └─ [子情况] 普通 agent                                 systemPrompt.ts:115
│       └─ return asSystemPrompt([
│             agentSystemPrompt,          ← agent 提示替换默认提示
│             appendSystemPrompt?,
│           ])
│
├─ [优先级 3] customSystemPrompt 存在（--system-prompt）   systemPrompt.ts:115
│   └─ return asSystemPrompt([
│         customSystemPrompt,             ← 用户自定义提示替换默认提示
│         appendSystemPrompt?,
│       ])
│
└─ [优先级 4] 默认路径                                     systemPrompt.ts:115
    └─ return asSystemPrompt([
          ...defaultSystemPrompt,         ← getSystemPrompt() 的完整结果
          appendSystemPrompt?,
        ])
  */
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string | null
}): SystemPrompt {
  if (overrideSystemPrompt) {
    return asSystemPrompt([overrideSystemPrompt])
  }
  // Coordinator mode: use coordinator prompt instead of default
  // Use inline env check instead of coordinatorModule to avoid circular
  // dependency issues during test module loading.
  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) &&
    !mainThreadAgentDefinition
  ) {
    // Lazy require to avoid circular dependency at module load time
    const { getCoordinatorSystemPrompt } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')
    return asSystemPrompt([
      getCoordinatorSystemPrompt(),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  const agentSystemPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({
          toolUseContext: { options: toolUseContext.options },
        })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  // Log agent memory loaded event for main loop agents
  if (mainThreadAgentDefinition?.memory) {
    logEvent('tengu_agent_memory_loaded', {
      ...(process.env.USER_TYPE === 'ant' && {
        agent_type:
          mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      scope:
        mainThreadAgentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'main-thread' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // In proactive mode, agent instructions are appended to the default prompt
  // rather than replacing it. The proactive default prompt is already lean
  // (autonomous agent identity + memory + env + proactive section), and agents
  // add domain-specific behavior on top — same pattern as teammates.
  if (
    agentSystemPrompt &&
    (feature('PROACTIVE') || feature('KAIROS')) &&
    isProactiveActive_SAFE_TO_CALL_ANYWHERE()
  ) {
    return asSystemPrompt([
      ...defaultSystemPrompt,
      `\n# Custom Agent Instructions\n${agentSystemPrompt}`,
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  return asSystemPrompt([
    ...(agentSystemPrompt
      ? [agentSystemPrompt]
      : customSystemPrompt
        ? [customSystemPrompt]
        : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}
