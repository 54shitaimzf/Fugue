// 第二套终端模拟器：**带真滚动历史的那一份**（首个 `put` 之前屏幕上已经有两行 shell 提示，
// 光标不在"想象的底部"）。原先在 `history-space` 与 `reserve-budget` 两个测试文件里各抄了一遍，
// 正文逐字相同（指纹 68674871ee · 1362 字节 · 19 行）。
//
// 与 `vt-screen.ts` 的区别（两份不是一个模型，别互相顶替）：
//   · 它按**格**存（`Array(columns)` 一行的 cell），这一份按**整行字符串**存，滚屏时把挤出去
//     的那一行推进 `history`——所以 `all` 拿得到"已经滚上去的那些行"；
//   · 它数**被迫折行**（`wraps`），这一份压根不许折行：`assert.ok(x < columns)`，超了当场红；
//   · 它认字形簇（`clustersOf`，宽字形占两格），这一份一个 code unit 一格；
//   · 它 `caret` 给 `{row,col}`，这一份给 `[x,y]`。
import assert from 'node:assert/strict'

export interface ScrollbackScreen {
  /** 喂一段字节（`term.draw` 的 `write` 直接接它）。 */
  put(raw: string): void
  /** 屏幕上的全部内容：已经滚上去的 + 现在可见的。 */
  readonly all: readonly string[]
  /** 现在这一屏。 */
  readonly visible: readonly string[]
  /** 光标，`[x, y]`。 */
  readonly caret: readonly [number, number]
  /** 滚屏了几次。 */
  readonly scrolls: number
}

// 说明留在正文里（两处原先各写一遍的那几句）：
//   · 初始光标在两行既有 shell 提示之后，不在一个想象出来的空底；
//   · 这一份只认这一格用得上的那几个输出控制序列，认不得的当场 `assert.fail`——
//     静默画错是这一层最会骗人的一种失败。
export function screen(columns = 40, rows = 24): ScrollbackScreen {
  let lines = Array.from({ length: rows }, () => ''), history: string[] = [], x = 0, y = 0, scrolls = 0
  const put = (raw: string): void => {
    for (let i = 0; i < raw.length;) {
      const c = raw[i++]!
      if (c === '\x1b') {
        const m = /^\[([\d;]*)([A-Za-z])/.exec(raw.slice(i)); assert.ok(m, 'unhandled control'); i += m[0].length; const n = Number(m[1]) || 1
        if (m[2] === 'A') y = Math.max(0, y - n); else if (m[2] === 'B') y = Math.min(rows - 1, y + n); else if (m[2] === 'C') x = Math.min(columns - 1, x + n); else if (m[2] === 'D') x = Math.max(0, x - n)
        else if (m[2] === 'K') lines[y] = ''; else if (m[2] === 'M') { lines.splice(y, n); while (lines.length < rows) lines.push('') }
        else assert.fail('unhandled CSI ' + m[2])
      } else if (c === '\r') x = 0
      else if (c === '\n') { if (++y === rows) { history.push(lines.shift()!); lines.push(''); y = rows - 1; scrolls++ } }
      else { assert.ok(x < columns, 'fixture must not wrap'); const s = lines[y]!; lines[y] = s.slice(0, x).padEnd(x, ' ') + c + s.slice(x + 1); x++ }
    }
  }
  put('SHELL0\r\nSHELL1\r\n')
  return { put, get all(): readonly string[] { return [...history, ...lines].map(s => s.trimEnd()) }, get visible(): readonly string[] { return lines.map(s => s.trimEnd()) }, get caret(): readonly [number, number] { return [x, y] }, get scrolls(): number { return scrolls } }
}
