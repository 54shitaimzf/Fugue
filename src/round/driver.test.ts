// B7.5 的断言：真驱动接上（PLAN § 5.8 的 `B7.5` 行 · 架构 § 14.1 那七步里的"跑"那一段 ·
// § 14.2 的六步与三档 · § 8.13.a 的接续 · § 9.6 的"两个面同一个操作"）。
// 跑法：cd ~/fugue && node --test src/round/driver.test.ts
//
//   ① 一个真轮次里**每一步落一条 `llm/call`**，而三个一线指标从那一趟的日志里算得出来
//      （不再是"算不出来"）· 负对照：把驱动换回打桩 → 一条 `llm/call` 都没有
//   ② 假模型驱动整轮 → 走到一次真提交，而**真工作树一个字节不动**
//   ③ 交接那一趟接得上：触发点到了落 `agent/handoff`，后继接着干完
//   ④ 驱动不在时**明确报出来**（不是静默地交一个空提交）
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import { createRoots } from '../roots/roots.ts'
import { applyEdit } from '../view/edit.ts'
import type { Log } from '../log/events.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import { modelDeclOf } from '../model/contract.ts'
import type { ModelEvent } from '../model/contract.ts'
import { scriptedModel } from '../runtime/step.ts'
import type { CallModel } from '../runtime/step.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'
import { metricsOf } from '../probe/metrics.ts'
import type { MergedRow } from '../probe/metrics.ts'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, WriterId } from '../terms.ts'
import type { Contract } from '../contract/types.ts'
import { runRound } from './execute.ts'
import type { RoundRun, RoundRunDeps, Stub } from './execute.ts'
import { commitView, noDriver, realDriver, stubDriver } from './driver.ts'

const AGENT = 'agent-1' as AgentId
const DECL = modelDeclOf('deepseek-chat/anthropic')
const CATALOG = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

/** 一条工具调用（三段：起点 · 分片 · 收尾）。**字段名照 `B1` 的 `ModelEvent`（`args` 不是 `text`）。** */
function callOne(index: number, id: string, name: string, args: unknown): ModelEvent[] {
  const text = JSON.stringify(args)
  return [
    { t: 'tool-start', index, id, name },
    { t: 'tool-delta', index, args: text },
    { t: 'tool-call', index, id, name, arguments: text },
  ]
}

const USAGE = { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64, rawStop: null, model: null }

