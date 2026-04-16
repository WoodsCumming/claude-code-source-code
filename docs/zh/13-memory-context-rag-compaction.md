# Claude Code：记忆、上下文、RAG、压缩策略技术文档

> 基于 Claude Code v2.1.88 源码分析

---

## 概览

四个系统协同工作，共同解决"如何在有限上下文窗口内最大化信息利用率"这一核心问题：

| 系统 | 核心目标 | 关键文件 |
|------|---------|---------|
| **记忆（Memory）** | 跨会话持久化重要信息 | `src/memdir/` |
| **上下文组装（Context）** | 每次 API 调用前构建 system prompt | `src/context.ts`、`src/constants/prompts.ts` |
| **RAG / 相关记忆检索** | 按需检索最相关的记忆文件 | `src/memdir/findRelevantMemories.ts` |
| **压缩（Compaction）** | token 超限时压缩对话历史 | `src/services/compact/` |

> **注意**：记忆文件实际存储在 `~/.claude/projects/<cwd-slug>/memory/`，而非 `~/.claude/projects/` 根目录。根目录下存放的是会话历史（`.jsonl`）和工具输出溢出文件（`tool-results/*.txt`），记忆目录按需惰性创建，从未写入记忆时不存在。

---

## 一、记忆系统（Memory）

### 1.1 存储结构

记忆以 Markdown 文件形式存储在本地磁盘，按项目隔离：

```
~/.claude/projects/<cwd-slug>/memory/
  MEMORY.md           ← 索引文件（最多 200 行 / 25KB）
  user_role.md        ← 单条记忆（带 frontmatter）
  feedback_testing.md
  project_deadline.md
  team/               ← 团队共享记忆（feature: TEAMMEM）
  logs/               ← 助手模式日志（feature: KAIROS）
    2026/04/
      2026-04-15.md
```

**索引文件 MEMORY.md 格式**（`src/memdir/memdir.ts:34`）：

```markdown
- [用户角色](user_role.md) — 一行摘要
- [测试反馈](feedback_testing.md) — 一行摘要
```

**单条记忆文件格式**（frontmatter 必填）：

```markdown
---
name: 记忆名称
description: 一行描述（供 RAG 检索时判断相关性）
type: user | feedback | project | reference
---

记忆正文内容
```

四种类型定义（`src/memdir/memoryTypes.ts:14`）：

```typescript
// src/memdir/memoryTypes.ts:14
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
// src/memdir/memoryTypes.ts:21
export type MemoryType = (typeof MEMORY_TYPES)[number]
```

- `user`（第 15 行）：用户角色、偏好、知识背景
- `feedback`（第 16 行）：用户对 Claude 行为的纠正或确认
- `project`（第 17 行）：当前项目的目标、进度、决策
- `reference`（第 18 行）：外部系统的资源指针（Linear、Slack 频道等）

各类型的详细使用指导以 `TYPES_SECTION_INDIVIDUAL`（第 113 行）/ `TYPES_SECTION_COMBINED`（第 37 行）常量形式存储，在 `buildMemoryLines()` 中注入到 system prompt。

### 1.2 索引文件的截断策略

**文件：`src/memdir/memdir.ts`**（第 34–103 行）

```typescript
// src/memdir/memdir.ts:34
export const ENTRYPOINT_NAME = 'MEMORY.md'
// src/memdir/memdir.ts:35
export const MAX_ENTRYPOINT_LINES = 200      // 行数上限，超出后追加警告
// src/memdir/memdir.ts:38
export const MAX_ENTRYPOINT_BYTES = 25_000   // 字节上限

// src/memdir/memdir.ts:41
export type EntrypointTruncation = {
  content: string        // 截断后的内容（含警告）
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

// src/memdir/memdir.ts:57
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  // L63: wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  // L66: wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES（检查原始字节数，非截断后）
  // L78: 先行截断 → contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
  // L82: 再字节截断 → truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)（在换行处截断）
  // L94: 返回截断内容 + 警告文本（提示清理旧条目）
}
```

### 1.3 记忆目录扫描

**文件：`src/memdir/memoryScan.ts`**（第 13–94 行）

```typescript
// src/memdir/memoryScan.ts:13
export type MemoryHeader = {
  filename: string       // 相对路径（如 user_role.md）
  filePath: string       // 绝对路径
  mtimeMs: number        // 修改时间（用于排序和新鲜度判断）
  description: string | null  // frontmatter.description（RAG 检索依赖此字段）
  type: MemoryType | undefined
}

// src/memdir/memoryScan.ts:21
const MAX_MEMORY_FILES = 200      // 最多扫描 200 个文件
// src/memdir/memoryScan.ts:22
const FRONTMATTER_MAX_LINES = 30  // 每个文件只读前 30 行（仅需 frontmatter）

// src/memdir/memoryScan.ts:35
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  // L40: readdir(memoryDir, { recursive: true }) 递归扫描
  // L41: 过滤 .md 文件，排除 MEMORY.md 本身
  // L45: Promise.allSettled 并行读取所有文件的 frontmatter
  // L48: readFileInRange(filePath, 0, FRONTMATTER_MAX_LINES) — 只读前 30 行
  // L72: 按 mtimeMs 倒序排列（最新优先）
  // L73: .slice(0, MAX_MEMORY_FILES) — 最多 200 个
}

// src/memdir/memoryScan.ts:84
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  // 格式：- [type] filename (ISO时间戳): description
  // 供 Sonnet 排序器使用
}
```

### 1.4 记忆注入到 System Prompt

**文件：`src/constants/prompts.ts`**（第 517 行）

```typescript
// src/constants/prompts.ts:517
systemPromptSection('memory', () => loadMemoryPrompt()),
// ↑ 会话级缓存，/clear 或 /compact 后失效并重新计算
```

`loadMemoryPrompt()`（`src/memdir/memdir.ts:419`）的完整执行路径：

```typescript
// src/memdir/memdir.ts:419
export async function loadMemoryPrompt(): Promise<string | null> {
  // L421: autoEnabled = isAutoMemoryEnabled()
  // L423: skipIndex = feature('tengu_moth_copse')
  //        → true 时跳过 MEMORY.md 索引注入（改用 attachment 预取）

  // L433: feature('KAIROS') && autoEnabled && getKairosActive()
  //        → 助手模式：返回 buildAssistantDailyLogPrompt()（日志模式）

  // L449: feature('TEAMMEM') && isTeamMemoryEnabled()
  //        → 团队模式：返回 buildCombinedMemoryPrompt()（合并个人+团队）

  // L476: autoEnabled（标准模式）
  //        → ensureMemoryDirExists(autoDir)   ← 惰性创建目录
  //        → buildMemoryLines('auto memory', autoDir, ...).join('\n')
}

// src/memdir/memdir.ts:199
export function buildMemoryLines(
  displayName: string,   // 'auto memory' | 'team memory' 等
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,     // true 时省略 MEMORY.md 两步写入指南
): string[] {
  // 返回完整的记忆系统行为指导文本，包含：
  // - TYPES_SECTION_INDIVIDUAL（4 种类型的定义）
  // - WHAT_NOT_TO_SAVE_SECTION（不应保存的内容）
  // - WHEN_TO_ACCESS_SECTION（何时读取记忆）
  // - TRUSTING_RECALL_SECTION（记忆验证规则）
  // - MEMORY_FRONTMATTER_EXAMPLE（frontmatter 格式示例）
  // - 两步写入指南（Step 1: 写文件，Step 2: 更新 MEMORY.md 索引）
  // - 当前 MEMORY.md 内容（截断后）
}

// src/memdir/memdir.ts:272
export function buildMemoryPrompt(params: {
  memoryDir: string
  entrypointContent: string | null
  // ...
}): string {
  // 将 buildMemoryLines() 的指导 + MEMORY.md 内容组合成最终 prompt 块
}

// src/memdir/memdir.ts:375
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  // feature('tengu_coral_fern') 启用时追加
  // 告知模型可通过 "Searching past context" 查找历史对话
}
```

