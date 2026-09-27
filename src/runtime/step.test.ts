// B4 的断言（PLAN § 5.8 的 B4 行 · 架构 § 14.2 的六步与三档 · § 8.11 的验证性质（相邻两步仅 C
// 变化）· § 8.13（`M12` 只做转移））。跑法：cd ~/fugue && node --test src/runtime/step.test.ts
//
// **这一份里没有一条会出网**，也没有一处需要密钥：驱动它的是一个**假模型**（一串脚本化的响应），
// 目标是一个 `from: 'fixture'` 的 `Target`（`B3` 夹具档那个形状：`fetchTransport` 见了当场拒）。
// 第五条断言反过来接上真接缝——`wireCall` + `B3` 的夹具传输——仍然不发一个字节出去。
//
//   ① 每一步落一条 `prefix/assemble` 与一条 `llm/call`，**步号单调**且有且只有一条
//   ② **C 区只追加**：相邻两步的 `hash(A+B)` 不变（架构 § 8.11 那条验证性质的机制侧兑现），
//      C 只是一串只追加的尾巴
//   ③ 三种 `StopReason`（调用工具 · 自然停 · 预算耗尽）**分得开**，不混成"结束了"
//   ④ 用**假模型**（一串脚本化的响应）驱动它，三区稳定性照旧成立
//      · 负对照：让循环在每步重写 C 区中部 → ② 变红
//
// ⑨ 是 W11 那一轮真档照出来的那三句收工口径（预算 · 怎么交卷 · 断言谁跑）：它们进的是 B 区，
//    而预算那个数逐字跟着状态走——负对照两条（换一个数 → 那一句跟着变；不给 → 那一句不写）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelEvent, Turn } from '../model/contract.ts'
import { modelDeclOf } from '../model/contract.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle, LogEvent } from '../log/events.ts'
import { assemble, firstDivergence, hashOf } from '../assemble/assemble.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { sourcesFor } from '../assemble/sources.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import { readFixture } from '../model/session.ts'
import { fixtureTarget } from '../model/session.ts'
import type { Fixture } from '../model/session.ts'
import { callModel, makeDumpCall } from '../model/http.ts'
import type { Transport } from '../model/http.ts'
import { fixtureTransport } from '../model/session.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'
import type { AgentId, BranchId, ContractId } from '../terms.ts'
import type { ModelId } from '../model/contract.ts'
import type { AgentHandle, CallModel, StepOutcome, ToolCallRequest } from './step.ts'
import { HarnessError, createRuntime, recordingExecutor, scriptedModel, wireCall } from './step.ts'
import { runSteps } from './run.ts'

const WHO: AgentCoord = { id: 'agent-1', branch: 'refs/heads/agent-1', outputPaths: ['deliver/agent-1/'] }
const FIXTURES = fileURLToPath(new URL('../model/fixtures/', import.meta.url))
const DECL = modelDeclOf('deepseek-chat/anthropic')
const tools = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])

/** 一次调用的四个数（假模型也守 `B1` 的口径：用量可以缺，缺了是 `null`）。 */
const USAGE = { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64, reasoningTokens: null, model: null }

/** 一条工具调用（三段：起点 · 分片 · 收尾）。 */
function callOne(index: number, id: string, name: string, args: string): ModelEvent[] {
  return [
    { t: 'tool-start', index, id, name },
    { t: 'tool-delta', index, args },
    { t: 'tool-call', index, id, name, arguments: args },
  ]
}

