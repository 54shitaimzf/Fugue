// M14 的第四支：**顺着 NDJSON 账跟随读**。出处：架构 § 9.6 那张观察表（`watch --follow` 那一行）·
// PLAN § 5.18（W11 的两个新单元）· 架构 § 9.2（全序由 `(seq, writer)` 隐含确定）·
// § 9.4（重建代价的上界）· § 8.1（三个方法，一个都不新增）。
//
// **它是一条纯读路径，而且不新增任何事件。** 跟随不是"盯着文件系统"（没有 inotify，也没有守护
// 进程——落地期间不引入），而是**再看一眼**：每一趟把日志读一遍，按每个 writer 的游标筛掉看过的。
//
// **游标是每个 writer 一个，不是全局一个 `fromSeq`。** 这一条是这一份里唯一"会错"的地方，所以
// 单独写清楚：`readMerged(fromSeq)` 的 `fromSeq` 是"每条 writer 各自的 `seq > fromSeq`"，
// 而 `(seq, writer)` 的合并序**先比 seq**——一个**晚出现的 writer**（比如第二个 agent 的日志口
// 在第一步之后才开）第一条就是 `seq = 1`，于是"从 `seq = N` 接着读"会把它**整段永久漏掉**。
// 跟随的每一趟都从**零**读（`readMerged(0)`），筛的是"这个 writer 我读到哪了"。
//
// **代价如实记在这里**：每一趟读全量。一个轮次的日志以百条计，看一眼的代价可以忽略；日志长到
// 百万条的那一天，这里要换成按 writer 的尾部窗口（`log.ts` 的 `tailSeq` 已经示范了那个做法）。
// **不猜序号**：`readByWriter` 只给事件、不给位置，所以"`high + 1`、`high + 2` 数下去"那种写法
// 在日志尾部留过半行的时候会与真实序号错位——位置只有 `readMerged` 给得出。
import type { Log } from '../log/events.ts'
import type { StatusRow } from './status.ts'

/** 每个 writer 各自读到哪了。**只增不减**。 */
export type Cursors = Readonly<Record<string, number>>

/** 跟随要的那几样。**一样句柄都不持有**（`log` 是调用方的）——这一份不开账本、不持锁。 */
export interface FollowOptions {
  /** 轮询间隔（毫秒）。不给是 200——人眼的分辨率，而不是它的精度。 */
  readonly intervalMs?: number
  /** 从哪儿接着读。不给就是从零起（"把账上有的先念一遍"）。 */
  readonly from?: Cursors
  /** 停下来的信号（`Ctrl-C` 那一档把它拨一下）。 */
  readonly signal?: AbortSignal
}

/** 一趟的产出：这一趟新读到的那些行，加**读过之后**的游标。 */
export interface Pass {
  readonly rows: readonly StatusRow[]
  readonly cursors: Cursors
}

/**
 * 读一趟。**它是这一份的全部逻辑，`follow` 只是把它连起来。**
 *
 * 位置（`pos`）原样带出去：跟随的人要看到 `(writer, seq)`，不然"这一条是第几步"就没法对账。
 */
export async function readNew(log: Pick<Log, 'readMerged'>, cursors: Cursors = {}): Promise<Pass> {
  const rows: StatusRow[] = []
  const next: Record<string, number> = { ...cursors }
  for await (const { pos, e } of log.readMerged(0)) {
    if (pos.seq <= (cursors[pos.writer] ?? 0)) continue
    rows.push({ pos, e })
    // 取**最大**而不是"最后见到的那一个"：游标按构造只增不减，这样"漏一条"这件事在状态上
    // 就不可能发生——即使某一个 writer 的行序反了（今天不会），游标也不会退回去重读。
    if (pos.seq > (next[pos.writer] ?? 0)) next[pos.writer] = pos.seq
  }
  return { rows, cursors: next }
}

/**
 * 睡一会儿，但**信号一到就当场醒**。
 *
 * 两个细节都是有意的：**定时器不 `unref()`**——一个等待中的跟随者要能吊住进程（`unref` 之后
 * "在等新事件"这件事不算活着，进程会当场退出，而它本该一直等到有人喊停）；**监听器要摘掉**——
 * 跟随一整趟会睡很多次，同一个信号上挂着几十个监听器会先把 Node 的告警招来。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    let settled = false
    let t: ReturnType<typeof setTimeout>
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal?.removeEventListener('abort', finish)
      done()
    }
    t = setTimeout(finish, ms)
    if (signal !== undefined) {
      if (signal.aborted) finish()
      else signal.addEventListener('abort', finish)
    }
  })
}

/**
 * 跟着读：**一趟一趟地看**，每一趟把**新到的那些行作为一批**吐出去（一趟一批，U4）。
 *
 * 次序那一句要说明白：**它是"到达序"，不是 `(seq, writer)` 的全序。** 全序那一份读法是
 * `fugue log`（一次读齐、按 `(seq, writer)` 排）；跟随是"现在有什么就说什么"，晚出现的那个
 * writer 的 `seq = 1` 一定排在已经念过的 `seq = 5` 之后——**这不是乱序，是实时**。
 * 一趟之内的行按 `readMerged` 排好（所以同一趟里的次序仍然是全序），趟与趟之间是到达序。
 *
 * **空趟不吐**：一趟什么新行都没有，就没有东西可说——那一趟只睡 `interval` 再看一眼。
 * 有新行的趟立即再看下一趟（与从前逐条那一档同一条节奏）。为什么按批：摆的那一头
 * （`ui/follow.ts`）一趟只画一帧——同趟到的几条对屏幕来说是同一瞬间，逐条画几十遍
 * 而字节一个不差，是白烧（`UI2` 实测一次启动 31 次重画 · 394 次清行）。
 */
export async function* follow(
  log: Pick<Log, 'readMerged'>,
  opts: FollowOptions = {},
): AsyncGenerator<readonly StatusRow[], void, unknown> {
  const interval = opts.intervalMs ?? 200
  let cursors: Cursors = opts.from ?? {}
  for (;;) {
    if (opts.signal?.aborted === true) return
    const p = await readNew(log, cursors)
    cursors = p.cursors
    if (p.rows.length > 0) yield p.rows
    if (p.rows.length > 0) continue
    await sleep(interval, opts.signal)
  }
}
