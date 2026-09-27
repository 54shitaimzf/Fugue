// M14 的第一支：**打回那三个数，从日志重算**。出处：架构 § 8.15（「不采集，只重算——因此任何
// 指标都能被复核」）· 架构 § 20 S7 的可用性（"打回率有读数——冲突数 · `Verifying → Working` 的
// 次数 · 动作被拒的次数，三个数从日志重算，不采集"）· 架构 § 8.1 的那三条事件 ·
// PLAN § 5.7 的 A8 行。
//
// **三个数各有唯一一处取值处，都在 `src/log/events.ts` 里**（A0 第一节的站前读数量过：那三个字段
// 今天就在事件形状里，`verdict` 那一个还是 A0 才补上的）。所以这一份**不新增事件、不读别的状态**：
//
//   ① `merge/attempt` 的 `conflicts` 求和     —— 合并那一趟撞了几条路径
//   ② `round/state` 里 `Verifying → Working` 的条数 —— 验收打回了几次
//   ③ `run/end` 的 `denied` 为真的条数        —— 动作被内核拒了几次
//
// **"重算"这件事本身就是它的可复核性**：同一份日志算两次同值，而两个不同的人拿同一份日志按这
// 三条判据各算一遍也同值——因为这三条判据在这里一字不差地写出来了，没有一处藏在状态里。
//
// **三个数各自独立，不合成一个"打回率"。** 合成需要一个分母，而分母是什么（每轮？每契约？每动作？）
// 今天没有定论——架构 § 8.13.a 那张表把"打回次数"与"打回的严格程度"分开读，正是因为它不该被
// 压成一个数。这一份因此给三个数，合成留给读的人（与 § 8.12 那句"事前不造伪判据"同一条纪律）。
import type { LogEvent } from '../log/events.ts'
import type { RoundId, RoundState } from '../terms.ts'

/**
 * 三个计数点。**它们的名字就是它们的判据**，没有第四条路。
 *
 * `merge-attempt` 的四个数里最要紧的是 `conflicts` 那一个；`verdict` 那一档只数**没通过**
 * （`fail`），**"跑不起来"不进**（架构 § 8.12 末段：仪器故障不算活干错了）。这一条是这一份里
 * 唯一一处"要判一下"的地方，所以它单独写成一句。
 */
export type Metric = 'conflicts' | 'rejects' | 'denied'

export const METRICS: readonly Metric[] = ['conflicts', 'rejects', 'denied']

/** 一条读数：那个数，加它是怎么数出来的。 */
export interface MetricReading {
  readonly metric: Metric
  readonly count: number
  /** 数了哪几条事件（人读的一句话）。 */
  readonly how: string
}

/** 三个数的名字与判据，给报告与走查印（**判据写在数据里**，好让它与代码对得上）。 */
export const METRIC_HOW: Readonly<Record<Metric, string>> = {
  conflicts: 'merge/attempt 的 conflicts 求和——合并那一趟撞了几条路径',
  rejects: 'round/state 里 Verifying → Working 的条数——验收打回了几次（断言"没通过"那一档）',
  denied: 'run/end 的 denied 为真的条数——动作被内核拒了几次',
}

/**
 * 一个轮次的范围。**不给就是全部**——`roundId` 只用来筛 `round/state` · `merge/attempt` ·
 * `merge/accept` 那几条带轮次号的事件；`run/end` 不带轮次号（§ 8.1 那张表逐字），所以按轮筛
 * 的时候它数的是**全部**，这一点如实写在读数里，不假装筛过。
 */
export interface Range {
  readonly round?: RoundId
}

/** 数一条事件贡献了几个。**三条判据的每一处都在这里，一眼看得完。** */
function countOf(e: LogEvent, metric: Metric, range: Range): number {
  if (metric === 'conflicts') {
    if (e.t !== 'merge/attempt') return 0
    if (range.round !== undefined && e.round !== range.round) return 0
    return e.conflicts
  }
  if (metric === 'rejects') {
    if (e.t !== 'round/state') return 0
    if (range.round !== undefined && e.round !== range.round) return 0
    // **只有"没通过 → 回 Working"那一条边算打回**；`Merging → Verifying` 那种"到了验收态"不算。
    // "没通过"这一档在事件上就是那条回边——失败断言与判决都进 `merge/accept`，而回边是它唯一的
    // 状态痕迹（A3 的那张表里，`Verifying` 只有三条出边）。
    return e.from === 'Verifying' && e.to === 'Working' ? 1 : 0
  }
  if (e.t !== 'run/end') return 0
  return e.denied ? 1 : 0
}

