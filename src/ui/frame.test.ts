// TUI 的第一格：**帧是同一读面的第二档渲染**（架构 § 9.6 的观察行 · 架构 § 8.13 的 `round/state`
// 链 · PLAN § 5.18 的三面表 · § 5.19 第五段）。跑法：cd ~/fugue && node --test src/ui/frame.test.ts
//
// 这一份量的四样：
//
//   ① **黄金帧**：一份固定事件串折出来的快照 → 整帧逐字节等于那一份原文，而且每一行的列宽恰好
//      是 `width`（框对得上，中日韩宽字符那把尺没错）。
//   ② **负对照 · 左栏**：账里多一条 `round/state`（一条图上真的走得到的边）→ 左栏变、
//      **右栏逐字节不变**；账尾那条会动——它是全账的读数，不属于任何一栏（那一栏的分工就写在
//      `frame.ts` 的头注里，这一条是它的判据）。
//   ③ **负对照 · 右栏**：账里多一条 `merge/attempt`（冲突 2）→ **左栏逐字节不变**、右栏变。
//   ④ **两栏都动的那一条也是对的**：多一次 `llm/call` → 两栏都变（调用次数在左栏"每一格"与
//      右栏"用量"各有一处口径）。它说明两栏不是按事件类型分的，是按**读法**分的。
//   ⑤ **地板**：窄了收成单栏（同一个框，少中间那根竖线，内容一行不少）· 矮了截断并说出还剩
//      几行 · 三行都不到印一句"太矮"（不静默给空帧）· 尺寸给 0 给一个空帧。
//   ⑥ **纯**：同一份输入两次调用逐字节相同，而且进去的那一份快照一个字段都没被改。
//   ⑦ **候选那一层开的窗**（`windowOf`，`T4` 的 `/` 菜单与 `Ctrl-P` 面板用它）：装得下就全印 · 装不下
//      时**选中的那一条一定在窗里**（贴着头或贴着尾）· 上下各还剩几条数得出来 · 只剩一行可印时不留
//      "还有几条"那一句（那一行留给候选）。
//   ⑧ **阅读面那一栏**（`T9` 的 `ReadInput`）：给 `top` 就从那一行起印 · 装不下时末行说"下面还有几行"
//      （**不截中间**）· 不给它时整帧与从前逐字节相同（这一栏是加出来的，不是改出来的）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import type { StatusRow, StatusSnapshot } from '../probe/status.ts'
import { statusOf } from '../probe/status.ts'
import { bodyOf, footerOf, frameOf, panelOf, windowOf } from './frame.ts'
import { clip, widthOf, wrap } from './glyph.ts'

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
          model: 'deepseek-flash/anthropic' as never,
          wire: 'anthropic-messages',
          toolCount: 9,
          invocations,
          status: null,
          headers: null,
          usage: { inputTokens: 1000, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 40 },
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
  "┌─ 处境 ───────────────────────────────┬─ 读数 ────────────────────────────────────────────────────┐",
  "│轮次 r1 · 状态 Rebuilding · 转移 5 条 │契约 2 · 折叠尝试 1 · 冲突 0 · 验收 1 次（过 3 / 没过 0）  │",
  "│跳步 1 · 打回 1 次 ·                  │用量 调用 3 · input 3000 · cacheRead 4096 · cacheWrite 0 · │",
  "│最近一条落在这一轮                    │output 300 · 思考 120                                      │",
  "│  Idle ──land──> Planning             │detour-rate 0（0/2）                                       │",
  "│  Planning ──contracts-issued──>      │prefix-hit-rate 1（3/3）                                   │",
  "│Delegated                             │打回 conflicts 0 · rejects 1 · denied 0                    │",
  "│  Delegated ──branches-started──>     │                                                           │",
  "│Working                               │                                                           │",
  "│  Verifying ──verdict-fail──> Working │                                                           │",
  "│  Verifying ⇒ Rebuilding（跳步，经    │                                                           │",
  "│verdict-pass · advanced）             │                                                           │",
  "│格 agent/r1/1 · 调 2 次 · 2 步 ·      │                                                           │",
  "│工具调用 3 · 动作 0 · 停：2 步 · 收敛 │                                                           │",
  "│格 agent/r1/2 · 调 1 次 · 1 步 ·      │                                                           │",
  "│工具调用 3 · 动作 0 · 停：没停        │                                                           │",
  "├──────────────────────────────────────┴───────────────────────────────────────────────────────────┤",
  "│最近 merge/accept（round 13）· 事件 13 条                                                         │",
  "└──────────────────────────────────────┴───────────────────────────────────────────────────────────┘",
]

