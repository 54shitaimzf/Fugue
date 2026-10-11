// 内核控制台：标准前景色 + 粗体亮色；退回路径和多帧都量字节。
import assert from 'node:assert/strict'
import test from 'node:test'
import { themeOf, DEFAULT_THEME, tierOf, SLOT_16, SLOTS, ROLE_SLOT, theme16 } from './theme.ts'
import { openTerm, CLEAR_LINE } from './term.ts'

test('linux 使用 16 色：继承的 COLORTERM 不能把控制台提升到 256 色', () => {
  assert.deepEqual(Object.keys(SLOT_16).sort(), [...SLOTS].sort(), '16色也完整覆盖八格')
  const theme = theme16()
  for (const [role, slot] of Object.entries(ROLE_SLOT)) assert.equal(theme[role], role === 'modelHeading' ? '\x1b[1m' : SLOT_16[slot] || undefined)
  for (const colorTerm of [undefined, '', 'truecolor', '256']) {
    const theme = themeOf({ term: 'linux', colorTerm })
    assert.equal(tierOf({ term: 'linux', colorTerm }), 2)
    assert.equal(theme?.waiting, '\x1b[1;33m', '等待用标准黄和粗体，控制台不发 38;5')
    assert.equal(theme?.ok, '\x1b[32m')
    assert.equal(theme?.refuse, '\x1b[1;31m')
    assert.equal(theme?.readHeading, '\x1b[1;36m')
    for (const s of Object.values(theme ?? {})) assert.match(s, /^\x1b\[(?:[012];?)*3?[0-7]?m$|^\x1b\[[12]m$/)
    assert.ok(!Object.values(theme ?? {}).some(s => s.includes('38;') || s.includes('48;')))
  }
  assert.equal(themeOf({ term: 'unknown' }), DEFAULT_THEME, '能力不明仍回黑白属性')
})

test('控制台两道全关门、无 TTY 都无 SGR，状态多帧改一行且未变帧零清行', () => {
  const draw = (theme: Parameters<typeof openTerm>[0]['theme'], tty = true) => {
    const chunks: string[] = []
    const term = openTerm({ out: { isTTY: tty, columns: 40, rows: 24, write: s => chunks.push(s) }, term: 'linux', theme, height: 5 })
    term.draw(['历史原文'], () => ({ rows: ['等待确认', '', '', '', ''], roles: ['waiting', 'body', 'body', 'body', 'body'] }))
    return { chunks, term }
  }
  const plain = draw(undefined).chunks.join('')
  for (const o of [{ noStyle: true }, { noColor: '1' }]) {
    const raw = draw(themeOf({ term: 'linux', ...o })).chunks.join('')
    assert.equal(raw, plain)
    assert.ok(!/\x1b\[[\d;]*m/.test(raw))
  }
  const pipe = draw(themeOf({ term: 'linux' }), false).chunks.join('')
  assert.equal(pipe, '历史原文\n', '管道只印永久原文，不发任何控制序列')
  const { chunks, term } = draw(themeOf({ term: 'linux' }))
  assert.ok(chunks[0]?.includes('\x1b[1;33m'))
  for (const [role, text, color] of [['ok', '已完成', '\x1b[32m'], ['refuse', '出错', '\x1b[1;31m']] as const) {
    const panel = () => ({ rows: [text, '', '', '', ''], roles: [role, 'body', 'body', 'body', 'body'] })
    term.draw([], panel)
    assert.ok(chunks.at(-1)?.includes(color))
    assert.equal(chunks.at(-1)!.split(CLEAR_LINE).length - 1, 1)
    term.draw([], panel)
    assert.equal(chunks.at(-1)!.split(CLEAR_LINE).length - 1, 0)
  }
  term.close()
  console.log('16色多帧：waiting→ok→refuse · 每次清行1 · 未变帧清行0 · no-style/NO_COLOR逐字节同无主题 · 管道ANSI=0')
})
