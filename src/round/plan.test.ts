// C1 的断言（PLAN § 5.10 的 C1 行 · 架构 § 15.1.a 的四步与"出口三档"· § 15.1 纪律 2/3 ·
// § 8.13 的 `Idle → Planning`）。跑法：cd ~/fugue && node --test src/round/plan.test.ts
//
//   ① **一趟预备态：一个契约都没发 · 一条分支都没起 · 真实工作树一个字节不动**，而日志里有
//      `round/intent` 与 `holder/distill`（草案跟着事件正文进日志，盘上不落第三处）
//   ② **出口三档落到同一个判据**：模型声明（`exit_plan_mode`）· Harness 判自然结束（`end-turn`）·
//      人喊停（`judgeOnly`）——三条路读出来的草案逐字节相同、判出来的结果相同
//   ③ **负对照**：草案缺一个键而模型照样调了 `exit_plan_mode` → 不许放行，要报出缺哪一节哪个键
//   ④ **每一格的预估占用印得出来，且落在甜点区间**；负对照：`ownedPaths` 铺到整棵树 → 那一条变红
//   ⑤ **持轮者那一格的作用域**：`bash` 与 `checkpoint` 回一句指路的话（不抛），而**工具目录与
//      子 agent 逐条相同**（不给持轮者加工具——架构 § 15.4 那一句）
//   ⑥ **同一轮里再跑一趟不造第二条 `Idle → Planning`**，意图只写一次（纪律 2/3）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import { createRoots } from '../roots/roots.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import type { AssembleState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import { modelDeclOf } from '../model/contract.ts'
import type { ModelDecl } from '../model/contract.ts'
import { scriptedModel } from '../runtime/step.ts'
import type { AgentHandle, ModelEvent, ToolCallRequest, ToolExecutor, ToolResult } from '../runtime/step.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'
import { createToolHost } from '../tools/host.ts'
import { createToolExecutor } from '../capability/dispatch.ts'
import { identFor } from '../identity.ts'
import { refHeadOf } from './head.ts'
import { scanTree, WORKSPACE_STATE } from '../materialize/diffstat.ts'
import { draftPathOf } from '../contract/draft.ts'
import type { DraftSection } from '../contract/draft.ts'
import { estimateTokensOfText } from '../runtime/budget.ts'
import { seedTextOf, seedTokensOf } from '../contract/build.ts'
import { holderFace, occupancyOf, planRound } from './plan.ts'
import type { PlanResult } from './plan.ts'

const KEEP = process.env.KEEP === '1'
const dirs: string[] = []
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
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

/** 一条工具调用（三段：起点 · 分片 · 收尾）——字段名照 `B1` 的 `ModelEvent`。 */
function callOne(index: number, id: string, name: string, args: unknown): ModelEvent[] {
  const text = JSON.stringify(args)
  return [
    { t: 'tool-start', index, id, name },
    { t: 'tool-delta', index, args: text },
    { t: 'tool-call', index, id, name, arguments: text },
  ]
}

const USAGE = { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40, rawStop: null, model: null }

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

interface Bench {
  readonly root: string
  readonly log: LogHandle
  readonly truth: ReturnType<typeof openTruth>
  readonly base: CommitId
  readonly before: string
  /** 开跑之前那几条 ref（"一条分支都没起"量的是**这一趟没多出新的**）。 */
  readonly refs: readonly string[]
}

