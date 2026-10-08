// W11 的断言：`status --once` 与 `watch --follow` 这两个读面（PLAN § 5.18 的两个新单元 ·
// 架构 § 9.6 的观察行 · 架构 § 8.15 的"**不采集，只重算**" · § 8.13 的 `round/state` 链）。
// 跑法：cd ~/fugue && node --test src/probe/status.test.ts
//
//   ① 重放：一串 `round/state` 走过去 → 状态 · 转移条数 · 打回次数都对；而且**打回那一个数与
//      `probe/round.ts` 的判据同值**（同一个数不许有两份写法）
//      · **实测那一趟的形状**（四条事件 · 其中一条跳步）照原样重放：状态是最后那一句、跳步那一条
//      把中间几步从图上找回来——账记的**不是一条路径**（`round/execute.ts:424` 落的是收尾那一条）
//      · 负对照：图外的一对 → 不抛、记进 `unrouted`；图上根本没有的路（`Aborted` 出发）→ `routeOf` 给 null
//   ② 用量缺项**不拿 0 顶**：没量到的进 `missing`，它与"量到 0"分得开
//   ③ `denies` 与 `probe/round.ts` 数出来的 `denied` 同值（同一句话的第二处写法，钉住）
//   ④ 同一串事件折两次 → 同一份快照（可复核性那条验证性质）
//   ⑤ `readNew` 两趟不重不漏，**其中一条落在晚出现的 writer 上**——它就是全局 `fromSeq` 会漏掉的
//      那一档（负对照：`readMerged(3)` 拿不到它）
//   ⑥ `follow` 到点就停（信号拨一下），而且**两条读面都是纯读**：走一遍之后日志目录逐字节不变
//   ⑦ **越界那一栏**：`bound/deny` 按由头分组 + 内核那一档，两者相加是 `total`；而**三数看不见
//      视图那一侧的拒**（那几条工具不落 `run/end`）——这一条把"那一栏没有生产者"钉住
//      · 负对照：抹掉那三条 `bound/deny` → 越界只剩内核那一档
//   ⑧ **树那一侧那一栏**（`mat/reclaim` 里 `changed` 非空）与"被挡"分开：`rows` 是报了几条 ·
//      `paths` 是去重排序之后的路径集；`changed` 为空的那几条不算（那是"照例读到空集"那个读数）
//      · 负对照：抹掉那几条 → 0 与空
//   ⑨ **逐趟账**（`--report` 那一栏 · PLAN § 5.9 的 `G5`）：每一条 `llm/call` 一行，末行是合计；
//      半截的流（`stop` 为 `null`）印「这一趟没走完」；没量到的印「未量到」；**没给峰谷档就说
//      钱没印**（少印要说）；给了档则逐趟与合计各一笔钱——合计那个数与 `costOf` 同源
//   ⑩ **序 32 的那个出口**（`status --once --metrics --report`）：那两栏与跑完那一档**同一个数 ·
//      同一个渲染**；没要的那一栏不出现（不是空数组）；账动两边一起动
//   ⑪ **范围写进读数**：`conflicts` 与 `rejects` 带 `[本轮]`（递了轮次时）· `denied` 两处都是
//      `[整账]`（`run/end` 事件里没有轮次那一栏）——⑩ 两边递的都是空范围，看不见这一层
//   ①d **跳步按边数**（本站）：图外边（一条转移零步）不再印「跳步 -1」，0 那一档不印（**恒印 0 那一版
//      是远端那一支的做法，没采纳**——它要动 `ui/term.test.ts` 的黄金帧，见疑点清单）· 自环边
//      （一条转移 · 零步）不许把别的转移里真的跳步抵掉；两条都点名旧判据 `hops - transitions`——
//      改回减法这两条当场红。跳步那一栏的字只有一处（`skipsNote`），`ui/frame.ts` 读的是同一处。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { AgentId, RoundId } from '../terms.ts'
import { computeAll, computeMerged, linesOfReadings } from './round.ts'
import type { MetricReading } from './round.ts'
import { computeAllMetrics, lineOf } from './metrics.ts'
import {
  METRICS_HEAD,
  REPORT_HEAD,
  callLinesOf,
  causeOf,
  linesOf,
  readings,
  readingsLines,
  routeOf,
  rowsOf,
  snapshot,
  statusOf,
} from './status.ts'
import { readingsOf } from './status.ts'
import type { StatusRow } from './status.ts'
import { BUILTIN_CATALOG } from '../model/catalog.ts'
import { follow, readNew } from './watch.ts'
import { LEDGER_HEAD } from './ledger.ts'
import { FLAGS_OF } from '../cli/flags.ts'

let seq = 0
/** 一条 `round` 那一份上的事件（纯函数那几条用不着真日志）。 */
const row = (e: LogEvent, w = 'round'): StatusRow => ({ pos: { writer: w, seq: (seq += 1) }, e })

/** 一条走完整整九步的轮次链（含一次打回）。**逐步对着 `machine.ts` 的图读。** */
function chain(round: RoundId, steps: readonly [string, string][]): StatusRow[] {
  return steps.map(([from, to]) => row({ t: 'round/state', round, from: from as never, to: to as never }))
}

const FULL: readonly [string, string][] = [
  ['Idle', 'Planning'],
  ['Planning', 'Delegated'],
  ['Delegated', 'Working'],
  ['Working', 'Collecting'],
  ['Collecting', 'Merging'],
  ['Merging', 'Verifying'],
  // 第一次验收没过：那条回边**回到 `Working`**，所以第二轮要从 `Working` 重新走到 `Verifying`——
  // 链必须接得上（打回不是"原地再来一次验收"，是"回到干活那一档"）。
  ['Verifying', 'Working'],
  ['Working', 'Collecting'],
  ['Collecting', 'Merging'],
  ['Merging', 'Verifying'],
  ['Verifying', 'Committed'],
  ['Committed', 'Rebuilding'],
]

/** 一次调用：**用量四个数都可缺**，缺了是 `null`（`B1` 的那一条）。 */
function call(agent: string, step: string, invocations: number, cacheRead: number | null): LogEvent {
  return {
    t: 'llm/call',
    agent: agent as AgentId,
    step: step as never,
    model: 'deepseek-flash/anthropic' as never,
    wire: 'anthropic-messages',
    toolCount: 9,
    invocations,
    status: null,
    headers: null,
    // 这一栏（序 27 起）：**声明的是哪一档思考**，`null` = 声明里没写。
    thinking: 'high',
    usage: { inputTokens: null, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: null },
    rawStop: 'end_turn',
    stop: 'end-turn',
  }
}

