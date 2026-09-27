// TUI 的第一格：**帧是同一读面的第二档渲染**（架构 § 9.6 的观察行 · 架构 § 8.13 的 `round/state`
// 链 · PLAN § 5.18 的三面表 · § 5.19 第五段）。跑法：cd ~/fugue && node --test src/ui/frame.test.ts
//
// 这一份量的四样：
//
//   ① **黄金帧**：一份固定事件串折出来的快照 → 整帧逐字节等于那一份原文，而且每一行的列宽恰好
//      是 `width`（框对得上，中日韩宽字符那把尺没错）。
//   ② **负对照 · 左栏**：账里多一条 `round/state`（一条图上真的走得到的边）→ 左栏变、
//      **右栏逐字节不变**；账尾那条会动——它是全账的读数，不属于任何一栏（那一栏的分工就写在
//      `frame.ts` 的头注里，这一条是它的牙）。
//   ③ **负对照 · 右栏**：账里多一条 `merge/attempt`（冲突 2）→ **左栏逐字节不变**、右栏变。
//   ④ **两栏都动的那一条也是对的**：多一次 `llm/call` → 两栏都变（调用次数在左栏"每一格"与
//      右栏"用量"各有一处口径）。它说明两栏不是按事件类型分的，是按**读法**分的。
//   ⑤ **地板**：窄了收成单栏（同一个框，少中间那根竖线，内容一行不少）· 矮了截断并说出还剩
//      几行 · 三行都不到印一句"太矮"（不静默给空帧）· 尺寸给 0 给一个空帧。
//   ⑥ **纯**：同一份输入两次调用逐字节相同，而且进去的那一份快照一个字段都没被改。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import type { StatusRow, StatusSnapshot } from '../probe/status.ts'
import { statusOf } from '../probe/status.ts'
import { bodyOf, clip, footerOf, frameOf, widthOf, wrap } from './frame.ts'

let seq = 0
/** 一条事件（`round` 那一份上）。**seq 每次从 0 起**：两次折用的序号于是对得上。 */
const row = (e: LogEvent, w = 'round'): StatusRow => ({ pos: { writer: w, seq: (seq += 1) }, e })

/** 一条链：四条单边 + 一条跳步（`Verifying` 那一条落的是收尾，中间几步要从图上找回来）。 */
const CHAIN: readonly (readonly [string, string])[] = [
  ['Idle', 'Planning'],
  ['Planning', 'Delegated'],
  ['Delegated', 'Working'],
  ['Verifying', 'Working'],
  ['Verifying', 'Rebuilding'],
]

/** 三次调用（两格）。`steps` 去重之后一格两步、一格一步。 */
const CALLS: readonly (readonly [string, string, number, number | null])[] = [
  ['agent/r1/1', '1', 2, 2048],
  ['agent/r1/1', '2', 1, 2048],
  ['agent/r1/2', '1', 3, 0],
]

/** 那一份固定的账。**两次折用的是同一份**（`seq` 从 0 起，所以逐字节对得上）。 */
function rowsOf(): StatusRow[] {
  seq = 0
  const out: StatusRow[] = []
  for (const [from, to] of CHAIN) {
    out.push(row({ t: 'round/state', round: 'r1' as never, from: from as never, to: to as never }))
  }
  for (const [agent, step, invocations, cacheRead] of CALLS) {
    out.push(
      row(
        {
          t: 'llm/call',
          agent: agent as never,
          step: step as never,
          model: 'deepseek-chat' as never,
          wire: 'anthropic-messages',
          toolCount: 9,
          invocations,
          status: null,
          headers: null,
          usage: { inputTokens: 1000, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: 100 },
          rawStop: 'end_turn',
          stop: 'end-turn',
        },
        agent,
      ),
    )
  }
  out.push(row({ t: 'agent/stop', agent: 'agent/r1/1' as never, steps: 2, stopped: '收敛', handoffs: 0 }, 'agent/r1/1'))
  out.push(
    row({
      t: 'contract/issue',
      round: 'r1' as never,
      contract: 'r1.implement.1' as never,
      owner: 'agent/r1/1' as never,
      paths: [],
      body: '{}',
    }),
  )
  out.push(
    row({
      t: 'contract/issue',
      round: 'r1' as never,
      contract: 'r1.implement.2' as never,
      owner: 'agent/r1/2' as never,
      paths: [],
      body: '{}',
    }),
  )
  out.push(row({ t: 'merge/attempt', round: 'r1' as never, branches: [] as never, conflicts: 0 }))
  out.push(
    row({
      t: 'merge/accept',
      round: 'r1' as never,
      commit: 'abc' as never,
      assertions: [
        { assertion: '缺省那一档', verdict: 'pass', note: '' },
        { assertion: 'options 那一档', verdict: 'pass', note: '' },
        { assertion: 'README 用法那一句', verdict: 'pass', note: '' },
      ],
    } as never),
  )
  return out
}