### 1.5 记忆路径与启用条件

**文件：`src/memdir/paths.ts`**

```typescript
// src/memdir/paths.ts:30
export function isAutoMemoryEnabled(): boolean {
  // 检查顺序（短路求值）：
  // 1. CLAUDE_CODE_DISABLE_AUTO_MEMORY env var → false
  // 2. settings.autoMemory 用户设置
  // 3. feature gate 兜底
}

// src/memdir/paths.ts:69
export function isExtractModeActive(): boolean {
  // feature('EXTRACT_MEMORIES') 启用时
  // 后台 Agent 自动从对话中提取记忆
}

// src/memdir/paths.ts:85
export function getMemoryBaseDir(): string {
  // 返回 ~/.claude/projects/<cwd-slug>/
}

// src/memdir/paths.ts:92
const AUTO_MEM_DIRNAME = 'memory'
// src/memdir/paths.ts:93
const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

// src/memdir/paths.ts:223
export const getAutoMemPath = memoize(
  // 返回 ~/.claude/projects/<cwd-slug>/memory/
  // slug 由 cwd 绝对路径转义生成（/ → -），保证跨会话稳定
  // memoize：进程内只计算一次
)

// src/memdir/paths.ts:246
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  // 返回 ~/.claude/projects/<slug>/memory/logs/YYYY/MM/YYYY-MM-DD.md
  // KAIROS 助手模式专用
}

// src/memdir/paths.ts:257
export function getAutoMemEntrypoint(): string {
  // 返回 ~/.claude/projects/<slug>/memory/MEMORY.md
}

// src/memdir/paths.ts:274
export function isAutoMemPath(absolutePath: string): boolean {
  // 判断路径是否在记忆目录内（用于过滤注入到 getUserContext 的文件）
}
```

### 1.6 KAIROS 助手模式的日志记忆

当 `feature('KAIROS')` 启用时，记忆系统切换为**追加式日志模式**（`src/memdir/memdir.ts:327`）：

```
~/.claude/projects/<slug>/memory/logs/2026/04/2026-04-15.md
```

每天一个文件，追加写入，不维护索引。适用于长期运行的助手场景。

---

## 二、上下文组装（Context Assembly）

### 2.1 总体架构

每次 API 调用前，上下文由三个并行获取的部分拼装而成：

**文件：`src/utils/queryContext.ts`**（第 44–74 行）

```typescript
// src/utils/queryContext.ts:44
export async function fetchSystemPromptParts({ tools, mainLoopModel, ... }) {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    // L62: customSystemPrompt 存在时跳过 getSystemPrompt()（自定义 prompt 完全替代）
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(tools, mainLoopModel, additionalWorkingDirectories, mcpClients),
    getUserContext(),    // CLAUDE.md + currentDate
    // L71: customSystemPrompt 存在时跳过 getSystemContext()（不需要 git 状态）
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}
```

### 2.2 System Prompt 组装

**文件：`src/constants/prompts.ts`**（第 444–611 行）

```typescript
// src/constants/prompts.ts:444
export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]> {
  // L451: CLAUDE_CODE_SIMPLE → 返回最小化 prompt（一行 CWD + Date）
  // L475: PROACTIVE/KAIROS 激活 → 返回自主 Agent prompt（含 loadMemoryPrompt）

  // L465: 并行预取（标准路径）
  const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
    getSkillToolCommands(cwd),           // 技能工具列表（供 session_guidance 使用）
    getOutputStyleConfig(),              // 输出样式配置
    computeSimpleEnvInfo(model, ...),    // 环境信息（L685）
  ])

  // L512: 动态区块（会话级缓存，/clear 或 /compact 后重新计算）
  const dynamicSections = [
    systemPromptSection('session_guidance', () =>
      getSessionSpecificGuidanceSection(enabledTools, skillToolCommands)),  // L352
    systemPromptSection('memory', () => loadMemoryPrompt()),                // L517 ← 记忆注入点
    systemPromptSection('ant_model_override', () => getAntModelOverrideSection()),  // L136
    systemPromptSection('env_info_simple', () => computeSimpleEnvInfo(...)),  // L685
    systemPromptSection('language', () => getLanguageSection(settings.language)),  // L142
    systemPromptSection('output_style', () => getOutputStyleSection(...)),   // L151
    DANGEROUS_uncachedSystemPromptSection('mcp_instructions', () =>          // L536
      isMcpInstructionsDeltaEnabled() ? null : getMcpInstructionsSection(mcpClients),
      'MCP servers connect/disconnect between turns'),
    systemPromptSection('scratchpad', () => getScratchpadInstructions()),    // L831
    systemPromptSection('frc', () => getFunctionResultClearingSection(model)),  // L855
    systemPromptSection('summarize_tool_results', () => SUMMARIZE_TOOL_RESULTS_SECTION),  // L875
  ]

  // L583: 返回 [静态区块..., DYNAMIC_BOUNDARY, ...动态区块]
  return [
    // 静态区块（进程内全局缓存，不受 /clear 影响）：
    getSimpleIntroSection(outputStyleConfig),    // L175 "You are Claude Code..."
    getSimpleSystemSection(),                    // L186
    getSimpleDoingTasksSection(),                // L199
    getActionsSection(),                         // L255
    getUsingYourToolsSection(enabledTools),      // L269
    getSimpleToneAndStyleSection(),              // L430
    getOutputEfficiencySection(),                // L403
    // L607: SYSTEM_PROMPT_DYNAMIC_BOUNDARY（L114）— prompt cache 分界标记
    ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
    // 动态区块（会话级缓存）：
    ...resolvedDynamicSections,
  ].filter(s => s !== null)
}
```

### 2.3 System Prompt 缓存机制

**文件：`src/constants/systemPromptSections.ts`**（第 1–68 行）

```typescript
// src/constants/systemPromptSections.ts:8
type ComputeFn = () => string | null | Promise<string | null>

// src/constants/systemPromptSections.ts:10
type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean   // false = 标准缓存，true = 每次重算
}

// src/constants/systemPromptSections.ts:20
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
  // 结果存入 systemPromptSectionCache（Map，在 bootstrap/state.ts 中维护）
  // 同一 name 命中缓存时直接返回，不重新执行 compute
}

// src/constants/systemPromptSections.ts:32
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,   // 必须提供原因，强制文档化为何绕过缓存
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
  // 每次 resolveSystemPromptSections() 都重新执行 compute
  // 用于 MCP 服务器连接/断开（mid-session 变化）
}

// src/constants/systemPromptSections.ts:43
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()
  return Promise.all(
    sections.map(async s => {
      // L50: !s.cacheBreak && cache.has(s.name) → 直接返回缓存值
      // L53: 否则执行 compute()，写入缓存
      if (!s.cacheBreak && cache.has(s.name)) return cache.get(s.name) ?? null
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}

// src/constants/systemPromptSections.ts:65
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()   // 清空 systemPromptSectionCache Map
  clearBetaHeaderLatches()          // 重置 AFK/fast-mode/cache-editing header 状态
  // 在 /clear 和 /compact 时调用
}
```

### 2.4 getUserContext：CLAUDE.md 注入

**文件：`src/context.ts`**（第 157–194 行）

