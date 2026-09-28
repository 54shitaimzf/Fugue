// TUI 的第一格：**同一读面的第二档渲染**。
//
// 出处：架构 § 9.6 那张观察表（`status` / `watch` 的落地栏）· 架构 § 8.13（`round/state` 那条链
// 与它的图）· 架构 § 8.15（"不采集，只重算——因此任何指标都能被复核"）· PLAN § 5.18 的三面表
// （**事件面是唯一读源**：状态机从 `round/state` 链重放，指标从日志重算）· § 5.19 第五段
// （"TUI 是同一读面的第二档渲染，不是新功能"）。
//
// **它一个新读源都不开。** 进来的那份 `StatusSnapshot` 就是 `status --once` 印的那一份
// （`probe/status.ts` 折出来的），指标是 `--metrics` 那一份从日志重算出来的八元，打回三数是
// `--report` 那一份（`probe/round.ts`）。这一份**只排版**：一个字节都不写、一次 IO 都不做。
//
// 三条不许破的性质：
//
//   · **纯**：同一份输入调两次，逐字节相同——没有时间 · 没有随机 · 不读终端尺寸（尺寸是入参，
//     TUI 那一侧问终端，这一份不问）；
//   · **不写状态**（读面那一列的天花板）：它连"最后一帧"都不留；
//   · **少印要说出来**：屏幕装不下时截断，并且说出还剩多少行——读面不许因为屏小就静默少印。
//
// 一帧分三层，每层读的都是同一份快照，**没有一处从事件重算**（那是 `probe/` 那两处的事）：
//
//   · **左栏 = 处境**：`round/state` 链重放出来的那几行（每一步 · 每一格走到哪儿 · 停因）；
//   · **右栏 = 读数**：契约 · 折叠尝试 · 冲突 · 验收 · 用量 · 八元 · 打回三数；
//   · **账尾（footer）**：全账的那一条状态条（最近一条事件是什么 · 一共几条）。它**不进任何一栏**：
//     它是"这份账到哪儿了"，不是某一栏的读数——放进右栏的话，"多一条 `round/state` 只动左栏"
//     这条性质就会被它搅浑（`frame.test.ts` ②）。
//
// 于是有三条可证伪的性质（`frame.test.ts` ②/③/④ 那三条对照）：
//
//   · 账里多一条 `round/state` → **左栏变**，右栏逐字节不变（账尾那条会动，那是全账的读数）；
//   · 账里多一条 `merge/attempt`（冲突 2）→ **右栏变**，左栏逐字节不变；
//   · 账里多一次 `llm/call` → **两栏都变**（调用次数在左栏与右栏各有一处口径）——这一条也是对的，
//     它说明两栏不是按事件类型分的，是按**读法**分的。
//
// **装不下怎么办**：宽了**折行**（一行都不少——折在空格处，折不出来才硬切），窄了收成单栏
// （同一个框，少中间那根竖线）；只有屏幕**矮**到装不下这几行时才截断，并且末行说出还剩几行。
// 高度连五行都没有（画不出框 + 账尾）时印一句"太矮"，不静默给一个空帧。
import type { MetricValue } from '../probe/metrics.ts'
import { costOf, matchModels, moneyText } from '../model/price.ts'
import type { Phase } from '../model/price.ts'
import type { MetricReading } from '../probe/round.ts'
import type { StatusSnapshot } from '../probe/status.ts'

/** 两栏至少要这么宽才画得下（再窄就收成单栏）：左 24 · 右 20 · 框与中间那根竖线 3 列。 */
export const MIN_TWO_COLUMN = 24 + 20 + 3

/** 画得出框 + 账尾至少要几行：上下两条边 · 一行内容 · 一条分隔 · 一行账尾。 */
export const MIN_HEIGHT = 5

/** 一条读数的两栏。**它是这一份唯一的中间产物**——渲染与那三条对照都从它读。 */
export interface FrameBody {
  /** 左栏那些行：处境。 */
  readonly left: readonly string[]
  /** 右栏那些行：读数。 */
  readonly right: readonly string[]
}

