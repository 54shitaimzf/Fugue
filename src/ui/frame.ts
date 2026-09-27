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
      ` · cacheWrite ${usageText(s.usage.cacheWriteTokens)} · output ${usageText(s.usage.outputTokens)}`,
  )
  for (const m of o.metrics ?? []) {
    right.push(`${m.metric} ${m.value === null ? '算不出来' : m.value}（${m.numerator ?? '—'}/${m.denominator ?? '—'}）`)
  }
  if (o.report !== undefined && o.report.length > 0) {
    right.push(`打回 ${o.report.map((r) => `${r.metric} ${r.count}`).join(' · ')}`)
  }
  return { left, right }
}

/**
 * 账尾那一行（全账的读数，**不属于任何一栏**）：最近一条事件是什么 + 一共几条。
 *
 * 次序是"最近一条"在前：这一行窄起来要从右边截（状态条那一档），先留住的是"账还在动"这个信号。
 */
export function footerOf(s: StatusSnapshot): string {
  if (s.last === null) return '事件 0 条（账上还没有一条）'
  return `最近 ${s.last.t}（${s.last.writer} ${s.last.seq}）· 事件 ${s.events} 条`
}

/**
 * 一个字符占几列。**近似**：东亚宽字符那几段算两列，其余算一列。
 *
 * 为什么在这里自己写一个：这一版没有依赖（约定 § 六），而框要对齐就得知道这个数。两处已知的
 * 近似写在下面（它们是**显示**的近似，不影响任何读数）：
 *   · 组合字符（零宽）算一列——这一版的印出来那些字里没有；
 *   · `⇒`（U+21D2，`status.ts` 的跳步那一条用它）在 Unicode 里是 Ambiguous：CJK 终端可能画成
 *     两列。这一份按一列算（Unicode 缺省），所以那种终端上跳步那几行会往右错一格。
 */
export function widthOf(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)
    n += wide ? 2 : 1
  }
  return n
}

/** 按列宽截断：切在字符边界上，末尾留下一个 `…`（它也占一列）。 */
export function clip(s: string, w: number): string {
  if (w <= 0) return ''
  if (widthOf(s) <= w) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const one = widthOf(ch)
    if (used + one > w - 1) break
    out += ch
    used += one
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
    let used = 0
    let hard = 0
    for (const ch of rest) {
      const one = widthOf(ch)
      if (used + one > w) break
      used += one
      hard += ch.length
    }
    // 切点：下一个字符放不下而它是个空格（或者到头了），就切在 `hard`——那正好是一个词的末尾；
    // 放不下那个字符落在词中间时退到最后一个空格。一个字符都放不下时切一个，免得原地打转。
    let cut = hard
    const next = rest[hard]
    if (next !== undefined && next !== ' ') {
      const sp = rest.lastIndexOf(' ', hard)
      if (sp > 0) cut = sp
    }
    if (cut <= 0) cut = (rest.codePointAt(0) ?? 0) > 0xffff ? 2 : 1
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
  const left = two ? Math.floor((width - 3) / 2) : width - 2
  const right = two ? width - 3 - left : 0
  const inner = width - 2

  // 内容那一栏：**先把每一行折进它那一栏的列宽**，再一行对一行（右边短的那些补空）；
  // 单栏那一档先把左栏印完再印右栏（同一个框，只是没有中间那根竖线）。
  const rows: { readonly l: string; readonly r: string }[] = []
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
  const footer = clip(footerOf(o.snapshot), inner)
  // 框占上下两行，账尾占分隔 + 一行；装不下就先让账尾让位。
  let withFooter = rows.length + 4 <= height
  let budget = height - 2 - (withFooter ? 2 : 0)
  if (budget < 1) {
    withFooter = false
    budget = height - 2
  }

  const shown = rows.length <= budget ? rows : rows.slice(0, Math.max(0, budget - 1))
  const dropped = rows.length - shown.length
  if (dropped > 0) shown.push({ l: `… 还有 ${dropped} 行没印（这一屏 ${height} 行）`, r: '' })

  const lines: string[] = []
  lines.push(`┌${bar(left, '处境')}${two ? `┬${bar(right, '读数')}` : ''}┐`)
  for (const one of shown) {
    lines.push(`│${cell(one.l, left)}${two ? `│${cell(one.r, right)}` : ''}│`)
  }
  if (withFooter) {
    lines.push(`├${'─'.repeat(left)}${two ? `┴${'─'.repeat(right)}` : ''}┤`)
    lines.push(`│${cell(footer, inner)}│`)
  }
  lines.push(`└${'─'.repeat(left)}${two ? `┴${'─'.repeat(right)}` : ''}┘`)
  return { width, height, columns: { left, right }, footer, lines }
}