```typescript
// src/context.ts:157
export const getUserContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    // L164: CLAUDE_CODE_DISABLE_CLAUDE_MDS → 完全禁用 CLAUDE.md 加载
    // L169: --bare 模式且无 --add-dir → 跳过自动发现
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)

    // L172: getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    //   getMemoryFiles()：扫描记忆目录，获取已注入的记忆文件路径集合
    //   filterInjectedMemoryFiles()：从 CLAUDE.md 候选列表中排除记忆目录内的文件
    //   getClaudeMds()：从 cwd 向上遍历至 home，收集所有 CLAUDE.md 并拼接
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))

    // L181: setCachedClaudeMdContent(claudeMd) — 缓存供 yoloClassifier.ts 使用
    // L191: 注入当前日期 "Today's date is YYYY/MM/DD."
    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
```

### 2.5 getSystemContext：Git 状态注入

**文件：`src/context.ts`**（第 20、36–151 行）

```typescript
// src/context.ts:20
const MAX_STATUS_CHARS = 2000   // git status 输出截断上限

// src/context.ts:36
export const getGitStatus = memoize(async (): Promise<string | null> => {
  // L46: getIsGit() — 检查是否在 git 仓库中
  // L61: 并行执行 5 条 git 命令：
  const [branch, mainBranch, status, log, userName] = await Promise.all([
    getBranch(),                                   // git branch --show-current
    getDefaultBranch(),                            // git rev-parse --abbrev-ref origin/HEAD
    execFileNoThrow(gitExe(), ['status', '--short']),  // git status --short
    execFileNoThrow(gitExe(), ['log', '--oneline', '-n', '5']),  // 最近 5 条提交
    execFileNoThrow(gitExe(), ['config', 'user.name']),          // 提交者姓名
  ])
  // L86: status 超过 2000 字符时截断并追加提示
  // L96: 返回格式化的多行字符串（branch, mainBranch, userName, status, log）
})

// src/context.ts:117
export const getSystemContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    // L125: CLAUDE_CODE_REMOTE 或禁用 git 指令 → 跳过 git status
    const gitStatus = isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || !shouldIncludeGitInstructions()
      ? null : await getGitStatus()

    // L132: feature('BREAK_CACHE_COMMAND') → 注入缓存破坏符（ant-only）
    const injection = feature('BREAK_CACHE_COMMAND') ? getSystemPromptInjection() : null

    return {
      ...(gitStatus && { gitStatus }),
      ...(injection ? { cacheBreaker: `[CACHE_BREAKER: ${injection}]` } : {}),
    }
  },
)
```

### 2.6 API 请求中的 System Prompt 构建

**文件：`src/services/api/claude.ts`**

最终 system prompt 在 `query()` 函数中组装为 `TextBlockParam[]`，通过 `buildSystemPromptBlocks()` 添加 `cache_control`：

```typescript
// 最终结构（伪代码）：
system: [
  { type: 'text', text: getAttributionHeader(fingerprint) },  // cc_version, cc_entrypoint
  { type: 'text', text: getCLISyspromptPrefix(...) },         // "You are Claude Code..."
  ...systemPromptSections.map(text => ({ type: 'text', text })),
  // 最后一个块加 cache_control: { type: 'ephemeral' }
  // → 启用 Anthropic prompt caching（1 小时 TTL）
  // → 静态区块命中率高，动态区块每会话计算一次后缓存
]
```

---

## 三、RAG：相关记忆检索

记忆系统的 RAG 实现分两层：**MEMORY.md 索引始终注入**（全量），**相关记忆文件按需检索**（精准）。

### 3.1 检索流程

**文件：`src/memdir/findRelevantMemories.ts`**（第 1–141 行）

```typescript
// src/memdir/findRelevantMemories.ts:13
export type RelevantMemory = {
  path: string      // 记忆文件绝对路径
  mtimeMs: number   // 修改时间（供 attachment 展示新鲜度）
}

// src/memdir/findRelevantMemories.ts:18
// Sonnet 排序器的 system prompt：
// - 只选择"确定有用"的记忆（保守策略，宁缺毋滥）
// - 如果最近使用了某工具，不选该工具的参考文档（已在使用中，无需重复注入）
// - 但仍选择该工具的"警告/已知问题"类记忆（恰恰是使用时最需要的）
const SELECT_MEMORIES_SYSTEM_PROMPT = `...`

// src/memdir/findRelevantMemories.ts:39
export async function findRelevantMemories(
  query: string,                                    // 当前用户输入文本
  memoryDir: string,                                // 记忆目录路径
  signal: AbortSignal,
  recentTools: readonly string[] = [],              // 最近使用的工具名（避免重复注入工具文档）
  alreadySurfaced: ReadonlySet<string> = new Set(), // 本轮已展示的路径（去重）
): Promise<RelevantMemory[]> {
  // L46: scanMemoryFiles(memoryDir) — 扫描目录，读取所有文件 frontmatter
  // L47: .filter(m => !alreadySurfaced.has(m.filePath)) — 排除已展示
  // L53: selectRelevantMemories() — 调用 Sonnet 排序，最多返回 5 个文件名
  // L59: 用文件名查找完整 MemoryHeader，提取 path + mtimeMs
  // L66: feature('MEMORY_SHAPE_TELEMETRY') → logMemoryRecallShape() 记录召回模式
}

// src/memdir/findRelevantMemories.ts:77
async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  // L83: validFilenames = new Set(memories.map(m => m.filename)) — 防止幻觉
  // L85: formatMemoryManifest(memories) — 生成文件名+描述的文本清单
  // L98: sideQuery({ model: getDefaultSonnetModel(), system: SELECT_MEMORIES_SYSTEM_PROMPT })
  //      独立 Sonnet API 调用，不影响主对话上下文
  //      JSON schema output：{ type: 'array', items: { type: 'string' } }
  // L返回: 过滤后的文件名数组（只保留 validFilenames 中存在的）
}
```

### 3.2 检索结果读取与注入

**文件：`src/utils/attachments.ts`**

```typescript
// src/utils/attachments.ts:2196
async function getRelevantMemoryAttachments(
  input: string,
  agents: AgentDefinition[],
  readFileState: FileStateCache,
  recentTools: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
): Promise<Attachment[]> {
  // L2206: 若输入中 @agent-xxx，搜索该 Agent 专属记忆目录（隔离）
  // L2213: 否则搜索 getAutoMemPath()（全局记忆目录）
  // L2215: 并行搜索多个目录（支持多 Agent 同时 @-提及）
  // L2217: findRelevantMemories(input, dir, signal, recentTools, alreadySurfaced)
  // L2241: return [{ type: 'relevant_memories', memories }]
}

// src/utils/attachments.ts:2251
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  // 扫描历史消息中 type === 'attachment' && attachment.type === 'relevant_memories'
  // 返回已展示的路径集合 + 累计字节数
  // 用途：
  //   1. 去重（同一文件本轮不重复展示）
  //   2. 流量控制（totalBytes 超过 RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES 时停止预取）
}

// src/utils/attachments.ts:2279
export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<Array<{ path, content, mtimeMs, header, limit? }>> {
  // 读取每个记忆文件内容（有行数/字节数上限）
  // 超限时追加截断提示 + 文件路径（模型可用 Read 工具查看完整内容）
}

// src/utils/attachments.ts:2327
export function memoryHeader(path: string, mtimeMs: number): string {
  // 格式：<system-reminder>\n<memory path="..." mtime="...">\n...
  // 作为每条记忆的标题注入对话
}
```

### 3.3 异步预取机制

**文件：`src/utils/attachments.ts`**（第 2346–2420 行）

