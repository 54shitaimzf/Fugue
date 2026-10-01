// 当前 View 的 immutable BlobId 相交；不缓存路径，不读物化/宿主文件树。
import type { BlobId, RelPath } from '../terms.ts'
import type { View } from '../view/contract.ts'

export type CandidateIndexLookup = (blob: BlobId, required: readonly string[]) => Promise<boolean | null>
export type CandidateView = Pick<View, 'base' | 'rev' | 'stat'>
export const MAX_INDEX_CANDIDATE_BATCH = 128
export const MAX_INDEX_REQUIREMENTS = 128
export const MAX_INDEX_PROBES = 4

function blobId(value: unknown): value is BlobId {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

/**
 * 只剔除有效当前文件的严格 false；未知/错误保持在扫描路径。任何变代撤销本批之前的
 * 负判断。这不提供整个枚举/查询的原子快照，也不会发现原枚举之外新加的路径。
 */
export async function filterCurrentViewCandidates(
  view: CandidateView, paths: readonly string[], required: readonly string[], lookup: CandidateIndexLookup,
): Promise<readonly string[]> {
  const batch = [...paths]
  try {
    if (batch.length > MAX_INDEX_CANDIDATE_BATCH || required.length === 0 || required.length > MAX_INDEX_REQUIREMENTS) return batch
    // 按索引生成有界的稠密快照；Array.some 不会访问稀疏原数组的空槽。
    const values = Array.from({ length: required.length }, (_, at) => required[at])
    if (!values.every((gram): gram is string => typeof gram === 'string' && gram.length === 3)) return batch
    const grams = Object.freeze(values)
    const base = view.base
    const rev = view.rev
    const excluded = new Set<number>()
    let next = 0
    let stale = false
    const changed = (): boolean => {
      try { return view.base !== base || view.rev !== rev }
      catch { return true }
    }
    const lane = async (): Promise<void> => {
      while (!stale) {
        if (stale || changed()) { stale = true; return }
        const at = next++
        if (at >= batch.length) return
        let omit = false
        try {
          const meta = await view.stat(batch[at] as RelPath)
          if (stale || changed()) { stale = true; return }
          if (meta?.kind === 'file' && blobId(meta.id)) omit = await lookup(meta.id, grams) === false
        } catch {
          // 保留候选；原 readBytes 路径仍负责真实读取错误。
        }
        if (stale || changed()) { stale = true; return }
        if (omit) excluded.add(at)
      }
    }
    // 只并发本批的派生只读探测，不并发工具调用/写事件。已发出的异步口全部观察到收尾。
    await Promise.all(Array.from({ length: Math.min(MAX_INDEX_PROBES, batch.length) }, lane))
    return stale || changed() ? batch : batch.filter((_, at) => !excluded.has(at))
  } catch {
    return batch
  }
}
