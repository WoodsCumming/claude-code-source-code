# SKILL.md 文档格式与加载机制

> 基于 Claude Code v2.1.88 源码分析

---

## 一、SKILL.md 文档格式

文件必须放在 `~/.claude/skills/<skill-name>/SKILL.md`（**目录格式**，不支持直接放 `.md` 单文件，`src/skills/loadSkillsDir.ts:452`）。

### 完整格式

```markdown
---
# ── 基本信息 ──────────────────────────────────────────
name: 显示名称（可选，覆盖目录名）
description: 一行描述（不填则从正文第一段提取）
version: "1.0.0"

# ── 调用控制 ──────────────────────────────────────────
user-invocable: true             # 用户可否 /skill-name 调用（默认 true）
disable-model-invocation: false  # 禁止模型通过 Skill 工具调用

# ── 工具权限 ──────────────────────────────────────────
allowed-tools:                   # 该技能运行期间允许的工具
  - Bash(git add:*)
  - Bash(git commit:*)
  - Read

# ── 参数 ──────────────────────────────────────────────
arguments: arg1, arg2            # 声明参数名，正文中用 $arg1/$arg2 引用
argument-hint: <message>         # 参数提示文本（灰色显示在命令后）

# ── 模型与资源 ────────────────────────────────────────
model: opus                      # 覆盖模型（opus/sonnet/haiku/inherit）
effort: max                      # token 预算（min/max 或 1-8）

# ── 执行上下文 ────────────────────────────────────────
context: fork                    # inline（默认）或 fork（独立子 Agent）
agent: general-purpose           # fork 时使用的 Agent 类型

# ── 条件激活 ──────────────────────────────────────────
paths: src/**/*.ts               # 仅操作匹配文件时才激活此技能
when_to_use: "当需要...时使用"    # 模型调用时机指导

# ── 生命周期 Hooks ────────────────────────────────────
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: echo "before tool"

# ── Shell 类型（影响 !`command` 执行） ──────────────────
shell: bash                      # bash 或 powershell
---

# 技能正文（Markdown）

正文内容会直接注入到 Claude 的对话上下文。

## 支持的变量替换

$arg1 $arg2          ← 替换为用户传入的参数
$ARGUMENTS           ← 所有参数的原始字符串
${CLAUDE_SKILL_DIR}  ← 替换为技能目录的绝对路径
${CLAUDE_SESSION_ID} ← 替换为当前会话 ID

## 支持内联 Shell 命令

!`git status`        ← 执行命令，将输出注入到提示中
```!
git log --oneline -5
```                  ← 多行 shell 块
```

---

## 二、YAML Frontmatter 的剥离、解析、加载全流程

### 2.1 正则剥离（`src/utils/frontmatterParser.ts:123`）

```typescript
// frontmatterParser.ts:123
export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/
```

`parseFrontmatter(markdown, sourcePath)` 用这个正则匹配文件头：

```
---          ← 开头的 ---（允许后面有空格）
([\s\S]*?)   ← 捕获组：YAML 内容（非贪婪，遇到第二个 --- 停止）
---          ← 结束的 ---
```

匹配后（`frontmatterParser.ts:130`）：
- `match[1]` = YAML 文本
- `markdown.slice(match[0].length)` = 剩余 Markdown 正文

没有 frontmatter 时直接返回 `{ frontmatter: {}, content: markdown }`。

### 2.2 YAML 解析（`src/utils/yaml.ts`）

```typescript
// yaml.ts
export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return Bun.YAML.parse(input)        // Bun 内置，零开销
  }
  return require('yaml').parse(input)   // Node.js 下懒加载 ~270KB 的 yaml 包
}
```

解析前有一个**预处理步骤**——`quoteProblematicValues()`（`frontmatterParser.ts:85`）：

```typescript
// frontmatterParser.ts:79
// 需要自动加引号的特殊字符集合
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

// 对每行 key: value 检查，若 value 含特殊字符则自动加双引号
// 例如：allowed-tools: Bash(git add:*)
//   → allowed-tools: "Bash(git add:*)"
```

这是为了让 glob 模式（`**/*.{ts,tsx}`）、Bash 权限规则（`Bash(git *)`）等不合法 YAML 值能被正确解析。

**两次尝试策略**（`frontmatterParser.ts:148`）：
1. 先直接 `parseYaml(frontmatterText)` — 大多数合法 YAML 直接成功
2. 若抛异常，再 `quoteProblematicValues()` 预处理后重试
3. 两次都失败 → 打 warn 日志，返回空 `frontmatter: {}`，**不崩溃**

