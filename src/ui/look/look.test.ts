// 外观草稿 · 整帧（ROADMAP § 5 的 0.4.3 行验收列，逐条落成断言）：
//
//   ① **未接线**：草稿以外的产品文件（`src/` · `bin/` · `tools/` 里除预览那一份）没有一处 import
//      `look/`——256 色仍在架构 § 9.8「定义里永远不做」的单子上，接线是 0.4.3 的事；判据自己要能红
//      （喂一份带 import 的假文件，它得报出来）；
//   ② 几何：每一档 · 每一种图标 · 每一个场景 · 每一个宽，每一行正好 `width` 列；
//   ③ **两道门**：`--no-style` / `NO_COLOR` 判出 off，整帧一个 ESC 都没有，逐字节等于片的字；
//   ④ **黑白地板**：认不得 256 色的五种终端（含 Linux 字符控制台）判出同一档、整帧逐字节相同，
//      只用粗与暗；剥掉 SGR 与 off 档逐字节相同；256 档同样剥掉之后逐字节相同（三档同形）；
//   ⑤ **图标两档**：不给 · 开关关（`iconTierOf({})`）· `ascii` 三份整帧逐字节相同；`nerd` 那一份
//      逐行同宽，把图标换回 ASCII 之后与 `ascii` 那一份逐字节相同（且真有图标被换——不是空话）；
//   ⑥ **图片两档**：探测不到 · 给了档却拿不出数据 → 只有说明行，整帧与「没有图片这一档」逐字节
//      相同；kitty + PNG → 说明行一字不变、下面多出留白、放图那一串分笔正确且光标不动（`C=1`）；
//   ⑦ 布局参数从 `LAYOUT` / `BOX` 推：框线内侧一列空气 · 细线缩在空气里 · 账尾与提示行之间空一行；
//   ⑧ 矮了先让提示行再截栏、末行说还有几行（多给一行就少藏一行）；窄到 · 矮到画不出框说一句。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import type { LogEvent } from '../../log/events.ts'
import type { StatusRow } from '../../probe/status.ts'
import { statusOf } from '../../probe/status.ts'
import { widthOf } from '../glyph.ts'
import { navNodesOf } from '../nav.ts'
import { permanentLinesOf } from '../stream.ts'
import { ICONS } from './icons.ts'
import { captionOf, imageBlockOf, kittyDeleteOf, KITTY_CHUNK } from './image.ts'
import { BOX, LAYOUT, lookOf } from './layout.ts'
import { paint, sp, strip, textOf } from './paint.ts'
import type { Line } from './paint.ts'
import { COLOR_TIERS, PALETTES } from './palette.ts'
import type { ColorTier } from './palette.ts'
import { sampleLookOf } from './sample.ts'
import type { SampleInput } from './sample.ts'
import { colorTierOf, iconTierOf } from './tier.ts'
import type { IconTier } from './tier.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')

// ── 一份固定的账（与 `frame.test.ts` 同形：五条边 · 三次调用 · 一格停了 · 两份契约 · 一次合并）──
function ledger(): StatusRow[] {
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
  for (const [agent, step] of [['agent/r1/1', '1'], ['agent/r1/1', '2'], ['agent/r1/2', '1']] as const) {
    rows.push(
      at(
        {
          t: 'llm/call',
          agent: agent as never,
          step: step as never,
          model: 'm' as never,
          wire: 'anthropic-messages',
          toolCount: 9,
          invocations: 1,
          status: null,
          headers: null,
          usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 },
          rawStop: 'end_turn',
          stop: 'end-turn',
        },
        agent,
      ),
    )
  }
  rows.push(at({ t: 'agent/stop', agent: 'agent/r1/1' as never, steps: 2, stopped: '收敛', handoffs: 0 }, 'agent/r1/1'))
  rows.push(at({ t: 'merge/attempt', round: 'r1' as never, branches: [] as never, conflicts: 1 }))
  rows.push(
    at({
      t: 'merge/accept',
      round: 'r1' as never,
      commit: 'abc1234def' as never,
      assertions: [
        { assertion: 'a', verdict: 'pass', note: '' },
        { assertion: 'b', verdict: 'fail', note: '' },
      ],
    } as never),
  )
  return rows
}