```typescript
// src/utils/attachments.ts:2346
export type MemoryPrefetch = {
  // Disposable 接口，支持 `using` 语法（自动清理）
  // settled: Promise<boolean> — 预取是否完成
}

// src/utils/attachments.ts:2361
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  // L2366: isAutoMemoryEnabled() && feature('tengu_moth_copse') — 双重门控
  //        tengu_moth_copse = false 时退回旧路径（同步注入，不预取）
  // L2372: 提取最后一条真实用户消息（跳过 isMeta 系统注入）
  // L2379: 单词数 < 2 → 跳过（上下文不足，无意义检索）
  // L2383: collectSurfacedMemories(messages) — 收集已展示记忆，传入去重集合
  // L2384: surfaced.totalBytes >= MAX_SESSION_BYTES → 停止预取（会话记忆配额耗尽）
  // 异步启动，返回 MemoryPrefetch handle
  // 下一轮 API 请求时 await handle.settled，将结果作为 attachment 注入
}
```

### 3.4 Skill 搜索（实验性 RAG）

**文件：`src/tools/SkillTool/SkillTool.ts`**（第 108 行），**`src/utils/attachments.ts`**（第 538、805 行）

```typescript
// src/tools/SkillTool/SkillTool.ts:108
const remoteSkillModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      ...require('../../services/skillSearch/remoteSkillState.js'),
      ...require('../../services/skillSearch/remoteSkillLoader.js'),
      ...require('../../services/skillSearch/telemetry.js'),
      ...require('../../services/skillSearch/featureCheck.js'),
    }
  : null
// 动态 require 是为了 dead code elimination：
// 外部构建中 feature() 返回 false → 整个 require 链被删除

// src/utils/attachments.ts:538
// attachment type: 'skill_discovery'

// src/utils/attachments.ts:805
// getTurnZeroSkillDiscovery() — 第 0 轮注入技能发现 attachment
// 让模型在第一轮就了解可用技能，无需等到调用 SkillTool 时才发现
```

`src/services/skillSearch/` 下的模块（编译产物，源码已被 feature flag 删除）：
- `featureCheck.js`：`isSkillSearchEnabled()` — 运行时检查是否启用
- `localSearch.js`：`getSkillIndex()` — 本地技能索引（memoized，按 cwd）
- `prefetch.js`：`getTurnZeroSkillDiscovery()` — 第 0 轮技能发现 attachment
- `remoteSkillState.js`：远程技能状态管理
- `remoteSkillLoader.js`：从 AKI/GCS 加载远程 canonical 技能（ant-only）

---

## 四、压缩策略（Compaction）

### 4.1 三层压缩架构

Claude Code 实现了三种粒度的上下文压缩，从轻到重依次触发：

```
Token 压力增大
  ↓
[轻量] API 原生上下文管理（apiMicrocompact）
  → 通过 API 参数清除旧 tool_use 块 / thinking 块
  → 无需额外 API 调用
  ↓
[中量] 微压缩（microCompact）
  → 将旧工具调用结果替换为 '[Old tool result content cleared]'
  → 基于时间策略（超过一定时间的结果优先清除）
  ↓
[重量] 全量压缩（compactConversation）
  → 调用 Sonnet 生成 9 段结构化摘要
  → 清空历史消息，以摘要替代
  → 重新注入关键附件（技能、计划、文件）
```

### 4.2 触发阈值

**文件：`src/services/compact/autoCompact.ts`**（第 30–241 行）

```typescript
// src/services/compact/autoCompact.ts:30
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000  // 为摘要输出预留的最大 token 数

// src/services/compact/autoCompact.ts:51
export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string                  // 每轮唯一 ID
  consecutiveFailures?: number    // 连续失败次数（熔断计数器）
}

// src/services/compact/autoCompact.ts:62
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000    // 自动压缩安全边距
// src/services/compact/autoCompact.ts:63
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000  // 用户警告阈值（显示 token 警告 UI）
// src/services/compact/autoCompact.ts:64
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000    // 错误阈值
// src/services/compact/autoCompact.ts:65
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000      // 手动 /compact 时的边距
// src/services/compact/autoCompact.ts:70
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3         // 熔断阈值

// src/services/compact/autoCompact.ts:33
export function getEffectiveContextWindowSize(model: string): number {
  // = getContextWindowForModel(model) - min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY)
  // L40: CLAUDE_CODE_AUTO_COMPACT_WINDOW env var → 覆盖上下文窗口大小（测试用）
}

// src/services/compact/autoCompact.ts:72
export function getAutoCompactThreshold(model: string): number {
  // = getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
  // L80: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE env var → 按百分比覆盖（测试用）
}

// src/services/compact/autoCompact.ts:93
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number                   // 剩余 token 百分比（0-100）
  isAboveWarningThreshold: boolean      // 是否显示警告
  isAboveErrorThreshold: boolean        // 是否显示错误
  isAboveAutoCompactThreshold: boolean  // 是否触发自动压缩
  isAtBlockingLimit: boolean            // 是否已到阻塞限制
}

// src/services/compact/autoCompact.ts:147
export function isAutoCompactEnabled(): boolean {
  // L148: DISABLE_COMPACT → false
  // L152: DISABLE_AUTO_COMPACT → false（只禁用自动，手动 /compact 仍可用）
  // L156: userConfig.autoCompactEnabled（用户设置）
}

// src/services/compact/autoCompact.ts:160
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  snipTokensFreed = 0,   // Snip 已释放的 token 数（避免重复计算）
): Promise<boolean> {
  // L171: session_memory / compact querySource → false（防止递归死锁）
  // L185: !isAutoCompactEnabled() → false
  // L195: feature('REACTIVE_COMPACT') → 抑制主动压缩，依赖 API 返回 prompt_too_long
  // L213: tokenCountWithEstimation(messages) - snipTokensFreed > getAutoCompactThreshold()
}

// src/services/compact/autoCompact.ts:241
export async function autoCompactIfNeeded(
  messages: Message[],
  context: ToolUseContext,
  // ...
): Promise<AutoCompactResult> {
  // 先尝试 trySessionMemoryCompaction()（轻量，提取记忆后清空历史）
  // 若失败则调用 compactConversation()（全量摘要压缩）
  // 连续失败 ≥ MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES → 熔断，停止尝试
}
```

### 4.3 API 原生上下文管理（最轻量）

**文件：`src/services/compact/apiMicrocompact.ts`**（第 35、64 行）

通过 API 的 `context_management` 参数，在服务端清除旧内容，**不消耗额外 API 调用**：

```typescript
// src/services/compact/apiMicrocompact.ts:35
export type ContextEditStrategy =
  | {
      type: 'clear_tool_uses_20250919'  // 清除旧 tool_use 块
      trigger?: { type: 'input_tokens'; value: number }
      keep?: { type: 'tool_uses'; value: number }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
    }
  | {
      type: 'clear_thinking_20251015'   // 清除旧 thinking 块
      keep: { type: 'thinking_turns'; value: number } | 'all'
    }

// src/services/compact/apiMicrocompact.ts:64
export function getAPIContextManagement(options?: {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
}): ContextManagementConfig | undefined {
  // 根据是否有 thinking 块、是否空闲超 1 小时等条件
  // 组合 clear_thinking + clear_tool_uses 策略
}
```

### 4.4 微压缩（microCompact）

**文件：`src/services/compact/microCompact.ts`**（第 36–530 行）