const METRICS = [
  { metric: 'detour-rate' as never, value: 0, numerator: 0, denominator: 2, how: '' },
  { metric: 'prefix-hit-rate' as never, value: 1, numerator: 3, denominator: 3, how: '' },
]
const REPORT = [
  { metric: 'conflicts' as never, count: 0, how: '' },
  { metric: 'rejects' as never, count: 1, how: '' },
  { metric: 'denied' as never, count: 0, how: '' },
]

/** 那一份快照（`extra` 是那几条对照往里加的事件）。 */
function snapshotOf(extra: readonly StatusRow[] = []): StatusSnapshot {
  const base = rowsOf()
  seq = base.length
  return statusOf([...base, ...extra])
}

const GOLDEN: readonly string[] = [
  "┌─ 处境 ─────────────────────────────────────────┬─ 读数 ──────────────────────────────────────────┐",
  "│轮次 r1 · 状态 Rebuilding · 转移 5 条 · 跳步 1 ·│契约 2 · 折叠尝试 1 · 冲突 0 · 验收 1 次（过 3 / │",
  "│打回 1 次 · 最近一条落在这一轮                  │没过 0）                                         │",
  "│  Idle ──land──> Planning                       │用量 调用 3 · input 3000 · cacheRead 4096 ·      │",
  "│  Planning ──contracts-issued──> Delegated      │cacheWrite 0 · output 300                        │",
  "│  Delegated ──branches-started──> Working       │detour-rate 0（0/2）                             │",
  "│  Verifying ──verdict-fail──> Working           │prefix-hit-rate 1（3/3）                         │",
  "│  Verifying ⇒ Rebuilding（跳步，经 verdict-pass │打回 conflicts 0 · rejects 1 · denied 0          │",
  "│advanced）                                      │                                                 │",
  "│格 agent/r1/1 · 调 2 次 · 2 步 · 工具调用 3 ·   │                                                 │",
  "│动作 0 · 停：2 步 · 收敛                        │                                                 │",
  "│格 agent/r1/2 · 调 1 次 · 1 步 · 工具调用 3 ·   │                                                 │",
  "│动作 0 · 停：没停                               │                                                 │",
  "├────────────────────────────────────────────────┴─────────────────────────────────────────────────┤",
  "│最近 merge/accept（round 13）· 事件 13 条                                                         │",
  "└────────────────────────────────────────────────┴─────────────────────────────────────────────────┘",
]

test('① 黄金帧：整帧逐字节等于那一份原文，而且每一行恰好 width 列', () => {
  const f = frameOf({ snapshot: snapshotOf(), metrics: METRICS, report: REPORT, width: 100, height: 16 })
  assert.deepEqual([...f.lines], [...GOLDEN], '帧与黄金那一份不逐字节相同')
  const widths = f.lines.map((l) => widthOf(l))
  assert.deepEqual(widths, f.lines.map(() => 100), `每一行都该是 100 列：${widths.join(',')}`)
  assert.deepEqual(f.columns, { left: 48, right: 49 }, '两栏的列宽')
  assert.equal(f.lines.length, 16, '这一屏给了 16 行，装得下就该印满（含账尾）')
  console.log(
    `① 读数：${f.lines.length} 行 · 每行 ${f.width} 列 · 左 ${f.columns.left} / 右 ${f.columns.right}` +
      ` · 账尾「${f.footer}」· 处境 ${bodyOf({ snapshot: snapshotOf() }).left.length} 行`,
  )
})

