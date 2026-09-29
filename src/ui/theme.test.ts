// U22 · 默认主题：表钉死（恰三个角色）· 两道退回门（--no-style · NO_COLOR）· 退回档的字节流
// 与没有主题那一档逐字节相同。真画出来的字节与屏幕可见内容那一对断言在 `term.test.ts` ⑬
// （那里夹具全：屏幕模拟器 · 拼接读数）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TermOut } from './term.ts'
import { openTerm } from './term.ts'
import { DEFAULT_THEME, themeOf } from './theme.ts'

/** 一个只会记的 sink：写出去的每一笔按次序收着（一帧一笔，U3）。 */
function sinkOf(o: { columns: number }): { written: string[]; out: TermOut } {
  const written: string[] = []
  const out: TermOut = {
    isTTY: true,
    columns: o.columns,
    write(s: string): boolean {
      written.push(s)
      return true
    },
  }
  return { written, out }
}

test('① DEFAULT_THEME：恰 border · footer · overlay 三个角色有值，body 与 read 不在表里', () => {
  assert.deepEqual(
    Object.keys(DEFAULT_THEME).sort(),
    ['border', 'footer', 'overlay'],
    '主题只动"边与弹出"，正文（body · read）缺省不动',
  )
  assert.equal(DEFAULT_THEME.border, '\x1b[2m', '框线：暗一档')
  assert.equal(DEFAULT_THEME.footer, '\x1b[2m', '脚注：暗一档（与框线同一副）')
  assert.equal(DEFAULT_THEME.overlay, '\x1b[1m', '弹层：加粗轻强调')
})

test('② 两道退回门：--no-style 或 NO_COLOR 非空 → 不给主题；NO_COLOR 空串与没设一样', () => {
  assert.equal(themeOf(), DEFAULT_THEME, '两道门都没开：默认那一档')
  assert.equal(themeOf({ noStyle: false }), DEFAULT_THEME, 'noStyle 没开不算')
  assert.equal(themeOf({ noStyle: true }), undefined, '--no-style：退回')
  assert.equal(themeOf({ noColor: '1' }), undefined, 'NO_COLOR 非空：退回（no-color.org）')
  assert.equal(themeOf({ noColor: '' }), DEFAULT_THEME, 'NO_COLOR 空串：算没喊')
  assert.equal(themeOf({ noColor: undefined }), DEFAULT_THEME, 'NO_COLOR 未设：算没喊')
  assert.equal(themeOf({ noStyle: true, noColor: '' }), undefined, '两道门一起：还是退回')
})

test('③ 退回档的字节流与没有主题那一档逐字节相同（themeOf 的答案原样递给 openTerm）', () => {
  // 同一帧画三遍：不给 theme（U20 的缺省）· `--no-style` 那一档 · `NO_COLOR=1` 那一档。
  // 后两档的字节流与第一份逐字节相同——退回是"一个字节都不多"，不是"另写一份"。
  const drawOnce = (theme: Parameters<typeof openTerm>[0]['theme']): string => {
    const { written, out } = sinkOf({ columns: 40 })
    openTerm({ out, height: 4, term: 'xterm-256color', theme }).draw([], () => ({
      rows: ['┌──┐', '│正文│', '└──┘'],
      roles: ['border', 'body', 'border'],
    }))
    return written.join('')
  }
  const plain = drawOnce(undefined)
  assert.notEqual(plain, '', '夹具那一帧得真写出东西来')
  assert.equal(drawOnce(themeOf({ noStyle: true })), plain, '--no-style 档逐字节相同')
  assert.equal(drawOnce(themeOf({ noColor: '1' })), plain, 'NO_COLOR 档逐字节相同')
  assert.equal(drawOnce(themeOf()), drawOnce(DEFAULT_THEME), '默认档与手递 DEFAULT_THEME 是同一份')
  // 对照：默认档与无主题档**有**差别（恰是角色包裹——⑬ 逐段钉）。
  assert.notEqual(drawOnce(themeOf()), plain, '默认档该有差别（差在角色包裹，不是别的）')
  console.log(
    `③ 读数：退回档与无主题档逐字节相同（${plain.length} 字节）· 默认档多出 ${
      drawOnce(themeOf()).length - plain.length
    } 字节（上下框线两行各一对 SGR）`,
  )
})