/** 一份台子：真仓库（一个底提交 + 一份方针）· 持轮者那一个日志口。 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-c1-'))
  dirs.push(root)
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  writeFileSync(join(root, 'AGENTS.md'), '# 方针\n\n- 一条。\n')
  writeFileSync(join(root, 'src-parse.ts'), '// 底里的解析器\n')
  const staged = spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(staged.status, 0, staged.stderr)
  const made = spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  assert.equal(base.length, 40, '读不出底那个提交')
  const truth = openTruth(root)
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  // **主线指着这个底**：轮次的底读的就是它（架构 § 8.14 的 C7）。`git init` 那一条缺省的分支名
  // 由 git 版本与全局配置定（这一份把全局配置关了），所以这一条按"没有才建"写——不假定它叫哪
  // 个名字。**轮次读的是 `refs/heads/main`**（`refFor('round')`）。
  // （`resolve` 读不到是抛，不是给 null——与 `agentCoord` 那一处同一条口径。）
  const hasMain = await truth.resolve('refs/heads/main' as never).then(
    () => true,
    () => false,
  )
  if (!hasMain) await truth.advance('refs/heads/main' as never, base, null)
  return {
    root,
    log,
    truth,
    base,
    before: JSON.stringify(scanTree(root, { skip: WORKSPACE_STATE }).leaves),
    refs: refsOf(root),
  }
}

/** 持轮者的那一份状态与句柄（一份状态值 + 一个句柄，与 CLI 那一档同一个形状）。 */
function holderOf(b: Bench): { handle: AgentHandle; sub: AssembleState } {
  const holder: AssembleState = {
    ...emptyState(),
    ...fixtureState(0),
    step: 0,
    cwd: '',
    policy: '# 方针\n\n- 一条。\n',
    goal: '把解析器拆出来',
    distill: '',
    recent: '',
  }
  const handle: AgentHandle = {
    agent: 'round' as AgentId,
    // **持轮者那一格没有 agent 这一栏**（架构 § 8.11：它手里是全部契约，不是一份）。
    coord: null,
    branch: 'refs/heads/main' as BranchId,
    contract: '' as ContractId,
    protocol: HOLDER_PROTOCOL,
    model: DECL.id,
    wireModel: 'deepseek-chat',
    target: { providerId: 'fixture', host: '', wire: { name: 'anthropic-messages' }, path: '', model: 'deepseek-chat', from: 'fixture', headers: {} },
    adapter: { name: 'anthropic-messages' },
    state: holder,
  }
  return { handle, sub: { ...emptyState(), ...fixtureState(0), step: 0, cwd: '' } }
}

/**
 * 这一趟的持轮者那一层：**走产品那两份实现**（`createToolHost` + `createToolExecutor`）。
 *
 * 为什么不用一个假的执行器：`exit_plan_mode` 那一档的收工判据是"它落了 `holder/plan` 并叫停"
 * ——假执行器会把这条判据变成"假执行器恰好返回了 halt"，而那正是要量的东西。
 */
async function wiringOf(
  b: Bench,
  view: Awaited<ReturnType<typeof loadView>>,
): Promise<{ execute: ToolExecutor; view: Awaited<ReturnType<typeof loadView>> }> {
  const roots = createRoots(b.root as never)
  const head = await refHeadOf(b.log, 'round' as WriterId, b.base)
  const host = createToolHost(view, roots, {
    actions: { writer: 'round' as WriterId, log: b.log, truth: b.truth, head },
  })
  const execute = createToolExecutor({
    logOf: () => b.log,
    host,
    fenceOf: (raw, cwd) => {
      const got = roots.resolveVirtual(raw, cwd as RelPath)
      return got.ok ? { ok: true as const, value: got.value } : { ok: false as const, error: got.error }
    },
  })
  return { execute, view }
}

