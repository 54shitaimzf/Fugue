// B7 的断言：八元指标与真实基线读数（PLAN § 5.8 的 B7 行 · 架构 § 8.15（八元的 `MetricId` ·
// 三个一线指标 · "**不采集，只重算**" · 验证性质"重放同一份日志，得到同一组指标值"）·
// § 20 S8 的验证一二（零工具调用率与绕行率基线建立 · **同一模型两个协议的指标可比**）·
// § 13.3（协议成为可分发物））。
// 跑法：cd ~/fugue && node --test src/probe/metrics.test.ts
//
//   ① 同一份日志重放两次 → 同一组值；而"一次读齐"与"一支一支算"两条路**逐字段相同**
//   ② 每个指标的分子与分母都印得出来；**算不出来与算出来是 0 分得开**（前者是 `null`）
//   ③ **`prefix-hit-rate` > 0**：真夹具那一次调用的用量里报回了缓存读（`cacheReadTokens`）
//      · 负对照：把那一栏抹掉 → ③ 变红，而"零工具调用率"那一支跟着动（同一个分子）
//   ④ 两套协议给出的**工具调用序列语义相同**：两份夹具解出来的调用逐字段相同
//      · 负对照：把 A 区那一栏改一个字节 → 两份的 `prefix-versions` 就分开了
//   ⑤ 归因三处对照（闸四）：冷 · 共享头 · 同一格第 k 步——**三行恒在**，位置不存在的那一行报
//      「没有读数」；负对照：日志说没命中就报没命中（这一份不假定任何一处该命中）
//   ⑥ `prefix-versions` **逐 writer 各数一份**：交错的两个 writer 各持一份 `(A,B)` → 两版
//      （合成一条链数的话是装配次数）· 同一个 writer 自己搬一次 → 各算一版
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { LogEvent } from '../log/events.ts'
import { modelDeclOf } from '../model/contract.ts'
import { readFixture, replayOf } from '../model/session.ts'
import type { Fixture } from '../model/session.ts'
import type { AgentId, RoundId } from '../terms.ts'
import {
  ATTRIBUTION_HOW,
  METRIC_HOW,
  METRIC_IDS,
  attributionOf,
  compute,
  computeAllMetrics,
  lineOf,
  looksLikeDetour,
  metricsOf,
} from './metrics.ts'
import type { MergedRow } from './metrics.ts'

const FIXTURES = fileURLToPath(new URL('../model/fixtures/', import.meta.url))
const ANTHROPIC: Fixture = readFixture(FIXTURES + 'deepseek-chat-anthropic.json')
const OPENAI: Fixture = readFixture(FIXTURES + 'deepseek-chat-openai.json')
const DECL = modelDeclOf('deepseek-chat/anthropic')

/** 一件事件配一个位置（交错的读侧那一份形状）。 */
let seq = 0
const row = (e: LogEvent): MergedRow => ({ pos: { writer: 'agent-1', seq: (seq += 1) }, e })