/** 一帧的三层。**帧自己说得出它的几何**（谁要把一帧拆开，就按 `columns` 拆）。 */
export interface Frame {
  readonly width: number
  readonly height: number
  /** 左栏与右栏各占多少列（单栏那一档 `right` 是 0）。 */
  readonly columns: { readonly left: number; readonly right: number }
  /** 账尾那一行（已经是把 `footerOf` 折进框宽之后的样子）。 */
  readonly footer: string
  /** 整帧：`height` 行以内，逐行等宽（显示宽度，按 `widthOf` 那把尺）。 */
  readonly lines: readonly string[]
}

export interface FrameInput {
  /** 读源一：那一刻的处境（`status --once` 印的那一份）。 */
  readonly snapshot: StatusSnapshot
  /** 读源二：八元指标。**不给就不印那一栏**——不拿 0 顶（`B1` 那一条）。 */
  readonly metrics?: readonly MetricValue[]
  /** 读源三：打回那三个数。同上，不给就不印。 */
  readonly report?: readonly MetricReading[]
  /**
   * 读的时候是峰时还是谷时（官方价目分两档）。**不给就不印钱那一栏**——账上没有时刻，这一档只能由
   * 读的人给（与 `status --once` 那条同一个口径）。
   */
  readonly phase?: Phase
  /**
   * 读源四：**永久行那一栏**（`ui/stream.ts` 的 `permanentLinesOf(rows)`）。账尾印它最后一条的
   * 原文——"这份账走到哪儿了"要说的是处境那条链走到哪了，不是"最近一条事件"的时刻与坐标（最近
   * 一条多半是一条只进瞬态区的 `llm/call`，印出来只是一个坐标）。不给（或空）时账尾照旧印
   * "最近 <事件>（writer seq）· 事件 N 条"。
   */
  readonly permanent?: readonly string[]
  /**
   * 读源五（**临时那一层**）：面板的候选行（`ui/menu.ts` 算好的原文）与选中项落在第几条。
   *
   * 它排在内容那一栏的**最下面**（挨着账尾）——面板是临时的一层，永久行与读数都不为它让位到看不见；
   * 装不下时 `windowOf` 把选中的那一条留在窗里，并把上下还剩几条说出来。不给时一列都不占。
   */
  readonly menu?: MenuInput | undefined
  /** 读源六（`T6`）：**门口那一批那一块**（底部队列行 + 预览 + 三档）。见 `GateInput`。 */
  readonly gate?: GateInput | undefined
  readonly width: number
  readonly height: number
}

/** 用量那四个数：**量到的和 + 没量到的条数**（与 `status --once` 同一个口径）。 */
function usageText(t: { readonly total: number; readonly missing: number }): string {
  return t.missing > 0 ? `${t.total}（缺 ${t.missing} 条）` : String(t.total)
}

/**
 * 两栏的内容。**只读快照，不算任何东西**——这一份里没有一处从事件重算的口径（那是
 * `probe/` 那两处的事，两处都在它们自己那一份文件里）。
 *
 * 次序两栏都是"先粗后细"：左栏先是轮次那一行（状态 · 转移条数 · 打回几次）再逐条边、再每一格；
 * 右栏先是记账那几行（契约 · 验收 · 用量），再八元、再打回三数。
 */
