import { feature } from 'bun:bundle'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'

// ! RAG：相关记忆检索
export type RelevantMemory = {
  path: string  // ! 记忆文件绝对路径
  mtimeMs: number // ! 修改时间（供 attachment 展示新鲜度）
}

// Sonnet 排序器的 system prompt：
// - 只选择"确定有用"的记忆（保守策略，宁缺毋滥）
// - 如果最近使用了某工具，不选该工具的参考文档（已在使用中，无需重复注入）
// - 但仍选择该工具的"警告/已知问题"类记忆（恰恰是使用时最需要的）
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude Code as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to Claude Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (Claude Code is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

/**
 * Find memory files relevant to a query by scanning memory file headers
 * and asking Sonnet to select the most relevant ones.
 *
 * Returns absolute file paths + mtime of the most relevant memories
 * (up to 5). Excludes MEMORY.md (already loaded in system prompt).
 * mtime is threaded through so callers can surface freshness to the
 * main model without a second stat.
 *
 * `alreadySurfaced` filters paths shown in prior turns before the
 * Sonnet call, so the selector spends its 5-slot budget on fresh
 * candidates instead of re-picking files the caller will discard.
 */
export async function findRelevantMemories(
  query: string,  // ! // 当前用户输入文本
  memoryDir: string,  // ! // 记忆目录路径
  signal: AbortSignal,
  recentTools: readonly string[] = [],  // ! // 最近使用的工具名（避免重复注入工具文档）
  alreadySurfaced: ReadonlySet<string> = new Set(), // ! // 本轮已展示的路径（去重）
): Promise<RelevantMemory[]> {
  // L46: scanMemoryFiles(memoryDir) — 扫描目录，读取所有文件 frontmatter
  // L47: .filter(m => !alreadySurfaced.has(m.filePath)) — 排除已展示
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) {
    return []
  }

  // ! 调用 Sonnet 排序，最多返回 5 个文件名
  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    signal,
    recentTools,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  // ! 用文件名查找完整 MemoryHeader，提取 path + mtimeMs
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // Fires even on empty selection: selection-rate needs the denominator,
  // and -1 ages distinguish "ran, picked nothing" from "never ran".
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)  // ! 记录召回模式
  }

  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename)) // ! 防止幻觉

  const manifest = formatMemoryManifest(memories) // ! 生成文件名+描述的文本清单

  // When Claude Code is actively using a tool (e.g. mcp__X__spawn),
  // surfacing that tool's reference docs is noise — the conversation
  // already contains working usage.  The selector otherwise matches
  // on keyword overlap ("spawn" in query + "spawn" in a memory
  // description → false positive).
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  try {
    //      JSON schema output：{ type: 'array', items: { type: 'string' } }
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,  // ! 独立 Sonnet API 调用，不影响主对话上下文
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance',
    })

    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    // ! L返回: 过滤后的文件名数组（只保留 validFilenames 中存在的）
    return parsed.selected_memories.filter(f => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectRelevantMemories failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}
