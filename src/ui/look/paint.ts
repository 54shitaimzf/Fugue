// 外观草稿（**素材，未接线**）· 行是一串**片**（文字 + 色位），上色是最后一步。
//
// 出处：ROADMAP § 5 的 0.4.3 行 ②（色位）· ④（截断与折叠标记全站一个口径）。
//
// **为什么要从「整行一个角色」走到「片」**：0.2.8 的主题是整行包一层（`term.ts` 先补宽再包裹）。
// 规格 ② 里有两格落不到整行上——截断标记（行尾那个 `…` 弱化，前面的字照旧）与成功/错误
// （「验收过 3 / 没过 1」里只有那两个数该上色）。所以一行拆成片，每片一个色位。
//
// 三条不许破的性质（与 `frame.ts` 那一份同口径）：
//
//   · **先补宽再上色**：`fit` 只看字（`glyph.ts` 那一把尺），`paint` 只加零宽的 SGR——上了色的串
//     不再拿去量列宽（ESC 那几个字节量出来是宽度，量了就错）。
//   · **`off` 档逐字节等于没有色位**：`paint(line, PALETTES.off)` 就是把片的字接起来，一个字节不多。
//   · **三档同形**：哪一档上的色，剥掉 SGR 之后都是 `off` 档那一份（`strip`）——色位只加颜色，
//     不改字、不改宽、不改行数。
import { clip, widthOf, wrap } from '../glyph.ts'
import { STYLE_OFF } from '../term.ts'
import type { Palette, Slot } from './palette.ts'

/** 一片：一段字，一个色位。 */
export interface Span {
  readonly text: string
  readonly slot: Slot
}

/** 一行 = 一串片。 */
export type Line = readonly Span[]

/** 一片（缺省是正文）。 */
export function sp(text: string, slot: Slot = 'body'): Span {
  return { text, slot }
}

/** 一行的字（片接起来，一个字节不改）。 */
export function textOf(line: Line): string {
  return line.map((s) => s.text).join('')
}

/** 一行占几列（量的是字，不是上了色的串）。 */
export function lineWidth(line: Line): number {
  return widthOf(textOf(line))
}

/**
 * **截断标记**（规格 ④）：从 `glyph.ts` 的 `clip` 推出来——一个两列的串截成一列，剩下的就是那个
 * 标记。全站只有这一个字形，草稿不另写一个 `'…'`（第二份就会漂）。
 */
export const ELLIPSIS: string = clip('xx', 1)

/** 全站那个分隔符（`frame.ts` · `stream.ts` · `gate.ts` 里一直是它）。 */
const SEP = ' · '

/**
 * 相邻同色位的片并成一片，空片丢掉。**只动片的边界，不动字**——于是上色时少写几对 SGR，
 * 而 `textOf` 前后逐字节相同。
 */
export function merge(line: Line): Line {
  const out: Span[] = []
  for (const s of line) {
    if (s.text === '') continue
    const last = out[out.length - 1]
    if (last !== undefined && last.slot === s.slot) out[out.length - 1] = { text: last.text + s.text, slot: s.slot }
    else out.push(s)
  }
  return out
}

/** 取一行字的 `[from, to)` 那一段（code unit 偏移），片的色位跟着走。 */
function sliceLine(line: Line, from: number, to: number): Line {
  const out: Span[] = []
  let at = 0
  for (const s of line) {
    const lo = Math.max(from, at)
    const hi = Math.min(to, at + s.text.length)
    if (hi > lo) out.push({ text: s.text.slice(lo - at, hi - at), slot: s.slot })
    at += s.text.length
  }
  return merge(out)
}

/**
 * 补到**正好 `w` 列**：宽了就截（截在簇边界上，末尾留一个 `ELLIPSIS`，它落**弱化**那一格），
 * 窄了补空格。**字与 `frame.ts` 的 `cell` 逐字节相同**（`clip` + 补空格）——变的只是 `…` 自己成了
 * 一片（`paint.test.ts` ① 拿生产那一把尺对着量）。
 */
export function fit(line: Line, w: number): Line {
  if (w <= 0) return []
  const plain = textOf(line)
  const cut = clip(plain, w)
  const out: Span[] = []
  if (cut === plain) out.push(...line)
  else {
    out.push(...sliceLine(line, 0, cut.length - ELLIPSIS.length))
    out.push(sp(ELLIPSIS, 'muted'))
  }
  const pad = w - widthOf(cut)
  if (pad > 0) out.push(sp(' '.repeat(pad)))
  return merge(out)
}

