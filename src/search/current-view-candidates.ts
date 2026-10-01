// 当前 View 的 immutable BlobId 相交；不缓存路径，不读物化/宿主文件树。
import type { BlobId, RelPath } from '../terms.ts'
import type { View } from '../view/contract.ts'

export type CandidateIndexLookup = (blob: BlobId, required: readonly string[]) => Promise<boolean | null>
export type CandidateView = Pick<View, 'base' | 'rev' | 'stat'>
export const MAX_INDEX_CANDIDATE_BATCH = 128
export const MAX_INDEX_REQUIREMENTS = 128

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
    const kept: string[] = []
    for (const path of batch) {
      let excluded = false
      try {
        const meta = await view.stat(path as RelPath)
        if (meta?.kind === 'file' && blobId(meta.id)) excluded = await lookup(meta.id, grams) === false
      } catch {
        // 辅助层不能掩盖真实读取错误；保留候选，由原 readBytes 路径给出结果或错误。
      }
      if (view.base !== base || view.rev !== rev) return batch
      if (!excluded) kept.push(path)
    }
    return view.base === base && view.rev === rev ? kept : batch
  } catch {
    return batch
  }
}