```typescript
// src/services/compact/microCompact.ts:36
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
// 替换旧工具结果的占位符文本

// src/services/compact/microCompact.ts:38
const IMAGE_MAX_TOKEN_SIZE = 2000  // 图片 token 超此值时也被清除

// src/services/compact/microCompact.ts:41
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,   // Read  — 文件内容可重新读取
  ...SHELL_TOOL_NAMES,   // Bash  — 命令输出可重新执行
  GREP_TOOL_NAME,        // Grep  — 搜索结果可重新搜索
  GLOB_TOOL_NAME,        // Glob  — 文件列表可重新获取
  WEB_SEARCH_TOOL_NAME,  // WebSearch
  WEB_FETCH_TOOL_NAME,   // WebFetch
  FILE_EDIT_TOOL_NAME,   // Edit  — 编辑结果（diff）可重新生成
  FILE_WRITE_TOOL_NAME,  // Write
  // 注意：AgentTool、SkillTool 等不在此列 — 其结果不可轻易重现
])

// src/services/compact/microCompact.ts:207
export type PendingCacheEdits = { /* cache editing API 所需的编辑指令 */ }
// src/services/compact/microCompact.ts:215
export type MicrocompactResult = {
  messages: Message[]
  pendingCacheEdits?: PendingCacheEdits  // Cached MC 路径才有此字段
}

// src/services/compact/microCompact.ts:253
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // L258: clearCompactWarningSuppression() — 重置压缩警告抑制状态

  // L267: maybeTimeBasedMicrocompact() — 时间触发路径（优先）
  //   evaluateTimeBasedTrigger()（L422）：
  //   - 找到最后一条 assistant 消息的时间戳
  //   - 计算 gapMinutes = (Date.now() - lastAssistant.timestamp) / 60_000
  //   - gapMinutes >= config.gapThresholdMinutes → 触发时间微压缩
  //   - 清除 COMPACTABLE_TOOLS 中最旧的 N 条结果（保留 keepRecent 条）
  //   - 时间触发时跳过 Cached MC（缓存已过期，无需 cache editing）

  // L276: feature('CACHED_MICROCOMPACT') — Cached MC 路径（ant-only）
  //   isCachedMicrocompactEnabled() && isModelSupportedForCacheEditing(model)
  //   && isMainThreadSource(querySource)（只对主线程，防止子 Agent 污染全局状态）
  //   → cachedMicrocompactPath()：通过 API cache editing 删除旧 tool_result
  //     返回 PendingCacheEdits，由调用方在下次 API 请求时附带

  // L288: Legacy path（外部构建、非 ant 用户、不支持的模型）
  //   → { messages }（不做任何压缩，由 autoCompactIfNeeded 处理）
}

// src/services/compact/microCompact.ts:422
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  // L431: 要求显式 main-thread querySource（undefined 不触发，防止分析调用误触发）
  // L434: findLast(m => m.type === 'assistant') — 找最后一条 assistant 消息
  // L438: gapMinutes = (Date.now() - timestamp) / 60_000
  // L440: gapMinutes < config.gapThresholdMinutes → null（未达阈值）
}
```

### 4.5 全量压缩（compactConversation）

**文件：`src/services/compact/compact.ts`**（第 122–1706 行）

关键常量（第 122–131 行）：

```typescript
// src/services/compact/compact.ts:122
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5      // 压缩后最多恢复 5 个文件
// src/services/compact/compact.ts:124
export const POST_COMPACT_TOKEN_BUDGET = 50_000          // 文件恢复总 token 预算
// src/services/compact/compact.ts:125
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000    // 单文件 token 上限
// src/services/compact/compact.ts:130
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000   // 单技能 token 上限
// src/services/compact/compact.ts:131
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000   // 技能恢复总 token 预算
// src/services/compact/compact.ts:132
const MAX_COMPACT_STREAMING_RETRIES = 2   // 流式摘要失败时的重试次数
// src/services/compact/compact.ts:228
const MAX_PTL_RETRIES = 3   // prompt_too_long 时截断重试次数
```

关键类型（第 300–329 行）：

```typescript
// src/services/compact/compact.ts:300
export interface CompactionResult {
  // 压缩结果，包含：摘要文本、压缩前消息数、压缩后消息列表等
}
// src/services/compact/compact.ts:318
export type RecompactionInfo = {
  // 重压缩信息（partial compact 场景使用）
}
```

主函数（第 388–772 行）：

```typescript
// src/services/compact/compact.ts:388
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult> {
  // L402: preCompactTokenCount = tokenCountWithEstimation(messages)
  // L407: onCompactProgress({ type: 'hooks_start', hookType: 'pre_compact' })
  // L414: executePreCompactHooks({ trigger: isAutoCompact ? 'auto' : 'manual' })
  //        → 执行 PreCompact hooks，可注入自定义指令
  // L421: mergeHookInstructions() — 合并 hook 注入的指令与用户自定义指令

  // L436: promptCacheSharingEnabled（默认 true）
  //        → 摘要请求复用主对话的 prompt cache prefix
  //        → 实验验证：false 路径 98% cache miss，每天浪费约 38B token

  // L441: getCompactPrompt(customInstructions) — 构建摘要请求文本
  // L451: for(;;) 循环（处理 prompt_too_long 重试）：
  //   L452: streamCompactSummary() — 流式调用 Sonnet 生成摘要
  //   L460: 检测 PROMPT_TOO_LONG_ERROR_MESSAGE
  //   L465: ptlAttempts++ → truncateHeadForPTLRetry()（L244）截断最旧消息后重试

  // L530: 并行生成压缩后的附件：
  //   createPostCompactFileAttachments()  ← 恢复最近读取的文件
  //   createAsyncAgentAttachmentsIfNeeded()  ← 恢复异步 Agent 结果
  // L546: createPlanAttachmentIfNeeded()   ← 恢复计划文件（Plan Mode）
  // L553: createPlanModeAttachmentIfNeeded()  ← 恢复 Plan Mode 指令
  // L559: createSkillAttachmentIfNeeded()  ← 恢复已调用的技能
  // L568: getDeferredToolsDeltaAttachment()  ← 重新宣告可用工具列表
  // L576: getAgentListingDeltaAttachment()   ← 重新宣告可用 Agent 列表
  // L579: getMcpInstructionsDeltaAttachment()  ← 重新宣告 MCP 指令

  // executePostCompactHooks() — 执行 PostCompact hooks
  // clearSystemPromptSections() — 清空 system prompt 缓存
}

// src/services/compact/compact.ts:773
export async function partialCompactConversation(
  // 局部压缩：只压缩消息列表的一部分（保留头部或尾部）
  // 用于超长会话中的渐进式压缩
)
```

压缩后附件恢复（第 1416–1658 行）：

```typescript
// src/services/compact/compact.ts:1416
export async function createPostCompactFileAttachments(
  preCompactReadFileState: FileStateCache,  // 压缩前的文件读取状态快照
  context: ToolUseContext,
  maxFiles: number,  // = POST_COMPACT_MAX_FILES_TO_RESTORE (5)
): Promise<AttachmentMessage[]>
// 从 preCompactReadFileState 中选取最近读取的文件重新注入
// 按 token 预算（POST_COMPACT_TOKEN_BUDGET = 50K）截断

// src/services/compact/compact.ts:1471
export function createPlanAttachmentIfNeeded(agentId?: string): AttachmentMessage | null
// 若当前 Agent 有活跃计划文件，重新注入

// src/services/compact/compact.ts:1495
export function createSkillAttachmentIfNeeded(agentId?: string): AttachmentMessage | null {
  // L1498: getInvokedSkillsForAgent(agentId) — 获取该 Agent 调用过的技能
  // L1509: 按 invokedAt 倒序排列（最近调用的优先保留）
  // L1513: truncateToTokens(content, POST_COMPACT_MAX_TOKENS_PER_SKILL)
  //        — 每个技能最多 5K tokens（保留头部，通常是使用说明）
  // L1520: 总预算 POST_COMPACT_SKILLS_TOKEN_BUDGET = 25K tokens
  // L1531: 返回 type: 'invoked_skills' attachment
}

// src/services/compact/compact.ts:1658
const SKILL_TRUNCATION_MARKER = '...[truncated]'
// 技能内容被截断时追加的标记
```