export function bodyOf(o: {
  readonly snapshot: StatusSnapshot
  readonly metrics?: readonly MetricValue[]
  readonly report?: readonly MetricReading[]
}): FrameBody {
  const s = o.snapshot

  const left: string[] = []
  if (s.rounds.length === 0) {
    left.push('还没开过轮次（账上一条 round/state 都没有）')
  }
  for (const r of s.rounds) {
    const here = r.round === s.current ? ' · 最近一条落在这一轮' : ''
    const jumps = r.hops === r.transitions ? '' : ` · 跳步 ${r.hops - r.transitions}`
    left.push(`轮次 ${r.round} · 状态 ${r.state} · 转移 ${r.transitions} 条${jumps} · 打回 ${r.rejects} 次${here}`)
    for (const e of r.edges) left.push(`  ${e}`)
    if (r.unrouted > 0) left.push(`  （图上走不通的 ${r.unrouted} 条：账与图对不上）`)
  }
  for (const a of s.agents) {
    const stop = a.stopped === null ? '没停' : `${a.stopSteps ?? '?'} 步 · ${a.stopped}`
    left.push(`格 ${a.agent} · 调 ${a.calls} 次 · ${a.steps} 步 · 工具调用 ${a.invocations} · 动作 ${a.actions} · 停：${stop}`)
  }

  const right: string[] = []
  right.push(
    `契约 ${s.contracts} · 折叠尝试 ${s.attempts} · 冲突 ${s.conflicts} · 验收 ${s.accepts.accepts} 次（过 ${s.accepts.pass} / 没过 ${s.accepts.fail}）`,
  )
  right.push(
    `用量 调用 ${s.usage.calls} · input ${usageText(s.usage.inputTokens)} · cacheRead ${usageText(s.usage.cacheReadTokens)}` +
      ` · cacheWrite ${usageText(s.usage.cacheWriteTokens)} · output ${usageText(s.usage.outputTokens)}` +
      ` · 思考 ${usageText(s.usage.reasoningTokens)}`,
  )
  // 钱那一栏：与 `status --once` 同一处算法、同一句话（`src/model/price.ts` 的 `moneyText`）。
  if (o.phase !== undefined) {
    const match = matchModels(s.models)
    right.push(moneyText({ money: costOf(s.usage, match.row, o.phase), match, phase: o.phase, models: s.models }))
  }
  for (const m of o.metrics ?? []) {
    right.push(`${m.metric} ${m.value === null ? '算不出来' : m.value}（${m.numerator ?? '—'}/${m.denominator ?? '—'}）`)
  }
  if (o.report !== undefined && o.report.length > 0) {
    right.push(`打回 ${o.report.map((r) => `${r.metric} ${r.count}`).join(' · ')}`)
  }
  return { left, right }
}

/**
 * 账尾那一行（全账的读数，**不属于任何一栏**）：**最近那条永久行的原文**；一条永久行都还没有时
 * 才是"最近一条事件是什么 + 一共几条"。
 *
 * 次序是"最近一条"在前：这一行窄起来要从右边截（状态条那一档），先留住的是"账还在动"这个信号。
 * 永久行那一栏由分法给（`ui/stream.ts` 那一张表），这一份只读它的最后一条——不分法、不重算。
 */
export function footerOf(s: StatusSnapshot, permanent?: readonly string[]): string {
  const last = permanent?.[permanent.length - 1]
  if (last !== undefined) return last
  if (s.last === null) return '事件 0 条（账上还没有一条）'
  return `最近 ${s.last.t}（${s.last.writer} ${s.last.seq}）· 事件 ${s.events} 条`
}

/**
 * 把一帧补成**正好 `height` 行、每行正好 `columns` 列**——终端那一层要的那块恒定 K 行的区域。
 *
 * 为什么要在这一份里做：**1 逻辑行 = 1 物理行**是"上移 K 行"唯一的前提，而它靠两件事——每行
 * 恰好 `columns` 列（`cell` 先截后补）与行数不超过 `height`。`frameOf` 本来就保证
 * `lines.length <= height`，这里再兜一次；**少的那几行补空白，不补内容**（"还有 N 行没印"那句
 * 由 `frameOf` 自己说，补空行不是少印）。
 */
export function panelOf(lines: readonly string[], height: number, columns: number): readonly string[] {
  const h = Math.max(0, height)
  const w = Math.max(0, columns)
  const out = lines.slice(0, h).map((one) => cell(one, w))
  while (out.length < h) out.push(' '.repeat(w))
  return out
}

/** 一个**簇**：人眼算一个字的那些 code unit（基字符 + 跟在它身上的组合符号 · 变体选择符 · ZWJ 那几段）。 */
export interface Cluster {
  /** 簇里的原文（一个字节不改）。 */
  readonly text: string
  /** 在这一行里的起止（`[start, end)`，code unit 偏移）。 */
  readonly start: number
  readonly end: number
  /** 占几列。 */
  readonly width: number
}

/** 东亚宽字符那几段（连 emoji）。**近似**：`⇒` 这类 Ambiguous 按 Unicode 缺省算一列。 */
function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff)
  )
}

