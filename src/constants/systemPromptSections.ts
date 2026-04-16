import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from '../bootstrap/state.js'

type ComputeFn = () => string | null | Promise<string | null>

type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean // ! // false = 标准缓存，true = 每次重算
}

/**
 * Create a memoized system prompt section.
 * Computed once, cached until /clear or /compact.
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
  // 结果存入 systemPromptSectionCache（Map，在 bootstrap/state.ts 中维护）
  // 同一 name 命中缓存时直接返回，不重新执行 compute
}

/**
 * Create a volatile system prompt section that recomputes every turn.
 * This WILL break the prompt cache when the value changes.
 * Requires a reason explaining why cache-breaking is necessary.
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,  // ! // 必须提供原因，强制文档化为何绕过缓存
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
  // 每次 resolveSystemPromptSections() 都重新执行 compute
  // 用于 MCP 服务器连接/断开（mid-session 变化）
}

/**
 * Resolve all system prompt sections, returning prompt strings.
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      // L50: !s.cacheBreak && cache.has(s.name) → 直接返回缓存值
      // L53: 否则执行 compute()，写入缓存
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}

/**
 * Clear all system prompt section state. Called on /clear and /compact.
 * Also resets beta header latches so a fresh conversation gets fresh
 * evaluation of AFK/fast-mode/cache-editing headers.
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState() // ! // 清空 systemPromptSectionCache Map
  clearBetaHeaderLatches()  // ! // 重置 AFK/fast-mode/cache-editing header 状态
  // ! // 在 /clear 和 /compact 时调用
}