/** 第一步调一次工具，第二步说完。 */
const SCRIPTS: readonly (readonly ModelEvent[])[] = [
  [
    { t: 'delta', text: '先看一眼。' },
    ...callOne(0, 'call_1', 'read', '{"path":"a.ts"}'),
    { t: 'usage', usage: USAGE },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ],
  [
    { t: 'delta', text: '数完了。' },
    { t: 'usage', usage: USAGE },
    { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
  ],
]

/** 一个夹具（`deleted` 那一档不存在：夹具是盘上的文件）。 */
const FIXTURE: Fixture = readFixture(FIXTURES + 'deepseek-chat-anthropic.json')

/** 一个临时工作区：日志落在它里面，跑完删干净。**写口一条命令一个**（`hold` 那条纪律）。 */
async function withRoot<T>(fn: (root: string, log: LogHandle) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-b4-'))
  const log = openLog(root, { write: 'agent-1' as AgentId })
  try {
    return await fn(root, log)
  } finally {
    await log.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/** 读一个 writer 的全部事件（**重放那一侧**：它只读，不写）。 */
async function eventsOf(root: string): Promise<LogEvent[]> {
  const log = openLog(root)
  const out: LogEvent[] = []
  for await (const e of log.readByWriter('agent-1' as AgentId)) out.push(e)
  return out
}

function handleOf(state: AssembleState, f: Fixture = FIXTURE): AgentHandle {
  return {
    agent: 'agent-1' as AgentId,
    coord: WHO,
    branch: 'refs/heads/agent-1' as BranchId,
    contract: 'c-1' as ContractId,
    protocol: SUBAGENT_PROTOCOL,
    model: DECL.id as ModelId,
    wireModel: f.target,
    target: fixtureTarget(f),
    adapter: fixtureTarget(f).wire,
    state,
    call: f.call,
  }
}

/** 一条只有文本的 `Turn`：测试自己往尾巴里塞东西时用的形状（W6 之后尾巴不是字符串了）。 */
function turnOfText(text: string): Turn {
  return { text, calls: [], results: [] }
}

/** 一次装配（与 `step` 里那一步同一条路：`assemble` 是纯函数，再算一次不碰任何状态）。 */
function prefixAt(h: AgentHandle) {
  return assemble({ protocol: h.protocol, model: h.model, segments: sourcesFor(h.protocol, h.state, h.coord) })
}

/** 一个运行时：假模型 + 记账的执行器 + 那个日志口。 */
function runtimeWith(log: LogHandle, scripts: readonly (readonly ModelEvent[])[] = SCRIPTS) {
  const executor = recordingExecutor((call) => ({ ok: true, output: `${call.name} 回了：2 个文件` }))
  const rt = createRuntime({
    logOf: () => log,
    call: scriptedModel(scripts),
    execute: executor,
    tools,
  })
  return { rt, executor }
}

// ── ① 每一步两条事件，步号单调 ────────────────────────────────────────────────

test('① 每一步落一条 `prefix/assemble` 与一条 `llm/call`，步号单调且有且只有一条', async () => {
  await withRoot(async (root, log) => {
    const { rt } = runtimeWith(log)
    const r = await runSteps(rt, handleOf(fixtureState(0)), new AbortController().signal)
    assert.equal(r.steps, 2)
    assert.equal(r.last.outcome.kind, 'done')

    const events = await eventsOf(root)
    const prefix = events.filter((e) => e.t === 'prefix/assemble')
    const calls = events.filter((e) => e.t === 'llm/call')
    assert.equal(prefix.length, 2, `两步应该两条 prefix/assemble，盘上是 ${prefix.length} 条`)
    assert.equal(calls.length, 2, `两步应该两条 llm/call，盘上是 ${calls.length} 条`)
    // 顺序：先 assemble 后 call，一步一对。
    assert.deepEqual(
      events.map((e) => e.t),
      ['prefix/assemble', 'llm/call', 'prefix/assemble', 'llm/call'],
    )
    // 步号单调（`llm/call` 的 `step` 读的是**这一步看的那个状态**的步号：0 之后 1）。
    const steps = calls.map((e) => (e as { step: string }).step)
    assert.deepEqual(steps, ['0', '1'])
    // 那几个数：模型 · 线协议 · 工具条数 · 用量四个数 · 停因。
    const first = calls[0] as {
      model: string
      wire: string
      toolCount: number
      invocations: number
      stop: string | null
      rawStop: string | null
      thinking: string | null
      usage: Record<string, number | null>
    }
    assert.equal(first.model, DECL.id)
    assert.equal(first.wire, 'anthropic-messages')
    assert.equal(first.toolCount, tools.length)
    // **两栏是两件事**：公布了几条 ≠ 它调了几条。`zero-tool-call-rate` 的分子问的是后者。
    assert.equal(first.invocations, 1)
    assert.equal((calls[1] as { invocations: number }).invocations, 0)
    assert.equal(first.stop, 'tool-calls')
    assert.equal(first.rawStop, 'tool_use')
    // **"这一趟开了什么"只有这一栏答得出**（序 27）：声明里那一档原样记下来，不是适配器补出来的
    // 那一档（`openai.ts` 把"没写"翻成 `disabled`、`anthropic.ts` 翻成一个字段都不发）。
    assert.equal(first.thinking, 'high', '`llm/call` 没记这一趟声明的是哪一档思考')
    assert.deepEqual(first.usage, { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64, reasoningTokens: null })
    console.log(
      `① 读数：${r.steps} 步 · ${events.length} 条事件（${prefix.length} assemble + ${calls.length} call）· ` +
        `步号 ${steps.join(' → ')} · 公布工具 ${first.toolCount} 条 · 思考 ${first.thinking} · 用量 ${JSON.stringify(first.usage)}`,
    )
  })
})

test('①b `llm/call` 记的是**我们声明的那一档**：没写那一栏就是 `null`，不是 `off`', async () => {
  await withRoot(async (root, log) => {
    const { rt } = runtimeWith(log)
    // 同一个句柄，只把调用配置里那一栏拿掉：`null` 说的是"声明里没写"，而 `off` 说的是
    // "我们定下来这一趟不想"——两条线对"没写"的解释相反，所以这两件事在日志里不许长一样。
    await rt.step({ ...handleOf(fixtureState(0)), call: { maxTokens: 1024 } }, new AbortController().signal)
    const calls = (await eventsOf(root)).filter((e) => e.t === 'llm/call') as { thinking: string | null }[]
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.thinking, null, '没写那一栏时它该是 `null`——`off` 是一个我们已经定下来的档')
    console.log(`①b 读数：没写思考那一栏 → \`llm/call\` 记的是 ${JSON.stringify(calls[0]?.thinking)}`)
  })
})

// ── ② C 区只追加：相邻两步 hash(A+B) 不变 ──────────────────────────────────────

test('② C 区只追加：相邻两步的 hash(A+B) 不变，C 只是一串只追加的尾巴', async () => {
  await withRoot(async (root, log) => {
    const { rt } = runtimeWith(log)
    const h0 = handleOf(fixtureState(0))
    const one = await rt.step(h0, new AbortController().signal)
    const two = await rt.step({ ...h0, state: one.next }, new AbortController().signal)
    assert.equal(one.outcome.kind, 'continue')
    assert.equal(two.outcome.kind, 'done')

    const events = await eventsOf(root)
    const zones = events
      .filter((e) => e.t === 'prefix/assemble')
      .map((e) => e as { zoneAHash: string; zoneBHash: string; zoneCHash: string })
    assert.equal(zones.length, 2)
    // **A 与 B 逐字节相同**（相邻两步只有 C 变）：架构 § 8.11 那条验证性质的机制侧兑现。
    assert.equal(zones[0]?.zoneAHash, zones[1]?.zoneAHash)
    assert.equal(zones[0]?.zoneBHash, zones[1]?.zoneBHash)
    // C 变了。
    assert.notEqual(zones[0]?.zoneCHash, zones[1]?.zoneCHash)
    // C 有两件事要量，而它们不是同一件事：
    //
    //   一 · **积累段只追加**：`turns` 是那条尾巴（「运行时上下文」那一段），下一步是这一步的
    //        超集——逐项相同、只多几项。
    //   二 · **"每步被换掉"的那一段排在最后**：`上一步结果` 不是积累段（它是"刚过去那一步"的
    //        回执），所以它在 C 的**末尾**（架构 § 8.11 的区表：运行时上下文 · 信号摘要 ·
    //        上一步结果）。排在中间的话，"每步换掉它"就等于每步作废 C 的中段。
    //
    // **"C 整段是下一步的前缀"这句话是错的**，别把它写进断言：上面第一条（积累段往前长）与
    // 第二条（换掉的那段在末尾）合起来**不蕴含**整段是前缀——长出来的那几项插在积累段的末尾，
    // 而积累段后面还有一段（信号摘要）。**相邻两步真正的性质是"分歧点不早于积累段的起点"**：
    // 分歧不可能发生在 A+B（它们是同一串字节），只可能落在 C 里那两个该变的段上。
    const baseTurns = h0.state.turns ?? []
    const turnsNow = one.next.turns ?? []
    assert.deepEqual(turnsNow.slice(0, baseTurns.length), baseTurns, '积累段的前缀变了')
    assert.ok(turnsNow.length > baseTurns.length, '这一步没有往积累段里追加东西')
    const p1 = prefixAt({ ...h0, state: one.next })
    const c1 = p1.zoneC
    const after: AssembleState = {
      ...one.next,
      step: one.next.step + 1,
      // 换掉末尾那一段（**比原来长**：这样"分歧点"那条断言才有内容）
      lastStep: `工具的另一次回执：${'x'.repeat(200)}`,
      turns: [...turnsNow, turnOfText('第二步新加的一段。')],
    }
    const c2 = prefixAt({ ...h0, state: after }).zoneC
    assert.ok(c2.length > c1.length, `C 没有长：${c1.length} → ${c2.length}`)
    // 分歧点不早于积累段的起点：C 里"运行时上下文"那一段的正文在两步之间逐字节相同，
    // 而第一个不同的字节落在它后面。
    const text1 = new TextDecoder().decode(c1)
    const accStart = text1.indexOf('第 0 步。')
    assert.equal(accStart, 0, '「运行时上下文」不在 C 的开头——那这一条度量的是别的段')
    // 积累段那一段正文的**长度**：从它开头到「信号摘要」那一段的开头。
    const sigAt = text1.indexOf('sig-1')
    assert.ok(sigAt > 0, 'C 里找不到「信号摘要」那一段')
    const accBytes = new TextEncoder().encode(text1.slice(0, sigAt)).length
    const diverge = firstDivergence(c1, c2)
    assert.ok(
      diverge >= accBytes,
      `分歧点 ${diverge} 落在积累段内部（它到 ${accBytes} 字节处）——长出来的那几项插在了中段，不是末尾`,
    )
    // 换掉的那一段在末尾：它落在**最后一次**出现的位置上（前面那些出现是积累段里的同一段文本），
    // 而且 C1 以它收尾。
    assert.ok(text1.lastIndexOf(one.next.lastStep) > sigAt, '「上一步结果」不在「信号摘要」之后')
    assert.ok(text1.endsWith(`${one.next.lastStep}\n`), `C1 不是以「上一步结果」收尾：${JSON.stringify(text1.slice(-40))}`)
    // 而换掉的那一段（`上一步结果`）在 C 的末尾：它的正文在 C1 里找得到，且它在 C1 里一直到尾。
    assert.deepEqual(after.lastStep, `工具的另一次回执：${'x'.repeat(200)}`)
    assert.notDeepEqual(after.lastStep, one.next.lastStep)

    // A 与 B 也逐字节相同（不是只有哈希相同）。
    const p2 = prefixAt({ ...h0, state: one.next })
    assert.deepEqual(p1.zoneA, p2.zoneA)
    assert.deepEqual(p1.zoneB, p2.zoneB)
    console.log(
      `② 读数：A ${p1.zoneA.length} 字节 ${zones[0]?.zoneAHash} · B ${p1.zoneB.length} 字节 ${zones[0]?.zoneBHash} · ` +
        `C ${c1.length} → ${c2.length} 字节（${zones[0]?.zoneCHash} → ${zones[1]?.zoneCHash}）· ` +
        `第一步那一段仍逐字节在第二步的头部`,
    )
  })
})

// ── ③ 三种停因分得开 ─────────────────────────────────────────────────────────

test('③ 三种 StopReason（调用工具 · 自然停 · 预算耗尽）分得开，不混成"结束了"', async () => {
  await withRoot(async (root, log) => {
    const cases: { readonly stop: string; readonly kind: StepOutcome['kind']; readonly why: string | null }[] = [
      { stop: 'tool-calls', kind: 'continue', why: null },
      { stop: 'end-turn', kind: 'done', why: null },
      { stop: 'max-tokens', kind: 'failed', why: 'max-tokens' },
      { stop: 'stop-sequence', kind: 'failed', why: 'stop-sequence' },
      { stop: 'refusal', kind: 'failed', why: 'refusal' },
    ]
    const readings: string[] = []
    for (const one of cases) {
      const script: ModelEvent[] = [
        ...(one.stop === 'tool-calls' ? callOne(0, 'call_1', 'read', '{"path":"a.ts"}') : []),
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: one.stop as 'tool-calls', raw: `raw-${one.stop}` },
      ]
      const { rt, executor } = runtimeWith(log, [script])
      const r = await rt.step(handleOf(fixtureState(0)), new AbortController().signal)
      assert.equal(r.outcome.kind, one.kind, `${one.stop} 判成了 ${r.outcome.kind}`)
      if (one.kind === 'failed') {
        const err = (r.outcome as { error: HarnessError }).error
        assert.ok(err instanceof HarnessError, `${one.stop} 的 failed 没带 HarnessError`)
        assert.equal(err.why, one.why)
      } else {
        // 那两档的用量是**那四个数**（不是 0 顶出来的）。
        assert.equal((r.outcome as { usage: { cacheReadTokens: number | null } }).usage?.cacheReadTokens, 24000)
      }
      // 只有"要调工具"那一档才真的执行了工具。
      assert.equal(executor.seen.length, one.stop === 'tool-calls' ? 1 : 0)
      readings.push(`${one.stop}→${r.outcome.kind}${one.why === null ? '' : `(${one.why})`}`)
    }
    assert.equal(new Set(cases.map((c) => c.kind)).size, 3)
    console.log(`③ 读数：${readings.join(' · ')}`)
  })
})

// ── ④ 假模型 + 负对照 ────────────────────────────────────────────────────────

test('④ 用假模型驱动它，三区稳定性照旧成立；负对照：每步重写 C 区中部 → ② 变红', async () => {
  await withRoot(async (root, log) => {
    // 三步才收敛（前两步各调一次工具）。
    const scripts: readonly (readonly ModelEvent[])[] = [
      [...callOne(0, 'call_1', 'read', '{"path":"a.ts"}'), { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'tool-calls' }],
      [...callOne(0, 'call_2', 'glob', '{"pattern":"*.ts"}'), { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'tool-calls' }],
      [{ t: 'delta', text: '好了。' }, { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'end-turn' }],
    ]
    const { rt, executor } = runtimeWith(log, scripts)
    const h0 = handleOf(fixtureState(0))
    const r = await runSteps(rt, h0, new AbortController().signal)
    assert.equal(r.steps, 3)
    assert.equal(r.last.outcome.kind, 'done')
    assert.equal(executor.seen.length, 2)
    const seen: ToolCallRequest[] = executor.seen

    const events = await eventsOf(root)
    const zones = events
      .filter((e) => e.t === 'prefix/assemble')
      .map((e) => e as { zoneAHash: string; zoneBHash: string; zoneCHash: string })
    assert.equal(zones.length, 3)
    // 三步的 A 与 B 各一种指纹，C 三种（只追加）。
    assert.equal(new Set(zones.map((z) => z.zoneAHash)).size, 1)
    assert.equal(new Set(zones.map((z) => z.zoneBHash)).size, 1)
    assert.equal(new Set(zones.map((z) => z.zoneCHash)).size, 3)

    // 负对照：把 C 区**中部**改掉（重写，不是追加）→ ② 那条"只追加"当场变红。
    const base = fixtureState(0)
    const withTail: AssembleState = { ...base, turns: [turnOfText('甲'), turnOfText('乙'), turnOfText('丙')] }
    const rewritten: AssembleState = { ...withTail, turns: [turnOfText('甲'), turnOfText('X'), turnOfText('丙')] }
    const a = prefixAt({ ...h0, state: withTail })
    const b = prefixAt({ ...h0, state: rewritten })
    assert.notDeepEqual(a.zoneC, b.zoneC, '重写中部之后 C 竟然没变——那"只追加"这条就没有判据了')
    assert.notEqual(hashOf(a.zoneC), hashOf(b.zoneC))
    // 而 A 与 B 一个字都没动（改的只是 C 那一段）。
    assert.deepEqual(a.zoneA, b.zoneA)
    assert.deepEqual(a.zoneB, b.zoneB)
    console.log(
      `④ 读数：假模型 ${r.steps} 步收敛 · A/B 各一种指纹（${zones[0]?.zoneAHash}/${zones[0]?.zoneBHash}）· ` +
        `C 三种 · 工具被调 ${seen.length} 次（${seen.map((c) => c.name).join(' · ')}）`,
    )
  })
})

// ── ⑤ 真接缝：夹具走 `wireCall`（不是假模型），仍然不发一个字节出去 ─────────────

test('⑤ `wireCall` 接上 `B3` 的夹具档：夹具里那两条调用被执行，三区稳定性照旧', async () => {
  await withRoot(async (root, log) => {
    const executor = recordingExecutor((call) => ({ ok: true, output: `${call.name} 的回执` }))
    // 第一步走**真接缝**（`wireCall` + 夹具传输：夹具里那条响应是 `tool-calls`，有两条调用）；
    // 第二步用脚本说"说完了"（否则夹具那一份会被一直重放）。
    let at = 0
    const reply = scriptedModel([[{ t: 'delta', text: '数完了。' }, { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'end-turn' }]])
    const call: CallModel = (request, signal) => {
      at += 1
      if (at > 1) return reply(request, signal)
      // `wireCall` 用的是 `fetchTransport`，那会真出网——所以这一档换掉传输：夹具那一份直接喂回去。
      const stream = callModel(
        request.target,
        {
          model: request.model,
          zones: { A: request.prefix.zoneA, B: request.prefix.zoneB, C: request.prefix.zoneC },
          tools: request.tools,
          ...(request.call === undefined ? {} : { call: request.call }),
        },
        fixtureTransport(FIXTURE, 1),
      )
      return {
        events: stream.events,
        ledger: () => {
          const l = stream.ledger()
          return { call: l.call, failure: l.failure }
        },
      }
    }
    const rt = createRuntime({ logOf: () => log, call, execute: executor, tools })
    const r = await runSteps(rt, handleOf(fixtureState(0)), new AbortController().signal)
    assert.equal(r.steps, 2)
    assert.equal(r.last.outcome.kind, 'done')
    // 夹具里那两条调用都被执行了（`bash` 与 `glob`），名字与参数就是夹具里写的那两份。
    assert.deepEqual(executor.seen.map((c) => c.name), ['bash', 'glob'])
    assert.equal(executor.seen[0]?.arguments, '{"command":"ls -la","timeout_ms":10000}')

    const events = await eventsOf(root)
    const calls = events.filter((e) => e.t === 'llm/call') as { usage: Record<string, number | null>; stop: string | null }[]
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.usage.cacheReadTokens, 24000)
    assert.equal(calls[0]?.usage.cacheWriteTokens, 0)
    assert.equal(calls[0]?.stop, 'tool-calls')
    assert.equal(calls[1]?.stop, 'end-turn')
    // 三区稳定性在真接缝上照旧（A/B 一种指纹，C 两种）。
    const zones = events
      .filter((e) => e.t === 'prefix/assemble')
      .map((e) => e as { zoneAHash: string; zoneBHash: string; zoneCHash: string })
    assert.equal(new Set(zones.map((z) => z.zoneAHash)).size, 1)
    assert.equal(new Set(zones.map((z) => z.zoneBHash)).size, 1)
    assert.equal(new Set(zones.map((z) => z.zoneCHash)).size, 2)
    console.log(
      `⑤ 读数：夹具那两条调用被 ${executor.seen.map((c) => c.name).join(' · ')} 执行 · ` +
        `用量 ${JSON.stringify(calls[0]?.usage)} · 停因 ${calls[0]?.stop} → ${calls[1]?.stop} · ` +
        `C 两种指纹（${zones.map((z) => z.zoneCHash).join(' → ')}）`,
    )
  })
})

