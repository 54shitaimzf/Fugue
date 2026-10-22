// 外观草稿的预览：**在真终端上看一眼 0.4.3 的样子**（`src/ui/look/` 那一份素材）。
//
// 出处：ROADMAP § 3 的 0.2.8 行「样式的视觉验收由实现者自己看终端，程序侧不建快照出口」——这一份
// 就是「自己看」的那一下：一份固定的账 → 快照 → 几个场景，按指定的档上色印到 stdout。它只用于
// 开发与验证，不属于产品（`tools/` 的口径）；产品路径上没有一处 import 那一份草稿。
//
// 跑法：cd ~/fugue && node tools/look-preview.ts [选项]
//
//   --tier auto|off|mono|256|all   上色那一档（缺省 auto：照这台终端的 TERM · COLORTERM · NO_COLOR 判）
//   --icons ascii|nerd|both        图标那一档（缺省 ascii；装了 Nerd Font 的终端试 nerd）
//   --scene main|menu|gate|read|narrow|short|all   哪一幕（缺省 all）
//   --width <n>                    宽（缺省终端列数，量不到 100）
//   --png <file>                   阅读面那一幕里放这张图（kitty graphics；不认 kitty 的终端会印乱码——
//                                  探测是接线时的事，这里是你点名要的）
//
// 例：在 Linux 字符控制台（TERM=linux）上 `--tier auto` 落黑白属性档；`--tier all` 三档挨着印。
import { readFileSync } from 'node:fs'
import { widthOf } from '../src/ui/glyph.ts'
import type { LogEvent } from '../src/log/events.ts'
import type { StatusRow } from '../src/probe/status.ts'
import { statusOf } from '../src/probe/status.ts'
import { permanentLinesOf } from '../src/ui/stream.ts'
import { navNodesOf } from '../src/ui/nav.ts'
import { gateQueueRowOf, optionRowOf, previewLinesOf, GATE_VIEW } from '../src/ui/gate.ts'
import type { GateFace } from '../src/ui/gate.ts'
import { KEYMAP, WIRED, keyLabelOf } from '../src/ui/keymap.ts'
import { lookOf } from '../src/ui/look/layout.ts'
import { foldText, paint, sp } from '../src/ui/look/paint.ts'
import type { Line } from '../src/ui/look/paint.ts'
import { COLOR_TIERS, PALETTES } from '../src/ui/look/palette.ts'
import type { ColorTier } from '../src/ui/look/palette.ts'
import { sampleLookOf } from '../src/ui/look/sample.ts'
import type { SampleInput } from '../src/ui/look/sample.ts'
import { colorTierOf } from '../src/ui/look/tier.ts'
import type { IconTier } from '../src/ui/look/tier.ts'
import { iconOf } from '../src/ui/look/icons.ts'
import { imageBlockOf } from '../src/ui/look/image.ts'

const args = process.argv.slice(2)
function opt(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : fallback
}

// ── 一份固定的账（与 `frame.test.ts` 那一份同形，多几条让三种状态色都露面）──────────────────
let seq = 0
const at = (e: LogEvent, w = 'round'): StatusRow => ({ pos: { writer: w, seq: (seq += 1) }, e })
const rows: StatusRow[] = []
for (const [from, to] of [
  ['Idle', 'Planning'],
  ['Planning', 'Delegated'],
  ['Delegated', 'Working'],
  ['Verifying', 'Working'],
  ['Verifying', 'Rebuilding'],
] as const) {
  rows.push(at({ t: 'round/state', round: 'r1' as never, from, to }))
}
for (const [agent, step, invocations] of [
  ['agent/r1/1', '1', 2],
  ['agent/r1/1', '2', 1],
  ['agent/r1/2', '1', 3],
] as const) {
  rows.push(
    at(
      {
        t: 'llm/call',
        agent: agent as never,
        step: step as never,
        model: 'deepseek-flash/anthropic' as never,
        wire: 'anthropic-messages',
        toolCount: 9,
        invocations,
        status: null,
        headers: null,
        usage: { inputTokens: 1000, cacheReadTokens: 2048, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 40 },
        rawStop: 'end_turn',
        stop: 'end-turn',
      },
      agent,
    ),
  )
}
rows.push(at({ t: 'agent/stop', agent: 'agent/r1/1' as never, steps: 2, stopped: '收敛', handoffs: 0 }, 'agent/r1/1'))
for (const n of [1, 2]) {
  rows.push(
    at({
      t: 'contract/issue',
      round: 'r1' as never,
      contract: `r1.implement.${n}` as never,
      owner: `agent/r1/${n}` as never,
      paths: [`src/ui/look/part${n}.ts` as never],
      body: '{}',
    }),
  )
}
rows.push(at({ t: 'merge/attempt', round: 'r1' as never, branches: [] as never, conflicts: 1 }))
rows.push(
  at({
    t: 'merge/accept',
    round: 'r1' as never,
    commit: 'abc1234def' as never,
    assertions: [
      { assertion: '缺省那一档', verdict: 'pass', note: '' },
      { assertion: 'options 那一档', verdict: 'pass', note: '' },
      { assertion: 'README 用法那一句', verdict: 'fail', note: '' },
    ],
  } as never),
)
const snapshot = statusOf(rows)
const permanent = permanentLinesOf(rows)
const metrics = [
  { metric: 'detour-rate' as never, value: 0, numerator: 0, denominator: 2, how: '' },
  { metric: 'prefix-hit-rate' as never, value: 1, numerator: 3, denominator: 3, how: '' },
]
const report = [
  { metric: 'conflicts' as never, count: 1, how: '' },
  { metric: 'rejects' as never, count: 1, how: '' },
  { metric: 'denied' as never, count: 0, how: '' },
]

