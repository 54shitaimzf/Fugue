// 当前 View 的 immutable BlobId 相交；不缓存路径，不读物化/宿主文件树。
import type { BlobId, RelPath } from '../terms.ts'
import type { View } from '../view/contract.ts'

export type CandidateIndexLookup = (blob: BlobId, required: readonly string[]) => Promise<boolean | null>
export type CandidateView = Pick<View, 'base' | 'rev' | 'stat'>
export const MAX_INDEX_REQUIREMENTS = 128

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
    // 循环内每个挂起点之后都复查过代次，这里到上一次复查之间没有 await；再查一次
    // 只会留下一个变异审计永远杀不掉的分支。
    return kept
  } catch {
    return batch
  }
}
