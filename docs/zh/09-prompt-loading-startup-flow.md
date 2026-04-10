# 从程序启动到 Prompt 装载的完整调用路径

> 基于 Claude Code v2.1.88 源码，从 `node cli.js` 开始，追踪每一个 prompt 相关内容的装载时机、调用路径和行号。

---

## 目录

1. [总体时序概览](#1-总体时序概览)
2. [阶段一：CLI 入口与快速路径](#2-阶段一cli-入口与快速路径)
3. [阶段二：init() 初始化](#3-阶段二init-初始化)
4. [阶段三：main() 启动流程](#4-阶段三main-启动流程)
5. [阶段四：后台预取（startDeferredPrefetches）](#5-阶段四后台预取)
6. [阶段五：首次 turn 前的 prompt 组装](#6-阶段五首次-turn-前的-prompt-组装)
7. [阶段六：buildEffectiveSystemPrompt — 交互模式的系统提示决策](#7-阶段六buildeffectivesystemprompt)
8. [阶段七：QueryEngine.ask() — 每次 turn 的 prompt 组装](#8-阶段七queryengineask)
9. [完整调用链汇总](#9-完整调用链汇总)

---

## 1. 总体时序概览

```
node cli.js
    │
    ├─ [快速路径检测] --version / --dump-system-prompt / --daemon-worker ...
    │
    ├─ await init()                          ← 基础初始化（配置、认证、设置）
    │
    ├─ await main()                          ← 主程序入口
    │   │
    │   ├─ [并行] MDM设置 + Keychain 预取
    │   ├─ [并行] commands + agentDefinitions 加载
    │   ├─ [并行] MCP 配置解析
    │   │
    │   ├─ [非交互模式] void getSystemContext()   ← 预热 git status（后台）
    │   ├─ [非交互模式] void getUserContext()     ← 预热 CLAUDE.md（后台）
    │   │
    │   ├─ showSetupScreens()                ← 信任对话框（交互模式）
    │   │
    │   └─ [分叉]
    │       ├─ 交互模式 → REPL 渲染 → startDeferredPrefetches()
    │       └─ 非交互模式(-p) → print.ts → QueryEngine.ask()
    │
    └─ [用户输入 / 首次 turn]
        │
        ├─ processUserInput() → getAttachmentMessages()
        │
        └─ QueryEngine.ask()
            ├─ fetchSystemPromptParts()      ← 正式装载 system prompt
            └─ query()                       ← 进入查询循环
```

---

## 2. 阶段一：CLI 入口与快速路径

**`src/entrypoints/cli.tsx:33` `main()`**

```
node cli.js [args]
    │
    ├─ cli.tsx:33  main() 开始
    │
    ├─ cli.tsx:37  --version 快速路径
    │   └─ console.log(MACRO.VERSION)  → 退出
    │
    ├─ cli.tsx:53  --dump-system-prompt 快速路径（ant-only）
    │   ├─ enableConfigs()
    │   ├─ getMainLoopModel()
    │   └─ getSystemPrompt([], model)  ← 直接调用，仅用于调试输出
    │       └─ prompts.ts:444
    │
    ├─ cli.tsx:100  --daemon-worker 快速路径（feature('DAEMON')）
    │   └─ runDaemonWorker(args[1])  → 退出
    │
    ├─ cli.tsx:283  --bare 标志
    │   └─ process.env.CLAUDE_CODE_SIMPLE = '1'
    │       └─ 影响后续 getSystemPrompt() 的分支选择
    │
    ├─ cli.tsx:291  startCapturingEarlyInput()
    │   └─ 开始捕获用户在 CLI 加载期间的提前输入
    │
    └─ cli.tsx:294-297  加载并执行完整 CLI
        ├─ await import('../main.js')
        └─ await cliMain()            → 进入 main.tsx
```

**关键说明：** `--dump-system-prompt` 是唯一在启动阶段直接调用 `getSystemPrompt()` 的路径，用于调试。正常启动路径中，系统提示在首次 turn 时才真正组装。

---

## 3. 阶段二：init() 初始化

**`src/entrypoints/init.ts:57` `init()`（memoize，全程只运行一次）**

```
init()                                    init.ts:57
│
├─ enableConfigs()                        ← 启用配置文件系统（settings.json 等）
├─ applySafeConfigEnvironmentVariables()  ← 应用安全的配置环境变量
├─ 初始化 GrowthBook（功能标志）
├─ 初始化认证状态
└─ 初始化日志和分析系统
```

**在 main.tsx 中的调用：**
```
main.tsx:907  program.hook('preAction', async () => {
    await Promise.all([
        ensureMdmSettingsLoaded(),       ← MDM 策略设置
        ensureKeychainPrefetchCompleted() ← Keychain 凭据
    ])
    await init()                          main.tsx:916
})
```

---

## 4. 阶段三：main() 启动流程

**`src/main.tsx`（主程序，通过 Commander.js 的 action handler 执行）**

### 4.1 并行预加载（阻塞，在 trust 对话框之前）

```
main.tsx:2029  await Promise.all([
    commandsPromise ?? getCommands(currentCwd),           ← 加载 slash commands
    agentDefsPromise ?? getAgentDefinitionsWithOverrides() ← 加载 agent 定义
])
```

**与 prompt 的关联：** Agent 定义中包含各 agent 的 `getSystemPrompt()` 方法，在后续 `buildEffectiveSystemPrompt()` 中使用。

### 4.2 非交互模式（-p）的提前预热

```
main.tsx:1977  void getSystemContext()
    └─ context.ts:116  getSystemContext()（memoize）
        ├─ getGitStatus()      ← 后台执行 git status/log/branch
        └─ 返回 { gitStatus, cacheBreaker? }
        注：此处 void（fire-and-forget），与后续 getCommands() await 并行执行

main.tsx:1983  void getUserContext()
    └─ context.ts:155  getUserContext()（memoize）
        ├─ getMemoryFiles()    ← 扫描 ~/.claude/memory/ 目录
        └─ getClaudeMds()      ← 遍历 cwd 向上读取所有 CLAUDE.md
        注：此处 void（fire-and-forget），与 MCP 连接并行执行
```

**设计意图（注释 main.tsx:1967）：**
> Spawn git status/log/branch now so the subprocess execution overlaps with the getCommands await below and startDeferredPrefetches. After setup() so cwd is final.

### 4.3 系统提示相关 CLI 参数处理

```
main.tsx:1343  let systemPrompt = options.systemPrompt
    ├─ --system-prompt <prompt>    → 完全替换默认系统提示
    ├─ --system-prompt-file <file> → 从文件读取替换
    └─ --append-system-prompt      → 追加到默认系统提示末尾

main.tsx:2084  非交互模式 + 自定义 agent 的系统提示处理
    if (isNonInteractiveSession && mainThreadAgentDefinition && !systemPrompt
        && !isBuiltInAgent(mainThreadAgentDefinition)) {
      const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt()
      if (agentSystemPrompt) {
        systemPrompt = agentSystemPrompt  ← agent 系统提示覆盖默认值
      }
    }

main.tsx:2215  Proactive 模式追加（feature('PROACTIVE') || feature('KAIROS')）
    appendSystemPrompt += `\n# Proactive Mode\n\nYou are in proactive mode...`

main.tsx:2219  KAIROS assistant 模式追加
    appendSystemPrompt += assistantModule.getAssistantSystemPromptAddendum()
```

### 4.4 交互模式：信任对话框

```
main.tsx:2253  await showSetupScreens(root, permissionMode, ...)
    └─ 显示信任对话框，等待用户确认
    └─ 信任确认后，getSystemContext() 才被允许（git 命令安全）
```

---

## 5. 阶段四：后台预取

**`src/main.tsx:388` `startDeferredPrefetches()`**

在 REPL 首次渲染后调用（不阻塞首次渲染）：

```
startDeferredPrefetches()                 main.tsx:388
│
├─ void initUser()                        ← 用户信息初始化
│
├─ void getUserContext()                  main.tsx:405
│   └─ context.ts:155  getUserContext()（memoize）
│       ├─ 若已被 main.tsx:1983 预热 → 直接返回缓存（memoize hit）
│       └─ 否则：
│           ├─ getMemoryFiles()            ← 扫描记忆文件目录
│           ├─ filterInjectedMemoryFiles() ← 过滤注入的记忆文件
│           └─ getClaudeMds()              ← 遍历 cwd 向上读所有 CLAUDE.md
│               └─ 返回 { claudeMd: string, currentDate: string }
│
├─ prefetchSystemContextIfSafe()          main.tsx:406
│   └─ main.tsx:360  prefetchSystemContextIfSafe()
│       ├─ 非交互模式 → 直接调用 void getSystemContext()
│       ├─ 交互模式 + 已信任 → void getSystemContext()
│       │   └─ context.ts:116  getSystemContext()（memoize）
│       │       ├─ 若已被 main.tsx:1977 预热 → 直接返回缓存
│       │       └─ 否则：
│       │           ├─ getGitStatus()      ← git status + git log + git branch
│       │           └─ 返回 { gitStatus: string }
│       └─ 交互模式 + 未信任 → 跳过（等信任建立后再调用）
│
└─ void initializeAnalyticsGates()        ← GrowthBook 初始化（影响功能标志）
```

**关键时机说明：**

`getUserContext()` 和 `getSystemContext()` 都是 `memoize` 包装的，即：
- 第一次调用触发实际 I/O（git 命令、文件读取）
- 后续调用直接返回缓存结果
- 这两个函数在 `startDeferredPrefetches()` 中被预热，使得首次 turn 时的 `fetchSystemPromptParts()` 几乎是零延迟的缓存命中

---

## 6. 阶段五：首次 turn 前的 Prompt 组装

### 6.1 交互模式路径：REPL → QueryEngine

用户在 REPL 中输入后，触发 `handlePromptSubmit()`，最终调用 `QueryEngine.ask()`。

### 6.2 非交互模式路径：print.ts → QueryEngine

```
print.ts:2147  for await (const message of ask({
    prompt,
    customSystemPrompt: options.systemPrompt,
    appendSystemPrompt,
    ...
}))
```

`ask()` 是 `QueryEngine.ask()` 的别名（`print.ts:91 import { ask } from 'src/QueryEngine.js'`）。

---

## 7. 阶段六：buildEffectiveSystemPrompt — 交互模式的系统提示决策

**`src/utils/systemPrompt.ts:41` `buildEffectiveSystemPrompt()`**

在交互模式中，每次 turn 开始时，REPL 通过此函数决定最终使用哪个系统提示：

```
buildEffectiveSystemPrompt({              systemPrompt.ts:41
    mainThreadAgentDefinition,            ← 当前激活的 agent 定义（可能为 undefined）
    toolUseContext,
    customSystemPrompt,                   ← --system-prompt 参数（可能为 undefined）
    defaultSystemPrompt,                  ← getSystemPrompt() 的结果
    appendSystemPrompt,                   ← --append-system-prompt 参数
    overrideSystemPrompt,                 ← 循环模式覆盖（可能为 null）
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
```

---

## 8. 阶段七：QueryEngine.ask() — 每次 turn 的 Prompt 组装

**`src/QueryEngine.ts` `ask()` 方法**

每次用户提交输入（或 SDK 调用），都会经过此路径：

```
QueryEngine.ask(prompt, options)          QueryEngine.ts（ask 方法）
│
├─ [Step 1] 解析模型                      QueryEngine.ts:278
│   └─ initialMainLoopModel = parseUserSpecifiedModel(userSpecifiedModel)
│       └─ 模型影响 getSystemPrompt() 中的知识截止日期、模型描述等
│
├─ [Step 2] ★ fetchSystemPromptParts()   QueryEngine.ts:298
│   └─ queryContext.ts:44
│       └─ Promise.all([                  ← 三路并行
│             getSystemPrompt(tools, mainLoopModel, dirs, mcpClients),
│             │   └─ prompts.ts:444
│             │       ├─ CLAUDE_CODE_SIMPLE=1 → 返回最小化提示
│             │       ├─ PROACTIVE/KAIROS 激活 → 返回自主 Agent 提示
│             │       └─ 标准路径：
│             │           ├─ [静态区块，全局可缓存]
│             │           │   ├─ getSimpleIntroSection()      prompts.ts:175
│             │           │   ├─ getSimpleSystemSection()     prompts.ts:186
│             │           │   ├─ getSimpleDoingTasksSection() prompts.ts:199
│             │           │   ├─ getActionsSection()          prompts.ts:255
│             │           │   ├─ getUsingYourToolsSection()   prompts.ts:269
│             │           │   ├─ getSimpleToneAndStyleSection() prompts.ts:430
│             │           │   └─ getOutputEfficiencySection() prompts.ts:403
│             │           │
│             │           ├─ [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] prompts.ts:114
│             │           │
│             │           └─ [动态区块，会话级缓存]
│             │               ├─ getSessionSpecificGuidanceSection() prompts.ts:352
│             │               ├─ loadMemoryPrompt()           ← 记忆指令
│             │               ├─ getAntModelOverrideSection() prompts.ts:136
│             │               ├─ computeSimpleEnvInfo()       prompts.ts:651
│             │               │   └─ 包含：CWD、平台、Shell、模型名、知识截止
│             │               ├─ getLanguageSection()         prompts.ts:142
│             │               ├─ getOutputStyleSection()      prompts.ts:151
│             │               ├─ getMcpInstructionsSection()  prompts.ts:160
│             │               └─ getScratchpadInstructions()  prompts.ts:797
│             │
│             getUserContext(),            ← memoize 缓存命中（已在预取阶段填充）
│             │   └─ context.ts:155
│             │       └─ 返回 { claudeMd, currentDate }
│             │
│             getSystemContext()           ← memoize 缓存命中（已在预取阶段填充）
│                 └─ context.ts:116
│                     └─ 返回 { gitStatus, cacheBreaker? }
│          ])
│
├─ [Step 3] 合并 coordinator userContext  QueryEngine.ts:308
│   └─ userContext = { ...baseUserContext, ...getCoordinatorUserContext() }
│
├─ [Step 4] 条件性加载记忆机制提示         QueryEngine.ts:322
│   └─ 仅当 customPrompt 存在 && CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 设置时
│       └─ memoryMechanicsPrompt = await loadMemoryPrompt()
│
├─ [Step 5] ★ 组装最终 systemPrompt       QueryEngine.ts:327
│   └─ systemPrompt = asSystemPrompt([
│         ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
│         ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
│         ...(appendSystemPrompt ? [appendSystemPrompt] : []),
│       ])
│       注：此处是 SDK/print 模式的路径
│       交互模式使用 buildEffectiveSystemPrompt()（见阶段六）
│
├─ [Step 6] processUserInput()            QueryEngine.ts:422
│   └─ processUserInput.ts:85
│       └─ getAttachmentMessages(input, context, ...)
│           └─ attachments.ts:2937
│               └─ getAttachments()       attachments.ts:743
│                   ├─ [用户输入触发] @文件、MCP资源、skill_discovery
│                   └─ [线程级] queued_command、todo_reminder、skill_listing、
│                              agent_listing_delta、mcp_instructions_delta...
│                   → AttachmentMessage[]（追加到 messages）
│
└─ [Step 7] query(params)                 query.ts:219
    └─ 进入查询循环（见文档08的详细分析）
        ├─ fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
        │   └─ api.ts:437  [...systemPrompt, "gitStatus: ...\n..."]
        └─ callModel({
              messages: prependUserContext(messagesForQuery, userContext),
              │         └─ api.ts:449  messages[0] = <system-reminder>claudeMd+date</system-reminder>
              systemPrompt: fullSystemPrompt,
           })
           └─ claude.ts（最终 API 请求构建，见文档08的§5.5）
```

---

## 9. 完整调用链汇总

```
node cli.js
│
├─ cli.tsx:302  void main()
│
├─ cli.tsx:33  main()
│   ├─ cli.tsx:293-297  await import('../main.js') → await cliMain()
│
├─ main.tsx  cliMain() → Commander.js action handler
│   ├─ main.tsx:914  await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])
│   ├─ main.tsx:916  await init()                   ← init.ts:57（基础初始化）
│   ├─ main.tsx:2029  await Promise.all([getCommands(), getAgentDefinitions()])
│   │
│   ├─ [非交互模式]
│   │   ├─ main.tsx:1977  void getSystemContext()   ← context.ts:116（后台预热）
│   │   └─ main.tsx:1983  void getUserContext()     ← context.ts:155（后台预热）
│   │
│   ├─ main.tsx:2253  await showSetupScreens()      ← 交互模式信任对话框
│   │
│   ├─ [交互模式] REPL 渲染后
│   │   └─ main.tsx:388  startDeferredPrefetches()
│   │       ├─ main.tsx:405  void getUserContext()  ← context.ts:155（预热/缓存命中）
│   │       └─ main.tsx:406  prefetchSystemContextIfSafe()
│   │           └─ main.tsx:367  void getSystemContext() ← context.ts:116（预热/缓存命中）
│   │
│   └─ [用户输入 / SDK 调用]
│       │
│       ├─ processUserInput()                       ← processUserInput.ts:85
│       │   └─ getAttachmentMessages(input, ...)    ← attachments.ts:2937
│       │       └─ getAttachments()                 ← attachments.ts:743
│       │           └─ [所有 attachment 类型并行生成]
│       │
│       └─ QueryEngine.ask()                        ← QueryEngine.ts
│           │
│           ├─ QueryEngine.ts:298  fetchSystemPromptParts()  ← queryContext.ts:44
│           │   └─ Promise.all([
│           │         getSystemPrompt(tools, model, dirs, mcp),  ← prompts.ts:444
│           │         getUserContext(),                            ← context.ts:155（缓存命中）
│           │         getSystemContext(),                          ← context.ts:116（缓存命中）
│           │      ])
│           │
│           ├─ QueryEngine.ts:327  systemPrompt = asSystemPrompt([
│           │     ...defaultSystemPrompt / customPrompt,
│           │     ...memoryMechanicsPrompt?,
│           │     ...appendSystemPrompt?,
│           │   ])
│           │
│           └─ query(params)                        ← query.ts:219
│               │
│               ├─ query.ts:470  fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
│               │   └─ api.ts:437  [...systemPrompt, "gitStatus: ...\n..."]
│               │
│               └─ query.ts:720  callModel({
│                     messages: prependUserContext(messagesForQuery, userContext),
│                     │         └─ api.ts:449  messages[0] = <system-reminder>claudeMd+date</system-reminder>
│                     systemPrompt: fullSystemPrompt,
│                  })
│                  └─ claude.ts
│                      ├─ claude.ts:1266  normalizeMessagesForAPI()     ← messages.ts:1989
│                      │   └─ AttachmentMessage → normalizeAttachmentForAPI() ← messages.ts:3453
│                      ├─ claude.ts:1358  systemPrompt = asSystemPrompt([
│                      │     getAttributionHeader(fingerprint),          ← system.ts:73
│                      │     getCLISyspromptPrefix(),                    ← system.ts:30
│                      │     ...systemPrompt,
│                      │     ADVISOR_TOOL_INSTRUCTIONS?,
│                      │     CHROME_TOOL_SEARCH_INSTRUCTIONS?,
│                      │   ])
│                      ├─ claude.ts:1376  system = buildSystemPromptBlocks(systemPrompt, ...)
│                      │   └─ claude.ts:3242  splitSysPromptPrefix() 按 BOUNDARY 分割缓存范围
│                      └─ anthropic.beta.messages.create({ system, messages, tools, ... })
```

---

## 关键设计要点

### 预热 vs 按需加载

| 函数 | 预热时机 | 实际使用时机 | 机制 |
|------|---------|------------|------|
| `getUserContext()` | 启动后（`startDeferredPrefetches` 或 `-p` 模式） | 每次 `fetchSystemPromptParts()` | memoize（会话内只计算一次） |
| `getSystemContext()` | 信任建立后（交互）或启动后（`-p`） | 每次 `appendSystemContext()` | memoize（会话内只计算一次） |
| `getSystemPrompt()` | 无预热 | 每次 `fetchSystemPromptParts()` | 内部有 Section 缓存机制 |
| Attachments | 用户输入时 | `processUserInput()` 调用时 | 无缓存，每次重新计算 |

### 为什么 getSystemPrompt() 没有全局预热？

`getSystemPrompt()` 依赖运行时状态（工具列表、MCP 客户端、模型）这些在启动阶段不稳定，因此不能像 `getUserContext()` 那样早期预热。它在每次 turn 开始时按需调用，但其内部的各个 Section 有自己的缓存机制（`systemPromptSection()`），避免重复计算。

### memoize 的会话边界

`getUserContext()` 和 `getSystemContext()` 的 memoize 缓存在 `/clear` 命令时被清除（`context.ts:32-33`）：

```typescript
export function clearContextCache(): void {
  getUserContext.cache.clear?.()    // context.ts:32
  getSystemContext.cache.clear?.()  // context.ts:33
}
```

这确保 `/clear` 后能获取最新的 CLAUDE.md 内容和 git 状态。