### 4.6 压缩提示词（9 段摘要结构）

**文件：`src/services/compact/prompt.ts`**（第 1–374 行）

```typescript
// src/services/compact/prompt.ts:19
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.`
// 设计原因（L12）：Sonnet 4.6+ adaptive thinking 模型有时会在摘要时尝试调用工具
// 若工具调用被拒绝，maxTurns: 1 下无文本输出 → 回退流式路径（约 2.79% 概率）
// 将此段放在最前面并明确说明后果，可将失败率从 2.79% 降至 0.01%

// src/services/compact/prompt.ts:31
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary,
wrap your analysis in <analysis> tags...`
// 要求在摘要前先进行分析（scratchpad），formatCompactSummary() 会去除此块

// src/services/compact/prompt.ts:61
const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary...`
// 9 段摘要结构（L66-L77）：
// 1. Primary Request and Intent  — 用户的所有明确请求（完整捕获）
// 2. Key Technical Concepts      — 技术概念、框架、技术栈
// 3. Files and Code Sections     — 检查/修改/创建的文件，含完整代码片段
// 4. Errors and Fixes            — 错误及修复，含用户反馈
// 5. Problem Solving             — 已解决的问题和进行中的调试
// 6. All User Messages           — 所有非工具结果的用户消息（完整保留，追踪意图变化）
// 7. Pending Tasks               — 明确被要求的待办任务
// 8. Current Work                — 压缩前正在进行的工作（含文件名和代码片段）
// 9. Optional Next Step          — 下一步行动（含原文引用，防止任务漂移）

// src/services/compact/prompt.ts:145
const PARTIAL_COMPACT_PROMPT = `...`
// 局部压缩版本：只摘要最近的消息，保留头部历史不变

// src/services/compact/prompt.ts:208
const PARTIAL_COMPACT_UP_TO_PROMPT = `...`
// 压缩到某个时间点：摘要会被插入会话中间，后续消息继续

// src/services/compact/prompt.ts:269
const NO_TOOLS_TRAILER = `...`
// 附加在 prompt 末尾的工具禁用提醒（双重保障）

// src/services/compact/prompt.ts:274
export function getPartialCompactPrompt(direction: PartialCompactDirection): string
// src/services/compact/prompt.ts:293
export function getCompactPrompt(customInstructions?: string): string {
  // 组合：NO_TOOLS_PREAMBLE + DETAILED_ANALYSIS_INSTRUCTION_BASE
  //       + BASE_COMPACT_PROMPT + customInstructions + NO_TOOLS_TRAILER
}

// src/services/compact/prompt.ts:311
export function formatCompactSummary(summary: string): string {
  // 从摘要中去除 <analysis>...</analysis> 块（scratchpad）
  // 只保留 <summary>...</summary> 内容作为最终摘要
}

// src/services/compact/prompt.ts:337
export function getCompactUserSummaryMessage(summary: string): string
// 将摘要包装为用户消息格式（压缩后的第一条消息）
```

### 4.7 手动压缩命令

**文件：`src/commands/compact/compact.ts`**

```
用户输入 /compact [custom instructions]
  ↓
尝试 trySessionMemoryCompaction()（无自定义指令时）
  ├─ 成功 → 提取会话记忆写入 MEMORY.md，清空历史（轻量路径）
  └─ 失败（有自定义指令 / 不满足条件）→ 回退到 compactConversation()
  ↓
clearSystemPromptSections()    ← 清空 system prompt 缓存（src/constants/systemPromptSections.ts:65）
getUserContext.cache.clear()   ← 清空 CLAUDE.md 缓存（src/context.ts:157）
notifyCompaction()             ← 通知 prompt cache 破坏检测
```

---

## 五、四个系统的协作关系

### 5.1 完整数据流

```
用户提交输入
  │
  ├─ [异步预取，不阻塞]
  │   startRelevantMemoryPrefetch(query)
  │     └─ sideQuery(Sonnet) 对记忆文件排序
  │
  ├─ [构建 API 请求]
  │   fetchSystemPromptParts()
  │     ├─ getSystemPrompt()
  │     │   ├─ systemPromptSection('memory') → loadMemoryPrompt()
  │     │   │   └─ 读取 MEMORY.md（截断到 200行/25KB）
  │     │   └─ 其他静态/动态段落（带缓存）
  │     ├─ getUserContext() → CLAUDE.md + 日期
  │     └─ getSystemContext() → git 状态
  │
  ├─ [注入 Attachments]
  │   ├─ relevant_memories（上一轮预取的结果）
  │   ├─ skill_discovery（实验性，turn 0）
  │   └─ 其他 attachments（文件、计划等）
  │
  └─ [发送 API 请求]
      system: TextBlockParam[]（带 cache_control）
      messages: Message[]
      context_management: ContextManagementConfig（API 原生清除）
        ├─ clear_tool_uses_20250919
        └─ clear_thinking_20251015
  │
  ← API 响应
  │
  ├─ [token 检查]
  │   calculateTokenWarningState(tokenUsage, model)
  │     ├─ 超过警告阈值 → 显示 token 警告
  │     ├─ 超过自动压缩阈值 → autoCompactIfNeeded()
  │     │   ├─ microcompactMessages()（轻量，先尝试）
  │     │   └─ compactConversation()（重量，必要时）
  │     └─ 连续失败 ≥ 3 次 → 熔断，停止自动压缩
  │
  └─ [压缩后恢复]
      clearSystemPromptSections()
      getUserContext.cache.clear()
      重新注入：文件 + 技能 + 计划 + 工具列表