test('① 重放：状态 · 转移 · 打回，与 probe/round.ts 那一个数同值', () => {
  const rows = chain('r1' as RoundId, FULL)
  const s = statusOf(rows)
  assert.equal(s.rounds.length, 1)
  assert.equal(s.rounds[0]?.state, 'Rebuilding')
  assert.equal(s.rounds[0]?.transitions, 12)
  assert.equal(s.rounds[0]?.hops, 12, '全程都是一条边一步')
  assert.equal(s.rounds[0]?.unrouted, 0)
  assert.equal(s.rounds[0]?.rejects, 1, 'Verifying → Working 那一条回边该数一次')
  assert.equal(s.current, 'r1')
  assert.deepEqual(
    s.rounds[0]?.edges[6],
    'Verifying ──verdict-fail──> Working',
    '第 7 步该是打回那一条，且把触发它的边名一并印出来',
  )
})

test('①b 实测那一趟的形状：账记的不是一条路径（跳步要能从图上找回来）', () => {
  // **逐字是打桩那一趟两个格跑出来的四条**（`round run '写两份文件' --max-steps 3`）：
  // 中间 `Working → Collecting → Merging → Verifying` 与 `Committed → Rebuilding` 一条都没落，
  // 而收尾那一条的 `from` 是字面量 `Verifying`、`to` 已经跨过两条边。
  const real: readonly [string, string][] = [
    ['Idle', 'Planning'],
    ['Planning', 'Delegated'],
    ['Delegated', 'Working'],
    ['Verifying', 'Rebuilding'],
  ]
  const s = statusOf(chain('r1' as RoundId, real))
  assert.equal(s.rounds[0]?.state, 'Rebuilding', '状态取账上最后那一句')
  assert.equal(s.rounds[0]?.transitions, 4)
  assert.equal(s.rounds[0]?.hops, 5, '三条单边 + 一条两跳')
  assert.equal(s.rounds[0]?.unrouted, 0)
  assert.deepEqual(s.rounds[0]?.edges.slice(3), ['Verifying ⇒ Rebuilding（跳步，经 verdict-pass · advanced）'])
  // 人读那几行把跳步印出来（读面不许把"账与图对不上"咽下去）。
  assert.match(linesOf(s, { cat: BUILTIN_CATALOG }).join('\n'), /跳步，经 verdict-pass · advanced/)
})

test('①c 负对照：图外的记数不炸；图上没有的路 routeOf 给 null', () => {
  // 一步就是一条边的那一条：图上没有就当场拒（`machine.ts` 的纪律）。
  assert.throws(() => causeOf('Idle' as never, 'Committed' as never), /图上没有这条边：Idle ──> Committed/)
  // `Aborted` 没有出边：走不通，如实给 null。
  assert.equal(routeOf('Aborted' as never, 'Idle' as never), null)
  // 读面对"图上走不通的那一对"**不抛**：记进 `unrouted`，照样把别的读出来。
  const s = statusOf(chain('r1' as RoundId, [['Aborted', 'Idle']]))
  assert.equal(s.rounds[0]?.unrouted, 1)
  assert.equal(s.rounds[0]?.state, 'Idle')
  assert.match(linesOf(s, { cat: BUILTIN_CATALOG }).join('\n'), /图上没有这条路/)
  // 状态本身不认识 → 账坏了，当场拒。
  assert.throws(() => statusOf(chain('r1' as RoundId, [['Idle', 'Dreaming']])), /不认识的轮次状态/)
})

test('①d 跳步按边数：图外边不印负数 · 自环吃不掉真跳步（判据改回减法这两条当场红）', () => {
  // ── 形态一 · 图外边：一条转移在图上走不通（零步）＋一条单边。
  // 旧判据 `hops - transitions` 在这一档印的是「跳步 -1」（1 - 2）——负数，而且它不是读数。
  const outside = statusOf(chain('r1' as RoundId, [['Aborted', 'Idle'], ['Idle', 'Planning']]))
  assert.equal(outside.rounds[0]?.transitions, 2)
  assert.equal(outside.rounds[0]?.hops, 1, '图外那一条零步 · 另一条一步')
  assert.equal(outside.rounds[0]?.unrouted, 1, '图外是另一种事实，它自己有一栏')
  assert.equal(outside.rounds[0]?.skips, 0, '图外边不许掺进跳步，也不许把别的抵成负数')
  const outsideLine = linesOf(outside, { cat: BUILTIN_CATALOG }).join('\n')
  // 0 那一档不印（恒印 0 那一版要动 `ui/term.test.ts` 的黄金帧，没采纳；见 `skipsNote` 的说明）。
  assert.doesNotMatch(outsideLine, /跳步/, `图外那一档不印跳步：${outsideLine}`)
  assert.doesNotMatch(outsideLine, /-\d/, `读面上不许出现负数：${outsideLine}`)

  // ── 形态二 · 自环边加真跳步：两条自环（一条转移 · 零步）＋一条三跳的转移。
  // 旧判据在这一档是 3 - 3 = 0 →「有跳步」那句话一个字都不印（真的跳步被自环抵掉了）。
  const loops = statusOf(chain('r1' as RoundId, [['Idle', 'Idle'], ['Planning', 'Planning'], ['Idle', 'Working']]))
  assert.equal(loops.rounds[0]?.transitions, 3)
  assert.equal(loops.rounds[0]?.hops, 3, '两条自环零步 ＋ 一条三跳')
  assert.equal(loops.rounds[0]?.unrouted, 0)
  assert.equal(loops.rounds[0]?.skips, 2, '自环自己不是跳步，也不许把那条三跳的转移抵掉')
  const loopsLine = linesOf(loops, { cat: BUILTIN_CATALOG }).join('\n')
  assert.match(loopsLine, /跳步 2/, `真跳步要被印出来：${loopsLine}`)
  // 同一份账那两张读脸读的是同一个数（`ui/frame.ts` 那一处也走 `skipsNote`）。
  assert.equal(loops.rounds[0]?.skips, 2)
})

