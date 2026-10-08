// TUI 的第一格：**帧是同一读面的第二档渲染**（架构 § 9.6 的观察行 · 架构 § 8.13 的 `round/state`
// 链 · PLAN § 5.18 的三面表 · § 5.19 第五段）。跑法：cd ~/fugue && node --test src/ui/frame.test.ts
//
// 这一份量的四样：
//
//   ① **黄金帧**：一份固定事件串折出来的快照 → 整帧逐字节等于那一份原文，而且每一行的列宽恰好
//      是 `width`（框对得上，中日韩宽字符那把尺没错）。
//   ② **负对照 · 进展那一档**：账里多一条 `round/state`（一条图上真的走得到的边）→ 它变、
//      **结果与花费那一档逐字节不变**；账尾那条会动——它是全账的读数，不属于任何一档
//      （两档各自读什么写在 `frame.ts` 的头注里，这一条是它的判据）。
//   ③ **负对照 · 结果与花费那一档**：账里多一条 `merge/attempt`（冲突 2）→ 进展那一档
//      逐字节不变、它变。
//   ④ **两档都动的那一条也是对的**：多一次 `llm/call` → 两档都变（调用次数在进展那一档的"每一格"
//      与结果与花费那一档的"用量"各有一处口径）。它说明两档不是按事件类型分的，是按**读法**分的。
//   ⑤ **地板**：窄了收成单栏（同一个框，少中间那根竖线，内容一行不少）· 矮了截断并说出还剩
//      几行 · 三行都不到印一句"太矮"（不静默给空帧）· **三列都不到印一句"太窄"**（`innerOf` 给 0，
//      `'─'.repeat` 会拿到负数）· 尺寸给 0 给一个空帧。
//   ⑥ **纯**：同一份输入两次调用逐字节相同，而且进去的那一份快照一个字段都没被改。
//   ⑦ **候选那一层开的窗**（`windowOf`，`T4` 的 `/` 菜单与 `Ctrl-P` 面板用它）：装得下就全印 · 装不下
//      时**选中的那一条一定在窗里**（贴着头或贴着尾）· 上下各还剩几条数得出来 · 只剩一行可印时不留
//      "还有几条"那一句（那一行留给候选）。
//   ⑧ **阅读面那一栏**（`T9` 的 `ReadInput`）：给 `top` 就从那一行起印 · 装不下时末行说"下面还有几行"
//      （**不截中间**）· 不给它时整帧与从前逐字节相同（这一栏是加出来的，不是改出来的）。
//   ⑩ **一把尺**（0.2.8 U2）：框内宽只有 `innerOf` 一个出处 · 长行**折开印**（旧版由 `cell` 截断，
//      尾巴永远看不见）· `top` 数到的那一行就是屏上第一条正文。
//   ⑪ **层次**（0.2.8 U3）：阅读面那一档收成单栏、框名换「阅读面」，那一行报 `readHeading`
//      （主题里加粗）· 遗漏数算上被那句提示顶掉的一行（`below + 1`）。
//   ⑫ **跳步那一栏**（本站）：左栏印的那个数与命令行那一张脸**同源**（`probe/status.ts` 的
//      `skipsNote`）；自环边吃不掉真跳步 · 图外边不印负数——判据改回 `hops - transitions` 当场红。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import type { StatusRow, StatusSnapshot } from '../probe/status.ts'
import { linesOf, statusOf, usageByRoundOf } from '../probe/status.ts'
import { BUILTIN_CATALOG } from '../model/catalog.ts'
import { bodyOf, footerOf, frameOf, innerOf, panelOf, windowOf } from './frame.ts'
import { FRAME_ROWS } from './layout.ts'
import { clip, setGlyphTier, widthOf, wrap } from './glyph.ts'
import { readWrap } from './read.ts'
import { SLOT_256, ROLE_SLOT, theme256 } from './theme.ts'

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
  "┌─ 对话 ───────────────────────────────────────────────────────────────────────────────────────────┐",
  "│ 正在处理你的任务。                                                                               │",
  "│                                                                                                  │",
  "│                                                                                                  │",
  "│                                                                                                  │",
  "│                                                                                                  │",
  "│                                                                                                  │",
  "├──────────────────────────────────────────────────────────────────────────────────────────────────┤",
  "│ 修改中 · 1 项任务在运行                                                                          │",
  "└──────────────────────────────────────────────────────────────────────────────────────────────────┘"
]
test('① 黄金帧：整帧逐字节等于那一份原文，而且每一行恰好 width 列', () => {
  // 高度取**真终端上框的那 10 行**（`ui/layout.ts` 的 `FRAME_ROWS`，一处真源）：第二幕 ⑦ 起框
  // 自己就填满这一屏，所以这一份黄金帧就是主面在 100 列 × 10 行上的那一眼。
  const f = frameOf({ snapshot: snapshotOf(), metrics: METRICS, report: REPORT, width: 100, height: FRAME_ROWS })
  assert.deepEqual([...f.lines], [...GOLDEN], '帧与黄金那一份不逐字节相同')
  const widths = f.lines.map((l) => widthOf(l))
  assert.deepEqual(widths, f.lines.map(() => 100), `每一行都该是 100 列：${widths.join(',')}`)
  assert.deepEqual(f.columns, { left: 96, right: 0 }, '一栏占满框内（第二幕 ⑦ 之后没有第二栏）')
  assert.equal(f.lines.length, FRAME_ROWS, '框恒填满这一屏（上边 1 + 内容 6 + 分隔 1 + 账尾 1 + 下边 1）：内容那 6 行里够不着的拿空行补足')
  console.log(
    `① 读数：${f.lines.length} 行 · 每行 ${f.width} 列 · 内容那一栏 ${f.columns.left} 列（右 ${f.columns.right}）` +
      ` · 账尾「${f.footer}」· 处境那一档 ${bodyOf({ snapshot: snapshotOf() }).left.length} 行`,
  )
})

