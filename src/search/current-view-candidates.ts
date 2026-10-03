// 当前 View 的 immutable BlobId 相交；不缓存路径，不读物化/宿主文件树。
import type { BlobId, RelPath } from '../terms.ts'
import type { View } from '../view/contract.ts'
import { MAX_REQUIRED_TRIGRAMS } from './regex-literal.ts'

export type CandidateIndexLookup = (blob: BlobId, required: readonly string[]) => Promise<boolean | null>
export type CandidateView = Pick<View, 'base' | 'rev' | 'stat'>
/** 必需条件最多多少个：就是正则前置**产出**的上限，同一个数，不是另拍一个——两边各写 128 会各自漂。 */
export const MAX_INDEX_REQUIREMENTS = MAX_REQUIRED_TRIGRAMS
export const MAX_INDEX_PROBES = 4

function blobId(value: unknown): value is BlobId {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

/**
 * 只剔除有效当前文件的严格 false；未知/错误保持在扫描路径。任何变代撤销本批之前的
 * 负判断。这不提供整个枚举/查询的原子快照，也不会发现原枚举之外新加的路径。
 *
 * **候选条数不设上限**：每条候选各一次 `View.stat` + 一次索引问询，顺序执行，代价与原
 * 扫描路径同阶，所以没有需要用计数封顶的东西。曾经有过一道「超过 128 条原样返回」的闸，
 * 那是个陷阱：候选的自然来源 `ToolHost.walk()` 上限是 5000 条，调用方整批传进来时这个
 * 适配器 100% 空转，而且不留任何「我没帮你过滤」的信号——接线后看着像启用了，实际一次
 * 索引都没走。真正要封顶的是必需条件数（`MAX_INDEX_REQUIREMENTS`），它决定每次问询的入参。
 */
export async function filterCurrentViewCandidates(
  view: CandidateView, paths: readonly string[], required: readonly string[], lookup: CandidateIndexLookup,
): Promise<readonly string[]> {
  const batch = [...paths]
  try {
    if (required.length === 0 || required.length > MAX_INDEX_REQUIREMENTS) return batch
    // 按索引生成有界的稠密快照：Array.prototype.every 会跳过稀疏数组的空槽，稠密化之后
    // 空槽变成 undefined，才判得出来。
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
