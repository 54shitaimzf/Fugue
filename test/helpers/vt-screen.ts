// 一套最小的终端屏幕模拟器：把 `term.draw` 写出去的字节喂进来，得到**屏幕的真实最后状态**
// （逐行内容 · 硬件光标 · 换行次数 · 滚屏次数）。
//
// 为什么要有它：`ui/term.ts` 那一档的断言问的是"屏幕上最后是什么样"，不是"写了哪些字节"。
// 只看字节串的话，`\x1b[2A` 之后画的内容与不画分不开，而"永久行只写一次""重画只重写变了的那几行"
// 这些主张恰恰要靠屏幕状态才判得动。
//
// **这一份原先在 16 个测试文件里各抄了一遍**（`empty-help-hint` · `empty-menu-hint` ·
// `foreground-reader` · `help-grouping` · `history-space` · `input-caret-row` · `input-invitation` ·
// `input-prefix` · `input-wide-floor` · `menu-acceptance-draft` · `menu-confirmation-return` ·
// `operation-capacity` · `pending-plan-status` · `reader-menu-acceptance` · `reserve-budget` ·
// `term-history`）——同一套 CSI 解析抄十六份，改一处要改十六处。收进这里一处。
//
// 口径：**只认它见过的控制序列**，别的当场 `assert.fail`（认不得的序列不许静默画错，
// 那是这一层最会骗人的一种失败）。
import assert from 'node:assert/strict'
import { clustersOf } from '../../src/ui/glyph.ts'

export interface Screen {
  /** 喂一段字节（`term.draw` 的 `write` 直接接它）。 */
  put(raw: string): void
  /** 屏幕当前的样子：每行 trimEnd 之后的文本。 */
  readonly lines: readonly string[]
  /** 硬件光标。 */
  readonly caret: { readonly row: number; readonly col: number }
  /** 写到最后一列之后被迫换行了几次。 */
  readonly wraps: number
  /** 滚屏了几次。 */
  readonly scrolls: number
}

export function screen(columns: number, rows: number): Screen {
  let cells = Array.from({ length: rows }, () => Array(columns).fill('')), x = 0, y = 0, pending = false, wraps = 0, scrolls = 0
  const down = (): void => { pending = false; if (++y === rows) { cells.shift(); cells.push(Array(columns).fill('')); y--; scrolls++ } }
  const put = (raw: string): void => {
    for (let i = 0; i < raw.length;) {
      const c = raw[i]!
      if (c === '\x1b') {
        const m = /^\x1b\[([\d;]*)([A-Za-z])/.exec(raw.slice(i)); assert.ok(m, 'unhandled terminal control'); i += m[0].length
        const n = Number(m[1]) || 1; pending = false
        if (m[2] === 'A') y = Math.max(0, y - n); else if (m[2] === 'B') y = Math.min(rows - 1, y + n)
        else if (m[2] === 'C') x = Math.min(columns - 1, x + n); else if (m[2] === 'D') x = Math.max(0, x - n)
        else if (m[2] === 'K') cells[y] = Array(columns).fill('')
        else if (m[2] === 'M') { cells.splice(y, n); while (cells.length < rows) cells.push(Array(columns).fill('')) }
        else assert.fail('unhandled CSI ' + m[2])
      } else if (c === '\r') { x = 0; pending = false; i++ }
      else if (c === '\n') { down(); i++ }
      else {
        const stop = raw.slice(i).search(/[\x1b\r\n]/), end = stop < 0 ? raw.length : i + stop
        for (const g of clustersOf(raw.slice(i, end))) {
          if (pending) { down(); x = 0; wraps++ }
          if (g.width > columns - x && x > 0) { down(); x = 0; wraps++ }
          assert.ok(g.width <= columns, 'each fixture glyph fits the host')
          cells[y]![x] = g.text; for (let k = 1; k < g.width; k++) cells[y]![x + k] = ''
          if (x + g.width === columns) { x = columns - 1; pending = true } else x += g.width
        }
        i = end
      }
    }
  }
  return {
    put,
    get lines(): readonly string[] { return cells.map(a => a.join('').trimEnd()) },
    get caret(): { readonly row: number; readonly col: number } { return { row: y, col: x } },
    get wraps(): number { return wraps },
    get scrolls(): number { return scrolls },
  }
}