test('⑫ 跳步那一栏：两张读脸同一个数、同一句话（判据改回减法当场红）', () => {
  // 自环两条（各一条转移 · 零步）＋ 一条三跳的转移（`Idle ⇒ Working` 是三条边）。
  // 旧判据 `hops - transitions` 在这一档是 3 - 3 = 0——真的跳步被自环抵掉，一个字都不印。
  const loops = statusOf([
    row({ t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: 'Idle' as never }),
    row({ t: 'round/state', round: 'r1' as never, from: 'Planning' as never, to: 'Planning' as never }),
    row({ t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: 'Working' as never }),
  ])
  const left = bodyOf({ snapshot: loops }).left.join('\n')
  assert.match(left, /转移 3 条 · 跳步 2/, `左栏要印真跳步（一条三跳的转移记 2）：${left}`)
  // 命令行那一张脸印的是同一个数、同一句话——两处都从 `probe/status.ts` 的 `skipsNote` 取，
  // 一处做减法两处就一起错（这正是这一条要钉住的）。
  assert.match(linesOf(loops, { cat: BUILTIN_CATALOG }).join('\n'), /转移 3 条 · 跳步 2/)

  // 图外边那一档：旧判据印「跳步 -1」（1 - 2）——负数不是读数；修后 0 那一档不印（恒印 0 那一版
  // 要动 `ui/term.test.ts` 的黄金帧，没采纳），而负数一个都不出现。
  const outside = statusOf([
    row({ t: 'round/state', round: 'r1' as never, from: 'Aborted' as never, to: 'Idle' as never }),
    row({ t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: 'Planning' as never }),
  ])
  const outLeft = bodyOf({ snapshot: outside }).left.join('\n')
  assert.doesNotMatch(outLeft, /跳步/, `图外那一档不印跳步：${outLeft}`)
  assert.doesNotMatch(outLeft, /-\d/, `读面上不许出现负数：${outLeft}`)
})

test('② 负对照 · 进展那一档：多一条 round/state → 它变，结果与花费那一档一字不变（账尾会动，它是全账的读数）', () => {
  const a = snapshotOf()
  const b = snapshotOf([row({ t: 'round/state', round: 'r1' as never, from: 'Working' as never, to: 'Collecting' as never })])
  const fa = bodyOf({ snapshot: a, metrics: METRICS, report: REPORT })
  const fb = bodyOf({ snapshot: b, metrics: METRICS, report: REPORT })
  assert.notDeepEqual([...fa.left], [...fb.left], '多一条边，进展那一档却没变')
  assert.deepEqual([...fa.right], [...fb.right], '结果与花费那一档不该因为一条 round/state 而动')
  // **不再"正好多一行"**（收口后按人令）：那几条原始转移不上主面了——多一条边动的是轮次那一行的
  // 条数。这一条量的还是"进展那一档真的读了它"，只是读的是数，不是那一行原文。
  assert.match(fb.left[0] ?? '', /转移 6 条/, `多一条边，轮次那一行的条数该动：${fb.left[0]}`)
  // 账尾是**全账**的读数：它会动。这一条写出来，免得下一个人把它当成"右栏变了"。
  assert.notEqual(footerOf(a), footerOf(b), '账尾该动（最近一条与条数都变了）')
  console.log(`② 读数：进展那一档 ${fa.left.length} → ${fb.left.length} 行 · 结果与花费那一档 ${fa.right.length} 行一字不变 · 账尾「${footerOf(a)}」→「${footerOf(b)}」`)
})