/** 一串脚本化的事件：两次调用（一次伸手 · 一次不伸手）· 一次绕行的 bash · 一次交接与它的产出。 */
function script(): MergedRow[] {
  seq = 0
  const agent = 'agent-1' as AgentId
  return [
    row({ t: 'prefix/assemble', agent, zoneAHash: 'a1', zoneBHash: 'b1', zoneCHash: 'c1' }),
    row({ t: 'llm/call', agent, step: '0', model: DECL.id, wire: 'anthropic-messages', toolCount: 9, invocations: 1, usage: { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64 }, rawStop: 'tool_use', stop: 'tool-calls' }),
    // 这一行**绕了**：它用 shell 干 `grep` 干的事（命令行里出现了那个工具名）。
    row({ t: 'run/start', agent, step: '0', action: 'bash', argv0: '/bin/sh', argv: ['/bin/sh', '-c', 'grep -n TODO a.ts'], cwd: '' }),
    row({ t: 'run/end', agent, step: '0', exit: 0, ms: 3, denied: false }),
    row({ t: 'prefix/assemble', agent, zoneAHash: 'a1', zoneBHash: 'b1', zoneCHash: 'c2' }),
    row({ t: 'llm/call', agent, step: '1', model: DECL.id, wire: 'anthropic-messages', toolCount: 9, invocations: 0, usage: { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64 }, rawStop: 'end_turn', stop: 'end-turn' }),
    // 物化那一趟：碰了两条、而实际变了一条（精度那一支的分母与分子因此不同）。
    row({ t: 'mat/fork', agent, base: 'c0' as never, strategy: 'hardlink', paths: ['a.ts', 'b.ts'], hashes: ['h1', 'h2'], ms: 12 }),
    row({ t: 'mat/reclaim', agent, declared: [], changed: ['a.ts'] }),
    // 一次交接：后继那一格走了两步才写出东西。
    row({ t: 'agent/handoff', agent, successor: 'agent-1-2' as AgentId, contract: 'c-1' as never, digest: 'd1', body: '【交接】…' }),
    row({ t: 'llm/call', agent: 'agent-1-2' as AgentId, step: '0', model: DECL.id, wire: 'anthropic-messages', toolCount: 9, invocations: 1, usage: { inputTokens: 88, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 64 }, rawStop: 'tool_use', stop: 'tool-calls' }),
    row({ t: 'llm/call', agent: 'agent-1-2' as AgentId, step: '1', model: DECL.id, wire: 'anthropic-messages', toolCount: 9, invocations: 1, usage: { inputTokens: 88, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 64 }, rawStop: 'tool_use', stop: 'tool-calls' }),
    row({ t: 'view/write', agent: 'agent-1-2' as AgentId, path: 'x.ts' as never, rev: 1 as never, blob: 'bl' as never, mode: 0o100644 }),
    row({ t: 'ckpt/commit', agent: 'agent-1-2' as AgentId, commit: 'deadbeef' as never, rev: 1 as never, msg: '第一个' }),
    row({ t: 'round/state', round: 'r1' as RoundId, from: 'Working', to: 'Merging' }),
    row({ t: 'round/state', round: 'r1' as RoundId, from: 'Merging', to: 'Verifying' }),
  ]
}

const valueOf = (m: readonly { metric: string; value: number | null }[], id: string): number | null =>
  m.find((x) => x.metric === id)?.value ?? null

// ── ① 重放两次同一组值 · 两条路逐字段相同 ─────────────────────────────────────

test('① 同一份日志重放两次 → 同一组值；一次读齐与一支一支算两条路逐字段相同', async () => {
  const a = metricsOf(script())
  const b = metricsOf(script())
  assert.deepEqual(a, b, '同一串事件两次算出同一组值（重算而非采集）')

  // 两条路：`computeAllMetrics`（走一遍）与 `compute`（一支一支）。
  const all = await computeAllMetrics(() => (async function* () { for (const r of script()) yield r })(), {})
  assert.deepEqual(all, a, '一次读齐与纯函数那一半同值')
  for (const id of METRIC_IDS) {
    const one = await compute(() => (async function* () { for (const r of script()) yield r })(), {}, id)
    assert.deepEqual(one, a.find((x) => x.metric === id), `${id} 那一支单算与一起算同值`)
  }

  // 读数：三个一线指标在这一串事件上的值。
  console.log(
    `① 读数：zero-tool-call-rate=${valueOf(a, 'zero-tool-call-rate')} · detour-rate=${valueOf(a, 'detour-rate')} · ` +
      `materialize-precision=${valueOf(a, 'materialize-precision')} · handoff-yield=${valueOf(a, 'handoff-yield')}`,
  )
})

// ── ② 分子与分母都印得出来 ───────────────────────────────────────────────────