/**
 * 零宽那些段：组合符号 · 变体选择符 · 肤色修饰 · 连接符（ZWJ）。
 *
 * **近似**：UAX #29 那张表是几百段，整张抄进来就是一份会漂的第二份真相；这里收的是终端上真会
 * 出现的那几段（印出来的字、还有输入行里打进去的字）。表外的组合符号会被当成独立的字——多占一列。
 * **什么条件下改主意**：真遇到表外的（那种字真落进输入行，而不只是印出来），就换
 * `Intl.Segmenter`，或者把这张表按需要长出来——长到几十行就该单独一份文件（`ui/glyph.ts`）。
 */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5],
  [0x05c7, 0x05c7], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4],
  [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0711, 0x0711], [0x0730, 0x074a], [0x07a6, 0x07b0], [0x07eb, 0x07f3],
  [0x0816, 0x0819], [0x081b, 0x0823], [0x0825, 0x0827], [0x0829, 0x082d], [0x0859, 0x085b], [0x08d3, 0x08e1],
  [0x08e3, 0x0903], [0x093a, 0x093c], [0x093e, 0x094f], [0x0951, 0x0957], [0x0962, 0x0963], [0x0981, 0x0983],
  [0x09bc, 0x09bc], [0x09be, 0x09cd], [0x09d7, 0x09d7], [0x09e2, 0x09e3], [0x0a01, 0x0a03], [0x0a3c, 0x0a3c],
  [0x0a3e, 0x0a4d], [0x0a51, 0x0a51], [0x0a70, 0x0a71], [0x0a75, 0x0a75], [0x0a81, 0x0a83], [0x0abc, 0x0abc],
  [0x0abe, 0x0acd], [0x0ae2, 0x0ae3], [0x0b01, 0x0b03], [0x0b3c, 0x0b3c], [0x0b3e, 0x0b57], [0x0b62, 0x0b63],
  [0x0b82, 0x0b82], [0x0bbe, 0x0bcd], [0x0bd7, 0x0bd7], [0x0c00, 0x0c04], [0x0c3e, 0x0c56], [0x0c62, 0x0c63],
  [0x0c81, 0x0c83], [0x0cbc, 0x0cbc], [0x0cbe, 0x0cd6], [0x0ce2, 0x0ce3], [0x0d00, 0x0d03], [0x0d3b, 0x0d3c],
  [0x0d3e, 0x0d4d], [0x0d57, 0x0d57], [0x0d62, 0x0d63], [0x0d81, 0x0d83], [0x0dca, 0x0dca], [0x0dcf, 0x0dd6],
  [0x0dd8, 0x0ddf], [0x0df2, 0x0df3], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x0eb1, 0x0eb1],
  [0x0eb4, 0x0ebc], [0x0ec8, 0x0ecd], [0x0f18, 0x0f19], [0x0f35, 0x0f35], [0x0f37, 0x0f37], [0x0f39, 0x0f39],
  [0x0f3e, 0x0f3f], [0x0f71, 0x0f84], [0x0f86, 0x0f87], [0x0f8d, 0x0f97], [0x0f99, 0x0fbc], [0x0fc6, 0x0fc6],
  [0x102b, 0x103e], [0x1056, 0x1059], [0x105e, 0x1060], [0x1062, 0x1064], [0x1067, 0x106d], [0x1071, 0x1074],
  [0x1082, 0x108d], [0x108f, 0x108f], [0x109a, 0x109d], [0x135d, 0x135f], [0x1712, 0x1715], [0x1732, 0x1734],
  [0x1752, 0x1753], [0x1772, 0x1773], [0x17b4, 0x17d3], [0x17dd, 0x17dd], [0x180b, 0x180d], [0x1885, 0x1886],
  [0x18a9, 0x18a9], [0x1920, 0x192b], [0x1930, 0x193b], [0x1a17, 0x1a1b], [0x1a55, 0x1a5e], [0x1a60, 0x1a7c],
  [0x1a7f, 0x1a7f], [0x1ab0, 0x1aff], [0x1b00, 0x1b04], [0x1b34, 0x1b44], [0x1b6b, 0x1b73], [0x1b80, 0x1b82],
  [0x1ba1, 0x1bad], [0x1be6, 0x1bf3], [0x1c24, 0x1c37], [0x1cd0, 0x1cd2], [0x1cd4, 0x1ce8], [0x1ced, 0x1ced],
  [0x1cf4, 0x1cf4], [0x1cf7, 0x1cf9], [0x1dc0, 0x1dff], [0x200d, 0x200d], [0x20d0, 0x20f0], [0x2cef, 0x2cf1],
  [0x2d7f, 0x2d7f], [0x2de0, 0x2dff], [0x302a, 0x302f], [0x3099, 0x309a], [0xa66f, 0xa672], [0xa674, 0xa67d],
  [0xa69e, 0xa69f], [0xa6f0, 0xa6f1], [0xa802, 0xa802], [0xa806, 0xa806], [0xa80b, 0xa80b], [0xa823, 0xa827],
  [0xa880, 0xa881], [0xa8b4, 0xa8c5], [0xa8e0, 0xa8f1], [0xa926, 0xa92d], [0xa947, 0xa953], [0xa980, 0xa983],
  [0xa9b3, 0xa9c0], [0xa9e5, 0xa9e5], [0xaa29, 0xaa36], [0xaa43, 0xaa43], [0xaa4c, 0xaa4d], [0xaa7b, 0xaa7d],
  [0xaab0, 0xaab0], [0xaab2, 0xaab4], [0xaab7, 0xaab8], [0xaabe, 0xaabf], [0xaac1, 0xaac1], [0xaaeb, 0xaaef],
  [0xaaf5, 0xaaf6], [0xabe3, 0xabea], [0xabec, 0xabed], [0xfb1e, 0xfb1e], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0x101fd, 0x101fd], [0x102e0, 0x102e0], [0x10376, 0x1037a], [0x10a01, 0x10a0f], [0x10a38, 0x10a3f],
  [0x10ae5, 0x10ae6], [0x11000, 0x11002], [0x11038, 0x11046], [0x1107f, 0x11082], [0x110b0, 0x110ba],
  [0x11100, 0x11102], [0x11127, 0x11134], [0x11145, 0x11146], [0x11173, 0x11173], [0x11180, 0x11182],
  [0x111b3, 0x111c0], [0x1122c, 0x11237], [0x112df, 0x112ea], [0x11300, 0x11303], [0x1133b, 0x1134d],
  [0x11357, 0x11357], [0x11362, 0x11374], [0x114b0, 0x114c3], [0x115af, 0x115c0], [0x16af0, 0x16af4],
  [0x16b30, 0x16b36], [0x16f51, 0x16f92], [0x1bc9d, 0x1bc9e], [0x1d165, 0x1d169], [0x1d16d, 0x1d182],
  [0x1d185, 0x1d18b], [0x1d1aa, 0x1d1ad], [0x1d242, 0x1d244], [0x1da00, 0x1da36], [0x1da3b, 0x1da6c],
  [0x1da75, 0x1da75], [0x1da84, 0x1da84], [0x1da9b, 0x1daa1], [0x1daa9, 0x1daad], [0x1e000, 0x1e02a],
  [0x1e8d0, 0x1e8d6], [0x1e944, 0x1e94a], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
]