const ROWS = ledger()
const SNAP = statusOf(ROWS)
const BASE = {
  snapshot: SNAP,
  permanent: permanentLinesOf(ROWS),
  metrics: [{ metric: 'detour-rate' as never, value: 0, numerator: 0, denominator: 2, how: '' }],
  report: [{ metric: 'rejects' as never, count: 1, how: '' }],
  hint: '按键 Enter 提交 · Esc 取消 · ? 帮助 · q 退出',
}

/** 几个场景：两栏 + 树 · 候选开着 · 门口那一块 · 阅读面（含一张图的说明行）。 */
function scenes(width: number, icons?: IconTier): readonly SampleInput[] {
  const nav = { nodes: navNodesOf(ROWS), at: 1 }
  const withIcons = icons === undefined ? {} : { icons }
  return [
    { ...BASE, ...withIcons, nav, width },
    { ...BASE, ...withIcons, nav, menu: { rows: ['/status', '/watch', '/tui', '/round go', '/log', '/diff'], sel: 3, cap: 3 }, width },
    { ...BASE, ...withIcons, gate: { preview: ['实现：一句目标', '  写路径：a.ts'], queue: '还有 1 份等你点头', option: '放行一次(y) · 拒(n)' }, width },
    { ...BASE, ...withIcons, read: { rows: [[sp('round 9 · 写 a.ts')], captionOf('b.png', icons ?? 'ascii')] }, width },
  ]
}

/** 一帧画成一档：每行的字节串。 */
function draw(input: SampleInput, tier: ColorTier): readonly string[] {
  return lookOf(sampleLookOf(input)).map((l) => paint(l, PALETTES[tier]))
}

const WIDTHS = [40, 60, 100, 140]

/** 草稿以外，谁 import 了 `look/`（一份「路径 → 原文」的表进来，报出犯规的那几份）。 */
function importersOf(files: ReadonlyMap<string, string>): readonly string[] {
  const out: string[] = []
  for (const [path, text] of files) if (/['"][^'"\n]*\/look\/[^'"\n]*['"]/.test(text)) out.push(path)
  return out.sort()
}

/** 产品文件（与草稿与预览无关的那些）：`src/` · `bin/` · `tools/` 底下的文本文件。 */
function productFiles(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const rel = relative(REPO, p)
      if (rel === join('src', 'ui', 'look') || rel === join('tools', 'look-preview.ts')) continue
      if (statSync(p).isDirectory()) walk(p)
      else out.set(rel, readFileSync(p, 'utf8'))
    }
  }
  for (const top of ['src', 'bin', 'tools']) walk(join(REPO, top))
  return out
}

test('① 未接线：草稿以外的产品文件没有一处 import look/（判据自己要能红）', () => {
  const files = productFiles()
  assert.ok(files.size > 100, `产品文件要真读到（读到 ${files.size} 份）`)
  assert.ok(files.has(join('src', 'ui', 'theme.ts')), '生产那一份主题在扫描范围里')
  assert.deepEqual(importersOf(files), [], '有产品文件 import 了外观草稿——接线是 0.4.3 的事（开口按 0.4.1 的批）')
  // 负对照：同一个判据，喂一份接了线的假 `term.ts`，它得报出来。
  const wired = new Map(files)
  wired.set(join('src', 'ui', 'term.ts'), `${files.get(join('src', 'ui', 'term.ts'))}\nimport { PALETTES } from './look/palette.ts'\n`)
  assert.deepEqual(importersOf(wired), [join('src', 'ui', 'term.ts')], '判据量不出接线——这一条就是空话')
  console.log(`① 读数：扫了 ${files.size} 份产品文件 · import look/ 的 0 份 · 负对照报出 1 份`)
})

test('② 几何：每档 · 每种图标 · 每个场景 · 每个宽，每一行正好 width 列', () => {
  let n = 0
  for (const w of WIDTHS) {
    for (const icons of ['ascii', 'nerd'] as const) {
      for (const s of scenes(w, icons)) {
        for (const tier of COLOR_TIERS) {
          for (const line of draw(s, tier)) {
            assert.equal(widthOf(strip(line)), w, `${tier}/${icons}/${w}：「${strip(line)}」`)
            n += 1
          }
        }
      }
    }
  }
  console.log(`② 读数：${n} 行 · ${WIDTHS.length} 种宽 × 2 种图标 × 4 个场景 × ${COLOR_TIERS.length} 档，行行等宽`)
})

