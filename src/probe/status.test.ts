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
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import type { AgentId, RoundId } from '../terms.ts'
import { computeMerged } from './round.ts'
import { causeOf, linesOf, routeOf, statusOf } from './status.ts'
import type { StatusRow } from './status.ts'

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
    model: 'deepseek-chat' as never,
    wire: 'anthropic-messages',
    toolCount: 9,
    invocations,
    status: null,
    headers: null,
    usage: { inputTokens: null, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: 10 },
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
  assert.match(linesOf(s).join('\n'), /跳步，经 verdict-pass · advanced/)
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
  assert.match(linesOf(s).join('\n'), /图上没有这条路/)
  // 状态本身不认识 → 账坏了，当场拒。
  assert.throws(() => statusOf(chain('r1' as RoundId, [['Idle', 'Dreaming']])), /不认识的轮次状态/)
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
  const text = linesOf(a).join('\n')
  assert.match(text, /状态 Rebuilding/)
  assert.match(text, /停：1 步 · 收敛/)
  assert.match(text, /cacheRead 1920/)
})
