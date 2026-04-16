/**
 * Memory-directory scanning primitives. Split out of findRelevantMemories.ts
 * so extractMemories can import the scan without pulling in sideQuery and
 * the API-client chain (which closed a cycle through memdir.ts — #25372).
 */

import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

// ! 记忆目录扫描
export type MemoryHeader = {
  filename: string  // ! 相对路径（如 user_role.md）
  filePath: string  // ! 绝对路径
  mtimeMs: number   // ! 修改时间（用于排序和新鲜度判断）
  description: string | null  // ! // frontmatter.description（RAG 检索依赖此字段）
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200  // ! 最多扫描 200 个文件
const FRONTMATTER_MAX_LINES = 30  // ! 每个文件只读前 30 行（仅需 frontmatter）

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at MAX_MEMORY_FILES). Shared by
 * findRelevantMemories (query-time recall) and extractMemories (pre-injects
 * the listing so the extraction agent doesn't spend a turn on `ls`).
 *
 * Single-pass: readFileInRange stats internally and returns mtimeMs, so we
 * read-then-sort rather than stat-sort-read. For the common case (N ≤ 200)
 * this halves syscalls vs a separate stat round; for large N we read a few
 * extra small files but still avoid the double-stat on the surviving 200.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true }) // ! 递归扫描
    const mdFiles = entries.filter( // ! 过滤 .md 文件，排除 MEMORY.md 本身
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled( // ! 并行读取所有文件的 frontmatter
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFileInRange( // ! 只读前 30 行
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)  // ! 按 mtimeMs 倒序排列（最新优先）
      .slice(0, MAX_MEMORY_FILES) // ! 最多 200 个
  } catch {
    return []
  }
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filename (timestamp): description. Used by both the recall
 * selector prompt and the extraction-agent prompt.
 */
// ! 格式：- [type] filename (ISO时间戳): description
// ! 供 Sonnet 排序器使用
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