// ── ⑥ 半截的流：三档里的 failed，账仍然落一条（`stop: null`） ────────────────────

test('⑥ 半截的流 → `failed` · 不静默重试，而 `llm/call` 仍然落一条（`stop: null`）', async () => {
  await withRoot(async (root, log) => {
    let asked = 0
    const cut: CallModel = () => {
      asked += 1
      return {
        events: (async function* (): AsyncGenerator<ModelEvent> {
          yield { t: 'delta', text: '说到一半' }
          throw new HarnessError('cut-stream', '上游掐了')
        })(),
        ledger: () => ({ call: null, failure: 'HarnessError: 上游掐了' }),
      }
    }
    const rt = createRuntime({ logOf: () => log, call: cut, execute: recordingExecutor(() => ({ ok: true, output: '' })), tools })
    const r = await rt.step(handleOf(fixtureState(0)), new AbortController().signal)
    // 抛在事件流里：`step` 把它收成 `failed`（而不是让异常一路穿出去）。
    assert.equal(r.outcome.kind, 'failed')
    assert.equal((r.outcome as { error: HarnessError }).error.why, 'cut-stream')
    assert.equal(asked, 1, `上游被问了 ${asked} 次——"不静默重试"这条被破坏了`)
    const events = await eventsOf(root)
    const calls = events.filter((e) => e.t === 'llm/call') as { stop: string | null }[]
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.stop, null, '半截的流那条 `llm/call` 的 `stop` 不是 null')
    console.log(`⑥ 读数：半截的流 → ${(r.outcome as { error: HarnessError }).error.why} · 上游被问 ${asked} 次 · llm/call 落 1 条（stop=null）`)
  })
})

