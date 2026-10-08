// 0.4.3 第二幕 ③ 的断言：四级色表与八格语义色位（宪法 0.4.3 行 ①②· 施工单 § 五 ③）。
//
// 四条各量一件事：
//   · ① **四级表**：名字逐条 · `tierOf` 三档各在什么条件下选中 · **第 3 级一档都选不出来**
//     （truecolor 不开——那是类型上的事，这里从外面再量一遍）；
//   · ② **八格不手抄**：`SLOTS` 从 `SLOT_MEANING` 推 · `SLOT_256` 与它逐格对齐 · `ROLE_SLOT`
//     的值都在八格里 · `theme256()` 的角色集合恰好是"落在非空格子上的那些角色"；
//   · ③ **黑白地板逐字节不变**：`--no-style` / `NO_COLOR` / 认不得 256 色 → 与 0.2.8 那一份
//     逐字节相同，且**与第 2 级不同**（不然这一条量不到东西）；
//   · ④ **两道门逐字节全关**：第 0 级与"没有主题"那一档的字节流逐字节相同（0.2.8 口径）。
//
// 负对照（红得起来才是断言）：
//   ① 往 `SLOT_MEANING` 加第九格而不给 `SLOT_256` 补一格 → ② 当场红（八格与色表对不上）；
//   ② 把 `claims256` 改成恒假 → ① 的第 2 级那两条当场红；
//   ③ 把第 1 级那四个角色改一个（比如 `footer` 改成 `\x1b[2m`）→ ③ 当场红（地板动了）；
//   ④ 把 `tierOf` 的 `noStyle` 那一道门删掉 → ④ 当场红（`--no-style` 还上色）。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COLOR_TIERS,
  DEFAULT_THEME,
  ROLE_SLOT,
  SLOT_256,
  SLOT_MEANING,
  SLOTS,
  claims256,
  theme256,
  themeOf,
  tierOf,
} from './theme.ts'
import type { LineRole } from './frame.ts'
import { openTerm } from './term.ts'
import type { TermOut } from './term.ts'

/** 一个只会记的 sink（与 `theme.test.ts` 那一只同一形状）：写出去的每一笔按次序收着。 */
function drawOnce(theme: Parameters<typeof openTerm>[0]['theme']): string {
  const written: string[] = []
  const out: TermOut = {
    isTTY: true,
    columns: 40,
    write(s: string): boolean {
      written.push(s)
      return true
    },
  }
  // 四族角色全在场（`DEFAULT_THEME` 那几个都各有一行）——少一族，那一条"逐字节相同"就量不到它。
  const rows = ['┌────────────────────────────────────┐', '│阅读面 · 框名那一行│', '│阅读面正文│', '├────────────────────────────────────┤', '│账尾│', '│候选│', '└────────────────────────────────────┘']
  const roles = ['border', 'readHeading', 'read', 'border', 'footer', 'overlay', 'border']
  openTerm({ out, height: rows.length, term: 'xterm-256color', theme }).draw([], () => ({ rows, roles }))
  return written.join('')
}

test('① 四级表：名字逐条 · tierOf 三档各自的条件 · 真彩那一档一档都选不出来', () => {
  assert.equal(COLOR_TIERS.length, 4, '四级表就是四条')
  assert.deepEqual([...COLOR_TIERS], ['全关', '黑白属性', '256 色', 'truecolor（不开）'])
  // 第 0 级：两道门各是一条。
  assert.equal(tierOf({ noStyle: true }), 0)
  assert.equal(tierOf({ noColor: '1' }), 0)
  assert.equal(tierOf({ noStyle: true, colorTerm: 'truecolor' }), 0, '门比色档靠前')
  assert.equal(tierOf({ noColor: '' }), 1, 'NO_COLOR 空串算没喊（no-color.org）')
  // 第 1 级：没说自己能上 256 色的都退这儿。
  assert.equal(tierOf(), 1)
  assert.equal(tierOf({ term: 'xterm' }), 1)
  assert.equal(tierOf({ term: 'linux' }), 1, '认不出 256 就退属性档，不半上色')
  assert.equal(tierOf({ colorTerm: 'yes' }), 1, '说不认得 256 的都不算')
  // 第 2 级：COLORTERM 或 TERM 认得才算。
  assert.equal(tierOf({ term: 'xterm-256color' }), 2)
  assert.equal(tierOf({ colorTerm: '256' }), 2)
  assert.equal(tierOf({ colorTerm: 'truecolor' }), 2, '真彩声明落在第 2 级——第 3 级不开')
  assert.equal(tierOf({ colorTerm: '24bit' }), 2)
  assert.ok(claims256('screen-256color', undefined), 'TERM 里带 256color 也算')
  assert.ok(!claims256('xterm', 'nope'), '两处都不认 → 不算')
  // 第 3 级：可选出来的档只有三个（类型是 `0 | 1 | 2`，这里从外面再点一遍）。
  const seen = new Set<number>()
  for (const t of [undefined, 'xterm', 'xterm-256color', 'dumb', '']) {
    for (const c of [undefined, '', '256', 'truecolor']) seen.add(tierOf({ term: t, colorTerm: c }))
  }
  assert.deepEqual([...seen].sort(), [1, 2], `选得出的只有 1 与 2：拿到 ${[...seen].sort().join(' · ')}`)
  console.log(`① 读数：四级表 ${COLOR_TIERS.join(' → ')}；实测选出来的档 ${[...seen].sort().join(' · ')}（第 0 级要开门才到）`)
})