/** 悬挂缩进之后一行至少还要剩几列（不够就不悬挂）。 */
const HANG_ROOM = 12

/**
 * 折行：断点照 `glyph.ts` 的 `wrap` 定（整词 · 退到空格 · 吃掉续行行首的 `· `），片的色位按字在
 * 原行里的位置跟过去。草稿多两件**样子上**的事：
 *
 *   · **续行悬挂缩进**（`hang` 列，加在原行行首的空格上）：边那一行折下去的 `Delegated` 不再顶到
 *     栏的最左边，一眼看得出它是上一行的尾巴；剩下的宽不够 `HANG_ROOM` 列就不悬挂（宁可贴边，也不
 *     挤成一列一字）；
 *   · **断点前那个悬空的 ` ·` 吃掉**：`wrap` 吃的是续行行首的 `· `，断在 `·` 后面时它留在上一行末尾。
 *
 * 吃掉的只有空白与分隔符——字一个不少（`paint.test.ts` ③ 拿「去掉空白与 `·` 之后逐字相同」钉住）。
 */
export function wrapLine(line: Line, w: number, hang = 0): readonly Line[] {
  const plain = textOf(line)
  if (w <= 0 || widthOf(plain) <= w) return [merge(line)]
  const lead = plain.length - plain.trimStart().length
  const indent = hang > 0 && w - lead - hang >= HANG_ROOM ? lead + hang : 0
  const out: Line[] = []
  let at = 0
  let width = w
  for (;;) {
    const rest = plain.slice(at)
    const parts = wrap(rest, width)
    let part = parts[0] as string
    const more = parts.length > 1
    if (more && part.endsWith(' ·')) part = part.slice(0, -2).trimEnd()
    out.push([...(out.length > 0 && indent > 0 ? [sp(' '.repeat(indent))] : []), ...sliceLine(line, at, at + part.length)])
    if (!more) break
    // 续行从哪儿起：与 `wrap` 同一条——先跳过空白（连同被吃掉的那个 ` ·`），再吃一个行首的 `· `。
    at += part.length
    while (at < plain.length && /\s/.test(plain[at] as string)) at += 1
    if (plain.startsWith('· ', at)) at += 2
    width = w - indent
  }
  return out
}

/** 上色：有 SGR 的片包成 `sgr + 字 + 归位`，没有的原样。`off` 档于是就是把字接起来。 */
export function paint(line: Line, palette: Palette): string {
  let out = ''
  for (const s of merge(line)) {
    const sgr = palette[s.slot]
    out += sgr === '' ? s.text : `${sgr}${s.text}${STYLE_OFF}`
  }
  return out
}

/** 剥掉 SGR（测试与「三档同形」那条对照用）。 */
export function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** 「还有 N 条」那一句数的是什么：列表数**条**，正文数**行**。 */
export type FoldUnit = '条' | '行'

/**
 * **折叠标记的唯一写法**（规格 ④）：`… 还有 N 条（提示 · 提示）`。0.2.8 里同一件事有六种说法
 * （`… 还有 N 条（↑↓ 翻，选中第 k 条）` · `… 还有 N 行没印（这一屏 H 行）` · `… 下面还有 N 行
 * （↑↓ 翻 · Esc 收起）` · `  … 还有 N 个节点（…）` · `（还有 N 条在后头）` · `…（还有 N 条，
 * 按 Ctrl-P 看全部）`）——收成一个：标记在前、数在中、怎么看全在括号里，括号里的分隔照全站
 * 用 ` · `。
 */
export function foldText(n: number, unit: FoldUnit, hints: readonly string[] = []): string {
  const how = hints.length > 0 ? `（${hints.join(SEP)}）` : ''
  return `${ELLIPSIS} 还有 ${n} ${unit}${how}`
}

/** 折叠标记那一行：整句落弱化那一格。 */
export function foldNote(n: number, unit: FoldUnit, hints: readonly string[] = []): Line {
  return [sp(foldText(n, unit, hints), 'muted')]
}

/** 几段接成一行，中间是弱化的 ` · `（读数里的分隔是骨架，不是内容）。 */
export function joinLine(parts: readonly Line[]): Line {
  const out: Span[] = []
  parts.forEach((p, i) => {
    if (i > 0) out.push(sp(SEP, 'muted'))
    out.push(...p)
  })
  return merge(out)
}
