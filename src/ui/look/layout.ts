// 外观草稿（**素材，未接线**）· 布局与留白：参数一张表，框一个画法。
//
// 出处：ROADMAP § 5 的 0.4.3 行 ③「框线内侧一列空气 · 三块分隔线细一档 · 账尾与提示行之间空一行
// ——布局参数收进一处常量表」。
//
// **这一份只排版、不上色**：出来的每一行是一串片（`paint.ts` 的 `Line`），每行**正好 `width` 列**；
// 上哪一档的色是调用方最后一步的事（`paint`）。于是三档共用一份几何——「三档同形」在这里是
// 构造出来的，不是测出来碰巧对上的。
//
// **两种线，两种意思**：实线 `─`（框线那一档）画**框的结构**——外框 · 栏与栏 · 账尾那一截；
// 细线 `┈`（细一档）只画**一栏里块与块的界**（树 · 流水 · 阅读面），而且缩在空气那一列里面，
// 不碰两边的竖线。看一眼就分得出「这是另一格框」还是「同一栏的下一块」。
//
// 与 `frame.ts` 的分工：那一份管**装什么**（读哪几样 · 怎么分两栏 · 谁先让位），这一份是 0.4.3 要
// 换上去的**样子**。草稿不重写那一份的预算逻辑，只带一个够用的：装不下先让提示行，再让弹层的
// 预览（末 `wideKeep` 行留住），最后每栏按行截、末行说还有几行。
import { widthOf } from '../glyph.ts'
import { MIN_HEIGHT } from '../frame.ts'
import type { Line, Span } from './paint.ts'
import { fit, foldNote, lineWidth, sp, wrapLine } from './paint.ts'

/** 布局参数（规格 ③ 要的那一张表）。改样子先改这里；别处不许再出现一个写死的留白数。 */
export const LAYOUT = {
  /** 框线内侧一列空气（左右各一列）。 */
  padX: 1,
  /** 折下去的续行比首行多缩几列（`paint.ts` 的 `wrapLine`）。 */
  hang: 2,
  /** 账尾与提示行之间空一行。 */
  hintGap: 1,
  /** 两栏时左栏（处境）占可用宽的份额——与 `frame.ts` U10c 同一个分法（读数那一栏拿大头）。 */
  leftShare: 2 / 5,
  /** 两栏最窄：左 24 · 右 20 · 三根竖线 · 四列空气。 */
  minTwo: 24 + 20 + 3 + 4,
  /** 画得出框最窄：两根竖线 · 两列空气 · 一列字。 */
  minWidth: 5,
  /** 画得出框最矮：与 `frame.ts` 同一个数（上下两条边 · 一行内容 · 一条分隔 · 一行账尾）。 */
  minHeight: MIN_HEIGHT,
} as const

/** 框线字形。**全取 CP437 里也有的那一套**（Linux 字符控制台的缺省字体认得），细线那一格除外。 */
export const BOX = {
  h: '─',
  v: '│',
  tl: '┌',
  tr: '┐',
  bl: '└',
  br: '┘',
  lj: '├',
  rj: '┤',
  tj: '┬',
  bj: '┴',
  /** 细一档：块与块之间。 */
  thin: '┈',
} as const

/** 一栏：框名 + 几块（块与块之间一条细线）。 */
export interface Column {
  readonly name: string
  /** 框名落标题那一格（阅读面开着时）；不给就是正文那一格。 */
  readonly heading?: boolean
  readonly blocks: readonly (readonly Line[])[]
  /** 这一栏装不下、末行换成折叠标记时括号里说什么（不给就是「这一屏 H 行」）。 */
  readonly fold?: readonly string[]
}

/** 账尾：状态标记（一片，成功 · 等待 · 错误三格之一）+ 正文 + 靠右的弱化尾巴（条数那类）。 */
export interface FooterInput {
  readonly mark: Span | null
  readonly text: Line
  readonly tail?: Line
}

export interface LookInput {
  /** 一栏或两栏。两栏放不下（`LAYOUT.minTwo`）就收成一栏：第二栏的块接在第一栏后面。 */
  readonly columns: readonly Column[]
  /** 横贯整栏的那一块（候选 · 门口那一块）：临时的一层，排在栏的下面、账尾的上面。 */
  readonly wide?: readonly Line[]
  /** 那一块装不下时末几行留住（人要按 · 要看的那几行）。 */
  readonly wideKeep?: number
  readonly footer: FooterInput
  /** 提示行（按键那一句）：画在框外，与账尾隔 `LAYOUT.hintGap` 行。 */
  readonly hint?: Line
  readonly width: number
  /** 不给就不限高（预览那一档）。 */
  readonly height?: number
}

type Row = { readonly line: Line } | 'rule'

const muted = (s: string): Span => sp(s, 'muted')
const air = (): Span => sp(' '.repeat(LAYOUT.padX))

/** 一栏的行：块按次序，块间一条细线；每行先折进这一栏的字宽。 */
function rowsOf(blocks: readonly (readonly Line[])[], w: number): Row[] {
  const out: Row[] = []
  for (const b of blocks) {
    if (b.length === 0) continue
    if (out.length > 0) out.push('rule')
    for (const l of b) for (const one of wrapLine(l, w, LAYOUT.hang)) out.push({ line: one })
  }
  return out
}

/** 截到 `n` 行：装不下时末行换成折叠标记（被它顶掉的那一行也算进 N——0.2.8 U3 那一条）。 */
function capRows(rows: readonly Row[], n: number, hints: readonly string[]): Row[] {
  if (rows.length <= n) return [...rows]
  const keep = rows.slice(0, Math.max(0, n - 1))
  return [...keep, { line: foldNote(rows.length - keep.length, '行', hints) }]
}