test('② 八格从 SLOT_MEANING 推：色表逐格对齐 · 角色都落在格里 · theme256 一个不多一个不少', () => {
  assert.equal(SLOTS.length, 8, `八格就是八条：拿到 ${SLOTS.length}——${SLOTS.join(' · ')}`)
  assert.deepEqual([...SLOTS].sort(), Object.keys(SLOT_MEANING).sort(), '名字从那张表推')
  // 色表与八格逐格对齐（加第九格而不补色表，这一条当场红）。
  assert.deepEqual(Object.keys(SLOT_256).sort(), [...SLOTS].sort(), '每一格都有一个 256 色索引')
  // 每个角色的那一格都在八格里。
  for (const [role, slot] of Object.entries(ROLE_SLOT)) {
    assert.ok(SLOTS.includes(slot), `${role} 落在八格里：${slot}`)
  }
  // theme256 的键集合 = "落在非空格子上的那些角色"（推导，不是手抄一遍角色名）。
  const want = (Object.keys(ROLE_SLOT) as readonly LineRole[])
    .filter((r) => SLOT_256[ROLE_SLOT[r]] !== '')
    .sort()
  assert.deepEqual((Object.keys(theme256()) as readonly LineRole[]).sort(), want, 'theme256 恰好覆盖该覆盖的角色')
  // 第 2 级里凡有值的角色都在八格的某一格上，取到的 SGR 与那一格逐字节相同。
  for (const [role, sgr] of Object.entries(theme256())) {
    assert.equal(sgr, SLOT_256[ROLE_SLOT[role as LineRole]], `${role} 取的就是它那一格`)
  }
  console.log(
    `② 读数：八格 ${SLOTS.map((s) => `${s}=${SLOT_MEANING[s]}`).join(' · ')}；` +
      `theme256 覆盖 ${Object.keys(theme256()).length} 个角色（${Object.keys(theme256()).join(' · ')}）`,
  )
})

test('③ 黑白地板逐字节不变：认不得 256 色那一档与 0.2.8 那一份逐字节相同', () => {
  assert.deepEqual(themeOf({ term: 'xterm' }), DEFAULT_THEME, '认不得 256 → 属性档那一份，逐字节相同')
  assert.deepEqual(themeOf(), DEFAULT_THEME, '什么都不给 → 属性档（theme.test.ts ② 那条口径不动）')
  assert.deepEqual(DEFAULT_THEME, {
    border: '\x1b[2m',
    footer: '\x1b[1m',
    overlay: '\x1b[1m',
    waiting: '\x1b[1m',
    readHeading: '\x1b[1m',
  })
  // **这一条要有对手**：第 2 级必须与它不同，不然"逐字节相同"量的是空气。
  const two = themeOf({ term: 'xterm-256color' })
  assert.notDeepEqual(two, DEFAULT_THEME, '第 2 级与第 1 级不同——不然上面那几条量不到东西')
  assert.equal(two?.border, '\x1b[38;5;242m', '框线在第 2 级走弱化那一格')
  assert.equal(two?.readHeading, '\x1b[1;38;5;75m', '阅读面标题在第 2 级是粗 + 蓝')
  console.log(`③ 读数：第 1 级 ${JSON.stringify(DEFAULT_THEME)} · 第 2 级 ${JSON.stringify(two)}`)
})

test('④ 两道门逐字节全关：第 0 级写出来的字节流与"没有主题"那一档逐字节相同', () => {
  const plain = drawOnce(undefined)
  assert.equal(drawOnce(themeOf({ noStyle: true })), plain, '--no-style：逐字节相同')
  assert.equal(drawOnce(themeOf({ noColor: '1' })), plain, 'NO_COLOR 非空：逐字节相同')
  assert.equal(drawOnce(themeOf({ noStyle: true, term: 'xterm-256color' })), plain, '门比色档靠前：还是全关')
  // 对手：第 1 级与第 2 级都该写出东西（不然上面那三条是"什么都没写"对"什么都没写"）。
  assert.notEqual(drawOnce(themeOf({ term: 'xterm' })), plain, '第 1 级有 SGR')
  assert.notEqual(drawOnce(themeOf({ term: 'xterm-256color' })), plain, '第 2 级有 SGR')
})
