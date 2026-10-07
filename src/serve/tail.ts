// serve 的**按根的尾部索引**（施工单 § 五 ③）。出处：架构 § 9.11「**服务端可以记住派生
// 物**」那一段——「一份按 writer 的尾部索引（追加即推进，重建只花时间）。它们的共同性质是**可弃**
// ——重启 · 换一个进程 · 删掉重算，读出来的东西逐字节不变。游标与附着者集合住在客户端那一侧，
// 每一端带着自己的游标来问；账上照旧只记发生过的事」。
//
// 这一份就是那句话的形状：**一个根一份**（`serve 按根一个`——多工作区就是多个进程，协议里不加
// root 维度），进程内住着，跨调用记得住两样东西：
//
//   · **一份按 writer 的尾部索引**：`walked` 是「这一趟走到哪了」——每个 writer 见到过的最大
//     `seq`。追加即推进（下一趟只认超过它的那些），只增不减；
//   · **读过的那些行**（`rows`，按 `(seq, writer)` 的合并序）。
//
// **那不是游标**（§ 9.11 说得明白：游标住在客户端）。这一份的索引说的永远是「走到哪了」，
// 客户端每一次把它自己那一份 `Cursors` **带进来**，`pass()` 按它筛一遍再交出去——服务端不替
// 任何一端记「你读到哪了」，也不催任何一端跟上。
//
// **一趟、一次扫描、N 个客户端共用**：`advance()` 把并发的调用合并到**同一次在飞的扫描**上
// （`inflight`），所以 N 条调用不会走 N 遍全量。这是这一份存在的全部理由——`watch` 原先每一条
// 调用都把 `readMerged(0)` 从头走一遍（`probe/watch.ts` 头上那句「每一趟读全量」如实写的代价）。
//
// **可弃**：`dispose()` 关掉那只长效句柄、扔掉索引与行——与「换一个进程重来」是同一件事。
// 重建之后，同一个游标问出来的字节与丢之前逐字节相同（`tail.test.ts` ② 量这一条）。
//
// **它不写任何东西**：只读句柄（`openLog` 不带 `write`，不取栅栏——§ 9.7 观察不加锁），不落盘，
// 不进事件联合，不参与 `(seq, writer)` 之外的任何排序。
import { openLog } from '../log/log.ts'
import type { Log } from '../log/events.ts'
import type { LogPos } from '../terms.ts'
import type { StatusRow } from '../probe/status.ts'
import type { Cursors } from '../probe/watch.ts'

/** 读那一趟的形状。**默认就是账本本身**；断言用注入的那一份数扫描次数（不做时长断言）。 */
export type TailReader = Pick<Log, 'readMerged'>

export interface TailOptions {
  /** 换一条读源（断言用：数「走了几遍全量」）。**产品路径上永远不给**。 */
  readonly reader?: TailReader
  /**
   * 把**客户端那一层的筛**拆掉（断言用：② 的负对照要的就是这个现场——筛一旦不在，"增量那条
   * 路"当场变成"全部行"）。**产品路径上永远不给**。
   */
  readonly filterOff?: boolean
}

/**
 * 一个根的尾部索引。
 *
 * 四个口：`advance()`（把账往前推一趟）· `pass(from)`（按某一端的游标答一趟）· `cursors()`
 * （这一刻走到哪了）· `dispose()`（弃掉）。**一个口都不写**。
 */
export interface RootTail {
  /** 推一趟：走一遍全量、只收索引之外的那些行。返回**这一趟**真的走了几遍（合并之后是 1）。 */
  advance(): Promise<number>
  /** 按 `from` 那些游标（每个 writer 一个 · 排他下界）答一趟：先推一趟，再从读过的行里筛。 */
  pass(from: Cursors): Promise<readonly StatusRow[]>
  /** 这一刻的尾部索引（每个 writer 见到过的最大 `seq`）。**只增不减**。 */
  cursors(): Cursors
  /** 弃掉：关句柄、扔掉索引与行。**可弃**——重建之后同一个游标读出来的东西逐字节相同。 */
  dispose(): Promise<void>
}

export function createRootTail(root: string, opts: TailOptions = {}): RootTail {
  const reader: TailReader = opts.reader ?? openLog(root)
  /** 每个 writer 见到过的最大 `seq`（**这一趟走到哪了**）。 */
  const walked = new Map<string, number>()
  /** 读过的那些行，按合并序（`readMerged` 给的次序）。 */
  const rows: StatusRow[] = []
  /** 在飞的那一趟。**并发的调用合并到它上面**——N 个客户端共用那块牌。 */
  let inflight: Promise<number> | null = null

  async function scan(): Promise<number> {
    let passes = 0
    passes++
    for await (const { pos, e } of reader.readMerged(0)) {
      // 索引之外的那些才收：**追加即推进**。晚出现的 writer 第一条就是 `seq = 1`，而它的索引
      // 起点是 0——所以"从零读、按 writer 筛"这条写法不会把它整段漏掉（裸 `seq` 会）。
      if (pos.seq <= (walked.get(pos.writer) ?? 0)) continue
      const row: StatusRow = { pos, e }
      rows.push(row)
      walked.set(pos.writer, pos.seq)
    }
    return passes
  }

  function advance(): Promise<number> {
    if (inflight !== null) return inflight
    const p = scan().finally(() => {
      if (inflight === p) inflight = null
    })
    inflight = p
    return p
  }

  return {
    advance,
    async pass(from: Cursors): Promise<readonly StatusRow[]> {
      // **先推一趟再答**：这一趟的账要读进来（并发的那些合并在这一次上）。
      await advance()
      // **按客户端那一份游标筛**（排他下界）：服务端不记任何一端的进度——它只是"把账上有的
      // 按你说的下界交出去"。筛在这一层，所以缓存里永远是全量的那些行。
      if (opts.filterOff === true) return [...rows]
      const out: StatusRow[] = []
      for (const r of rows) {
        if (r.pos.seq > (from[r.pos.writer] ?? 0)) out.push(r)
      }
      return out
    },
    cursors(): Cursors {
      return Object.fromEntries(walked)
    },
    async dispose(): Promise<void> {
      const h = reader as { close?: () => Promise<void> }
      await h.close?.()
      // **索引 · 读过的行 · 在飞那一趟一起扔掉**：弃掉之后这个对象不该再被用（要接着读就现建
      // 一个，读出来的东西逐字节相同——`tail.test.ts` ② 量的是那一条）。
      walked.clear()
      rows.length = 0
      inflight = null
    },
  }
}

/** 尾部索引那一份读数（诊断用：每个 writer 走到哪了 · 一共几个 writer）。 */
export function tailStateOf(tail: RootTail): { cursors: Cursors; writers: number } {
  const c = tail.cursors()
  return { cursors: c, writers: Object.keys(c).length }
}

/** 一行在答案里的坐标（断言用：`writer:seq`）。 */
export function posKey(pos: LogPos): string {
  return `${pos.writer}:${pos.seq}`
}