test('③ 两道门：--no-style · NO_COLOR 判出 off，整帧零 ESC、逐字节等于片的字', () => {
  const env = { isTTY: true, term: 'xterm-256color', colorTerm: 'truecolor' }
  for (const gate of [{ noStyle: true }, { noColor: '1' }]) {
    const tier = colorTierOf({ ...env, ...gate })
    assert.equal(tier, 'off', `门 ${JSON.stringify(gate)}`)
    for (const s of scenes(100)) {
      const lines = lookOf(sampleLookOf(s))
      const out = lines.map((l) => paint(l, PALETTES[tier])).join('\n')
      assert.ok(!out.includes('\x1b'), '门开着时一个 ESC 都不许有')
      assert.equal(out, lines.map(textOf).join('\n'), '与「没有色位」逐字节相同')
    }
  }
  console.log('③ 读数：两道门 × 4 个场景 · 零 ESC · 与片的字逐字节相同')
})

test('④ 黑白地板：认不得 256 的终端同一档、整帧逐字节相同、只用粗与暗；三档剥掉 SGR 同形', () => {
  const terms = ['xterm', 'linux', 'vt100', 'screen', 'rxvt-unicode']
  const tiers = terms.map((term) => colorTierOf({ isTTY: true, term }))
  assert.deepEqual(new Set(tiers), new Set(['mono']), `这几种终端都该落黑白档：${tiers.join(' · ')}`)
  let bytes = 0
  for (const s of scenes(100)) {
    const frames = tiers.map((t) => draw(s, t).join('\n'))
    for (const f of frames) assert.equal(f, frames[0], '黑白档的整帧与终端名无关')
    const mono = frames[0] as string
    for (const m of mono.matchAll(/\x1b\[([0-9;]*)m/g)) {
      for (const p of (m[1] as string).split(';')) assert.ok(['0', '1', '2'].includes(p), `黑白档用了 ${p}`)
    }
    const off = draw(s, 'off').join('\n')
    assert.equal(strip(mono), off, '黑白档剥掉 SGR 与 off 档同形')
    const deep = draw(s, '256').join('\n')
    assert.equal(strip(deep), off, '256 档剥掉 SGR 与 off 档同形')
    assert.ok(deep.includes('\x1b[38;5;'), '256 档真上了色（不然同形是句空话）')
    bytes += mono.length
  }
  console.log(`④ 读数：${terms.join(' · ')} 都落黑白档 · 4 个场景整帧逐字节相同（共 ${bytes} 字节）· 只含 0/1/2`)
})

test('⑤ 图标两档：不给 = 开关关 = ascii 逐字节相同；nerd 逐行同宽、换回 ASCII 后逐字节相同', () => {
  const swapBack = (s: string): string => {
    let out = s
    for (const i of Object.values(ICONS)) out = out.split(i.nerd).join(i.ascii)
    return out
  }
  for (const i of Object.values(ICONS)) assert.equal(widthOf(i.nerd), widthOf(i.ascii), `${i.says}：两套字形要同宽`)
  let swapped = 0
  for (const w of WIDTHS) {
    const none = scenes(w)
    const off = scenes(w, iconTierOf({}))
    const ascii = scenes(w, 'ascii')
    const nerd = scenes(w, 'nerd')
    for (let k = 0; k < none.length; k += 1) {
      for (const tier of COLOR_TIERS) {
        const a = draw(ascii[k] as SampleInput, tier)
        assert.deepEqual(draw(none[k] as SampleInput, tier), a, '不给图标那一档 = ascii')
        assert.deepEqual(draw(off[k] as SampleInput, tier), a, '开关关着 = ascii')
        const n = draw(nerd[k] as SampleInput, tier)
        assert.deepEqual(n.map((l) => widthOf(strip(l))), a.map((l) => widthOf(strip(l))), 'nerd 那一份逐行同宽')
        assert.deepEqual(n.map(swapBack), a, 'nerd 换回 ASCII 之后逐字节相同')
        for (const l of n) for (const i of Object.values(ICONS)) swapped += l.split(i.nerd).length - 1
      }
    }
  }
  assert.ok(swapped > 0, 'nerd 那一份里要真有图标（不然换回去是空话）')
  console.log(`⑤ 读数：${Object.keys(ICONS).length} 个图标两套同宽 · 换回 ${swapped} 处之后逐字节相同`)
})

test('⑥ 图片两档：探测不到 · 拿不出数据 → 只有说明行（与没有这一档逐字节相同）；kitty + PNG 分笔正确', () => {
  const png = new Uint8Array(10_000)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < png.length; i += 1) png[i] = (i * 31) % 251
  const base = { name: 'b.png', icons: 'ascii' as const, cols: 20, rows: 5, id: 7 }
  const floors = [
    imageBlockOf({ ...base, tier: 'none', png }),
    imageBlockOf({ ...base, tier: 'kitty' }),
    imageBlockOf({ ...base, tier: 'kitty', png: new Uint8Array([1, 2, 3]) }),
    imageBlockOf({ ...base, tier: 'sixel' }),
    imageBlockOf({ ...base, tier: 'sixel', sixel: 'not a sixel' }),
  ]
  const caption = captionOf('b.png', 'ascii')
  for (const f of floors) {
    assert.deepEqual(f.rows, [caption], '地板：只有说明行')
    assert.equal(f.place, null, '地板：不放图')
  }
  // 整帧：阅读面里放地板那一块，与只放说明行的那一帧逐字节相同。
  const frameWith = (rows: readonly Line[]): string =>
    draw({ ...BASE, read: { rows: [[sp('round 9 · 写 a.ts')], ...rows] }, width: 80 }, '256').join('\n')
  assert.equal(frameWith((floors[0] as { rows: readonly Line[] }).rows), frameWith([caption]), '与「没有图片这一档」逐字节相同')

  const k = imageBlockOf({ ...base, tier: 'kitty', png })
  assert.deepEqual(k.rows[0], caption, '有图时说明行一个字节不变')
  assert.equal(k.rows.length, 1 + base.rows, '说明行下面留出图那几行')
  const place = k.place as string
  const chunks = [...place.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)]
  const b64 = Buffer.from(png).toString('base64')
  assert.equal(chunks.length, Math.ceil(b64.length / KITTY_CHUNK), '按 KITTY_CHUNK 分笔')
  assert.match(chunks[0]?.[1] as string, /^a=T,f=100,t=d,i=7,c=20,r=5,C=1,q=2,m=1$/, '首笔：传完就放 · PNG · 光标不动')
  assert.deepEqual(chunks.map((c) => /m=(\d)/.exec(c[1] as string)?.[1]), [...Array(chunks.length - 1).fill('1'), '0'], '末笔 m=0')
  assert.deepEqual(new Uint8Array(Buffer.from(chunks.map((c) => c[2]).join(''), 'base64')), png, '拼回去就是原图')
  assert.equal(kittyDeleteOf(7), '\x1b_Ga=d,d=I,i=7,q=2\x1b\\', '重画之前删那一张（连数据：d=I）')
  const six = imageBlockOf({ ...base, tier: 'sixel', sixel: '\x1bPq#0;2;0;0;0~~\x1b\\' })
  assert.equal(six.place, '\x1bPq#0;2;0;0;0~~\x1b\\', 'sixel：外形对就原样放（编码不在草稿里）')
  console.log(`⑥ 读数：${floors.length} 种地板都只有说明行 · kitty ${png.length} 字节 → ${chunks.length} 笔 · 拼回逐字节相同`)
})