### 2.3 类型化（`FrontmatterData`，`frontmatterParser.ts:10`）

解析结果被断言为 `FrontmatterData` 类型：

```typescript
// frontmatterParser.ts:10
export type FrontmatterData = {
  'allowed-tools'?: string | string[] | null
  description?: string | null
  type?: string | null              // 记忆文件专用
  'argument-hint'?: string | null
  when_to_use?: string | null
  version?: string | null
  model?: string | null
  'user-invocable'?: string | null
  hooks?: HooksSettings | null
  effort?: string | null
  context?: 'inline' | 'fork' | null
  agent?: string | null
  paths?: string | string[] | null
  shell?: string | null
  [key: string]: unknown            // 允许任意额外字段（开放扩展）
}

export type ParsedMarkdown = {
  frontmatter: FrontmatterData
  content: string                   // frontmatter 之后的 Markdown 正文
}
```

所有字段都是可选且允许 `null`（YAML 中 `key:` 无值时返回 null）。

### 2.4 字段解析（`parseSkillFrontmatterFields`，`src/skills/loadSkillsDir.ts:204`）

从非类型安全的 `FrontmatterData` 提取并校验每个字段：

```typescript
// loadSkillsDir.ts:204
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
): { displayName, description, allowedTools, argumentNames, model, ... } {

  // allowed-tools：string | string[] | null → string[]
  allowedTools: parseSlashCommandToolsFromFrontmatter(frontmatter['allowed-tools'])

  // paths：支持逗号分隔或 YAML 数组，支持 brace 展开
  // splitPathInFrontmatter("src/*.{ts,tsx}") → ["src/*.ts", "src/*.tsx"]
  const paths = parseSkillPaths(frontmatter)   // loadSkillsDir.ts:159

  // model：'inherit' → undefined（使用全局默认）
  const model = frontmatter.model === 'inherit'
    ? undefined
    : parseUserSpecifiedModel(frontmatter.model)  // 'opus'/'sonnet'/'haiku' → 标准化

  // user-invocable：字符串 → 布尔，默认 true
  const userInvocable = frontmatter['user-invocable'] === undefined
    ? true
    : parseBooleanFrontmatter(frontmatter['user-invocable'])  // "true"/"false" → boolean

  // description：优先用 frontmatter.description，否则从正文第一段提取
  const description = validatedDescription
    ?? extractDescriptionFromMarkdown(markdownContent, 'Skill')
}
```

`splitPathInFrontmatter()` 支持 brace 展开（`frontmatterParser.ts:189`）：

```typescript
splitPathInFrontmatter("a, src/*.{ts,tsx}")
// → ["a", "src/*.ts", "src/*.tsx"]

splitPathInFrontmatter("{a,b}/{c,d}")
// → ["a/c", "a/d", "b/c", "b/d"]

splitPathInFrontmatter(["a", "src/*.{ts,tsx}"])  // 也接受 YAML 数组
// → ["a", "src/*.ts", "src/*.tsx"]
```

### 2.5 构造 Command 对象加载到内存（`createSkillCommand`，`loadSkillsDir.ts:292`）

所有解析结果传入 `createSkillCommand()`，构造一个 `Command` 对象存入内存：

```typescript
// loadSkillsDir.ts:292
export function createSkillCommand({ skillName, markdownContent, ... }): Command {
  return {
    type: 'prompt',
    name: skillName,           // 目录名
    description,               // frontmatter.description 或正文第一段
    allowedTools,              // 解析后的工具列表
    model,                     // 解析后的模型名
    context: executionContext, // 'inline' | 'fork' | undefined
    // ... 其他字段

    // 关键：内容不是立即展开，而是惰性求值
    // loadSkillsDir.ts:366
    async getPromptForCommand(args, toolUseContext) {
      // 1. 拼接 baseDir 前缀（若有参考文件）
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      // 2. 替换 $arg1/$arg2 等参数占位符
      finalContent = substituteArguments(finalContent, args, true, argumentNames)

      // 3. 替换 ${CLAUDE_SKILL_DIR} → 技能目录绝对路径
      finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)

      // 4. 替换 ${CLAUDE_SESSION_ID} → 当前会话 ID
      finalContent = finalContent.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

      // 5. 执行 !`command` 内联 shell 命令
      //    MCP 技能跳过此步（loadedFrom !== 'mcp'），防止远程代码注入
      if (loadedFrom !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(finalContent, ...)
      }

      return [{ type: 'text', text: finalContent }]
    },
  }
}
```