test('② 每个指标的分子与分母都印得出来；算不出来（null）与算出来是 0 分得开', () => {
  const rows = script()
  const all = metricsOf(rows)
  assert.equal(all.length, 8, `八元，实际 ${all.length} 条`)
  assert.deepEqual(all.map((m) => m.metric), [...METRIC_IDS], '顺序照 `METRIC_IDS`')
  for (const m of all) {
    assert.ok(typeof m.how === 'string' && m.how.length > 0, `${m.metric} 没有"怎么数出来的"那句话`)
    assert.ok(m.how.includes('分子') && m.how.includes('分母'), `${m.metric} 那句话里没说清分子分母`)
    assert.equal(METRIC_HOW[m.metric], m.how, '判据只有一处（与表里那一句相同）')
    const line = lineOf(m)
    assert.match(line, /分子 .+ \/ 分母 .+/, `${m.metric} 那一行没印分子分母：${line}`)
  }

  // 逐条的读数（这一串事件上的确定值）。
  assert.equal(valueOf(all, 'zero-tool-call-rate'), 0.25, '四次调用里一次没伸手（1/4）')
  assert.equal(valueOf(all, 'detour-rate'), 1, '一次 run/start，而那一行里有 `grep` 这个工具名——绕行了')
  assert.equal(valueOf(all, 'prefix-hit-rate'), 0.5, '四次调用里两次报回了缓存读（2/4）')
  assert.equal(valueOf(all, 'prefix-versions'), 1, '两次装配的 (A,B) 指纹相同 → 一版')
  assert.equal(valueOf(all, 'materialize-precision'), 2, '碰了两条、变了一条（2/1——不等，这正是那一支要抓的）')
  assert.equal(valueOf(all, 'ensure-latency'), 12, '一次 fork，12 毫秒')
  assert.equal(valueOf(all, 'handoff-yield'), 2, '交接之后走了两步才写出东西（2/1）')

  // **空日志**：比率类一概 `null`（算不出来），计数类是 0（算出来就是 0）。两者分得开。
  const none = metricsOf([])
  assert.equal(valueOf(none, 'zero-tool-call-rate'), null, '一次调用都没有时分母是 0 → null')
  assert.equal(valueOf(none, 'prefix-versions'), 0, '一次装配都没有 → 0（不是 null）')
  assert.equal(none.find((m) => m.metric === 'zero-tool-call-rate')?.denominator, null)
  assert.equal(none.find((m) => m.metric === 'prefix-versions')?.denominator, 1)

  // 绕行那一支的判据本身：词边界。
  assert.equal(looksLikeDetour(['/bin/sh', '-c', 'grep -n TODO src/']), true)
  assert.equal(looksLikeDetour(['/bin/sh', '-c', 'echo readme.txt']), false, '`readme` 不是 `read`')
  assert.equal(looksLikeDetour(['/bin/sh', '-c', 'cat a.ts']), false, '`cat` 不是我们公布的工具名')
})

// ── ③ prefix-hit-rate > 0（真夹具那一趟的用量） ──────────────────────────────

test('③ 真夹具那一次调用：prefix-hit-rate > 0（上游报回了缓存读）· 负对照：抹掉那一栏就变红', () => {
  // 真夹具里那一次调用的用量（`B3` 录下来的那一份）。
  const real = metricsOf([
    row({ t: 'prefix/assemble', agent: 'agent-1' as AgentId, zoneAHash: 'a', zoneBHash: 'b', zoneCHash: 'c' }),
    row({
      t: 'llm/call',
      agent: 'agent-1' as AgentId,
      step: '0',
      model: DECL.id,
      wire: 'anthropic-messages',
      toolCount: 9, invocations: 1,
      usage: { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64 },
      rawStop: 'tool_use',
      stop: 'tool-calls',
    }),
  ])
  const hit = valueOf(real, 'prefix-hit-rate')
  assert.ok(hit !== null && hit > 0, `真那一趟的 prefix-hit-rate 该 > 0，实际 ${hit}`)
  assert.equal(hit, 1)

  // 负对照：把 `cacheReadTokens` 抹成 0（上游没报缓存那一档）→ 它变红。
  const wiped = metricsOf([
    row({ t: 'prefix/assemble', agent: 'agent-1' as AgentId, zoneAHash: 'a', zoneBHash: 'b', zoneCHash: 'c' }),
    row({
      t: 'llm/call',
      agent: 'agent-1' as AgentId,
      step: '0',
      model: DECL.id,
      wire: 'anthropic-messages',
      toolCount: 9, invocations: 1,
      usage: { inputTokens: 88, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 64 },
      rawStop: 'tool_use',
      stop: 'tool-calls',
    }),
  ])
  assert.equal(valueOf(wiped, 'prefix-hit-rate'), 0, '抹掉之后是 0（真值 0，不是算不出来）')
  assert.notEqual(valueOf(wiped, 'prefix-hit-rate'), hit)
  console.log(`③ 读数：真那一趟 prefix-hit-rate=${hit} · 抹掉之后 ${valueOf(wiped, 'prefix-hit-rate')}`)
})

