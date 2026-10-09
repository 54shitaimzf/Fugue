// 图片能力与纯文字地板。实际像素加载、放置与收起由 preview.test.ts 验。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DEFAULT_GRAPHICS_TIER, IMAGE_EXTENSIONS, graphics, graphicsOf, isImagePath, setGraphics } from './image.ts'
import { facesOf, readStateOf } from './read.ts'
import type { StatusRow } from '../probe/status.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'

test('① 探测那张表：认得的信号给 kitty / sixel，认不出来就是 none', () => {
  assert.equal(DEFAULT_GRAPHICS_TIER, 'none', '缺省是没有（产品路径探一次再定）')
  assert.equal(graphicsOf({ KITTY_WINDOW_ID: '1' }), 'kitty', 'kitty 自己那个信号')
  assert.equal(graphicsOf({ TERM: 'xterm-kitty' }), 'kitty', '`TERM` 里那个后缀')
  assert.equal(graphicsOf({ TERM_PROGRAM: 'ghostty' }), 'kitty', 'ghostty 报的是 kitty 那一套')
  assert.equal(graphicsOf({ TERM: 'mlterm-sixel' }), 'sixel', '`TERM` 里带 sixel')
  assert.equal(graphicsOf({ TERM_PROGRAM: 'WezTerm' }), 'sixel')
  assert.equal(graphicsOf({ TERM: 'xterm-256color' }), 'none', '认不出来就是没有')
  assert.equal(graphicsOf({}), 'none')
  console.log(
    `① 读数：kitty 三条（KITTY_WINDOW_ID · TERM=xterm-kitty · TERM_PROGRAM=ghostty）· ` +
      `sixel 两条（TERM=mlterm-sixel · TERM_PROGRAM=WezTerm）· 其余 none`,
  )
})

test('② 像不像图：后缀那张闭表（大小写不认 · 双层后缀不算）', () => {
  for (const p of ['a.png', 'docs/Shot.PNG', 'x.Jpeg', 'y.gif', 'z.webp', 'w.bmp', 'v.svg']) {
    assert.ok(isImagePath(p), `${p} 该算图`)
  }
  for (const p of ['a.ts', 'notes', 'a.png.txt', 'src/png', 'a.pngx']) {
    assert.ok(!isImagePath(p), `${p} 不该算图`)
  }
  assert.equal(IMAGE_EXTENSIONS.length, 7, `后缀表是 ${IMAGE_EXTENSIONS.length} 条`)
  console.log(`② 读数：认得的后缀 ${IMAGE_EXTENSIONS.join(' ')}（7 条）· 认不出的 5 条全过`)
})

test('③ 能力地板：控制台与复用器优先于继承的 Kitty 变量', () => {
  for (const env of [{ TERM: 'linux', KITTY_WINDOW_ID: '1' }, { TERM: 'screen.xterm', KITTY_WINDOW_ID: '1' },
    { TERM: 'tmux-256color', KITTY_WINDOW_ID: '1' }, { TERM: 'xterm-kitty', TMUX: 'socket' }, { TERM: 'xterm-kitty', STY: 'screen' }]) {
    assert.equal(graphicsOf(env), 'none')
  }
  console.log('③ 控制台/复用器继承 Kitty 信号：5 组均 none')
})

test('④ 退化档 + 接线：档是 none 时阅读面 diff 那一面逐字节与从前相同', () => {
  const ROWS: readonly StatusRow[] = [
    { pos: { writer: 'agent/r1/1', seq: 1 }, e: { t: 'view/write', agent: 'agent/r1/1', path: 'docs/shot.png', rev: 1, blob: 'b1', mode: 0o100644 } },
    { pos: { writer: 'agent/r1/1', seq: 2 }, e: { t: 'view/write', agent: 'agent/r1/1', path: 'src/scroll.ts', rev: 2, blob: 'b2', mode: 0o100644 } },
  ] as unknown as StatusRow[]
  const was = setGraphics('none')
  try {
    const off = facesOf(readStateOf(ROWS)).diff?.lines ?? []
    assert.equal(off.length, 2, `档关着时那一面就是那两行：${off.join(' / ')}`)
    assert.ok(off[0]?.endsWith('写 docs/shot.png') === true, `第 1 行该是那条写入：${String(off[0])}`)
    assert.equal(graphics(), 'none')
    setGraphics('kitty')
    const on = facesOf(readStateOf(ROWS)).diff?.lines ?? []
    assert.deepEqual(on, off, '只有能力没有像素时，纯文字读面逐字节相同；真实预览由 preview.test 按可见请求验')
  } finally {
    setGraphics(was)
  }
  console.log('④ none/kitty 无像素时均2行，文字逐字节相同；不再预先留空位')
})

test('⑤ 全关那一格开关认得它：`ui.images off` 通 · 别的值拒（人不必替终端点 sixel）', () => {
  const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
  const root = tmpDir('fugue-images-')
  const run = (...args: readonly string[]) =>
    spawnSync(process.execPath, [CLI, '--root', root, ...args], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, FUGUE_SYSTEM_DIR: tmpDir('fugue-sys-none-') },
    })
  const off = run('config', 'set', 'ui.images', 'off')
  assert.equal(off.status, 0, `config set ui.images off 该通：${off.stdout}${off.stderr}`)
  const got = run('config', 'get', 'ui.images')
  assert.ok(got.stdout.includes('off'), `读回来该是 off：${got.stdout}`)
  const bad = run('config', 'set', 'ui.images', 'sixel')
  assert.notEqual(bad.status, 0, '只有 auto / off 两个值')
  assert.ok(`${bad.stdout}${bad.stderr}`.includes('auto'), '拒的那一句该把认得的两个值说出来')
  console.log(`⑤ 读数：ui.images=off 写通 · 读回 ${got.stdout.trim()} · 坏值 sixel 退出码 ${bad.status}`)
})


test('没有显式开启图片时，协议能力不会开启图片', async () => {
  const { graphicsFor } = await import('./image.ts')
  const env = { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' }
  assert.equal(graphicsFor(undefined, env), 'none')
  assert.equal(graphicsFor('off', env), 'none')
  assert.equal(graphicsFor('auto', env), 'kitty')
  assert.equal(graphicsFor('bad', env), 'none')
})
