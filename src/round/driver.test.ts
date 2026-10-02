// tier: real —— cc（动作夹具含真编译；PATH 探针实测：缺 cc 三条红，仅缺 bwrap 反而全绿——围栏降档的地板是好的）
// B7.5 的断言：真驱动接上（PLAN § 5.8 的 `B7.5` 行 · 架构 § 14.1 那七步里的"跑"那一段 ·
// § 14.2 的六步与三档 · § 8.13.a 的接续 · § 9.6 的"两个面同一个操作"）。
// 跑法：cd ~/fugue && node --test src/round/driver.test.ts
//
//   ① 一个真轮次里**每一步落一条 `llm/call`**，而三个一线指标从那一趟的日志里算得出来
//      （不再是"算不出来"）· 负对照：把驱动换回打桩 → 一条 `llm/call` 都没有
//   ② 假模型驱动整轮 → 走到一次真提交，而**真工作树一个字节不动**
//   ③ 交接那一趟接得上：触发点到了落 `agent/handoff`，后继接着干完
//   ④ 驱动不在时**明确报出来**（不是静默地交一个空提交）
//   ①e 契约那一格的收工口径第三面：预算快用完时，回执末尾多一句"还剩几步"（第十六趟那一格照出来的）
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { matParts } from '../roots/paths.ts'
import type { Enforcement, PolicyLayer, PolicyMode } from '../terms.ts'
import { clearMaterialization, removeTree } from '../materialize/mount.ts'
import { applyEdit } from '../view/edit.ts'
import type { Log, LogReader } from '../log/events.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import { BUILTIN_CATALOG, modelDeclOf } from '../model/catalog.ts'
import type { ModelEvent } from '../model/contract.ts'
import { scriptedModel } from '../runtime/step.ts'
import type { CallModel, RuntimeRequest } from '../runtime/step.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'
import { metricsOf } from '../probe/metrics.ts'
import type { MergedRow } from '../probe/metrics.ts'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, WriterId } from '../terms.ts'
import type { Contract } from '../contract/types.ts'
import { runRound } from './execute.ts'
import { entriesOf } from '../merge/accept.ts'
import type { RoundRun, RoundRunDeps, Stub } from './execute.ts'
import { commitView, noDriver, openRefHead, realDriver, stubDriver } from './driver.ts'
import { refHeadOf } from './head.ts'
import { RefConflictError } from '../truth/truth.ts'

const AGENT = 'agent-1' as AgentId
const DECL = modelDeclOf('deepseek-flash/anthropic', BUILTIN_CATALOG)
const CATALOG = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])

// P1a 那一条读数要「宿主真的有这个键」（escape.test 同款）：round 这一路实现之前整份继承宿主
// 环境，bash 里读得到；core 基线起读不到。node --test 每文件一个进程，进程退出即散，不恢复。
if (process.env.DEEPSEEK_API_KEY === undefined) process.env.DEEPSEEK_API_KEY = 'driver-P1a 的探测假值'

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

const USAGE = { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64, reasoningTokens: null, model: null }

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

/**
 * 那份 tiny 声明（上限 800 · 触发点 150）配的用量：**与它的前缀同一个量级**。
 *
 * 上面那份 24,088 是给真声明（上限 12.8 万）用的；套在 tiny 上，真读数那一笔修正会把它自己
 * 撑爆（实测 ×82.49：交接一次之后一步都不走）。**真读数与估账同量级**是这里的取值纪律——
 * 脚本里的用量是造的，它得造得像。
 */
const TINY_USAGE = { inputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 64, reasoningTokens: null, model: null }
const TINY_SCRIPTS: readonly (readonly ModelEvent[])[] = SCRIPTS.map((step) =>
  step.map((e) => (e.t === 'usage' ? { t: 'usage', usage: TINY_USAGE } : e)),
)

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
  /** 底那一棵树的对象号：打桩那一份要拿它当"盘上本来有的那些"（见 `stubOf`）。 */
  readonly tree: string
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
async function bench(readme = '底\n', ref = 'refs/heads/agent-1'): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-b75-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const truth = openTruth(root)
  // **一个日志一个写者**：这一份台子用 `round` 那个口（它也是主线那一支的写者）。
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  // **底那个提交用 git 自己落**：物化的底**就是工作树**（架构 § 8.4），所以"底"与"盘上"必须
  // 是同一份内容——不齐时的症状是静默的（物化树里空着，命令面照旧报成功）。走 git 落，两边
  // 天然逐字节同一份；`ref` 那一栏说的是这一份底**挂在哪一支上**（缺省挂在 `agent-1` 上，这样
  // 这一格的提交接在底后面；挂在主线上的话这一格的提交会变成一条无父的根提交）。
  writeFileSync(join(root, 'README.md'), readme)
  const staged = spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(staged.status, 0, staged.stderr)
  const made = spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  assert.equal(base.length, 40, `读不出底那个提交：${base}`)
  const tree = (spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim()
  await truth.advance(ref as never, base, null)
  // 主线那一条 ref 也指同一个底：轮次开始读的是它（架构 § 8.14 的 C7）。
  await truth.advance('refs/heads/main' as never, base, null)
  // **视图那一侧**：这一份台子不往视图里写底（底由 git 落），而这一格的真驱动的视图是
  // `round/execute.ts` 按 agent 自己开的（`openAgentView`），与这一份无关。
  const extra: LogHandle[] = []
  return {
    root,
    log,
    truth,
    base,
    tree,
    keep: (l) => extra.push(l),
    close: async () => {
      // **用产品那一份收尾**（`clearMaterialization` · `removeTree`），不自己 `rmSync`：
      // W8 起这一格的 `bash` 真的把物化树挂起来了（overlayfs），而卸载之后内核在
      // `tmp/work/` 里留了一个 `root:root 000` 的 `work/work`——`fs.rmSync` 会先 `readdir`
      // 每个目录，于是在它上面吃 `EACCES`；`removeTree` 先 `rmdir` 再往下走，正好绕过这一处。
      // 这条纪律在 `mount.ts` 的注释里写着（"这个顺序不能由调用点各自记着"），所以这里调它。
      await log.close()
      for (const l of extra) await l.close().catch(() => undefined)
      await truth.close()
      clearMaterialization(
        matParts(root as never, AGENT).merged,
        (["agent-1", "agent-2", "agent-3"] as AgentId[]).flatMap((a) => {
          const p = matParts(root as never, a)
          return [p.upper, p.merged, p.temp]
        }),
      )
      removeTree(root as never)
    },
  }
}

/**
 * 轮次那一份 deps：**除了驱动与它的那几样支持，别的一个字节都不与 S7 那一份不同**。
 *
 * `support` 给了就是真驱动那一档（`B7.5`）：`call` · `execute` · `decl` · `handle` · `state`
 * 由它带进来。不给就是打桩那一档。
 */
/** `depsOf` 那一份拆分：一条契约，或者（给 `identityFor` 时）N 条只有目标与产物路径不同的。 */
type SplitDraft = RoundRunDeps['split'][number]