test('② 用量缺项不拿 0 顶：没量到的进 missing', () => {
  seq = 0
  const rows = [
    row(call('agent/r1/1', '0', 1, 300), 'agent/r1/1'),
    row(call('agent/r1/1', '1', 0, null), 'agent/r1/1'),
    row(call('agent/r1/1', '2', 2, null), 'agent/r1/1'),
  ]
  const s = statusOf(rows)
  assert.equal(s.usage.calls, 3)
  assert.deepEqual(s.usage.cacheReadTokens, { total: 300, missing: 2 })
  // `inputTokens` 三条都没报：`total` 是 0，而 `missing` 是 3——**这两件事分得开**。
  assert.deepEqual(s.usage.inputTokens, { total: 0, missing: 3 })
  assert.deepEqual(s.usage.cacheWriteTokens, { total: 0, missing: 0 }, '报回 0 与没报是两件事')
  // 一格那一栏也一起看：三次调用 · 三步 · 三次工具调用。
  assert.equal(s.agents.length, 1)
  assert.deepEqual(
    { calls: s.agents[0]?.calls, steps: s.agents[0]?.steps, invocations: s.agents[0]?.invocations },
    { calls: 3, steps: 3, invocations: 3 },
  )
})

test('③ denies 与 probe/round.ts 的 denied 同值', async () => {
  seq = 0
  const rows = [
    row({ t: 'run/start', agent: 'agent/r1/1' as AgentId, step: '0' as never, action: 'bash', argv0: '/bin/sh' }, 'agent/r1/1'),
    row({ t: 'run/end', agent: 'agent/r1/1' as AgentId, step: '0' as never, exit: 0, ms: 1, denied: true }, 'agent/r1/1'),
    row({ t: 'run/end', agent: 'agent/r1/1' as AgentId, step: '1' as never, exit: 0, ms: 1, denied: false }, 'agent/r1/1'),
    row({ t: 'bound/deny', agent: 'agent/r1/1' as AgentId, path: '/etc/passwd', space: 'virtual', rule: 'reach' }, 'agent/r1/1'),
  ]
  const s = statusOf(rows)
  const reading = await computeMerged(
    (async function* () {
      for (const r of rows) yield r
    })(),
    {},
    'denied',
  )
  assert.equal(s.agents[0]?.denies, reading.count)
  assert.equal(s.agents[0]?.denies, 1)
  // **边界挡的那一栏与内核拒的那一栏分开**：一个是围栏，一个是内核。
  assert.equal(s.agents[0]?.bounds, 1)
  assert.equal(s.agents[0]?.actions, 1)
})

test('④ 同一串事件折两次 → 同一份快照', () => {
  seq = 0
  const rows = [
    ...chain('r1' as RoundId, FULL),
    row(call('agent/r1/1', '0', 1, 1920), 'agent/r1/1'),
    row({ t: 'contract/issue', round: 'r1' as RoundId, contract: 'c1' as never, owner: 'agent/r1/1' as AgentId, paths: [], body: '{}' }),
    row({ t: 'agent/stop', agent: 'agent/r1/1' as AgentId, steps: 1, stopped: '收敛', handoffs: 0 }, 'agent/r1/1'),
  ]
  const a = statusOf(rows)
  const b = statusOf(rows)
  assert.deepEqual(a, b)
  assert.equal(a.contracts, 1)
  assert.equal(a.agents[0]?.stopped, '收敛')
  assert.equal(a.agents[0]?.stopSteps, 1)
  // 人读那几行要把这几样印出来（`--once` 的正面就是它）。
  const text = linesOf(a, { cat: BUILTIN_CATALOG }).join('\n')
  assert.match(text, /状态 Rebuilding/)
  assert.match(text, /停：1 步 · 收敛/)
  assert.match(text, /cacheRead 1,920/)
})