test('③ 负对照 · 结果与花费那一档：多一条 merge/attempt（冲突 2）→ 它变，进展那一档一字不变', () => {
  const a = snapshotOf()
  const b = snapshotOf([row({ t: 'merge/attempt', round: 'r1' as never, branches: [] as never, conflicts: 2 })])
  const fa = bodyOf({ snapshot: a, metrics: METRICS, report: REPORT })
  const fb = bodyOf({ snapshot: b, metrics: METRICS, report: REPORT })
  assert.deepEqual([...fa.left], [...fb.left], '进展那一档不该因为一条 merge/attempt 而动')
  assert.notDeepEqual([...fa.right], [...fb.right], '多一条合并尝试，结果与花费那一档却没变')
  assert.match(fb.right[0] ?? '', /合并试了 2 次 · 冲突 2/, `它那一行的两个数都该动：${fb.right[0]}`)
  console.log(`③ 读数：结果与花费那一档那一行「${fb.right[0]}」· 进展那一档 ${fa.left.length} 行一字不变`)
})

test('④ 多一次 llm/call：两档都动（调用次数在两边各有一处口径——分的是读法，不是事件类型）', () => {
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
  assert.notDeepEqual([...fa.left], [...fb.left], '左栏那一条"格"的行该动（调用 2 次 → 3 次）')
  assert.notDeepEqual([...fa.right], [...fb.right], '右栏那一条"用量"的行该动（调用 3 → 4）')
  // 格那一行拆成两行之后（收口后按人令：头一行只说哪一格 · 停在没停，计数在缩进那一行）：
  // **拿缩进那一行当锚**，头一行里已经没有数了。
  assert.match(fb.left.join('\n'), /agent\/r1\/1 · 2 步就停（收敛）\n  调用 3 次 · 走了 3 步/, `左栏那一行的数该动：${fb.left.join(' ｜ ')}`)
  assert.match(fb.right.join('\n'), /用量 调用 4/, `右栏那一行的数该动：${fb.right.join(' ｜ ')}`)
  console.log('④ 读数：进展那一档「调用 3 次 · 3 步」· 结果与花费那一档「用量 调用 4」——同一件事两处口径，两档都动是对的')
})