// ── ⑦ 上游给的原话：状态码与白名单响应头进已有的 `llm/call`（不新开一族事件）────────

test('⑦ 失败那一趟：状态码与请求号进 `llm/call` 的 status/headers；成功那一趟两栏都是 null', async () => {
  await withRoot(async (root, log) => {
    const said = { status: 429, 'x-request-id': 'req-abc-123', 'retry-after': '7' }
    const refused: CallModel = () => ({
      events: (async function* (): AsyncGenerator<ModelEvent> {
        throw new HarnessError('cut-stream', '上游 429', said)
      })(),
      ledger: () => ({ call: null, failure: 'HarnessError: 上游 429' }),
    })
    const rt = createRuntime({ logOf: () => log, call: refused, execute: recordingExecutor(() => ({ ok: true, output: '' })), tools })
    const r = await rt.step(handleOf(fixtureState(0)), new AbortController().signal)
    assert.equal(r.outcome.kind, 'failed')
    const events = await eventsOf(root)
    const bad = events.filter((e) => e.t === 'llm/call') as { status: number | null; headers: Record<string, string> | null; stop: string | null }[]
    assert.equal(bad.length, 1)
    assert.equal(bad[0]?.stop, null, '失败那一趟的 stop 该是 null')
    assert.equal(bad[0]?.status, 429, '状态码没进日志——排障时只剩 stderr 上的一句话')
    assert.equal(bad[0]?.headers?.['x-request-id'], 'req-abc-123')
    assert.equal(bad[0]?.headers?.['retry-after'], '7')

    // 成功那一趟：**两栏都是 null**（默认档一个字节都不多）。
    await withRoot(async (root2, log2) => {
      const reply = scriptedModel([[{ t: 'delta', text: '数完了。' }, { t: 'stop', reason: 'end-turn' }]])
      const rt2 = createRuntime({ logOf: () => log2, call: reply, execute: recordingExecutor(() => ({ ok: true, output: '' })), tools })
      const r2 = await rt2.step(handleOf(fixtureState(0)), new AbortController().signal)
      assert.equal(r2.outcome.kind, 'done')
      const good = (await eventsOf(root2)).filter((e) => e.t === 'llm/call') as { status: number | null; headers: unknown }[]
      assert.equal(good.length, 1)
      assert.equal(good[0]?.status, null, '成功那一趟的 status 该是 null')
      assert.equal(good[0]?.headers, null, '成功那一趟的 headers 该是 null')
    })
    console.log(`⑦ 读数：失败那一趟 status=${bad[0]?.status} headers=${JSON.stringify(bad[0]?.headers)}；成功那一趟两栏都是 null`)
  })
})

