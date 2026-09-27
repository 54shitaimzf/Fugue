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
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { AgentId, RoundId } from '../terms.ts'
import { computeMerged } from './round.ts'
import { callLinesOf, causeOf, linesOf, routeOf, snapshot, statusOf } from './status.ts'
import type { StatusRow } from './status.ts'
import { follow, readNew } from './watch.ts'

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
    for await (const r of follow(openLog(dir), { intervalMs: 5, signal: ac.signal })) {
      got.push(`${r.pos.writer}/${r.pos.seq}`)
      if (got.length === 3) ac.abort()
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
  const line = linesOf(s).find((l) => l.startsWith('越界 '))
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

  const line = linesOf(s).find((l) => l.startsWith('越界 '))
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
  const bare = callLinesOf(rows)
  assert.equal(bare.length, 3, `两条调用 + 一行合计，盘上是 ${bare.length} 行`)
  assert.match(bare[0] as string, /步 0 · end-turn（end_turn） · 思考 high · input 未量到 · cacheRead 1920 · cacheWrite 0 · output 10（思考 未量到） · 钱 没印/)
  assert.match(bare[1] as string, /cut-stream（这一趟没走完）/)
  assert.match(bare[2] as string, /^合计 调用 2 · input 0（缺 2 条） · cacheRead 3840 · cacheWrite 0 · output 20 · 思考 0（缺 2 条） · 费用 没印：/)
  assert.match(linesOf(statusOf(rows)).join('\n'), /费用 没印：读的时候没给峰谷档/, '`linesOf` 那一档也要说"少印"')

  // **给了档**：逐趟一笔、合计一笔。合计那个数走的是 `costOf`（一处算式）。
  const priced = callLinesOf(rows, { phase: 'off-peak' })
  assert.match(priced[0] as string, /· 钱 \$0\.000012（下界：有 1 条没量到）/)
  assert.match(priced[2] as string, /· 费用 ≈ \$0\.000024（谷时 · deepseek-chat → deepseek-flash：未命中 \$0\.15\/M · 命中 \$0\.003\/M · 输出 \$0\.6\/M）/)

  // 一次调用都没有那一档：合计照印，并说清"一次调用都还没有"。
  const none = callLinesOf([row({ t: 'round/state', round: 'r1' as RoundId, from: 'Idle' as never, to: 'Planning' as never })])
  assert.equal(none.length, 1)
  assert.match(none[0] as string, /合计 调用 0 · .*——这一份日志里一次调用都还没有/)
  console.log(`⑨ 读数：${bare[0] as string}`)
  console.log(`⑨ 读数：${priced[2] as string}`)
})
