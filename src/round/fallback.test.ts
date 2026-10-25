// **角色层站的红判据**（路线图那一行的验收原文）：「角色路由可配带回退的断言——把主模型配死，
// 回退档接得住要能红；按模型分账的首账」。这一份在快档量（假传输 · 真 git · 真日志）：
//
//   ① **回退接得住**：主模型那台传输当场死（收下就抛）——换回退脸重试同一步，这一格照常收敛；
//      负对照：链不在（不配 round.fallback 的那一档）同一台死传输，这一格断在半路（failed）。
//   ② **那一跳落账 · 按模型分账的首账**：`model/fallback`（from 主脸 · to 回退脸）进日志；
//      两条 `llm/call` 各落各的 `model`——台账按模型分组，正好两组各一笔。
//   ③ **裁断那一格自己的链**：裁断的脸死掉换下一张，那一跳也落账；判出来了就停
//      （哪怕退化路——模型说了话，判决成立）。
//
// 跑法：cd ~/fugue && node --test src/round/fallback.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { openLog } from '../log/log.ts'
import type { Log, LogHandle } from '../log/events.ts'
import { openTruth } from '../truth/truth.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import type { Catalog } from '../model/catalog.ts'
import type { ModelDecl } from '../model/contract.ts'
import { wireNamed } from '../model/wire/registry.ts'
import { faceOf } from '../model/roles.ts'
import type { ModelFace } from '../model/roles.ts'
import type { Transport, Target } from '../model/http.ts'
import { wireCallOver } from '../runtime/step.ts'
import type { CallModel, ModelEvent } from '../runtime/step.ts'
import { recordingExecutor } from '../runtime/step.ts'
import { runAgentOnce, withStepsLeft } from './driver.ts'
import type { DriverAsk, DriverResult } from './driver.ts'
import { takeAsks } from './handback.ts'
import type { ToolExecutor, ToolCallRequest } from '../runtime/step.ts'
import { ledgerOf } from '../probe/ledger.ts'
import type { LedgerRow } from '../probe/ledger.ts'
import type { AgentId, CommitId, ContractId, RelPath, WriterId } from '../terms.ts'
import type { Contract } from '../contract/types.ts'

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

/** 一份两模型的测试目录：主脸与回退脸（同一台假传输按「提供方那边的名字」分岔）。 */
const PRIMARY: ModelDecl = {
  id: 'test/primary',
  protocol: 'subagent',
  provider: 'testco',
  wire: 'openai-chat',
  model: 'test-main',
  systemPromptUpdate: 'in-history',
  contextLimit: 100_000,
  budget: { trigger: 35_000, handoffMargin: 4_000 },
  call: { thinking: 'off' },
}
const BACKUP: ModelDecl = { ...PRIMARY, id: 'test/backup', model: 'test-backup' }
const TEST_CAT: Catalog = {
  providers: { testco: { id: 'testco', host: 'https://test.invalid' } },
  models: { [PRIMARY.id]: PRIMARY, [BACKUP.id]: BACKUP },
  prices: [],
}

/** 回退脸那一份完整的一次调用（Chat Completions 那条线的两帧 + [DONE]）：说完即收敛。 */
const BACKUP_SSE = [
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"用回退脸干完了。"},"finish_reason":null}]}',
  '',
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n')

/**
 * **把主模型配死的那台传输**：目标的名是主脸的（`test-main`）→ 收下就抛；是回退脸的 →
 * 吐一份完整的 SSE。产品路径原样走（`wireCallOver` · `callModel` · 真适配器）。
 */
function dyingPrimary(): Transport & { posts: string[] } {
  const posts: string[] = []
  return {
    posts,
    async *post(t: Target): AsyncGenerator<Uint8Array> {
      posts.push(t.model)
      if (t.model === PRIMARY.model) throw new Error('模拟：主模型那台当场死了（503 之后的传输层错）')
      yield* (async function* (): AsyncGenerator<Uint8Array> {
        for (const line of BACKUP_SSE.split('\n')) yield new TextEncoder().encode(`${line}\n`)
      })()
    },
  }
}

