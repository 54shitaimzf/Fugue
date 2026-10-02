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

test('① DEFAULT_THEME：四个角色有值，body 与 read 不在表里；两族名单从这张表推', () => {
  assert.deepEqual(
    Object.keys(DEFAULT_THEME).sort(),
    ['border', 'footer', 'overlay', 'readHeading'],
    '主题只动"边与弹出"与阅读面那个框名，正文（body · read）缺省不动',
  )
  assert.equal(DEFAULT_THEME.border, '\x1b[2m', '框线：暗一档')
  // **两族名单从这张表推**（交接单判决 2：手抄一遍角色名，表动的时候测试不跟动，漂移不报错）。
  const byValue = (v: string): string[] =>
    Object.entries(DEFAULT_THEME).filter(([, got]) => got === v).map(([role]) => role).sort()
  assert.deepEqual(byValue('\x1b[2m'), ['border'], '只有框线暗一档')
  assert.deepEqual(byValue('\x1b[1m'), ['footer', 'overlay', 'readHeading'], '账尾改粗（U3）· 弹层 · 阅读面框名')
  assert.equal(
    byValue('\x1b[2m').length + byValue('\x1b[1m').length,
    Object.keys(DEFAULT_THEME).length,
    '表里只有这两族值——颜色属于后续的纪元（0.2.8 是黑白属性之内）',
  )
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

test('③ 退回档的字节流与没有主题那一档逐字节相同（四族角色全在场 · themeOf 的答案原样递给 openTerm）', () => {
  // 同一帧画三遍：不给 theme（U20 的缺省）· `--no-style` 那一档 · `NO_COLOR=1` 那一档。
  // 后两档的字节流与第一份逐字节相同——退回是"一个字节都不多"，不是"另写一份"。
  // **四族角色全在场**（U3 之后是 border · footer · overlay · readHeading）：少一族在场，这条对照
  // 就量不到那一族的退回，是句空话。
  const rows = ['┌────────────────────────────────────┐', '│阅读面 · 框名那一行│', '│阅读面正文│', '├────────────────────────────────────┤', '│账尾│', '│候选│', '└────────────────────────────────────┘']
  const roles = ['readHeading', 'read', 'body', 'border', 'footer', 'overlay', 'border']
  const themedRoles = Object.keys(DEFAULT_THEME) as readonly string[]
  for (const role of themedRoles) assert.ok(roles.includes(role), `这一帧里要有 ${role}（四族齐了才量得动退回）`)
  const drawOnce = (theme: Parameters<typeof openTerm>[0]['theme']): string => {
    const { written, out } = sinkOf({ columns: 40 })
    openTerm({ out, height: rows.length, term: 'xterm-256color', theme }).draw([], () => ({ rows, roles }))
    return written.join('')
  }
  const plain = drawOnce(undefined)
  assert.notEqual(plain, '', '夹具那一帧得真写出东西来')
  assert.equal(drawOnce(themeOf({ noStyle: true })), plain, '--no-style 档逐字节相同')
  assert.equal(drawOnce(themeOf({ noColor: '1' })), plain, 'NO_COLOR 档逐字节相同')
  assert.equal(drawOnce(themeOf()), drawOnce(DEFAULT_THEME), '默认档与手递 DEFAULT_THEME 是同一份')
  // 对照：默认档与无主题档**有**差别（恰是角色包裹——⑬ 逐段钉）。
  assert.notEqual(drawOnce(themeOf()), plain, '默认档该有差别（差在角色包裹，不是别的）')
  // **两族 SGR 与角色数逐对**：多一对少一对都在这里现形（四族角色各一行，所以次数 = 角色数）。
  const themed = drawOnce(themeOf())
  const byValue = (v: string): string[] =>
    Object.entries(DEFAULT_THEME).filter(([, got]) => got === v).map(([role]) => role)
  for (const [sgr, value] of [['\\x1b[2m', '\x1b[2m'], ['\\x1b[1m', '\x1b[1m']] as const) {
    const want = roles.filter((r) => byValue(value).includes(r)).length
    assert.ok(want > 0, `${sgr} 那一族要在场`)
    assert.equal(themed.split(value).length - 1, want, `${sgr} 恰那一族那么多次（该 ${want}）`)
  }
  console.log(
    `③ 读数：退回档（--no-style · NO_COLOR）与无主题档逐字节相同（${plain.length} 字节）· 默认档多出 ${
      themed.length - plain.length
    } 字节（全是 SGR 对 · ${themedRoles.length} 族角色全在场）`,
  )
})
