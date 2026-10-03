// 外观草稿 · 三样探测（ROADMAP § 5 的 0.4.3 行 ①⑤）：判据是纯函数，所以「这台终端落哪一档」
// 不用真终端就量得出。
//
//   ① 上色那一档：两道门（复用生产的 `themeOf`）· 写不写 ANSI（复用 `ansiOf`）· 认得 256 色才上色，
//      Linux 字符控制台照规格落黑白档；
//   ② 图标那一档：只认配置开关恰好是 `nerd`，`--no-style` 退回 ASCII；
//   ③ 图片那一档：从回话原文判——kitty 回 OK 才给 kitty，DA1 里有 `4` 才给 sixel，不写 ANSI 与
//      `--no-style` 一律不给。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { themeOf } from '../theme.ts'
import { ansiOf } from '../term.ts'
import { COLORTERM_DEEP, DA1_QUERY, KITTY_QUERY, TERM_256_PREFIX, colorTierOf, iconTierOf, imageTierOf, knows256 } from './tier.ts'

test('① 上色那一档：门 → off · 认不出 → off · 认得 256 → 256 · 其余 → 黑白（控制台在这里）', () => {
  const tty = { isTTY: true }
  const cases: readonly (readonly [string, Parameters<typeof colorTierOf>[0], string])[] = [
    ['--no-style', { ...tty, term: 'xterm-256color', noStyle: true }, 'off'],
    ['NO_COLOR=1', { ...tty, term: 'xterm-256color', noColor: '1' }, 'off'],
    ['NO_COLOR 空串不算喊', { ...tty, term: 'xterm-256color', noColor: '' }, '256'],
    ['不是 TTY', { isTTY: false, term: 'xterm-256color' }, 'off'],
    ['TERM=dumb', { ...tty, term: 'dumb' }, 'off'],
    ['TERM 认不出', { ...tty, term: 'wat-256color' }, 'off'],
    ['TERM 没设', { ...tty }, 'off'],
    ['xterm', { ...tty, term: 'xterm' }, 'mono'],
    ['linux（字符控制台）', { ...tty, term: 'linux' }, 'mono'],
    ['vt100', { ...tty, term: 'vt100' }, 'mono'],
    ['screen', { ...tty, term: 'screen' }, 'mono'],
    ['COLORTERM=yes 不算', { ...tty, term: 'xterm', colorTerm: 'yes' }, 'mono'],
    ['xterm-256color', { ...tty, term: 'xterm-256color' }, '256'],
    ['screen-256color-bce', { ...tty, term: 'screen-256color-bce' }, '256'],
    ['tmux-256color', { ...tty, term: 'tmux-256color' }, '256'],
    ['xterm-direct', { ...tty, term: 'xterm-direct' }, '256'],
    ['rxvt-unicode-256color', { ...tty, term: 'rxvt-unicode-256color' }, '256'],
    ['COLORTERM=truecolor', { ...tty, term: 'xterm', colorTerm: 'truecolor' }, '256'],
    ['COLORTERM=24BIT（大小写）', { ...tty, term: 'linux', colorTerm: '24BIT' }, '256'],
    ['xterm-kitty', { ...tty, term: 'xterm-kitty' }, '256'],
    ['alacritty', { ...tty, term: 'alacritty' }, '256'],
    ['foot-extra', { ...tty, term: 'foot-extra' }, '256'],
  ]
  for (const [why, env, want] of cases) assert.equal(colorTierOf(env), want, why)
  // 门只有一份：凡是 TTY 且 `$TERM` 认得的场合，「落 off」与「生产的 `themeOf` 不给主题」是同一件事。
  for (const noStyle of [undefined, false, true]) {
    for (const noColor of [undefined, '', '1', 'yes']) {
      const gated = themeOf({ noStyle, noColor }) === undefined
      assert.equal(colorTierOf({ ...tty, term: 'xterm-256color', noStyle, noColor }) === 'off', gated, `门：${noStyle}/${noColor}`)
    }
  }
  // 表与表对得上：认得 256 色的每一个前缀，`KNOWN_TERM` 也得认（不然它落 off，永远上不了色）。
  for (const p of TERM_256_PREFIX) {
    assert.equal(ansiOf(p), true, `${p} 在 256 色表里却不在 KNOWN_TERM 里`)
    assert.equal(colorTierOf({ ...tty, term: p }), '256', `${p} 该落 256 档`)
  }
  for (const c of COLORTERM_DEEP) assert.equal(colorTierOf({ ...tty, term: 'xterm', colorTerm: c }), '256', `COLORTERM=${c}`)
  assert.equal(knows256('xterm-256colour', undefined), true, '英式拼法也认')
  assert.equal(knows256('xterm-256colorful', undefined), false, '后缀要落在词界上')
  console.log(`① 读数：${cases.length} 种环境 · 门与生产 themeOf 逐格一致（12 种组合）`)
})

