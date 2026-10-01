// ROADMAP § 3 / 0.2.5 · 清单按视图代缓存；只缓存派生结果，不另建真源。
import type { View } from '../view/contract.ts'
import type { CommitId, RelPath, ViewRev } from '../terms.ts'

type WalkView = Pick<View, 'base' | 'rev' | 'list'>

interface WalkLimits {
  readonly maxDepth: number
  readonly maxRows: number
}

export interface WalkResult {
  readonly paths: readonly string[]
  /** Enumeration stopped before examining a file or subtree; omitted file count is unknown. */
  readonly truncated: boolean
  readonly limits: readonly ('rows' | 'depth')[]
}

interface CachedWalk {
  readonly base: CommitId | null
  readonly rev: ViewRev
  readonly result: Promise<WalkResult>
}

/** 与旧走法同一候选前缀；只为未遍历的文件/子树补上限制原因。 */
async function collectPaths(view: WalkView, limits: WalkLimits): Promise<WalkResult> {
  const paths: string[] = []
  const stopped = new Set<'rows' | 'depth'>()
  const step = async (dir: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) { stopped.add('depth'); return }
    if (paths.length >= limits.maxRows) { stopped.add('rows'); return }
    for (const row of await view.list(dir as RelPath)) {
      // 软链/gitlink 没有候选，不把一个只有这些条目的尾部报成缺了文件。
      if (row.kind !== 'file' && row.kind !== 'dir') continue
      if (paths.length >= limits.maxRows) { stopped.add('rows'); return }
      const path = dir === '' ? row.name : `${dir}/${row.name}`
      if (row.kind === 'dir') await step(path, depth + 1)
      else paths.push(path)
    }
  }
  await step('', 0)
  const reasons = (['rows', 'depth'] as const).filter((reason) => stopped.has(reason))
  return { paths, truncated: reasons.length > 0, limits: reasons }
}

/**
 * 一份宿主只保留当前视图代的一份有界清单。并发读复用同一次遍历；失败不缓存。
 * 调用者拿独立数组，不能改坏下一次 grep/glob 的候选。遍历期间视图有变更时，
 * 本次结果沿用旧走法的语义，但不留作后来调用的缓存；这里不声称提供原子快照。
 */
export function createCachedWalkDetailed(view: WalkView, limits: WalkLimits): () => Promise<WalkResult> {
  let cached: CachedWalk | undefined
  return async () => {
    if (cached === undefined || cached.base !== view.base || cached.rev !== view.rev) {
      const generation: CachedWalk = { base: view.base, rev: view.rev, result: collectPaths(view, limits) }
      cached = generation
      // 只清自己的那一代：旧请求晚回来不能抹掉已经起跑的新一代。
      generation.result.then(
        () => {
          if (cached === generation && (view.base !== generation.base || view.rev !== generation.rev)) {
            cached = undefined
          }
        },
        () => { if (cached === generation) cached = undefined },
      )
    }
    const result = await cached.result
    return { paths: [...result.paths], truncated: result.truncated, limits: [...result.limits] }
  }
}