/** 提示行：按键表推（与 `hintLineOf` 同一张表），折叠那一截用草稿的统一写法。 */
function hintOf(limit: number): string {
  const ready = KEYMAP.rows.filter((b) => WIRED.includes(b.by))
  const shown = ready.slice(0, limit).map((b) => `${keyLabelOf(b)} ${b.hint}`)
  const more = ready.length - shown.length
  return `按键 ${shown.join(' · ')}${more > 0 ? ` ${foldText(more, '条', ['Ctrl-P 看全部'])}` : ''}`
}

const gateFace: GateFace = {
  round: 'r1',
  fingerprint: 'f00dfeed',
  same: [],
  cards: [
    {
      id: 'r1.implement.1',
      agent: 'agent/r1/1',
      kind: 'implement',
      head: '实现：把外观草稿的色位落到账尾',
      detail: ['  起进程：node tools/test-entry.js fast', '  写路径：src/ui/look/layout.ts · src/ui/look/sample.ts'],
    },
    { id: 'r1.investigate.2', agent: 'agent/r1/2', kind: 'investigate', head: '调查：控制台字体认不认 ┈', detail: [] },
  ],
}

function readRows(icons: IconTier, png: Uint8Array | undefined): { rows: Line[]; place: string | null } {
  const img = imageBlockOf({
    name: 'assets/look-256.png',
    tier: png === undefined ? 'none' : 'kitty',
    icons,
    png,
    cols: 24,
    rows: 6,
    id: 7,
  })
  const diff: Line[] = [
    [sp('round 14 · ', 'muted'), iconOf('file', icons), sp(' 写 src/ui/look/paint.ts'), sp('（+142 −0）', 'muted')],
    [sp('  + export function fit(line: Line, w: number): Line {')],
    [sp('  +   if (w <= 0) return []')],
    [sp('round 15 · ', 'muted'), iconOf('file', icons), sp(' 写 src/ui/look/layout.ts'), sp('（+180 −0）', 'muted')],
    [sp('round 16 · ', 'muted'), ...img.rows[0]!],
    ...img.rows.slice(1),
    [sp('round 17 · ', 'muted'), iconOf('deny', icons), sp(' 边界拦下 /etc/hosts（物化树）', 'bad'), sp(' · 规则 fence:outside', 'muted')],
  ]
  return { rows: diff, place: img.place }
}

const W = Number(opt('width', String(process.stdout.columns ?? 100))) || 100
const tierArg = opt('tier', 'auto')
const tiers: ColorTier[] =
  tierArg === 'all'
    ? [...COLOR_TIERS]
    : tierArg === 'auto'
      ? [
          colorTierOf({
            isTTY: process.stdout.isTTY,
            term: process.env['TERM'],
            colorTerm: process.env['COLORTERM'],
            noColor: process.env['NO_COLOR'],
          }),
        ]
      : [tierArg as ColorTier]
const iconArg = opt('icons', 'ascii')
const iconTiers: IconTier[] = iconArg === 'both' ? ['ascii', 'nerd'] : [iconArg as IconTier]
const pngPath = opt('png', '')
const png = pngPath === '' ? undefined : new Uint8Array(readFileSync(pngPath))
const sceneArg = opt('scene', 'all')

function scenes(icons: IconTier): { name: string; input: SampleInput; place?: string | null }[] {
  // 提示行按宽取前几条（与 `hintLimitOf` 同一个量法：量整行，「还有 N 条」那一句也占列）。
  let limit = KEYMAP.rows.length
  while (limit > 1 && widthOf(hintOf(limit)) > W - 2) limit -= 1
  const base = { snapshot, metrics, report, permanent, icons, hint: hintOf(limit) }
  const nav = { nodes: navNodesOf(rows), at: 1 }
  const read = readRows(icons, png)
  return [
    { name: 'main · 两栏 + 树 + 提示行', input: { ...base, nav, width: W } },
    {
      name: 'menu · 候选开着（开窗 · 折叠标记）',
      input: {
        ...base,
        nav,
        menu: { rows: ['/status', '/watch', '/tui', '/round go', '/round new', '/log', '/diff', '/doctor'], sel: 3, cap: 4 },
        width: W,
      },
    },
    {
      name: 'gate · 门口那一块（预览 · 队列行 · 选项行）',
      input: {
        ...base,
        gate: { preview: previewLinesOf(gateFace.cards[0]!), queue: gateQueueRowOf(gateFace, 0), option: optionRowOf(GATE_VIEW) },
        width: W,
      },
    },
    { name: 'read · 阅读面（单栏 · 框名落标题格）', input: { ...base, read: { rows: read.rows }, width: W }, place: read.place },
    { name: 'narrow · 40 列收单栏', input: { ...base, width: 40 } },
    { name: 'short · 矮屏：先让提示行，再截栏', input: { ...base, nav, width: W, height: 12 } },
  ]
}

for (const tier of tiers) {
  for (const icons of iconTiers) {
    for (const s of scenes(icons)) {
      if (sceneArg !== 'all' && !s.name.startsWith(sceneArg)) continue
      process.stdout.write(`\n── ${s.name} · 上色 ${tier} · 图标 ${icons} ──\n\n`)
      const lines = lookOf(sampleLookOf(s.input)).map((l) => paint(l, PALETTES[tier]))
      process.stdout.write(`${lines.join('\n')}\n`)
      if (s.place !== undefined && s.place !== null) process.stdout.write(`(图放在阅读面那一块的留白里：接线时由终端层定位)${s.place}\n`)
    }
  }
}