test('② 图标那一档：配置恰好是 nerd 才给，--no-style 退回 ASCII，NO_COLOR 不管字形', () => {
  assert.equal(iconTierOf({ icons: 'nerd' }), 'nerd')
  for (const v of [undefined, '', 'Nerd', 'yes', 'ascii', 'nerdfont']) assert.equal(iconTierOf({ icons: v }), 'ascii', `${v}`)
  assert.equal(iconTierOf({ icons: 'nerd', noStyle: true }), 'ascii', '--no-style 是「全无样式」，专有字形也算样式')
  assert.equal(iconTierOf({}), 'ascii', '没配就是地板')
  console.log('② 读数：只有 icons=nerd 给 Nerd 字形，其余 6 种值与 --no-style 都是 ASCII')
})

test('③ 图片那一档：kitty 回 OK → kitty · DA1 有 4 → sixel · 其余与不写 ANSI · --no-style → none', () => {
  const OK = '\x1b_Gi=31;OK\x1b\\'
  const cases: readonly (readonly [string, Parameters<typeof imageTierOf>[0], string])[] = [
    ['kitty 回 OK', { ansi: true, kittyReply: OK, da1: '\x1b[?62;22c' }, 'kitty'],
    ['kitty 回错', { ansi: true, kittyReply: '\x1b_Gi=31;ENOTSUPPORTED:no\x1b\\', da1: '\x1b[?62;22c' }, 'none'],
    ['两样都认：kitty 优先', { ansi: true, kittyReply: OK, da1: '\x1b[?62;4;22c' }, 'kitty'],
    ['DA1 有 4', { ansi: true, kittyReply: null, da1: '\x1b[?62;4;22c' }, 'sixel'],
    ['DA1 首位是 4 的变体（64;4）', { ansi: true, da1: '\x1b[?64;4c' }, 'sixel'],
    ['DA1 里只有 14（不是 4）', { ansi: true, da1: '\x1b[?62;14c' }, 'none'],
    ['DA1 没有 4', { ansi: true, da1: '\x1b[?1;2c' }, 'none'],
    ['什么都没回', { ansi: true }, 'none'],
    ['不写 ANSI 那一档', { ansi: false, kittyReply: OK, da1: '\x1b[?62;4c' }, 'none'],
    ['--no-style', { ansi: true, noStyle: true, kittyReply: OK }, 'none'],
  ]
  for (const [why, o, want] of cases) assert.equal(imageTierOf(o), want, why)
  // 问与答对得上：查询里的图号就是认回话时找的那个号；DA1 那条就是 `ESC [ c`。
  const id = /i=(\d+)/.exec(KITTY_QUERY)?.[1]
  assert.match(KITTY_QUERY, /^\x1b_G.*a=q.*\x1b\\$/, 'kitty 那条是只查询不显示（a=q）的图形命令')
  assert.equal(imageTierOf({ ansi: true, kittyReply: `\x1b_Gi=${id};OK\x1b\\` }), 'kitty', `查询的图号 ${id} 与认回话的图号要一致`)
  assert.equal(DA1_QUERY, '\x1b[c')
  console.log(`③ 读数：${cases.length} 种回话 · 判出 kitty ${cases.filter((c) => c[2] === 'kitty').length} · sixel ${cases.filter((c) => c[2] === 'sixel').length} · 其余不给`)
})