/** 框名那一截：`─ 名字 ───`，装不下名字就只剩线。 */
function barOf(w: number, name: string, heading: boolean): Span[] {
  if (widthOf(name) + 3 > w) return [muted(BOX.h.repeat(Math.max(0, w)))]
  return [muted(`${BOX.h} `), sp(name, heading ? 'heading' : 'body'), muted(` ${BOX.h.repeat(w - widthOf(name) - 3)}`)]
}

/** 一格字（含两侧空气）：`fit` 补到正好 `w` 列；细线那一行缩在空气里面。 */
function cellOf(row: Row | undefined, w: number): Span[] {
  const body = row === undefined ? [] : row === 'rule' ? [muted(BOX.thin.repeat(w))] : row.line
  return [air(), ...fit(body, w), air()]
}

/** 账尾那一行的字（不含框线与空气）：标记 · 正文，尾巴放得下才靠右放（先让位的是尾巴）。 */
function footerLineOf(f: FooterInput, w: number): Line {
  const head: Span[] = f.mark === null ? [...f.text] : [f.mark, sp(' '), ...f.text]
  const tail = f.tail ?? []
  const gap = w - lineWidth(head) - lineWidth(tail)
  if (tail.length > 0 && gap >= 2) return fit([...head, sp(' '.repeat(gap)), ...tail], w)
  return fit(head, w)
}

/**
 * 一帧的样子。**纯**：进去的那几样决定出来的那几行。每一行正好 `width` 列（`look.test.ts` 逐档量）。
 * 窄到画不出框 · 矮到画不出框与账尾，都说一句为什么（与 `frame.ts` 同一条：不给静默的空帧）。
 */
export function lookOf(o: LookInput): readonly Line[] {
  const W = o.width
  if (W <= 0) return []
  if (W < LAYOUT.minWidth) return [fit([sp(`（这一屏太窄：要 ${LAYOUT.minWidth} 列以上才画得出框，拿到的是 ${W} 列）`)], W)]
  const H = o.height ?? Number.POSITIVE_INFINITY
  if (H < LAYOUT.minHeight) {
    return [fit([sp(`（这一屏太矮：要 ${LAYOUT.minHeight} 行以上才画得出框与账尾，拿到的是 ${H} 行）`)], W)]
  }

  const pad = 2 * LAYOUT.padX
  const two = o.columns.length === 2 && W >= LAYOUT.minTwo
  const avail = two ? W - 3 - 2 * pad : W - 2 - pad
  const lw = two ? Math.floor(avail * LAYOUT.leftShare) : avail
  const rw = two ? avail - lw : 0
  const first = o.columns[0] ?? { name: '', blocks: [] }
  const second = o.columns[1]
  const left = rowsOf(two || second === undefined ? first.blocks : [...first.blocks, ...second.blocks], lw)
  const right = two && second !== undefined ? rowsOf(second.blocks, rw) : []

  // 预算：框四行（上边 · 账尾分隔 · 账尾 · 下边）是死的；提示行先让，弹层的预览再让，栏最后截。
  let hintRows = o.hint === undefined ? 0 : LAYOUT.hintGap + 1
  let wide = [...(o.wide ?? [])]
  const keep = Math.max(0, Math.min(o.wideKeep ?? 0, wide.length))
  const need = Math.max(1, left.length, right.length)
  const spare = (): number => H - 4 - hintRows - (wide.length > 0 ? wide.length + 1 : 0)
  if (spare() < need) hintRows = 0
  while (spare() < Math.min(need, 2) && wide.length > keep) wide = wide.slice(1)
  if (spare() < 1) wide = []
  const bodyRows = Math.min(need, Math.max(1, spare()))
  const screen = [`这一屏 ${H} 行`]
  const l = capRows(left, bodyRows, first.fold ?? screen)
  const r = capRows(right, bodyRows, second?.fold ?? screen)

  const lines: Line[] = []
  const v = muted(BOX.v)
  lines.push([
    muted(BOX.tl),
    ...barOf(lw + pad, first.name, first.heading === true),
    ...(two && second !== undefined ? [muted(BOX.tj), ...barOf(rw + pad, second.name, second.heading === true)] : []),
    muted(BOX.tr),
  ])
  for (let i = 0; i < bodyRows; i += 1) {
    lines.push(two ? [v, ...cellOf(l[i], lw), v, ...cellOf(r[i], rw), v] : [v, ...cellOf(l[i], lw), v])
  }
  // 栏到此为止：两栏那一档在这里把中间那根竖线收住（`┴`）——下面那几截都是横贯整栏的。
  const across = BOX.lj + BOX.h.repeat(W - 2) + BOX.rj
  lines.push([muted(two ? BOX.lj + BOX.h.repeat(lw + pad) + BOX.bj + BOX.h.repeat(rw + pad) + BOX.rj : across)])
  if (wide.length > 0) {
    // 横贯整栏的那一块只截不折（与 `frame.ts` 同：门口那几行由 `gate.ts` 按宽先折好）。
    for (const one of wide) lines.push([v, air(), ...fit(one, W - 2 - pad), air(), v])
    lines.push([muted(across)])
  }
  lines.push([v, air(), ...footerLineOf(o.footer, W - 2 - pad), air(), v])
  lines.push([muted(BOX.bl + BOX.h.repeat(W - 2) + BOX.br)])
  if (hintRows > 0 && o.hint !== undefined) {
    for (let i = 0; i < LAYOUT.hintGap; i += 1) lines.push([sp(' '.repeat(W))])
    lines.push(fit([sp(' '.repeat(1 + LAYOUT.padX)), ...o.hint], W))
  }
  return lines
}