/** 一趟预备态。`session` 是模型那一串脚本；不给就是人喊停那一档（不跑模型）。 */
async function plan(
  b: Bench,
  sections: readonly Record<string, unknown>[],
  opts: { readonly declare?: boolean; readonly judge?: boolean; readonly path?: RelPath } = {},
): Promise<PlanResult> {
  const { handle, sub } = holderOf(b)
  // **一份视图，两处用**（写它的那一份与判它那一份是同一个对象）：调用点那一侧按 `base` 记着。
  let view: Awaited<ReturnType<typeof loadView>> | undefined
  const viewOf = async (base: CommitId): Promise<Awaited<ReturnType<typeof loadView>>> => {
    if (view === undefined) view = await loadView(b.log, 'round' as WriterId, { lower: lowerAt(b.truth, base) })
    return view
  }
  const { execute } = await wiringOf(b, await viewOf(b.base))
  const text = draftText(sections)
  const path = opts.path ?? draftPathOf(ROUND)
  const write: ModelEvent[] = [...callOne(0, 'c1', 'write', { path, content: text }), { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }]
  const end: ModelEvent[] =
    opts.declare === true
      ? [...callOne(0, 'c2', 'exit_plan_mode', { plan: '拆成两格，各写一半', planFilePath: path }), { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }]
      : [{ t: 'delta', text: '拆完了。' }, { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }]
  if (opts.judge === true) {
    // 人喊停那一档：草案由人放进视图（就是"人写草案、机器判"那条地板），这一趟一步都不跑。
    await (await viewOf(b.base)).write(path, new TextEncoder().encode(text))
  }
  return await planRound({
    base: b.base,
    view: await viewOf(b.base),
    log: b.log,
    round: ROUND,
    goal: '把解析器拆出来',
    handle,
    decl: DECL,
    call: scriptedModel([write, end]),
    execute,
    tools: CATALOG,
    maxSteps: 8,
    // **身份按构造次序问**（调查型在前）：门判出来的那一批契约的身份就是放行那一下要发的那些。
    identityFor: (n: number) => identFor(ROUND, n),
    // 绑好的动作表：这一份台子把 `ok` 绑上、不声明产出（一条只跑退出码的断言）。
    actions: { ok: [] as readonly RelPath[] },
    ...(opts.judge === true ? { judgeOnly: true } : {}),
    occupancy: {
      decl: DECL,
      base: sub,
      goal: '把解析器拆出来',
      round: ROUND,
      maxSteps: 8,
      tools: JSON.stringify(CATALOG),
    },
  })
}

async function eventsOf(b: Bench): Promise<LogEvent[]> {
  const out: LogEvent[] = []
  for await (const e of b.log.readByWriter('round')) out.push(e)
  return out
}