/** 一串脚本：写一份交付物，然后说完。 */
const SCRIPTS: readonly (readonly ModelEvent[])[] = [
  [
    ...callOne(0, 'c1', 'write', { path: 'a.ts', content: '（模型写的）a.ts\n' }),
    { t: 'usage', usage: USAGE },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ],
  [
    { t: 'delta', text: '写完了。' },
    { t: 'usage', usage: USAGE },
    // **值域是 `end-turn`（`contract.ts` 的 `STOP_REASONS`），`end_turn` 是提供方那半句、归 `raw`。**
    // 写错那一栏的后果不是报错，是循环把它读成"这一条流没走完"（`cut-stream`）而停住，
    // 于是第二趟调用一条用量都没有——**读数会以一个说得通的样子错掉**。
    { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
  ],
]

/** 这一轮收口的那句判据。**`Committed` 不是终点**：定格之后真实工作树被推进，状态机再走一步
 * 到 `Rebuilding`（`round/machine.ts` 那条 `Committed ──advanced──> Rebuilding`），
 * 而 `execute.ts` 把最后那一步的状态原样交回来。所以"通过了"要看 `report.ok` 与 `advanced`。 */
function assertLanded(run: RoundRun, say: string): void {
  assert.equal(run.state, 'Rebuilding', `${say}：状态该走到 Rebuilding，实际 ${run.state}`)
  assert.equal(run.report.ok, true, `${say}：验收该过`)
  assert.ok(run.advanced !== null, `${say}：真实工作树该被推进`)
}

/**
 * ① 那一趟用四步：写 → 起一次进程 → 说完。
 *
 * 为什么多两步：`detour-rate` 的分母是 `run/start`（起过一次进程），而 `B5` 公布的九条里
 * **只有 `bash`（执行类）那一格会起进程**——`grep` 那一格走的是视图侧，不落 `run/start`。
 * 命令里写着 `grep`：**模型绕开 grep 工具、用 shell 干同一件事**，分子分母各 1。
 */
const DETOUR_SCRIPTS: readonly (readonly ModelEvent[])[] = [
  SCRIPTS[0] as readonly ModelEvent[],
  [
    ...callOne(0, 'c2', 'bash', { command: 'grep -n TODO a.ts' }),
    { t: 'usage', usage: USAGE },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ],
  SCRIPTS[1] as readonly ModelEvent[],
]

interface Bench {
  readonly root: string
  readonly log: LogHandle
  readonly truth: ReturnType<typeof openTruth>
  readonly base: CommitId
  /** 这一份台子开过的所有日志口（跑完一起关）。 */
  readonly keep: (l: LogHandle) => void
  readonly close: () => Promise<void>
}

/**
 * 一份台子：一个真对象库 · **一个底**（轮次要有 HEAD——架构 § 8.14 的 C7）· 持轮者那份日志。
 *
 * 底是走**产品那条路**落的：`view/write` → `checkpoint()`（`fugue commit` 与模型侧那个
 * `checkpoint` 是同一个操作，§ 9.6）。
 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-b75-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const truth = openTruth(root)
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  const view = await loadView(log, 'round' as WriterId, { lower: lowerAt(truth, null) })
  await applyEdit(
    { view, truth, log, writer: 'round' as WriterId },
    { kind: 'add', path: 'README.md' as RelPath, bytes: new TextEncoder().encode('底\n'), mode: 0o100644 },
  )
  const base = await commitView({
    view,
    log,
    truth,
    writer: 'round' as WriterId,
    expectedOld: null,
    msg: '底',
  })
  const extra: LogHandle[] = []
  return {
    root,
    log,
    truth,
    base: base.commit,
    keep: (l) => extra.push(l),
    close: async () => {
      await log.close()
      for (const l of extra) await l.close().catch(() => undefined)
      await truth.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * 轮次那一份 deps：**除了驱动与它的那几样支持，别的一个字节都不与 S7 那一份不同**。
 *
 * `support` 给了就是真驱动那一档（`B7.5`）：`call` · `execute` · `decl` · `handle` · `state`
 * 由它带进来。不给就是打桩那一档。
 */
function depsOf(
  b: Bench,
  driver: RoundRunDeps['stub'],
  support?: RoundRunDeps['driver'],
  round = 'r1',
): RoundRunDeps {
  const split = [
    {
      goal: '写一份 a.ts',
      ownedPaths: ['a.ts' as RelPath],
      deliverables: [{ path: 'a.ts' as RelPath, form: '一份文件' }],
      assertions: [{ name: '总是过', action: 'ok' }],
    },
  ]
  // **一个 writer 一个口**（`hold.ts` 那道栅栏）：同一份日志被两条路要（轮次那一步 · 驱动自己
  // 那一步），各开一次就会撞上"已经有写者"。所以这里记住开过的口，跑完一起关。
  const opened = new Map<AgentId, LogHandle>()
  const logOf = (a: AgentId): LogHandle => {
    const hit = opened.get(a)
    if (hit !== undefined) return hit
    const made = openLog(b.root, { write: a as WriterId, sync: 'each' })
    opened.set(a, made)
    b.keep(made)
    return made
  }
  return {
    roots: createRoots(b.root as never),
    truth: b.truth,
    log: b.log,
    logOf,
    logForAgent: logOf,
    // 一个 agent 一个口、由调用方持有：台子把开过的口记着，跑完一起关（`Bench.close`）。
    closeAgentLogs: async () => undefined,
    round: round as never,
    // **`question` 不给**（给了就是派一份调查型契约，而那一份要一个非空的问题）。
    intent: { goal: '把一件事做完' },
    split,
    agents: [AGENT],
    branchOf: (a) => `refs/heads/${a}` as BranchId,
    seedOf: () => [],
    stub: driver,
    ...(support === undefined ? {} : { driver: support }),
    specsOf: () => [
      {
        assertion: { action: 'ok', name: '总是过', expect: 0 } as never,
        argv: ['/bin/sh', '-c', 'true'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      },
    ],
    retriesLeft: 0,
  }
}

/** 真驱动那一档要的那几样（`DriverSupport`）：**一条契约一个 agent** · 同一份声明 · 同一串脚本。 */
function supportOf(b: Bench, call: CallModel): RoundRunDeps['driver'] {
  const state = { ...emptyState(), ...fixtureState(0), step: 0, cwd: '' }
  return {
    state: () => state,
    handle: (agent: AgentId) => ({
      agent,
      coord: { id: agent, branch: `refs/heads/${agent}`, outputPaths: [] },
      branch: `refs/heads/${agent}` as BranchId,
      contract: 'r1.implement.1' as ContractId,
      protocol: SUBAGENT_PROTOCOL,
      model: DECL.id,
      wireModel: 'deepseek-chat',
      target: { providerId: 'fixture', host: '', wire: { name: 'anthropic-messages' }, path: '', model: 'deepseek-chat', from: 'fixture', headers: {} },
      adapter: { name: 'anthropic-messages' },
      state,
    }),
    decl: DECL,
    call,
    tools: CATALOG,
  }
}

/** 驱动那一份 ask 的公共那一半：这一格的视图与日志各自开。 */
function askOf(b: Bench, call: CallModel | undefined, over: Record<string, unknown> = {}) {
  const state = { ...emptyState(), ...fixtureState(0), step: 0, cwd: '' }
  return {
    agent: AGENT,
    contract: { id: 'r1.implement.1' as ContractId, kind: 'implement', goal: '写一份 a.ts', ownedPaths: ['a.ts'], deliverables: [{ path: 'a.ts', form: '一份文件' }], assertions: [] } as unknown as Contract,
    base: b.base,
    openView: async () => loadView(openLog(b.root), AGENT as WriterId, { lower: lowerAt(b.truth, null) }),
    logOf: () => openLog(b.root, { write: AGENT as WriterId, sync: 'each' }),
    truth: b.truth,
    writer: AGENT as WriterId,
    tools: CATALOG,
    roots: createRoots(b.root as never),
    state,
    handle: {
      agent: AGENT,
      coord: { id: AGENT, branch: `refs/heads/${AGENT}`, outputPaths: [] },
      branch: `refs/heads/${AGENT}` as BranchId,
      contract: 'r1.implement.1' as ContractId,
      protocol: SUBAGENT_PROTOCOL,
      model: DECL.id,
      wireModel: 'deepseek-chat',
      target: { providerId: 'fixture', host: '', wire: { name: 'anthropic-messages' }, path: '', model: 'deepseek-chat', from: 'fixture', headers: {} },
      adapter: { name: 'anthropic-messages' },
      state,
    },
    decl: DECL,
    ...(call === undefined ? {} : { call }),
  } as never
}

/** 交一个提交（打桩那一档：直接算一棵树）。 */
function stubOf(b: Bench): Stub {
  return {
    run: async (agent, c, base) => {
      const id = await b.truth.putBlob(new TextEncoder().encode(`（打桩）${c.id}\n`))
      const tree = await b.truth.putTree([{ name: `stub-${c.id}.txt`, mode: 0o100644, id }])
      return b.truth.commit(tree, [base], `（打桩）${agent}`)
    },
  }
}

async function eventsOf(root: string): Promise<LogEvent[]> {
  const log = openLog(root)
  const out: LogEvent[] = []
  for (const w of ['round', 'agent-1'] as WriterId[]) {
    for await (const e of log.readByWriter(w)) out.push(e)
  }
  return out
}

const worktreeOf = (root: string): string[] =>
  readdirSync(root)
    .filter((n) => n !== '.git' && n !== '.fugue')
    .sort()

// ── ① 每一步一条 llm/call ────────────────────────────────────────────────────

test('① 真驱动那一趟：每一步一条 llm/call，八元指标从那一趟的日志里算得出来', async () => {
  const b = await bench()
  try {
    const call = scriptedModel(DETOUR_SCRIPTS)
    // **产出由模型自己写**（脚本第一条就是 `write a.ts` → `B5` 的工具面 → `view/write`）。
    // `deliver` 那道口是给"模型自己不写"那一档的，这一趟不接。
    const driver = realDriver({})
    const seen: string[] = []
    const run: RoundRun = await runRound(
      depsOf(
        b,
        async (ask) => {
          seen.push(ask.agent)
          return driver(ask)
        },
        supportOf(b, call),
      ),
    )
    assertLanded(run, '① 真驱动那一趟')

    const rows = await eventsOf(b.root)
    const calls = rows.filter((e) => e.t === 'llm/call')
    assert.equal(calls.length, 3, `每一步一条 llm/call，实际 ${calls.length} 条`)
    assert.equal(seen.length, 1, '驱动被叫了一次（一条契约一个 agent）')

    // **三个一线指标现在算得出来**（这就是 `B7.5` 的全部意义）。
    const merged: MergedRow[] = rows.map((e, i) => ({ pos: { writer: 'round', seq: i + 1 }, e }))
    const metrics = metricsOf(merged)
    const rate = (id: string): number | null => metrics.find((m) => m.metric === id)?.value ?? null
    assert.ok(rate('prefix-hit-rate') !== null, '`prefix-hit-rate` 不再"算不出来"')
    assert.equal(rate('prefix-hit-rate'), 1, '两次调用都报回了缓存读（2/2）')
    assert.equal(rate('zero-tool-call-rate'), 1 / 3, '三次调用里最后一次没伸手（1/3）')
    assert.equal(rate('detour-rate'), 1, '这一趟起过一次进程，而那一行命令用的是工具的名字（1/1）')
    const detour = metrics.find((m) => m.metric === 'detour-rate')
    assert.equal(detour?.numerator, 1, '分子分母都要印得出来')
    assert.equal(detour?.denominator, 1)
    console.log(
      `① 读数：llm/call ${calls.length} 条 · zero-tool-call-rate=${rate('zero-tool-call-rate')} · ` +
        `detour-rate=${rate('detour-rate')} · prefix-hit-rate=${rate('prefix-hit-rate')} · ` +
        `prefix-versions=${rate('prefix-versions')}`,
    )
  } finally {
    await b.close()
  }
})

test('① 负对照：把驱动换回打桩 → 一条 llm/call 都没有，指标全部"算不出来"', async () => {
  const b = await bench()
  try {
    const run = await runRound(depsOf(b, stubDriver(stubOf(b))))
    assertLanded(run, '① 负对照（打桩）')
    const rows = await eventsOf(b.root)
    const calls = rows.filter((e) => e.t === 'llm/call')
    assert.equal(calls.length, 0, `打桩那一趟不该有 llm/call，实际 ${calls.length} 条`)
    const metrics = metricsOf(rows.map((e, i) => ({ pos: { writer: 'round', seq: i + 1 }, e })))
    assert.equal(metrics.find((m) => m.metric === 'zero-tool-call-rate')?.value, null)
    console.log('① 负对照读数：打桩那一趟 llm/call 0 条 · zero-tool-call-rate=null')
  } finally {
    await b.close()
  }
})

// ── ② 走到一次真提交，工作树不动 ──────────────────────────────────────────────

test('② 假模型驱动整轮 → 一次真提交，而真工作树一个字节不动', async () => {
  const b = await bench()
  try {
    const before = worktreeOf(b.root)
    // 产出由模型自己写（脚本第一条 `write a.ts`）；`deliver` 不接，于是"盘上有没有被碰过"
    // 这件事才只取决于工具面那一侧。
    const run = await runRound(depsOf(b, realDriver({}), supportOf(b, scriptedModel(SCRIPTS))))
    assertLanded(run, '② 假模型驱动整轮')
    const commit = run.work['r1.implement.1' as ContractId]
    assert.ok(typeof commit === 'string' && commit.length === 40, `提交点是 ${String(commit)}`)

    const show = spawnSync('git', ['--git-dir=' + join(b.root, '.git'), 'ls-tree', '-r', '--name-only', String(commit)], { env: GIT_ENV, encoding: 'utf8' })
    assert.equal(show.status, 0, show.stderr)
    assert.ok(show.stdout.includes('a.ts'), `提交里该有 a.ts：${show.stdout}`)

    const rows = await eventsOf(b.root)
    // **两条各是各的**：台子那个底（`writer: round`）一条，驱动这一趟（视图那一刻那一份）一条。
    const ckpts = rows.filter((e) => e.t === 'ckpt/commit')
    assert.equal(ckpts.length, 2, `底一条 + 驱动一条，实际 ${ckpts.length} 条`)
    assert.equal(ckpts.filter((e) => e.t === 'ckpt/commit' && e.agent === AGENT).length, 1, '驱动那一趟恰好一条')
    assert.ok(rows.filter((e) => e.t === 'view/write').length >= 1, '产出走的是视图那条路（`view/write`）')
    // **判据分两半**：驱动那一趟（跑到提交为止）是真工作树一个字节不动；而整轮末尾那一步
    // `advance` 的活就是"把盘上推到目标树"（架构 § 8.14 的 `Committed ──advanced──> Rebuilding`），
    // 它写盘是对的。两件事混成一条断言就会在正确的行为上报红。
    assert.deepEqual(before, [], '台子起手时真工作树是空的（底是直接落进对象库的）')
    assert.deepEqual(
      worktreeOf(b.root),
      ['README.md', 'a.ts'],
      `推进之后盘上该恰好是目标树那两条：${worktreeOf(b.root).join(' ')}`,
    )
    assert.equal(
      readFileSync(join(b.root, 'a.ts'), 'utf8'),
      '（模型写的）a.ts\n',
      '推进写到盘上的就是模型写进视图的那一份',
    )
    console.log(`② 读数：提交 ${String(commit).slice(0, 12)} · 树里 ${show.stdout.trim().split('\n').join(' ')} · 工作树 ${worktreeOf(b.root).length} 项`)
  } finally {
    await b.close()
  }
})

// ── ③ 交接接得上 ────────────────────────────────────────────────────────────

test('③ 触发点到了落 agent/handoff，后继接着干完（同一条分支 · 轮级状态不变）', async () => {
  const b = await bench()
  try {
    // **把触发点压到很低**：一份"上限 200 · 触发点 150 · 余量 10"的声明——三区一算就过线。
    // **上限要压到实际三区之下、但压在触发点之上一点点**（实到 629 字节：`B6` 那一条报的就是
    // "用了 629（触发点 150），而交接还差 439 写不下"）。压到 200 的话 `planBudget` 直接给
    // `stop`——那一趟连一步都不走，交接自然一次都没有。
    const tiny = { ...DECL, contextLimit: 700, budget: { trigger: 150, handoffMargin: 10 } }
    // 预算那一栏由 `decl` 决定，而 `realDriver` 的 `onResult` 能拿到那一趟的读数。
    let result: { handoffs: readonly string[]; stopped: string } | null = null
    const driver = realDriver({
      deliver: async () => [],
      onResult: (_a, r) => {
        result = r
      },
    })
    const run = await runRound(
      depsOf(
        b,
        async (ask) => driver({ ...ask, decl: tiny, maxSteps: 8 } as never),
        { ...supportOf(b, scriptedModel(SCRIPTS)), decl: tiny } as RoundRunDeps['driver'],
      ),
    )
    assertLanded(run, '③ 交接那一趟')
    assert.ok(result !== null, '驱动交了读数')
    const r = result as unknown as { handoffs: readonly string[]; stopped: string }
    assert.equal(r.handoffs.length, 1, `该交接一次，实际 ${r.handoffs.length} 次（${r.stopped}）`)
    assert.match(r.handoffs[0]!, /【交接】/)

    const rows = await eventsOf(b.root)
    const handoffs = rows.filter((e) => e.t === 'agent/handoff')
    assert.equal(handoffs.length, 1, '日志里一条 agent/handoff')
    const h = handoffs[0]!
    assert.equal(h.agent, AGENT)
    assert.match(String(h.successor), /^agent-1-\d+$/, `后继的名字：${h.successor}`)
    // **轮级状态那一栏没被动过**：这条事件里没有轮次号，也没有 `round/state` 跟着它。
    console.log(`③ 读数：交接 ${r.handoffs.length} 次 · 后继 ${String(h.successor)} · 停下来的话「${r.stopped}」`)
  } finally {
    await b.close()
  }
})

// ── ④ 驱动不在时明确报出来 ───────────────────────────────────────────────────

test('④ 驱动不在：当场报出来，不交空提交', async () => {
  const b = await bench()
  try {
    const err = noDriver(AGENT, 'r1.implement.1' as ContractId)
    assert.equal(err.why, 'no-driver')
    assert.match(err.message, /没有接上驱动/)
    assert.match(err.message, /不交空提交/)

    // 真的走一趟：`call` 不给 → 那一格当场抛，而 `runRound` 把它带出来。
    const run = realDriver({})
    await assert.rejects(
      () =>
        runRound(
          depsOf(
            b,
            async (ask) => run({ ...ask, call: undefined } as never),
            // **不给 `call`**：这就是"驱动不在"那一档。
            { ...supportOf(b, scriptedModel(SCRIPTS)), call: undefined } as RoundRunDeps['driver'],
          ),
        ),
      (e: Error) => /没有接上驱动/.test(e.message) && (e as { why?: string }).why === 'no-driver',
      '缺驱动时该报出来，且短分类是 no-driver',
    )
    const rows = await eventsOf(b.root)
    // **台子那个底本身就是一条 `ckpt/commit`**（`writer: round`）——要量的是"这一格一条都没交"：
    // 没有 agent 名下的提交，也没有空提交挂在轮次那条分支上。
    const ckpts = rows.filter((e) => e.t === 'ckpt/commit')
    assert.equal(ckpts.length, 1, `只有台子那个底那一条，实际 ${ckpts.length} 条`)
    assert.equal(ckpts[0]?.agent, 'round', '那一条是底（持轮者落的），不是这一格交的')
    assert.equal(ckpts.filter((e) => e.agent === AGENT).length, 0, `**${AGENT} 一条都没交**（不交空提交）`)
    console.log('④ 读数：no-driver 当场抛出 · 台子那个底 1 条 ckpt/commit · 这一格 0 条')
  } finally {
    await b.close()
  }
})