test('⑦ 布局参数从 LAYOUT / BOX 推：内侧一列空气 · 细线缩在空气里 · 账尾与提示行之间空一行', () => {
  const airs = ' '.repeat(LAYOUT.padX)
  let rules = 0
  for (const s of scenes(100)) {
    const lines = draw(s, 'off')
    const bottom = lines.findIndex((l) => l.startsWith(BOX.bl))
    for (const l of lines.slice(1, bottom)) {
      if (!l.startsWith(BOX.v)) continue
      assert.equal(l.slice(1, 1 + LAYOUT.padX), airs, `左框线内侧要有 ${LAYOUT.padX} 列空气：「${l}」`)
      assert.equal(l.slice(-1 - LAYOUT.padX, -1), airs, `右框线内侧要有 ${LAYOUT.padX} 列空气：「${l}」`)
      for (const m of l.matchAll(new RegExp(`${BOX.thin}+`, 'g'))) {
        rules += 1
        assert.equal(l.slice((m.index as number) - LAYOUT.padX, m.index), airs, '细线左边是空气，不碰竖线')
        assert.equal(l.slice((m.index as number) + m[0].length, (m.index as number) + m[0].length + LAYOUT.padX), airs, '细线右边也是')
      }
    }
    const gap = lines.slice(bottom + 1, bottom + 1 + LAYOUT.hintGap)
    assert.equal(gap.length, LAYOUT.hintGap, '框下面要有那几行空')
    for (const g of gap) assert.equal(g.trim(), '', '账尾与提示行之间是空行')
    assert.match(lines[bottom + 1 + LAYOUT.hintGap] ?? '', /^ +按键/, '空行之后是提示行')
    assert.equal(lines.length, bottom + 2 + LAYOUT.hintGap, '提示行是最后一行')
  }
  assert.ok(rules > 0, '场景里要真有细线（不然这一条量不到它）')
  console.log(`⑦ 读数：空气 ${LAYOUT.padX} 列 · 细线 ${rules} 处都缩在空气里 · 账尾与提示行隔 ${LAYOUT.hintGap} 行`)
})