const refsOf = (root: string): string[] =>
  (spawnSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: root, encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')

test('① 一趟预备态：零契约 · 零分支 · 真实工作树一个字节不动，而日志里有那两条', async () => {
  const b = await bench()
  try {
    const r = await plan(b, [section(), section({ goal: '把调用方改到新模块上', ownedPaths: ['src/callers'] })], { declare: true })
    assert.equal(r.held, true, `该停在门口：${r.gate.problems.join(' / ')}`)
    assert.equal(r.exit, 'declared', '模型调了 exit_plan_mode，这一趟该记成 declared')
    assert.equal(r.steps, 2, `该走两步（写草案 · 交卷），实际 ${r.steps}`)
    assert.equal(r.gate.draft?.sections.length, 2)

    const evs = await eventsOf(b)
    const names = evs.map((e) => e.t)
    for (const want of ['round/intent', 'round/state', 'holder/distill', 'holder/plan']) {
      assert.ok(names.includes(want as never), `日志里没有 ${want}：${names.join(' · ')}`)
    }
    assert.equal(names.filter((n) => n === 'contract/issue').length, 0, '预备态发契约了')
    // **判出来的那一批已经在手上，而一个字节都没发**（C2 的判据）：停在门口不是"看着像对"，
    // 是那一批契约值已经造得出来且过了预检——只差人那一声放行。
    assert.notEqual(r.gate.built, null, '停在门口却没造出契约集合')
    assert.deepEqual(
      r.gate.built?.contracts.map((c) => c.id),
      ['r1.implement.1', 'r1.implement.2'],
    )
    assert.notEqual(r.gate.precheck, null, '预检没跑')
    assert.deepEqual(r.gate.precheck?.intersections, [], '两格写不同的地方')
    assert.equal(names.filter((n) => n === 'mat/fork').length, 0, '预备态铺物化了')
    assert.equal(names.filter((n) => n === 'ckpt/commit').length, 0, '预备态提交了')

    // **一条分支都没起**：这一趟之后 ref 表与开跑之前逐条相同（`git init` 自己那条 `master` 不算）。
    assert.deepEqual(refsOf(b.root), [...b.refs], '预备态起了分支')
    // **真实工作树一个字节不动**，且草案不住在盘上（它在视图里，跟着事件进日志）。
    assert.equal(JSON.stringify(scanTree(b.root, { skip: WORKSPACE_STATE }).leaves), b.before, '真实工作树被动了')
    assert.equal(existsSync(join(b.root, '.fugue', 'plan', 'r1.md')), false, '"盘上不落第三处"：草案落到真实工作树里了')

    const stateLine = evs.find((e) => e.t === 'round/state' && e.from === 'Idle')
    assert.deepEqual(stateLine, { t: 'round/state', round: ROUND, from: 'Idle', to: 'Planning' }, '该走 Idle → Planning')
    console.log(`① 读数：事件 ${names.join(' · ')}（contract/issue 0 条）· 门后面那一批 ${r.gate.built?.contracts.length} 份已在手上`)
    console.log(`① 读数：refs [${refsOf(b.root).join(' · ')}]（开跑之前也是这 ${b.refs.length} 条）· 真实工作树指纹没动 · 盘上没有 .fugue/plan/`)
  } finally {
    await b.log.close()
    await b.truth.close()
  }
})

test('② 出口三档落到同一个判据：读出来的草案逐字节相同', async () => {
  const sections = [section(), section({ goal: '把调用方改到新模块上', ownedPaths: ['src/callers'] })]
  const want = draftText(sections)
  const got: PlanResult[] = []
  for (const mode of ['declared', 'natural', 'judged'] as const) {
    const b = await bench()
    try {
      const r = await plan(b, sections, mode === 'declared' ? { declare: true } : mode === 'judged' ? { judge: true } : {})
      got.push(r)
      assert.equal(r.exit, mode, `这一趟该记成 ${mode}，实际 ${r.exit}`)
      assert.equal(r.held, true, `${mode} 那一档该停在门口：${r.gate.problems.join(' / ')}`)
      assert.equal(r.draftText, want, `${mode} 那一档读出来的草案与写下去的不是同一份`)
      assert.equal(r.steps, mode === 'judged' ? 0 : 2, `${mode} 那一档的步数不对：${r.steps}`)
      console.log(
        `② 读数：${mode} → exit=${r.exit} · 步 ${r.steps} · 停在门口=${r.held} · ` +
          `草案 ${r.draftText === null ? '（没写出来）' : `${estimateTokensOfText(r.draftText)} token`}`,
      )
    } finally {
      await b.log.close()
      await b.truth.close()
    }
  }
  assert.deepEqual(got.map((r) => r.gate.problems.length), [0, 0, 0], '三档的判据该是同一个')
  assert.deepEqual(got.map((r) => r.gate.draft?.sections.length), [2, 2, 2])
})

test('③ 负对照：缺一个键而模型照样交卷 → 不许放行，报出哪一节哪个键', async () => {
  const b = await bench()
  try {
    const short = { ...section({ goal: '把调用方改到新模块上' }) }
    delete short['ownedPaths']
    const r = await plan(b, [section(), short], { declare: true })
    assert.equal(r.held, false, '草案缺一个键却放行了')
    assert.equal(r.exit, 'declared', '模型确实交了卷——判据不该被这件事改变')
    assert.equal(r.gate.problems.length, 1, `该报一处：${r.gate.problems.join(' / ')}`)
    assert.match(r.gate.problems[0] ?? '', /第 2 节缺一个键：ownedPaths/)
    assert.equal(r.occupancy.length, 0, '草案读不出来就不该印占用（印的是每一节）')
    const names = (await eventsOf(b)).map((e) => e.t)
    assert.equal(names.filter((n) => n === 'contract/issue').length, 0, '不许放行却发了契约')
    console.log(`③ 读数：exit=${r.exit} · 停在门口=false · 报出「${r.gate.problems[0]}」· contract/issue ${names.filter((n) => n === 'contract/issue').length} 条`)
  } finally {
    await b.log.close()
    await b.truth.close()
  }
})

test('④ 每一格的预估占用印得出来；ownedPaths 铺到整棵树那一档变红', async () => {
  const b = await bench()
  try {
    const r = await plan(b, [section()], { declare: true })
    assert.equal(r.occupancy.length, 1, '每一节该有一行占用')
    const one = r.occupancy[0]
    assert.ok(one !== undefined)
    assert.equal(one.sweet, true, `这一格该落在甜点区间：${one.why}`)
    assert.ok(one.headroom > 0)
    assert.ok(one.used + one.handoffMargin <= one.trigger)
    console.log(`④ 读数：第 1 节 used ${one.used} · 触发点 ${one.trigger} · 差额 ${one.headroom} · 甜点=${one.sweet}`)

    // **负对照**：把 `ownedPaths` 铺到整棵树——「文件内容」那一段随之涨到越界。
    // **它自带一份小窗口的声明**：负对照要的是"铺开就该越线"这件事有牙，而真实那份声明的窗口
    // 是 1 000 000——拿它当尺，铺上几十万条路径也未必越线，那条断言就成了恒真的。窗口小是**这
    // 面镜子的一部分**，不是把标准放松。
    // **铺多少条仍由那把尺定**：先量一小片，按 1.5 倍往上撑，撑破"甜点区间"就停手。
    const { sub } = holderOf(b)
    const SMALL: ModelDecl = { ...DECL, contextLimit: 8_000, budget: { trigger: 2_800, handoffMargin: 1_000 } }
    const pathsOf = (n: number): RelPath[] =>
      Array.from({ length: n }, (_, i) => `src/module-${String(i).padStart(4, '0')}/file-${i}.ts` as RelPath)
    const rowsOf = (n: number) =>
      occupancyOf([section({ ownedPaths: pathsOf(n) }) as unknown as DraftSection], {
        decl: SMALL,
        base: sub,
        goal: '把树铺开',
        round: ROUND,
        maxSteps: 8,
        tools: JSON.stringify(CATALOG),
      })
    // 按 1.5 倍往上撑，**撑破"甜点区间"就停手**（由尺判，不由条数判）——条数本身不是判据，
    // 它是"这一份状态"的尺寸；账与上限的关系才是判据。
    let n = 10
    let big = rowsOf(n)[0]
    assert.ok(big !== undefined)
    for (let i = 0; i < 8 && big.sweet; i++) {
      n = Math.ceil(n * 1.5)
      big = rowsOf(n)[0]
      assert.ok(big !== undefined)
    }
    assert.equal(big.sweet, false, `铺到 ${n} 条该越过触发点：${big.why}`)
    console.log(`④ 读数（负对照）：${n} 条路径 → used ${big.used} · 触发点 ${big.trigger} · 甜点=${big.sweet}`)
  } finally {
    await b.log.close()
    await b.truth.close()
  }
})

test('⑤ 持轮者那一格的作用域：那三条回实话、不抛；工具目录与子 agent 逐条相同', async () => {
  // **不给持轮者加工具**：两份协议的工具目录是同一份（架构 § 11 的 Zone A 要与子 agent 逐字节相同）。
  assert.deepEqual([...HOLDER_PROTOCOL.toolCatalog], [...SUBAGENT_PROTOCOL.toolCatalog], '持轮者的工具目录与子 agent 的不是同一份')

  const seen: string[] = []
  const inner: ToolExecutor = {
    async execute(call: ToolCallRequest): Promise<ToolResult> {
      seen.push(call.name)
      return call.name === 'exit_plan_mode' ? { ok: true, halt: true, output: '交了' } : { ok: true, output: '跑了' }
    },
  }
  let declared = 0
  const face = holderFace(inner, { onDeclare: () => (declared += 1) })
  const h = {} as AgentHandle
  for (const name of ['bash', 'run_action', 'checkpoint']) {
    const r = await face.execute({ id: 'c1', name, arguments: '{}' }, h)
    assert.equal(r.ok, false, `${name} 该回一句实话`)
    assert.equal(r.halt, undefined, `${name} 是"这一格没有的东西"，不是交卷`)
  }
  const ok = await face.execute({ id: 'c2', name: 'exit_plan_mode', arguments: '{"plan":"x"}' }, h)
  assert.equal(ok.ok, true)
  assert.equal(declared, 1, 'exit_plan_mode 那一趟没被记下来（declared 那一档就废了）')
  assert.deepEqual(seen, ['exit_plan_mode'], '被拦下的那三条不该进到里面那一层')
  const refused = await face.execute({ id: 'c3', name: 'bash', arguments: '{"command":"ls"}' }, h)
  assert.match(refused.output, /read · glob · grep/, '拒的话要指得出路')
  console.log(`⑤ 读数：bash/run_action/checkpoint 各一句实话 · exit_plan_mode 记下 ${declared} 次 · 工具目录 ${HOLDER_PROTOCOL.toolCatalog.length} 条（与子 agent 同一份）`)
})

test('⑥ 同一轮里再跑一趟：不造第二条 Idle → Planning，意图只写一次', async () => {
  const b = await bench()
  try {
    const first = await plan(b, [section()], { declare: true })
    assert.equal(first.held, true)
    const second = await plan(b, [section()], { judge: true })
    assert.equal(second.exit, 'judged')
    assert.equal(second.held, true, `第二趟该照样判：${second.gate.problems.join(' / ')}`)
    const evs = await eventsOf(b)
    const lands = evs.filter((e) => e.t === 'round/state' && e.from === 'Idle' && e.to === 'Planning')
    assert.equal(lands.length, 1, `${lands.length} 条 Idle → Planning：第二趟把处境当成了 Idle`)
    assert.equal(evs.filter((e) => e.t === 'round/intent').length, 1, '意图写了两遍（纪律 2：写入一次，此后不得改写）')
    console.log(`⑥ 读数：两趟之后 Idle→Planning ${lands.length} 条 · round/intent ${evs.filter((e) => e.t === 'round/intent').length} 条`)
  } finally {
    await b.log.close()
    await b.truth.close()
  }
})
test('⑦ seed 那一段量的是内容：门上的差额与派发那一趟同一个量法', async () => {
  const b = await bench()
  try {
    // 一条在底里（`src-parse.ts`）· 一条不在——**这一份量的是取得到的那一份内容**，而取不到的
    // 那条只算它自己那一行（`round/seed.ts` 的退化档）。两半合起来说明这一栏不是清单长短。
    const CONTENT = '// 底里的解析器\n'
    const seedPaths: readonly RelPath[] = ['src-parse.ts', '这一条不在底上.ts']
    const r = await plan(b, [section({ seed: seedPaths })], { declare: true })
    assert.equal(r.held, true, `该停在门口：${r.gate.problems.join(' / ')}`)
    assert.equal(r.seedRead.from, 'tree')
    assert.equal(r.seedRead.loaded, 1, `该在视图上取到 1 份内容：${JSON.stringify(r.seedRead)}`)
    assert.deepEqual(r.seedRead.missing, ['这一条不在底上.ts'], '不在底上的那一条该被点名')
    const row = r.occupancy[0]
    assert.ok(row !== undefined)
    const pointers = seedTokensOf(seedPaths)
    assert.equal(
      row.seed,
      estimateTokensOfText([seedTextOf(seedPaths), CONTENT].join('\n')),
      '那一栏不是那份正文过尺的读数',
    )
    assert.ok(row.seed > pointers, `seed 那一栏量的还是清单：${row.seed} 与只量清单的 ${pointers}`)
    console.log(
      `⑦ 读数：第 1 节 seed ${row.seed} token（只量清单是 ${pointers}）· 取到内容 1 份 · ` +
        `不在这一棵树上 1 条 · used ${row.used}`,
    )
  } finally {
    await b.log.close()
    await b.truth.close()
  }
})
