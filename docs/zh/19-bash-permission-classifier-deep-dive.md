# Bash 权限分类器深度解析：工具调用的安全审批系统

> 基于 Claude Code v2.1.88 源码，含函数级代码注释与完整调用链路

---

## 目录

1. [什么是审批分类器？](#1-什么是审批分类器)
2. [整体架构与两类分类器](#2-整体架构与两类分类器)
3. [核心入口：bashToolHasPermission](#3-核心入口bashtoolhaspermission)
4. [规则匹配体系](#4-规则匹配体系)
5. [命令预处理：包装器剥离与环境变量处理](#5-命令预处理包装器剥离与环境变量处理)
6. [AST 安全解析集成](#6-ast-安全解析集成)
7. [Bash 提示词分类器（ant-only）](#7-bash-提示词分类器ant-only)
8. [推测性分类器：后台并行检查](#8-推测性分类器后台并行检查)
9. [沙箱自动放行](#9-沙箱自动放行)
10. [复合命令安全检查](#10-复合命令安全检查)
11. [关键安全设计](#11-关键安全设计)
12. [权限决策优先级总结](#12-权限决策优先级总结)

---

## 1. 什么是审批分类器？

Claude Code 每次执行 Bash 命令前，都需要判断该命令是否需要用户批准。这个判断系统称为"审批分类器"（Permission Classifier），主要实现在 `src/tools/BashTool/bashPermissions.ts`（2600+ 行）。

与 YOLO 分类器（用于 Auto Mode 的全局操作判断）不同，Bash 审批分类器专门针对 **Shell 命令** 进行细粒度的安全分析，包含：

- **规则匹配**：精确匹配、前缀匹配、通配符匹配
- **AST 语法树分析**：通过 tree-sitter 解析命令结构
- **语义安全检查**：检测 eval、zsh 内置命令等危险语义
- **路径约束检查**：防止写操作逃逸到项目目录之外
- **Bash 提示词分类器**：ant-only，通过 LLM 语义理解命令意图

### 与 YOLO 分类器的区别

| 维度 | Bash 审批分类器 | YOLO 分类器 |
|------|--------------|------------|
| 作用范围 | 仅 BashTool | 所有工具 |
| 触发时机 | 每次 Bash 调用前 | 仅 Auto 模式 |
| 主要技术 | 规则匹配 + AST 解析 + 提示词分类 | 全量 transcript + LLM 分类 |
| 用户可见性 | 弹出权限审批对话框 | 静默放行/拒绝 |
| 外部可用 | 是（规则匹配部分） | 否（ANT-only stub） |

---

## 2. 整体架构与两类分类器

```
BashTool.checkPermissions()
        │
        ▼
bashToolHasPermission()             ← bashPermissions.ts:1665
  │
  ├── [0] AST 解析（tree-sitter）
  │   ├── simple  → 语义检查 → 提取子命令
  │   ├── too-complex → 早期退出 deny/ask
  │   └── unavailable → 回退到 legacy 路径
  │
  ├── [1] 沙箱自动放行（checkSandboxAutoAllow）
  │
  ├── [2] 精确匹配（bashToolCheckExactMatchPermission）
  │   ├── deny → 直接拒绝
  │   ├── ask  → 返回询问
  │   └── allow → 直接放行
  │
  ├── [3] Bash 提示词分类器（ANT-ONLY，并行 deny+ask）
  │   ├── deny matches → 拒绝
  │   └── ask matches  → 询问（含 pendingClassifierCheck）
  │
  ├── [4] 操作符权限检查（checkCommandOperatorPermissions）
  │   处理 |、&&、||、;、>、>> 等
  │
  ├── [5] 子命令遍历
  │   ├── bashToolCheckPermission（前缀/通配符规则 + 路径约束）
  │   └── checkCommandAndSuggestRules（生成建议规则）
  │
  └── 返回 PermissionResult { behavior: 'allow'|'ask'|'deny'|'passthrough' }
              │
              ├── ask → 弹出权限对话框
              │   ├── pendingClassifierCheck 存在？→ 后台启动推测性分类器
              │   └── 用户操作 or 分类器抢先 auto-approve
              └── allow/deny → 直接执行/拒绝
```

---

## 3. 核心入口：bashToolHasPermission

**文件**：`src/tools/BashTool/bashPermissions.ts:1665`

```typescript
/**
 * Bash 工具权限检查的主入口函数。
 * 综合 AST 解析、规则匹配、路径约束、安全语义检查，
 * 返回最终的权限决定。
 *
 * @param input   - BashTool 输入（含 command 字段）
 * @param context - 工具使用上下文（含权限上下文、AbortController）
 * @param getCommandSubcommandPrefixFn - 可注入的前缀提取函数（测试用）
 */
export async function bashToolHasPermission(
  input: z.infer<typeof BashTool.inputSchema>,
  context: ToolUseContext,
  getCommandSubcommandPrefixFn = getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  let appState = context.getAppState()

  // 步骤 0: AST 安全解析
  // 优先使用 tree-sitter 解析命令结构（比 legacy 正则更精确）
  // GrowthBook killswitch: tengu_birch_trellis 可禁用 AST 路径
  const astRoot = await parseCommandRaw(input.command)
  let astResult = parseForSecurityFromAst(input.command, astRoot)

  // Shadow 模式：记录 tree-sitter vs legacy 的分歧（telemetry only），
  // 强制使用 legacy 路径保持稳定性。
  if (feature('TREE_SITTER_BASH_SHADOW')) {
    logEvent('tengu_tree_sitter_shadow', { ... })
    astResult = { kind: 'parse-unavailable' }
    astRoot = null
  }

  // too-complex: 命令有复杂结构（命令替换、扩展、控制流等）
  // 检查 deny 规则后，直接询问用户
  if (astResult.kind === 'too-complex') {
    const earlyExit = checkEarlyExitDeny(input, appState.toolPermissionContext)
    if (earlyExit !== null) return earlyExit
    return {
      behavior: 'ask',
      ...(feature('BASH_CLASSIFIER') ? {
        pendingClassifierCheck: buildPendingClassifierCheck(
          input.command, appState.toolPermissionContext
        ),
      } : {}),
    }
  }

  // simple: 语义安全检查（eval、zsh 内置命令等危险语义）
  if (astResult.kind === 'simple') {
    const sem = checkSemantics(astResult.commands)
    if (!sem.ok) {
      const earlyExit = checkSemanticsDeny(input, appState.toolPermissionContext, astResult.commands)
      if (earlyExit !== null) return earlyExit
      return { behavior: 'ask', ... }
    }
    // 提取子命令列表（使用 AST span，比 splitCommand 更准确）
    astSubcommands = astResult.commands.map(c => c.text)
    astCommands = astResult.commands
  }

  // 步骤 1: 沙箱自动放行
  if (SandboxManager.isSandboxingEnabled() && shouldUseSandbox(input)) {
    return checkSandboxAutoAllow(input, appState.toolPermissionContext)
  }

  // 步骤 2: 精确匹配检查
  const exactMatchResult = bashToolCheckExactMatchPermission(input, appState.toolPermissionContext)
  if (exactMatchResult.behavior === 'deny') return exactMatchResult

  // 步骤 3: Bash 提示词分类器（ANT-ONLY，并行 deny+ask）
  // 同时查询 deny 和 ask 分类器，deny 优先
  if (isClassifierPermissionsEnabled() && /* 非 auto 模式 */) {
    const [denyResult, askResult] = await Promise.all([
      classifyBashCommand(input.command, cwd, denyDescriptions, 'deny', ...),
      classifyBashCommand(input.command, cwd, askDescriptions, 'ask', ...),
    ])
    if (denyResult?.matches && denyResult.confidence === 'high') {
      return { behavior: 'deny', ... }
    }
    if (askResult?.matches && askResult.confidence === 'high') {
      return { behavior: 'ask', pendingClassifierCheck: ..., ... }
    }
  }

  // 步骤 4: 操作符权限（|、&&、||、;、>、>>）
  const operatorResult = await checkCommandOperatorPermissions(input, ...)
  if (operatorResult.behavior !== 'passthrough') return operatorResult

  // 步骤 5: 子命令拆分与逐个检查
  const subcommands = astSubcommands ?? splitCommand(input.command)
  // [cd 安全检查、git+cd 攻击防护、子命令数量上限]
  const subcommandResults = subcommands.map(cmd =>
    bashToolCheckPermission({ command: cmd }, appState.toolPermissionContext, compoundCommandHasCd, ...)
  )

  // deny > ask > allow 优先级
  const denied = subcommandResults.find(_ => _.behavior === 'deny')
  if (denied) return { behavior: 'deny', ... }

  // 步骤 6: 对原始命令的路径约束检查（检测 splitCommand 剥离的重定向）
  const pathResult = checkPathConstraints(input, cwd, ..., astRedirects, astCommands)
  if (pathResult.behavior === 'deny') return pathResult
  if (pathResult.behavior === 'ask' && /* 无子命令 ask */) return pathResult

  // 所有子命令均通过 → allow
  if (subcommandResults.every(_ => _.behavior === 'allow') && !hasPossibleCommandInjection) {
    return { behavior: 'allow', ... }
  }

  // 其余情况：生成建议规则后询问用户
  return checkCommandAndSuggestRules(...)
}
```

---

## 4. 规则匹配体系

**文件**：`src/tools/BashTool/bashPermissions.ts:780`，`src/utils/permissions/shellRuleMatching.ts`

### 4.1 三种规则类型

```
规则语法                示例                       匹配行为
─────────────────────────────────────────────────────────────
精确匹配（exact）       Bash(git status)           只匹配完全相同的命令
前缀匹配（prefix）      Bash(git commit:*)         匹配所有以 "git commit" 开头的命令
通配符（wildcard）      Bash(git *push*)           使用 glob 模式匹配
```

### 4.2 规则优先级（deny > ask > allow）

```typescript
// bashPermissions.ts:993-1050
export const bashToolCheckExactMatchPermission = (
  input, toolPermissionContext
): PermissionResult => {
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')

  // 1. deny 规则最高优先级
  if (matchingDenyRules[0]) {
    return {
      behavior: 'deny',
      message: `Permission denied.`,
      decisionReason: { type: 'rule', rule: matchingDenyRules[0] }
    }
  }
  // 2. ask 规则次之
  if (matchingAskRules[0]) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: { type: 'rule', rule: matchingAskRules[0] }
    }
  }
  // 3. allow 规则放行
  if (matchingAllowRules[0]) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: matchingAllowRules[0] }
    }
  }
  // 4. 无匹配 → passthrough（继续其他检查）
  return { behavior: 'passthrough', suggestions: suggestionForExactCommand(command) }
}
```

### 4.3 deny/ask 规则的激进剥离（防绕过）

```typescript
// bashPermissions.ts:812-855
// SECURITY: deny/ask 规则使用全量环境变量剥离（stripAllEnvVars=true）
// 防止 `FOO=bar denied_command` 绕过 `Bash(denied_command:*)` deny 规则
//
// 迭代定点算法，处理多层嵌套：
//   1. stripSafeWrappers:       nohup FOO=bar timeout 5 claude → FOO=bar timeout 5 claude
//   2. stripAllLeadingEnvVars:  FOO=bar timeout 5 claude → timeout 5 claude
//   3. stripSafeWrappers:       timeout 5 claude → claude  ← deny 规则命中！
const matchingDenyRules = filterRulesByContentsMatchingInput(
  input, denyRuleByContents, matchMode,
  { stripAllEnvVars: true, skipCompoundCheck: true },
)
```

### 4.4 allow 规则只用安全剥离（防误放）

```typescript
// 对比 allow 规则：只使用 SAFE_ENV_VARS 白名单剥离
// 原因：allow 规则不能太宽松，防止 `DOCKER_HOST=evil.com docker ps`
//      被 `Bash(docker ps:*)` allow 规则错误放行（HackerOne #3543050）
const matchingAllowRules = filterRulesByContentsMatchingInput(
  input, allowRuleByContents, matchMode,
  // stripAllEnvVars 默认 false
)
```

### 4.5 复合命令中前缀/通配符规则的安全限制

```typescript
// bashPermissions.ts:888-932
// SECURITY: 前缀/通配符规则不能匹配复合命令
// 防止 Bash(cd:*) 匹配 "cd /path && python3 evil.py"
//
// 例：shell 转义可骗过第一轮 splitCommand：
//   cd src\&\& python3 hello.py → splitCommand → ["cd src&& python3 hello.py"]
//   看起来是单命令，以 "cd " 开头 → 被前缀规则匹配！
// 此处在 filterRulesByContentsMatchingInput 内重新 splitCommand 检测

if (isCompoundCommand.get(cmdToMatch)) {
  return false  // 复合命令不允许前缀/通配符规则匹配
}
```

---

## 5. 命令预处理：包装器剥离与环境变量处理

**文件**：`src/tools/BashTool/bashPermissions.ts:526`

### 5.1 安全包装器剥离（stripSafeWrappers）

```typescript
/**
 * 剥离 timeout/time/nice/nohup/stdbuf 等安全包装器，
 * 使 Bash(npm install:*) 能匹配 "timeout 10 npm install foo"。
 *
 * 两阶段处理：
 *   Phase 1: 剥离 SAFE_ENV_VARS 中的环境变量 + 注释行
 *   Phase 2: 剥离安全包装器 + 注释行（不剥离环境变量！）
 *
 * 安全性要求：
 *   - 使用 [ \t]+ 而非 \s+（防止跨换行匹配，\n 是 bash 命令分隔符）
 *   - Phase 2 不剥离环境变量：VAR=val 在 nohup 之后是命令名，不是赋值
 *     `nohup VAR=val ls` → bash 将 VAR=val 作为命令执行（HackerOne #3543050）
 *   - 必须与 checkSemantics 的包装器剥离逻辑保持同步
 */
export function stripSafeWrappers(command: string): string {
  const SAFE_WRAPPER_PATTERNS = [
    // timeout: 支持所有 GNU 长短标志，标志值只允许 [A-Za-z0-9_.+-]
    // 防止 `timeout -k$(id) 10 ls` 剥离到 ls 而匹配 Bash(ls:*)
    /^timeout[ \t]+(?:...)/,
    /^time[ \t]+(?:--[ \t]+)?/,
    // nice: 支持 bare `nice cmd`、`nice -n N cmd`、`nice -N cmd` 三种形式
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ]
  // Phase 1: 环境变量剥离循环（定点迭代）
  // Phase 2: 包装器剥离循环（定点迭代）
}
```

### 5.2 安全环境变量白名单

```typescript
// bashPermissions.ts:380-432
// 只允许剥离不影响代码执行的环境变量
const SAFE_ENV_VARS = new Set([
  'NODE_ENV',           // Node 环境名（非 NODE_OPTIONS！）
  'PYTHONUNBUFFERED',   // Python 行为标志（非 PYTHONPATH！）
  'RUST_BACKTRACE',     // Rust 日志
  'GOOS', 'GOARCH',     // Go 构建目标
  'LANG', 'LC_ALL',     // locale
  'TZ',                 // 时区
  'ANTHROPIC_API_KEY',  // API 认证

  // 绝对禁止添加：
  // PATH, LD_PRELOAD, LD_LIBRARY_PATH（执行/库加载劫持）
  // PYTHONPATH, NODE_PATH（模块加载劫持）
  // GOFLAGS, NODE_OPTIONS（可包含代码执行标志）
])

// ANT-ONLY 附加白名单（有意识地接受风险，基于 30 天遥测数据）
const ANT_ONLY_SAFE_ENV_VARS = new Set([
  'KUBECONFIG',                   // kubectl 配置文件路径
  'DOCKER_HOST',                  // Docker daemon endpoint
  'AWS_PROFILE', 'CLOUDSDK_CORE_PROJECT', // 云项目选择
  'CUDA_VISIBLE_DEVICES',         // GPU 设备选择
  // ...Anthropic 内部集群变量
])
```

### 5.3 建议规则生成（按命令类型）

```typescript
// bashPermissions.ts:268-297
function suggestionForExactCommand(command: string): PermissionUpdate[] {
  // Heredoc 命令：提取 << 之前的稳定前缀
  // 每次 heredoc 内容不同，精确匹配规则无法复用
  const heredocPrefix = extractPrefixBeforeHeredoc(command)
  if (heredocPrefix) return sharedSuggestionForPrefix(BashTool.name, heredocPrefix)

  // 多行命令：使用第一行作为前缀规则
  if (command.includes('\n')) {
    const firstLine = command.split('\n')[0]!.trim()
    if (firstLine) return sharedSuggestionForPrefix(BashTool.name, firstLine)
  }

  // 单行命令：提取 "命令 子命令" 2-word 前缀
  // 例：'git commit -m "fix"' → 建议 Bash(git commit:*)（可复用）
  const prefix = getSimpleCommandPrefix(command)
  if (prefix) return sharedSuggestionForPrefix(BashTool.name, prefix)

  // 回退：精确匹配建议
  return sharedSuggestionForExactCommand(BashTool.name, command)
}
```

---

## 6. AST 安全解析集成

**文件**：`src/tools/BashTool/bashPermissions.ts:1672`，`src/utils/bash/ast.ts`

### 6.1 解析结果三态

```typescript
// ParseForSecurityResult 三种状态：
type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }           // 成功，简单命令列表
  | { kind: 'too-complex'; reason: string; nodeType: string } // 成功但有复杂结构
  | { kind: 'parse-unavailable' }                            // tree-sitter 未加载

// too-complex 触发场景：
//   命令替换 $(...)、反引号
//   参数扩展 ${var}
//   控制流 if/for/while/case
//   进程替换 <(...)
//   tree-sitter 与 bash 解析分歧（parser differential）
```

### 6.2 too-complex 路径处理

```typescript
// bashPermissions.ts:1743-1771
if (astResult.kind === 'too-complex') {
  // 先检查 deny 规则（用户明确拒绝的命令不能降级为 ask）
  const earlyExit = checkEarlyExitDeny(input, appState.toolPermissionContext)
  if (earlyExit !== null) return earlyExit

  logEvent('tengu_bash_ast_too_complex', { nodeTypeId: nodeTypeId(astResult.nodeType) })

  return {
    behavior: 'ask',
    decisionReason: { type: 'other', reason: astResult.reason },
    // 附带 pendingClassifierCheck：Bash 提示词分类器可能在后台 auto-approve
    ...(feature('BASH_CLASSIFIER') ? {
      pendingClassifierCheck: buildPendingClassifierCheck(
        input.command, appState.toolPermissionContext
      ),
    } : {}),
  }
}
```

### 6.3 Shadow 模式（实验性）

```typescript
// bashPermissions.ts:1709-1741
// TREE_SITTER_BASH_SHADOW feature 开启时：
// 1. 运行 tree-sitter 解析，记录结果
// 2. 与 legacy splitCommand 对比，记录分歧到 tengu_tree_sitter_shadow 事件
// 3. 强制使用 legacy 路径（observational only，不影响实际行为）
// 目的：在 tree-sitter 完全替换 legacy 之前，收集生产数据验证正确性
if (feature('TREE_SITTER_BASH_SHADOW')) {
  logEvent('tengu_tree_sitter_shadow', {
    available,
    astTooComplex: tooComplex,
    astSemanticFail: semanticFail,
    subsDiffer,           // tree-sitter 与 legacy 子命令列表是否不同
    injectionCheckDisabled,
    killswitchOff: !shadowEnabled,
    cmdOverLength: input.command.length > 10000,
  })
  astResult = { kind: 'parse-unavailable' }  // 强制回退到 legacy
  astRoot = null
}
```

---

## 7. Bash 提示词分类器（ant-only）

**文件**：`src/tools/BashTool/bashPermissions.ts:1858`，`src/utils/permissions/bashClassifier.ts`

### 7.1 什么是提示词分类器

这是 **ANT-ONLY** 功能（外部构建返回全为 false 的 stub），通过 LLM 语义理解判断命令是否符合用户用自然语言编写的规则。

用户可以在设置中添加自然语言规则，例如：
- **allow rule**：`"run npm commands"` → 匹配所有 npm 相关命令
- **deny rule**：`"delete files from home directory"` → 拒绝删除 home 目录文件
- **ask rule**：`"network operations"` → 需要确认网络相关命令

### 7.2 并行 deny+ask 分类

```typescript
// bashPermissions.ts:1858-1973
if (isClassifierPermissionsEnabled() && /* 非 auto 模式 */) {
  const denyDescriptions = getBashPromptDenyDescriptions(toolPermissionContext)
  const askDescriptions  = getBashPromptAskDescriptions(toolPermissionContext)

  // 并行发送 deny 和 ask 分类请求（两者都用 Haiku 模型）
  const [denyResult, askResult] = await Promise.all([
    hasDeny ? classifyBashCommand(command, cwd, denyDescriptions, 'deny', signal, ...) : null,
    hasAsk  ? classifyBashCommand(command, cwd, askDescriptions,  'ask',  signal, ...) : null,
  ])

  // deny 优先于 ask
  if (denyResult?.matches && denyResult.confidence === 'high') {
    return {
      behavior: 'deny',
      message: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
    }
  }
  if (askResult?.matches && askResult.confidence === 'high') {
    return {
      behavior: 'ask',
      // 附带 pendingClassifierCheck 供后续 allow 分类器使用
      pendingClassifierCheck: buildPendingClassifierCheck(command, toolPermissionContext),
      decisionReason: { type: 'other', reason: `Required by Bash prompt rule: "${askResult.matchedDescription}"` },
    }
  }
}
```

### 7.3 buildPendingClassifierCheck：携带 allow 检查元数据

```typescript
// bashPermissions.ts:1461-1483
/**
 * 构建待处理的 allow 分类器检查元数据。
 * 当命令需要用户审批时，同时返回此元数据——
 * UI 层可以用它在后台并行启动 allow 分类器，
 * 若分类器高置信度匹配，在用户响应前自动放行。
 *
 * 跳过条件：
 * - 分类器未启用（bashClassifier.isClassifierPermissionsEnabled() === false）
 * - Auto 模式（YOLO 分类器负责全部决策）
 * - bypassPermissions 模式
 * - 无 allow 描述规则
 */
function buildPendingClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
): { command: string; cwd: string; descriptions: string[] } | undefined {
  if (!isClassifierPermissionsEnabled()) return undefined
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto') return undefined
  if (toolPermissionContext.mode === 'bypassPermissions') return undefined

  const allowDescriptions = getBashPromptAllowDescriptions(toolPermissionContext)
  if (allowDescriptions.length === 0) return undefined

  return { command, cwd: getCwd(), descriptions: allowDescriptions }
}
```

---

## 8. 推测性分类器：后台并行检查

**文件**：`src/tools/BashTool/bashPermissions.ts:1485`

推测性分类器是一个性能优化：在权限对话框弹出**之前**就启动分类器，让它在后台并行运行，争取在用户看到对话框前完成判断。

### 8.1 启动推测性检查（由 UI 层调用）

```typescript
// bashPermissions.ts:1499-1529
// 由 BashPermissionRequest 组件在权限对话框渲染前调用
export function startSpeculativeClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): boolean {
  // 同 buildPendingClassifierCheck 的守卫条件
  if (!isClassifierPermissionsEnabled()) return false
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto') return false
  const allowDescriptions = getBashPromptAllowDescriptions(toolPermissionContext)
  if (allowDescriptions.length === 0) return false

  // 立即发起 LLM 调用，存入 Map 供后续 consume
  const promise = classifyBashCommand(
    command, getCwd(), allowDescriptions, 'allow', signal, isNonInteractiveSession
  )
  // 防止未被 consume 前的 unhandled rejection（signal abort 时）
  promise.catch(() => {})
  speculativeChecks.set(command, promise)
  return true
}
```

### 8.2 后台异步 allow 检查（权限对话框展示期间运行）

```typescript
// bashPermissions.ts:1607-1660
/**
 * 在权限对话框展示期间后台运行 allow 分类器。
 * 若高置信度匹配且用户尚未操作，自动 approve。
 *
 * @param pendingCheck         - buildPendingClassifierCheck 的返回值
 * @param signal               - 中止信号
 * @param callbacks.shouldContinue - 用户是否已交互（按键/点击 → false）
 * @param callbacks.onAllow        - 分类器批准时的回调（关闭对话框）
 * @param callbacks.onComplete     - 分类器完成（无论结果）时的回调
 */
export async function executeAsyncClassifierCheck(
  pendingCheck: { command: string; cwd: string; descriptions: string[] },
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  callbacks: AsyncClassifierCheckCallbacks,
): Promise<void> {
  // 优先消费推测性检查结果（复用已发起的 LLM 调用，节省延迟）
  const speculativeResult = consumeSpeculativeClassifierCheck(pendingCheck.command)
  const classifierResult = speculativeResult
    ? await speculativeResult
    : await classifyBashCommand(pendingCheck.command, pendingCheck.cwd, pendingCheck.descriptions, 'allow', signal, ...)

  // 若用户已经做出选择，不覆盖用户决定
  if (!callbacks.shouldContinue()) return

  if (feature('BASH_CLASSIFIER') && classifierResult.matches && classifierResult.confidence === 'high') {
    // Auto-approve：回调通知 UI 关闭对话框并执行命令
    callbacks.onAllow({
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    })
  } else {
    // 无匹配：清除"正在检查"指示器
    callbacks.onComplete?.()
  }
}
```

### 8.3 Swarm Agent 中的 allow 检查

```typescript
// bashPermissions.ts:1557-1589
/**
 * 供 Swarm Agent（tmux / in-process teammate）使用：
 * 先运行 allow 分类器，只有分类器拒绝才将权限请求升级给 Coordinator。
 * 避免不必要的跨进程通信开销。
 */
export async function awaitClassifierAutoApproval(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionDecisionReason | undefined> {
  const { command, cwd, descriptions } = pendingCheck
  // 优先消费推测性结果
  const speculativeResult = consumeSpeculativeClassifierCheck(command)
  const classifierResult = speculativeResult
    ? await speculativeResult
    : await classifyBashCommand(command, cwd, descriptions, 'allow', signal, ...)

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  // 高置信度匹配 → 返回 allow 原因（不需要 Coordinator 审批）
  if (feature('BASH_CLASSIFIER') && classifierResult.matches && classifierResult.confidence === 'high') {
    return {
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    }
  }
  // 未匹配 → 返回 undefined（交给 Coordinator 决定）
  return undefined
}
```

---

## 9. 沙箱自动放行

**文件**：`src/tools/BashTool/bashPermissions.ts:1272`

```typescript
/**
 * 沙箱模式（--sandbox）下的自动放行检查。
 * 沙箱隔离了文件系统和网络，所以可以放宽权限——
 * 但仍然尊重用户配置的明确 deny/ask 规则。
 *
 * 关键安全设计：
 *   前缀规则如 Bash(rm:*) 不会匹配完整复合命令
 *   "echo hello && rm -rf /" 不以 "rm" 开头，全命令前缀检查不会命中
 *   因此必须拆分子命令逐一检查 deny/ask 规则
 *
 *   IMPORTANT: 子命令 deny 检查必须在全命令 ask 检查之前
 *   否则 Bash(*echo*) 通配符 ask 规则会在 Bash(rm:*) deny 规则检查前返回 ask，
 *   将 deny 降级为 ask
 */
function checkSandboxAutoAllow(
  input, toolPermissionContext
): PermissionResult {
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(input, toolPermissionContext, 'prefix')
  if (matchingDenyRules[0]) return { behavior: 'deny', ... }

  // 拆分复合命令，逐个检查子命令 deny 规则
  const subcommands = splitCommand(command)
  if (subcommands.length > 1) {
    let firstAskRule: PermissionRule | undefined
    for (const sub of subcommands) {
      const subResult = matchingRulesForInput({ command: sub }, toolPermissionContext, 'prefix')
      if (subResult.matchingDenyRules[0]) return { behavior: 'deny', ... }  // deny 立即返回
      firstAskRule ??= subResult.matchingAskRules[0]
    }
    if (firstAskRule) return { behavior: 'ask', ... }
  }

  // 全命令 ask 检查（在所有 deny 检查完后）
  if (matchingAskRules[0]) return { behavior: 'ask', ... }

  return {
    behavior: 'allow',
    decisionReason: { type: 'other', reason: 'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)' },
  }
}
```

---

## 10. 复合命令安全检查

**文件**：`src/tools/BashTool/bashPermissions.ts:2183`

### 10.1 多 cd 命令检测

```typescript
// bashPermissions.ts:2183-2198
// 多个 cd 命令会使路径约束失效（无法确定实际工作目录）
const cdCommands = subcommands.filter(cmd => isNormalizedCdCommand(cmd))
if (cdCommands.length > 1) {
  return {
    behavior: 'ask',
    decisionReason: {
      type: 'other',
      reason: 'Multiple directory changes in one command require approval for clarity',
    },
  }
}
```

### 10.2 cd + git 攻击防护（bare repo RCE）

```typescript
// bashPermissions.ts:2204-2227
// SECURITY: 防止通过 cd 进入恶意 git 仓库触发 core.fsmonitor RCE
// 攻击向量：cd /malicious/dir && git status
//   恶意目录含有 bare git repo + core.fsmonitor = 任意代码执行
//
// 必须在此处检查（不能在子命令级别，因为 bashToolCheckPermission 中
// BashTool.isReadOnly() 会重新推导 compoundCommandHasCd=false，
// 从单独的 "git status" 来看它是只读的，会被错误放行）
if (compoundCommandHasCd) {
  const hasGitCommand = subcommands.some(cmd => isNormalizedGitCommand(cmd.trim()))
  if (hasGitCommand) {
    return {
      behavior: 'ask',
      decisionReason: {
        type: 'other',
        reason: 'Compound commands with cd and git require approval to prevent bare repository attacks',
      },
    }
  }
}
```

### 10.3 子命令数量上限

```typescript
// bashPermissions.ts:2161-2181
// CC-643: legacy splitCommand 在复杂命令上可能产生指数级爆炸的子命令数组
// 每个子命令触发 tree-sitter 解析 + ~20 个安全校验 + logEvent，
// 微任务链饿死事件循环（REPL 100% CPU 冻结，strace 显示 ~127Hz /proc/self/stat 读取）
// 50 个是上限，合法用户命令不会超过这个数
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50

if (astSubcommands === null && subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
  return {
    behavior: 'ask',
    decisionReason: {
      type: 'other',
      reason: `Command splits into ${subcommands.length} subcommands, too many to safety-check individually`,
    },
  }
}
```

---

## 11. 关键安全设计

### 11.1 deny 规则不可降级

```typescript
// checkEarlyExitDeny / checkSemanticsDeny
// 无论在 too-complex、semantic fail 还是其他路径，
// 只要命中 deny 规则，绝对不能返回 'ask'（更不能 'allow'）
// 防止：用户明确禁止的命令通过"绕过解析"降级为询问
```

### 11.2 重定向单独验证

```typescript
// bashPermissions.ts:2270-2288
// splitCommand 会剥离重定向（> /etc/passwd）
// 子命令级别的 checkPathConstraints 看不到它们
// 必须在原始命令上重新验证输出重定向路径约束
// 使用 AST 数据（更精确）避免 shell-quote 单引号反斜杠解析 bug
const pathResult = checkPathConstraints(
  input,            // 原始命令（含重定向）
  getCwd(),
  appState.toolPermissionContext,
  compoundCommandHasCd,
  astRedirects,     // AST 提取的重定向（比 shell-quote 更精确）
  astCommands,
)
```

### 11.3 BARE_SHELL_PREFIXES 防护

```typescript
// bashPermissions.ts:198-228
// 禁止对这些命令生成前缀规则建议
// 原因：Bash(bash:*) 等同于 Bash(*)，允许所有命令
const BARE_SHELL_PREFIXES = new Set([
  'sh', 'bash', 'zsh', 'fish',  // shell 解释器
  'env', 'xargs',                // 执行任意参数
  'sudo', 'doas', 'pkexec',      // 权限提升
  'nice', 'stdbuf', 'nohup', 'timeout', 'time',  // 包装器（避免 Bash(nice:*)≈Bash(*)）
])
```

### 11.4 xargs 前缀匹配扩展

```typescript
// bashPermissions.ts:905-913
// Bash(grep:*) 也能匹配 "xargs grep pattern"（bare xargs，无额外标志）
// Bash(rm:*) deny 规则也能阻止 "xargs rm file"
// "xargs -n1 grep" 不匹配（有标志，词边界不符）
const xargsPrefix = 'xargs ' + bashRule.prefix
if (cmdToMatch === xargsPrefix) return true
return cmdToMatch.startsWith(xargsPrefix + ' ')
```

---

## 12. 权限决策优先级总结

```
bashToolHasPermission() 决策链（优先级从高到低）：

优先级  检查点                           触发条件
──────────────────────────────────────────────────────────────────
  1    AST too-complex 中的 deny 规则   命令结构复杂 + 明确 deny 规则
  2    AST 语义失败中的 deny 规则       eval/zsh-builtin 等危险语义 + deny 规则
  3    沙箱环境 deny/ask 规则           沙箱启用时的明确规则
  4    精确匹配 deny                   完全相同的命令在 deny 规则中
  5    提示词分类器 deny（ANT-ONLY）   LLM 高置信度匹配 deny 描述
  6    提示词分类器 ask（ANT-ONLY）    LLM 高置信度匹配 ask 描述
  7    操作符权限 deny                 重定向/管道违反约束
  8    子命令 deny 规则（前缀/通配符）  子命令匹配前缀/通配符 deny 规则
  9    重定向路径约束 deny             写入限制区域之外
  10   子命令 ask 规则                 子命令匹配 ask 规则
  11   路径约束 ask                    cd/访问限制区域
  12   精确匹配 allow                  完全相同的命令在 allow 规则中
  13   子命令 allow 规则               所有子命令均匹配 allow 规则
  14   沙箱自动放行                    沙箱启用且无明确规则
  15   读写检测 allow                  BashTool.isReadOnly() 检测为只读
  16   passthrough → 询问用户          所有检查均无结论

后台并行（不阻塞主流程）：
  * 推测性 allow 分类器              buildPendingClassifierCheck 非空时，
    在权限对话框展示期间后台运行 → 高置信度匹配 → auto-approve
```

### 源文件索引

| 文件 | 职责 |
|-----|-----|
| `src/tools/BashTool/bashPermissions.ts` | 主权限检查逻辑（2600+ 行） |
| `src/utils/permissions/bashClassifier.ts` | 提示词分类器接口（外部为 stub） |
| `src/utils/permissions/shellRuleMatching.ts` | 规则解析与匹配工具函数 |
| `src/utils/bash/ast.ts` | AST 安全分析（parseForSecurity*） |
| `src/utils/bash/parser.ts` | tree-sitter 解析门控 |
| `src/tools/BashTool/pathValidation.ts` | 路径约束检查 |
| `src/tools/BashTool/sedValidation.ts` | sed 命令约束检查 |
| `src/tools/BashTool/modeValidation.ts` | 权限模式特定检查 |
| `src/tools/BashTool/bashCommandHelpers.ts` | 操作符权限检查 |
| `src/tools/BashTool/bashSecurity.ts` | Legacy 安全检查（正则模式） |