test('⑧ 矮了先让提示行再截栏（多给一行就少藏一行）· 窄到矮到画不出框说一句', () => {
  const full = draw({ ...BASE, nav: { nodes: navNodesOf(ROWS), at: 0 }, width: 100 }, 'off')
  const hidden = (h: number): number | null => {
    const lines = draw({ ...BASE, nav: { nodes: navNodesOf(ROWS), at: 0 }, width: 100, height: h }, 'off')
    assert.ok(lines.length <= h, `高 ${h}：画了 ${lines.length} 行`)
    const m = lines.map((l) => /… 还有 (\d+) 行（这一屏 (\d+) 行）/.exec(l)).find((x) => x !== null)
    if (m === undefined || m === null) return null
    assert.equal(Number(m[2]), h, '折叠标记说的是这一屏的高')
    assert.ok(!lines.some((l) => /按键/.test(l)), `高 ${h}：截栏之前提示行该先让掉`)
    return Number(m[1])
  }
  const readings: string[] = []
  let last: number | null = null
  // 整帧里栏占几行：去掉框的四行（上边 · 账尾分隔 · 账尾 · 下边）与提示行那一截。
  const fullBody = full.length - 4 - (1 + LAYOUT.hintGap)
  for (let h = 6; h < full.length; h += 1) {
    const k = hidden(h)
    if (k === null) continue
    // 截栏那一档：提示行已让掉，栏有 h − 4 行，末行是折叠标记——印出来的 h − 5 行 + 藏的 = 全部。
    assert.equal(k + (h - 4 - 1), fullBody, `高 ${h}：藏 ${k} 行，与整帧 ${fullBody} 行对不上`)
    if (last !== null) assert.equal(k, last - 1, `高 ${h}：多给一行就该少藏一行（${last} → ${k}）`)
    last = k
    readings.push(`${h}→${k}`)
  }
  assert.ok(readings.length > 3, '要真截过几档')
  assert.equal(hidden(full.length), null, '装得下就不截')
  assert.match(draw({ ...BASE, width: 3 }, 'off')[0] ?? '', /^（/, '3 列：说一句太窄')
  assert.equal(widthOf(draw({ ...BASE, width: 3 }, 'off')[0] ?? ''), 3)
  assert.match(strip(draw({ ...BASE, width: 60, height: 4 }, '256')[0] ?? ''), /太矮/, '4 行：说一句太矮')
  console.log(`⑧ 读数：整帧 ${full.length} 行 · 截栏读数（高→藏）${readings.slice(0, 6).join(' · ')} …`)
})

