# System Prompt vs User Prompt：各类内容的归属分析

> 基于 Claude Code v2.1.88 源码，详细梳理哪些内容进入 `system[]` 数组，哪些进入 `messages[]` 数组。

---

## 目录

1. [API 调用结构总览](#1-api-调用结构总览)
2. [System Prompt 的内容](#2-system-prompt-的内容)
3. [User Prompt（messages）的内容](#3-user-promptmessages-的内容)
4. [完整分类对照表](#4-完整分类对照表)
5. [组装流程时序](#5-组装流程时序)
6. [关键设计决策解析](#6-关键设计决策解析)

---

## 1. API 调用结构总览

**`src/services/api/claude.ts:1699`** 最终发出的 API 请求结构：

```typescript
anthropic.beta.messages.create({
  model: ...,
  system: buildSystemPromptBlocks(systemPrompt, ...),  // system[] 数组
  messages: addCacheBreakpoints(
    prependUserContext(messagesForQuery, userContext),   // messages[] 数组
    ...
  ),
  tools: allTools,
  ...
})
```

两个核心参数的组装路径完全不同：

```
getSystemPrompt()          ──┐
getSystemContext()           ├──► appendSystemContext() ──► system[]
getCLISyspromptPrefix()    ──┘

getUserContext()            ──► prependUserContext() ──► messages[0] (isMeta)
normalizeAttachmentForAPI() ──► messages[1..N] (isMeta)
用户实际输入                ──► messages[N+1]
```

---

## 2. System Prompt 的内容

### 2.1 主系统提示（`getSystemPrompt()`）

**来源：** `src/constants/prompts.ts:444`
**注入点：** `src/query.ts:469` → `appendSystemContext(systemPrompt, systemContext)`

主系统提示由 7 个静态区块 + 若干动态区块组成，全部进入 `system[]`：

| 区块 | 函数 | 行号 |
|------|------|------|
| 身份介绍 | `getSimpleIntroSection()` | `prompts.ts:175` |
| 系统行为规则 | `getSimpleSystemSection()` | `prompts.ts:186` |
| 任务执行规范 | `getSimpleDoingTasksSection()` | `prompts.ts:199` |
| 操作安全规范 | `getActionsSection()` | `prompts.ts:255` |
| 工具使用规范 | `getUsingYourToolsSection()` | `prompts.ts:269` |
| 语调与风格 | `getSimpleToneAndStyleSection()` | `prompts.ts:430` |
| 输出效率规范 | `getOutputEfficiencySection()` | `prompts.ts:403` |
| 会话特定指导 | `getSessionSpecificGuidanceSection()` | `prompts.ts:352` |
| **持久化记忆** | `loadMemoryPrompt()` | `prompts.ts:495` |
| 环境信息 | `computeSimpleEnvInfo()` | `prompts.ts:651` |
| 语言偏好 | `getLanguageSection()` | `prompts.ts:142` |
| MCP 服务器指令 | `getMcpInstructionsSection()` | `prompts.ts:160` |
| Scratchpad 指令 | `getScratchpadInstructions()` | `prompts.ts:797` |

### 2.2 系统上下文（`getSystemContext()`）

**来源：** `src/context.ts:116`
**注入点：** `src/query.ts:470` `appendSystemContext(systemPrompt, systemContext)`

```typescript
// appendSystemContext 的实现（api.ts:437）
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

`systemContext` 包含：

| 字段 | 内容 | 条件 |
|------|------|------|
| `gitStatus` | git 分支、状态、最近提交（`git status` + `git log` 输出） | 启用 git 指令且非 CCR 环境 |
| `cacheBreaker` | `[CACHE_BREAKER: <injection>]` | `feature('BREAK_CACHE_COMMAND')` 且有注入值（ant-only） |

**注意**：`gitStatus` 追加在系统提示末尾，不在静态缓存区块内（因为每次 git 状态可能不同），不影响全局 prompt cache。

### 2.3 身份前缀（`getCLISyspromptPrefix()`）

**来源：** `src/constants/system.ts:30`
**注入点：** `src/services/api/claude.ts:1361`

```typescript
systemPrompt = asSystemPrompt([
  getAttributionHeader(fingerprint),   // 归因头（cc_version, cc_entrypoint）
  getCLISyspromptPrefix({ ... }),       // "You are Claude Code..."
  ...systemPrompt,                      // 主系统提示内容
  ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
  ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
].filter(Boolean))
```

三种前缀根据运行模式选择：
- 标准交互：`"You are Claude Code, Anthropic's official CLI for Claude."`
- 非交互 + 有附加系统提示：`"...running within the Claude Agent SDK."`
- 非交互 + 无附加系统提示：`"You are a Claude agent, built on Anthropic's Claude Agent SDK."`

### 2.4 记忆（`loadMemoryPrompt()`）

**来源：** `src/memdir/memdir.ts`
**注入点：** `src/constants/prompts.ts:495`（动态区块，会话级缓存）

记忆系统的**指令**（如何读写 MEMORY.md、记忆类型定义）进入 `system[]`。这是一个重要的设计决策：记忆指令在系统提示中，而记忆文件的**实际内容**则通过 `relevant_memories` attachment 以 `<system-reminder>` 注入 `messages[]`（见第 3 节）。

### 2.5 Advisor 工具指令（`ADVISOR_TOOL_INSTRUCTIONS`）

**来源：** `src/services/api/claude.ts:150`（导入）
**注入点：** `src/services/api/claude.ts:1366`
**条件：** 启用 advisor 模型时

### 2.6 Chrome 工具指令（`CHROME_TOOL_SEARCH_INSTRUCTIONS`）

**来源：** `src/utils/claudeInChrome/prompt.ts`
**注入点：** `src/services/api/claude.ts:1367`
**条件：** 使用 tool search 且有 Chrome 工具且未启用 MCP delta

---

## 3. User Prompt（messages）的内容

### 3.1 用户上下文（`getUserContext()`）→ messages[0]

**来源：** `src/context.ts:155`
**注入点：** `src/query.ts:720` → `prependUserContext(messagesForQuery, userContext)`

```typescript
// prependUserContext 的实现（api.ts:449）
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  return [
    createUserMessage({
      content: `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
<CLAUDE.md 文件内容>

# currentDate
Today's date is 2026/04/10.

      IMPORTANT: this context may or may not be relevant to your tasks.
      You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
`,
      isMeta: true,   // ← 标记为系统生成，用户不可见
    }),
    ...messages,
  ]
}
```

`userContext` 包含：

| 字段 | 内容 | 说明 |
|------|------|------|
| `claudeMd` | 所有 CLAUDE.md 文件内容（cwd 向上遍历 + 附加目录） | 注入为 `messages[0]`，`isMeta: true` |
| `currentDate` | `Today's date is YYYY/MM/DD.` | 同上 |

**CLAUDE.md 为什么在 user prompt 而非 system prompt？**

CLAUDE.md 内容是**项目特定的**、**用户可修改的**，放在 `messages[0]` 有两个好处：
1. 不影响全局 prompt cache（system prompt 的全局缓存要求跨组织字节相同）
2. 语义上更接近"用户提供的上下文"而非"系统行为规则"

### 3.2 Attachments → messages（isMeta）

所有 attachment 类型通过 `normalizeAttachmentForAPI()` 转换为 user messages，以 `<system-reminder>` 包裹，`isMeta: true`。

**`src/utils/messages.ts:3453` `normalizeAttachmentForAPI()`**

#### 文件类 Attachments

| Attachment 类型 | 转换为 | 行号 |
|----------------|--------|------|
| `file`（图片） | `[tool_use(Read), tool_result(image)]` | `messages.ts:3549` |
| `file`（文本） | `[tool_use(Read), tool_result(text), ?truncation_notice]` | `messages.ts:3557` |
| `file`（notebook） | `[tool_use(Read), tool_result(notebook)]` | `messages.ts:3573` |
| `file`（PDF） | `[tool_use(Read), tool_result(pdf)]` | `messages.ts:3582` |
| `directory` | `[tool_use(Bash, ls), tool_result(listing)]` | `messages.ts:3526` |
| `compact_file_reference` | 文件过大提示 user message | `messages.ts:3593` |
| `pdf_reference` | PDF 大文件使用说明 user message | `messages.ts:3601` |
| `edited_text_file` | 文件被修改通知 user message | `messages.ts:3539` |

#### IDE 集成 Attachments

| Attachment 类型 | 内容 | 行号 |
|----------------|------|------|
| `selected_lines_in_ide` | 用户在 IDE 中选中的代码行 | `messages.ts:3613` |
| `opened_file_in_ide` | 用户在 IDE 中打开的文件 | `messages.ts:3629` |

#### 计划与技能 Attachments

| Attachment 类型 | 内容 | 行号 |
|----------------|------|------|
| `plan_file_reference` | Plan 模式下的计划文件内容 | `messages.ts:3637` |
| `invoked_skills` | 本会话中已调用的 skill 内容（用于续传） | `messages.ts:3644` |
| `skill_listing` | 可用 skill 列表 | `messages.ts:3732` |
| `skill_discovery` | 与当前任务相关的技能推荐（`EXPERIMENTAL_SKILL_SEARCH`） | `messages.ts:3507` |

#### 任务管理 Attachments

| Attachment 类型 | 内容 | 行号 |
|----------------|------|------|
| `todo_reminder` | TodoWrite 工具使用提醒 + 当前 todo 列表 | `messages.ts:3663` |
| `task_reminder` | Task 工具使用提醒 + 当前任务列表 | `messages.ts:3680` |
| `queued_command` | 队列中的命令（含 `task-notification`） | `messages.ts:3739` |

#### 记忆 Attachments

| Attachment 类型 | 内容 | 行号 |
|----------------|------|------|
| `nested_memory` | 嵌套记忆文件内容（`<system-reminder>` 包裹） | `messages.ts:3700` |
| `relevant_memories` | 与当前任务相关的记忆文件内容 | `messages.ts:3708` |

#### 多 Agent 协作 Attachments（功能门控）

| Attachment 类型 | 内容 | 条件 |
|----------------|------|------|
| `teammate_mailbox` | 队友发来的消息 | `isAgentSwarmsEnabled()` |
| `team_context` | 团队协作上下文（团队名、身份、任务列表路径） | `isAgentSwarmsEnabled()` |
| `agent_listing_delta` | Agent 类型列表增量更新 | `messages.ts:4194` |
| `mcp_instructions_delta` | MCP 服务器指令增量更新 | `messages.ts:4216` |

### 3.3 延迟工具列表（Deferred Tools）→ messages（isMeta）

**注入点：** `src/services/api/claude.ts:1337`
**条件：** 启用 tool search（`useToolSearch`）

```typescript
// 当 tool search 启用时，将可用工具列表注入为合成 user message
const deferredToolsMessage = createUserMessage({
  content: `<available-deferred-tools>\n${deferredToolNames.join('\n')}\n</available-deferred-tools>`,
  isMeta: true,
})
```

### 3.4 Task 通知（`<task-notification>`）→ messages（isMeta）

**来源：** `src/tasks/LocalAgentTask/LocalAgentTask.tsx:252`
**注入机制：** `enqueuePendingNotification()` → 下一轮对话作为 `queued_command` attachment 注入

```xml
<task-notification>
  <task-id>xxx</task-id>
  <output-file>/path/to/xxx.output</output-file>
  <status>completed</status>
  <summary>Agent "描述" completed</summary>
  <result>Fork 的最终报告</result>
  <usage>...</usage>
</task-notification>
```

以 `queued_command`（`commandMode: 'task-notification'`）的形式排队，下一轮通过 `normalizeAttachmentForAPI()` 转换为 user message，`isMeta: true`。

### 3.5 Hook 上下文（SubagentStart/UserPromptSubmit）→ messages（isMeta）

**来源：** `src/tools/AgentTool/runAgent.ts:546`

```typescript
if (additionalContexts.length > 0) {
  const contextMessage = createAttachmentMessage({
    type: 'hook_additional_context',
    content: additionalContexts,
    hookName: 'SubagentStart',
    ...
  })
  initialMessages.push(contextMessage)
}
```

用户配置的 hooks（如 `UserPromptSubmit`、`SubagentStart`）返回的附加上下文，以 `<system-reminder>` 包裹注入 user messages。

---

## 4. 完整分类对照表

| 内容 | 位置 | 格式 | 来源文件:行号 |
|------|------|------|--------------|
| **→ System Prompt** | | | |
| 身份声明 (`You are Claude Code...`) | system[0] | 纯文本 | `system.ts:10`，`claude.ts:1361` |
| 归因头（`cc_version`, `cc_entrypoint`） | system[0] 前 | 纯文本 | `system.ts:73`，`claude.ts:1360` |
| 主系统提示（7 个静态区块） | system[1..N] | 纯文本 | `prompts.ts:444` |
| 持久化记忆指令（MEMORY.md 读写规则） | system 动态区块 | 纯文本 | `prompts.ts:495`，`memdir.ts` |
| 会话特定指导 | system 动态区块 | 纯文本 | `prompts.ts:352` |
| 环境信息（CWD、平台、模型名、知识截止） | system 动态区块 | 纯文本 | `prompts.ts:651` |
| 语言偏好 | system 动态区块 | 纯文本 | `prompts.ts:142` |
| MCP 服务器指令 | system 动态区块 | 纯文本 | `prompts.ts:160` |
| Git 状态（分支、status、log） | system 末尾追加 | 纯文本 | `context.ts:124`，`query.ts:470` |
| Cache Breaker（ant-only） | system 末尾追加 | 纯文本 | `context.ts:131` |
| Advisor 工具指令 | system 末尾 | 纯文本 | `claude.ts:1366` |
| Chrome 工具指令 | system 末尾 | 纯文本 | `claude.ts:1367` |
| **→ User Prompt (messages)** | | | |
| CLAUDE.md 文件内容 | messages[0]（isMeta） | `<system-reminder>` | `context.ts:170`，`api.ts:449` |
| 当前日期 | messages[0]（isMeta） | `<system-reminder>` | `context.ts:186`，`api.ts:449` |
| 文件 attachment（图片/文本/PDF/notebook） | messages（isMeta） | tool_use + tool_result | `messages.ts:3545` |
| 目录 attachment | messages（isMeta） | tool_use(Bash ls) + tool_result | `messages.ts:3526` |
| IDE 选中代码行 | messages（isMeta） | `<system-reminder>` | `messages.ts:3621` |
| IDE 打开文件通知 | messages（isMeta） | `<system-reminder>` | `messages.ts:3629` |
| Plan 文件内容 | messages（isMeta） | `<system-reminder>` | `messages.ts:3637` |
| 已调用 Skill 内容（续传用） | messages（isMeta） | `<system-reminder>` | `messages.ts:3656` |
| Skill 列表 | messages（isMeta） | `<system-reminder>` | `messages.ts:3732` |
| 相关技能推荐（skill_discovery） | messages（isMeta） | `<system-reminder>` | `messages.ts:3507` |
| Todo 提醒 + 列表 | messages（isMeta） | `<system-reminder>` | `messages.ts:3673` |
| Task 提醒 + 列表 | messages（isMeta） | `<system-reminder>` | `messages.ts:3693` |
| 记忆文件实际内容（relevant_memories） | messages（isMeta） | `<system-reminder>` | `messages.ts:3708` |
| 嵌套记忆内容（nested_memory） | messages（isMeta） | `<system-reminder>` | `messages.ts:3700` |
| Task 完成通知（`<task-notification>`） | messages（isMeta） | XML | `LocalAgentTask.tsx:252` |
| 延迟工具列表（tool search） | messages（isMeta） | `<available-deferred-tools>` | `claude.ts:1337` |
| Agent 列表增量更新 | messages（isMeta） | `<system-reminder>` | `messages.ts:4194` |
| MCP 指令增量更新 | messages（isMeta） | `<system-reminder>` | `messages.ts:4216` |
| 队友消息（teammate_mailbox） | messages（isMeta） | 格式化文本 | `messages.ts:3457` |
| 团队协作上下文（team_context） | messages（isMeta） | `<system-reminder>` | `messages.ts:3468` |
| Hook 附加上下文 | messages（isMeta） | `<system-reminder>` | `runAgent.ts:546` |
| 用户实际输入 | messages（非 isMeta） | 纯文本 | — |

---

## 5. 组装流程时序

```
query() 调用时序（src/query.ts）
│
├─ 1. 获取系统上下文（并行）
│   ├─ getUserContext()          → { claudeMd, currentDate }
│   └─ getSystemContext()        → { gitStatus, cacheBreaker? }
│
├─ 2. 构建完整系统提示
│   │  query.ts:469
│   └─ fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
│       ├─ systemPrompt：来自 getSystemPrompt()（含记忆指令、环境信息等）
│       └─ systemContext：追加 gitStatus + cacheBreaker
│
├─ 3. 处理 messages（attachments → user messages）
│   │  query.ts 上游，messages 已含 normalizeAttachmentForAPI() 结果
│   └─ messagesForQuery：所有 attachment 已转换为 user messages
│
├─ 4. 发送 API 请求
│   │  query.ts:719
│   └─ callModel({
│         messages: prependUserContext(messagesForQuery, userContext),
│         │                           ↑ 在 messages 最前插入 claudeMd + currentDate
│         systemPrompt: fullSystemPrompt,
│         ...
│       })
│
└─ API 最终请求结构（claude.ts:1699）
    ├─ system: [
    │    "x-anthropic-billing-header: ...",  // 归因头
    │    "You are Claude Code...",            // 身份前缀
    │    <主系统提示 7 个静态区块>,
    │    <动态区块：记忆指令、环境信息、会话指导...>,
    │    "gitStatus: ...\ncacheBreaker: ...", // systemContext 追加
    │    "ADVISOR_TOOL_INSTRUCTIONS",         // 可选
    │  ]
    └─ messages: [
         { role: "user", content: "<system-reminder>claudeMd + currentDate</system-reminder>", isMeta: true },
         { role: "user", content: "<system-reminder>file attachment...</system-reminder>", isMeta: true },
         { role: "user", content: "<system-reminder>skill listing...</system-reminder>", isMeta: true },
         { role: "user", content: "<system-reminder>task reminder...</system-reminder>", isMeta: true },
         ...
         { role: "user", content: "用户实际输入" },           // 真实用户消息
         { role: "assistant", content: "..." },
         ...
       ]
```

---

## 6. 关键设计决策解析

### 6.1 为什么 CLAUDE.md 在 user prompt 而非 system prompt？

`getUserContext()` 的注释（`context.ts:152`）：
> This context is prepended to each conversation, and cached for the duration of the conversation.

CLAUDE.md 内容是**项目特定的**，每个用户/项目不同，放在 system prompt 会破坏全局 prompt cache（全局缓存要求跨组织字节相同）。放在 `messages[0]`（`isMeta: true`）则：
1. 不影响全局 cache 策略
2. 会话内稳定（memoize），不会每轮重新计算
3. 语义上属于"用户提供的项目指导"

### 6.2 为什么 gitStatus 在 system prompt 而非 user prompt？

`getSystemContext()` 的注释（`context.ts:116`）：
> 追加在 system prompt 末尾，而非 user context。

原因：git 状态是**环境信息**，属于 Claude 运行环境的一部分，与系统提示中的"环境信息区块"语义一致。同时，它追加在系统提示末尾（动态部分），不影响静态区块的缓存。

### 6.3 为什么记忆指令在 system prompt，而记忆内容在 user prompt？

- **记忆指令**（如何读写 MEMORY.md、记忆类型分类）：属于 Claude 的**行为规范**，应在 system prompt
- **记忆文件内容**（`relevant_memories` attachment）：属于**动态上下文**，每轮可能不同，以 `<system-reminder>` 包裹注入 user messages，保持 system prompt 缓存稳定

### 6.4 `isMeta: true` 的作用

标记为 `isMeta: true` 的 user messages：
- 对用户**不可见**（UI 不显示）
- 对 Claude **可见**（发送给 API）
- 通常包裹在 `<system-reminder>` 标签中，提示 Claude 这是系统注入的上下文
- 用于区分"人类输入"与"系统注入"，影响 transcript 显示、`getLastRealUserPrompt()` 等逻辑

### 6.5 `<system-reminder>` 标签的语义

Claude 的系统提示中有明确说明（`getSimpleSystemSection()`）：
> Tool results and user messages may include `<system-reminder>` or other tags. Tags contain information from the system. They bear no direct relation to the specific tool results or user messages in which they appear.

这个约定让 Claude 知道：`<system-reminder>` 内的内容是系统自动注入的，与周围的对话上下文无直接关联，应独立理解。

### 6.6 Agent 列表和 MCP 指令为什么从 system prompt 移到 user messages？

**`messages.ts:692`** 的注释说明：

> agent_listing_delta 的设计动机：动态 agent 列表曾占 fleet cache_creation tokens 的 10.2%。MCP 异步连接、/reload-plugins、权限模式变化都会改变列表 → 工具描述变化 → 完整工具模式缓存失效。

通过 `agent_listing_delta` attachment 注入 messages（而非嵌入工具描述），避免了每次 agent 列表变化导致的全量工具模式缓存失效。MCP 指令（`mcp_instructions_delta`）同理。