function isZero(c: number): boolean {
  for (const [lo, hi] of ZERO) if (c >= lo && c <= hi) return true
  return false
}

/** 区域指示符：一对拼成一面旗（两列）。 */
function isRegional(c: number): boolean {
  return c >= 0x1f1e6 && c <= 0x1f1ff
}

/**
 * 一行切成**簇**。一个簇 = 基字符 + 挂在它身上的那些（组合符号 · 变体选择符 · 肤色修饰 ·
 * ZWJ 后面那一个，一对区域指示符算一个）。于是"左移一格"对 `e` + U+0301 是一步而不是两步，
 * 对一串 ZWJ 连起来的 emoji（一家三口那种）也是一步。
 *
 * **按串记住**（`CLUSTERS`）：一帧里同一个串要被问好几次（截 · 折 · 量列宽），每帧重算是白烧。
 * 表里存的只是纯函数对同一个输入的答案，所以这不改任何输出。
 */
const CLUSTERS = new Map<string, readonly Cluster[]>()
const CLUSTERS_MAX = 512

export function clustersOf(s: string): readonly Cluster[] {
  const hit = CLUSTERS.get(s)
  if (hit !== undefined) return hit
  const out: Cluster[] = []
  let i = 0
  while (i < s.length) {
    const start = i
    const base = s.codePointAt(i) as number
    i += base > 0xffff ? 2 : 1
    let flags = isRegional(base) ? 1 : 0
    while (i < s.length) {
      const next = s.codePointAt(i) as number
      if (next === 0x200d && i + 1 < s.length) {
        i += 1
        i += (s.codePointAt(i) as number) > 0xffff ? 2 : 1
        continue
      }
      if (isZero(next)) {
        i += next > 0xffff ? 2 : 1
        continue
      }
      if (flags === 1 && isRegional(next)) {
        i += 2
        flags = 2
        continue
      }
      break
    }
    const wide = isWide(base) || isRegional(base)
    out.push({ text: s.slice(start, i), start, end: i, width: isZero(base) ? 0 : wide ? 2 : 1 })
  }
  if (CLUSTERS.size >= CLUSTERS_MAX) CLUSTERS.clear()
  CLUSTERS.set(s, out)
  return out
}