```

### 5.2 缓存失效矩阵

| 操作 | System Prompt 缓存 | getUserContext | getSystemContext | 记忆预取 |
|------|-------------------|----------------|------------------|---------|
| `/clear` | ✅ 清空 | ✅ 清空 | ✅ 清空 | 下轮重跑 |
| `/compact` | ✅ 清空 | ✅ 清空 | 保留 | 下轮重跑 |
| MCP 连接/断开 | 部分（`DANGEROUS_uncached`） | 保留 | 保留 | 保留 |
| 写入记忆文件 | 保留（下轮 `loadMemoryPrompt` 重读） | 保留 | 保留 | 下轮重跑 |
| 进程重启 | 全部清空 | 全部清空 | 全部清空 | 全部清空 |

### 5.3 Prompt Cache 与压缩的交互

全量压缩时复用主对话的 prompt cache（`tengu_compact_cache_prefix` feature，默认 true）：

```typescript
// compact.ts 中 streamCompactSummary() 的关键设计：
// - 摘要请求使用与主对话相同的 cache prefix
// - 避免冷启动 cache miss（实验数据：false 路径 98% cache miss）
// - 节省约 0.76% 的 fleet cache_creation token
```

---

## 六、关键文件索引

### 记忆系统（`src/memdir/`）

| 文件 | 符号 | 行号 | 说明 |
|------|------|------|------|
| `memdir.ts` | `ENTRYPOINT_NAME` | 34 | `'MEMORY.md'` |
| `memdir.ts` | `MAX_ENTRYPOINT_LINES` | 35 | `200`（索引行数上限） |
| `memdir.ts` | `MAX_ENTRYPOINT_BYTES` | 38 | `25_000`（索引字节上限） |
| `memdir.ts` | `EntrypointTruncation` | 41 | 截断结果类型 |
| `memdir.ts` | `truncateEntrypointContent()` | 57 | 行数+字节双重截断 |
| `memdir.ts` | `ensureMemoryDirExists()` | 129 | 惰性创建记忆目录 |
| `memdir.ts` | `buildMemoryLines()` | 199 | 构建记忆系统行为指导文本 |
| `memdir.ts` | `buildMemoryPrompt()` | 272 | 组合指导文本+MEMORY.md内容 |
| `memdir.ts` | `buildSearchingPastContextSection()` | 375 | `tengu_coral_fern` feature 追加段 |
| `memdir.ts` | `loadMemoryPrompt()` | 419 | 记忆注入入口，含 KAIROS/TEAMMEM 分支 |
| `paths.ts` | `isAutoMemoryEnabled()` | 30 | env var + 设置 + feature gate 检查 |
| `paths.ts` | `isExtractModeActive()` | 69 | 自动提取记忆模式 |
| `paths.ts` | `getMemoryBaseDir()` | 85 | `~/.claude/projects/<slug>/` |
| `paths.ts` | `AUTO_MEM_DIRNAME` | 92 | `'memory'` |
| `paths.ts` | `getAutoMemPath` | 223 | memoized，返回记忆目录绝对路径 |
| `paths.ts` | `getAutoMemDailyLogPath()` | 246 | KAIROS 日志路径 |
| `paths.ts` | `getAutoMemEntrypoint()` | 257 | MEMORY.md 绝对路径 |
| `paths.ts` | `isAutoMemPath()` | 274 | 判断路径是否在记忆目录内 |
| `memoryTypes.ts` | `MEMORY_TYPES` | 14 | `['user','feedback','project','reference']` |
| `memoryTypes.ts` | `MemoryType` | 21 | 类型别名 |
| `memoryTypes.ts` | `parseMemoryType()` | 28 | 从 frontmatter 解析类型 |
| `memoryTypes.ts` | `TYPES_SECTION_COMBINED` | 37 | 团队模式的类型说明文本 |
| `memoryTypes.ts` | `TYPES_SECTION_INDIVIDUAL` | 113 | 个人模式的类型说明文本 |
| `memoryTypes.ts` | `WHAT_NOT_TO_SAVE_SECTION` | 183 | 不应保存的内容说明 |
| `memoryTypes.ts` | `WHEN_TO_ACCESS_SECTION` | 216 | 何时读取记忆的说明 |
| `memoryTypes.ts` | `TRUSTING_RECALL_SECTION` | 240 | 记忆验证规则 |
| `memoryTypes.ts` | `MEMORY_FRONTMATTER_EXAMPLE` | 261 | frontmatter 格式示例 |
| `memoryScan.ts` | `MemoryHeader` | 13 | 扫描结果类型（含 description + type） |
| `memoryScan.ts` | `MAX_MEMORY_FILES` | 21 | `200`（最多扫描文件数） |
| `memoryScan.ts` | `FRONTMATTER_MAX_LINES` | 22 | `30`（每文件只读前 30 行） |
| `memoryScan.ts` | `scanMemoryFiles()` | 35 | 递归扫描，按 mtime 倒序，最多 200 个 |
| `memoryScan.ts` | `formatMemoryManifest()` | 84 | 生成供 Sonnet 排序的文本清单 |
| `findRelevantMemories.ts` | `RelevantMemory` | 13 | `{ path, mtimeMs }` |
| `findRelevantMemories.ts` | `SELECT_MEMORIES_SYSTEM_PROMPT` | 18 | Sonnet 排序器的 system prompt |
| `findRelevantMemories.ts` | `findRelevantMemories()` | 39 | RAG 主入口，最多返回 5 个 |
| `findRelevantMemories.ts` | `selectRelevantMemories()` | 77 | 调用 `sideQuery()` 排序 |

### 上下文组装

| 文件 | 符号 | 行号 | 说明 |
|------|------|------|------|
| `src/context.ts` | `MAX_STATUS_CHARS` | 20 | `2000`（git status 截断上限） |
| `src/context.ts` | `getGitStatus` | 36 | memoized，并行 5 条 git 命令 |
| `src/context.ts` | `getSystemContext` | 117 | memoized，含 gitStatus + cacheBreaker |
| `src/context.ts` | `getUserContext` | 157 | memoized，含 claudeMd + currentDate |
| `src/constants/prompts.ts` | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | 114 | prompt cache 分界标记 |
| `src/constants/prompts.ts` | `getSimpleIntroSection()` | 175 | 静态段：身份介绍 |
| `src/constants/prompts.ts` | `getSimpleSystemSection()` | 186 | 静态段：系统说明 |
| `src/constants/prompts.ts` | `getSimpleDoingTasksSection()` | 199 | 静态段：任务执行指南 |
| `src/constants/prompts.ts` | `getActionsSection()` | 255 | 静态段：操作规范 |
| `src/constants/prompts.ts` | `getUsingYourToolsSection()` | 269 | 静态段：工具使用规范 |
| `src/constants/prompts.ts` | `getSessionSpecificGuidanceSection()` | 352 | 动态段：技能/工具列表 |
| `src/constants/prompts.ts` | `getOutputEfficiencySection()` | 403 | 静态段：输出效率 |
| `src/constants/prompts.ts` | `getSimpleToneAndStyleSection()` | 430 | 静态段：风格规范 |
| `src/constants/prompts.ts` | `getSystemPrompt()` | 444 | System prompt 组装主函数 |
| `src/constants/prompts.ts` | `systemPromptSection('memory', ...)` | 517 | **记忆注入点** |
| `src/constants/prompts.ts` | `DANGEROUS_uncachedSystemPromptSection('mcp_instructions', ...)` | 536 | MCP 指令（每次重算） |
| `src/constants/prompts.ts` | `computeSimpleEnvInfo()` | 685 | 环境信息（平台/shell/日期/cwd） |
| `src/constants/prompts.ts` | `getScratchpadInstructions()` | 831 | 思考块指令 |
| `src/constants/prompts.ts` | `getFunctionResultClearingSection()` | 855 | 工具结果清除提示 |
| `src/constants/prompts.ts` | `SUMMARIZE_TOOL_RESULTS_SECTION` | 875 | 工具结果摘要提示 |
| `src/constants/systemPromptSections.ts` | `systemPromptSection()` | 20 | 会话级缓存段落 |
| `src/constants/systemPromptSections.ts` | `DANGEROUS_uncachedSystemPromptSection()` | 32 | 每次重算段落 |
| `src/constants/systemPromptSections.ts` | `resolveSystemPromptSections()` | 43 | 并行解析所有段落（带缓存） |
| `src/constants/systemPromptSections.ts` | `clearSystemPromptSections()` | 65 | 清空缓存（`/clear`、`/compact` 时调用） |
| `src/utils/queryContext.ts` | `fetchSystemPromptParts()` | 44 | 三路并行预取入口 |

### RAG / 相关记忆检索

| 文件 | 符号 | 行号 | 说明 |
|------|------|------|------|
| `src/utils/attachments.ts` | `getRelevantMemoryAttachments()` | 2196 | 支持多目录（Agent @-提及隔离） |
| `src/utils/attachments.ts` | `collectSurfacedMemories()` | 2251 | 收集已展示记忆路径+字节数 |
| `src/utils/attachments.ts` | `readMemoriesForSurfacing()` | 2279 | 读取记忆文件（含截断处理） |
| `src/utils/attachments.ts` | `memoryHeader()` | 2327 | 生成记忆标题（`<memory path=...>`） |
| `src/utils/attachments.ts` | `MemoryPrefetch` | 2346 | 预取 handle 类型（Disposable） |
| `src/utils/attachments.ts` | `startRelevantMemoryPrefetch()` | 2361 | 异步预取入口（`tengu_moth_copse` 门控） |
| `src/utils/attachments.ts` | `collectRecentSuccessfulTools()` | 2465 | 收集最近使用的工具（传给排序器） |

### 压缩系统

| 文件 | 符号 | 行号 | 说明 |
|------|------|------|------|
| `src/services/compact/autoCompact.ts` | `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 30 | `20_000`（摘要输出预留） |
| `src/services/compact/autoCompact.ts` | `AutoCompactTrackingState` | 51 | 压缩追踪状态（含熔断计数器） |
| `src/services/compact/autoCompact.ts` | `AUTOCOMPACT_BUFFER_TOKENS` | 62 | `13_000` |
| `src/services/compact/autoCompact.ts` | `WARNING_THRESHOLD_BUFFER_TOKENS` | 63 | `20_000` |
| `src/services/compact/autoCompact.ts` | `ERROR_THRESHOLD_BUFFER_TOKENS` | 64 | `20_000` |
| `src/services/compact/autoCompact.ts` | `MANUAL_COMPACT_BUFFER_TOKENS` | 65 | `3_000` |
| `src/services/compact/autoCompact.ts` | `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 70 | `3`（熔断阈值） |
| `src/services/compact/autoCompact.ts` | `getEffectiveContextWindowSize()` | 33 | 上下文窗口 - 摘要预留 |
| `src/services/compact/autoCompact.ts` | `getAutoCompactThreshold()` | 72 | 自动压缩触发阈值 |
| `src/services/compact/autoCompact.ts` | `calculateTokenWarningState()` | 93 | 返回 5 个布尔状态 |
| `src/services/compact/autoCompact.ts` | `isAutoCompactEnabled()` | 147 | env var + 用户设置检查 |
| `src/services/compact/autoCompact.ts` | `shouldAutoCompact()` | 160 | 含递归防护 + 熔断检查 |
| `src/services/compact/autoCompact.ts` | `autoCompactIfNeeded()` | 241 | 先 session memory，再全量压缩 |
| `src/services/compact/compact.ts` | `POST_COMPACT_MAX_FILES_TO_RESTORE` | 122 | `5` |
| `src/services/compact/compact.ts` | `POST_COMPACT_TOKEN_BUDGET` | 124 | `50_000` |
| `src/services/compact/compact.ts` | `POST_COMPACT_MAX_TOKENS_PER_FILE` | 125 | `5_000` |
| `src/services/compact/compact.ts` | `POST_COMPACT_MAX_TOKENS_PER_SKILL` | 130 | `5_000` |
| `src/services/compact/compact.ts` | `POST_COMPACT_SKILLS_TOKEN_BUDGET` | 131 | `25_000` |
| `src/services/compact/compact.ts` | `MAX_COMPACT_STREAMING_RETRIES` | 132 | `2` |
| `src/services/compact/compact.ts` | `MAX_PTL_RETRIES` | 228 | `3`（prompt_too_long 重试） |
| `src/services/compact/compact.ts` | `CompactionResult` | 300 | 压缩结果接口 |
| `src/services/compact/compact.ts` | `buildPostCompactMessages()` | 331 | 构建压缩后初始消息列表 |
| `src/services/compact/compact.ts` | `mergeHookInstructions()` | 375 | 合并 hook 注入的自定义指令 |
| `src/services/compact/compact.ts` | `compactConversation()` | 388 | 全量压缩主函数 |
| `src/services/compact/compact.ts` | `partialCompactConversation()` | 773 | 局部压缩（保留头部或尾部） |
| `src/services/compact/compact.ts` | `createCompactCanUseTool()` | 1126 | 压缩过程中的工具权限函数 |
| `src/services/compact/compact.ts` | `createPostCompactFileAttachments()` | 1416 | 恢复最近读取的文件 |
| `src/services/compact/compact.ts` | `createPlanAttachmentIfNeeded()` | 1471 | 恢复计划文件 |
| `src/services/compact/compact.ts` | `createSkillAttachmentIfNeeded()` | 1495 | 恢复已调用技能（按 token 预算） |
| `src/services/compact/compact.ts` | `createPlanModeAttachmentIfNeeded()` | 1543 | 恢复 Plan Mode 指令 |
| `src/services/compact/compact.ts` | `createAsyncAgentAttachmentsIfNeeded()` | 1569 | 恢复异步 Agent 结果 |
| `src/services/compact/compact.ts` | `SKILL_TRUNCATION_MARKER` | 1658 | `'...[truncated]'` |
| `src/services/compact/microCompact.ts` | `TIME_BASED_MC_CLEARED_MESSAGE` | 36 | `'[Old tool result content cleared]'` |
| `src/services/compact/microCompact.ts` | `IMAGE_MAX_TOKEN_SIZE` | 38 | `2000`（图片 token 上限） |
| `src/services/compact/microCompact.ts` | `COMPACTABLE_TOOLS` | 41 | 可被微压缩的工具集合 |
| `src/services/compact/microCompact.ts` | `consumePendingCacheEdits()` | 88 | 获取并清空待发送的 cache edits |
| `src/services/compact/microCompact.ts` | `PendingCacheEdits` | 207 | cache editing API 指令类型 |
| `src/services/compact/microCompact.ts` | `MicrocompactResult` | 215 | 微压缩结果（含可选 cache edits） |
| `src/services/compact/microCompact.ts` | `microcompactMessages()` | 253 | 微压缩主函数（时间触发 + Cached MC） |
| `src/services/compact/microCompact.ts` | `evaluateTimeBasedTrigger()` | 422 | 计算 gapMinutes，判断是否触发 |
| `src/services/compact/prompt.ts` | `NO_TOOLS_PREAMBLE` | 19 | 工具禁用前置提示（防 adaptive thinking） |
| `src/services/compact/prompt.ts` | `DETAILED_ANALYSIS_INSTRUCTION_BASE` | 31 | 分析块指令（scratchpad） |
| `src/services/compact/prompt.ts` | `BASE_COMPACT_PROMPT` | 61 | 9 段摘要结构主体 |
| `src/services/compact/prompt.ts` | `PARTIAL_COMPACT_PROMPT` | 145 | 局部压缩版本 |
| `src/services/compact/prompt.ts` | `PARTIAL_COMPACT_UP_TO_PROMPT` | 208 | 压缩到时间点版本 |
| `src/services/compact/prompt.ts` | `NO_TOOLS_TRAILER` | 269 | 工具禁用尾部提醒 |
| `src/services/compact/prompt.ts` | `getPartialCompactPrompt()` | 274 | 局部压缩 prompt 构建 |
| `src/services/compact/prompt.ts` | `getCompactPrompt()` | 293 | 全量压缩 prompt 构建 |
| `src/services/compact/prompt.ts` | `formatCompactSummary()` | 311 | 去除 `<analysis>` 块 |
| `src/services/compact/prompt.ts` | `getCompactUserSummaryMessage()` | 337 | 包装为用户消息格式 |
| `src/services/compact/apiMicrocompact.ts` | `ContextEditStrategy` | 35 | `clear_tool_uses` / `clear_thinking` 策略类型 |
| `src/services/compact/apiMicrocompact.ts` | `ContextManagementConfig` | 59 | `{ edits: ContextEditStrategy[] }` |
| `src/services/compact/apiMicrocompact.ts` | `getAPIContextManagement()` | 64 | 构建 API `context_management` 参数 |