test('⑤ 地板：窄屏照画（没有第二栏这回事了）· 矮了截断并说出剩几行 · 三行都不到说"太矮" · 尺寸 0 给空帧', () => {
  const snapshot = snapshotOf()
  const narrow = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 40, height: 40 })
  // 第二幕 ⑦ 之后每一档视图**只有一栏**（决策材料问三：各拿满宽）：`right` 恒 0，中间那根竖线没了。
  assert.equal(narrow.columns.right, 0, '没有第二栏')
  assert.equal(narrow.columns.left, innerOf(40), '内容那一栏就是框内宽')
  assert.equal(narrow.lines.some((l) => l.includes('┬')), false, '不该有中间那根竖线')
  const text = narrow.lines.join('\n')
  for (const one of ['正在处理你的任务。', '修改中', '1 项任务在运行']) {
    assert.ok(text.includes(one), `对话视图窄屏那一档少了这一处：${one}`)
  }
  // 另两档在窄屏上也画得出来（折得更勤，一格不丢）——这一条量的是「窄了不丢档」。
  const spend = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 40, height: 40, view: 'spending' }).lines.join('\n')
  assert.ok(spend.includes('任务 2') && spend.includes('用量 调用 3'), `结果与花费视图窄屏上该有记账与用量：\n${spend}`)
  // 账尾是**状态条**：40 列那一档它装不下，从右边截并留一个 `…`（说了它被截过）。截掉的是尾巴上
  // 那半截（`…· 事件 13 条`），留下的是"账在动"那个信号——次序就是为这个排的。
  assert.ok(text.includes('修改中'), '单栏那一档也该有账尾')
  assert.ok(!text.includes('agent/r1/'), '主面不显示内部任务编号')

  // 矮：压到 5 行（`MIN_HEIGHT`，画得出框的下限）——对话视图的内容自己就 4 行，给 8 行装得下、
  // 不会被截，所以这一档要真压到装不下才量得到那句「还有几行没印」。
  const short = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 100, height: 5, conversation: [{ text: '第一段汇报', role: 'body' }, { text: '第二段汇报', role: 'body' }] })
  assert.ok(short.lines.length <= 5, `这一屏只给 5 行，印出来 ${short.lines.length} 行`)
  const cut = short.lines.find((l) => l.includes('还有'))
  assert.ok(cut !== undefined, `截断了却没说出还剩几行：${short.lines.join('\n')}`)
  assert.match(cut as string, /还有 \d+ 行没印/)

  // 连框都画不出：三行。
  const tiny = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 100, height: 3 })
  assert.equal(tiny.lines.length, 1, '画不出框时只印一句')
  assert.match(tiny.lines[0] ?? '', /太矮/)

  // 极窄（1–2 列）：**同一个口径**——`ui/term.ts` 的列宽探测是 `seen > 0` 就放行，1–2 列真会走到
  // 这里。**负对照**：这道提示拿掉，`lines` 就不是一句而是十几行空框（框内 0 列，每行 `││`），
  // 下面第一条当场红。U2 之前那一档还会以 `RangeError` 收场（`inner` 是负的，直接进了 `repeat`）；
  // `innerOf` 把它夹成 0 之后那条抛错没有了——守卫守的因此是"别印一个静默的空框"。
  for (const width of [1, 2]) {
    const thin = frameOf({ snapshot, metrics: METRICS, report: REPORT, width, height: 20 })
    assert.equal(thin.lines.length, 1, `${width} 列：只印一句（不是空帧）`)
    assert.equal(thin.roles.length, 1, '窄帧里 roles 与 lines 也是平行的')
    assert.equal(widthOf(thin.lines[0] as string), width, `${width} 列那一行不许超宽`)
    // 1–2 列上**那一句原因自己也印不出来**（框内一列都没有），留下的是 `…`——与截断那一条同一个
    // 记号，说的是"这里还有东西没印出来"。所以这一段的作用是**当场不抛**，不是把话说全。
    assert.equal(
      (thin.lines[0] as string).startsWith('…'),
      true,
      `${width} 列那一行是截断记号：${JSON.stringify(thin.lines[0])}`,
    )
  }
  // 3 列是**边界**：画得出（框内恰一列），每一行仍是 3 列。
  const edge = frameOf({ snapshot, metrics: METRICS, report: REPORT, width: 3, height: 20 })
  assert.equal((edge.lines[0] as string).startsWith('┌'), true, `3 列该画得出框：${edge.lines[0]}`)
  for (const l of edge.lines) assert.equal(widthOf(l), 3, `3 列那一档每一行都是 3 列：${JSON.stringify(l)}`)

  // 终端那一刻没给出尺寸：空帧（调用方那一侧的事）。
  assert.deepEqual(frameOf({ snapshot, width: 0, height: 0 }).lines, [])

  console.log(
    `⑤ 读数：40 列 → 单栏（右 0，${narrow.lines.length} 行，一处内容不少）· 5 行 → 「${(cut as string).split('│').map((x) => x.trim()).filter((x) => x !== '').join(' ｜ ')}」` +
      ` · 3 行 → 「${(tiny.lines[0] as string).replace(/^│|│$/g, '').trim()}」· 0 列 0 行 → ${frameOf({ snapshot, width: 0, height: 0 }).lines.length} 行` +
      ` · 1–2 列 → 「${(frameOf({ snapshot, width: 2, height: 20 }).lines[0] as string).replace(/^│|│$/g, '').trim()}」· 3 列 → 「${edge.lines[0]}」`,
  )
})