test('② 负对照 · 左栏：多一条 round/state → 左栏变、右栏一字不变（账尾会动，它是全账的读数）', () => {
  const a = snapshotOf()
  const b = snapshotOf([row({ t: 'round/state', round: 'r1' as never, from: 'Working' as never, to: 'Collecting' as never })])
  const fa = bodyOf({ snapshot: a, metrics: METRICS, report: REPORT })
  const fb = bodyOf({ snapshot: b, metrics: METRICS, report: REPORT })
  assert.notDeepEqual([...fa.left], [...fb.left], '多一条边，左栏却没变')
  assert.deepEqual([...fa.right], [...fb.right], '右栏不该因为一条 round/state 而动')
  assert.equal(fb.left.length, fa.left.length + 1, '多一条边，左栏正好多一行')
  // 账尾是**全账**的读数：它会动。这一条写出来，免得下一个人把它当成"右栏变了"。
  assert.notEqual(footerOf(a), footerOf(b), '账尾该动（最近一条与条数都变了）')
  console.log(`② 读数：左栏 ${fa.left.length} → ${fb.left.length} 行 · 右栏 ${fa.right.length} 行一字不变 · 账尾「${footerOf(a)}」→「${footerOf(b)}」`)
})

test('③ 负对照 · 右栏：多一条 merge/attempt（冲突 2）→ 右栏变、左栏一字不变', () => {
  const a = snapshotOf()
  const b = snapshotOf([row({ t: 'merge/attempt', round: 'r1' as never, branches: [] as never, conflicts: 2 })])
  const fa = bodyOf({ snapshot: a, metrics: METRICS, report: REPORT })
  const fb = bodyOf({ snapshot: b, metrics: METRICS, report: REPORT })
  assert.deepEqual([...fa.left], [...fb.left], '左栏不该因为一条 merge/attempt 而动')
  assert.notDeepEqual([...fa.right], [...fb.right], '多一条合并尝试，右栏却没变')
  assert.match(fb.right[0] ?? '', /折叠尝试 2 · 冲突 2/, `右栏那一行的两个数都该动：${fb.right[0]}`)
  console.log(`③ 读数：右栏那一行「${fb.right[0]}」· 左栏 ${fa.left.length} 行一字不变`)
})

test('④ 多一次 llm/call：两栏都动（调用次数在两栏各有一处口径——分的是读法，不是事件类型）', () => {
  const a = snapshotOf()
  const b = snapshotOf([
    row(
      {
        t: 'llm/call',
        agent: 'agent/r1/1' as never,
        step: '3' as never,
        model: 'deepseek-chat' as never,
        wire: 'anthropic-messages',
        toolCount: 9,
        invocations: 1,
        status: null,
        headers: null,
        usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
        rawStop: 'end_turn',
        stop: 'end-turn',
      },
      'agent/r1/1',
    ),
  ])
  const fa = bodyOf({ snapshot: a, metrics: METRICS, report: REPORT })
  const fb = bodyOf({ snapshot: b, metrics: METRICS, report: REPORT })
  assert.notDeepEqual([...fa.left], [...fb.left], '左栏那一条"格"的行该动（调 2 次 → 3 次）')
  assert.notDeepEqual([...fa.right], [...fb.right], '右栏那一条"用量"的行该动（调用 3 → 4）')
  assert.match(fb.left.join('\n'), /agent\/r1\/1 · 调 3 次 · 3 步/, `左栏那一行的数该动：${fb.left.join(' ｜ ')}`)
  assert.match(fb.right.join('\n'), /用量 调用 4/, `右栏那一行的数该动：${fb.right.join(' ｜ ')}`)
  console.log('④ 读数：左栏「调 3 次 · 3 步」· 右栏「用量 调用 4」——同一件事两处口径，两栏都动是对的')
})

