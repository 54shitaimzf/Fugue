// 外观草稿 · 色位表（ROADMAP § 5 的 0.4.3 行 ①②；验收列「色位表从 theme.ts 推、不手抄」）。
//
//   ① 八格恰八格，三档每一档都一格不缺——名单从 `SLOT_MEANING` 推，档表的键对着它核；
//   ② 256 档的颜色真落在规格说的那一族上（绿 · 红 · 黄 · 灰 · 蓝+粗），弹层与命中只是粗；同义
//      不许混用：上色的五格两两不同色；黑白档只用粗与暗两个属性；
//   ③ 两种底都读得清：上色的每一格在纯黑底与纯白底上对比度都 ≥ 3（xterm 256 色公式现算）；
//   ④ 与 0.2.8 的接续：黑白档投到 0.2.8 的行角色上，与 `DEFAULT_THEME` 逐字节相同——**只有账尾
//      不同**（草稿的请示件），而且差别的名单从 `DEFAULT_THEME` 推，不手抄。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME } from '../theme.ts'
import type { LineRole } from '../frame.ts'
import { COLOR_TIERS, LINE_SLOT, PALETTES, SLOT_MEANING, SLOTS } from './palette.ts'
import type { Slot } from './palette.ts'

/** 一段 SGR 的参数（`\x1b[1;38;5;32m` → [1, 38, 5, 32]）。空串 → []。 */
function paramsOf(sgr: string): number[] {
  const m = /^\x1b\[([0-9;]*)m$/.exec(sgr)
  if (sgr === '') return []
  assert.ok(m !== null, `不是一段 SGR：${JSON.stringify(sgr)}`)
  return (m[1] as string).split(';').map(Number)
}

/** 256 色索引（`38;5;n` 那个 n）；没有就是 null。 */
function indexOf256(sgr: string): number | null {
  const p = paramsOf(sgr)
  const i = p.indexOf(38)
  return i >= 0 && p[i + 1] === 5 ? (p[i + 2] as number) : null
}

/** xterm 256 色 → RGB（16–231 是 6×6×6 立方，232–255 是灰阶）。 */
function rgbOf(n: number): readonly [number, number, number] {
  const L = [0, 95, 135, 175, 215, 255]
  if (n >= 232) {
    const v = 8 + 10 * (n - 232)
    return [v, v, v]
  }
  const k = n - 16
  return [L[Math.floor(k / 36)] as number, L[Math.floor(k / 6) % 6] as number, L[k % 6] as number]
}

/** 色相族：灰（无彩）· 红 · 黄 · 绿 · 蓝。 */
function familyOf(n: number): string {
  const [r, g, b] = rgbOf(n)
  const hi = Math.max(r, g, b)
  const lo = Math.min(r, g, b)
  if (hi === lo) return 'brightBlack'
  let h = hi === r ? ((g - b) / (hi - lo)) % 6 : hi === g ? (b - r) / (hi - lo) + 2 : (r - g) / (hi - lo) + 4
  h = (h * 60 + 360) % 360
  if (h < 20 || h >= 340) return 'red'
  if (h < 70) return 'yellow'
  if (h < 170) return 'green'
  if (h < 260) return 'blue'
  return 'other'
}

/** WCAG 相对亮度与对比度。 */
function contrast(a: readonly number[], b: readonly number[]): number {
  const lin = (c: number): number => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  const lum = (c: readonly number[]): number =>
    0.2126 * lin(c[0] as number) + 0.7152 * lin(c[1] as number) + 0.0722 * lin(c[2] as number)
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

test('① 八格恰八格（规格 ② 的次序），三档每一档的键与它逐一对上', () => {
  assert.deepEqual([...SLOTS], ['ok', 'bad', 'wait', 'muted', 'body', 'heading', 'overlay', 'hit'], '规格 ② 的八格与次序')
  assert.deepEqual([...COLOR_TIERS].sort(), Object.keys(PALETTES).sort(), '档的次序表与档表对得上')
  for (const tier of COLOR_TIERS) {
    assert.deepEqual(Object.keys(PALETTES[tier]).sort(), [...SLOTS].sort(), `${tier} 档的格名与 SLOT_MEANING 对不上`)
    assert.equal(PALETTES[tier].body, '', `${tier} 档：正文=缺省（一个 SGR 都不包）`)
  }
  for (const s of SLOTS) assert.equal(PALETTES.off[s], '', `off 档的 ${s} 该是空串`)
  console.log(`① 读数：${SLOTS.length} 格 · ${COLOR_TIERS.length} 档（${COLOR_TIERS.join(' · ')}）`)
})

test('② 256 档落在规格那一族上 · 同义不许混用 · 黑白档只用粗与暗', () => {
  const p = PALETTES['256']
  const colored: Slot[] = SLOTS.filter((s) => indexOf256(p[s]) !== null)
  for (const s of colored) {
    const want = SLOT_MEANING[s].family.replace('+bold', '')
    assert.equal(familyOf(indexOf256(p[s]) as number), want, `${s}（${SLOT_MEANING[s].says}）该落在 ${want} 那一族`)
  }
  assert.deepEqual(colored, ['ok', 'bad', 'wait', 'muted', 'heading'], '上色的恰是这五格（成功 · 错误 · 等待 · 弱化 · 标题）')
  assert.ok(paramsOf(p.heading).includes(1), '阅读面标题=粗+蓝：要有粗')
  for (const s of SLOTS.filter((x) => SLOT_MEANING[x].family === 'bold')) {
    assert.deepEqual(paramsOf(p[s]), [1], `${s} 只是粗，不上色`)
  }
  const idx = colored.map((s) => indexOf256(p[s]))
  assert.equal(new Set(idx).size, idx.length, `同义不许混用：上色的五格两两不同色（${idx.join(' · ')}）`)
  for (const s of SLOTS) {
    for (const n of paramsOf(PALETTES.mono[s])) assert.ok(n === 1 || n === 2, `黑白档 ${s} 用了属性以外的参数 ${n}`)
  }
  console.log(`② 读数：256 档 ${colored.map((s) => `${s}=${indexOf256(p[s])}`).join(' · ')}`)
})

test('③ 两种底都读得清：上色的每一格在黑底与白底上对比度都 ≥ 3', () => {
  const p = PALETTES['256']
  const rows: string[] = []
  for (const s of SLOTS) {
    const n = indexOf256(p[s])
    if (n === null) continue
    const k = contrast(rgbOf(n), [0, 0, 0])
    const w = contrast(rgbOf(n), [255, 255, 255])
    assert.ok(k >= 3 && w >= 3, `${s}=${n}：黑底 ${k.toFixed(2)} · 白底 ${w.toFixed(2)}（要两边都 ≥ 3）`)
    rows.push(`${s}=${n} 黑 ${k.toFixed(2)} 白 ${w.toFixed(2)}`)
  }
  // 对照：这把尺量得出不合格的——亮橙 214 在白底上不到 2。
  assert.ok(contrast(rgbOf(214), [255, 255, 255]) < 3, '尺子要量得出白底上看不清的那一格')
  console.log(`③ 读数：${rows.join(' · ')}`)
})

test('④ 与 0.2.8 的接续：黑白档投到行角色上 = DEFAULT_THEME，只有账尾不同（请示件）', () => {
  const roles = Object.keys(LINE_SLOT) as LineRole[]
  const differ = roles.filter((r) => PALETTES.mono[LINE_SLOT[r]] !== (DEFAULT_THEME[r] ?? '')).sort()
  // 名单从 `DEFAULT_THEME` 推：它有值的角色里，除了账尾，黑白档都给出同一段 SGR。
  const themed = (Object.keys(DEFAULT_THEME) as LineRole[]).filter((r) => r !== 'footer')
  for (const r of themed) assert.equal(PALETTES.mono[LINE_SLOT[r]], DEFAULT_THEME[r], `${r}：黑白档与 0.2.8 不同`)
  assert.deepEqual(differ, ['footer'], '与 0.2.8 不同的行角色只许是账尾（改成「状态标记 + 正文」那一条）')
  assert.equal(DEFAULT_THEME.footer, '\x1b[1m', '0.2.8 的账尾是整行加粗（U3）——这一条变了，请示件要跟着改')
  console.log(`④ 读数：${roles.length} 个行角色 · 与 0.2.8 相同 ${roles.length - differ.length} · 不同 ${differ.join(' · ')}`)
})