test('⑦ 账尾只显示运行状态；永久历史不重复打印到状态栏', () => {
  const snapshot = snapshotOf()
  const permanent = ['round 1 · 轮次 r1 · Idle → Planning', 'round 5 · 轮次 r1 · 合并接受 abcdef01… · 验收 3 条（过 3 / 没过 0）']
  assert.equal(footerOf(snapshot), '修改中 · 1 项任务在运行')
  assert.equal(footerOf(snapshot, []), footerOf(snapshot), '一条永久行都没有时照旧')
  assert.equal(footerOf(snapshot, permanent), footerOf(snapshot), `给了那一列，账尾该是它最后一条：${footerOf(snapshot, permanent)}`)
  const withRow = frameOf({ snapshot, permanent, width: 100, height: 16 })
  assert.equal(withRow.footer, footerOf(snapshot), '整帧状态栏不重复历史')
  assert.equal(withRow.lines.length, frameOf({ snapshot, width: 100, height: 16 }).lines.length, '多这一列不该动行数')
  assert.equal(withRow.footer, frameOf({ snapshot, width: 100, height: 16 }).footer)
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
  const shown = all.lines.filter((l) => l.includes('│ 标题 · 三面之一'))
  assert.equal(shown.length, 1, '标题在（阅读面那一栏是横贯整栏的）')
  assert.ok(all.lines.some((l) => l.includes('第一行')), '第二行也在')
  assert.ok(!all.lines.some((l) => l.includes('轮次 r1 · 状态')), '内容那一栏不印了（地方整块给正文）')
  assert.ok(!all.lines.some((l) => l.includes('主线（round）') || l.includes('格 agent/r1/1')), '树那几行也不印了')
  // **框名与那一行的角色**（0.2.8 U3）：阅读面开着时那个框叫「阅读面」，头一行报 `readHeading`
  // （主题里加粗）——整块地方给它，框就得说它。两栏那两根名字与中间那根竖线一起收掉。
  assert.ok((all.lines[0] as string).includes('阅读面'), `头一行是框名：${all.lines[0]}`)
  assert.equal(all.roles[0], 'readHeading', '框名那一行报 readHeading')
  assert.ok(!all.lines.some((l) => l.includes('┬')), '阅读面那一档收成单栏（不留中间那根竖线）')
  assert.ok(!all.lines.some((l) => l.includes('读数')), '右栏那个名字也不印了')

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
  // **遗漏数算上被那句提示顶掉的一行**（0.2.8 U3 · 判决 7）：这一面 61 行，屏上印了 `printed` 行，
  // 其中**末行被提示换了**——没看见的是 61 − (印 − 1)。旧的写法（不加那一）在这一条上红。
  const printed = cut.roles.filter((r) => r === 'read').length
  const said = Number(/下面还有 (\d+) 行/.exec(tailLine as string)?.[1] ?? '0')
  assert.equal(said, 61 - (printed - 1), `遗漏数要算上被顶掉的那一行（说 ${said} · 印了 ${printed}）`)
  assert.notEqual(said, 61 - printed, '旧版（`below` 不加那一）在这一条上红')
  console.log(
    `⑧ 读数：${rows.length} 行全装得下（内容与树都让位）· \`top=2\` 起印第二行 · 61 行时末行「${tailLine?.replace(/[│ ]+$/, '').trim()}」`,
  )
  assert.ok(cut.lines.some((l) => l.includes('第 1 行正文')), '头一行仍在（不是从中间挖掉一块）')
  for (const l of cut.lines) assert.equal(widthOf(l), 80, `每一行都该是 80 列：${JSON.stringify(l)}`)
})