function depsOf(
  b: Bench,
  driver: RoundRunDeps['stub'],
  support?: RoundRunDeps['driver'],
  round = 'r1',
  over: { readonly split?: readonly SplitDraft[]; readonly identityFor?: (n: number) => { agent: AgentId; branch: BranchId } } = {},
): RoundRunDeps {
  const split: readonly SplitDraft[] = over.split ?? [
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
    // **身份一个来源**（架构 § 14.1 第 1 步）：名字与它那条分支一处给。
    identityFor: over.identityFor ?? (() => ({ agent: AGENT, branch: `refs/heads/${AGENT}` as BranchId })),
    seeds: [] as readonly (readonly RelPath[])[],
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

/**
 * 真驱动那一档要的那几样（`DriverSupport`）：**一条契约一个 agent** · 同一份声明 · 同一串脚本。
 *
 * **状态与句柄都按 agent 走**（`B7.5` 之后签名就是 `(agent, contract)`）：两个 agent 的 B 区
 * 里有它自己的目标与产物，所以两份 B 区**本来就该不同**——一处写死会把 ①b 那条断言变成
 * "两个 agent 恰好装出同一份 B 区"，那是夹具的假象，不是产品。
 */
function supportOf(b: Bench, call: CallModel, agents: readonly AgentId[] = [AGENT]): RoundRunDeps['driver'] {
  const base = { ...emptyState(), ...fixtureState(0), step: 0, cwd: '' }
  const stateOf = (agent: AgentId): AssembleState => ({
    ...base,
    goal: `把「${agent}」那一格做完。`,
    task: { ...(base.task as NonNullable<AssembleState['task']>), goal: `把「${agent}」那一格做完。` },
  })
  return {
    state: (agent: AgentId) => stateOf(agent),
    handle: (agent: AgentId) => ({
      agent,
      coord: { id: agent, branch: `refs/heads/${agent}`, outputPaths: [] },
      branch: `refs/heads/${agent}` as BranchId,
      contract: 'r1.implement.1' as ContractId,
      protocol: SUBAGENT_PROTOCOL,
      model: DECL.id,
      wireModel: 'deepseek-flash',
      target: { providerId: 'fixture', host: '', wire: { name: 'anthropic-messages' }, path: '', model: 'deepseek-flash', from: 'fixture', headers: {} },
      adapter: { name: 'anthropic-messages' },
      state: stateOf(agent),
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
      wireModel: 'deepseek-flash',
      target: { providerId: 'fixture', host: '', wire: { name: 'anthropic-messages' }, path: '', model: 'deepseek-flash', from: 'fixture', headers: {} },
      adapter: { name: 'anthropic-messages' },
      state,
    },
    decl: DECL,
    ...(call === undefined ? {} : { call }),
  } as never
}

/** 交一个提交（打桩那一档：直接算一棵树）。 */
/**
 * 打桩那一份：**产出落在"底那棵树之上"**。
 *
 * 它多带一栏 `b.tree`（底那棵树）是有理由的：一个提交的树是一棵**完整的**树，不是"这一格新
 * 写的那几条"。原先只放自己那一条，盘上恰好也空着才成立；W8 起台子的底真的落在盘上（§ 8.4：
 * 物化的底就是工作树），于是"盘上有 README、目标树里没有"会当场被漂移检拦下——**拦得对**。
 */
function stubOf(b: Bench): Stub {
  return {
    run: async (agent, c, base) => {
      const id = await b.truth.putBlob(new TextEncoder().encode(`（打桩）${c.id}\n`))
      // **树的形状照 git 自己那一份来**（`entriesOf` 逐层列，与 `putTree` 收的同一组形状），
      // 再加自己那一条——一个提交的树是一棵完整的树，不是"这一格新写的那几条"。
      const all = await entriesOf(b.truth, base)
      const tree = await b.truth.putTree([...all, { name: `stub-${c.id}.txt`, mode: 0o100644, id }])
      return b.truth.commit(tree, [base], `（打桩）${agent}`)
    },
  }
}

async function eventsOf(root: string, writers: readonly string[] = ['round', 'agent-1']): Promise<LogEvent[]> {
  const log = openLog(root)
  const out: LogEvent[] = []
  for (const w of writers) {
    for await (const e of log.readByWriter(w as WriterId)) out.push(e)
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

// ── ①b 两个 agent 的 A 区全等（在真轮次里量一遍）────────────────────────────────

test('①b 真轮次里两个 agent 各走一格：各自的 prefix/assemble 里 hash(zoneA) 全等，而 B 区各不相同', async () => {
  const b = await bench()
  try {
    const two: readonly AgentId[] = ['agent-1' as AgentId, 'agent-2' as AgentId]
    const split: SplitDraft[] = [
      {
        goal: '写一份 a.ts' as never,
        ownedPaths: ['a.ts' as RelPath],
        deliverables: [{ path: 'a.ts' as RelPath, form: '一份文件' }],
        assertions: [{ name: '总是过', action: 'ok' }],
      },
      {
        goal: '写一份 b.ts' as never,
        ownedPaths: ['b.ts' as RelPath],
        deliverables: [{ path: 'b.ts' as RelPath, form: '一份文件' }],
        assertions: [{ name: '总是过', action: 'ok' }],
      },
    ]
    const seen: string[] = []
    const run = await runRound(
      depsOf(
        b,
        async (ask) => {
          seen.push(ask.agent)
          // 两个 agent 都按同一串脚本干：写它自己那一份产出（`a.ts` · `b.ts`）。
          const first = ask.agent === 'agent-2' ? 'b.ts' : 'a.ts'
          return realDriver({})(
            ask,
            scriptedModel([
              [
                { kind: 'tool', name: 'write', arguments: JSON.stringify({ path: first, content: `（模型写的）${first}\n` }) },
                { kind: 'end' },
              ],
            ]),
          )
        },
        supportOf(b, scriptedModel(SCRIPTS), two),
        'r1',
        {
          split,
          identityFor: (n: number) => ({ agent: two[n] as AgentId, branch: `refs/heads/${two[n]}` as BranchId }),
        },
      ),
    )
    assertLanded(run, '①b 两个 agent 各走一格')
    assert.deepEqual(seen, ['agent-1', 'agent-2'], `两格各被驱动一次，实际 ${seen.join(' ')}`)

    // **一个 agent 一份日志**：A 区的全等要在两份日志之间量，不是在同一份里量两次。
    const a1 = (await eventsOf(b.root, ['agent-1'])).filter((e) => e.t === 'prefix/assemble')
    const a2 = (await eventsOf(b.root, ['agent-2'])).filter((e) => e.t === 'prefix/assemble')
    assert.ok(a1.length >= 1 && a2.length >= 1, `两份日志里都要有装配事件（${a1.length} · ${a2.length}）`)
    const one = a1[0] as { zoneAHash: string; zoneBHash: string }
    const two0 = a2[0] as { zoneAHash: string; zoneBHash: string }
    assert.equal(one.zoneAHash, two0.zoneAHash, '两个 agent 的 A 区不是同一份字节——架筑 § 8.11 那条验证性质在真轮次里不成立')
    assert.notEqual(one.zoneBHash, two0.zoneBHash, '两个 agent 的 B 区居然相同——那 B 区里没有它自己的那一段')
    console.log(
      `①b 读数：agent-1 的 hash(zoneA)=${one.zoneAHash} · agent-2 的 hash(zoneA)=${two0.zoneAHash}（全等）；` +
        `各自的 hash(zoneB)=${one.zoneBHash} / ${two0.zoneBHash}（不相同）`,
    )
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
    // **驱动这一趟恰好一条**：底那一份现在是 git 落的（不走 `checkpoint`），所以日志里只有
    // 这一格自己交的那一条。
    const ckpts = rows.filter((e) => e.t === 'ckpt/commit')
    assert.equal(ckpts.length, 1, `驱动一条，实际 ${ckpts.length} 条`)
    assert.equal(ckpts.filter((e) => e.t === 'ckpt/commit' && e.agent === AGENT).length, 1, '驱动那一趟恰好一条')
    assert.ok(rows.filter((e) => e.t === 'view/write').length >= 1, '产出走的是视图那条路（`view/write`）')
    // **判据分两半**：驱动那一趟（跑到提交为止）是真工作树一个字节不动；而整轮末尾那一步
    // `advance` 的活就是"把盘上推到目标树"（架构 § 8.14 的 `Committed ──advanced──> Rebuilding`），
    // 它写盘是对的。两件事混成一条断言就会在正确的行为上报红。
    assert.deepEqual(before, ['README.md'], '台子起手时真工作树上只有底里那一份（§ 8.4：底就是工作树）')
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
    // **把触发点压到很低**：一份"上限 800 · 触发点 150 · 余量 10"的声明——三区一算就过线。
    // **上限要压到实际三区之上、但不能太远**（实到 292 token：`B6` 那一条报的就是
    // "用了 292（触发点 150）"，而交接提示词那几十个字节要写得下）。压到 200 的话 `planBudget`
    // 直接给 `stop`——那一趟连一步都不走，交接自然一次都没有。
    // **292 这个读数随前缀自己的长度走**：W11 收工口径那三句进「我的任务」之后它涨了一截，
    // 上限因此从 700 抬到 800（那三句是给模型的话，涨是它们的目的，不是漂）。
    const tiny = { ...DECL, contextLimit: 800, budget: { trigger: 150, handoffMargin: 10 } }
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
        { ...supportOf(b, scriptedModel(TINY_SCRIPTS)), decl: tiny } as RoundRunDeps['driver'],
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
    // **逐字**：`driver.ts` 交接那一步算的是 `<前任>-<第几步 + 1>`，而这一趟的步号由脚本与触发点
    // 定死，所以这里钉得住那个数（0.2.9 ⑤：`successorNameOf` 撤了，那条规则原先只有它那一份没有
    // 消费者的实现与一条宽松的正则；规则现在只在生产那一处，断言在真跑出来的这一条上）。
    assert.equal(h.successor, 'agent-1-2', `后继的名字：${h.successor}`)
    // **轮级状态那一栏没被动过**：这条事件里没有轮次号，也没有 `round/state` 跟着它。
    console.log(`③ 读数：交接 ${r.handoffs.length} 次 · 后继 ${String(h.successor)} · 停下来的话「${r.stopped}」`)
  } finally {
    await b.close()
  }
})

// W9 那一段（§ 5.16 的判据）——重来一遍，逐条对得上，不再零敲碎打。
//
// **病**：`driver.ts` 给 CAS 的期望写死成 `base`（收尾 `commitView` 也一样），而 `checkpoint`
// 是模型的合法动作——它每调一次，这一格的 ref 就往前走一格。于是撞错两条：格内第二次
// `checkpoint` 当场 `tool-threw`，收尾那次 `commitView` 直接把 `RefConflictError` 穿出
// `runRound`（它不是 `HarnessError`）——**这一格连 `agent/stop` 都落不下来**，已经干完的活全作废。
//
// **修法**：期望跟着 ref 走（`round/head.ts` 那份格内缓存），头从这一格自己的日志重放。

/** 三条脚本：写一份交付物 → `checkpoint` → `checkpoint` → 说完。 */
const CKPT_SCRIPTS: readonly (readonly ModelEvent[])[] = [
  SCRIPTS[0] as readonly ModelEvent[],
  [
    ...callOne(0, 'k1', 'checkpoint', { message: '第一格' }),
    { t: 'usage', usage: USAGE },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ],
  [
    ...callOne(0, 'k2', 'checkpoint', { message: '第二格' }),
    { t: 'usage', usage: USAGE },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ],
  SCRIPTS[1] as readonly ModelEvent[],
]

/** 两条脚本：写一份交付物 → 说完。**格内一次 `checkpoint` 都不调**（判据 3 那一档）。 */
const CKPT_NEVER: readonly (readonly ModelEvent[])[] = [
  SCRIPTS[0] as readonly ModelEvent[],
  SCRIPTS[1] as readonly ModelEvent[],
]

/** 这一格落下的 `ckpt/commit`（按日志顺序）。 */
async function commitsOf(root: string): Promise<{ commit: string; msg: string }[]> {
  const out: { commit: string; msg: string }[] = []
  for (const e of await eventsOf(root)) {
    if (e.t === 'ckpt/commit' && e.agent === AGENT) out.push({ commit: e.commit, msg: e.msg })
  }
  return out
}

/** 一个提交的父提交（问台子的 git）。 */
function parentsOf(root: string, commit: string): string[] {
  const r = spawnSync('git', ['rev-list', '--parents', '-n', '1', commit], { cwd: root, encoding: 'utf8' })
  return (r.stdout ?? '').trim().split(/\s+/).slice(1)
}

/**
 * 这一格那一趟：**产出由脚本里的 `write` 铺**（与 ① 那一条逐字节同一条路——
 * `write` → `B5` 的工具面 → `view/write`），脚本只管说话与调工具。
 *
 * 为什么不用 `deliver` 那道口：它拿不到这一格的口——`deliver` 的闭包里只有台子那个 `round`
 * 的口，用它写 agent 的日志会当场撞 `hold.ts` 那道栅栏（"一次命令只写一个 writer"，
 * 施工当场撞到过）。脚本自己会写，这一档本来也不需要它。
 */
function ckptRun(b: Bench, scripts: readonly (readonly ModelEvent[])[]): RoundRunDeps {
  return depsOf(b, realDriver({}), supportOf(b, scriptedModel(scripts)))
}

test('W9 ① 格内调一次 `checkpoint` 后照常跑完：ref 上 base → c1 → c2 成链（c2 的 parent 逐字是 c1）', async () => {
  const b = await bench()
  try {
    // 三条脚本：写 → 提交一次 → 说完。所以这一格该落**两条** `ckpt/commit`（模型那一次 + 收尾那次）。
    const one: readonly (readonly ModelEvent[])[] = [
      SCRIPTS[0] as readonly ModelEvent[],
      CKPT_SCRIPTS[1] as readonly ModelEvent[],
      SCRIPTS[1] as readonly ModelEvent[],
    ]
    const run = await runRound(ckptRun(b, one))
    assertLanded(run, 'W9 ①')

    const commits = await commitsOf(b.root)
    // **一条都不能少**：模型那一次与收尾那一次各一条，顺序与发生顺序一致。
    assert.equal(commits.length, 2, `这一格该落两条 ckpt/commit，实际 ${commits.length} 条：${JSON.stringify(commits)}`)
    assert.equal(commits[0]!.msg, '第一格', '前一条是模型给的那句说明')
    assert.match(commits[1]!.msg, /agent-1/, '后一条是收尾提交（说明是这一格的契约目标）')

    // **成链**：c1 接在底上，c2 接在 c1 上——逐字比，不是"看着差不多"。
    assert.deepEqual(parentsOf(b.root, commits[0]!.commit), [b.base], 'c1 的父该是这一格的底')
    assert.deepEqual(parentsOf(b.root, commits[1]!.commit), [commits[0]!.commit], 'c2 的父逐字是 c1')

    // ref 的当前头就是 c2（合并拿到的就是它）。
    const head = (spawnSync('git', ['rev-parse', 'refs/heads/agent-1'], { cwd: b.root, encoding: 'utf8' }).stdout ?? '').trim()
    assert.equal(head, commits[1]!.commit, 'ref 指在 c2 上')
    console.log(`W9 ① 读数：base ${b.base.slice(0, 8)} → c1 ${commits[0]!.commit.slice(0, 8)} → c2 ${commits[1]!.commit.slice(0, 8)}`)
  } finally {
    await b.close()
  }
})

test('W9 ② 格内连调两次 `checkpoint`：第二次照常成功，两个提交号逐字不同（c1 → c2 → c3 成链）', async () => {
  const b = await bench()
  try {
    const run = await runRound(ckptRun(b, CKPT_SCRIPTS))
    assertLanded(run, 'W9 ②')

    const commits = await commitsOf(b.root)
    assert.equal(commits.length, 3, `两条模型提交 + 一次收尾，实际 ${commits.length} 条`)
    assert.deepEqual(commits.map((c) => c.msg).slice(0, 2), ['第一格', '第二格'], '前两条的说明按顺序')

    // **两个提交号逐字不同**，而且三条连成一条链（这才是"相撞"那一条断言的对立面）。
    const ids = commits.map((c) => c.commit)
    assert.equal(new Set(ids).size, 3, `三条提交号该互不相同：${ids.map((i) => i.slice(0, 8)).join(' · ')}`)
    assert.deepEqual(parentsOf(b.root, ids[0]!), [b.base], 'c1 接在底上')
    assert.deepEqual(parentsOf(b.root, ids[1]!), [ids[0]!], 'c2 接在 c1 上')
    assert.deepEqual(parentsOf(b.root, ids[2]!), [ids[1]!], 'c3 接在 c2 上')
    console.log(`W9 ② 读数：${ids.map((i) => i.slice(0, 8)).join(' → ')}（第二次没有撞 CAS）`)
  } finally {
    await b.close()
  }
})

test('W9 ③ 格内一次都没调：收尾提交的父就是底（回归——没踩到就不许跑偏）', async () => {
  const b = await bench()
  try {
    const run = await runRound(ckptRun(b, CKPT_NEVER))
    assertLanded(run, 'W9 ③')

    const commits = await commitsOf(b.root)
    assert.equal(commits.length, 1, `这一格该只有收尾那一条，实际 ${commits.length} 条`)
    assert.deepEqual(parentsOf(b.root, commits[0]!.commit), [b.base], '没踩到 `checkpoint` 时，父就是这一格的底')

    // **头从日志重放、而且接得上这一格的底**——这一句量在最里面那一层：重放一次、再重建一次，
    // 两次都得给出同一份头（「起错头就每次 CAS 都撞」那个坑的守卫：重放认的是日志）。
    const head = await refHeadOf(b.log, AGENT as WriterId, b.base)
    assert.equal(head.value, commits[0]!.commit, '重放出来的头就是日志里最后那条 ckpt/commit')
    assert.equal((await head.refresh()).value, commits[0]!.commit, '重建一次还是它（缓存可以随便作废）')
    assert.deepEqual(parentsOf(b.root, head.value!), [b.base], '而且那份头接得上这一格的底')
    console.log('W9 ③ 读数：无 checkpoint 的一格只有收尾一条提交，父是底（重放 = 那一条）')
  } finally {
    await b.close()
  }
})

test('W9 ④ 缓存只是缓存：任意作废、从日志重建，重建之后行为逐字节相同（重放是权威）', async () => {
  const b = await bench()
  try {
    const run = await runRound(ckptRun(b, CKPT_SCRIPTS))
    assertLanded(run, 'W9 ④')
    const commits = await commitsOf(b.root)
    assert.equal(commits.length, 3, `台子这一趟该落 3 条，实际 ${commits.length} 条`)

    // 拿这一格的日志另开一份缓存（就是 `driveOnce` 起跑时那一次的那个函数）。
    const head = await openRefHead(b.log, AGENT as WriterId, b.base)
    assert.equal(head.value, commits[2]!.commit, '重放出来的头就是最后那一条 ckpt/commit')
    assert.equal((await head.refresh()).value, commits[2]!.commit, '**重建之后逐字节相同**（缓存可以随便作废）')

    // **负对照：重放是权威。** 让这份"日志"第一次读就什么都读不到（缓存刚建出来那一瞬间的样子）
    // ——缓存若把自己当成独立账本，重建就会给出一个旧头；而它给的是底，与日志同源。
    let reads = 0
    const flaky: LogReader = {
      readByWriter: (w, from) => {
        reads += 1
        if (reads === 1) return (async function* () {})()
        return b.log.readByWriter(w, from)
      },
    }
    const h2 = await refHeadOf(flaky, AGENT as WriterId, b.base)
    assert.equal(h2.value, b.base, '日志读不到东西时重放给出这一格的底——缓存里那个头没有变成第二个源')
    assert.equal((await h2.refresh()).value, commits[2]!.commit, '日志回来之后重建，头又是最后那条提交')
    console.log(`W9 ④ 读数：重放与重建都给 c3 ${commits[2]!.commit.slice(0, 8)} · 负对照（空读）给出底 ${b.base.slice(0, 8)}`)
  } finally {
    await b.close()
  }
})

test('W9 ⑤ 负对照：把期望钉死（不跟着 ref 走）→ 收尾提交当场撞 CAS', async () => {
  const b = await bench()
  try {
    // **这一条钉的是"期望必须跟着 ref 走"**：造一份"ref 已经往前走了、而这一格的日志里没有那条
    // `ckpt/commit`"的处境——正好是 W9 那个病（旧代码把期望写死成 `base`，而 `checkpoint` 已经
    // 让 ref 往前走过）。`refresh: false` 把这一刻的头冻住，于是 CAS 拿底去比 ref 的实际值，必输。
    const made = spawnSync('git', ['commit', '--allow-empty', '-qm', '日志之外的推进'], { cwd: b.root, env: GIT_ENV, encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    const stash = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: b.root, encoding: 'utf8' }).stdout ?? '').trim()
    assert.notEqual(stash, b.base, '台子这一下必须真的多出一个提交')

    // 这一格自己的日志口（与台子那几条同一个开法；跑完由 `b.keep` 一起关）。
    const agentLog = openLog(b.root, { write: AGENT as WriterId, sync: 'each' })
    b.keep(agentLog)
    await b.truth.advance(`refs/heads/${AGENT}` as never, stash, b.base)
    const view = await loadView(agentLog, AGENT as WriterId, { lower: lowerAt(b.truth, b.base) })
    // 视图里要有一份真内容（否则交的是空提交——那件事另有它自己的判据）。
    await applyEdit(
      { view, truth: b.truth, log: agentLog, writer: AGENT as WriterId },
      { kind: 'add', path: 'a.ts' as RelPath, bytes: new TextEncoder().encode('（产出）\n'), mode: 0o100644 },
    )

    // ① **钉死**：头停在底上（`refresh: false`），而 ref 早就是 `stash` 了 → CAS 必输。
    const frozen = await refHeadOf(agentLog, AGENT as WriterId, b.base)
    let froze: unknown = null
    try {
      await commitView({
        view,
        log: agentLog,
        truth: b.truth,
        writer: AGENT as WriterId,
        head: frozen,
        msg: '钉死的那一次',
        ref: `refs/heads/${AGENT}` as never,
        refresh: false,
      })
    } catch (e) {
      froze = e
    }
    assert.ok(
      froze instanceof RefConflictError,
      `钉死期望时该撞 CAS，实际：${froze instanceof Error ? `${froze.name}: ${froze.message}` : String(froze)}`,
    )

    // ② **跟着 ref 走**（缺省那一档）：把 ref 挪回底、再提交一次——刷新之后头对上，提交成功，
    // 而且它接在 ref 当时那个值上（这就是"成链"的全部）。
    await b.truth.advance(`refs/heads/${AGENT}` as never, b.base, stash)
    const r = await commitView({ view, log: agentLog, truth: b.truth, writer: AGENT as WriterId, head: frozen, msg: '跟着 ref 走的那一次', ref: `refs/heads/${AGENT}` as never })
    assert.notEqual(String(r.commit), String(stash), '提交必须是一个新提交')
    assert.deepEqual(parentsOf(b.root, String(r.commit)), [b.base], '那一份的父是底（它接在 ref 当时的值上）')
    console.log('W9 ⑤ 读数：钉死期望 → 撞 CAS · 跟着 ref 走 → 提交成功且接在 ref 当时的头上')
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
    // **这一格一条都没交**：没有 agent 名下的提交，也没有空提交挂在轮次那条分支上。
    // （底那一份现在是 git 落的、不走 `checkpoint`，所以日志里连它也没有——这一条比原先更紧。）
    const ckpts = rows.filter((e) => e.t === 'ckpt/commit')
    assert.equal(ckpts.length, 0, `这一格一条都不该交，实际 ${ckpts.length} 条`)
    assert.equal(ckpts.filter((e) => e.agent === AGENT).length, 0, `**${AGENT} 一条都没交**（不交空提交）`)
    console.log('④ 读数：no-driver 当场抛出 · 这一格 0 条 ckpt/commit（底由台子的 git 落）')
  } finally {
    await b.close()
  }
})

// ── ①c 花钱的那道上界：`maxSteps` 真的停得住（第一次联网验证就按它压）──────────────

test('①c `maxSteps` 是真上界，而且它真的传到了驱动那一层（`--max-steps` 接线的判据）', async () => {
  const b = await bench()
  try {
    // `DETOUR_SCRIPTS` 那一串是 3 步（①量的就是它）。给 `maxSteps: 1` 必须恰好停在 1，
    // 而停下来的理由是"步数到顶"——**不是"收敛"**（那是两件事：一个是我拦的，一个是它干完了）。
    const run = await runRound({
      ...depsOf(b, realDriver({}), supportOf(b, scriptedModel(DETOUR_SCRIPTS))),
      maxSteps: 1,
    })
    assertLanded(run, '①c 上界那一趟')
    const calls = (await eventsOf(b.root)).filter((e) => e.t === 'llm/call')
    // **每一步一条 `llm/call`**（①那条口径），所以"恰好一条"就是"恰好一步"。
    assert.equal(calls.length, 1, `给了 maxSteps 1，实际落了 ${calls.length} 条 llm/call`)

    // 负对照：同一串脚本，不给上界 → 3 步（①那条读数）。**没有它，"恰好 1 条"可能只是脚本短。**
    const b2 = await bench()
    try {
      const full = await runRound(depsOf(b2, realDriver({}), supportOf(b2, scriptedModel(DETOUR_SCRIPTS))))
      assertLanded(full, '①c 负对照（不给上界）')
      const calls2 = (await eventsOf(b2.root)).filter((e) => e.t === 'llm/call')
      assert.equal(calls2.length, 3, `不给 maxSteps 时落了 ${calls2.length} 条——那"恰好 1 条"就不是上界的功劳`)
      console.log(`①c 读数：maxSteps=1 → ${calls.length} 条 llm/call · 走完那一趟 ${calls2.length} 条（负对照）`)
    } finally {
      await b2.close()
    }
  } finally {
    await b.close()
  }
})

// ── ①c2 不设上界就是真的不设（上界是用户的决策，不是我们的兜底）──────────────

/**
 * **不给 `--max-steps` 就处处不设**：这一格一直走到它自己收工。原先那一版在这里有一个
 * `DEFAULT_MAX_STEPS = 64` 的兜底——"这一趟最多花多少"被一个没人看过的常量定了；现在它由命令
 * 面给（用户的决策），不给就一直走。
 *
 * 断言的形状：一串 **71 步**的脚本（第一步写 `a.ts`，中间 69 步读它，最后一步说完）。
 *   · 不给上界 → **71 步**走完（不是 64）——这一条就是"那个缺省不在了"的可证伪读数；
 *   · 给 64 → **恰好 64 步**停，而停因说出那是**你给的上界**。
 * 少一半也过不了（71 ≠ 64），所以它不是"脚本短所以只走了一条"那种瞎绿。
 */
test('①c2 不给上界就不设：71 步的脚本走完 71 步；给了 64 就恰好停在 64', async () => {
  const mid = (i: number): readonly ModelEvent[] => [
    ...callOne(0, `c${i}`, 'read', { path: 'a.ts' }),
    { t: 'usage', usage: USAGE },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ]
  const LONG_SCRIPTS: readonly (readonly ModelEvent[])[] = [
    SCRIPTS[0] as readonly ModelEvent[],
    ...Array.from({ length: 69 }, (_unused, i) => mid(i + 2)),
    SCRIPTS[1] as readonly ModelEvent[],
  ]
  /** 这一步之后停因那一句（驱动落的那条 `agent/stop`）。 */
  const stoppedOf = async (root: string): Promise<string> =>
    (await eventsOf(root)).find((e) => e.t === 'agent/stop')?.stopped ?? '（没落）'

  const b = await bench()
  try {
    await runRound(depsOf(b, realDriver({}), supportOf(b, scriptedModel(LONG_SCRIPTS))))
    const calls = (await eventsOf(b.root)).filter((e) => e.t === 'llm/call')
    assert.equal(calls.length, 71, `不给上界该走完 71 步，实际 ${calls.length} 条 llm/call`)
    const stopped = await stoppedOf(b.root)
    assert.equal(stopped, '收敛', `不给上界那一趟的停因该是「收敛」，实际「${stopped}」`)
    console.log(`①c2 读数：不给上界 → ${calls.length} 条 llm/call（停因「${stopped}」）`)
  } finally {
    await b.close()
  }

  const b2 = await bench()
  try {
    await runRound({
      ...depsOf(b2, realDriver({}), supportOf(b2, scriptedModel(LONG_SCRIPTS))),
      maxSteps: 64,
    })
    const calls2 = (await eventsOf(b2.root)).filter((e) => e.t === 'llm/call')
    assert.equal(calls2.length, 64, `给了 64 该恰好停在第 64 步，实际 ${calls2.length} 条`)
    const stopped2 = await stoppedOf(b2.root)
    assert.ok(/到了你给的上界（64 步）/.test(stopped2), `停因该说出那是你给的上界，实际「${stopped2}」`)
    console.log(`①c2 读数：给 64 → ${calls2.length} 条 llm/call（停因「${stopped2}」）`)
  } finally {
    await b2.close()
  }
})

// ── ①c3 真读数修正下一步的账（以 api 返回为最高标准）──────────────────────────

/**
 * 用户那条决策：**不能全量采取估计，通过 api 修正**。断言的形状：同一串脚本、同一份声明，
 * 两条路只差"模型报没报用量"——
 *   · 用量四个数全 null（提供方没报）→ **一步都不修**，六步走完，停因「收敛」；
 *   · 报了一份把账放大三倍的用量 → 第二步起账跟着真读数走，撞上限停下，而停的那句话里说得出
 *     「按 N 份真读数修」。
 * 两条路的步数与停因都不同，所以它不是"脚本短所以只走了一条"那种瞎绿。
 */
test('①c3 真读数修正下一步的账：报了用量就跟着它走，没报就一步不修', async () => {
  const tiny = { ...DECL, contextLimit: 900, budget: { trigger: 250, handoffMargin: 10 } }
  interface Usageish {
    inputTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    outputTokens: number | null
    reasoningTokens: number | null
    model: string | null
  }
  const NONE: Usageish = { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, model: null }
  /** 那份 tiny 前缀的原始估账是 292（③ 的注释里那个数），900 是它三倍上下。 */
  const BIG: Usageish = { ...NONE, inputTokens: 900 }
  const withUsage = (usage: Usageish): readonly (readonly ModelEvent[])[] => {
    const swap = (step: readonly ModelEvent[]): ModelEvent[] =>
      step.map((e) => (e.t === 'usage' ? { t: 'usage', usage } : e))
    const mid = (i: number): ModelEvent[] =>
      swap([
        ...callOne(0, `r${i}`, 'read', { path: 'a.ts' }),
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
      ])
    return [
      swap(SCRIPTS[0] as readonly ModelEvent[]),
      ...Array.from({ length: 4 }, (_x, i) => mid(i + 2)),
      swap(SCRIPTS[1] as readonly ModelEvent[]),
    ]
  }
  const stoppedOf = async (root: string): Promise<string> =>
    (await eventsOf(root)).find((e) => e.t === 'agent/stop')?.stopped ?? '（没落）'
  const runOf = async (usage: Usageish): Promise<{ calls: number; stopped: string }> => {
    const b = await bench()
    try {
      const driver = realDriver({})
      await runRound(
        depsOf(
          b,
          async (ask) => driver({ ...ask, decl: tiny, maxSteps: 8 } as never),
          { ...supportOf(b, scriptedModel(withUsage(usage))), decl: tiny } as RoundRunDeps['driver'],
        ),
      )
      return {
        calls: (await eventsOf(b.root)).filter((e) => e.t === 'llm/call').length,
        stopped: await stoppedOf(b.root),
      }
    } finally {
      await b.close()
    }
  }

  const silent = await runOf(NONE)
  assert.equal(silent.calls, 6, `没读数那一趟该走完 6 步，实际 ${silent.calls} 条 llm/call`)
  assert.equal(silent.stopped, '收敛', `没读数那一趟的停因该是「收敛」，实际「${silent.stopped}」`)
  console.log(`①c3 读数：用量全 null → ${silent.calls} 条 llm/call（停因「${silent.stopped}」）`)

  const heard = await runOf(BIG)
  assert.ok(heard.calls < silent.calls, `报了用量那一趟该更早停：${heard.calls} < ${silent.calls}`)
  assert.match(heard.stopped, /按 1 份真读数修/, `停的那句话该说清账是按真读数修的：「${heard.stopped}」`)
  assert.match(heard.stopped, /不裁剪后照发/, heard.stopped)
  console.log(`①c3 读数：用量报 900 → ${heard.calls} 条 llm/call（停因「${heard.stopped}」）`)
})

// ── ①d 执行类工具落在哪棵树上 ──────────────────────────────────────────────────

/**
 * ①d **`bash` 落在这一格的执行面上**：W8 起它是**物化根**（`.fugue/mat/<agent>/merged`）——
 * 既不是发出这条命令的那个进程的目录（跑测试时是 `~/fugue`），也不是真实工作区（`realRoot`）。
 *
 * **W8 起这一格的档是恒定的 `workspace-write`，而这一档不加挂载层**（`resolvePolicy`：
 * 挂载层只在 `read-only` 档用）——所以今天真驱动那一趟走的是第二层（`landlock`），子进程就在
 * 宿主上跑、`spawn` 的 `cwd` 是物化根那个绝对路径。**按档取的写法照旧留着**：档是环境给的
 * （内核有没有 Landlock · 有没有 `bwrap`），换一台机器读数就换一个坐标，而"落在物化根上"
 * 这句话在档与档之间是同一个事实。挂载层在场那一档报的是 `/work`（架构 § 8.8 的
 * `Policy.coords`）。
 *
 * 这条断言为什么值一条测试：cwd 落错**不报错**，它只是让模型在一棵别的树上干活——第一次联网
 * 验证量到的就是这个（`--root /tmp/…` 从 `~/fugue` 里发出去，模型那一条 `find .` 把产品仓库
 * 列了一遍，四步全在 `find`，`写 0 条`，而退出码 0）。
 *
 * 三半各量一件事，而**三半都只读**——不在这一格的根里落任何字节：落了会被这一轮末尾的漂移检
 * 拦下（"盘上那一份既不是底、也不是这次合并算出来的"），而那是它对的行为。所以那一份要读的字节
 * 不另放：用**台子那个底里的一份文件**（`README.md`）——那一条测试自己写进去的记号。`.fugue/`
 * 是派生区、**不进物化树**（架构 § 9.1），所以拿日志当"根里的东西"是错的，这一条第一版踩过。
 *
 *   一 · 子进程的 cwd 就是这一格的执行面（`pwd` 那一句；沙箱里报 `/work`，退化档报物化根）；
 *   二 · **相对路径落在执行面上，而且读得到这个根里的东西**：那一句在 `README.md` 里
 *        `grep -c` 一条只属于这一次跑的记号——产品仓库的同一路径里没有它；
 *   三 · 工具结果进的是**模型真看见的那串字节**（下一步的 C 区是那份前缀的一段）。
 */
// ── ①e 契约那一格的"还剩几步"（收工口径的第三面 · 推到子 agent 那一档）──────────

/**
 * **预算快用完时，契约那一格的回执末尾也多一句"还剩几步"**（持轮者那一格那一条在 `plan.test.ts`
 * 的 ⑪ 里）。
 *
 * 由头：样本盘第十六趟（案一 · cap 16 · 第五趟，`/tmp/scenario-b21/run/case-1-3`）——持轮者这一趟
 * 没拆（整件事一份契约 · 一格），那一格 **16 步里 10 步在视图之外找 TypeScript 编译器**，而工作
 * 第 5–6 步就做完了（写两个文件 + 删 `legacy/`），最后停在 16 步上界。它手里有"这一格最多几步"
 * （「我的任务」那一句），但那 10 步里没有一处提醒它"预算正在用完"。
 *
 * 断言的形状（与持轮者那一格同一个）：一串 **8 步**的脚本（写 `a.ts` → 读 6 次 → 收工）——
 *   · 给上界 8 → 第 5 · 6 · 7 步各带一句，数是 **3 · 2 · 1**，而句子里那半句是**契约那一格的**
 *     （"把产物落下去"，不是持轮者那句"写草案"）；
 *   · 不给上界 → **一次都不说**（负对照）。
 * 两条路的读数不同，所以它不是"脚本短所以没出现"那种瞎绿。
 */
test('①e 契约那一格：预算快用完时回执末尾多一句"还剩几步"（上界前那三步），不给上界一次都不说', async () => {
  const read = (i: number): readonly ModelEvent[] => [
    ...callOne(0, `r${i}`, 'read', { path: 'a.ts' }),
    { t: 'usage', usage: USAGE },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ]
  /** 8 步：写 → 读 6 次 → 说完。 */
  const EIGHT: readonly (readonly ModelEvent[])[] = [
    SCRIPTS[0] as readonly ModelEvent[],
    ...Array.from({ length: 6 }, (_unused, i) => read(i + 2)),
    SCRIPTS[1] as readonly ModelEvent[],
  ]
  const record = (): { call: CallModel; seen: string[] } => {
    const seen: string[] = []
    const inner = scriptedModel(EIGHT)
    // **只收最后那一条轮次**：C 区那条尾巴是累积的，逐条收会把同一份回执数好几遍。
    const call: CallModel = (req: RuntimeRequest, signal: AbortSignal) => {
      for (const one of (req.turns ?? []).at(-1)?.results ?? []) seen.push(one.output)
      return inner(req, signal)
    }
    return { call, seen }
  }

  const b = await bench()
  try {
    const capped = record()
    await runRound({ ...depsOf(b, realDriver({}), supportOf(b, capped.call)), maxSteps: 8 })
    const hits = capped.seen.filter((o) => o.includes(' left.'))
    assert.equal(
      hits.length,
      3,
      `上界 8 那一档该从第 5 步起每步说一次（还剩 3 · 2 · 1 步）：${hits.map((h) => h.slice(-90)).join(' | ')}`,
    )
    assert.match(hits[0] ?? '', /3 left\./, `第 5 步那一次说的数不对：${hits[0] ?? ''}`)
    assert.match(hits[1] ?? '', /2 left\./, `第 6 步那一次说的数不对：${hits[1] ?? ''}`)
    assert.match(hits[2] ?? '', /1 left\./, `第 7 步那一次说的数不对：${hits[2] ?? ''}`)
    assert.ok(
      hits.every((h) => h.includes('Land the deliverable(s) now')),
      `契约那一格的收工那半句该是"把产物落下去"：${hits[0] ?? ''}`,
    )
    assert.equal(
      capped.seen.filter((o) => o.includes('Write the draft now')).length,
      0,
      '持轮者那一句不该出现在契约那一格',
    )

    // 负对照：命令行那一栏空着（没有上界）→ 一次都不说。
    const b2 = await bench()
    try {
      const bare = record()
      await runRound(depsOf(b2, realDriver({}), supportOf(b2, bare.call)))
      assert.equal(bare.seen.filter((o) => o.includes(' left.')).length, 0, '没给上界却说了"还剩几步"')
      console.log(
        `①e 读数：上界 8 那一趟，模型看到的 ${capped.seen.length} 份回执里 ${hits.length} 份带"还剩"` +
          `（${hits.map((h) => (h.match(/\d+ left\./) ?? [''])[0]).join(' · ')}）· 没给上界那一趟 ${bare.seen.filter((o) => o.includes(' left.')).length} 份`,
      )
    } finally {
      await b2.close()
    }
  } finally {
    await b.close()
  }
})

test('①d `bash` 落在这一格的物化根上（不是进程自己的目录，也不是真实工作区）', async () => {
  // **靶子那串字节在台子那一步就写进底**（工作树与提交一起）：测试体里再改盘会被漂移检当场拦下
  // （"盘上那一份既不是底、也不是这次合并算出来的"）——那正是它该做的。
  const b = await bench('fugue-driver-base-marker\n')
  // **W8 起执行面是物化根**（`host.execCwd()`）：同一格之内 `write` 进视图、`bash` 跑在那一棵
  // 由 `ensure` 同步过去的树上——两句话因此不会打架（§ 5.15.a 的那对事实）。
  const merged = matParts(b.root as never, AGENT).merged
  try {
    // **要读的那一串字节**就是台子写进底里的那一条记号（`README.md`）。
    const marker = 'fugue-driver-base-marker'
    const cmd = (args: Record<string, unknown>): readonly ModelEvent[] => [
      ...callOne(0, 'c1', 'bash', args),
      { t: 'usage', usage: USAGE },
      { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
    ]
    // 前两条是工具调用；之后一直用最后一条（脚本用完了就用最后一条——`scriptedModel` 的口径）。
    const scripts: readonly (readonly ModelEvent[])[] = [
      cmd({ command: 'pwd' }),
      cmd({ command: `grep -c ${marker} README.md; /bin/pwd` }),
      [
        { t: 'delta', text: '看过了。' },
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
      ],
    ]
    // **`scriptedModel` 只能建一次**：它内部那个"第几次被调"的计数是每建一份各算各的——写在回调
    // 里就是每一步都从第 0 条脚本重来（那一步于是永远 `pwd`，后半条断言量不到东西）。
    const scripted = scriptedModel(scripts)
    // **把每一步发出去的那份前缀收下来**：C 区里就是模型看到的工具结果。
    const asked: RuntimeRequest[] = []
    const call: CallModel = (request, signal) => {
      asked.push(request)
      return scripted(request, signal)
    }
    const run = await runRound(depsOf(b, realDriver({}), supportOf(b, call)))
    assertLanded(run, '①d cwd 那一趟')


    const zoneC = (n: number): string => new TextDecoder().decode(asked[n]?.prefix.zoneC ?? new Uint8Array())
    const first = zoneC(1)
    const second = zoneC(2)
    console.log(
      `①d 读数：这一格的根 ${b.root} · 进程目录 ${process.cwd()}\n` +
        `  第一次的 C 区尾：${JSON.stringify(first.slice(-200))}\n` +
        `  第二次的 C 区尾：${JSON.stringify(second.slice(-260))}`,
    )

    // **这一格的执行面在哪一门里**：只看"读数是不是执行面"会漏掉一种退化——`bash` 若没被围栏
    // 包住，它仍会在 `spawn` 的那个 cwd（物化根）里跑，报出来的照样是执行面。所以两门各钉一条：
    // **沙箱里报的是它自己那门坐标 `/work`（`Policy.coords`）**，退化档在宿主上跑、报物化根那个
    // 绝对路径。任一门下都不许出现真实工作区那个绝对路径（下面第三条断言钉它）。
    // **今天走到的是后面那一门**（`workspace-write` 不加挂载层），这里按读数取——档由环境定，
    // 不写死在哪一门上。
    const sandboxed = first.includes('\n/work\n')
    const where = sandboxed ? '/work' : merged
    console.log(`①d 执行面：${where}（这一门${sandboxed ? '是沙箱' : '在宿主上'}）`)

    // 一 · 子进程报出来的目录就是执行面（按档取坐标：沙箱里是 `/work`，退化档是物化根）。
    assert.ok(
      first.includes(`\n${where}\n`),
      `\`pwd\` 的读数该是执行面 ${where}——` +
        `那一步的 C 区里没有它。\n  C 区尾部：${first.slice(-300)}`,
    )
    // 一并钉住"真实工作区不是执行面"：模型看见的世界里没有它（`merged` 的字符串里当然带根那个
    // 前缀，所以先把执行面那一串替掉，再看剩下的是不是提到真实工作区）。
    const stripped = first.split(merged).join('（执行面）')
    assert.ok(
      !stripped.includes(b.root),
      `真实工作区 ${b.root} 不该出现在模型看见的世界里——C 区尾部：${first.slice(-300)}`,
    )
    // 二 · **相对路径落在执行面上，而且读到的就是这个根里的东西**：命中一行（那串记号只在
    //     这一格的根里有），而且**不是一句报错**。
    assert.ok(
      second.includes('\n1\n'),
      `那一句该在这个根里命中 1 行——C 区尾部：${second.slice(-400)}`,
    )
    assert.ok(
      !second.includes('No such file'),
      `那一句该读得到（相对路径落在执行面上）：C 区尾部：${second.slice(-400)}`,
    )
    // 三 · 同一次调用的收尾也报同一个落点（两半互为旁证：读到的东西对了，站的地方也对了）。
    assert.ok(
      second.includes(`\n${where}\n`),
      `那一句的 cwd 该是 ${where}——C 区尾部：${second.slice(-400)}`,
    )

    const starts = (await eventsOf(b.root)).filter((e) => e.t === 'run/start')
    assert.equal(starts.length, 2, `两次 bash 各落一条 run/start，实际 ${starts.length} 条`)
    // **两次调用都是相对路径**（`cwd` 那一栏是空串 = 这一格的根）：落点错的时候，这两句正是那句
    // `find .` 变成"把产品仓库列一遍"的形状。
    assert.deepEqual(starts.map((e) => e.cwd), ['', ''], '两次 bash 的 cwd 都是这一格的根')
  } finally {
    await b.close()
  }
})

test('P1a · round 那一路的 bash 也过 envFor：坐标是本 agent 的、宿主的凭据键读不到', async () => {
  // 文件顶部已往测试进程放了 DEEPSEEK_API_KEY：宿主真的有这个键，「读不到」才是 envFor 拦的，
  // 不是键本来就不在。**这一路修之前是整份继承**——`commandFor` 只交命令行，spawn 不带 env，
  // 宿主环境（连凭据键）原样进沙箱里的 bash，这是架构 § 14.4 那条挂账的 round 侧。
  const b = await bench()
  try {
    // 探针就一句（常量参数列表，不拼任何输入）：printenv 按参数各打一行，键不在就跳过那一行
    // ——HOME 与 PORT 是 envFor 该给的坐标与端口片，DEEPSEEK_API_KEY 在 core 基线下缺席。
    const PROBE = 'printenv HOME PORT DEEPSEEK_API_KEY'
    const scripts: readonly (readonly ModelEvent[])[] = [
      [
        ...callOne(0, 'c1', 'bash', { command: PROBE }),
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
      ],
      [
        { t: 'delta', text: '看过了。' },
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
      ],
    ]
    const scripted = scriptedModel(scripts)
    const asked: RuntimeRequest[] = []
    const call: CallModel = (request, signal) => {
      asked.push(request)
      return scripted(request, signal)
    }
    const run = await runRound(depsOf(b, realDriver({}), supportOf(b, call)))
    assertLanded(run, 'P1a env 那一趟')

    const zoneC = (n: number): string => new TextDecoder().decode(asked[n]?.prefix.zoneC ?? new Uint8Array())
    const tail = zoneC(1).slice(-400)
    console.log(`P1a 读数：那一步的 C 区尾：${JSON.stringify(tail)}`)

    // 一 · 宿主的凭据键读不到（core 基线）——打出假值来就是宿主环境还在整份进。
    assert.ok(
      !tail.includes('driver-P1a 的探测假值'),
      `bash 的环境里该没有 DEEPSEEK_API_KEY——C 区尾：${tail}`,
    )
    // 二 · HOME 与 PORT 是 envFor 给的坐标与端口片（沙箱门 HOME=/cache，宿主门是本 agent 的
    // 缓存路径——两门都带 cache），不是从宿主环境继承来的那份。
    const lines = tail.split('\n')
    const at = lines.findIndex((l, ix) => ix > 0 && /^3\d{4}$/.test(l))
    assert.ok(at > 0, `PORT 那一行该是端口片里的号——C 区尾：${JSON.stringify(tail)}`)
    const home = lines[at - 1] ?? ''
    assert.ok(home.includes('cache'), `HOME 那一行该是本 agent 的坐标——C 区尾：${JSON.stringify(tail)}`)
    assert.notEqual(home, process.env.HOME ?? '(宿主没有 HOME)', 'HOME 该是本 agent 的坐标，不是宿主那个家')
    assert.notEqual(lines[at] ?? '', process.env.PORT ?? '', 'PORT 不是从宿主环境继承来的')
  } finally {
    await b.close()
  }
})

// ── P3b1 · run_action 归真（计划 § 5.20 第三线：名字按绑定解析成命令行，不再当 shell 命令跑）──

test('P3b1 · run_action 的命令行来自绑定的解析：args 追加到尾 · 没绑的拒且指路', async () => {
  const b = await bench()
  try {
    // 绑定就一条：mark。argv 用 `node -e` 打一行读数——`process.argv.slice(1)` 恰是「追加到尾」的
    // 那几个参数，模型给了什么、spawn 收到什么，一行读数两头都能对上。
    const SCRIPT = "process.stdout.write('P3B1-MARK:' + process.argv.slice(1).join(','))"
    mkdirSync(join(b.root, '.fugue'), { recursive: true })
    writeFileSync(
      join(b.root, '.fugue', 'config'),
      JSON.stringify({ actions: { mark: { argv: [process.execPath, '-e', SCRIPT] } } }),
    )

    const scripts: readonly (readonly ModelEvent[])[] = [
      [
        ...callOne(0, 'c1', 'run_action', { action: 'mark', args: ['one', 'two'] }),
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
      ],
      [
        ...callOne(0, 'c2', 'run_action', { action: 'nope' }),
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
      ],
      [
        { t: 'delta', text: '跑完了。' },
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
      ],
    ]
    const scripted = scriptedModel(scripts)
    const asked: RuntimeRequest[] = []
    const call: CallModel = (request, signal) => {
      asked.push(request)
      return scripted(request, signal)
    }
    const run = await runRound(depsOf(b, realDriver({}), supportOf(b, call)))
    assertLanded(run, 'P3b1 那一趟')

    const zoneC = (n: number): string => new TextDecoder().decode(asked[n]?.prefix.zoneC ?? new Uint8Array())
    const markTail = zoneC(1).slice(-300)
    const nopeTail = zoneC(2).slice(-300)
    console.log(`P3b1 读数：mark 的 C 区尾：${JSON.stringify(markTail)}\n  nope 的 C 区尾：${JSON.stringify(nopeTail)}`)

    // 一 · **账上那一行就是绑定解析出来的命令行**：argv = 绑定的 argv + 模型的 args 追加到尾。
    //    （归真之前那一行是 `shellArgv(名字)`——`['/bin/sh','-c','mark']`，与实际要跑的不是同一条。）
    const starts = (await eventsOf(b.root)).filter((e) => e.t === 'run/start' && e.action === 'run_action')
    assert.equal(starts.length, 2, `两次 run_action 各落一条 run/start，实际 ${starts.length} 条`)
    assert.deepEqual(
      starts[0]?.argv,
      [process.execPath, '-e', SCRIPT, 'one', 'two'],
      'run_action 的 run/start 该记绑定解析出来的 argv（名字不再是 shell 命令）',
    )
    // 二 · **spawn 收到的就是那一行**：追加的参数从子进程的 process.argv 读得回来（stdout 进回执进 C 区）。
    assert.ok(markTail.includes('P3B1-MARK:one,two'), `mark 的读数该带追加的那两个参数——C 区尾：${markTail}`)
    assert.ok(markTail.includes('action mark exit code 0'), `mark 的回执头该是退出码 0——C 区尾：${markTail}`)
    // 三 · 地板：名字没绑 → 拒且话里带 actions 键的指路（readBinding 那句原样到模型面前，不猜不补）。
    assert.ok(
      nopeTail.includes('fugue config set actions.nope'),
      `没绑的名字该被拒并指路 actions 键——C 区尾：${nopeTail}`,
    )
    assert.ok(nopeTail.includes('action nope exit code 1'), `nope 的回执头该是退出码 1——C 区尾：${nopeTail}`)
  } finally {
    await b.close()
  }
})

// ── 产出去向 · run_action 的回写与 bash 同一条反向通道（W8 起；host.ts 原先写着「没接上」是过期的）──

test('产出去向 · 声明集内的产出回视图进提交，集外的写 mat/reclaim 如实报、进不了', async () => {
  const b = await bench()
  try {
    // 一条动作写两样：声明集内的 out/mark.txt 与集外的 outside.txt——去向该分开。契约的写入面
    // 恰是那一条声明路径（门上的跨字段检查：outputs ⊆ ownedPaths），于是这一趟把回写的两个方向
    // 都走了一遍：集内随 applyEdit 回视图，集外落一条 mat/reclaim。
    const EMIT = 'mkdir -p out && echo mark > out/mark.txt && echo noise > outside.txt'
    mkdirSync(join(b.root, '.fugue'), { recursive: true })
    writeFileSync(
      join(b.root, '.fugue', 'config'),
      JSON.stringify({
        actions: {
          emit: { argv: ['/bin/sh', '-c', EMIT], outputs: ['out/mark.txt'], doc: '写一份声明集内的产出与一份集外的噪声' },
        },
      }),
    )

    const scripts: readonly (readonly ModelEvent[])[] = [
      [
        ...callOne(0, 'c1', 'run_action', { action: 'emit' }),
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
      ],
      [
        { t: 'delta', text: '跑完了。' },
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
      ],
    ]
    const scripted = scriptedModel(scripts)
    const asked: RuntimeRequest[] = []
    const call: CallModel = (request, signal) => {
      asked.push(request)
      return scripted(request, signal)
    }
    const run = await runRound(
      depsOf(b, realDriver({}), supportOf(b, call), 'r1', {
        split: [
          {
            goal: '跑 emit 把产出写出来',
            ownedPaths: ['out/mark.txt' as RelPath],
            deliverables: [{ path: 'out/mark.txt' as RelPath, form: '一份文件' }],
            assertions: [{ name: '总是过', action: 'ok' }],
          },
        ],
      }),
    )
    assertLanded(run, '产出去向那一趟')

    const events = await eventsOf(b.root)

    // 一 · 账上那一行就是绑定解析出来的命令行（与 P3b1 同一条口径）：产出去向的判据都挂在
    //    「跑的就是声明的那条」上。
    const starts = events.filter((e) => e.t === 'run/start' && e.action === 'run_action')
    assert.equal(starts.length, 1, `emit 该恰起一次进程，实际 ${starts.length} 条 run/start`)
    assert.deepEqual(starts[0]?.argv, ['/bin/sh', '-c', EMIT], 'run_action 的 run/start 该记绑定的 argv')

    // 二 · **声明集内的产出回视图、进提交**：`afterRun` 的 applyEdit 把物化树里的差异写回
    //    （W8 的反向通道），收尾提交里就有那一份，字节即命令写下的。
    const commit = Object.values(run.work)[0] as CommitId
    const entries = await entriesOf(b.truth, commit)
    const names = entries.map((e) => e.name).sort()
    assert.ok(names.includes('out/mark.txt'), `收尾提交该含声明集内的产出——实际 ${JSON.stringify(names)}`)
    const mark = entries.find((e) => e.name === 'out/mark.txt')
    const markBytes = mark === undefined ? '' : Buffer.from((await b.truth.getBlob(mark.id as never)) ?? new Uint8Array()).toString('utf8')
    assert.equal(markBytes, 'mark\n', '产出的字节该是命令写下的那份')

    // 三 · **集外的写进不了提交**：物化树里落了盘，但声明集不认——收尾树里没有它。
    assert.ok(!names.includes('outside.txt'), `集外的写不该进提交——实际 ${JSON.stringify(names)}`)

    // 四 · **集外的写被如实报**：`undeclared` 枚举 upper、减掉清单与声明集，`mat/reclaim` 落一条账，
    //    changed 恰是集外那一份——报，但不进。
    const reclaims = events.filter((e) => e.t === 'mat/reclaim')
    assert.equal(reclaims.length, 1, `集外的写该落一条 mat/reclaim，实际 ${reclaims.length} 条`)
    assert.deepEqual(reclaims[0]?.changed, ['outside.txt'], 'changed 该恰是集外那一份')
  } finally {
    await b.close()
  }
})