/**
 * 一个串占几列（**显示列**）。按簇算：`e` + U+0301 是一列（组合符号零宽），`中文abc` 是七列，
 * 一串 ZWJ 连起来的 emoji（一家三口那种）是两列。`⇒` 那类 Ambiguous 按 Unicode 缺省算一列（见 `isWide`）。
 */
export function widthOf(s: string): number {
  let n = 0
  for (const c of clustersOf(s)) n += c.width
  return n
}

/**
 * 前 `w` 列切在几个 code unit 上（**整簇**切：不会把一个字的基字符与它身上的组合符号切成两半）。
 * 一个簇都放不下（`w` 比整簇还窄）时切一个整簇，免得调用方原地打转；`w <= 0` 切 0。
 */
export function cutAt(s: string, w: number): number {
  if (w <= 0) return 0
  let used = 0
  let n = 0
  for (const c of clustersOf(s)) {
    if (used + c.width > w) break
    used += c.width
    n = c.end
  }
  if (n === 0) n = clustersOf(s)[0]?.end ?? 0
  return n
}

/** 按列宽截断：切在**簇**边界上，末尾留下一个 `…`（它也占一列）。 */
export function clip(s: string, w: number): string {
  if (w <= 0) return ''
  if (widthOf(s) <= w) return s
  let out = ''
  let used = 0
  for (const c of clustersOf(s)) {
    if (used + c.width > w - 1) break
    out += c.text
    used += c.width
  }
  return `${out}…`
}

/**
 * 折行：把一行按列宽切成几段。**整词放得下就切在词尾**；放不下那个字符落在词中间时，退到
 * **最后一个空格**（宁可这一行短一点，也不把词切成两半——`cacheWrite` 切在中间没人看得懂）。
 * 一整段连一个空格都没有时就是硬切：**一个字都不许少**。
 *
 * 为什么是折而不是截：宽了就把一行切掉半截，等于**静默少印**——读面不许这样。折行之后一个
 * 字节都不少，只有屏幕**矮**的时候才截（那时末行会说还剩几行）。断点落在 ` · ` 前半截时，
 * 下一行会从 `· ` 开头（读起来像漏了半句）——把那个分隔符吃掉再起；吃掉的只是标点。
 */
export function wrap(s: string, w: number): readonly string[] {
  if (w <= 0 || widthOf(s) <= w) return [s]
  const out: string[] = []
  let rest = s
  while (widthOf(rest) > w) {
    // 切点：下一个簇放不下而它是个空格（或者到头了），就切在 `cutAt` 给的那个位置——那正好是一个
    // 词的末尾；放不下的那个簇落在词中间时退到最后一个空格。一个簇都放不下时切一个整簇，免得
    // 原地打转（`cutAt` 已经保证整簇切）。
    let cut = cutAt(rest, w)
    const next = rest[cut]
    if (next !== undefined && next !== ' ') {
      const sp = rest.lastIndexOf(' ', cut)
      if (sp > 0) cut = sp
    }
    if (cut <= 0) cut = clustersOf(rest)[0]?.end ?? 1
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
    if (rest.startsWith('· ')) rest = rest.slice(2)
  }
  if (rest !== '') out.push(rest)
  return out
}

/** 补到正好 `w` 列（先截后补）。折过行的那几行进来时正好是 `w` 以内，所以这里的截是兜底。 */
function cell(s: string, w: number): string {
  const cut = clip(s, w)
  return cut + ' '.repeat(Math.max(0, w - widthOf(cut)))
}

/** 一段框线：左边一个空格与标签，右边拿 `─` 补满（位置不够就只剩 `─`）。 */
function bar(w: number, label?: string): string {
  if (label === undefined || widthOf(label) + 3 > w) return '─'.repeat(Math.max(0, w))
  return `─ ${label} ` + '─'.repeat(w - widthOf(label) - 3)
}

/** 候选那一层那几行（`ui/menu.ts` 算好的原文）与选中项落在第几条（`T4`）。 */
export interface MenuInput {
  readonly rows: readonly string[]
  readonly sel: number
}