test('⑨ 外部审查四条的回归：跳步按边数 · 只有收敛算成功 · 控制字节转义 · 矮屏留住门口那两行', () => {
  // ① 跳步：图外那条（零步）不许减成负数；「原地说了一次」（零步）不许把真跳步抵掉。
  const chain = (pairs: readonly (readonly [string, string])[]): readonly string[] => {
    let seq = 0
    const rows = pairs.map(([from, to]) => ({ pos: { writer: 'round', seq: (seq += 1) }, e: { t: 'round/state', round: 'r1', from, to } }) as never)
    const snapshot = statusOf(rows)
    return draw({ snapshot, width: 140 }, 'off')
  }
  const jumpOf = (lines: readonly string[]): string | null => /跳步 (-?\d+)/.exec(lines.join('\n'))?.[1] ?? null
  assert.equal(jumpOf(chain([['Idle', 'Planning'], ['Aborted', 'Working']])), null, '图外那条：不该印「跳步 -1」')
  assert.equal(jumpOf(chain([['Idle', 'Planning'], ['Planning', 'Planning'], ['Verifying', 'Rebuilding']])), '1', '原地那条不许抵掉真跳步')
  assert.equal(jumpOf(chain([['Idle', 'Planning'], ['Aborted', 'Working'], ['Verifying', 'Rebuilding']])), '1', '图外 + 跳步：跳步照数')

  // ② 停了不等于成了：只有「收敛」落成功格（+），别的停因落错误格（x）。判据那句原话从源码核。
  for (const f of ['round/driver.ts', 'round/plan.ts']) {
    assert.match(readFileSync(join(REPO, 'src', f), 'utf8'), /let stopped = '收敛'/, `${f} 里「收敛」那句原话变了，CONVERGED 要跟着改`)
  }
  const stopped = (why: string): Line[] => {
    const rows: StatusRow[] = [
      { pos: { writer: 'agent/r1/1', seq: 1 }, e: { t: 'agent/stop', agent: 'agent/r1/1' as never, steps: 3, stopped: why, handoffs: 0 } },
    ]
    return [...lookOf(sampleLookOf({ snapshot: statusOf(rows), width: 100 }))]
  }
  const agentRow = (lines: Line[]): Line => lines.find((l) => textOf(l).includes('格 agent/r1/1')) as Line
  const ok = agentRow(stopped('收敛'))
  const cut = agentRow(stopped('max-tokens：这一步的回复被截断'))
  assert.ok(ok.some((s) => s.text === '+' && s.slot === 'ok'), '收敛：成功图标落成功格')
  assert.ok(!cut.some((s) => s.slot === 'ok'), '没收住的停因不许有一片落成功格')
  assert.ok(cut.some((s) => s.text === 'x' && s.slot === 'bad'), '没收住：失败图标落错误格')

  // ③ 控制字节：文件名里的 ESC 与换行转成可见形状——off 档零 ESC，256 档的 ESC 全是 SGR，行行等宽。
  const evil = '\x1b[2J\x1b]0;pwn\x07\n.png'
  const read = { ...BASE, read: { rows: [captionOf(evil, 'ascii'), [sp(`round 9 · 写 ${evil}`)]] }, width: 80 }
  const off = draw(read, 'off')
  assert.ok(!off.join('').includes('\x1b'), 'off 档一个 ESC 都不许漏出去')
  assert.ok(off.join('\n').includes('\\u001b[2J'), '转义成可见形状（与阅读面同一个 escapeOf）')
  const deep = draw(read, '256').join('\n')
  assert.equal(deep.replace(/\x1b\[[0-9;]*m/g, '').includes('\x1b'), false, '256 档：除了 SGR 不许有别的 ESC')
  for (const l of off) assert.equal(widthOf(l), 80, '转义之后行行等宽（换行没把一帧撕开）')

  // ④ 矮屏：5–7 行时门口那块末两行（队列行 · 选项行）留住，栏整个收起；5 行只放得下一行时留选项行。
  const gate = { ...BASE, gate: { preview: ['实现：一句目标', '  写路径：a.ts'], queue: '还有 1 份等你点头', option: '放行一次(y) · 拒(n)' }, width: 100 }
  for (const h of [5, 6, 7, 8]) {
    const lines = draw({ ...gate, height: h }, 'off')
    assert.ok(lines.length <= h, `高 ${h}：画了 ${lines.length} 行`)
    for (const l of lines) assert.equal(widthOf(l), 100)
    assert.ok(lines.some((l) => l.includes('放行一次(y)')), `高 ${h}：选项行（人要按的那一行）要在`)
    if (h >= 6) assert.ok(lines.some((l) => l.includes('等你点头')), `高 ${h}：队列行也要在`)
  }
  console.log('⑨ 读数：跳步不出负数、不被原地抵掉 · 只有「收敛」是绿的 · 控制字节零泄漏 · 5–8 行门口那两行都在')
})