// ── ⑨ 行的角色（U20 样式层地基）─────────────────────────────────────────────
test('⑨ 行的角色（U20）：roles 与 lines 平行 · 框线 border · 账尾 footer · 正文 body · 候选与门口 overlay · 阅读面 read · 矮帧报 body', () => {
  // 高度 20：这一格量的是「哪些行是哪个角色」，给它几行让块间细线 · 分隔线与账尾都还在
  // （让位那一条由 ① 与 ⑤ 量）。
  const base = { snapshot: snapshotOf(), metrics: METRICS, report: REPORT, width: 100, height: 20 }
  const f = frameOf({
    ...base,
    menu: { rows: ['候选一', '候选二'], sel: 0 },
    bottom: { rows: ['门口那一块 · 第 1/1 份'], keep: 1 },
  })
  assert.equal(f.roles.length, f.lines.length, 'roles 与 lines 平行（逐行对应）')
  assert.equal(f.roles[0], 'border', '头一行是框线')
  assert.equal(f.roles[f.roles.length - 1], 'border', '末行是框线')
  assert.equal(
    f.roles.filter((r) => r === 'border').length,
    3,
    '框线三行（上下两根 + 账尾那根分隔 + 对话视图里那条块间细线——它也是框线那一档的颜色）',
  )
  const footAt = f.lines.findIndex((l) => l.includes(f.footer))
  assert.ok(footAt >= 0, '账尾那一行找得到')
  assert.equal(f.roles[footAt], 'footer', '账尾那一行报 footer')
  const menuAt = f.lines.findIndex((l) => l.includes('候选一'))
  assert.ok(menuAt >= 0 && f.roles[menuAt] === 'overlay', '候选那一层报 overlay')
  const gateAt = f.lines.findIndex((l) => l.includes('门口那一块'))
  assert.ok(gateAt >= 0 && f.roles[gateAt] === 'overlay', '门口那一块报 overlay')
  const bodyAt = f.lines.findIndex((l) => l.includes('正在处理你的任务。'))
  assert.ok(bodyAt >= 0 && f.roles[bodyAt] === 'body', '读数那一行报 body')

  // 阅读面开着：框名那一行报 `readHeading`（U3），正文那些行报 `read`。
  const r = frameOf({ ...base, read: { rows: ['标题', '正文一'], top: 0 } })
  assert.equal(r.roles[0], 'readHeading', '阅读面开着时框名那一行报 readHeading')
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
      '其余 body · 阅读面框名报 readHeading · 阅读面正文报 read · 矮帧报 body',
  )
})
// ── ⑩ 一把尺（0.2.8 U2）：框内宽一个出处 · 长行折开印 · `top` 数到哪一行屏上就是哪一行 ──────────
test('⑩ 一把尺：`innerOf` 是框内宽的唯一出处 · 长行折开印（旧版截断）· 翻到第几行屏上就是那一行', () => {
  const base = { snapshot: snapshotOf(), metrics: METRICS, report: REPORT, height: 19 }

  // **一个出处**：单栏那一档的左栏宽 = `innerOf(width)`；两栏那一档左 + 右 + 框那 3 列 = 整幅。
  for (const width of [30, 60, 100, 137]) {
    const f = frameOf({ ...base, width })
    if (f.columns.right === 0) {
      assert.equal(f.columns.left, innerOf(width), `单栏那一档左栏宽该是 innerOf(${width})`)
    } else {
      assert.equal(f.columns.left + f.columns.right + 3, width, `两栏 + 框 3 列 = 整幅（${width}）`)
    }
  }
  assert.equal(innerOf(2), 0, '2 列时框内宽是 0（`─`.repeat 不许拿到负数）')
  console.log(`⑩ 读数：innerOf(30)=${innerOf(30)} · innerOf(60)=${innerOf(60)} · innerOf(100)=${innerOf(100)}`)

  // **长行折开印**：130 列的正文在 26 列的框里（框内 24），整条都看得见。旧版那一档舞台递的是
  // **未折行的原文**，由框这一层 `cell` 截到 24 列——尾巴永远看不见，而 `top` 仍按 1 逻辑行 =
  // 1 物理行数，"下面还有几行"跟着错。
  const long = `一条很长的正文 ${'x'.repeat(120)} 尾巴`
  const face = ['标题 · 长行', long, '短行']
  const narrow = face.flatMap((l) => [...readWrap(l, innerOf(26))])
  const wide = face.flatMap((l) => [...readWrap(l, innerOf(120))])
  assert.ok(narrow.length > wide.length, `窄列折得多（窄 ${narrow.length} · 宽 ${wide.length}）`)
  assert.equal(narrow.join(''), wide.join(''), '两档拼回来是同一份字节——折的只是行')

  const f = frameOf({ ...base, width: 26, read: { rows: narrow, top: 0 } })
  const shown = f.lines.filter((l) => l.startsWith('│')).map((l) => l.slice(2, -2).trimEnd())
  assert.ok(shown.join('').includes(long), `整条正文都在屏上（一个字节都没被截）：${JSON.stringify(shown)}`)
  // **负对照**：旧版那一串（未折行的原文）在同一个框里被截掉尾巴——上面那一条正是为它写的。
  assert.notEqual(clip(long, innerOf(26)), long, '旧版走 `cell` → `clip`：尾巴没了')
  assert.ok(face.some((l) => widthOf(l) > innerOf(26)), '旧版那一串里有画不进框的行')

  // **翻到第几行**：`top` 数的是同一串物理行——屏上第一条正文就是 `rows[top]`。
  for (const top of [0, 1, 4, narrow.length - 1]) {
    const g = frameOf({ ...base, width: 26, read: { rows: narrow, top } })
    const body = g.lines.filter((l) => l.startsWith('│')).map((l) => l.slice(2, -2).trimEnd())
    assert.equal(body[0], narrow[top], `翻到第 ${top} 行：屏上第一条就是它`)
  }
  console.log(
    `⑩ 读数：130 列的正文在框内 ${innerOf(26)} 列里折成 ${readWrap(long, innerOf(26)).length} 行（旧版只印头 ${innerOf(26)} 列）` +
      ` · top 0/1/4/${narrow.length - 1} 屏上第一条都对得上`,
  )
})

