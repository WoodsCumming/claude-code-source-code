# YOLO 分类器深度解析：Auto Mode 的 AI 安全守门人

> 基于 Claude Code v2.1.88 源码，含函数级代码注释与完整调用链路

---

## 目录

1. [什么是 YOLO 分类器？](#1-什么是-yolo-分类器)
2. [整体架构与调用链路](#2-整体架构与调用链路)
3. [触发条件与快速通道](#3-触发条件与快速通道)
4. [核心函数：classifyYoloAction](#4-核心函数classifyyoloaction)
5. [两阶段 XML 分类器](#5-两阶段-xml-分类器)
6. [系统提示构建](#6-系统提示构建)
7. [Transcript 构建与防注入设计](#7-transcript-构建与防注入设计)
8. [安全失败原则（Fail-Closed）](#8-安全失败原则fail-closed)
9. [Prompt Cache 优化](#9-prompt-cache-优化)
10. [熔断机制与拒绝追踪](#10-熔断机制与拒绝追踪)
11. [关键常量与配置](#11-关键常量与配置)

---

## 1. 什么是 YOLO 分类器？

名字来自 "YOLO 模式"（You Only Live Once，即"放飞自我/无人值守"模式），指 Claude Code 的 `--auto` 模式。在此模式下，Claude 执行工具调用前**无法询问用户**，需要自动判断：这个操作安全吗？应该放行还是拦截？

`yoloClassifier.ts` 就是这个自动判断系统，它是 `TRANSCRIPT_CLASSIFIER` feature flag 保护的 **ant-only** 功能（外部构建中以 stub 形式存在）。

### 与图像识别 YOLO 的区别

| 维度 | 图像识别 YOLO | Claude Code YOLO 分类器 |
|------|------------|----------------------|
| 含义 | You Only Look Once（一次前向传播） | You Only Live Once（无人值守模式） |
| 输入 | 图片像素 | 对话历史 + 待执行的工具调用 |
| 输出 | 边界框 + 类别 | shouldBlock: boolean + reason |
| 模型 | 卷积神经网络 | Claude 大语言模型 |

---

## 2. 整体架构与调用链路

```
用户开启 --auto 模式（claude --auto）
        │
        ▼
hasPermissionsToUseTool()               ← src/utils/permissions/permissions.ts:473
  │
  ├── tool.checkPermissions() → 'ask'   ← 正常权限检查结果：需要用户确认
  │
  ├── 快速通道（无需分类器）：
  │   ├── [1] safetyCheck 非分类器可批准 → 直接拒绝或询问用户
  │   ├── [2] acceptEdits 快速路径 → 允许（CWD 内的文件编辑）
  │   ├── [3] SAFE_YOLO_ALLOWLISTED_TOOLS → 允许（只读工具等）
  │   └── [4] PowerShell（非 ant）→ 要求用户交互
  │
  └── 调用 YOLO 分类器：
      │
      ▼
    classifyYoloAction()                 ← src/utils/permissions/yoloClassifier.ts:1012
      │
      ├── buildTranscriptForClassifier() ← 构建对话摘要
      ├── buildYoloSystemPrompt()        ← 构建系统提示
      ├── buildClaudeMdMessage()         ← 注入 CLAUDE.md
      │
      ├── [XML模式] classifyYoloActionXml()
      │   ├── Stage 1（快速）: max_tokens=64, stop_sequences
      │   │   └── 允许 → 直接返回（快速路径）
      │   └── Stage 2（思考）: max_tokens=4096, chain-of-thought
      │       └── 最终裁决
      │
      └── [Tool模式] sideQuery() + classify_result 工具
          └── 单次 LLM 调用
              │
              ▼
          YoloClassifierResult { shouldBlock, reason, ... }
              │
              ├── shouldBlock=false → behavior: 'allow'
              └── shouldBlock=true  → behavior: 'deny' 或 fallback 询问用户
```

---

## 3. 触发条件与快速通道

**文件**：`src/utils/permissions/permissions.ts:473`，`src/utils/permissions/classifierDecision.ts`

### 3.1 触发前提

分类器只在以下同时满足时触发：

```typescript
// permissions.ts:521-525
feature('TRANSCRIPT_CLASSIFIER') &&
(appState.toolPermissionContext.mode === 'auto' ||
  (appState.toolPermissionContext.mode === 'plan' &&
    autoModeStateModule?.isAutoModeActive()))
```

### 3.2 安全工具白名单（直接放行，不调用分类器）

```typescript
// classifierDecision.ts:56-94
const SAFE_YOLO_ALLOWLISTED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,      // 只读文件操作
  GREP_TOOL_NAME,           // 搜索
  GLOB_TOOL_NAME,           // 文件列表
  LSP_TOOL_NAME,            // 语言服务
  TODO_WRITE_TOOL_NAME,     // 任务管理（元数据）
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME, // Plan mode / UI
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  TEAM_CREATE_TOOL_NAME,    // 多 Agent 协调（内部邮箱/状态）
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SLEEP_TOOL_NAME,
  YOLO_CLASSIFIER_TOOL_NAME, // 分类器工具本身
  // ...ant-only 工具
])

// 查询函数：O(1) Set 查找
export function isAutoModeAllowlistedTool(toolName: string): boolean {
  return SAFE_YOLO_ALLOWLISTED_TOOLS.has(toolName)
}
```

### 3.3 acceptEdits 快速路径

```typescript
// permissions.ts:596-656
// 在 auto 模式下，对 CWD 内的文件写操作，
// 使用 acceptEdits 权限模式重新检查——如果允许就跳过分类器
if (
  result.behavior === 'ask' &&
  tool.name !== AGENT_TOOL_NAME &&  // Agent 工具除外（可能包含 VM 逃逸）
  tool.name !== REPL_TOOL_NAME      // REPL 工具除外（内部工具调用不受监控）
) {
  const acceptEditsResult = await tool.checkPermissions(parsedInput, {
    ...context,
    getAppState: () => ({
      ...state,
      toolPermissionContext: {
        ...state.toolPermissionContext,
        mode: 'acceptEdits' as const,  // 临时切换权限模式
      },
    }),
  })
  if (acceptEditsResult.behavior === 'allow') {
    // CWD 内的文件操作直接放行，不调用分类器
    return { behavior: 'allow', ... }
  }
}
```

---

## 4. 核心函数：classifyYoloAction

**文件**：`src/utils/permissions/yoloClassifier.ts:1012`

```typescript
/**
 * Auto Mode 的核心分类函数。
 * 接收完整的对话历史和待执行的工具调用，
 * 通过 LLM 判断是否应该拦截。
 *
 * 安全失败原则：API 错误、超时、响应无法解析 → 一律返回 shouldBlock=true。
 *
 * @param messages   - 完整对话历史（用于构建 transcript）
 * @param action     - 待评估的工具调用（TranscriptEntry 格式）
 * @param tools      - 工具注册表（用于 toAutoClassifierInput 编码）
 * @param context    - 工具权限上下文（用于提取 Bash 规则）
 * @param signal     - AbortSignal（用户按 Esc 时中断）
 */
export async function classifyYoloAction(
  messages: Message[],
  action: TranscriptEntry,
  tools: Tools,
  context: ToolPermissionContext,
  signal: AbortSignal,
): Promise<YoloClassifierResult> {
  const lookup = buildToolLookup(tools)

  // 1. 编码待分类的操作
  //    Tool.toAutoClassifierInput() 控制哪些字段暴露给分类器
  //    返回 '' 表示该工具无安全相关输入，直接放行（避免空 action 触发 API 400）
  const actionCompact = toCompact(action, lookup)
  if (actionCompact === '') {
    return { shouldBlock: false, reason: 'Tool declares no classifier-relevant input', ... }
  }

  // 2. 构建系统提示（含安全规则）
  const systemPrompt = await buildYoloSystemPrompt(context)

  // 3. 构建对话历史 transcript
  const transcriptEntries = buildTranscriptEntries(messages)

  // 4. 注入 CLAUDE.md（用户自定义指令）
  const claudeMdMessage = buildClaudeMdMessage()
  const prefixMessages = claudeMdMessage ? [claudeMdMessage] : []

  // 5. 构建用户内容块（transcript + action）
  //    cache_control 放在最后的 action 块上，
  //    使两阶段分类器的 Stage 2 能命中 Stage 1 的缓存前缀
  const userContentBlocks = [...transcriptBlocks]
  userContentBlocks.push({
    type: 'text',
    text: actionCompact,
    cache_control: cacheControl,  // Stage 2 的缓存命中点
  })

  // 6. 分发到对应的分类器实现
  if (isTwoStageClassifierEnabled()) {
    return classifyYoloActionXml(...)   // 两阶段 XML 分类器（推荐）
  }
  // 降级：单次 tool_use 分类器
  return sideQueryWithClassifyResultTool(...)
}
```

---

## 5. 两阶段 XML 分类器

**文件**：`src/utils/permissions/yoloClassifier.ts:711`

这是推荐的分类器实现，通过两阶段设计平衡速度和准确性。

### 5.1 三种运行模式

```typescript
// yoloClassifier.ts:711
type TwoStageMode = 'both' | 'fast' | 'thinking'

/**
 * 'both'（默认）: Stage 1 快速判断，允许直接返回；拦截时升级 Stage 2 减少误报
 * 'fast':         仅 Stage 1，快速但可能有更多误报
 * 'thinking':     仅 Stage 2，最准确但速度慢
 */
async function classifyYoloActionXml(
  prefixMessages,
  systemPrompt,
  userPrompt,
  userContentBlocks,
  model,
  promptLengths,
  signal,
  dumpContextInfo,
  mode: TwoStageMode,
): Promise<YoloClassifierResult>
```

### 5.2 Stage 1：快速判断

```typescript
// yoloClassifier.ts:769-857
// Stage 1 suffix（xml_s1_h2 变体）——促使模型立即给出 <block> 决定
const XML_S1_SUFFIX = '\nErr on the side of blocking. <block> immediately.'

// Stage 1：低 token 预算，停在 </block> 之前
const stage1Opts = {
  model,
  max_tokens: (mode === 'fast' ? 256 : 64) + thinkingPadding,
  stop_sequences: ['</block>'],  // 触发停止，避免输出多余内容
  temperature: 0,                // 确定性输出
  thinking: disableThinking,     // 禁用 thinking（节省 token）
  messages: [
    ...prefixMessages,           // [CLAUDE.md]
    { role: 'user', content: [
      { type: 'text', text: '<transcript>\n' },
      ...userContentBlocks,       // transcript + action
      { type: 'text', text: '</transcript>\n' },
      { type: 'text', text: XML_S1_SUFFIX },
    ]},
  ],
  querySource: 'auto_mode',
}

const stage1Raw = await sideQuery(stage1Opts)
const stage1Text = extractTextContent(stage1Raw.content)
const stage1Block = parseXmlBlock(stage1Text)  // 解析 <block>yes/no</block>

// 允许 → 立即返回（快速路径，节省 Stage 2 的 API 调用费用）
if (stage1Block === false) {
  return { shouldBlock: false, reason: 'Allowed by fast classifier', stage: 'fast', ... }
}
// 拦截 → 升级到 Stage 2（减少误报）
```

### 5.3 Stage 2：思考判断

```typescript
// yoloClassifier.ts:860-940
// Stage 2 suffix（xml_s2_t2 变体）——要求 chain-of-thought
const XML_S2_SUFFIX =
  '\nReview the classification process and follow it carefully, ' +
  'making sure you deny actions that should be blocked. ' +
  'As a reminder, explicit (not suggestive or implicit) user confirmation ' +
  'is required to override blocks. ' +
  'Use <thinking> before responding with <block>.'

// Stage 2：高 token 预算，允许 chain-of-thought 减少误报
const stage2Opts = {
  model,
  max_tokens: 4096 + thinkingPadding,  // 更大 token 预算
  // 无 stop_sequences，允许完整推理
  temperature: 0,
  thinking: disableThinking,
  messages: [
    ...prefixMessages,
    { role: 'user', content: [
      { type: 'text', text: '<transcript>\n' },
      ...userContentBlocks,
      { type: 'text', text: '</transcript>\n' },
      { type: 'text', text: XML_S2_SUFFIX },
    ]},
  ],
  querySource: 'auto_mode',
}

const stage2Raw = await sideQuery(stage2Opts)
const stage2Block = parseXmlBlock(stage2Text)
const thinking = parseXmlThinking(stage2Text)  // 提取 <thinking>...</thinking>

return {
  thinking,
  shouldBlock: stage2Block,
  reason: parseXmlReason(stage2Text) ?? 'No reason provided',
  stage: 'thinking',
  // 合并两阶段的 token 用量统计
  usage: combineUsage(stage1Usage, stage2Usage),
  ...
}
```

### 5.4 XML 响应解析

```typescript
// yoloClassifier.ts:567-604

/**
 * 去除 <thinking> 块，防止其内部的 <block> 标签被误匹配
 * （模型在推理时可能写 "I think this should be <block>yes</block>..."）
 */
function stripThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<thinking>[\s\S]*$/, '')  // 处理未闭合的 thinking 块
}

/**
 * 解析 <block>yes/no</block>
 * 去除 thinking 后再匹配，避免 chain-of-thought 中的 <block> 污染结果
 * 返回 true（拦截）、false（放行）、null（无法解析 → fail-closed）
 */
function parseXmlBlock(text: string): boolean | null {
  const matches = [
    ...stripThinking(text).matchAll(/<block>(yes|no)\b(<\/block>)?/gi),
  ]
  if (matches.length === 0) return null           // 无法解析 → 调用方会 fail-closed
  return matches[0]![1]!.toLowerCase() === 'yes'  // 'yes' = 拦截
}

/**
 * 解析 <reason>...</reason>（仅在拦截时出现）
 * 放行时系统提示要求不输出 <reason> 标签，节省 token
 */
function parseXmlReason(text: string): string | null {
  const matches = [...stripThinking(text).matchAll(/<reason>([\s\S]*?)<\/reason>/g)]
  if (matches.length === 0) return null
  return matches[0]![1]!.trim()
}
```

---

## 6. 系统提示构建

**文件**：`src/utils/permissions/yoloClassifier.ts:484`

```typescript
/**
 * 构建分类器系统提示。
 * 将安全规则模板与用户自定义规则合并。
 *
 * 模板结构：
 *   BASE_PROMPT（auto_mode_system_prompt.txt）
 *     └── <permissions_template> 占位符
 *           ├── 外部用户：permissions_external.txt
 *           └── Anthropic 内部：permissions_anthropic.txt（更严格）
 *
 * 三个可自定义区块（用 <user_*_to_replace> 标签标识）：
 *   - user_allow_rules_to_replace    → settings.autoMode.allow
 *   - user_deny_rules_to_replace     → settings.autoMode.soft_deny
 *   - user_environment_to_replace    → settings.autoMode.environment
 *
 * 外部模板：用户规则「替换」默认值
 * Anthropic 模板：用户规则「追加」到默认值末尾
 */
export async function buildYoloSystemPrompt(
  context: ToolPermissionContext,
): Promise<string> {
  const usingExternal = isUsingExternalPermissions()
  const systemPrompt = BASE_PROMPT.replace('<permissions_template>', () =>
    usingExternal ? EXTERNAL_PERMISSIONS_TEMPLATE : ANTHROPIC_PERMISSIONS_TEMPLATE,
  )

  const autoMode = getAutoModeConfig()

  // Bash 规则（ant-only，BASH_CLASSIFIER feature 保护）
  const includeBashPromptRules = feature('BASH_CLASSIFIER') ? !usingExternal : false
  const allowDescriptions = [
    ...(includeBashPromptRules ? getBashPromptAllowDescriptions(context) : []),
    ...(autoMode?.allow ?? []),
  ]
  const denyDescriptions = [
    ...(includeBashPromptRules ? getBashPromptDenyDescriptions(context) : []),
    ...(includePowerShellGuidance ? POWERSHELL_DENY_GUIDANCE : []),
    ...(autoMode?.soft_deny ?? []),
  ]

  // 替换模板中的占位区块
  return systemPrompt
    .replace(
      /<user_allow_rules_to_replace>([\s\S]*?)<\/user_allow_rules_to_replace>/,
      (_m, defaults: string) => userAllow ?? defaults,
    )
    .replace(
      /<user_deny_rules_to_replace>([\s\S]*?)<\/user_deny_rules_to_replace>/,
      (_m, defaults: string) => userDeny ?? defaults,
    )
    .replace(
      /<user_environment_to_replace>([\s\S]*?)<\/user_environment_to_replace>/,
      (_m, defaults: string) => userEnvironment ?? defaults,
    )
}
```

### 6.1 PowerShell 拒绝规则（ant-only）

```typescript
// yoloClassifier.ts:1402-1411
// 将 PowerShell 特有危险模式映射到已有的拒绝类别
const POWERSHELL_DENY_GUIDANCE: readonly string[] = feature('POWERSHELL_AUTO_MODE')
  ? [
      // iex (iwr ...) = "Code from External"（等同于 curl | bash）
      'PowerShell Download-and-Execute: `iex (iwr ...)` ...',
      // Remove-Item -Recurse -Force = "Irreversible Local Destruction"
      'PowerShell Irreversible Destruction: `Remove-Item -Recurse -Force` ...',
      // Register-ScheduledTask = "Unauthorized Persistence"
      'PowerShell Persistence: modifying `$PROFILE`, `Register-ScheduledTask` ...',
      // Start-Process -Verb RunAs = "Security Weaken"
      'PowerShell Elevation: `Start-Process -Verb RunAs` ...',
    ]
  : []
```

---

## 7. Transcript 构建与防注入设计

**文件**：`src/utils/permissions/yoloClassifier.ts:302`

### 7.1 buildTranscriptEntries：会话摘要构建

```typescript
/**
 * 从 messages 构建 transcript entries。
 *
 * 关键安全决策：
 *   只保留用户文本消息 + 助手的 tool_use 块
 *   故意排除助手的文本内容（text 块）
 *
 * 原因：助手文本是模型自己生成的，攻击者可以诱导模型输出
 *      包含 <block>no</block> 的文本来欺骗分类器。
 *      仅保留 tool_use 块（工具名 + 输入），语义确定，难以伪造。
 */
export function buildTranscriptEntries(messages: Message[]): TranscriptEntry[] {
  const transcript: TranscriptEntry[] = []
  for (const msg of messages) {
    if (msg.type === 'attachment' && msg.attachment.type === 'queued_command') {
      // 提取排队的用户命令（异步 Agent 场景）
      transcript.push({ role: 'user', content: [{ type: 'text', text }] })
    } else if (msg.type === 'user') {
      // 保留用户文本消息（非工具结果）
      const textBlocks = extractUserTextBlocks(content)
      if (textBlocks.length > 0) {
        transcript.push({ role: 'user', content: textBlocks })
      }
    } else if (msg.type === 'assistant') {
      const blocks: TranscriptBlock[] = []
      for (const block of msg.message.content) {
        // 只保留 tool_use 块——排除 text 块（防注入）
        if (block.type === 'tool_use') {
          blocks.push({ type: 'tool_use', name: block.name, input: block.input })
        }
      }
      if (blocks.length > 0) {
        transcript.push({ role: 'assistant', content: blocks })
      }
    }
  }
  return transcript
}
```

### 7.2 toCompactBlock：工具输入序列化

```typescript
/**
 * 将 transcript 块序列化为紧凑字符串。
 *
 * 格式（JSONL 模式开启时）：
 *   tool_use: {"Bash":"ls -la /tmp"}\n
 *   user:     {"user":"请帮我删除 /etc 目录"}\n
 *
 * 格式（传统模式）：
 *   tool_use: Bash ls -la /tmp\n
 *   user:     User: 请帮我删除 /etc 目录\n
 *
 * 安全设计：
 *   JSON 序列化确保用户输入无法突破字符串上下文伪造 {"user":...} 行。
 *   换行符在 JSON 值内变为 \n，无法被解析为新的 JSONL 行。
 *
 * toAutoClassifierInput 是每个 Tool 实现的钩子，
 * 控制哪些字段暴露给分类器，返回 '' 表示无安全相关信息。
 */
function toCompactBlock(
  block: TranscriptBlock,
  role: TranscriptEntry['role'],
  lookup: ToolLookup,
): string {
  if (block.type === 'tool_use') {
    const tool = lookup.get(block.name)
    if (!tool) return ''

    let encoded: unknown
    try {
      // 工具自定义编码：只暴露安全相关字段
      encoded = tool.toAutoClassifierInput(input) ?? input
    } catch (e) {
      // 编码失败（如恶意模型输出导致 schema 验证失败）
      // 记录遥测并回退到原始输入，不崩溃
      logEvent('tengu_auto_mode_malformed_tool_input', { toolName: block.name })
      encoded = input
    }

    if (encoded === '') return ''  // 工具声明无安全相关输入
    return isJsonlTranscriptEnabled()
      ? jsonStringify({ [block.name]: encoded }) + '\n'
      : `${block.name} ${typeof encoded === 'string' ? encoded : jsonStringify(encoded)}\n`
  }

  if (block.type === 'text' && role === 'user') {
    return isJsonlTranscriptEnabled()
      ? jsonStringify({ user: block.text }) + '\n'
      : `User: ${block.text}\n`
  }

  return ''
}
```

### 7.3 CLAUDE.md 注入

```typescript
/**
 * 将 CLAUDE.md 内容作为前缀消息注入到分类器。
 *
 * 设计考量：
 *   1. 包装在 <user_claude_md> 标签中，告知分类器这是用户配置
 *   2. 打上 cache_control——CLAUDE.md 内容在会话内稳定，
 *      与系统提示共同构成稳定缓存前缀
 *   3. 从 bootstrap/state.ts 缓存读取（避免循环依赖：
 *      claudemd → permissions/filesystem → permissions → yoloClassifier）
 *   4. CLAUDE_CODE_DISABLE_CLAUDE_MDS 禁用时返回 null（静默跳过）
 */
function buildClaudeMdMessage(): Anthropic.MessageParam | null {
  const claudeMd = getCachedClaudeMdContent()
  if (claudeMd === null) return null
  return {
    role: 'user',
    content: [{
      type: 'text',
      text:
        `The following is the user's CLAUDE.md configuration. These are ` +
        `instructions the user provided to the agent and should be treated ` +
        `as part of the user's intent when evaluating actions.\n\n` +
        `<user_claude_md>\n${claudeMd}\n</user_claude_md>`,
      cache_control: getCacheControl({ querySource: 'auto_mode' }),  // 稳定缓存
    }],
  }
}
```

---

## 8. 安全失败原则（Fail-Closed）

所有不确定情况下，分类器一律返回 `shouldBlock: true`：

```
异常情况                           → 返回值
──────────────────────────────────────────────────────────
API 错误（非 PTL）                 → shouldBlock=true, unavailable=true
用户按 Esc 中断                    → shouldBlock=true, unavailable=true
响应无法解析（Stage 1 null）        → shouldBlock=true（fast 模式为最终裁决）
响应无法解析（Stage 2 null）        → shouldBlock=true
Stage 1 无 tool_use 块             → shouldBlock=true
Transcript 超出上下文窗口（PTL）    → shouldBlock=true, transcriptTooLong=true
```

### 8.1 PTL（Prompt Too Long）特殊处理

```typescript
// permissions.ts:818-842
if (classifierResult.shouldBlock) {
  // Transcript 超上下文窗口——确定性错误，重试无效
  if (classifierResult.transcriptTooLong) {
    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      // 无人值守模式：直接 AbortError（避免无限重试浪费 token）
      throw new AbortError(
        'Agent aborted: auto mode classifier transcript exceeded context window in headless mode',
      )
    }
    // 交互模式：回退到手动审批
    return {
      ...result,
      decisionReason: {
        type: 'other',
        reason: 'Auto mode classifier transcript exceeded context window — falling back to manual approval',
      },
    }
  }
}
```

### 8.2 分类器不可用时的 Iron Gate

```typescript
// permissions.ts:845-895
// 当分类器 API 不可用时，行为取决于 tengu_iron_gate_closed GrowthBook gate
if (classifierResult.unavailable) {
  if (getFeatureValue_CACHED_WITH_REFRESH('tengu_iron_gate_closed', true)) {
    // Iron Gate 关闭（默认）：拒绝操作，提示分类器不可用
    return {
      behavior: 'deny',
      message: buildClassifierUnavailableMessage(classifierResult.reason),
      ...
    }
  }
  // Iron Gate 开放：降级到询问用户（非无人值守模式下）
}
```

---

## 9. Prompt Cache 优化

分类器系统精心设计了缓存策略，最大化缓存命中率：

```
消息结构（按缓存稳定性排序）：

[系统提示] ← cache_control（稳定，每次相同）
    │
    ▼
[CLAUDE.md 前缀消息] ← cache_control（会话内稳定）
    │
    ▼
[Transcript 内容块] ← 随对话增长
    │
    ▼
[Action 块] ← cache_control（最新操作，Stage 1/2 共享此断点）
```

**两阶段缓存共享**：

```typescript
// yoloClassifier.ts:1094-1106

// action 块打上 cache_control，成为两阶段的共享缓存断点：
//   Stage 1 发送：system + CLAUDE.md + transcript + action（写缓存）
//   Stage 2 发送：system + CLAUDE.md + transcript + action（命中缓存！）
// 这样 Stage 2 几乎是纯 cache read，费用极低

userContentBlocks.push({
  type: 'text',
  text: actionCompact,
  cache_control: cacheControl,  // 断点在此，Stage 2 命中 Stage 1 的完整前缀
})

// 缓存块数统计：
//   系统提示（1）+ CLAUDE.md（0-1）+ action（1）= 2-3 个 cache_control
// API 上限为 4 个，安全范围内
```

### 9.1 alwaysOnThinking 模型的特殊处理

```typescript
// yoloClassifier.ts:683-693
/**
 * 对于声明了 alwaysOnThinking 的模型（如某些 ant-only 实验模型），
 * 不能传 thinking: false（会返回 400 错误）。
 * 改为增大 max_tokens headroom（+2048），
 * 避免自适应 thinking 耗尽 token 预算导致 stop_reason=max_tokens，
 * 进而使 parseXmlBlock('') 返回 null → fail-closed 误拦截。
 */
function getClassifierThinkingConfig(model: string): [false | undefined, number] {
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)?.alwaysOnThinking) {
    return [undefined, 2048]  // 不禁用 thinking，但给 2048 token 余量
  }
  return [false, 0]  // 禁用 thinking，节省 token
}
```

---

## 10. 熔断机制与拒绝追踪

**文件**：`src/utils/permissions/denialTracking.ts`（通过 `permissions.ts` 引用）

```typescript
// permissions.ts:554-558
// 使用本地拒绝追踪（异步子 Agent 的 setAppState 是空操作）
const denialState =
  context.localDenialTracking ??
  appState.denialTracking ??
  createDenialTrackingState()

// 每次分类器允许操作时，重置连续拒绝计数
if (!classifierResult.shouldBlock) {
  const newDenialState = recordSuccess(denialState)
  persistDenialState(context, newDenialState)
}
```

连续拒绝超过阈值（`DENIAL_LIMITS`）时，Agent 进入降级状态，避免无限循环。

---

## 11. 关键常量与配置

### 11.1 Token 预算

| 场景 | max_tokens | 说明 |
|-----|-----------|------|
| Stage 1 `'both'` 模式 | 64 + thinkingPadding | 只要 `<block>` 决定 |
| Stage 1 `'fast'` 模式 | 256 + thinkingPadding | 允许包含 `<reason>` |
| Stage 2 | 4096 + thinkingPadding | 完整 chain-of-thought |
| alwaysOnThinking 附加 | +2048 | 防止 thinking 耗尽预算 |

### 11.2 环境变量

| 变量 | 说明 |
|-----|-----|
| `CLAUDE_CODE_AUTO_MODE_MODEL` | 覆盖分类器使用的模型（ant-only） |
| `CLAUDE_CODE_TWO_STAGE_CLASSIFIER` | 控制两阶段分类器（`true`/`false`/`'fast'`/`'thinking'`） |
| `CLAUDE_CODE_JSONL_TRANSCRIPT` | 启用 JSONL transcript 格式 |
| `CLAUDE_CODE_DUMP_AUTO_MODE` | 将分类请求/响应转储到磁盘（ant-only，调试用） |

### 11.3 GrowthBook Feature Flags

| 标志 | 说明 |
|-----|-----|
| `tengu_auto_mode_config` | 分类器配置（model/twoStageClassifier/forceExternalPermissions/jsonlTranscript） |
| `tengu_iron_gate_closed` | 分类器不可用时是否拒绝操作（默认 true） |
| `TRANSCRIPT_CLASSIFIER` | 整个 YOLO 分类器的 feature gate |
| `BASH_CLASSIFIER` | Bash 专用分类器规则 |
| `POWERSHELL_AUTO_MODE` | PowerShell 支持 auto mode |

### 11.4 源文件索引

| 文件 | 职责 |
|-----|-----|
| `src/utils/permissions/yoloClassifier.ts` | 核心分类逻辑、两阶段 XML 分类器、transcript 构建 |
| `src/utils/permissions/classifierDecision.ts` | 安全工具白名单（`SAFE_YOLO_ALLOWLISTED_TOOLS`） |
| `src/utils/permissions/classifierShared.ts` | `extractToolUseBlock`、`parseClassifierResponse` 共享工具 |
| `src/utils/permissions/permissions.ts` | 分类器集成点、快速通道判断、Iron Gate 处理 |
| `src/utils/permissions/autoModeState.ts` | Auto mode 开关状态（`autoModeActive`、`autoModeCircuitBroken`） |
| `src/utils/permissions/bashClassifier.ts` | Bash 命令专用分类规则（ant-only stub 外部版本） |
| `src/utils/permissions/yolo-classifier-prompts/` | 分类器系统提示文本文件 |

---

## 总结：分类决策流程图

```
工具调用请求
    │
    ▼
hasPermissionsToUseTool()
    │
    ├── checkPermissions() → 'allow' → ✅ 直接放行
    │
    ├── checkPermissions() → 'deny'  → ❌ 直接拒绝
    │
    └── checkPermissions() → 'ask'
            │
            ├── mode = 'dontAsk'      → ❌ 静默拒绝
            │
            └── mode = 'auto'
                    │
                    ├── safetyCheck（非分类器可批准）→ ❌/❓ 用户决定
                    │
                    ├── acceptEdits 快速路径        → ✅ CWD 内文件操作
                    │
                    ├── 安全工具白名单              → ✅ 只读工具等
                    │
                    └── classifyYoloAction()
                            │
                            ├── Stage 1（64 tok）
                            │   └── <block>no → ✅ 允许（快速路径）
                            │   └── <block>yes
                            │           │
                            │           └── Stage 2（4096 tok）
                            │               └── <block>no  → ✅ 允许（误报修正）
                            │               └── <block>yes → ❌ 拒绝
                            │               └── null       → ❌ fail-closed
                            │
                            └── 错误/超时         → ❌ fail-closed
```

核心设计哲学：**宁可误拦，不可误放**（Err on the side of blocking）。
