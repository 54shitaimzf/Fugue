// ROADMAP § 3 / 0.2.5 · 清单按视图代缓存；只缓存派生结果，不另建真源。
import type { View } from '../view/contract.ts'
import type { CommitId, RelPath, ViewRev } from '../terms.ts'

type WalkView = Pick<View, 'base' | 'rev' | 'list'>

interface WalkLimits {
  readonly maxDepth: number
  readonly maxRows: number
}

interface CachedWalk {
  readonly base: CommitId | null
  readonly rev: ViewRev
  readonly paths: Promise<readonly string[]>
}

/** 与旧走法同一顺序、同一截尾；软链和 gitlink 不跟随。 */
async function collectPaths(view: WalkView, limits: WalkLimits): Promise<readonly string[]> {
  const paths: string[] = []
  const step = async (dir: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || paths.length >= limits.maxRows) return
    for (const row of await view.list(dir as RelPath)) {
      if (paths.length >= limits.maxRows) return
      const path = dir === '' ? row.name : `${dir}/${row.name}`
      if (row.kind === 'dir') await step(path, depth + 1)
      else if (row.kind === 'file') paths.push(path)
    }
  }
  await step('', 0)
  return paths
}

/**
 * 一份宿主只保留当前视图代的一份有界清单。并发读复用同一次遍历；失败不缓存。
 * 调用者拿独立数组，不能改坏下一次 grep/glob 的候选。遍历期间视图有变更时，
 * 本次结果沿用旧走法的语义，但不留作后来调用的缓存；这里不声称提供原子快照。
 */
export function createCachedWalk(view: WalkView, limits: WalkLimits): () => Promise<readonly string[]> {
  let cached: CachedWalk | undefined
  return async () => {
    if (cached === undefined || cached.base !== view.base || cached.rev !== view.rev) {
      const generation: CachedWalk = { base: view.base, rev: view.rev, paths: collectPaths(view, limits) }
      cached = generation
      // 只清自己的那一代：旧请求晚回来不能抹掉已经起跑的新一代。
      generation.paths.then(
        () => {
          if (cached === generation && (view.base !== generation.base || view.rev !== generation.rev)) {
            cached = undefined
          }
        },
        () => { if (cached === generation) cached = undefined },
      )
    }
    return [...await cached.paths]
  }
}