/**
 * 门口那一块那几行（`ui/gate.ts` 算好的原文）与**装不下也要留住的条数**（`T6`）。
 *
 * 它排在内容那一栏的**最下面**（比候选还下面——候选是打字时的一层，而门口那一块是"要人点头"的
 * 一件事）。装不下时**先让位的是预览**（头几行），末 `keep` 行留住：那两行是人要按的东西（队列行 ·
 * 选项行）。不给时一列都不占——`T6` 之前逐字节相同。
 */
export interface GateInput {
  readonly rows: readonly string[]
  readonly keep: number
}

/** 候选那一层开的一个窗：印第 `from` 条起的 `count` 条，`summary` 说还要不要补一行"还有几条"。 */
export interface MenuWindow {
  readonly from: number
  readonly count: number
  readonly above: number
  readonly below: number
  readonly summary: boolean
}

/**
 * 在 `budget` 行里给 `n` 条候选开一个窗，**选中的那一条一定在窗里**（偏到边上就贴着边走）。装不下时
 * 留一行说"还有几条"（`summary`），于是印出去的候选行数 + 那一样 ≤ `budget`。
 */
export function windowOf(n: number, sel: number, budget: number): MenuWindow {
  const total = Math.max(0, n)
  const b = Math.max(1, budget)
  const at = Math.max(0, Math.min(total - 1, sel))
  if (total <= b) return { from: 0, count: total, above: 0, below: 0, summary: false }
  if (b === 1) return { from: at, count: 1, above: at, below: total - at - 1, summary: false }
  const count = b - 1
  const from = Math.max(0, Math.min(total - count, at - Math.floor(count / 2)))
  const above = from
  const below = total - from - count
  return { from, count, above, below, summary: above + below > 0 }
}

/**
 * 一帧。**纯函数**：进去的那几样决定出来的那几行，别的一处都不看。
 *
 * 尺寸：`width` / `height` 是入参。两栏要 `MIN_TWO_COLUMN` 以上才画得出，否则收成单栏；
 * 内容装不下时按行截断，末行说出还剩多少行（账尾那一条装不下时先让位——它是全账的读数，
 * 不是这一屏的内容）。`width <= 0 || height <= 0` 时给一个空帧（终端那一刻没给出尺寸）。
 */