test('⑬ 近几轮用量那条小条形（可读性三件 ②）：每轮一格 · 四档从字形档取 · 没有这一栏就同形', () => {
  const ev = (input: number | null): LogEvent => ({
    t: 'llm/call',
    agent: 'agent/r1/1' as never,
    step: 's' as never,
    model: 'deepseek-flash/anthropic' as never,
    wire: 'anthropic-messages',
    toolCount: 0,
    invocations: 0,
    status: null,
    headers: null,
    thinking: null,
    usage: { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: null },
    rawStop: 'end_turn',
    stop: 'end-turn',
  })
  const rows: StatusRow[] = [
    row({ t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: 'Working' as never }),
    row(ev(100), 'agent/r1/1'),
    row({ t: 'round/state', round: 'r2' as never, from: 'Idle' as never, to: 'Working' as never }),
    // 量到 0 的那一轮：条形上就是那一个空格位（列位照旧对齐）。
    row(ev(0), 'agent/r2/1'),
    row({ t: 'round/state', round: 'r3' as never, from: 'Idle' as never, to: 'Working' as never }),
    row(ev(400), 'agent/r3/1'),
  ]
  const snap = statusOf(rows)
  const per = usageByRoundOf(rows)
  const at = { snapshot: snap, permanent: [], width: 100, height: FRAME_ROWS } as const
  const line = bodyOf({ snapshot: snap, usageByRound: per }).right.find((l) => l.includes('轮用量'))
  assert.equal(line, '近 3 轮用量 ░ █（最高 400）', `那一行该逐字是它：${String(line)}`)
  const spent = frameOf({ ...at, view: 'spending', usageByRound: per }).lines.join('\n')
  assert.ok(spent.includes('近 3 轮用量 ░ █（最高 400）'), `读数那一档上该看得见它：\n${spent}`)
  // **退化档**：不给这一栏（或者给个空表）→ 逐字节与从前相同（"没有这一档"就是没有）。
  assert.equal(
    frameOf({ ...at, view: 'spending', usageByRound: [] }).lines.join('\n'),
    frameOf({ ...at, view: 'spending' }).lines.join('\n'),
    '空表与不给该逐字节同形',
  )
  assert.ok(!frameOf({ ...at, view: 'spending' }).lines.join('\n').includes('轮用量'), '不给就不印')
  // 只给得到一轮：一个格子的趋势不算趋势。
  assert.equal(
    bodyOf({ snapshot: snap, usageByRound: usageByRoundOf(rowsOf()) }).right.some((l) => l.includes('轮用量')),
    false,
    '一轮不印',
  )
  // 另两档不印它（那一条是读数那一档的话）。
  assert.ok(!frameOf({ ...at, view: 'progress', usageByRound: per }).lines.join('\n').includes('轮用量'), '进展那一档不印')
  assert.ok(!frameOf({ ...at, usageByRound: per }).lines.join('\n').includes('轮用量'), '对话那一档不印')
  // 四档从字形档取一处：`ascii` 那一档用 `.` 与 `#`。
  const was = setGlyphTier('ascii')
  try {
    assert.equal(
      bodyOf({ snapshot: snap, usageByRound: per }).right.find((l) => l.includes('轮用量')),
      '近 3 轮用量 . #（最高 400）',
      'ascii 档该用 ASCII 那几格（条形的四档也住字形档一处）',
    )
  } finally {
    setGlyphTier(was)
  }
  console.log(`⑬ 读数：${String(line)} · ascii 档「近 3 轮用量 . #（最高 400）」· 没量到那一栏在括号里 · 不给这一栏逐字节同形`)
})