test('⑤ readNew 两趟不重不漏，晚出现的 writer 那一档在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'))
  try {
    const log = openLog(dir, { sync: 'each' })
    const round = 'round' as never
    await log.append(round, { t: 'round/intent', round: 'r1' as RoundId, digest: 'd', body: '{}' })
    await log.append(round, { t: 'round/state', round: 'r1' as RoundId, from: 'Idle', to: 'Planning' })
    await log.append(round, { t: 'round/state', round: 'r1' as RoundId, from: 'Planning', to: 'Delegated' })
    // 第一趟：账上已有的三条。
    const p1 = await readNew(log, {})
    assert.equal(p1.rows.length, 3)
    assert.deepEqual(p1.cursors, { round: 3 })
    // 第二趟之前：**新开一个 writer**（第二个 agent 的日志口就是这么开的），它的第一条是 `seq = 1`。
    await log.append('agent-2' as never, {
      t: 'agent/stop',
      agent: 'agent/r1/2' as AgentId,
      steps: 2,
      stopped: '收敛',
      handoffs: 0,
    })
    await log.append(round, { t: 'round/state', round: 'r1' as RoundId, from: 'Delegated', to: 'Working' })
    const p2 = await readNew(log, p1.cursors)
    assert.equal(p2.rows.length, 2, '晚出现的 writer 那一条 + 老 writer 的那一条')
    assert.deepEqual(
      p2.rows.map((r) => `${r.pos.writer}/${r.pos.seq}`).sort(),
      ['agent-2/1', 'round/4'],
    )
    assert.deepEqual(p2.cursors, { round: 4, 'agent-2': 1 })
    // 第三趟：没有新的，一条都不给（游标不退回）。
    const p3 = await readNew(log, p2.cursors)
    assert.equal(p3.rows.length, 0)
    assert.deepEqual(p3.cursors, p2.cursors)
    // **负对照**：全局 `fromSeq` 那一条（`readMerged(3)`）拿不到 `agent-2/1`——它就是这一档会漏的
    // 那一条。跟随的游标因此是**每 writer 一个**，不是全局一个。
    const viaFromSeq: string[] = []
    for await (const { pos } of log.readMerged(3)) viaFromSeq.push(`${pos.writer}/${pos.seq}`)
    assert.deepEqual(viaFromSeq, ['round/4'], '全局 fromSeq 会把晚出现的 writer 整段漏掉')
    await log.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑥ follow 到点就停；两条读面都是纯读（日志逐字节不变）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'))
  try {
    const log = openLog(dir, { sync: 'each' })
    const round = 'round' as never
    for (const [from, to] of FULL.slice(0, 3)) {
      await log.append(round, { t: 'round/state', round: 'r1' as RoundId, from: from as never, to: to as never })
    }
    await log.close()

    /** 日志目录的指纹：文件名 + 字节（**读面走一遍之后必须一模一样**）。 */
    const fingerprint = (): string => {
      const h = createHash('sha256')
      const walk = (d: string, prefix: string): void => {
        for (const name of readdirSync(d).sort()) {
          const p = join(d, name)
          if (statSync(p).isDirectory()) walk(p, prefix + name + '/')
          else h.update(prefix + name + '\0').update(readFileSync(p))
        }
      }
      walk(join(dir, '.fugue'), '')
      return h.digest('hex')
    }
    const before = fingerprint()

    const ac = new AbortController()
    const got: string[] = []
    for await (const batch of follow(openLog(dir), { intervalMs: 5, signal: ac.signal })) {
      for (const r of batch) {
        got.push(`${r.pos.writer}/${r.pos.seq}`)
        if (got.length === 3) ac.abort()
      }
    }
    assert.deepEqual(got, ['round/1', 'round/2', 'round/3'])

    // 纯读两份一起看：`snapshot` 走一遍也不留痕迹。
    const s = await snapshot(openLog(dir))
    assert.equal(s.events, 3)
    assert.equal(s.rounds[0]?.state, 'Working')

    assert.equal(fingerprint(), before, '读面不许写日志（一个字节都不许）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ⑦ 越界那一栏（样本盘第九趟真档照出来的那个缺口）──────────────────────────────────
//
// 由头：那一趟 `agent/r1/5` 伸手写 `src/total.ts` 与 `src/format.ts`，两次都被 `contract-scope`
// 挡下（`bound/deny` 各一条），而 `ledger.tsv` 的越界那一栏读的是 `denied`——**视图层那几条工具
// 不落 `run/end`**（`capability/dispatch.ts` 里只有执行层那一格才落那一对事件），于是那两次一条
// 都没进那三个数。而架构 § 8.13.a 那一栏（越界率）要的正是它："子 agent 想写契约没声明的地方"。
// 这一条把它单独立成一个读数：**三数不动**（那是打回），越界按由头分组。

test('⑦ 越界那一栏：`bound/deny` 按由头分组 + 内核那一档；三数看不见视图那一侧的拒', async () => {
  seq = 0
  const rows = [
    row({ t: 'bound/deny', agent: 'agent/r1/5' as AgentId, path: 'src/total.ts', space: 'virtual', rule: 'contract-scope' }, 'agent/r1/5'),
    row({ t: 'bound/deny', agent: 'agent/r1/5' as AgentId, path: 'src/format.ts', space: 'virtual', rule: 'contract-scope' }, 'agent/r1/5'),
    row({ t: 'bound/deny', agent: 'agent/r1/1' as AgentId, path: '/etc/passwd', space: 'virtual', rule: 'fence:reach' }, 'agent/r1/1'),
    row({ t: 'run/start', agent: 'agent/r1/2' as AgentId, step: '0' as never, action: 'bash', argv0: '/bin/sh' }, 'agent/r1/2'),
    row({ t: 'run/end', agent: 'agent/r1/2' as AgentId, step: '0' as never, exit: 1, ms: 1, denied: true }, 'agent/r1/2'),
  ]
  const s = statusOf(rows)

  // 一 · 两个来源都在，按由头分得开（次序是排过的：同一个数不许有两份写法）。
  assert.equal(s.refusals.total, 4)
  assert.equal(s.refusals.kernel, 1)
  assert.deepEqual(
    s.refusals.byRule,
    [
      { rule: 'contract-scope', count: 2 },
      { rule: 'fence:reach', count: 1 },
    ],
    `按由头分组：${JSON.stringify(s.refusals.byRule)}`,
  )

  // 二 · **三数看不见视图那一侧的拒**——那就是这一栏要单独立起来的理由。
  const three = await computeMerged(
    (async function* () {
      for (const r of rows) yield r
    })(),
    {},
    'denied',
  )
  assert.equal(three.count, 1, '三数里的 denied 只有内核那一档')
  assert.equal(s.refusals.total - s.refusals.kernel, 3, '三条 bound/deny 都不在那三个数里')

  // 三 · 人面那一行把两半都印出来。
  const line = linesOf(s, { cat: BUILTIN_CATALOG }).find((l) => l.startsWith('越界 '))
  assert.ok(
    line !== undefined && line.includes('被挡 4') && line.includes('内核拒 1') && line.includes('contract-scope 2'),
    `人面那一行：${String(line)}`,
  )

  // 四 · 负对照：抹掉那三条 `bound/deny` → 越界只剩内核那一档（读数由那些事件产出，不是别处来的）。
  const bare = statusOf(rows.filter((r) => r.e.t !== 'bound/deny'))
  assert.equal(bare.refusals.total, 1)
  assert.deepEqual(bare.refusals.byRule, [])
  console.log(
    `⑦ 读数：越界 ${s.refusals.total} 次（内核 ${s.refusals.kernel} · ` +
      `${s.refusals.byRule.map((r) => `${r.rule} ${r.count}`).join(' · ')}）· 同一份日志三数里 denied ${three.count}`,
  )
})

// ── ⑧ 树那一侧的越界（样本盘第九趟 · `agent/r1/4` 那四条里的真信号）────────────────────
//
// 由头：那一格的 `mat/reclaim` 报了四条，三条是同一条路径（`__probe.txt`——它往树里写了一个
// 探针文件，随后自己 `rm -f` 掉了），一条是祖先白障的噪声（那一档已清，见 `ca8e246`）。
// 真信号那三条今天哪里都不去：回收不收它（对，声明集外的就是不该收），三数与 `refusals` 也
// 看不见它（那两栏量的是"被挡"）。它单独一栏，与"被挡"分开读。

test('⑧ 树那一侧的越界：`mat/reclaim` 里 `changed` 非空的那几条，与"被挡"分开', () => {
  seq = 0
  const rows = [
    row({ t: 'mat/reclaim', agent: 'agent/r1/4' as AgentId, declared: ['legacy/old-format.js'] as never[], changed: ['__probe.txt'] as never[] }, 'agent/r1/4'),
    row({ t: 'mat/reclaim', agent: 'agent/r1/4' as AgentId, declared: ['legacy/old-format.js'] as never[], changed: ['__probe.txt'] as never[] }, 'agent/r1/4'),
    // **`changed` 为空的那一条不是越界**：它是"照例读到空集"那个读数（默认档每次运行都取）。
    row({ t: 'mat/reclaim', agent: 'agent/r1/1' as AgentId, declared: [] as never[], changed: [] as never[] }, 'agent/r1/1'),
    // 同一格跑几趟会把同一条路径再报一次：`rows` 是几趟，`paths` 才是"动过哪儿"。
    row({ t: 'mat/reclaim', agent: 'agent/r1/2' as AgentId, declared: [] as never[], changed: ['__probe.txt', 'stray/x'] as never[] }, 'agent/r1/2'),
    row({ t: 'bound/deny', agent: 'agent/r1/5' as AgentId, path: 'src/total.ts', space: 'virtual', rule: 'contract-scope' }, 'agent/r1/5'),
  ]
  const s = statusOf(rows)

  assert.equal(s.outside.rows, 3, '三条 `changed` 非空')
  assert.deepEqual(s.outside.paths, ['__probe.txt', 'stray/x'], '去重排序之后的路径集')

  // **两栏分开**：被挡的那一次不进这一栏，报出来的这几条也不进那一栏。
  assert.equal(s.refusals.total, 1)
  assert.equal(s.refusals.byRule[0]?.rule, 'contract-scope')
  assert.equal(s.outside.paths.includes('src/total.ts'), false, '被挡的那一条没落进树里')

  const line = linesOf(s, { cat: BUILTIN_CATALOG }).find((l) => l.startsWith('越界 '))
  assert.ok(
    line !== undefined && line.includes('被挡 1 次') && line.includes('树上报了没挡的 3 条') && line.includes('__probe.txt'),
    `人面那一行：${String(line)}`,
  )

  // 负对照：抹掉那几条 `mat/reclaim` → 这一栏回到 0 与空。
  const bare = statusOf(rows.filter((r) => r.e.t !== 'mat/reclaim'))
  assert.equal(bare.outside.rows, 0)
  assert.deepEqual(bare.outside.paths, [])
  console.log(`⑧ 读数：树上报了没挡的 ${s.outside.rows} 条（${s.outside.paths.join(' · ')}）· 被挡 ${s.refusals.total} 次`)
})

test('⑨ 逐趟账：每一条 `llm/call` 一行 + 合计；半截的流与"没给档"都印出来，不拿 0 顶', () => {
  const rows = [
    row(call('agent/r1/1', '0', 1, 1920), 'agent/r1/1'),
    // 半截的流：`stop` 是 `null`（`cut-stream`）。**不许当"走完了"**，所以它有自己的写法。
    row({ ...(call('agent/r1/1', '1', 0, 1920) as object), stop: null, rawStop: null } as LogEvent, 'agent/r1/1'),
  ]
  // **没给档**：逐趟与合计都说"钱没印"，而"没印"这件事本身印出来了（少印要说）。
  const bare = callLinesOf(rows, { cat: BUILTIN_CATALOG })
  assert.equal(bare.length, 3, `两条调用 + 一行合计，盘上是 ${bare.length} 行`)
  assert.match(bare[0] as string, /步 0 · end-turn（end_turn） · 思考 high · input 未量到 · cacheRead 1,920 · cacheWrite 0 · output 10（思考 未量到） · 钱 没印/)
  assert.match(bare[1] as string, /cut-stream（这一趟没走完）/)
  assert.match(bare[2] as string, /^合计 调用 2 · input 0（缺 2 条） · cacheRead 3,840 · cacheWrite 0 · output 20 · 思考 0（缺 2 条） · 费用 没印：/)
  assert.match(linesOf(statusOf(rows), { cat: BUILTIN_CATALOG }).join('\n'), /费用 没印：读的时候没给峰谷档/, '`linesOf` 那一档也要说"少印"')

  // **给了档**：逐趟一笔、合计一笔。合计那个数走的是 `costOf`（一处算式）。
  const priced = callLinesOf(rows, { phase: 'off-peak', cat: BUILTIN_CATALOG })
  assert.match(priced[0] as string, /· 钱 \$0\.000012（下界：有 1 条没量到）/)
  assert.match(priced[2] as string, /· 费用 ≈ \$0\.000024（谷时 · deepseek-flash\/anthropic → deepseek-flash：未命中 \$0\.15\/M · 命中 \$0\.003\/M · 输出 \$0\.6\/M）/)

  // 一次调用都没有那一档：合计照印，并说清"一次调用都还没有"。
  const none = callLinesOf([row({ t: 'round/state', round: 'r1' as RoundId, from: 'Idle' as never, to: 'Planning' as never })])
  assert.equal(none.length, 1)
  assert.match(none[0] as string, /合计 调用 0 · .*——这一份日志里一次调用都还没有/)
  console.log(`⑨ 读数：${bare[0] as string}`)
  console.log(`⑨ 读数：${priced[2] as string}`)
})

// ── ⑩ 序 32：读面在命令上的那个出口（`status --once --metrics --report`）──────────────────
//
// 由头：八元指标与打回三数原先只挂在 `round run` / `round work` 的 `--report --metrics` 上——
// **跑完才有，跑着读不到**，而 TUI 与第二个渲染器（另一个宿主 · 另一门语言 · 原生窗口）读的正是
// "跑着"的那一份。这一格把出口加在 `status` 上：`--json` 那一份对象去掉 `width` / `height` 就是
// `ui/frame.ts` 的 `FrameInput`——命令面与渲染器的输入契约是同一份。
//
// 四条：前两条是主张，后两条是负对照。
//   一 · **两处读法同一个数**：跑完那一档走 `computeAll` / `computeAllMetrics`，读账那一档走
//        `readings()`，逐项相同；而快照那一份就是 `statusOf` 折出来的那一份（形状一个字段没动）。
//   二 · **文字面逐字相同**：`readingsLines()` 那两块，就是跑完那一档印的那两块——表头是同一个
//        常数（`REPORT_HEAD` / `METRICS_HEAD`），行是同一个 `linesOfReadings` / `lineOf`。
//   三 · **没要的那一栏不出现**（不是空数组）："没算"与"算出来是空"要分得开（`B1` 那条）。
//   四 · **账动两边一起动**：往同一份账里再落一条回边与一次内核拒，两处的 `rejects` / `denied`
//        一起 +1；而 `report` 那三个数还与 `statusOf` 自己那三栏（`rounds[].rejects` · `conflicts` ·
//        逐格 `denies`）对得上——那是账上第二处独立折法，两边改掉一处就红。
test('⑩ 出口：`status` 那两栏与 `round run` 那两栏同一个数、同一个渲染；没要的栏不出现', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'))
  try {
    const log = openLog(dir, { sync: 'each' })
    const r1 = 'r1' as RoundId
    const A = 'agent/r1/1' as AgentId
    const B = 'agent/r1/2' as AgentId
    /** 一份**真跑一趟**会落下来的账：每一族的形状照 `src/log/events.ts` 逐字。 */
    const script: [string, LogEvent][] = [
      ['round', { t: 'round/intent', round: r1, base: 'b0' as never, digest: 'd0', body: '{"goal":"写一份 notes.md"}' }],
      ...FULL.map(([from, to]): [string, LogEvent] => ['round', { t: 'round/state', round: r1, from: from as never, to: to as never }]),
      ['round', { t: 'contract/issue', round: r1, contract: 'c1' as never, owner: A, paths: ['src/a.ts'] as never[], body: '{}' }],
      ['round', { t: 'merge/attempt', round: r1, branches: [A] as never[], conflicts: 2 }],
      // **交接落在 A 的第一条上**：交错那一份是 (seq, writer) 的全序（`log.ts` 的 `readMerged`），
      // 而「交接在继任者第一次调用之前」要在这个次序上成立——`handoff-yield` 量的就是它。
      [A, { t: 'agent/handoff', agent: A, successor: B, contract: 'c2' as never, digest: 'd2', body: '{}' }],
      [A, { t: 'prefix/assemble', agent: A, zoneAHash: 'a1', zoneBHash: 'b1', zoneCHash: 'c1' }],
      [A, call(A, '0', 1, 0)],
      [A, call(A, '1', 0, 1920)],
      [A, { t: 'run/start', agent: A, step: '0' as never, action: 'bash', argv0: '/bin/sh', argv: ['/bin/sh', '-c', 'grep -n 数完了 notes.md'] }],
      [A, { t: 'run/end', agent: A, step: '0' as never, exit: 1, ms: 3, denied: true }],
      [A, { t: 'mat/fork', agent: A, base: 'b0' as never, strategy: 'copy' as never, paths: ['src/a.ts'] as never[], hashes: ['h1'], ms: 7 }],
      [A, { t: 'mat/reclaim', agent: A, declared: ['src/a.ts'] as never[], changed: ['src/a.ts'] as never[] }],
      [A, { t: 'view/write', agent: A, path: 'src/a.ts' as never, rev: 1 as never, blob: 'bl1' as never, mode: 420 }],
      [B, call(B, '0', 1, 4864)],
      [B, { t: 'view/write', agent: B, path: 'src/b.ts' as never, rev: 1 as never, blob: 'bl2' as never, mode: 420 }],
      [B, { t: 'agent/stop', agent: B, steps: 1, stopped: '收敛', handoffs: 0 }],
    ]
    for (const [w, e] of script) await log.append(w as never, e)

    // 一 · 两处读法：跑完那一档（`round run` 那条路）⇄ 读账那一档（`status` 那条路）。
    const viaRun = {
      report: await computeAll(() => log.readMerged(), {}),
      metrics: await computeAllMetrics(() => log.readMerged(), {}),
    }
    const viaStatus = await readings(log, { metrics: true, report: true })
    const rep = viaStatus.report ?? []
    const met = viaStatus.metrics ?? []
    assert.deepEqual(viaStatus.snapshot, statusOf(await rowsOf(() => log.readMerged())), '快照那一份一个字段没动')
    assert.deepEqual(rep, viaRun.report, `打回那三个数：${JSON.stringify(rep)}`)
    assert.deepEqual(met, viaRun.metrics, `八元指标：${JSON.stringify(met)}`)

    // **把数钉住**：这一份账上的八条值逐条写死——**值与分子分母都写**，因为 `B7` 那条契约就是
    // "分母与分子都要印得出来"，而只钉 `value` 钉不住一处分子（`value` 是另算的）。上面那两条比的是
    // 「两处读法同源」，这一条管的是**那个源本身有没有被动过**：改掉 `metricsOf` 的一处折法当场红。
    const f = (m: (typeof met)[number]): string => `${m.metric}=${m.value}（${m.numerator}/${m.denominator}）`
    assert.deepEqual(
      met.map(f),
      [
        'zero-tool-call-rate=0.3333333333333333（1/3）',
        'detour-rate=1（1/1）',
        'prefix-hit-rate=0.6666666666666666（2/3）',
        'prefix-versions=1（1/1）',
        'materialize-precision=1（1/1）',
        'ensure-latency=7（1/1）',
        'git-calls-per-round=3（3/1）',
        'handoff-yield=1（1/1）',
      ],
      `八元那八条：${met.map(f).join(' · ')}`,
    )

    // 二 · 文字面：跑完那一档印的那两块（表头 + 行），与 `readingsLines()` 那两块逐字相同。表头与
    // 行都是一处取值处，所以这一条钉的是**次序与归属**：快照那几行在前，两块在后，一块不多一块不少。
    const runBlocks = [
      REPORT_HEAD,
      ...linesOfReadings(viaRun.report).map((l) => `  ${l}`),
      METRICS_HEAD,
      ...viaRun.metrics.map((m) => `  ${lineOf(m)}`),
    ]
    const mine = readingsLines(viaStatus, { phase: 'off-peak', cat: BUILTIN_CATALOG })
    assert.deepEqual(mine.slice(mine.indexOf(REPORT_HEAD)), runBlocks, `文字面：\n${mine.join('\n')}`)

    // 三 · 负对照：没要的那一栏**不出现**（不是空数组），而 `--json` 那一份就是它。
    const bare = await readings(log)
    assert.deepEqual(Object.keys(bare), ['snapshot'], `没给开关时那一份对象：${JSON.stringify(bare)}`)
    assert.equal(Object.hasOwn(bare, 'metrics'), false)
    assert.equal(Object.hasOwn(bare, 'report'), false)
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(bare)) as object), ['snapshot'], 'JSON 那一档是同一份')
    const onlyReport = (await readings(log, { report: true })) as Record<string, unknown>
    assert.deepEqual(Object.keys(onlyReport).sort(), ['report', 'snapshot'], '只要一栏时另一栏也不出现')

    // 四 · 负对照：账动，两边一起动；而三个数与 `statusOf` 自己那三栏对得上（账上第二处独立折法）。
    const pick = (rs: readonly { readonly metric: string; readonly count: number }[], m: string): number | undefined =>
      rs.find((r) => r.metric === m)?.count
    assert.deepEqual(
      { rejects: pick(rep, 'rejects'), conflicts: pick(rep, 'conflicts'), denied: pick(rep, 'denied') },
      { rejects: 1, conflicts: 2, denied: 1 },
    )
    assert.equal(viaStatus.snapshot.rounds[0]?.rejects, 1, 'statusOf 自己那一栏：打回')
    assert.equal(viaStatus.snapshot.conflicts, 2, 'statusOf 自己那一栏：冲突')
    assert.equal(viaStatus.snapshot.agents.reduce((n, a) => n + a.denies, 0), 1, 'statusOf 自己那一栏：内核拒')

    await log.append('round' as never, { t: 'round/state', round: r1, from: 'Verifying', to: 'Working' })
    await log.append(A as never, { t: 'run/end', agent: A, step: '1' as never, exit: 1, ms: 2, denied: true })
    const afterRun = await computeAll(() => log.readMerged(), {})
    const afterStatus = await readings(log, { report: true })
    assert.equal(pick(afterRun, 'rejects'), 2, '账上多一条回边：跑完那一档跟着动')
    assert.equal(pick(afterRun, 'denied'), 2, '账上多一次内核拒：跑完那一档跟着动')
    assert.equal(pick(afterStatus.report ?? [], 'rejects'), 2, '读账那一档也动')
    assert.equal(afterStatus.snapshot.rounds[0]?.rejects, 2, 'statusOf 那一栏也动')
    assert.equal(afterStatus.snapshot.agents.reduce((n, a) => n + a.denies, 0), 2)

    console.log(`⑩ 读数：打回 ${viaRun.report.map((r) => `${r.metric} ${r.count}`).join(' · ')}`)
    console.log(
      `⑩ 读数：八元 ${viaRun.metrics.map((m) => `${m.metric}=${m.value === null ? '算不出来' : m.value}`).join(' · ')}`,
    )
    console.log('⑩ 负对照：账上多一条回边 + 一次内核拒 → 两处 rejects 1→2 · denied 1→2；没要的栏不出现')
    await log.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ⑪ 范围写进读数：三行并排，范围却不一样（⑩ 证的是折法共用，这一条证的是范围）─────────────
//
// 由头：`conflicts` 与 `rejects` 落在带轮次那一栏的事件上（`merge/attempt` · `round/state`），
// `denied` 落在 `run/end` 上，而那条事件**没有轮次那一栏**（架构 § 8.1 那张表逐字）。于是命令行
// 那两处出口递的范围不同时（`round run` 递 `{round}` · `status` 递 `{}`），同一个名字印出来的数
// 可以不一样——⑩ 两边递的都是空范围，所以它看不见这一层。
//
// 这一条把范围钉在读数自己身上（`how` 开头的标签）。负对照：把 `scopeOf` 里 `denied` 那一支也
// 按 `range.round` 走 → "`denied` 两处都是 `[整账]`" 当场红。
test('⑪ 范围写进读数：两支按轮次筛、一支整份账，标签就在数前面', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-range-'))
  try {
    const log = openLog(dir, { sync: 'each' })
    const r1 = 'r1' as RoundId
    const r2 = 'r2' as RoundId
    const A = 'agent/r1/1' as AgentId
    const B = 'agent/r2/1' as AgentId
    /** 两轮落在同一份账上：每轮各撞一次冲突 · 各留一次被内核拒的动作（`FULL` 里那条回边也在）。 */
    for (const [round, who] of [
      [r1, A],
      [r2, B],
    ] as readonly (readonly [RoundId, AgentId])[]) {
      await log.append('round' as never, { t: 'round/intent', round, base: 'b0' as never, digest: 'd', body: '{}' })
      for (const [from, to] of FULL) {
        await log.append('round' as never, { t: 'round/state', round, from: from as never, to: to as never })
      }
      await log.append('round' as never, { t: 'merge/attempt', round, branches: [who] as never[], conflicts: 1 })
      await log.append(who as never, { t: 'run/end', agent: who, step: '0' as never, exit: 1, ms: 2, denied: true })
    }

    const whole = (await readings(log, { report: true })).report ?? []
    const one = await computeAll(() => log.readMerged(), { round: r1 })
    const two = await computeAll(() => log.readMerged(), { round: r2 })
    const tagged = (rs: readonly MetricReading[]): string[] => rs.map((r) => `${r.metric}${r.how.slice(0, 4)}`)
    const count = (rs: readonly MetricReading[], m: string): number => rs.find((r) => r.metric === m)?.count ?? -1

    // 一 · 标签：整份账那一档三行都 `[整账]`；带轮次那一档前两支 `[本轮]`、`denied` 仍是 `[整账]`。
    assert.deepEqual(tagged(whole), ['conflicts[整账]', 'rejects[整账]', 'denied[整账]'], `整份账那一档：${whole.map((r) => r.how).join(' · ')}`)
    assert.deepEqual(tagged(one), ['conflicts[本轮]', 'rejects[本轮]', 'denied[整账]'], `带轮次那一档：${one.map((r) => r.how).join(' · ')}`)
    assert.deepEqual(tagged(two), ['conflicts[本轮]', 'rejects[本轮]', 'denied[整账]'])

    // 二 · 数：前两支按轮次筛（逐轮相加 == 整份账），`denied` 不筛（三处同一个数）。
    assert.deepEqual({ c: count(whole, 'conflicts'), r: count(whole, 'rejects') }, { c: 2, r: 2 })
    assert.deepEqual({ c: count(one, 'conflicts'), r: count(one, 'rejects') }, { c: 1, r: 1 })
    assert.equal(count(one, 'conflicts') + count(two, 'conflicts'), count(whole, 'conflicts'))
    assert.equal(count(one, 'rejects') + count(two, 'rejects'), count(whole, 'rejects'))
    assert.deepEqual(
      { 整账: count(whole, 'denied'), r1: count(one, 'denied'), r2: count(two, 'denied') },
      { 整账: 2, r1: 2, r2: 2 },
      '`denied` 那一支不筛轮次：三处读出来是同一个数',
    )

    // 三 · 文字面：范围不同 → 两处印出来的行**不逐字相同**（⑩ 那一条说的是折法共用，不是这个）。
    assert.equal(linesOfReadings(whole).length, 3)
    assert.notDeepEqual(linesOfReadings(one), linesOfReadings(whole), '两处的文字面不该逐字相同——范围不一样')

    console.log(`⑪ 读数：整份账 ${tagged(whole).join(' · ')}`)
    console.log(`⑪ 读数：带轮次 ${tagged(one).join(' · ')}`)
    console.log(
      `⑪ 读数：conflicts 整账 ${count(whole, 'conflicts')} = r1 ${count(one, 'conflicts')} + r2 ${count(two, 'conflicts')} · rejects 整账 ${count(whole, 'rejects')} = r1 ${count(one, 'rejects')} + r2 ${count(two, 'rejects')} · denied 三处都是 ${count(whole, 'denied')}`,
    )
    console.log('⑪ 负对照：把 `scopeOf` 里 `denied` 那一支也按 `range.round` 走 → "denied 仍是 [整账]" 当场红')
    await log.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ⑫ T8 那一句断言：界面那一头「切过去」与 status --agent <x> 读的是同一批行。
//
// 「切过去」在界面那一头就是「筛行再折」（ui/follow.ts：focus 给了就 rows.filter），命令面那一头是
// readings(log, { agent })。两处必须是同一个口径——不然面板上印的与 status --agent <x> --once 印的
// 是两份读数，而两边都不报错。负对照是不滤的那一份（整份账）。
test('⑫ `--agent` 那一档与界面「切过去」读的是同一批行（T8）', async () => {
  // 两行归主线（持轮者那一份），一行归第一格 agent。这一条量的是「两处筛的是不是同一批行」，
  // 所以行的形状只要对得上折法就行（形状取自 dispatch.test.ts 的夹具）。
  const lines: readonly StatusRow[] = [
    ...chain('r1' as RoundId, [
      ['Idle', 'Planning'],
      ['Planning', 'Delegated'],
    ]),
    row(
      { t: 'round/intent', round: 'r1' as RoundId, base: 'a'.repeat(40) as never, digest: 'd'.repeat(16), body: '{}' },
      'agent/r1/1',
    ),
  ]
  // 一个只有 readMerged 的口：命令面那一档读的正是它（probe/status.ts 的 readings）。
  const fake = {
    readMerged: async function* () {
      for (const r of lines) yield r
    },
  }
  const viaFlag = await readings(fake, { agent: 'agent/r1/1' })
  const viaUi = readingsOf(
    lines.filter((r) => r.pos.writer === 'agent/r1/1'),
    {},
  )
  assert.deepEqual(viaFlag, viaUi, '命令面那一档与界面那一档不是同一份读数')
  const whole = await readings(fake, {})
  assert.notDeepEqual(whole, viaUi, '负对照：整份账那一档与只读那一格那一档相同——那这一条就抓不住')
  assert.notDeepEqual(viaFlag, whole, '同一句的另一种说法：滤过的那一份与整份账不同')
  console.log(
    '⑫ 读数：--agent 那一档与界面切过去那一档逐字段相同（' +
      String(lines.filter((r) => r.pos.writer === 'agent/r1/1').length) +
      ' 行那一份）· 整份账那一档（' +
      String(lines.length) +
      ' 行）与它不同',
  )
})

// ⑬ 本站 ④：`status --ledger`（每调用成本台账）那一栏。
//
// 三条：一 · **不给开关就不出现**（「没算」与「算出来是空」要分得开，与另两栏同一条规矩）；
// 二 · 文字面那一块的表头与行都住 `probe/ledger.ts`（一处取值处，排在打回 · 八元之后）；
// 三 · **命令面真认得这个开关**（`FLAGS_OF` 那张表里声明了——「声明了没人接」与「没声明」在读数上
// 都读不出来，所以这一条量的是那张表）。
//
// 这一份账是**旧账那一档**：那一条 `llm/call` 没有 `ms` 那一栏 → 耗时写「未量到」，而账自己把这件事
// 说出来（不静默、不拿 0 顶）。钱那一栏：给了峰谷档才算，不给就是 `null`。
test('⑬ `status --ledger`：这一栏挂在同一个出口上，不给开关就不出现', async () => {
  const A = 'agent/r1/1'
  const rows: readonly StatusRow[] = [
    row(call(A, '0', 1, 0), A),
    row(
      {
        t: 'run/start',
        agent: A as never,
        step: '0' as never,
        action: 'bash',
        argv0: '/bin/sh',
        argv: ['/bin/sh', '-c', 'grep -n 数完了 notes.md'],
      },
      A,
    ),
    row({ t: 'run/end', agent: A as never, step: '0' as never, exit: 1, ms: 3, denied: true }, A),
  ]
  const fake = {
    readMerged: async function* () {
      for (const r of rows) yield r
    },
  }
  // 一 · 不给开关：只读处境那一栏。
  const bare = (await readings(fake)) as Record<string, unknown>
  assert.deepEqual(Object.keys(bare), ['snapshot'], `不给开关时那一份对象：${JSON.stringify(Object.keys(bare))}`)
  // 二 · 给了：两条调用各一行，钱按读的时候那份价目算。
  const withLedger = await readings(fake, { ledger: { cat: BUILTIN_CATALOG, phase: 'off-peak', bindings: [] } })
  const l = withLedger.ledger
  assert.ok(l !== undefined, '给了 --ledger 却没有那一栏')
  assert.equal(l?.calls.length, 2)
  assert.equal(l?.calls[0]?.kind, 'model')
  assert.equal(l?.calls[0]?.ms, null, '这一条 `llm/call` 是旧账那一档（没有 ms）→ 未量到')
  assert.equal(l?.msMissing, 1, '没量到的那条要数得出来')
  assert.equal(typeof l?.calls[0]?.usd, 'number', `给了峰谷档就该算得出钱：${String(l?.calls[0]?.usd)}`)
  assert.equal(l?.calls[1]?.ms, 3, '工具那一类的耗时取 `run/end.ms`')
  assert.equal(l?.calls[1]?.model, 'deepseek-flash/anthropic', '分组键从同格同一步那条 `llm/call` 补')
  assert.equal(l?.calls[1]?.tool?.detour, true, '这一行里提到了 grep → 绕行')
  assert.equal(l?.calls[1]?.tool?.denied, true)
  assert.equal(l?.truncated, false, '这两条调用没到上限')
  assert.equal(l?.totalCalls, 2)
  // **每一行指得回日志里那一条**：坐标就是那一行自己的位置（`row()` 给的），不是另算一个序号。
  assert.deepEqual(l?.calls[0]?.source, rows[0]?.pos)
  assert.deepEqual(l?.calls[1]?.source, rows[2]?.pos)
  // 三 · 没给峰谷档：钱那一栏是 `null`（不是 0）——与 `status --once` 同一条口径。
  const noPhase = await readings(fake, { ledger: { cat: BUILTIN_CATALOG } })
  assert.equal(noPhase.ledger?.calls[0]?.usd, null, '没给峰谷档就不算钱')
  // 四 · 文字面：表头 + 行（一处取值处），排在打回与八元之后。
  const blocks = readingsLines(withLedger, { phase: 'off-peak', cat: BUILTIN_CATALOG })
  assert.ok(blocks.includes(LEDGER_HEAD), `文字面里没有台账那一块：\n${blocks.join('\n')}`)
  assert.ok(blocks.some((t) => t.includes('模型调用 1 次')), '台账那一块没有合计那一行')
  assert.ok(blocks.some((t) => t.includes('没量到')), '旧账那一档少了「未量到」那一句')
  // 五 · 命令面真认得这个开关。
  assert.ok(
    FLAGS_OF['status']?.flags.includes('ledger') === true,
    '`status` 那张开关表里没有 ledger——声明了没人接与没声明在读数上都读不出来',
  )
  console.log(`⑬ 读数：台账 ${String(l?.calls.length)} 条调用（模型 1 · 工具 1）· 未量到 ${String(l?.msMissing)} 条`)
  console.log(`⑬ 文字面那一块（不含快照那几行）：\n${blocks.slice(blocks.indexOf(LEDGER_HEAD)).join('\n')}`)
})