// ── ④ 两套协议的工具调用序列语义相同 ─────────────────────────────────────────

test('④ 两套协议解出来的工具调用序列语义相同 · 负对照：A 区改一个字节就分开', async () => {
  // **走产品那条回放路径**（`replayOf`：`callModel` + 假提供方逐字节吐），不另搭一条。
  // 事件流是一次性的：先把账攒出来，再问 `ledger()`（顺序反了会读到半截）。
  const ra = replayOf(ANTHROPIC)
  const rb = replayOf(OPENAI)
  for await (const e of ra.events) void e
  for await (const e of rb.events) void e
  const ca = ra.ledger().call
  const cb = rb.ledger().call
  assert.ok(ca !== null && cb !== null, '两份夹具都解出了一次完整的调用')
  // **比的是积出来的账**（`ModelCall` 那个规范形状），不是上游那两串字节。
  //
  // 比的是**名字与参数**那两栏：`id` 是**上游自己起的**（`toolu_fixture_01` vs
  // `call_fixture_01`），它由那一条线协议定，不是语义的一部分——把它算进"语义相同"里，
  // 等于要求两条线给同一个 id，而那是协议的事。它也从不被回传（`ToolResult` 里没有 id）。
  const semantics = (c: { readonly name: string; readonly arguments: string }[]): { name: string; arguments: string }[] =>
    c.map((x) => ({ name: x.name, arguments: x.arguments }))
  assert.deepEqual(semantics(ca!.toolCalls), semantics(cb!.toolCalls), '两份夹具积出来的调用语义相同（名字 · 参数）')
  assert.notDeepEqual(
    ca!.toolCalls.map((c) => c.id),
    cb!.toolCalls.map((c) => c.id),
    '而上游给的那两个 id 不同——它是那一条线自己的东西',
  )
  assert.ok(ca!.toolCalls.length > 0, '真的积出了调用（否则这条断言是空的）')
  assert.equal(ca!.stop, cb!.stop, '收尾原因相同')
  assert.equal(ca!.toolCalls.length, cb!.toolCalls.length)

  // **同一份状态、两条线**：`prefix-versions` 只由 `(zoneAHash, zoneBHash)` 定，所以两组读数
  // 在同一个 (A,B) 上是同一版——这正是"两个协议可比"那句话的落点。
  const rows = (wire: string): MergedRow[] => [
    row({ t: 'prefix/assemble', agent: 'agent-1' as AgentId, zoneAHash: 'a1', zoneBHash: 'b1', zoneCHash: 'c1' }),
    row({ t: 'llm/call', agent: 'agent-1' as AgentId, step: '0', model: DECL.id, wire, toolCount: 9, invocations: 1, usage: { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64 }, rawStop: 'tool_use', stop: 'tool-calls' }),
  ]
  const onAnthropic = metricsOf(rows('anthropic-messages'))
  const onOpenai = metricsOf(rows('openai-chat'))
  assert.equal(valueOf(onAnthropic, 'prefix-versions'), valueOf(onOpenai, 'prefix-versions'))
  assert.equal(valueOf(onAnthropic, 'zero-tool-call-rate'), valueOf(onOpenai, 'zero-tool-call-rate'))

  // 负对照：A 区指纹换一个字节 → 版本数变两版（那一支真的在跟着指纹走）。
  const shifted = metricsOf([
    row({ t: 'prefix/assemble', agent: 'agent-1' as AgentId, zoneAHash: 'a1', zoneBHash: 'b1', zoneCHash: 'c1' }),
    row({ t: 'prefix/assemble', agent: 'agent-1' as AgentId, zoneAHash: 'a2', zoneBHash: 'b1', zoneCHash: 'c1' }),
  ])
  assert.equal(valueOf(shifted, 'prefix-versions'), 2)
  console.log(
    `④ 读数：两份夹具各积出 ${ca!.toolCalls.length}/${cb!.toolCalls.length} 条调用（${ca!.toolCalls.map((c) => c.name).join(' · ')}）· 同一 (A,B) 上两线同版`,
  )
})