test('⑭ 门口要按的那一行（第三幕 ①）：给了坐标就报 waiting，不给就与从前逐字节相同', () => {
  const base = { snapshot: snapshotOf(), width: 100, height: 14 } as const
  const rows = ['写路径：src/ui/frame.ts', '还有 1 份等你点头 · 第 1/1 份（↑↓ 翻）', '放行一次(y) · 拒(n) · 中止(Esc)']
  const after = frameOf({ ...base, bottom: { rows, keep: 2, waitingAt: 2 } })
  const at = (f: { readonly lines: readonly string[] }, s: string): number => f.lines.findIndex((l) => l.includes(s))
  assert.equal(after.roles[at(after, '写路径')], 'overlay', '预览走弹层那一格')
  assert.equal(after.roles[at(after, '等你点头')], 'overlay', '排队行也还走弹层那一格')
  assert.equal(after.roles[at(after, '放行一次(y)')], 'waiting', '要人此刻按的那一行走等待那一格（宪法 ②）')
  // **退化档**：不给坐标（或坐标越界）→ 文字与从前逐字节相同，角色整块还是弹层那一格。
  const before = frameOf({ ...base, bottom: { rows, keep: 2 } })
  assert.deepEqual([...before.lines], [...after.lines], '文字一个字节都不该差（这一栏是加出来的）')
  assert.deepEqual(
    [...before.roles],
    [...after.roles.map((r) => (r === 'waiting' ? 'overlay' : r))],
    '角色只差那一格',
  )
  const out = frameOf({ ...base, bottom: { rows, keep: 2, waitingAt: 9 } })
  assert.deepEqual([...out.roles], [...before.roles], '坐标越界 = 没给（不报错、也不猜）')
  // **让位是从头切的**：矮屏上预览被切掉，末 `keep` 行还在，那一行仍报 waiting（坐标按"离末行几个"算）。
  const short = frameOf({ ...base, height: 5, bottom: { rows, keep: 2, waitingAt: 2 } })
  assert.equal(short.roles[at(short, '放行一次(y)')], 'waiting', '矮屏上那一行仍是等待那一格')
  assert.equal(short.roles[at(short, '写路径')], undefined, '预览那一行该先让位（它不在了）')
  // 那一格在第 2 级上真的是等待黄，而且是从表推的（不手抄一个 SGR）。
  assert.equal(ROLE_SLOT.waiting, 'waiting', '`waiting` 角色落在等待那一格')
  assert.equal(theme256().waiting, SLOT_256.waiting, '第 2 级那一份从 `SLOT_256` 推')
  assert.equal(SLOT_256.waiting, '\x1b[38;5;214m', '等待黄是 214（第三幕 ① 的取值依据在 `theme.ts`）')
  console.log(
    `⑭ 读数：门口 ${rows.length} 行里末一行报 waiting（第 2 级 ${JSON.stringify(SLOT_256.waiting)}）· ` +
      '不给坐标与给越界坐标都与从前逐字节相同 · 矮屏上让位的是预览',
  )
})


test('正文统一留白、长内容不挤走账尾；极窄档保留完整几何', () => {
  for (const width of [3, 4, 5, 20, 40, 100]) {
    const f = frameOf({ snapshot: snapshotOf(), width, height: FRAME_ROWS, view: 'spending' })
    assert.equal(f.lines.length, FRAME_ROWS)
    assert.equal(f.roles.filter((r) => r === 'footer').length, 1)
    for (const line of f.lines) assert.equal(widthOf(line), width)
    if (width >= 5) {
      for (const [i, line] of f.lines.entries()) {
        if (f.roles[i] !== 'border') assert.ok(line.startsWith('│ ') && line.endsWith(' │'))
      }
    }
  }
})


test('对话只显示最近汇报；内部编号与调用计数留在进展视图', () => {
  const snapshot = snapshotOf()
  const conversation = [
    { text: '任务：「改善终端阅读体验」', role: 'body' as const },
    { text: '验收通过：3 项。', role: 'ok' as const },
    { text: '已拒绝越界写入：src/private.ts', role: 'refuse' as const },
  ]
  const main = frameOf({ snapshot, conversation, width: 100, height: FRAME_ROWS, focus: 'agent/r1/1' })
  assert.ok(main.lines.some((l) => l.includes('改善终端阅读体验')))
  assert.ok(!main.lines.join('').includes('agent/r1/'))
  assert.ok(!main.lines.join('').includes('工具调用'))
  assert.ok(main.roles.includes('ok') && main.roles.includes('refuse'))
  const details = frameOf({ snapshot, width: 100, height: 30, view: 'progress' }).lines.join('')
  assert.ok(details.includes('agent/r1/1') && details.includes('调用'))
})
