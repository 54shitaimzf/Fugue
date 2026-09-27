// C5 的断言（PLAN § 5.10 的 C5 行 · 架构 § 15.1.a 的"问与答"与那张两态表 · 架构 § 9.10 的保留
// 前缀 · 架构 § 8.11 的两段投影 · 架构 § 23 U10 的"最近几次 = 3 条" · 架构 § 8.13 的"`Idle` 是
// 讨论态"）。跑法：cd ~/fugue && node --test src/round/say.test.ts
//
//   ① **讨论态**：说一句 → 那一趟**每一步都读得到它**（它进的是尾端第一条，不被原生轮次挤掉——
//      量的是**发出去的请求体**，走的是产品那条适配器）→ 落一条 `holder/distill`（修正后的理解）
//      → 而这一态的处境**没动**（讨论不落地）
//   ② **预备态**：说一句 → 那一趟**改的是那份草案文件** → 重判 → **仍然停在门口**（一个契约都
//      没发）· **原话不另存**（工作区里找不到第二份：会话里没有 · 日志里没有 · 草案里没有）
//   ③ **没有"等"这种状态**：`sayRound` 返回时那一趟已经跑完（返回里的步数与日志里的 `llm/call`
//      条数逐条对得上）
//   ④ 会话记录那一段：一行一条（正文里的换行不会把一条拆成两条）· 投影是**最近 3 条**（数出来的）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import { createRoots } from '../roots/roots.ts'
import { HOLDER_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import type { AssembleState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import { modelDeclOf } from '../model/contract.ts'
import { scriptedModel } from '../runtime/step.ts'
import type { AgentHandle, CallModel, ModelEvent, RuntimeRequest, ToolExecutor } from '../runtime/step.ts'
import { wireRequestOf } from '../model/http.ts'
import { wireNamed } from '../model/wire/registry.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'
import { createToolHost } from '../tools/host.ts'
import { createToolExecutor } from '../capability/dispatch.ts'
import { identFor } from '../identity.ts'
import { refHeadOf } from './head.ts'
import { draftPathOf } from '../contract/draft.ts'
import type { DraftSection } from '../contract/draft.ts'
import { roundStateOf } from './dispatch.ts'
import { roundFactsOf } from './versions.ts'
import { planRound } from './plan.ts'
import { RECENT_COUNT, SayError, recentOf, recordOf, recordsOf, sayRound, sessionPathOf } from './say.ts'
import type { SayDeps } from './say.ts'
import type { PlanResult } from './plan.ts'

/** 计数版的读侧：`readByWriter` 被调几次就是「读了几遍日志」（其余几栏照旧）。 */
function countingLog(log: LogHandle, counter: { n: number }): LogHandle {
  return {
    ...log,
    readByWriter: (w, from) => {
      counter.n += 1
      return log.readByWriter(w, from)
    },
  }
}

const KEEP = process.env.KEEP === '1'
const dirs: string[] = []
const benches: Bench[] = []
process.on('exit', () => {
  if (KEEP) {
    if (dirs.length > 0) console.log(`（KEEP=1，现场留着：${dirs.join(' · ')}）`)
    return
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const DECL = modelDeclOf('deepseek-chat/anthropic')
const CATALOG = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
const ROUND = 'r1' as RoundId
const AGENT = 'round' as AgentId
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}
const USAGE = { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40, reasoningTokens: null, model: null }

/** 一条工具调用（三段：起点 · 分片 · 收尾）——字段名照 `B1` 的 `ModelEvent`。 */
function callOne(index: number, id: string, name: string, args: unknown): ModelEvent[] {
  const text = JSON.stringify(args)
  return [
    { t: 'tool-start', index, id, name },
    { t: 'tool-delta', index, args: text },
    { t: 'tool-call', index, id, name, arguments: text },
  ]
}

/** 一步：调一次工具。 */
function stepOf(index: number, id: string, name: string, args: unknown): ModelEvent[] {
  return [...callOne(index, id, name, args), { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }]
}

/** 一步：说一句就收工（`end-turn`）。**交卷就是话说完**。 */
function sayStep(text: string): ModelEvent[] {
  return [{ t: 'delta', text }, { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }]
}

interface Bench {
  readonly root: string
  readonly log: LogHandle
  readonly truth: ReturnType<typeof openTruth>
  readonly base: CommitId
  readonly head: CommitId
  readonly view: Awaited<ReturnType<typeof loadView>>
  readonly execute: ToolExecutor
  /**
   * 收尾：openLog 与 openTruth 各带一个**常驻** git cat-file --batch-command 子进程
   * （架构 § 8.2 的读档位「批量」）——不关，node --test 那个进程跑完测试也不退。
   */
  readonly close: () => Promise<void>
}

/**
 * 断言抛了也要收尾：不收，失败的那一档会挂着不退（实测 60 秒被超时砍）。
 */
after(async () => {
  for (const b of benches) {
    await b.log.close().catch(() => undefined)
    await b.truth.close().catch(() => undefined)
  }
})

/** 一份台子：真仓库（一个底提交 + 一份方针）· 持轮者那一个日志口 · 一张视图 · 一套工具面。 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-c5-'))
  dirs.push(root)
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  writeFileSync(join(root, 'AGENTS.md'), '# 方针\n\n- 一条。\n')
  writeFileSync(join(root, 'notes.md'), '底里的一行。\n')
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  assert.equal(base.length, 40, '读不出底那个提交')
  const truth = openTruth(root)
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  const hasMain = await truth.resolve('refs/heads/main' as never).then(
    () => true,
    () => false,
  )
  if (!hasMain) await truth.advance('refs/heads/main' as never, base, null)
  const view = await loadView(log, 'round' as WriterId, { lower: lowerAt(truth, base) })
  const head = await refHeadOf(log, 'round' as WriterId, base)
  const host = createToolHost(view, createRoots(root as never), {
    actions: { writer: 'round' as WriterId, log, truth, head },
  })
  const execute = createToolExecutor({
    logOf: () => log,
    host,
    fenceOf: (raw, cwd) => {
      const got = createRoots(root as never).resolveVirtual(raw, cwd as RelPath)
      return got.ok ? { ok: true as const, value: got.value } : { ok: false as const, error: got.error }
    },
  })
  const made: Bench = {
    root,
    log,
    truth,
    base,
    head,
    view,
    execute,
    close: async () => {
      await log.close().catch(() => undefined)
      await truth.close().catch(() => undefined)
    },
  }
  benches.push(made)
  return made
}

/**
 * 一个"看得见请求体"的假模型：**把每一次调用真的渲染一遍**（走产品那条适配器 +
 * `wireRequestOf`），再把事件交给脚本。
 *
 * 由头：C5 断言 ① 里"每一步都读得到它"量的是**发出去的字节**——假模型直接读 `handle.state`
 * 的话，量到的是装配那一侧，而"被原生轮次挤掉"这件事发生在适配器那一侧（两条线协议）。
 */
function spyModel(scripts: readonly (readonly ModelEvent[])[]): {
  readonly call: CallModel
  readonly bodies: string[]
  readonly requests: RuntimeRequest[]
} {
  const inner = scriptedModel(scripts)
  const bodies: string[] = []
  const requests: RuntimeRequest[] = []
  const adapter = wireNamed('anthropic-messages')
  const call: CallModel = (request, signal) => {
    requests.push(request)
    bodies.push(new TextDecoder().decode(adapter.bytes(wireRequestOf(request))))
    return inner(request, signal)
  }
  return { call, bodies, requests }
}

/** 说一句话要的那几样（与 CLI 那一档同一个形状：`makeHandle` 是唯一一处按这一趟拼状态的地方）。 */
function sayDeps(
  b: Bench,
  opts: {
    readonly text: string
    readonly call: CallModel
    readonly goal?: string
    readonly distill?: string
    /** 不给就读台子那一份；给了就量「读了几遍」（`countingLog`）。 */
    readonly log?: LogHandle
    /** 这一轮的读数（`roundFactsOf`）：给了它，这一趟就不该再去读日志。 */
    readonly facts?: Awaited<ReturnType<typeof roundFactsOf>>
  },
): SayDeps {
  const goal = opts.goal ?? ''
  const distill = opts.distill ?? ''
  const makeHandle = (over: { readonly runtime: string; readonly recent: string }): AgentHandle => {
    const state: AssembleState = {
      ...emptyState(),
      ...fixtureState(0),
      step: 0,
      cwd: '',
      policy: '# 方针\n\n- 一条。\n',
      goal,
      distill,
      recent: over.recent,
      ...(over.runtime === '' ? {} : { runtime: over.runtime }),
    }
    return {
      agent: AGENT,
      coord: null,
      branch: 'refs/heads/main' as BranchId,
      contract: '' as ContractId,
      protocol: HOLDER_PROTOCOL,
      model: DECL.id,
      wireModel: 'deepseek-chat',
      target: { providerId: 'fixture', host: '', wire: { name: 'anthropic-messages' }, path: '', model: 'deepseek-chat', from: 'fixture', headers: {} },
      adapter: { name: 'anthropic-messages' },
      state,
    }
  }
  return {
    round: ROUND,
    text: opts.text,
    view: b.view,
    log: opts.log ?? b.log,
    truth: b.truth,
    writer: 'round' as WriterId,
    head: b.head,
    goal,
    distill,
    makeHandle,
    call: opts.call,
    execute: b.execute,
    tools: CATALOG,
    maxSteps: 8,
    ...(opts.facts === undefined ? {} : { facts: opts.facts }),
  }
}

/** 轮级日志里全部事件，按写入次序。 */
async function roundEvents(b: Bench): Promise<LogEvent[]> {
  const out: LogEvent[] = []
  for await (const e of b.log.readByWriter('round' as WriterId)) out.push(e)
  return out
}

const ofType = <T extends LogEvent['t']>(rows: readonly LogEvent[], t: T): Extract<LogEvent, { t: T }>[] =>
  rows.filter((e) => e.t === t) as Extract<LogEvent, { t: T }>[]

/** 两条必须键都齐的一节。 */
function section(over: Partial<DraftSection> = {}): Record<string, unknown> {
  return {
    kind: 'implement',
    goal: '把解析器拆成独立模块',
    ownedPaths: ['src/parse.ts'],
    deliverables: [{ path: 'src/parse.ts', form: '模块' }],
    assertions: [{ action: 'ok', name: '单元测试全过' }],
    seed: [],
    ...over,
  }
}

function draftText(sections: readonly Record<string, unknown>[], prose = '为什么这么拆：两格可以并行。'): string {
  return `${prose}\n\n${sections.map((s, i) => `## 第 ${i + 1} 节\n\n\`\`\`json\n${JSON.stringify(s)}\n\`\`\``).join('\n\n')}\n`
}

/** 一趟预备态（走产品那一份 `planRound`）：讨论态与预备态的差别只在"这一趟是干什么的"。 */
async function runPlan(b: Bench, handle: AgentHandle, goal: string, call: CallModel, judgeOnly: boolean): Promise<PlanResult> {
  return await planRound({
    base: b.base,
    view: b.view,
    log: b.log,
    round: ROUND,
    goal,
    identityFor: (n: number) => identFor(ROUND, n),
    // 绑好的动作表：这一份台子把 `ok` 绑上、不声明产出（一条只跑退出码的断言）。
    actions: { ok: [] as readonly RelPath[] },
    handle,
    decl: DECL,
    call,
    execute: b.execute,
    tools: CATALOG,
    maxSteps: 8,
    ...(judgeOnly ? { judgeOnly: true } : {}),
    occupancy: {
      decl: DECL,
      base: { ...emptyState(), ...fixtureState(0), step: 0, cwd: '' },
      goal,
      round: ROUND,
      maxSteps: 8,
      tools: JSON.stringify(CATALOG),
    },
  })
}

test('① 讨论态：说一句 → 每一步都读得到它（请求体里）→ 落一条 holder/distill · 处境没动', async () => {
  const b = await bench()
  // 会话记录里先有四条旧话：投影取**最近 3 条**，最旧那一条不许进前缀。
  const seeded = recordOf(recordOf(recordOf(recordOf('', '人', '旧话一'), '持轮者', '旧答一'), '人', '旧话二'), '持轮者', '旧答二')
  await b.view.write(sessionPathOf(ROUND), new TextEncoder().encode(seeded))

  const sentence = '把解析器拆成两格再动手'
  const said = '理解更新：这一轮要把解析器拆出来，先拆成两格，各自带一条单元测试。'
  const spy = spyModel([stepOf(0, 'c1', 'read', { path: 'notes.md' }), sayStep(said)])
  const r = await sayRound(sayDeps(b, { text: sentence, call: spy.call }))

  assert.equal(r.where, '讨论态')
  // **讨论不落地**：这一态的处境没动（`Idle` 是讨论态，架构 § 8.13）。
  assert.equal(r.state, 'Idle')
  assert.equal(r.steps, 2)
  assert.equal(r.distill, said, '这一趟的产物该是它最后说的那一段话（修正后的理解）')

  // 一 · **每一步都读得到它**：两次调用**发出去的请求体**里都有那句话。
  assert.equal(spy.bodies.length, 2, `这一趟该发两次调用，实际 ${spy.bodies.length} 次`)
  for (const [at, body] of spy.bodies.entries()) {
    assert.ok(body.includes(sentence), `第 ${at} 步发出去的请求体里没有那句话：${body.slice(0, 400)}`)
  }
  // 而**第二步就是带原生轮次的那一步**（第 0 步那一对必须在里面）——原先那句话正是在这一档消失的。
  assert.ok((spy.requests[1]?.turns?.length ?? 0) === 1, '第二步该带一条原生轮次')
  assert.ok(
    (spy.bodies[1] ?? '').includes('tool_use') && (spy.bodies[1] ?? '').includes('tool_result'),
    `第二步没带上原生轮次那一对：${(spy.bodies[1] ?? '').slice(0, 400)}`,
  )
  assert.equal(spy.requests[0]?.turns, undefined, '第 0 步不该有轮次')
  // **那一段头由 `cHead` 发出去**（第 1 步起尾巴换成原生轮次，头照旧要发）——这一条必须单独判：
  // 请求体里那句话在讨论态**还有第二处来路**，会话记录那一段投影（B 区）里就带着它，于是"字节里
  // 有它"钉不住 C 区那一段头。负对照实测：把 `cZoneHeadOf` 抹空，只判字节那一条照旧绿，加上这一
  // 条才红。
  for (const [at, req] of spy.requests.entries()) {
    assert.equal(new TextDecoder().decode(req.cHead ?? new Uint8Array()), sentence, `第 ${at} 步没把那一句发成 C 区那一段的头`)
  }

  // 二 · 产物：那一条 `holder/distill`（正文全文，一处不缺）。
  const distills = ofType(await roundEvents(b), 'holder/distill')
  assert.equal(distills.length, 1, `该恰好一条 holder/distill，实际 ${distills.length} 条`)
  assert.equal(distills[0]?.body, said)
  assert.equal(distills[0]?.round, ROUND)

  // 三 · 处境没动：这一趟**一条 `round/state` 都没有**。
  assert.equal(ofType(await roundEvents(b), 'round/state').length, 0, '讨论那一趟落了 round/state——讨论不落地')

  // 四 · 对话：**人说的那一句由接口写进去**，它那一侧的输出跟着落一条。
  const session = new TextDecoder().decode((await b.view.read(sessionPathOf(ROUND))) ?? new Uint8Array())
  const read = recordsOf(session)
  assert.equal(read.bad.length, 0)
  assert.equal(read.records.length, 6, `四条旧的 + 那两句 = 6 条，实际 ${read.records.length} 条`)
  assert.equal(read.records.at(-2)?.text, sentence)
  assert.equal(read.records.at(-2)?.who, '人')
  assert.equal(read.records.at(-1)?.text, said)
  assert.equal(read.records.at(-1)?.who, '持轮者')

  // 五 · 投影：**最近 3 条**（"旧话一"不许在里面）。
  assert.equal(r.recent.split('\n').length, RECENT_COUNT, `投影该是 ${RECENT_COUNT} 条：${r.recent}`)
  assert.ok(!r.recent.includes('旧话一'), `投影里出现了更早的话：${r.recent}`)
  assert.ok(r.recent.includes('旧答二') && r.recent.includes(sentence), r.recent)
  console.log(
    `① 读数：两次调用的请求体里都有那句话 · 第二步带 ${spy.requests[1]?.turns?.length ?? 0} 条原生轮次 · ` +
      `产物 ${said.length} 字进 holder/distill · 对话 ${read.records.length} 条 · 投影 ${r.recent.split('\n').length} 条 · round/state 0 条`,
  )
})

test('② 预备态：说一句 → 改的是那份草案 → 重判仍停在门口 · 原话不另存', async () => {
  const b = await bench()
  const goal = '把解析器拆出来'
  const draftPath = draftPathOf(ROUND)
  const v1 = draftText([section()])
  await b.view.write(draftPath, new TextEncoder().encode(v1))
  // 先落地一轮预备态（**人喊停那一档**：草案由人放进视图，机器只判）——处境因此是 `Planning`。
  const first = await runPlan(b, sayDeps(b, { text: 'x', call: spyModel([sayStep('不用跑')]).call }).makeHandle({ runtime: '', recent: '' }), goal, spyModel([sayStep('不用跑')]).call, true)
  assert.equal(first.held, true, `第一趟该停在门口：${first.gate.problems.join(' / ')}`)

  const sentence = '第二节也要拆，别只动第一节'
  const v2 = draftText([section(), section({ goal: '把调用方改到新模块上', ownedPaths: ['src/callers'] })])
  const spy = spyModel([stepOf(0, 'w1', 'write', { path: draftPath, content: v2 }), sayStep('照这句话改了第二节。')])
  const deps = sayDeps(b, { text: sentence, call: spy.call, goal, distill: v1 })
  const r = await sayRound({
    ...deps,
    plan: async (over) =>
      await runPlan(b, deps.makeHandle({ runtime: over.runtime, recent: over.recent }), over.goal, spy.call, false),
  })

  assert.equal(r.where, '预备态')
  assert.equal(r.state, 'Planning')
  assert.equal(r.plan?.held, true, `该仍然停在门口：${r.plan?.gate.problems.join(' / ')}`)

  // 一 · **这一趟改的是那份草案文件**：视图里那一份成了 v2，而日志里多了一条正文 = v2 的版本。
  const now = new TextDecoder().decode((await b.view.read(draftPath)) ?? new Uint8Array())
  assert.equal(now, v2, '这一趟没改成那份草案')
  const distills = ofType(await roundEvents(b), 'holder/distill')
  assert.equal(distills.length, 2, `该两条版本（v1 · v2），实际 ${distills.length} 条`)
  assert.equal(distills[0]?.body, v1, '第 1 条该是最初那一版')
  assert.equal(distills[1]?.body, v2, '第 2 条该是这一趟改出来的那一版')
  assert.equal(r.distill, v2)
  // **链**：第 2 条记着它从第 1 条改出来的（`against` = 上一版的正文指纹），第 1 条没有那一栏。
  assert.equal('against' in (distills[0] as object), false, `第 1 版不该有 against：${JSON.stringify(distills[0])}`)
  assert.equal(distills[1]?.against, distills[0]?.digest, '第 2 版该记着第 1 版的指纹')

  // 二 · **一个契约都没发**（重判仍停在门口），而处境照旧只走过那一条。
  assert.equal(ofType(await roundEvents(b), 'contract/issue').length, 0, '门停着却发了契约')
  const states = ofType(await roundEvents(b), 'round/state')
  assert.equal(states.length, 1, `处境只该走过 Idle → Planning，实际 ${states.length} 条`)
  assert.equal(states[0]?.from, 'Idle')
  assert.equal(states[0]?.to, 'Planning')

  // 三 · **原话不另存**：会话记录里没有它 · 日志里没有它 · 草案里也没有它。
  assert.equal(existsSync(join(b.root, '.fugue', 'session', `${ROUND}.jsonl`)), false, '预备态里落了一份会话记录')
  assert.equal(
    readFileSync(join(b.root, '.fugue', 'log', 'round.jsonl'), 'utf8').includes(sentence),
    false,
    '那句话进了日志（架构 § 15.1.a：原话照旧不落在日志里）',
  )
  assert.equal(v2.includes(sentence), false)
  // **而这一趟真的读到了它**——不然上面那三条都是空的。
  assert.ok((spy.bodies[0] ?? '').includes(sentence), '这一趟的请求体里没有那句话：那上面三条就不是"不另存"')
  console.log(
    `② 读数：草案 v1 ${v1.length} 字节 → v2 ${v2.length} 字节 · 两条 holder/distill（第 1 条 = v1）· ` +
      `contract/issue 0 条 · round/state 1 条 · 原话在工作区里出现 0 次 · 而请求体里有它`,
  )
})

test('③ 没有"等"这种状态：返回时那一趟已经跑完（步数与日志里的 llm/call 条数相等）', async () => {
  const b = await bench()
  const sentence = '先看一眼这两个文件'
  const spy = spyModel([
    stepOf(0, 'c1', 'read', { path: 'notes.md' }),
    stepOf(1, 'c2', 'read', { path: 'AGENTS.md' }),
    sayStep('看过了。'),
  ])
  const r = await sayRound(sayDeps(b, { text: sentence, call: spy.call }))
  assert.equal(r.steps, 3)
  assert.equal(spy.bodies.length, 3)
  // **不在后台挂一个**：返回里那几步与日志里那几条 `llm/call` 是同一趟（一条不多一条不少）。
  assert.equal(ofType(await roundEvents(b), 'llm/call').length, r.steps, '那一趟没跑完就返回了')
  for (const [at, body] of spy.bodies.entries()) {
    assert.ok(body.includes(sentence), `第 ${at} 步的请求体里没有那句话`)
  }
  console.log(`③ 读数：${r.steps} 步 · 3 次调用 · 日志里 llm/call 3 条 · 三次请求体里都有那句话`)
})

test('④ 会话记录：一行一条（正文里的换行不拆条）· 投影是最近 3 条 · 坏行如实报出来', () => {
  assert.equal(sessionPathOf(ROUND), '.fugue/session/r1.jsonl')
  const one = recordOf('', '人', '换行\n也要算一条')
  assert.equal(recordsOf(one).records.length, 1, '正文里的换行把一条拆成了两条')
  assert.equal(recordsOf(one).records[0]?.text, '换行\n也要算一条')

  let s = ''
  for (let i = 1; i <= 5; i++) s = recordOf(s, i % 2 === 0 ? '持轮者' : '人', `第 ${i} 句`)
  assert.equal(recordsOf(s).records.length, 5)
  assert.equal(RECENT_COUNT, 3, '最近几次那个数是 3（架构 § 23 U10）')
  const recent = recentOf(s)
  assert.equal(recent.split('\n').length, RECENT_COUNT, recent)
  assert.ok(!recent.includes('第 2 句'), `投影里出现了更早的话：${recent}`)
  assert.ok(recent.includes('第 3 句') && recent.includes('第 5 句'), recent)

  // 读不出来的那几行**如实报出来**，不当空行丢掉（"少了一条"与"这一条坏了"要分得开）。
  const broken = recordsOf(`${s}这不是一条 JSON\n`)
  assert.equal(broken.records.length, 5)
  assert.equal(broken.bad.length, 1)
  // 空记录：一条都没有（第一次说话之前这一场对话还没有一条）。
  assert.equal(recordsOf('').records.length, 0)
  assert.equal(recentOf(''), '')
  console.log(`④ 读数：5 条里投影 ${recent.split('\n').length} 条 · 坏行 ${broken.bad.length} 行如实报出来 · 空记录 0 条`)
})

test('⑤ 处境不对就拒：已经在跑的那一轮不吃这一句话 · 空话也拒（不落一条空记录）', async () => {
  const b = await bench()
  // 把处境推到合并那一段：说话只在 `Idle` 与 `Planning` 两处。
  await b.log.append('round' as WriterId, { t: 'round/state', round: ROUND, from: 'Working', to: 'Merging' })
  assert.equal(await roundStateOf(b.log, ROUND), 'Merging')
  const spy = spyModel([sayStep('不该跑')])
  await assert.rejects(
    () => sayRound(sayDeps(b, { text: '喂', call: spy.call })),
    (err: unknown) => {
      assert.ok(err instanceof SayError, String(err))
      assert.match((err as Error).message, /Merging/)
      assert.match((err as Error).message, /Idle（讨论态）与 Planning（预备态）/)
      return true
    },
  )
  assert.equal(spy.bodies.length, 0, '拒了却还是调了模型')
  assert.equal(existsSync(join(b.root, '.fugue', 'session', `${ROUND}.jsonl`)), false, '拒了却落了一条记录')
  await assert.rejects(() => sayRound(sayDeps(b, { text: '   ', call: spy.call })), /说什么/)
  console.log('⑤ 读数：Merging 那一档当场拒（0 次调用 · 0 条记录）· 空话也拒')
})

test('⑥ 一趟说话只读一遍轮次日志；给了那一份读数就一遍都不读', async () => {
  const b = await bench()
  try {
    const said = '理解更新：这一轮先把第一节拆出来。'
    const c1 = { n: 0 }
    const r1 = await sayRound(sayDeps(b, { text: '第一节也要拆', call: spyModel([sayStep(said)]).call, log: countingLog(b.log, c1) }))
    assert.equal(c1.n, 1, `不给读数时该只读一遍轮次日志，实际 ${c1.n} 遍`)
    assert.equal(r1.distill, said)
    // 同一份读数递进去：这一趟**一遍都不该读**。
    const facts = await roundFactsOf(b.log, ROUND)
    const c2 = { n: 0 }
    const r2 = await sayRound(
      sayDeps(b, { text: '再改一点', call: spyModel([sayStep('理解更新：改成两格。')]).call, log: countingLog(b.log, c2), facts }),
    )
    assert.equal(c2.n, 0, `给了读数还去读日志：${c2.n} 遍`)
    assert.equal(r2.landing?.at, 2, `这一趟落下的该是链上第 2 格，实际 ${String(r2.landing?.at)}`)
    console.log(`⑥ 读数：一趟说话读 ${c1.n} 遍轮次日志（不给读数）· ${c2.n} 遍（给了那一份读数）`)
  } finally {
    for (const one of benches.splice(0)) await one.close()
  }
})