export function frameOf(o: FrameInput): Frame {
  const { width, height } = o
  const empty: Frame = { width, height, columns: { left: 0, right: 0 }, footer: '', lines: [] }
  if (width <= 0 || height <= 0) return empty
  if (height < MIN_HEIGHT) {
    // 画不出框就说出来，不静默给一个空帧（读面那一条：少印要说）。
    const why = `（这一屏太矮：要 ${MIN_HEIGHT} 行以上才画得出框与账尾，拿到的是 ${height} 行）`
    return { ...empty, lines: [cell(why, width)] }
  }

  const body = bodyOf(o)
  const two = width >= MIN_TWO_COLUMN && body.left.length > 0 && body.right.length > 0
  // **右栏拿大头（3/5）**（U10c）：读数那一栏是"数字 + 分子/分母"的长行（八元指标一条
  // 就是一句），40 列那档两栏对半时它截得最狠；处境那一栏的行短（轮次 · 状态 · 边），
  // 2/5 装得下。两根竖线加两头的框占 3 列，先扣再分。
  const left = two ? Math.floor(((width - 3) * 2) / 5) : width - 2
  const right = two ? width - 3 - left : 0
  const inner = width - 2

  // 内容那一栏：**先把每一行折进它那一栏的列宽**，再一行对一行（右边短的那些补空）；
  // 单栏那一档先把左栏印完再印右栏（同一个框，只是没有中间那根竖线）。
  const rows: { readonly l: string; readonly r: string; readonly full?: boolean }[] = []
  if (two) {
    const l2 = body.left.flatMap((one) => wrap(one, left))
    const r2 = body.right.flatMap((one) => wrap(one, right))
    const n = Math.max(l2.length, r2.length)
    for (let i = 0; i < n; i += 1) rows.push({ l: l2[i] ?? '', r: r2[i] ?? '' })
  } else {
    for (const one of body.left.flatMap((x) => wrap(x, left))) rows.push({ l: one, r: '' })
    for (const one of body.right.flatMap((x) => wrap(x, left))) rows.push({ l: one, r: '' })
  }

  // 账尾那条状态条：**一行**，超出就从右边截（`clip` 留 `…`，说了它被截过）。
  const footer = clip(footerOf(o.snapshot, o.permanent), inner)
  // 框占上下两行，账尾占分隔 + 一行；装不下就先让账尾让位。
  let withFooter = rows.length + 4 <= height
  let budget = height - 2 - (withFooter ? 2 : 0)
  if (budget < 1) {
    withFooter = false
    budget = height - 2
  }

  // 候选那一层（`/` 菜单 · `Ctrl-P` 面板）**从内容那一栏的最下面切一块**（最多一半）：面板开开关关，
  // 上面那几行读数一个字节都不动；它自己装不下时把选中的那一条留在窗里，并把还剩几条说出来。
  const menuAll = o.menu === undefined ? null : o.menu.rows
  const menuCap = menuAll === null ? 0 : Math.max(1, Math.min(Math.floor(budget / 2), Math.max(1, menuAll.length)))
  const win = menuAll === null || menuAll.length === 0 ? null : windowOf(menuAll.length, o.menu?.sel ?? 0, menuCap)
  const menuBody: string[] = []
  if (menuAll !== null) {
    if (menuAll.length === 0) menuBody.push('（没有匹配的）')
    else {
      const w = win as MenuWindow
      const at = Math.max(0, Math.min(menuAll.length - 1, o.menu?.sel ?? 0))
      for (let i = w.from; i < w.from + w.count; i += 1) {
        menuBody.push(`${i === at ? '▸' : ' '} ${menuAll[i] as string}`)
      }
      if (w.summary) menuBody.push(`… 还有 ${w.above + w.below} 条（↑↓ 翻，选中第 ${at + 1} 条）`)
    }
  }
  // 门口那一块（`T6`）先占住它那几行，再轮到候选，最后才是内容那一栏（装不下时**从后往前让位**，
  // 而门口那一块自己先让位的是**预览**——头几行；末 `keep` 行留住：那是人要按的东西）。一块都没有
  // （`gate` 不给）时下面这几步与从前逐字节相同（`gateBody` 是空的 · `keep` 是 0）。
  const gateAll = o.gate?.rows ?? []
  const keep = Math.max(0, Math.min(o.gate?.keep ?? 0, gateAll.length))
  let gateBody = [...gateAll]
  while (gateBody.length > keep && budget - 1 - gateBody.length < 0) gateBody = gateBody.slice(1)
  while (menuBody.length > 0 && budget - 1 - gateBody.length - menuBody.length < 0) menuBody.pop()
  while (gateBody.length > keep && budget - 1 - gateBody.length - menuBody.length < 0) gateBody = gateBody.slice(1)
  while (menuBody.length > 0 && budget - gateBody.length < 1) menuBody.pop()
  while (gateBody.length > 0 && budget - gateBody.length < 1) gateBody = gateBody.slice(1)
  const bodyBudget = Math.max(1, budget - menuBody.length - gateBody.length)
  const shown = rows.length <= bodyBudget ? rows : rows.slice(0, Math.max(0, bodyBudget - 1))
  const dropped = rows.length - shown.length
  if (dropped > 0) shown.push({ l: `… 还有 ${dropped} 行没印（这一屏 ${height} 行）`, r: '' })
  for (const one of menuBody) shown.push({ l: one, r: '', full: true })
  for (const one of gateBody) shown.push({ l: one, r: '', full: true })

  const lines: string[] = []
  lines.push(`┌${bar(left, '处境')}${two ? `┬${bar(right, '读数')}` : ''}┐`)
  for (const one of shown) {
    // 候选那一层**横贯整栏**（它是临时的一层，不参与左右两栏的分工）。
    if (one.full === true) {
      lines.push(`│${cell(one.l, inner)}│`)
      continue
    }
    lines.push(`│${cell(one.l, left)}${two ? `│${cell(one.r, right)}` : ''}│`)
  }
  if (withFooter) {
    lines.push(`├${'─'.repeat(left)}${two ? `┴${'─'.repeat(right)}` : ''}┤`)
    lines.push(`│${cell(footer, inner)}│`)
  }
  lines.push(`└${'─'.repeat(left)}${two ? `┴${'─'.repeat(right)}` : ''}┘`)
  return { width, height, columns: { left, right }, footer, lines }
}