这个 Command 对象被推入 `getSkillDirCommands()` 的返回数组，最终通过 `loadAllCommands()` 合并进全局命令列表，**memoize 缓存**（按 cwd 键），进程内只加载一次。

---

## 三、完整调用链

```
fs.readFile('~/.claude/skills/my-skill/SKILL.md')    ← 读原始字符串
  ↓
parseFrontmatter(content, filePath)                   ← frontmatterParser.ts:130
  ├─ FRONTMATTER_REGEX.match()                        ← 正则剥离 YAML 块（第 123 行）
  ├─ parseYaml(frontmatterText)                       ← yaml.ts（Bun.YAML 或 npm yaml）
  │   └─ 失败 → quoteProblematicValues() 后重试       ← 处理 glob/Bash 规则等特殊字符（第 85 行）
  └─ 返回 { frontmatter: FrontmatterData, content: string }
  ↓
parseSkillFrontmatterFields(frontmatter, markdownContent, skillName)
  ├─ 每个字段独立解析（类型转换 + 默认值 + 校验）    ← loadSkillsDir.ts:204
  └─ 返回结构化对象
  ↓
parseSkillPaths(frontmatter)                          ← loadSkillsDir.ts:159
  └─ splitPathInFrontmatter() brace 展开              ← frontmatterParser.ts:189
  ↓
createSkillCommand({ ...parsed, skillName, markdownContent, ... })
  └─ 返回 Command 对象（含惰性 getPromptForCommand 闭包）  ← loadSkillsDir.ts:292
  ↓
推入 commands[] 数组，memoize 缓存（按 cwd 键）
```

---

## 四、关键约束

| 约束 | 说明 |
|------|------|
| **必须是目录格式** | `skills/<name>/SKILL.md`，直接放 `skills/<name>.md` 不生效（`loadSkillsDir.ts:452`） |
| **文件名大小写** | 必须是 `SKILL.md`（`isSkillFile` 用大小写不敏感正则 `/^skill\.md$/i` 匹配） |
| **MCP 技能不执行 shell** | `loadedFrom === 'mcp'` 时跳过 `!command` 执行，防止远程代码注入（`loadSkillsDir.ts:400`） |
| **paths 条件激活** | 有 `paths` 字段的技能不进入默认命令列表，只在操作匹配文件后激活（`loadSkillsDir.ts:829`） |
| **YAML 解析容错** | 两次尝试策略，失败不崩溃，返回空 frontmatter（`frontmatterParser.ts:148`） |
| **内容惰性求值** | `markdownContent` 在加载时只存储为字符串，变量替换和 shell 执行在调用时才发生 |

---

## 五、关键文件索引

| 文件 | 符号 | 行号 | 说明 |
|------|------|------|------|
| `src/utils/frontmatterParser.ts` | `FrontmatterData` | 10 | frontmatter 字段类型定义 |
| `src/utils/frontmatterParser.ts` | `ParsedMarkdown` | 61 | 解析结果类型 |
| `src/utils/frontmatterParser.ts` | `YAML_SPECIAL_CHARS` | 79 | 需要预处理的特殊字符集 |
| `src/utils/frontmatterParser.ts` | `quoteProblematicValues()` | 85 | 自动给含特殊字符的值加引号 |
| `src/utils/frontmatterParser.ts` | `FRONTMATTER_REGEX` | 123 | `---` 块剥离正则 |
| `src/utils/frontmatterParser.ts` | `parseFrontmatter()` | 130 | 主解析函数（剥离 + YAML 解析） |
| `src/utils/frontmatterParser.ts` | `splitPathInFrontmatter()` | 189 | 逗号分隔 + brace 展开 |
| `src/utils/yaml.ts` | `parseYaml()` | 9 | YAML 解析（Bun 内置 or npm yaml） |
| `src/skills/loadSkillsDir.ts` | `parseSkillFrontmatterFields()` | 204 | 字段提取与类型转换 |
| `src/skills/loadSkillsDir.ts` | `parseSkillPaths()` | 159 | paths 字段解析 |
| `src/skills/loadSkillsDir.ts` | `createSkillCommand()` | 292 | 构造 Command 对象 |
| `src/skills/loadSkillsDir.ts` | `getPromptForCommand()` | 366 | 惰性内容展开（变量替换 + shell） |
| `src/skills/loadSkillsDir.ts` | `loadSkillsFromSkillsDir()` | 434 | 单目录加载主函数 |
| `src/skills/loadSkillsDir.ts` | `isSkillFile()` | 512 | 大小写不敏感的 SKILL.md 匹配 |