/** 一个 agent 在真 git 台子上的那一格（假传输版——脸从测试目录来）。 */
async function cellWith(
  transport: Transport,
  fallbacks: readonly ModelFace[],
  opts: { readonly maxSteps?: number; readonly execute?: ToolExecutor } = {},
): Promise<{ run: () => Promise<DriverResult>; log: LogHandle; events: () => Promise<{ pos: { writer: string; seq: number }; e: LogEventLike }[]>; close: () => Promise<void> }> {
  const AGENT = 'agent-1' as AgentId
  const root = mkdtempSync(join(tmpdir(), 'fugue-fallback-'))
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  assert.equal(spawnSync('git', ['update-ref', 'refs/heads/agent-1', base], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)

  const truth = openTruth(root)
  const log: LogHandle = openLog(root, { write: AGENT as WriterId, sync: 'each' })
  const c = {
    id: 'c1',
    agent: AGENT,
    branch: 'refs/heads/agent-1',
    goal: '把一件事做完',
    kind: 'implement',
    ownedPaths: ['src/a.ts'],
    deliverables: [{ path: 'src/a.ts', form: '模块' }],
    assertions: [],
    seed: [],
    actionOutputs: {},
  } as unknown as Contract
  const state = { ...emptyState(), goal: c.goal }
  const give = { doc: {}, credential: '测试凭据（不出网）' }
  const faces = [PRIMARY, BACKUP].map((d) => faceOf(d, TEST_CAT, give))
  const ask: DriverAsk = {
    agent: AGENT,
    contract: c,
    base,
    openView: async () => loadView(log, AGENT as WriterId, { lower: lowerAt(truth, base) }),
    logOf: () => log,
    truth,
    writer: AGENT as WriterId,
    state,
    handle: {
      agent: AGENT,
      coord: { id: AGENT, branch: 'refs/heads/agent-1', outputPaths: ['src/a.ts'] },
      branch: 'refs/heads/agent-1',
      contract: 'c1' as ContractId,
      protocol: SUBAGENT_PROTOCOL,
      model: PRIMARY.id,
      wireModel: PRIMARY.model,
      target: (faces[0] as ModelFace).target(),
      adapter: { name: PRIMARY.wire },
      state,
    },
    decl: PRIMARY,
    call: wireCallOver(transport) as CallModel,
    execute: opts.execute ?? recordingExecutor(() => ({ ok: true, output: '好。' })),
    ...(fallbacks.length === 0 ? {} : { fallbacks }),
    ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
  }
  const events = async (): Promise<{ pos: { writer: string; seq: number }; e: LogEventLike }[]> => {
    const out: { pos: { writer: string; seq: number }; e: LogEventLike }[] = []
    for await (const row of (log as unknown as Log).readMerged()) out.push(row as never)
    return out
  }
  return {
    run: () => runAgentOnce(ask),
    log,
    events,
    close: async () => {
      await log.close()
      await truth.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 日志事件的宽松形状（这一份只读 `t` 与几栏）。 */
interface LogEventLike {
  t: string
  agent?: string
  from?: string
  to?: string
  why?: string
  model?: string
  wire?: string
  stop?: string | null
  steps?: number
  stopped?: string
  failed?: boolean
}

test('①② 回退接得住 · 那一跳落账 · 按模型分账的首账（负对照：链不在就断在半路）', async () => {
  // 甲：配了回退（round.fallback 那一档在测试里就是 fallbacks 那一栏）——主模型死了也收敛。
  const a = await cellWith(dyingPrimary(), [faceOf(BACKUP, TEST_CAT, { doc: {}, credential: '测试凭据（不出网）' })])
  try {
    const r = await a.run()
    assert.equal(r.stopped, '收敛', `主模型配死、回退接住，这一格该照常收敛：${r.stopped}`)
    assert.equal(r.failed, false)
    const rows = await a.events()
    // ① 那一跳落账：from 主脸 · to 回退脸 · why 是失败那一趟的原话。
    const hops = rows.filter((x) => x.e.t === 'model/fallback')
    assert.equal(hops.length, 1, `回退那一跳恰好一条：${JSON.stringify(hops.map((h) => h.e))}`)
    assert.equal(hops[0]?.e.from, 'test/primary')
    assert.equal(hops[0]?.e.to, 'test/backup')
    assert.match(hops[0]?.e.why ?? '', /主模型那台当场死了/, 'why 是失败那一趟的原话')
    // ② 两条 llm/call 各落各的 model：主脸那条是半截（stop null），回退脸那条走完。
    const calls = rows.filter((x) => x.e.t === 'llm/call')
    assert.deepEqual(
      calls.map((x) => [x.e.model, x.e.stop]),
      [
        ['test/primary', null],
        ['test/backup', 'end-turn'],
      ],
      `两次调用各归各的模型：${JSON.stringify(calls.map((x) => [x.e.model, x.e.stop]))}`,
    )
    // ③ **按模型分账的首账**：同一份日志重算，正好两组、各一笔——分组键本来就在每条 llm/call 上。
    const book = ledgerOf(rows as never, { cat: TEST_CAT })
    assert.equal(book.groups.length, 2, `按模型分组该正好两组：${JSON.stringify(book.groups.map((g) => [g.model, g.calls]))}`)
    assert.deepEqual(
      book.groups.map((g) => [g.model, g.calls]),
      [
        ['test/backup', 1],
        ['test/primary', 1],
      ].sort(),
      '两组各一笔（按模型名排序）',
    )
    console.log(
      `①② 读数：回退 1 跳（test/primary → test/backup）· llm/call 2 条（primary 半截 · backup end-turn）·` +
        ` 台账 ${book.groups.length} 组各 1 笔——按模型分账的首账`,
    )
  } finally {
    await a.close()
  }

  // 乙（负对照）：链不在——同一台死传输，这一格断在半路（红得起来才是断言）。
  const b = await cellWith(dyingPrimary(), [])
  try {
    const r = await b.run()
    assert.match(r.stopped, /^cut-stream/, `链不在就该断在半路：${r.stopped}`)
    assert.equal(r.failed, true, '断在半路要落 failed——重跑那一道闸不把它当交过卷')
    const rows = await b.events()
    assert.equal(rows.filter((x) => x.e.t === 'model/fallback').length, 0, '链不在就一跳都没有')
    assert.equal(rows.filter((x) => x.e.t === 'llm/call').length, 1, '只有主脸那一条半截的 llm/call')
    console.log(`乙 读数：链不在 → stopped=${JSON.stringify(r.stopped.slice(0, 30))}… failed=true · llm/call 1 条 · 0 跳`)
  } finally {
    await b.close()
  }
})

test('③ 裁断那一格自己的链：脸死了换下一张（那一跳也落账），判出来了就停', async () => {
  // 假的裁断调用：第一趟抛（主脸死），第二趟给出 verdictOf 认的那两行。
  const scripts: readonly (readonly ModelEvent[])[] = [
    [{ t: 'delta', text: 'tier: contract\nruling: 用回退脸判的' }],
  ]
  let nth = 0
  const inner = (request: never, signal: never) => {
    void request
    void signal
    return undefined
  }
  void inner
  const call: CallModel = (request, signal) => {
    nth += 1
    if (nth === 1) {
      return {
        events: (async function* (): AsyncGenerator<ModelEvent> {
          throw new Error('模拟：裁断的主脸那台死了')
        })(),
        ledger: () => ({ call: null, failure: 'Error: 模拟：裁断的主脸那台死了', attempts: [0] }),
      }
    }
    const events = scripts[0] as readonly ModelEvent[]
    return {
      events: (async function* (): AsyncGenerator<ModelEvent> {
        for (const e of [...events, { t: 'stop', reason: 'end-turn', raw: 'stop' } as ModelEvent]) yield e
      })(),
      ledger: () => ({ call: { stop: 'end-turn' } as never, failure: null, attempts: [200] }),
    }
  }
  void wireNamed

  const root = mkdtempSync(join(tmpdir(), 'fugue-fallback-ask-'))
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const truth = openTruth(root)
  const log: LogHandle = openLog(root, { write: 'agent-1' as WriterId, sync: 'each' })
  const c = { id: 'c1', agent: 'agent-1', branch: 'refs/heads/agent-1', goal: '做完', kind: 'implement', ownedPaths: [], deliverables: [], assertions: [], seed: [], actionOutputs: {} } as unknown as Contract
  const faces = [PRIMARY, BACKUP].map((d) => faceOf(d, TEST_CAT, { doc: {}, credential: '测试凭据（不出网）' }))
  try {
    const out = await takeAsks({
      log,
      writer: 'agent-1' as WriterId,
      agent: 'agent-1' as AgentId,
      contract: c,
      task: { goal: '做完', question: '', deliverables: [], evidenceRequired: [], assertions: [], ownedPaths: [] },
      asks: [{ question: '这一格问了一个问题' }],
      aZone: new TextEncoder().encode('A 区'),
      call,
      target: (faces[0] as ModelFace).target(),
      adapter: { name: PRIMARY.wire },
      model: PRIMARY.model,
      ruler: faces,
    })
    assert.equal(out.verdict.tier, 'contract', '回退脸判出来了（self 档）')
    assert.equal(out.verdict.forwarded, false, '判成了就不转人')
    assert.match(out.verdict.ruling, /用回退脸判的/)
    const rows: LogEventLike[] = []
    for await (const row of (log as unknown as Log).readMerged()) rows.push(row.e as LogEventLike)
    const hops = rows.filter((x) => x.t === 'model/fallback')
    assert.equal(hops.length, 1, '裁断的那一跳也落账')
    assert.equal(hops[0]?.from, 'test/primary')
    assert.equal(hops[0]?.to, 'test/backup')
    console.log(`③ 读数：裁断链 1 跳（primary → backup）· tier=contract · forwarded=false · ask/raised 与 ask/ruling 各一条`)
  } finally {
    await log.close()
    await truth.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/** Chat 那条线的一帧（`delta` + 可选 `finish_reason`）——工具调用夹具与 ⑨ 那一套同形。 */
const frameOf = (delta: Record<string, unknown>, finish: string | null = null): string => {
  const choice: Record<string, unknown> = { index: 0, delta, ...(finish === null ? {} : { finish_reason: finish }) }
  return `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [choice] })}`
}

/** 一份"两条工具调用"的完整响应：第一条会落副作用，第二条在执行器里抛。 */
const TWO_TOOLS = [
  frameOf({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'side', arguments: '{}' } }] }),
  '',
  frameOf({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'side', arguments: '{}' } }] }),
  '',
  frameOf({}, 'tool_calls'),
  '',
  'data: [DONE]',
  '',
].join('\n')

test('⑤ 额度闸在每次发起之前：回退尝试计入 --max-steps（上界 1 → 只发一次；上界 2 → 主败+回退成功）', async () => {
  const backup = (): ModelFace => faceOf(BACKUP, TEST_CAT, { doc: {}, credential: '测试凭据（不出网）' })
  // 上界 1：主脸那一趟失败后额度已尽——不换脸、不再发，如实断在半路。
  const one = await cellWith(dyingPrimary(), [backup()], { maxSteps: 1 })
  try {
    const r = await one.run()
    assert.match(r.stopped, /^cut-stream/, '最后一趟失败且额度已尽：如实断在半路')
    assert.equal(r.failed, true)
    const rows = await one.events()
    assert.equal(rows.filter((x) => x.e.t === 'llm/call').length, 1, '上界 1 就只发一次——回退不是暗中多出来的免费额度')
    assert.equal(rows.filter((x) => x.e.t === 'model/fallback').length, 0, '额度尽了就不换脸（一跳都不落）')
  } finally {
    await one.close()
  }
  // 上界 2：主脸失败（1 次）+ 回退成功（1 次）——正当用满。
  const two = await cellWith(dyingPrimary(), [backup()], { maxSteps: 2 })
  try {
    const r = await two.run()
    assert.equal(r.stopped, '收敛', `两次额度够主败+回退成功：${r.stopped}`)
    assert.equal(r.failed, false)
    const rows = await two.events()
    assert.equal(rows.filter((x) => x.e.t === 'llm/call').length, 2)
    assert.equal(rows.filter((x) => x.e.t === 'model/fallback').length, 1)
  } finally {
    await two.close()
  }
  console.log('⑤ 读数：maxSteps=1 → 1 次调用 0 跳（failed）；maxSteps=2 → 2 次调用 1 跳（收敛）')
})

test('⑥ 已执行工具的失败不回退：副作用不从模型上下文里消失后被重做', async () => {
  // 两台模型都给同一份"两条工具调用"：若允许回退重跑这一步，回退模型看不到第一条的回执，
  // 会把同两条再发一遍——已落地的副作用被重放。
  const posts: string[] = []
  const both: Transport = {
    async *post(t: Target): AsyncGenerator<Uint8Array> {
      posts.push(t.model)
      for (const line of TWO_TOOLS.split('\n')) yield new TextEncoder().encode(`${line}\n`)
    },
  }
  let ran = 0
  const execute: ToolExecutor = {
    async execute(call: ToolCallRequest) {
      ran += 1
      if (ran % 2 === 0) throw new Error(`第二条工具当场抛了（${call.name}）`)
      return { ok: true, output: '第一条落了' }
    },
  }
  const cell = await cellWith(both, [faceOf(BACKUP, TEST_CAT, { doc: {}, credential: '测试凭据（不出网）' })], { execute })
  try {
    const r = await cell.run()
    assert.match(r.stopped, /^tool-threw/, '执行阶段失败：如实停下')
    assert.equal(r.failed, true)
    assert.equal(ran, 2, `第一条已落、第二条抛——回退不许把这一步重走一遍（实际执行 ${ran} 次）`)
    const rows = await cell.events()
    assert.equal(rows.filter((x) => x.e.t === 'llm/call').length, 1, '只有主脸那一趟调用——不换脸重跑')
    assert.equal(rows.filter((x) => x.e.t === 'model/fallback').length, 0)
    assert.equal(posts.length, 1, '回退模型一次都没被请求')
  } finally {
    await cell.close()
  }
  console.log('⑥ 读数：两条工具 · 第一条落副作用 · 第二条抛 → 不回退 · 执行恰 2 次 · 调用恰 1 次')
})

test('⑦ 收工那半句读同一个额度：attempts（含回退跳）优先，逻辑步退位', async () => {
  const inner: ToolExecutor = { async execute() { return { ok: true, output: 'x' } } }
  const wrapped = withStepsLeft(inner, 3)
  const call = { id: 'a', name: 'side', arguments: '{}' } as ToolCallRequest
  const withAttempts = await wrapped.execute(call, { state: { ...emptyState(), step: 1, attempts: 2 } } as never)
  assert.match(withAttempts.output, /this is step 3: 0 left/, 'attempts=2 → 这是第 3 次尝试、这次走完剩 0——与闸同一个数')
  const withoutAttempts = await wrapped.execute(call, { state: { ...emptyState(), step: 1 } } as never)
  assert.match(withoutAttempts.output, /this is step 2: 1 left/, 'attempts 缺席退回逻辑步（没有失败重试的那一档两者相等）')
})

test('⑧ 取消是独立终态：裁断链不换脸、一张都不发（预先取消 → 转人，不归"模型供不上"）', async () => {
  const ctl = new AbortController()
  ctl.abort(new Error('人喊停了'))
  let calls = 0
  const call: CallModel = () => {
    calls += 1
    return {
      events: (async function* (): AsyncGenerator<ModelEvent> {
        yield { t: 'delta', text: 'tier: contract\nruling: 不该走到这里' }
        yield { t: 'stop', reason: 'end-turn', raw: 'stop' } as ModelEvent
      })(),
      ledger: () => ({ call: null, failure: null, attempts: [200] }),
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'fugue-fallback-cancel-'))
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const truth = openTruth(root)
  const log: LogHandle = openLog(root, { write: 'agent-1' as WriterId, sync: 'each' })
  const c = { id: 'c1', agent: 'agent-1', branch: 'refs/heads/agent-1', goal: '做完', kind: 'implement', ownedPaths: [], deliverables: [], assertions: [], seed: [], actionOutputs: {} } as unknown as Contract
  const faces = [PRIMARY, BACKUP].map((d) => faceOf(d, TEST_CAT, { doc: {}, credential: '测试凭据（不出网）' }))
  try {
    const out = await takeAsks({
      log,
      writer: 'agent-1' as WriterId,
      agent: 'agent-1' as AgentId,
      contract: c,
      task: { goal: '做完', question: '', deliverables: [], evidenceRequired: [], assertions: [], ownedPaths: [] },
      asks: [{ question: '取消之后还问的问题' }],
      aZone: new TextEncoder().encode('A 区'),
      call,
      target: (faces[0] as ModelFace).target(),
      adapter: { name: PRIMARY.wire },
      model: PRIMARY.model,
      signal: ctl.signal,
      ruler: faces,
    })
    assert.equal(calls, 0, `预先取消：一张脸都不该被请（实际 ${calls} 次）`)
    assert.equal(out.verdict.forwarded, true, '取消转人，不当裁断成了')
    assert.match(out.verdict.why ?? '', /已取消/, 'why 说的是取消，不是"模型供不上"')
    const rows: LogEventLike[] = []
    for await (const row of (log as unknown as Log).readMerged()) rows.push(row.e as LogEventLike)
    assert.equal(rows.filter((x) => x.t === 'model/fallback').length, 0, '取消不换脸：一跳都不落')
  } finally {
    await log.close()
    await truth.close()
    rmSync(root, { recursive: true, force: true })
  }
  console.log('⑧ 读数：预先取消 → 裁断 0 次调用 · 0 跳 · forwarded=true（why=已取消）')
})
