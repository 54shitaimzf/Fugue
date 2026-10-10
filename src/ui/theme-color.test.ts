// 色档按宿主能力选择，八格角色映射与原有黑白/全关退化逐字节保留。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('① 五级表：全关、属性、16 色、256 色；真彩只落到 256 色', () => {
  assert.deepEqual([...COLOR_TIERS], ['全关', '黑白属性', '16 色', '256 色', 'truecolor（不开）'])
  assert.equal(tierOf({ noStyle: true }), 0)
  assert.equal(tierOf({ noColor: '1' }), 0)
  assert.equal(tierOf({ noStyle: true, colorTerm: 'truecolor' }), 0)
  assert.equal(tierOf({ noColor: '' }), 1)
  assert.equal(tierOf(), 1)
  assert.equal(tierOf({ term: 'xterm' }), 1, '未声明更高能力保留黑白地板')
  assert.equal(tierOf({ term: 'linux' }), 2)
  assert.equal(tierOf({ term: 'xterm-16color' }), 2)
  assert.equal(tierOf({ colorTerm: 'yes' }), 1)
  assert.equal(tierOf({ term: 'xterm-256color' }), 3)
  for (const colorTerm of ['256', 'truecolor', '24bit']) assert.equal(tierOf({ colorTerm }), 3)
  assert.ok(claims256('screen-256color', undefined))
  assert.ok(!claims256('xterm', 'nope'))
  const seen = new Set<number>()
  for (const term of [undefined, 'xterm', 'linux', 'xterm-256color', 'dumb', '']) {
    for (const colorTerm of [undefined, '', '256', 'truecolor']) seen.add(tierOf({ term, colorTerm }))
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3])
  console.log(`① 色档：${COLOR_TIERS.join(' → ')}；可选 ${[...seen].sort().join('/')}（0 全关、4 不开）`)
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
  // **角色的名单从 `ui/frame.ts` 的 `LineRole` 联合里现读**，不手抄一份（抄下来的那一份会漂）：
  // `Record<LineRole, Slot>` 只是个类型，而 `.ts` 直跑是 strip-only——**运行时一个字都不管**。
  // 所以"帧那一层报得出的角色，每一格都有落点"必须在这里真的量一遍。
  // 实测过的那一发：摘掉 `ROLE_SLOT.hit`，补这一条之前一条都不红。
  const frameSrc = readFileSync(new URL('./frame.ts', import.meta.url), 'utf8')
  const union = /export type LineRole =([^\n]*)/.exec(frameSrc)?.[1] ?? ''
  const roles = [...union.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1] as string)
  assert.ok(roles.length >= 10, `\`LineRole\` 那个联合该有一串角色，读到的只有 ${roles.length} 个：${union}`)
  for (const role of roles) {
    assert.ok(role in ROLE_SLOT, `帧那一层报得出的角色 \`${role}\` 在 \`ROLE_SLOT\` 里没有落点`)
  }
  assert.equal(roles.length, Object.keys(ROLE_SLOT).length, `两边角色数该一样：联合 ${roles.length} · 表 ${Object.keys(ROLE_SLOT).length}`)
  // theme256 的键集合 = "落在非空格子上的那些角色"（推导，不是手抄一遍角色名）。
  const want = (Object.keys(ROLE_SLOT) as readonly LineRole[])
    .filter((r) => SLOT_256[ROLE_SLOT[r]] !== '')
    .sort()
  assert.deepEqual((Object.keys(theme256()) as readonly LineRole[]).sort(), want, 'theme256 恰好覆盖该覆盖的角色')
  // 背景不明的八个关键角色使用宿主前景；其余角色仍逐字节取语义色位。
  for (const [role, sgr] of Object.entries(theme256())) {
    const critical: Partial<Record<LineRole, string>> = { waiting: '\x1b[1m', system: '\x1b[39m', hint: '\x1b[39m', user: '\x1b[1m', readHeading: '\x1b[1m', ok: '\x1b[1m', refuse: '\x1b[1m', modelHeading: '\x1b[1m' }
    assert.equal(sgr, critical[role as LineRole] ?? SLOT_256[ROLE_SLOT[role as LineRole]], `${role} 遵循当前背景与角色的样式`)
  }
  console.log(
    `② 读数：八格 ${SLOTS.map((s) => `${s}=${SLOT_MEANING[s]}`).join(' · ')}；` +
      `theme256 覆盖 ${Object.keys(theme256()).length} 个角色（${Object.keys(theme256()).join(' · ')}）`,
  )
})

test('③ 黑白地板逐字节不变：能力未声明时既有角色字节不变、新汇报角色使用黑白属性', () => {
  assert.deepEqual(themeOf({ term: 'xterm' }), DEFAULT_THEME, '能力未声明 → 属性档那一份，逐字节相同')
  assert.deepEqual(themeOf(), DEFAULT_THEME, '什么都不给 → 属性档（theme.test.ts ② 那条口径不动）')
  assert.deepEqual(DEFAULT_THEME, {
    border: '\x1b[2m',
    footer: '\x1b[1m',
    overlay: '\x1b[1m',
    overlayBody: '\x1b[1m',
    waiting: '\x1b[1m',
    readHeading: '\x1b[1m',
    ok: '\x1b[1m',
    refuse: '\x1b[1m',
    hit: '\x1b[1m',
  })
  // **这一条要有对手**：256 色档必须与它不同，不然"逐字节相同"量的是空气。
  const two = themeOf({ term: 'xterm-256color' })
  assert.notDeepEqual(two, DEFAULT_THEME, '256 色档与第 1 级不同——不然上面那几条量不到东西')
  assert.equal(two?.border, '\x1b[38;5;242m', '框线在256 色档走弱化那一格')
  assert.equal(two?.readHeading, '\x1b[1m', '未知背景的阅读面标题用宿主前景加粗')
  console.log(`③ 读数：第 1 级 ${JSON.stringify(DEFAULT_THEME)} · 256 色档 ${JSON.stringify(two)}`)
})

test('④ 两道门逐字节全关：第 0 级写出来的字节流与"没有主题"那一档逐字节相同', () => {
  const plain = drawOnce(undefined)
  assert.equal(drawOnce(themeOf({ noStyle: true })), plain, '--no-style：逐字节相同')
  assert.equal(drawOnce(themeOf({ noColor: '1' })), plain, 'NO_COLOR 非空：逐字节相同')
  assert.equal(drawOnce(themeOf({ noStyle: true, term: 'xterm-256color' })), plain, '门比色档靠前：还是全关')
  // 对手：第 1 级与256 色档都该写出东西（不然上面那三条是"什么都没写"对"什么都没写"）。
  assert.notEqual(drawOnce(themeOf({ term: 'xterm' })), plain, '第 1 级有 SGR')
  assert.notEqual(drawOnce(themeOf({ term: 'xterm-256color' })), plain, '256 色档有 SGR')
})