/**
 * 从一个**交错的**读侧算一个数——`readMerged` 那条全序流（§ 9.2：`writer` 字段就是为交错排序
 * 而生的）。
 *
 * **必须走交错这一条**：三个计数点里有两个落在持轮者那一份日志上（`merge/attempt` ·
 * `round/state`），而第三个（`run/end`）落在**每个 agent 自己那一份**上。按 writer 读要先把
 * writer 名枚举出来，而"有哪些 writer"只有日志目录知道（`LogHandle.writers()`）——交错那一条
 * 一处都不用枚举，也不会漏掉某个 agent。
 */
export async function computeMerged(
  merged: AsyncIterable<{ readonly pos: { readonly writer: string }; readonly e: LogEvent }>,
  range: Range,
  metric: Metric,
): Promise<MetricReading> {
  let count = 0
  for await (const { e } of merged) count += countOf(e, metric, range)
  return { metric, count, how: METRIC_HOW[metric] }
}

/** 三个数一次算齐。**同一份日志上的三次遍历**——它们的和不是任何东西，所以不求和。 */
export async function computeAll(
  merged: () => AsyncIterable<{ readonly pos: { readonly writer: string }; readonly e: LogEvent }>,
  range: Range,
): Promise<readonly MetricReading[]> {
  const out: MetricReading[] = []
  for (const m of METRICS) out.push(await computeMerged(merged(), range, m))
  return out
}

/** 一份报告：那三个数，加一段能直接印出来的话。 */
export interface RoundReport {
  readonly range: Range
  readonly readings: readonly MetricReading[]
  /** 逐条印出来（`fugue round run --report` 的那一栏）。 */
  readonly lines: readonly string[]
  /**
   * 归因三处对照那三行（闸四 · § 5.9.3 判据卡那一栏）。**恒三行**——位置不存在的那一行
   * 是「没有读数」，由 `probe/metrics.ts` 那一边排好版；这一份只负责带上它。
   */
  readonly attributionLines: readonly string[]
  /**
   * **逐趟账**：每一条 `llm/call` 一行，末行是合计（PLAN § 5.9 的 `G5`：「`--report` 里每趟
   * `usage` 四个数一行」）。它由 `probe/status.ts` 的 `callLinesOf` 排，这一份只负责带上它——
   * 汇总那一处与 `status --once` 是同一份实现（`statusOf`），不在这里另算一遍。
   */
  readonly callLines: readonly string[]
  /** 是否是"故意撞红"的那一趟：三个数逐个大于 0。**它是 A8 ② 那条断言的判据。** */
  readonly allPositive: boolean
}

/**
 * 把三个数排成一份报告。**它不判"打回率高不高"**——那是读的人的事，而这一份的活是把数摆出来，
 * 并且让"怎么算的"与数一起出现。
 *
 * `allPositive` 是给走查用的一个读数：一趟**故意撞红**的轮次跑完，三个数该逐个大于 0。它不是
 * 判据（打回率高不是好事），是"这三个数真的在动"的证据。
 */
export function reportOf(
  range: Range,
  readings: readonly MetricReading[],
  attributionLines: readonly string[] = [],
  callLines: readonly string[] = [],
): RoundReport {
  const lines = readings.map((r) => `${r.metric}\t${r.count}\t${r.how}`)
  return { range, readings, lines, attributionLines, callLines, allPositive: readings.every((r) => r.count > 0) }
}

/** 一个状态序列里 `Verifying → Working` 的条数——**纯函数那一半，给"同一份日志重算两次"那条断言用**。 */
export function rejectsIn(states: readonly { readonly from: RoundState; readonly to: RoundState }[]): number {
  return states.filter((s) => s.from === 'Verifying' && s.to === 'Working').length
}