test('① 黄金帧：整帧逐字节等于那一份原文，而且每一行恰好 width 列', () => {
  const f = frameOf({ snapshot: snapshotOf(), metrics: METRICS, report: REPORT, width: 100, height: 19 })
  assert.deepEqual([...f.lines], [...GOLDEN], '帧与黄金那一份不逐字节相同')
  const widths = f.lines.map((l) => widthOf(l))
  assert.deepEqual(widths, f.lines.map(() => 100), `每一行都该是 100 列：${widths.join(',')}`)
  assert.deepEqual(f.columns, { left: 38, right: 59 }, '两栏的列宽（U10c：左 2/5 · 右 3/5）')
  assert.equal(f.lines.length, 19, '这一屏给了 19 行，装得下就该印满（含账尾；左栏窄了折行多两行，高度跟着补）')
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
        model: 'deepseek-flash/anthropic' as never,
        wire: 'anthropic-messages',
        toolCount: 9,
        invocations: 1,
        status: null,
        headers: null,
        usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 2 },
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

test('⑦ 账尾那一列：给了"永久行"就印它的最后一条（没给照旧印最近一条事件）', () => {
  const snapshot = snapshotOf()
  const permanent = ['round 1 · 轮次 r1 · Idle → Planning', 'round 5 · 轮次 r1 · 合并接受 abcdef01… · 断言 3 条（过 3 / 没过 0）']
  assert.equal(footerOf(snapshot), '最近 merge/accept（round 13）· 事件 13 条', '没给那一列时账尾该是最近一条事件')
  assert.equal(footerOf(snapshot, []), footerOf(snapshot), '一条永久行都没有时照旧')
  assert.equal(footerOf(snapshot, permanent), permanent[1], `给了那一列，账尾该是它最后一条：${footerOf(snapshot, permanent)}`)
  const withRow = frameOf({ snapshot, permanent, width: 100, height: 16 })
  assert.equal(withRow.footer, permanent[1], '整帧那一栏也是它')
  assert.equal(withRow.lines.length, 16, '多这一列不该动行数')
  assert.notEqual(withRow.footer, frameOf({ snapshot, width: 100, height: 16 }).footer, '两条路该分得开')
  // 补到 K 行那一处（终端那一层要的）：多出来的行不写，少的那几行补空白（不是补内容）。
  assert.deepEqual([...panelOf(['ab'], 2, 4)], ['ab  ', '    '], '补空行那一处不对')
  assert.deepEqual([...panelOf(['ab', 'cd', 'ef'], 2, 4)], ['ab  ', 'cd  '], '多出来的行该不写')
  console.log(`⑦ 读数：没给 → 「${footerOf(snapshot)}」· 给了 → 「${withRow.footer}」· panelOf 补空行 4 列 × 2 行`)
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

// ── ⑦ 候选那一层开的窗（`T4` 的面板用它）──────────────────────────────────────
test('⑦ `windowOf`：装得下就全印 · 选中的一定在窗里 · 上下各剩几条 · 只剩一行时不留那句话', () => {
  assert.deepEqual(windowOf(0, 0, 3), { from: 0, count: 0, above: 0, below: 0, summary: false }, '一条都没有')
  assert.deepEqual(windowOf(3, 1, 3), { from: 0, count: 3, above: 0, below: 0, summary: false }, '装得下就全印')
  assert.deepEqual(windowOf(30, 15, 4), { from: 14, count: 3, above: 14, below: 13, summary: true }, '中间那一条')
  assert.deepEqual(windowOf(30, 0, 4), { from: 0, count: 3, above: 0, below: 27, summary: true }, '贴着头（不往回滚）')
  assert.deepEqual(windowOf(30, 29, 4), { from: 27, count: 3, above: 27, below: 0, summary: true }, '贴着尾')
  // 选中的那一条一定在窗里（这一条是这一段的判据：翻到哪一条都看得见）。
  for (const sel of [0, 1, 14, 15, 28, 29]) {
    const w = windowOf(30, sel, 4)
    assert.ok(sel >= w.from && sel < w.from + w.count, `选中第 ${sel + 1} 条时它不在窗里：${JSON.stringify(w)}`)
  }
  assert.deepEqual(windowOf(5, 2, 1), { from: 2, count: 1, above: 2, below: 2, summary: false }, '只剩一行可印：留给候选，不留那句话')
  assert.equal(windowOf(5, 2, 1).count + (windowOf(5, 2, 1).summary ? 1 : 0), 1, '印出去的行数不超过给的预算')
  for (const budget of [1, 2, 3, 8]) {
    const w = windowOf(30, 7, budget)
    assert.ok(w.count + (w.summary ? 1 : 0) <= budget, `预算 ${budget} 行时印多了：${JSON.stringify(w)}`)
  }
  console.log(
    '⑦ 读数：30 条候选在 4 行预算里 → 印 3 条 + 一句"还有 27 条"· 选中第 1/2/15/16/29/30 条时都在窗里 · ' +
      '预算 1 行时不留那句话（那一行留给候选）',
  )
})

// ── ⑧ 阅读面那一栏（`T9`）────────────────────────────────────────────────────
test('⑧ 阅读面那一栏：整块地方给它（树与内容都让位）· 从 `top` 起印 · 装不下就说"下面还有几行" · 不给它时逐字节与从前相同', () => {
  const base = { snapshot: snapshotOf(), metrics: METRICS, report: REPORT, width: 80, height: 19 }
  const rows = ['标题 · 三面之一', '第一行', '第二行', '第三行', '第四行', '第五行']

  // **不给 `read` 时**（`T9` 之前那一档）：整帧与从前逐字节相同——这一栏是加出来的，不是改出来的。
  const none = frameOf(base)
  const emptyRead = frameOf({ ...base, read: { rows: [], top: 0 } })
  assert.deepEqual([...emptyRead.lines], [...none.lines], '给一个空的阅读面与不给，逐字节相同（一个字节都不占）')

  // 从第 0 行起：标题在头一行，**处境与读数那两栏让位**（整块地方给正文）。
  const all = frameOf({ ...base, read: { rows, top: 0 } })
  const shown = all.lines.filter((l) => l.includes('│标题 · 三面之一'))
  assert.equal(shown.length, 1, '标题在（阅读面那一栏是横贯整栏的）')
  assert.ok(all.lines.some((l) => l.includes('第一行')), '第二行也在')
  assert.ok(!all.lines.some((l) => l.includes('轮次 r1 · 状态')), '内容那一栏不印了（地方整块给正文）')
  assert.ok(!all.lines.some((l) => l.includes('主线（round）') || l.includes('格 agent/r1/1')), '树那几行也不印了')

  // `top = 2`：头两行不印了（那正是"翻下去"的意思）。
  const scrolled = frameOf({ ...base, read: { rows, top: 2 } })
  assert.ok(!scrolled.lines.some((l) => l.includes('标题 · 三面之一')), '翻下去之后标题不在屏上')
  assert.ok(scrolled.lines.some((l) => l.includes('第二行')), '`top` 那一行起印')
  assert.ok(!scrolled.lines.some((l) => l.includes('第一行')), '前两行都不印')

  // 装不下：末行说还剩几行——**少的要说出来**，而且不是从中间挖掉一块。
  const many = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行正文`)
  const cut = frameOf({ ...base, read: { rows: ['标题', ...many], top: 0 } })
  const tailLine = cut.lines.find((l) => l.includes('下面还有'))
  assert.ok(tailLine !== undefined, '装不下时末行要说还剩几行')
  console.log(
    `⑧ 读数：${rows.length} 行全装得下（内容与树都让位）· \`top=2\` 起印第二行 · 61 行时末行「${tailLine?.replace(/[│ ]+$/, '').trim()}」`,
  )
  assert.ok(cut.lines.some((l) => l.includes('第 1 行正文')), '头一行仍在（不是从中间挖掉一块）')
  for (const l of cut.lines) assert.equal(widthOf(l), 80, `每一行都该是 80 列：${JSON.stringify(l)}`)
})

// ── ⑨ 行的角色（U20 样式层地基）─────────────────────────────────────────────
test('⑨ 行的角色（U20）：roles 与 lines 平行 · 框线 border · 账尾 footer · 正文 body · 候选与门口 overlay · 阅读面 read · 矮帧报 body', () => {
  const base = { snapshot: snapshotOf(), metrics: METRICS, report: REPORT, width: 100, height: 19 }
  const f = frameOf({
    ...base,
    menu: { rows: ['候选一', '候选二'], sel: 0 },
    bottom: { rows: ['门口那一块 · 第 1/1 份'], keep: 1 },
  })
  assert.equal(f.roles.length, f.lines.length, 'roles 与 lines 平行（逐行对应）')
  assert.equal(f.roles[0], 'border', '头一行是框线')
  assert.equal(f.roles[f.roles.length - 1], 'border', '末行是框线')
  assert.equal(f.roles.filter((r) => r === 'border').length, 3, '框线三行（上下两根 + 账尾那根分隔）')
  const footAt = f.lines.findIndex((l) => l.includes(f.footer))
  assert.ok(footAt >= 0, '账尾那一行找得到')
  assert.equal(f.roles[footAt], 'footer', '账尾那一行报 footer')
  const menuAt = f.lines.findIndex((l) => l.includes('候选一'))
  assert.ok(menuAt >= 0 && f.roles[menuAt] === 'overlay', '候选那一层报 overlay')
  const gateAt = f.lines.findIndex((l) => l.includes('门口那一块'))
  assert.ok(gateAt >= 0 && f.roles[gateAt] === 'overlay', '门口那一块报 overlay')
  const bodyAt = f.lines.findIndex((l) => l.includes('轮次 r1 · 状态'))
  assert.ok(bodyAt >= 0 && f.roles[bodyAt] === 'body', '读数那一行报 body')

  // 阅读面开着：正文那些行报 `read`（临时那一层的另一种）。
  const r = frameOf({ ...base, read: { rows: ['标题', '正文一'], top: 0 } })
  const readAt = r.lines.findIndex((l) => l.includes('正文一'))
  assert.ok(readAt >= 0 && r.roles[readAt] === 'read', '阅读面正文报 read')

  // 矮帧：那句「画不出框」报 body；空帧 roles 是空的。
  const short = frameOf({ ...base, height: 3 })
  assert.equal(short.lines.length, 1, '矮帧只那一行话')
  assert.deepEqual([...short.roles], ['body'], '矮帧那一行报 body')
  assert.deepEqual([...frameOf({ ...base, width: 0, height: 0 }).roles], [], '空帧 roles 空')

  console.log(
    `⑨ 读数：${f.lines.length} 行里 border ×${f.roles.filter((x) => x === 'border').length} · ` +
      `footer ×${f.roles.filter((x) => x === 'footer').length} · overlay ×${f.roles.filter((x) => x === 'overlay').length} · ` +
      '其余 body · 阅读面行报 read · 矮帧报 body',
  )
})