test('⑤ 地板：窄了收单栏 · 矮了截断并说出剩几行 · 三行都不到说"太矮" · 尺寸 0 给空帧', () => {
  const snapshot = snapshotOf()
  const narrow = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 40, height: 40 })
  assert.equal(narrow.columns.right, 0, '40 列画不出两栏')
  assert.equal(narrow.lines.some((l) => l.includes('┬')), false, '单栏那一档不该有中间那根竖线')
  const text = narrow.lines.join('\n')
  for (const one of ['轮次 r1 · 状态 Rebuilding', '契约 2', '用量 调用 3']) {
    assert.ok(text.includes(one), `单栏那一档少了这一处：${one}`)
  }
  // 账尾是**状态条**：40 列那一档它装不下，从右边截并留一个 `…`（说了它被截过）。截掉的是尾巴上
  // 那半截（`…· 事件 13 条`），留下的是"账在动"那个信号——次序就是为这个排的。
  assert.ok(text.includes('最近 merge/accept'), '单栏那一档也该有账尾')
  assert.ok(text.includes('…'), '账尾在这一档截过，该留一个 `…`——不然就是静默少印')

  // 矮：给 8 行，内容装不下 → 末行说出还剩几行。
  const short = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 100, height: 8 })
  assert.ok(short.lines.length <= 8, `这一屏只给 8 行，印出来 ${short.lines.length} 行`)
  const cut = short.lines.find((l) => l.includes('还有'))
  assert.ok(cut !== undefined, `截断了却没说出还剩几行：${short.lines.join('\n')}`)
  assert.match(cut as string, /还有 \d+ 行没印/)

  // 连框都画不出：三行。
  const tiny = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 100, height: 3 })
  assert.equal(tiny.lines.length, 1, '画不出框时只印一句')
  assert.match(tiny.lines[0] ?? '', /太矮/)

  // 终端那一刻没给出尺寸：空帧（调用方那一侧的事）。
  assert.deepEqual(frameOf({ snapshot, width: 0, height: 0 }).lines, [])

  console.log(
    `⑤ 读数：40 列 → 单栏（右 0，${narrow.lines.length} 行，一处内容不少）· 8 行 → 「${(cut as string).split('│').map((x) => x.trim()).filter((x) => x !== '').join(' ｜ ')}」` +
      ` · 3 行 → 「${(tiny.lines[0] as string).replace(/^│|│$/g, '').trim()}」· 0 列 0 行 → ${frameOf({ snapshot, width: 0, height: 0 }).lines.length} 行`,
  )
})

test('⑥ 纯：同一份输入两次逐字节相同，进去的那一份快照一个字段都没被改', () => {
  const snapshot = snapshotOf()
  const before = JSON.stringify(snapshot)
  const one = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 100, height: 16 })
  const two = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 100, height: 16 })
  assert.deepEqual([...one.lines], [...two.lines], '同一份输入两次不一样——那就不是纯函数')
  assert.equal(JSON.stringify(snapshot), before, '快照被这一份改过了（读面不许写）')
  // 那把尺也顺手量一下：宽字符算两列 · 截断留 `…` · 折行按空格断。
  assert.equal(widthOf('中文abc'), 7, '中日韩宽字符算两列')
  assert.equal(clip('中文字', 4), '中…', '截断留一个 `…`')
  assert.deepEqual([...wrap('甲 乙 丙 丁', 5)], ['甲 乙', '丙 丁'], '折在空格处')
  console.log(`⑥ 读数：两次逐字节相同（${one.lines.length} 行）· 快照 JSON ${before.length} 字节两趟同值 · 尺子 中文abc=7 · 中文字→「中…」`)
})
