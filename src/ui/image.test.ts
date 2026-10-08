// 第二幕 ⑨ 后一半的断言：图片档（探测 + 文件名那一行 + 留白）。
//
//   ① **探测那张表**：认得的信号 → `kitty` / `sixel`；认不出来 → `none`（认不出来就是没有）；
//   ② **像不像图**：后缀那张闭表（大小写不认 · 双层后缀不算）；
//   ③ **留白**：档是 `none` 给空表 · 探到才给（头一行 + 三行空的，头一行里点出文件名）；
//   ④ **退化档 + 接线**：阅读面 diff 那一面上，档是 `none` 时逐字节与从前相同，探到之后只多出那一块。
//
// 负对照（成对）：把 `imageRowsOf` 里"档是 none 就给空表"那道门摘掉 → ④ 当场红，连带
// `read.test.ts` 里那一面那几条也红（缺省那一档的字节流不许变）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DEFAULT_GRAPHICS_TIER, IMAGE_EXTENSIONS, IMAGE_RESERVE_ROWS, graphics, graphicsOf, imageRowsOf, isImagePath, setGraphics } from './image.ts'
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

test('③ 留白：档是 none 给空表，探到才给（头一行 + 三行空的）', () => {
  assert.deepEqual([...imageRowsOf('a.png', 'none')], [], '档关着一个字节都不给')
  assert.deepEqual([...imageRowsOf('a.ts', 'kitty')], [], '不是图就不给（这一档不认识它）')
  const rows = imageRowsOf('docs/shot.png', 'kitty')
  assert.equal(rows.length, IMAGE_RESERVE_ROWS + 1, '头一行 + 留白那几行')
  assert.ok(rows[0]?.includes('shot.png') === true, `头一行该点出文件名：${String(rows[0])}`)
  assert.ok(rows[0]?.includes('kitty') === true, '头一行该说这一台认哪一档')
  assert.deepEqual([...rows.slice(1)], Array.from({ length: IMAGE_RESERVE_ROWS }, () => '  '), '底下那几行是空的')
  console.log(`③ 读数：none→0 行 · 不是图→0 行 · kitty+docs/shot.png→${rows.length} 行（「${String(rows[0]).trim()}」+ ${IMAGE_RESERVE_ROWS} 行留白）`)
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
    assert.equal(on.length, off.length + IMAGE_RESERVE_ROWS + 1, '探到支持时只多出那一块留白')
    assert.equal(on[0], off[0], '文件名那一行照旧（一个字节都没动）')
    assert.ok(on[1]?.includes('shot.png') === true, `留白头一行点的是那份图：${String(on[1])}`)
    assert.deepEqual([...on.slice(2, 2 + IMAGE_RESERVE_ROWS)], Array.from({ length: IMAGE_RESERVE_ROWS }, () => '  '))
    assert.equal(on[2 + IMAGE_RESERVE_ROWS], off[1], '不是图的那一条一个字节都没动')
  } finally {
    setGraphics(was)
  }
  console.log(`④ 读数：none→2 行（逐字节与从前相同）· kitty→${2 + IMAGE_RESERVE_ROWS + 1} 行（多出 1 行说明 + ${IMAGE_RESERVE_ROWS} 行留白）`)
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