// ── ⑧ W6 · turns 贯通：state 里的尾巴真的流到发出去的字节 ──────────────────────

test('⑧ 第二步的请求带上第一步的往返：RuntimeRequest.turns 有它，发出去的字节里有 tool_use/tool_result 一开一合', async () => {
  await withRoot(async (root, log) => {
    const executor = recordingExecutor((call) => ({ ok: true, output: `${call.name} 的回执` }))
    /** 抓到的那些 RuntimeRequest（第二步那一份是主角）。 */
    const seenReq: { turns?: readonly Turn[] }[] = []
    let at = 0
    const reply = scriptedModel([[{ t: 'delta', text: '数完了。' }, { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'end-turn' }]])
    const call: CallModel = (request, signal) => {
      at += 1
      seenReq.push({ ...(request.turns === undefined ? {} : { turns: request.turns }) })
      if (at > 1) return reply(request, signal)
      const stream = callModel(
        request.target,
        {
          model: request.model,
          zones: { A: request.prefix.zoneA, B: request.prefix.zoneB, C: request.prefix.zoneC },
          tools: request.tools,
          ...(request.call === undefined ? {} : { call: request.call }),
        },
        fixtureTransport(FIXTURE, 1),
      )
      return {
        events: stream.events,
        ledger: () => {
          const l = stream.ledger()
          return { call: l.call, failure: l.failure }
        },
      }
    }
    const rt = createRuntime({ logOf: () => log, call, execute: executor, tools })
    const r = await runSteps(rt, handleOf(fixtureState(0)), new AbortController().signal)
    assert.equal(r.steps, 2)
    assert.equal(r.last.outcome.kind, 'done')

    // 一 · RuntimeRequest.turns：第一步**没有**（那时候还没有往返），第二步**有**——
    //     而且那一条 Turn 里就是夹具那两条调用与执行器的回执（逐条对位）。
    assert.equal(seenReq[0]?.turns, undefined, '第 0 步不该带 turns')
    const walked = seenReq[1]?.turns ?? []
    assert.equal(walked.length, 1, '第二步只该有第一步那一条 Turn')
    assert.deepEqual(walked[0]?.calls.map((c) => c.name), ['bash', 'glob'], 'Turn 里那两条就是夹具里的')
    assert.equal(walked[0]?.calls[0]?.arguments, '{"command":"ls -la","timeout_ms":10000}')
    assert.deepEqual(walked[0]?.results.map((x) => x.output), ['bash 的回执', 'glob 的回执'])
    assert.ok(walked[0]?.results.every((x) => !x.isError), '两条都是成功档')

    // 二 · 真正发出去的字节：把第二步那份 RuntimeRequest 喂给 makeDumpCall（记录型传输，
    //     不出网），断言 body 里有 tool_use 与 tool_result 一开一合、id 配对。
    const bodies: string[] = []
    const spy: Transport = {
      async *post(_t, body, _sig) {
        bodies.push(new TextDecoder().decode(body))
        yield* fixtureTransport(FIXTURE, 1).post(_t, body, _sig)
      },
    }
    const dump = makeDumpCall(join(root, 'dump-w6'), spy)
    // 第二步会收到夹具的回放（tool-calls）——没有关系，这里只看**发出去的字节**。
    await dump(
      {
        target: fixtureTarget(FIXTURE),
        adapter: fixtureTarget(FIXTURE).wire,
        prefix: assemble({ protocol: SUBAGENT_PROTOCOL, model: DECL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, r.last.next, WHO) }),
        tools,
        promptCache: 'implicit',
        model: fixtureTarget(FIXTURE).model,
        turns: walked,
      },
      new AbortController().signal,
    ).events[Symbol.asyncIterator]().next().catch(() => undefined)
    const sent = bodies[0] ?? ''
    assert.ok(sent.includes('"type":"tool_use"'), '发出的字节里要有 tool_use')
    assert.ok(sent.includes('"type":"tool_result"'), '发出的字节里要有 tool_result')
    const ids = [...sent.matchAll(/"id":"(toolu_[^"]+)"/g)].map((m) => m[1])
    const paired = [...sent.matchAll(/"tool_use_id":"(toolu_[^"]+)"/g)].map((m) => m[1])
    assert.equal(new Set(paired).size, paired.length, 'tool_use_id 不重复')
    assert.ok(paired.every((id) => ids.includes(id)), '每一条 tool_result 都配得上对')
    console.log(`⑧ 读数：第二步带 ${String(walked.length)} 条 Turn · 发出 ${String(Buffer.byteLength(sent, 'utf8'))} 字节 · ${String(paired.length)} 条配对`)
  })
})

