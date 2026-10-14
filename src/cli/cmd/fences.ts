// 多写者那一族的**栅栏预取**：要 N 把就先拿全 N 把，再开第一个口。
// 出处：架构 § 9.11「**要 N 把栅栏的请求先拿全再开口**。中途撞上任何一把，已拿到的全部放掉，
// 请求以明确的 busy 结束——不领重复序号，不留半份日志」· § 9.2（一份日志一个写者进程）。
//
// 为什么这一份单独住一处：那三条要求（全拿 / 全放 / 拿手顺序）在**每一个多 writer 的入口**都
// 成立，而入口今天有四条（`round new` · `round run` · `round go` · `round work`）。分散着写就
// 会有一条只做到"用一个开一个"，而在盘的读数上分不开——两种都跑得通，只有撞上 busy 的那一趟
// 才看得出差别（那一趟会留下半份口）。
//
// **预取是 upsert，不是"先检查一遍"**：`holdWriter` 自己会现场判活锁、接管死锁（§ 9.2 的既有
// 判据），这里只做两件事——拿全，或者一把不剩地放掉。
import { holdWriter } from '../../log/hold.ts'
import { openLog } from '../../log/log.ts'
import type { Hold } from '../../log/hold.ts'
import type { Log } from '../../log/events.ts'
import type { LogHandle } from '../../log/log.ts'
import type { WriterId } from '../../terms.ts'

/**
 * 已拿全的那一份开口器。
 *
 * 两条判据合成一条：拿到这个对象就说明**N 把都在手上**（拿不全的构造会抛、且在抛之前全放掉）；
 * `open()` 只是从手里那一份里挑一个开（幂等——同一个 writer 要第二次拿到的是同一个口）。
 */
export interface FenceSet {
  /** N 把栅栏的 writer 名单（**拿全了**才有这个名字单）。 */
  readonly writers: readonly WriterId[]
  /** 开某一个 writer 的口。**它必须在这份名单里**——不在就说明拿手那一步漏了人。 */
  open(w: WriterId): Log
  /** 关掉开过的口，再放掉手上余下的栅栏。**可以调两次**。 */
  closeAll(): Promise<void>
}

/**
 * 拿手。**全成或者全不成**：
 *
 *   · 要到第 n 把时撞上 busy（`LogHeldError`）→ 把已经拿到的 n−1 把**按逆序**放掉，原错往上抛
 *     （错话由 `hold.ts` 给：谁持着、从什么时候起）。于是这一趟在盘上留不下那个 writer 的任何
 *     东西——`Hold.release` 连它自己顺手建的那两层空目录一起收（`log/hold.ts` 的 `madeLog`）。
 *   · `writers` 里有重复 → 当场拒。同一把栅栏拿两次是程序错误：第二次必然撞上自己（`holdWriter`
 *     对持者是本进程的同样拒），而报出来的会是"已经有写者"——那句错话会把人的注意力引向别人。
 */
export function acquireFences(
  root: string,
  writers: readonly WriterId[],
  opts: { readonly sync?: 'batch' | 'each'; readonly clock?: boolean } = {},
): FenceSet {
  const seen = new Set<WriterId>()
  for (const w of writers) {
    if (seen.has(w)) throw new Error(`同一把栅栏要了两次：${String(w)}（架构 § 9.2：一份日志一个写者）`)
    seen.add(w)
  }
  const holds = new Map<WriterId, Hold>()
  try {
    for (const w of writers) holds.set(w, holdWriter(root, w))
  } catch (err) {
    for (const h of [...holds.values()].reverse()) h.release()
    holds.clear()
    throw err
  }
  const list: readonly WriterId[] = [...writers]
  const logs = new Map<WriterId, LogHandle>()
  return {
    writers: list,
    open(w: WriterId): Log {
      const hit = logs.get(w)
      if (hit !== undefined) return hit
      const hold = holds.get(w)
      if (hold === undefined) {
        throw new Error(`开 ${String(w)} 的口，而拿手那一步没有拿它：${list.map(String).join(' · ')}`)
      }
      const made = openLog(root, { hold, sync: opts.sync ?? 'each', ...(opts.clock === undefined ? {} : { clock: opts.clock }) })
      logs.set(w, made)
      return made
    },
    async closeAll(): Promise<void> {
      // **口先关、栅栏后放**（架构 § 9.11「先关句柄、再放锁」）：反过来的话，那一小段时间里
      // 盘上的锁已经没了，而这一份句柄还开着——另一个写者会取到锁，两个写者同时往一份日志里写。
      for (const [w, l] of [...logs.entries()]) {
        logs.delete(w)
        await l.close()
      }
      for (const [w, h] of [...holds.entries()]) {
        holds.delete(w)
        h.release()
      }
    },
  }
}
