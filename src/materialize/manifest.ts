// 物化清单：从 `M0` 里该 agent 的 `mat/*` 事件重放出来。出处：架构 § 8.5（"`manifest` 是派生
// 数据，不持久化"）· § 8.1（三个 `mat/*` 事件）· § 9.4（重放的手法）。
//
// **清单记的是"相对 base 变了的路径"，不是"铺过哪些路径"**（§ 8.1 的原话）。这句话落在三处：
//
//   一 · `mat/fork` 铺的是整个 base，而它的 `paths` 恒为空——底就是真实工作树，`fork` 什么都
//        没"铺"过（§ 8.5）。
//   二 · `mat/sync` 的 `paths` 是**这次 sync 之后清单的全貌**，不是"这次落了哪几条"。差别只在
//        一种情形上现形：一条路径改了又改回去。按"落了哪几条"记的话，它留在旧事件里，而它
//        此刻与底逐字节相同——§ 8.5 的第二条验证性质（"重放得到的清单与差异集相等"）就不成
//        立了。全貌记法让重放退化成"取最后一条 `mat/sync`"。
//   三 · 一次重来（`dispose` + `fork`）把清单清空：读到新的 `mat/fork` 就从头起。
//
// 代价：事件大小与清单规模成正比——一个长期活着的 agent，每条 `mat/sync` 都要重抄一遍清单。
// 改成增量式得让事件带得下"这条从清单里出去了"，那是 § 8.1 的改动（改规格由人批）。
import type { LogReader } from '../log/events.ts'
import type { AgentId, CommitId, ForkStrategy, RelPath, ViewRev } from '../terms.ts'

/** 该 agent 的物化到此刻这一步：`mat/*` 事件折出来的全部。 */
export interface MatState {
  /** 铺过没有。没有的话 delta 没有地方落——`ensure` 据此拒绝并指路。 */
  readonly forked: boolean
  readonly base: CommitId | null
  readonly strategy: ForkStrategy | null
  /** 已经落到的修订点：`mat/fork` 之后是 0（底就是 base），每个 `mat/sync` 推到它的 `to`。 */
  readonly rev: ViewRev
  /** 清单：相对 base 变了的路径，按路径排序。 */
  readonly paths: readonly RelPath[]
  /** 与 `paths` 一一对应的内容哈希。**`''` 表示这条路径在视图里没有了**（`upper` 里是一条
   *  whiteout）——内容哈希是 64 位十六进制，空串与它不会撞。 */
  readonly hashes: readonly string[]
}

export const NOT_FORKED: MatState = {
  forked: false,
  base: null,
  strategy: null,
  rev: 0,
  paths: [],
  hashes: [],
}

/** 清单 → `mat/*` 事件要的那两个数组。**按路径排序**：同一份清单重放两次要给同一串字节。 */
export function manifestPayload(entries: ReadonlyMap<RelPath, string>): {
  paths: RelPath[]
  hashes: string[]
} {
  const paths = [...entries.keys()].sort()
  return { paths, hashes: paths.map((p) => entries.get(p) ?? '') }
}

/** 清单的两个数组 → 一张表（`land.ts` 要的是"这条路之前是什么"，不是两个平行数组）。 */
export function manifestMap(st: MatState): Map<RelPath, string> {
  const m = new Map<RelPath, string>()
  st.paths.forEach((p, i) => m.set(p, st.hashes[i] ?? ''))
  return m
}

/**
 * 重放 `mat/*`。**只有读侧**（`LogReader`）：物化读日志，物化不写日志——事件由 `ensure` 在
 * 落完之后追加（§ 8.1 的写者只有那几处）。
 *
 * 读到一个没有 `mat/fork` 在前面的 `mat/sync` 就忽略它：写路径保证不会出现这种日志（`ensure`
 * 先要求 fork 过），而派生数据的读侧宁可少信一条，不该让整次重放炸掉。
 */
export async function matState(log: LogReader, agent: AgentId): Promise<MatState> {
  let st = NOT_FORKED
  for await (const e of log.readByWriter(agent)) {
    if (e.t === 'mat/fork') {
      st = { forked: true, base: e.base, strategy: e.strategy, rev: 0, paths: [], hashes: [] }
      continue
    }
    if (e.t === 'mat/sync' && st.forked) {
      st = { ...st, rev: e.to, paths: [...e.paths], hashes: [...e.hashes] }
    }
  }
  return st
}