test('④ 那一份真夹具的三区指纹（`B3` 录下来的那一份）在两份夹具里相同', () => {
  // 两份夹具是同一份状态两次装配出来的（`B3` 的读数）：三区指纹该逐字段相同。
  assert.deepEqual(ANTHROPIC.zones, OPENAI.zones, `两份夹具的三区指纹：${JSON.stringify(ANTHROPIC.zones)} vs ${JSON.stringify(OPENAI.zones)}`)
  assert.equal(ANTHROPIC.wire, 'anthropic-messages')
  assert.equal(OPENAI.wire, 'openai-chat')
  // 而请求体字节不同（那是"两条线各自翻译"）。
  assert.notEqual(ANTHROPIC.bodyHash, OPENAI.bodyHash)
})

// ── ⑤ 归因三处对照（闸四 · PLAN § 5.12 序 3）────────────────────────────────────
//
// 三处是**位置**（冷 · 共享头 · 同一格第 k 步），三行**恒在**：位置不存在的那一行是「没有读数」
// 加一句为什么，不拿 0 顶。而这一份**只读 `llm/call` 说的数**——日志说没命中就报没命中。

/** 一格的调用序列：`hits` 是每一步报回来的 `cacheReadTokens`（`null` = 上游没报这个数）。 */
const callsOf = (who: string, hits: readonly (number | null)[], input = 100): MergedRow[] =>
  hits.map((h, i) =>
    row({
      t: 'llm/call',
      agent: who as AgentId,
      step: String(i),
      model: DECL.id,
      wire: 'anthropic-messages',
      toolCount: 9,
      invocations: 1,
      usage: { inputTokens: input, cacheReadTokens: h, cacheWriteTokens: 0, outputTokens: 8 },
      rawStop: 'tool_use',
      stop: 'tool-calls',
    }),
  )

test('⑤ 三处对照：冷 · 共享头 · 第 k 步（两格两步那一趟）', () => {
  seq = 0
  // agent-1 三步（第一步冷 · 后面两步命中 24000）· agent-2 一步（共享头，命中 24000）。
  const three = attributionOf([...callsOf('agent/r1/1', [0, 24000, 24000]), ...callsOf('agent/r1/2', [24000])])
  assert.equal(three.length, 3, '三行恒在')
  assert.equal(three[0].where, 'agent/r1/1 第 0 步（冷）')
  assert.equal(three[0].cacheReadTokens, 0)
  assert.equal(three[1].where, 'agent/r1/2 第 0 步（共享头）')
  assert.equal(three[1].cacheReadTokens, 24000)
  assert.equal(three[2].where, 'agent/r1/1 第 2 步（同一格第 k 步）')
  assert.equal(three[2].cacheReadTokens, 24000)
  // **第 k 步那一行是"与自己第 0 步比"**：它把两个数都写进 note 里（命中不随步数增长）。
  assert.match(three[2].note, /第 0 步是 0/)
  assert.match(three[1].note, /0 → 24000/)
  // 三处的判据与数一起给得出（人读的一句话不是可选的）。
  assert.equal(ATTRIBUTION_HOW.length, 3)
  console.log(`⑤ 读数：${three.map((a) => a.where + ' 命中 ' + String(a.cacheReadTokens)).join(' · ')}`)
})

test('⑤ 一格那一趟（回放夹具就是这一种）：共享头那一行如实报「没有读数」', () => {
  seq = 0
  const one = attributionOf(callsOf('agent/r1/1', [0, 2048, 2176]))
  assert.equal(one.length, 3, '三行照旧在——缺的那一行是「没有读数」，不是空行')
  assert.equal(one[1].agent, null)
  assert.equal(one[1].cacheReadTokens, null, '位置不存在给 null（与"量到 0"分得开）')
  assert.match(one[1].note, /这一趟只有一格/)
  assert.equal(one[2].where, 'agent/r1/1 第 2 步（同一格第 k 步）')
  // 只走一步那一格：第 k 步与第 0 步是同一处 → 那一行也是「没有读数」。
  seq = 0
  const single = attributionOf(callsOf('agent/r1/1', [0]))
  assert.equal(single[2].cacheReadTokens, null)
  assert.match(single[2].note, /只走了一步/)
  // 一条 `llm/call` 都没有（打桩那一档）：三行都在，头一行说得出为什么。
  seq = 0
  const none = attributionOf([])
  assert.equal(none.length, 3)
  assert.match(none[0].note, /一条 `llm\/call` 都没有/)
  console.log(`⑤ 读数：一格那一趟 → "${one[1].note}" · 打桩那一档 → "${none[0].note}"`)
})