// ── ⑨ W11 · 收工口径那三句进 B 区，预算那个数跟着状态走 ──────────────────────

test('⑨ 「我的任务」带三句收工口径（预算 · 交卷 · 断言谁跑）：预算逐字在里面 · 缺省不写那一句 · 改预算动 B 不动 A · 改步号不动 B', () => {
  const dec = (b: Uint8Array): string => new TextDecoder().decode(b)
  const p5 = prefixAt(handleOf({ ...fixtureState(0), maxSteps: 5 }))
  const b5 = dec(p5.zoneB)

  // 一 · 三句都在 B 区那一段里（架构 § 8.11 那张表：「我的任务」属于 B 区）。
  const three = [
    'At most 5 steps for this task.',
    'When the work is done, say so in one message and stop calling tools — handing in is ending the turn.',
    'The harness runs the assertions, not you.',
  ]
  for (const line of three) {
    assert.ok(b5.includes(line), `B 区里该有这一句：${line}\nB 区是：${JSON.stringify(b5)}`)
    assert.equal(dec(p5.zoneC).includes(line), false, `C 区里不该有这一句（那句话每步都要重付）：${line}`)
    assert.equal(dec(p5.zoneA).includes(line), false, `A 区里不该有这一句（它逐 agent 各不相同）：${line}`)
  }
  // 产物路径照旧是那一段的最后一行（架构 § 8.11 那句"近因最好"：模型读到这里就动手）。
  const last = b5.trimEnd().split('\n').at(-1) ?? ''
  assert.equal(last, `Output paths: ${WHO.outputPaths.join(' · ')}`, `「我的任务」最后一行该是产物路径，实际是：${last}`)

  // 二 · 负对照一：换一个预算 → 那一句逐字跟着变（它不是一句写死的话），而 A 区一个字节不动。
  const p4 = prefixAt(handleOf({ ...fixtureState(0), maxSteps: 4 }))
  const b4 = dec(p4.zoneB)
  assert.ok(b4.includes('At most 4 steps for this task.'), `B 区里该写 4：${JSON.stringify(b4)}`)
  assert.equal(b4.includes('At most 5 steps for this task.'), false, '换了预算，旧那个数不该还在')
  assert.notEqual(hashOf(p4.zoneB), hashOf(p5.zoneB), '预算变了，B 区的指纹该跟着变')
  assert.equal(hashOf(p4.zoneA), hashOf(p5.zoneA), '预算变了，A 区不该动（它不认识「我的任务」）')

  // 三 · 负对照二：**只有步号变**（同一格的下一步）→ B 区逐字节不动，C 区跟着变。
  //     它守的是"预算那一句不许写成'这是第几步'"：那一个字每步都变，B 区跨步复用那条性质
  //     当场破掉——`step` 到今天为止都不进前缀，正是为了同一件事。
  const p1 = prefixAt(handleOf({ ...fixtureState(1), maxSteps: 5 }))
  assert.equal(hashOf(p1.zoneB), hashOf(p5.zoneB), '只有步号变，B 区该逐字节相同')
  assert.notEqual(hashOf(p1.zoneC), hashOf(p5.zoneC), '步号变了，C 区该跟着变（负对照的另一半）')

  // 四 · 地板那一档：不给预算 → 那一句不写，另两句照在，装配照跑（不抛）。
  const bare = prefixAt(handleOf(fixtureState(0)))
  const bb = dec(bare.zoneB)
  assert.equal(bb.includes('At most '), false, '没给预算就不该写那一句')
  assert.ok(bb.includes('When the work is done, say so in one message and stop calling tools — handing in is ending the turn.'), '另两句是常量，照旧在')
  assert.ok(bb.includes('The harness runs the assertions, not you.'), '另两句是常量，照旧在')
  console.log(
    `⑨ 读数：B 区带预算 ${p5.zoneB.length} 字节 · 不带预算 ${bare.zoneB.length} 字节（差 ${p5.zoneB.length - bare.zoneB.length}）` +
      ` · 改步号 B 区指纹 ${hashOf(p1.zoneB)} 与带预算那份相同 · C 区指纹 ${hashOf(p1.zoneC)} ≠ ${hashOf(p5.zoneC)}`,
  )
})
