// 界面那三档（字形 · 图标 · 图片）的地板：`ui/console.ts` 的 `uiTiersOf`。
//
// **为什么单独立一条**：那一块原先内联在 `tuiCmd` 里，注释写着"读不出配置不是退出的理由"，而代码
// 里没有那一道 `catch`——配置一坏 `fugue tui` 直接起不来。断言「坏配置下这三档退到 `DEFAULT_*` 且
// `why` 非空」抓得住那一类"说好的地板没接上"。
//
// 负对照（红得起来才是断言）：
//   ① 配置好 → 三档从配置来、`why` 是 null——**把 `getConfig` 那三行去掉，这一条当场红**；
//   ② 配置坏 → 三档退到 `DEFAULT_*`、`why` 说得出为什么——**把 `try/catch` 摘掉，这一条当场抛**；
//   ③ 值超出值域（`ui.glyphs: "huge"` 这种）→ 与坏 JSON 同一条地板（值域由 `config.ts` 核）。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { configFileOf } from '../config.ts'
import { DEFAULT_GLYPH_TIER } from './glyph.ts'
import { DEFAULT_ICON_TIER } from './icons.ts'
import { DEFAULT_GRAPHICS_TIER } from './image.ts'
import { uiTiersOf } from './console.ts'

// 系统那一级指到临时目录（与 `ui/gate-setup.test.ts` 同一条：读数不取决于这台机器上有没有人配过）。
process.env.FUGUE_SYSTEM_DIR = tmpDir('fugue-ui-tiers-sys-')

async function rootWith(text: string): Promise<string> {
  const root = tmpDir('fugue-ui-tiers-')
  await mkdir(join(root, '.fugue'), { recursive: true })
  await writeFile(configFileOf(root), text, 'utf8')
  return root
}

test('① 配置好：三档从配置来 · why 是 null（负对照：`getConfig` 那三行丢了就红）', async () => {
  const root = await rootWith(JSON.stringify({ ui: { glyphs: 'ascii', icons: 'nerd' } }))
  const t = await uiTiersOf(root)
  assert.equal(t.glyph, 'ascii', '字形档从配置来')
  assert.equal(t.icon, 'nerd', '图标档从配置来')
  assert.equal(t.graphics, DEFAULT_GRAPHICS_TIER, '没点名的那一档按缺省')
  assert.equal(t.why, null, '读得出 ⇒ 不说那句话')
})

test('② 配置坏：三档退到缺省、why 说得出为什么（负对照：摘掉 `try/catch` 当场抛）', async () => {
  const root = await rootWith('{ 这不是 JSON')
  const t = await uiTiersOf(root)
  assert.equal(t.glyph, DEFAULT_GLYPH_TIER, `字形档退到缺省（${DEFAULT_GLYPH_TIER}）`)
  assert.equal(t.icon, DEFAULT_ICON_TIER, `图标档退到缺省（${DEFAULT_ICON_TIER}）`)
  assert.equal(t.graphics, DEFAULT_GRAPHICS_TIER, `图片档退到缺省（${DEFAULT_GRAPHICS_TIER}）`)
  assert.notEqual(t.why, null, 'why 非空 —— 不说的话人以为配置没生效')
  assert.ok(t.why?.includes('JSON'), `报文说得出为什么：${t.why}`)
})

test('③ 值超出值域：与坏 JSON 同一条地板（值域归 `config.ts` 那一层管）', async () => {
  // `config.ts` 在 `readConfig` 那一趟就核值域（`ui.glyphs` 收 ascii / box / rich，`ui.icons` 收
  // off / ascii / nerd），超出值域当场拒——于是这里走的是"读不出来"那条路：退缺省档 + 说一声。
  // **这一条量的是"坏值也退得下去"**；值域本身那一条断言住在 `config` 那几份测试里。
  const root = await rootWith(JSON.stringify({ ui: { glyphs: 'huge' } }))
  const t = await uiTiersOf(root)
  assert.equal(t.glyph, DEFAULT_GLYPH_TIER, '超出值域的字形档退到缺省')
  assert.equal(t.icon, DEFAULT_ICON_TIER, '图标档跟着退到缺省')
  assert.notEqual(t.why, null, '说得出是哪一栏不对')
  assert.ok(t.why?.includes('ui.glyphs'), `报文点到那一栏：${t.why}`)
  console.log(`读数：好配置 → 从配置来 · 坏 JSON / 坏值 → ${t.glyph}/${t.icon}/${t.graphics} 且 why 非空`)
})
