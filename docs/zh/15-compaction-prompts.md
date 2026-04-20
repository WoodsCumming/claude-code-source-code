# Claude Code 上下文压缩 Prompt 完整源码

> 基于 Claude Code v2.1.88 源码分析  
> 源文件：`src/services/compact/prompt.ts`

---

## 概览

压缩 prompt 由 4 个常量拼接而成，有 3 个变体对应不同压缩场景：

```
最终 prompt = NO_TOOLS_PREAMBLE
            + <主体模板（3 选 1）>
            + （可选）customInstructions
            + NO_TOOLS_TRAILER
```

| 常量 | 行号 | 作用 |
|------|------|------|
| `NO_TOOLS_PREAMBLE` | 23 | 前置警告，禁止调用工具（放最前，降低工具调用失败率 2.79%→0.01%） |
| `BASE_COMPACT_PROMPT` | 77 | 全量压缩主体（9 段摘要结构） |
| `PARTIAL_COMPACT_PROMPT` | 162 | 局部压缩主体（只摘要最近消息） |
| `PARTIAL_COMPACT_UP_TO_PROMPT` | 226 | 插入式压缩主体（摘要插入会话中间） |
| `NO_TOOLS_TRAILER` | 288 | 尾部提醒，双重保障禁止工具调用 |

---

## 一、`NO_TOOLS_PREAMBLE`（第 23 行）

设计原因：Sonnet 4.6+ adaptive thinking 模型有时会在摘要时尝试调用工具。`maxTurns: 1` 下工具调用被拒绝后无文本输出，触发流式回退路径（约 2.79% 概率）。将此段放最前面并明确说明后果，可将失败率降至 0.01%。

```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
```

---

## 二、`DETAILED_ANALYSIS_INSTRUCTION_BASE`（第 36 行）

嵌入在主体模板中的分析指令。要求模型先在 `<analysis>` 标签内打草稿，`formatCompactSummary()` 在存储前会将其去除，只保留 `<summary>` 内容。

```
Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.
```

---

## 三、`BASE_COMPACT_PROMPT`（第 77 行）

全量压缩主体，用于 `/compact` 命令和自动压缩（`getCompactPrompt()`）。

```
Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages: 
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response. 

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
```

---

## 四、`PARTIAL_COMPACT_PROMPT`（第 162 行）

局部压缩主体，用于只压缩最近一段消息、保留头部历史的场景（`getPartialCompactPrompt('from')`）。

```
Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
```

---

## 五、`PARTIAL_COMPACT_UP_TO_PROMPT`（第 226 行）

插入式压缩主体，用于摘要插入会话中间、后续消息继续的场景（`getPartialCompactPrompt('up_to')`）。第 8、9 节与其他变体不同，改为 "Work Completed" 和 "Context for Continuing Work"。

```
Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents in detail
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks.
8. Work Completed: Describe what was accomplished by the end of this portion.
9. Context for Continuing Work: Summarize any context, decisions, or state that would be needed to understand and continue the work in subsequent messages.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Work Completed:
   [Description of what was accomplished]

9. Context for Continuing Work:
   [Key context, decisions, or state needed to continue the work]

</summary>
</example>

Please provide your summary following this structure, ensuring precision and thoroughness in your response.
```

---

## 六、`NO_TOOLS_TRAILER`（第 288 行）

附加在所有 prompt 末尾的尾部提醒，双重保障禁止工具调用：

```
REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.
```

---

## 七、三个变体的完整对比

| 维度 | 全量压缩（`BASE`） | 局部压缩（`PARTIAL from`） | 插入式压缩（`PARTIAL up_to`） |
|------|-------------------|--------------------------|------------------------------|
| **使用场景** | `/compact` 或自动压缩 | 只压缩最近消息，保留头部 | 摘要插入会话中间 |
| **分析指令** | `DETAILED_ANALYSIS_INSTRUCTION_BASE`（按时间顺序分析全部） | `DETAILED_ANALYSIS_INSTRUCTION_PARTIAL`（只分析最近消息） | `DETAILED_ANALYSIS_INSTRUCTION_BASE` |
| **第 8 节** | Current Work（当前正在做什么） | Current Work | Work Completed（完成了什么） |
| **第 9 节** | Optional Next Step（含原文引用） | Optional Next Step | Context for Continuing Work（续接上下文） |
| **调用函数** | `getCompactPrompt()` 第 312 行 | `getPartialCompactPrompt('from')` 第 293 行 | `getPartialCompactPrompt('up_to')` 第 293 行 |

---

## 八、压缩后注入给模型的消息（`getCompactUserSummaryMessage()`，第 361 行）

压缩完成后，摘要以此格式作为新会话的第一条用户消息注入：

```
This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
（formatCompactSummary() 处理后的摘要：去除 <analysis> 块，提取 <summary> 内容）

If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: <transcriptPath>

Recent messages are preserved verbatim.

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.
```

KAIROS 自主模式下额外追加：

```
You are running in autonomous/proactive mode. This is NOT a first wake-up — you were already working autonomously before compaction. Continue your work loop: pick up where you left off based on the summary above. Do not greet the user or ask what to work on.
```

---

## 九、`formatCompactSummary()` 后处理（第 332 行）

模型输出的原始摘要经过此函数处理后才存入上下文：

```typescript
// 1. 去除 <analysis>...</analysis> 块（scratchpad，仅用于提升摘要质量，无需保留）
formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')

// 2. 提取 <summary>...</summary> 内容，替换为 "Summary:\n<内容>"
formattedSummary.replace(/<summary>([\s\S]*?)<\/summary>/, `Summary:\n${content.trim()}`)

// 3. 清理多余空行
formattedSummary.replace(/\n\n+/g, '\n\n')
```

---

## 十、关键文件索引

| 符号 | 行号 | 说明 |
|------|------|------|
| `NO_TOOLS_PREAMBLE` | 23 | 前置工具禁用警告 |
| `DETAILED_ANALYSIS_INSTRUCTION_BASE` | 36 | 全量/插入式压缩分析指令 |
| `DETAILED_ANALYSIS_INSTRUCTION_PARTIAL` | 51 | 局部压缩分析指令 |
| `BASE_COMPACT_PROMPT` | 77 | 全量压缩主体（9 段结构） |
| `PARTIAL_COMPACT_PROMPT` | 162 | 局部压缩主体 |
| `PARTIAL_COMPACT_UP_TO_PROMPT` | 226 | 插入式压缩主体 |
| `NO_TOOLS_TRAILER` | 288 | 尾部工具禁用提醒 |
| `getPartialCompactPrompt()` | 293 | 局部/插入式压缩 prompt 构建 |
| `getCompactPrompt()` | 312 | 全量压缩 prompt 构建 |
| `formatCompactSummary()` | 332 | 去除 `<analysis>`，提取 `<summary>` |
| `getCompactUserSummaryMessage()` | 361 | 构建压缩后注入给模型的第一条消息 |
