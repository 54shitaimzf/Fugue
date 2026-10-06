// 系统里唯一一处"现在几点"。出处：架构 § 9.2 的信封表（`ts` · `boot` · `inc`）。
//
// **三栏是一件事，不是三件。** `ts` 单独回拨时，账上没有任何东西能说明刚才发生了什么；
// `(boot, inc)` 一起记，回拨就是**读得出来的事实**（`inc` 不回头而 `ts` 回头），而无需让钟参与
// 排序——全序仍是 `(seq, writer)`。所以这一份**要么给全三栏，要么一栏不给**，没有"给一半"那一档。
//
// **读不出启动标识就没有钟**（宿主没有 `/proc`）：`inc` 跨启动不可比，而"这一条属于哪一次启动"
// 答不出来时，三栏里没有一栏还站得住。**不造值**——缺栏是「未量到」，不是 0，也不是空串（与
// `llm/call` 那一栏 `ms` 同一条口径，见 `events.ts`）。消费者那一侧的判据因此只有一条：
// **栏不在就是没量到**。
//
// **信封与锁读的是同一处**（`log/envelope.ts` 与 `log/hold.ts`）：系统里只有一份"现在几点"。
// 两处各读一次的话它们迟早会漂，而漂了不报错。
import { readFileSync } from 'node:fs'

/** 信封里的那三栏。**只在给钟时出现**（架构 § 9.2 的信封表）。 */
export interface Clock {
  /** 墙钟时刻，epoch 毫秒整数。 */
  readonly ts: number
  /** 机器这一次启动的标识。**`boot` 不同的两条 `inc` 不可比**。 */
  readonly boot: string
  /** 同一启动内的单调计数，微秒。跨进程可比，跨启动由 `boot` 隔开。 */
  readonly inc: number
}

/**
 * 机器这一次启动的 id。读不到给 `null`（宿主没有 `/proc`）。
 *
 * **一个进程里读一次就够**：启动标识在两次重启之间不会变，而进程活不过一次重启。这一处是取钟
 * 路径上唯一一次 I/O——缓存把"每条事件多读一次文件"收成一次。
 */
let cached: string | null | undefined
export function bootId(): string | null {
  if (cached === undefined) {
    let text: string | null
    try {
      text = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    } catch {
      text = null
    }
    cached = text === '' ? null : text
  }
  return cached
}

/**
 * 现在几点。**读不出启动标识就给 `null`**——那一档一栏都不写，不写 0、不写空串。
 *
 * `boot` 那一个参数是**缝**，不是门：缺省那一条（不给）读本机 `/proc`，给了就用给的那个值。
 * 它今天有两个用处——断言里驱动"读不出启动标识"那一档，以及将来换宿主时换一个启动标识的读法
 * （纯血 Windows 上没有 `/proc`）。**它不改变任何行为**，只是把"启动标识从哪来"这件事放在一处。
 */
export function clockOf(boot: string | null = bootId()): Clock | null {
  if (boot === null) return null
  return { ts: Date.now(), boot, inc: Number(process.hrtime.bigint() / 1000n) }
}

/** 一条读得到的回拨。 */
export interface Rollback {
  readonly writer: string
  /** 前一条：`ts` 更大、`inc` 更小的那一条。 */
  readonly before: { readonly seq: number; readonly ts: number; readonly inc: number }
  /** 后一条：`ts` 回头的那一条。 */
  readonly after: { readonly seq: number; readonly ts: number; readonly inc: number }
}

/**
 * 同一 writer 里相邻两条**`inc` 递增而 `ts` 递减**——那是钟被回拨过，读得出来。
 *
 * **只在同一 writer 内比**：跨 writer 的相邻没有意义——两个 writer 的 `inc` 只有在同一个 `boot`
 * 下才可比，而它们之间还隔着别人的行。**不给钟的行跳过**（缺栏是「未量到」）。
 *
 * 它报的是**事实，不是错误**：回拨是环境里发生的事（对时 · 时区脚本 · 虚拟机挂起），账没有错。
 */
export function rollbacksOf(
  rows: readonly {
    readonly pos: { readonly writer: string; readonly seq: number }
    readonly clock: Clock | null
  }[],
): readonly Rollback[] {
  const out: Rollback[] = []
  const last = new Map<string, { seq: number; ts: number; inc: number }>()
  for (const row of rows) {
    const c = row.clock
    if (c === null) continue
    const prev = last.get(row.pos.writer)
    last.set(row.pos.writer, { seq: row.pos.seq, ts: c.ts, inc: c.inc })
    if (prev === undefined) continue
    if (c.inc > prev.inc && c.ts < prev.ts) {
      out.push({
        writer: row.pos.writer,
        before: prev,
        after: { seq: row.pos.seq, ts: c.ts, inc: c.inc },
      })
    }
  }
  return out
}

/** 回拨那一行的文字面（`status` 与它同一处取值）。**报事实，不报错**。 */
export function rollbackLine(b: Rollback): string {
  return (
    `${b.writer} · seq ${b.before.seq}→${b.after.seq} · ts ${b.before.ts}→${b.after.ts}` +
    ` · inc ${b.before.inc}→${b.after.inc}（inc 不回头而 ts 回头）`
  )
}