test('⑤ 负对照：日志说"共享头没命中"就报 0（这一份不假定任何一处该命中）', () => {
  seq = 0
  // 这一串就是"改 A 区一个字节之后再跑一趟"在日志上的样子：第二格第 0 步的命中掉到 0。
  const broke = attributionOf([...callsOf('agent/r1/1', [0, 24000]), ...callsOf('agent/r1/2', [0])])
  assert.equal(broke[1].cacheReadTokens, 0, '量到了 0 就报 0——不因为"共享头该命中"而报成命中')
  assert.notEqual(broke[1].cacheReadTokens, null, '这是量到的 0，不是「没有读数」')
  assert.match(broke[1].note, /0 → 0/, '与冷那一处的比较照样印出来（两个 0 也印）')
  console.log(`⑤ 负对照读数：共享头第 0 步报 ${String(broke[1].cacheReadTokens)}（与冷 ${String(broke[0].cacheReadTokens)} 比）——读数跟着日志走`)
})

// ── ⑥ `prefix-versions` 逐 writer 各数一份 ────────────────────────────────────
//
// 由头：样本盘第一趟全链路真档（53 次调用 · 5 个 writer）。这一栏读出 **51**，而拿日志逐 writer
// 查一遍是 **5**（round 1 · 四个格各 1）：A 区全日志只有一个版本（`f0c507a644adae97`），每个
// writer 自己那一趟里 B 区**一个版本没变**——判据⑥ 那三条在真档下都成立，而这一支的读法把它们
// 埋进交错里了（`merged` 是一条交错的流，而 `(A,B)` 是逐 writer 的东西）。

test('⑥ `prefix-versions` 逐 writer 各数一份：交错不当作重装配', () => {
  const w1 = 'agent/r1/1' as AgentId
  const w2 = 'agent/r1/2' as AgentId
  const rows: MergedRow[] = []
  for (let i = 0; i < 4; i++) {
    rows.push(row({ t: 'prefix/assemble', agent: w1, zoneAHash: 'a', zoneBHash: 'b1', zoneCHash: 'c' + String(i) }))
    rows.push(row({ t: 'prefix/assemble', agent: w2, zoneAHash: 'a', zoneBHash: 'b2', zoneCHash: 'c' + String(i) }))
  }
  // 两个 writer 各持一份 `(A,B)` → **两版**。合成一条链数的话是 8 次装配 8 次「变了」。
  assert.equal(valueOf(metricsOf(rows), 'prefix-versions'), 2, '两个 writer 各一份 → 两版，不是 8')
  // 同一个 writer 自己那一趟里指纹搬了一次，照旧各算一版（这一支还是在跟着指纹走）。
  const moved = metricsOf([
    row({ t: 'prefix/assemble', agent: w1, zoneAHash: 'a', zoneBHash: 'b1', zoneCHash: 'c1' }),
    row({ t: 'prefix/assemble', agent: w1, zoneAHash: 'a', zoneBHash: 'b2', zoneCHash: 'c2' }),
    row({ t: 'prefix/assemble', agent: w2, zoneAHash: 'a', zoneBHash: 'b3', zoneCHash: 'c1' }),
  ])
  assert.equal(valueOf(moved, 'prefix-versions'), 3, '逐 writer 数：w1 两版 + w2 一版')
  // 负对照：同一个 writer 上 A 换一个字节 → 它照样变两版（④ 里那一条负对照没被这一次改动碰掉）。
  assert.equal(
    valueOf(
      metricsOf([
        row({ t: 'prefix/assemble', agent: w1, zoneAHash: 'a1', zoneBHash: 'b1', zoneCHash: 'c1' }),
        row({ t: 'prefix/assemble', agent: w1, zoneAHash: 'a2', zoneBHash: 'b1', zoneCHash: 'c1' }),
      ]),
      'prefix-versions',
    ),
    2,
  )
  console.log(
    `⑥ 读数：交错 8 次装配 → ${valueOf(metricsOf(rows), 'prefix-versions')} 版（逐 writer 各一份）· ` +
      `逐 writer 各搬一次 → ${valueOf(moved, 'prefix-versions')}`,
  )
})
