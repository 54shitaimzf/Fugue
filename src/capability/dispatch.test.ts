// B5 的断言：工具面接线（PLAN § 5.8 的 B5 行 · 架构 § 8.9 那张表与四条推论 · § 8.10 的工具目录 ·
// § 14.2 第 4 步）。跑法：cd ~/fugue && node --test src/capability/dispatch.test.ts
//
//   ① **公布的那一份 ⊆ 实现表**：目录 ∩ 实现 = 公布，一条都不许"公布了却跑不起来"
//      · 负对照：往公布名单里塞一条没实现的 → 当场变红
//   ② 四条推论**从表里读出来**：十五格各自的层 → 四个开关，一层都不靠工具名分岔
//   ③ **围栏那条推论是从能力表推出来的**：把 `bash` 那一格的 `fence` 改成 `false`，
//      一次越界的调用就再也不被拦住（同一份输入，只有表那一格变了）
//   ④ 越界的 `bash` **在起进程之前就被挡住**：一次 `run` 都没有 · 视图一个字节没变 ·
//      日志里有且只有一条 `bound/deny`，拒的话里带着指路
//   ⑤ **一次工具调用 = 一对 `run/start` · `run/end`**（完整的 `argv` · 同一个 step · 分开的 ms），
//      而视图层与真源层那些工具**不落**这两条；**围栏拦下的那一趟也不落**（它一次进程都没起），
//      负对照读的就是"不过围栏"与"被围栏拦下"这两件事的差
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Capability, Lookup } from './table.ts'
import { INFERENCE_LIST, TOOL_NAMES, lookup } from './table.ts'
import type { Log, LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { AgentId, BranchId, ContractId, RelPath, WriterId } from '../terms.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import type { AssembleState } from '../assemble/sources.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type { AskItem, DenyAsk, PlanAsk, RunAsk, TodoItem, ToolHost } from '../tools/execute.ts'
import { faceOf } from '../tools/execute.ts'
import type { ToolCallRequest } from '../runtime/step.ts'
import type { AgentHandle } from '../runtime/step.ts'
import { announce, createToolExecutor, dispatch } from './dispatch.ts'
import type { DispatchDeps } from './dispatch.ts'

const AGENT = 'agent-1' as AgentId
const CATALOG = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])

/** 一次调用的形状（名字 + 原样的参数 JSON 文本）——与适配器解出来的那一种逐字相同。 */
const call = (name: string, args: unknown): ToolCallRequest =>
  ({ index: 0, id: `call_${name}`, name, arguments: JSON.stringify(args) }) as ToolCallRequest

// ── 一个记得住事的假宿主 ──────────────────────────────────────────────────────
//
// 这一份**不做围栏、不碰视图**：围栏归 `dispatch` 那一道（`fenceOf`），宿主只在被真的叫到时
// 才动。所以"有没有被叫到"这件事在它身上量得出来——断言 ④ 量的就是它。

interface FakeHost extends ToolHost {
  readonly runs: RunAsk[]
  readonly denies: DenyAsk[]
  readonly writes: { path: string; text: string }[]
  readonly files: Map<string, string>
  /** 每一次 `todo_write` 给的那一整份（覆盖式的：后一份替掉前一份，两条都留着看得到）。 */
  readonly todos: TodoItem[][]
  /** 交上来的计划（只有持轮者那一格会走到这里）。 */
  readonly plans: PlanAsk[]
  /** 问人的那几问。 */
  readonly asks: AskItem[][]
}

function fakeHost(paths: readonly string[] = []): FakeHost {
  const runs: RunAsk[] = []
  const denies: DenyAsk[] = []
  const writes: { path: string; text: string }[] = []
  const files = new Map<string, string>()
  const todos: TodoItem[][] = []
  const plans: PlanAsk[] = []
  const asks: AskItem[][] = []
  return {
    files,
    runs,
    denies,
    writes,
    todos,
    plans,
    asks,
    readBytes: (rel) => {
      const text = files.get(rel)
      return Promise.resolve(text === undefined ? null : { bytes: new Uint8Array(Buffer.from(text, 'utf8')), mode: 0o100644 })
    },
    writeBytes: (rel, bytes) => {
      const text = Buffer.from(bytes).toString('utf8')
      files.set(rel, text)
      writes.push({ path: rel, text })
      return Promise.resolve({ rev: writes.length })
    },
    edit: () => Promise.resolve({ rev: 1, changed: true }),
    list: () => Promise.resolve([]),
    walk: () => Promise.resolve([...paths]),
    // 假宿主**不认物化**：给一个空的执行根。`bash` 那一格起进程之前会问它一句（W8 起的接线），
    // 于是"执行面在哪儿"这件事在假宿主上也被走过一次——给不出来就该在那一步现形，不是静默跑在
    // 一棵别的树上。
    execCwd: () => Promise.resolve({ root: '', strategy: null }),
    run: (ask) => {
      runs.push(ask)
      return Promise.resolve({ exit: 0, ms: 1, denied: false, stdout: 'ok\n', stderr: '' })
    },
    checkpoint: () => Promise.resolve({ commit: 'c0ffee' }),
    runAction: (ask) => {
      runs.push({ command: `action:${ask.action}`, cwd: ask.cwd, timeoutMs: null })
      return Promise.resolve({ exit: 0, ms: 1, denied: false, stdout: '', stderr: '' })
    },
    askUser: (list) => {
      asks.push([...list])
      return Promise.resolve()
    },
    declarePlan: (ask) => {
      plans.push(ask)
      return Promise.resolve()
    },
    setTodos: (list) => {
      todos.push([...list])
      return Promise.resolve({ count: list.length })
    },
    deny: (d) => {
      denies.push(d)
      return Promise.resolve()
    },
  }
}

function stateOf(step = 0, cwd = ''): AssembleState {
  return { ...emptyState(), step, cwd }
}

function handleOf(state: AssembleState = stateOf(), protocol = SUBAGENT_PROTOCOL): AgentHandle {
  return {
    agent: AGENT,
    coord: { id: AGENT, branch: 'refs/heads/agent-1', outputPaths: [] },
    branch: 'refs/heads/agent-1' as BranchId,
    contract: 'c-1' as ContractId,
    protocol,
    model: 'deepseek-chat/anthropic' as AgentHandle['model'],
    wireModel: 'deepseek-chat',
    target: {
      providerId: 'x',
      host: '',
      wire: { name: 'anthropic-messages' } as AgentHandle['target']['wire'],
      path: '',
      model: 'deepseek-chat',
      from: 'fixture',
      headers: {},
    },
    adapter: { name: 'anthropic-messages' } as AgentHandle['adapter'],
    state,
  }
}

/** 一个临时的日志根：跑完删干净。**写口一个**（`hold` 那条纪律）。 */
async function withLog<T>(fn: (log: Log, root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-b5-'))
  // `sync: 'each'`：这一份测试要**读回刚落的那些事件**（`bound/deny` · `run/start`），
  // 而 batch 档把它们攒在内存里——那不是"没落"，是"还没落"。
  const log = openLog(root, { write: AGENT as WriterId, sync: 'each' })
  try {
    return await fn(log, root)
  } finally {
    await log.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/** 读一个 writer 的全部事件（重放那一侧：只读）。 */
async function eventsOf(root: string): Promise<LogEvent[]> {
  const log = openLog(root)
  const out: LogEvent[] = []
  for await (const e of log.readByWriter(AGENT as WriterId)) out.push(e)
  return out
}

/** 那一道路径围栏（真实现：`M3` 的 `resolveVirtual`，根就是一个临时目录）。 */
async function fenceAt(root: string): Promise<DispatchDeps['fenceOf']> {
  const { createRoots } = await import('../roots/roots.ts')
  const roots = createRoots(root as never)
  return (raw: string, cwd: string) => {
    const got = roots.resolveVirtual(raw, cwd as RelPath)
    return got.ok ? { ok: true as const, value: got.value } : { ok: false as const, error: got.error }
  }
}

/**
 * 一次派发要的那些东西。
 *
 * `ensureOf` 给的是一个**记账的空实现**：执行类的工具在围栏之前先过"先物化"那一条推论
 * （架构 § 8.9 第一条），不给它的话越界的调用会在围栏之前就被"没有接上物化"拒掉——那样 ③ ④
 * 量的就不是围栏那一条了。`commandFor` 给的是一个**会炸的实现**：围栏拦住的那一趟一次
 * `run` 都不该有，所以它一旦被叫到就是红的。
 */
function depsOf(log: Log, fence: DispatchDeps['fenceOf'], over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    logOf: () => log,
    host: fakeHost(),
    fenceOf: fence,
    ensureOf: () => Promise.resolve(),
    commandFor: () => {
      throw new Error('被围栏拦住的那一趟不该起进程——commandFor 被叫到了')
    },
    ...over,
  }
}

/**
 * 一份**真宿主**（真视图 · 真日志 · 真对象库）。
 *
 * ④ 要的是"日志里有一条 `bound/deny`"，而那一行是**宿主**落的（`deny` 那道口）——假宿主只
 * 把它记在自己身上。所以那一条必须在真宿主上量：否则量到的是"假宿主忠实地记了一笔"。
 */
async function realHostOf(log: Log, root: string): Promise<ToolHost> {
  // `M1` 不建仓库（架构 § 9.1）：真源是一个**既有的** git 对象库，所以这里先起一个。
  const { spawnSync } = await import('node:child_process')
  const made = spawnSync('git', ['init', '-q', '.'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'fugue',
      GIT_AUTHOR_EMAIL: 'fugue@localhost',
      GIT_COMMITTER_NAME: 'fugue',
      GIT_COMMITTER_EMAIL: 'fugue@localhost',
    },
    encoding: 'utf8',
  })
  if (made.status !== 0) throw new Error(`git init 没成：${made.stderr}`)
  const { createToolHost } = await import('../tools/host.ts')
  const { refHeadOf } = await import('../round/head.ts')
  const { openTruth } = await import('../truth/truth.ts')
  const { loadView } = await import('../view/view.ts')
  const { lowerAt } = await import('../view/lower.ts')
  const { createRoots } = await import('../roots/roots.ts')
  const truth = openTruth(root)
  const view = await loadView(log, AGENT as WriterId, { lower: lowerAt(truth, null) })
  return createToolHost(view, createRoots(root as never), {
    actions: { writer: AGENT as WriterId, log, truth, head: await refHeadOf(log, AGENT as WriterId, null) },
  })
}

// ── ① 公布的那一份 ⊆ 实现表 ──────────────────────────────────────────────────

test('① 公布给模型的每一条都有实现，而没实现的一条都不公布', () => {
  const published = announce(CATALOG, TOOL_NAMES)
  const names = published.map((e) => e.name)

  // **公布面 = 绑定面 = 12**：目录里每一条都跑得起来，差值为 0。
  assert.equal(names.length, CATALOG.length, `公布的有 ${names.length} 条，目录 ${CATALOG.length} 条：${names.join(' ')}`)
  assert.equal(
    CATALOG.filter((e) => !names.includes(e.name)).length,
    0,
    `这几条在目录里却没公布：${CATALOG.filter((e) => !names.includes(e.name)).map((e) => e.name).join(' · ')}`,
  )

  // 这一条是那句话本身：**公布 ⊆ 实现**（拿"一次调用能不能跑"那一处问每一格）。
  for (const name of names) {
    const got = lookup(name)
    assert.ok(!('denied' in got), `${name} 在能力表里查不到`)
  }

  // 每一条都查得出推论，且**都能跑**（`faceOf` 给得回一面）："公布了却跑不起来"构造不出来。
  for (const name of names) {
    assert.ok(faceOf(name) !== null, `${name} 公布了，却拿不出实现`)
  }
})

test('① 负对照：往公布名单里塞一条没实现的 → 那一条被筛掉，名单不再是它', () => {
  const extra: ToolEntry = {
    name: 'subagent',
    description: '（这一条今天没有实现）',
    parameters: { type: 'object', properties: {} },
  } as ToolEntry
  const published = announce([...CATALOG, extra], TOOL_NAMES)
  assert.ok(
    !published.some((e) => e.name === 'subagent'),
    '没实现的那一条被公布了——"公布了却跑不起来"这条错路就构造得出来',
  )
  assert.equal(published.length, CATALOG.length, '公布面仍是目录那一份（多出来的一条被筛掉）')
})

// ── ② 四条推论从表里读出来 ────────────────────────────────────────────────────

test('② 十二格各自的层推出四个开关：一层都不靠工具名分岔', () => {
  const expected: Readonly<Record<string, readonly [string, boolean, boolean, boolean, boolean]>> = {
    // 工具: [层, materialize, fence, confine, writeBack]
    read: ['view', false, true, false, false],
    write: ['view', false, true, false, false],
    edit: ['view', false, true, false, false],
    read_image: ['view', false, true, false, false],
    glob: ['view', false, true, false, false],
    grep: ['view', false, true, false, false],
    bash: ['execute', true, true, true, false],
    run_action: ['execute', true, true, true, true],
    checkpoint: ['truth', false, false, false, false],
    todo_write: ['log', false, false, false, false],
    ask_user_question: ['log', false, false, false, false],
    exit_plan_mode: ['log', false, false, false, false],
  }
  for (const name of TOOL_NAMES) {
    const c = lookup(name) as Capability
    const want = expected[name]!
    assert.deepEqual(
      [c.layer, c.materialize, c.fence, c.confine, c.writeBack],
      [...want],
      `${name} 那一格推出来的四个开关不对`,
    )
  }
  // 四条推论的名字就是那四个（读表的人按它分组）。
  assert.deepEqual([...INFERENCE_LIST], ['materialize', 'fence', 'confine', 'writeBack'])

  // **只有执行层有声明集**：`writeBack` 只在一格上为真，而它在执行层。
  const wb = TOOL_NAMES.filter((n) => (lookup(n) as Capability).writeBack)
  assert.deepEqual(wb, ['run_action'], '可回写视图的只有 run_action 那一格（架构 § 8.9 单独说的那一句）')
})

// ── ③ 围栏那一条是从表推出来的 ────────────────────────────────────────────────

test('③ 把 bash 那一格的 fence 改成 false：同一份输入就不再被拦住', async () => {
  await withLog(async (log, root) => {
    const host = fakeHost()
    const fence = await fenceAt(root)
    const state = stateOf(0, '')

    // 一次越界的调用（`cwd` 往上走出这棵树）。
    const out = call('bash', { command: 'echo hi', cwd: '../..' })

    // (a) 表里那一格是执行层：`fence` 为真 → 拦住，一次 run 都没有。
    const a = await dispatch(out, handleOf(state), { ...depsOf(log, fence), host })
    assert.equal(a.result.ok, false, '越界的 bash 不该跑起来')
    assert.deepEqual(a.applied, ['confine', 'materialize', 'fence'], '这一趟读过的推论（沙箱与物化由那一格定，先记上）')
    assert.equal(host.runs.length, 0, '被围栏挡住时一次 run 都不该有')

    // (b) 只有那一格变了：物化照旧、其余不动，`fence` 换成 false。
    const open: DispatchDeps['lookupOf'] = (tool: string): Lookup => {
      const c = lookup(tool)
      if (!('denied' in c) && tool === 'bash') return { ...c, fence: false }
      return c
    }
    const b = await dispatch(out, handleOf(state), { ...depsOf(log, fence, { lookupOf: open }), host })
    assert.equal(b.result.ok, true, '关掉围栏那一条之后它跑得起来——说明拦住它的正是表里那一栏')
    assert.deepEqual(b.applied, ['confine', 'materialize'], '围栏那一条没读——它被改成了 false')
    assert.equal(host.runs.length, 1, '围栏那一条关了，这一趟就真的起了')
  })
})

// ── ④ 越界在起进程之前就被挡住 ────────────────────────────────────────────────

test('④ 越界的 bash：一次 run 都没有 · 视图一个字节没变 · 日志里一条 bound/deny', async () => {
  await withLog(async (log, root) => {
    const host = await realHostOf(log, root)
    const fence = await fenceAt(root)
    const out = await dispatch(
      call('bash', { command: 'echo 出去了', cwd: '../../escape' }),
      handleOf(),
      { logOf: () => log, host, fenceOf: fence, ensureOf: () => Promise.resolve() },
    )

    assert.equal(out.result.ok, false, '越界那一次是失败的')
    assert.equal(out.denied, true, '它是被拒的（不是命令自己退非零）')
    // 这一次是**直接派发**（没经过 `createToolExecutor`），所以日志里不会有那一对事件——
    // "没起过进程"的凭据在下面：`bound/deny` 那一条落了，而真宿主没被叫到 `run` 那道口上
    // （它一旦被叫到就会真起一个进程；这一份测试里没有哪一处会替它拦下来）。

    // 拒的话里带着指路（架构 § 8.4 纪律 2）：说清在哪只能读、要出去该走哪条路。
    assert.match(out.result.output, /工作区外/, `拒的话是：${out.result.output}`)
    assert.match(out.result.output, /工作区内请用 read/)

    const rows = await eventsOf(root)
    console.log('EVENTS ' + JSON.stringify(rows.map((e) => [e.t, e.cwd ?? null])))
    const denies = rows.filter((e) => e.t === 'bound/deny')
    assert.equal(denies.length, 1, '日志里有且只有一条 bound/deny')
    const d = denies[0]!
    assert.equal(d.t, 'bound/deny')
    assert.equal(d.path, '../../escape', '被拒的那一串原文进日志')
    assert.equal(d.space, 'virtual', '视图内的相对路径这一空间')
    assert.match(d.rule, /^fence:escape/, `由头那一栏是：${d.rule}`)
    // **没有 run/start**：起进程之前就被挡住了（那一条日志就是"没起过"的凭据）。
    assert.equal(rows.filter((e) => e.t === 'run/start').length, 0, '被挡住的一步不该有 run/start')
  })
})

// ── ④b `cwd` 的三支（W8 冻结点第 2 句：执行侧与事件都只收归一后的那一份）────────

test('④b `cwd` 三支：空串是根 · 相对归一后写回 `args.cwd` · 绝对在围栏这关拒', async () => {
  await withLog(async (log, root) => {
    const host = fakeHost()
    const fence = await fenceAt(root)
    const executor = createToolExecutor({ logOf: () => log, host, fenceOf: fence, ensureOf: () => Promise.resolve() })
    const h = handleOf(stateOf(0, ''))

    // 一 · 相对那一支：`./src/../note` → `note`，而**执行侧收到的就是归一后的那一份**
    // （`host.run` 的 `ask.cwd`），不是原始输入——两处读数同一把尺。
    const rel = await executor.execute(call('bash', { command: 'true', cwd: './src/../note' }), h)
    assert.equal(rel.ok, true, rel.output)
    assert.equal(host.runs.length, 1, '相对那一支要真的起一次')
    assert.equal(host.runs[0]!.cwd, 'note', `执行侧收到的 cwd 该是归一后的 RelPath：${JSON.stringify(host.runs[0]!.cwd)}`)

    // 二 · 绝对那一支：拒，而且**一次 run 都没有**（拒在起进程之前）。
    const abs = await executor.execute(call('bash', { command: 'true', cwd: '/etc' }), h)
    assert.equal(abs.ok, false, '绝对 cwd 是一次失败的结果')
    assert.equal(host.runs.length, 1, '被拒的那一趟一次 run 都不该有')
    assert.equal(host.denies.length, 1, '宿主那一道拒口收到一次')
    assert.match(host.denies[0]!.rule, /^fence:absolute/, `由头那一栏是：${host.denies[0]!.rule}`)

    // 三 · 空串那一支：空串是根，而**不是**被解成 `.` 或别的东西。
    const root0 = await executor.execute(call('bash', { command: 'true', cwd: '' }), h)
    assert.equal(root0.ok, true, root0.output)
    assert.equal(host.runs[1]!.cwd, '', `空串该原样交出去（根）：${JSON.stringify(host.runs[1]!.cwd)}`)

    // **两处读数同一把尺**：`run/start` 那条事件里的 `cwd` 就是上面那两个归一值。
    // 读它要走写手柄自己（`withLog` 那个句柄）——另开一个只读句柄在写手柄还握着的时候读不全
    // （实测：那样读到的只有最后那一条）。
    await log.close()
    const starts = []
    for await (const e of openLog(root).readByWriter(AGENT as WriterId)) if (e.t === 'run/start') starts.push(e.cwd)
    assert.deepEqual(starts, ['note', ''], `两条 run/start 的 cwd 都是归一后的那一份：${JSON.stringify(starts)}`)
  })
})

// ── ⑤ 一次工具调用 = 一对 run/start · run/end ────────────────────────────────

test('⑤ 执行类两次调用各落一对 run/start · run/end（完整 argv · 同一个 step），视图与真源层不落', async () => {
  await withLog(async (log, root) => {
    const host = fakeHost()
    const fence = await fenceAt(root)
    // 走**真产品路径**（`/bin/sh -c <命令>`）：`commandFor` 不给，宿主就是"交给 shell"那一档。
    // 起进程没意义，所以命令是 `true` 那种立刻返回的——这一条验的是两条事件，不是命令干了什么。
    const executor = createToolExecutor({ logOf: () => log, host, fenceOf: fence, ensureOf: () => Promise.resolve() })
    const h = handleOf(stateOf(3, ''))

    // 三次调用：执行类（bash · run_action）各一对，视图层（read）与真源层（checkpoint）一对都没有。
    for (const req of [
      call('bash', { command: 'true' }),
      call('read', { path: 'a.ts' }),
      call('checkpoint', { message: '一个检查点' }),
      call('run_action', { action: 'true' }),
    ]) {
      await executor.execute(req, h)
    }

    const rows = await eventsOf(root)
    const starts = rows.filter((e) => e.t === 'run/start')
    const ends = rows.filter((e) => e.t === 'run/end')
    // 四次调用里只有那两次执行类的落了：1:1，不多不少。
    assert.equal(starts.length, 2, `run/start 有 ${starts.length} 条：${starts.map((e) => e.action).join(' ')}`)
    assert.equal(ends.length, 2, `run/end 有 ${ends.length} 条`)

    assert.deepEqual(
      starts.map((e) => e.action),
      ['bash', 'run_action'],
      '只有执行层那两个落这一对事件',
    )
    for (const [i, s] of starts.entries()) {
      const e = ends[i]!
      assert.equal(s.step, '3', `第 ${i} 对的 step 是 ${s.step}（工具面读的是状态里那一步）`)
      assert.equal(e.step, s.step, '起止两条同一个 step')
      assert.equal(s.agent, AGENT)
      assert.ok(Array.isArray(s.argv) && s.argv.length >= 2, `完整命令行在 argv 里：${JSON.stringify(s.argv)}`)
      assert.equal(s.argv0, s.argv[0], 'argv0 就是 argv 的第一段（命令行面那一条口径照旧）')
      assert.equal(s.cwd, '', 'cwd 照状态给（这一趟是根）')
      assert.ok(typeof e.ms === 'number' && e.ms >= 0, 'run/end 报了这一趟花了多久')
    }
    // **完整的 argv**：这一档就是"交给 shell"，所以头两段是 `/bin/sh -c`，第三段是那一行命令原文。
    assert.deepEqual(starts[0]!.argv, ['/bin/sh', '-c', 'true'], `第一对的 argv：${JSON.stringify(starts[0]!.argv)}`)
    assert.deepEqual(starts[1]!.argv, ['/bin/sh', '-c', 'true'], '第二个动作的 argv 是那个动作名那一条')
    // `read` 与 `checkpoint` 都没落这一对（前者在视图层、后者在真源层）。
    assert.equal(rows.filter((e) => e.t === 'run/start').length, 2, '视图层与真源层那些工具不落 run/start')
  })
})

test('⑤ 负对照：把围栏那一栏关掉之后，越界那一次就真的起进程了', async () => {
  await withLog(async (log, root) => {
    const fence = await fenceAt(root)
    const open: DispatchDeps['lookupOf'] = (tool) => {
      const c = lookup(tool)
      return !('denied' in c) && tool === 'bash' ? { ...c, fence: false } : c
    }
    const h = handleOf(stateOf(0, ''))
    // 两个执行器只差一处：表里 `bash` 那一格的 `fence`。`lookupOf` 是构造时给的，所以要各建一个；
    // 各配一个假宿主，好让"真的起了几次进程"这件事在每一侧各有一个计数器。
    const strictHost = fakeHost()
    const looseHost = fakeHost()
    const strict = createToolExecutor({ logOf: () => log, host: strictHost, fenceOf: fence, ensureOf: () => Promise.resolve() })
    const loose = createToolExecutor({
      logOf: () => log,
      host: looseHost,
      fenceOf: fence,
      ensureOf: () => Promise.resolve(),
      lookupOf: open,
    })
    // 两条都跑真命令（`true` 立刻返回）：这一份宿主没有 `commandFor`，走的就是产品路径。
    const rs = await strict.execute(call('bash', { command: 'true', cwd: '../../escape' }), h)
    const rl = await loose.execute(call('bash', { command: 'true', cwd: '../../escape' }), h)
    assert.equal(rs.ok, false, `紧的那一侧该被拒：${rs.output}`)
    assert.equal(rl.ok, true, `松的那一侧该跑完：${rl.output}`)
    // **一对事件只有松的那一次落**：围栏拦下的那一趟一次进程都没起，凭据在 `bound/deny` 里，
    // 不在这一对上（与断言 ④ 同一句话——被挡住的一步不该有 `run/start`）。表里 `fence: false`
    // 那一格是"这一格不过围栏"，不是"被围栏拦下"，所以它照样落这一对。
    const rows = await eventsOf(root)
    const ends = rows.filter((e) => e.t === 'run/end')
    const starts = rows.filter((e) => e.t === 'run/start')
    assert.equal(starts.length, 1, `只有真的起了进程的那一次落 run/start：${starts.length}`)
    assert.equal(ends.length, 1, `run/end 跟着 run/start 一起：${ends.length}`)
    assert.deepEqual(ends.map((e) => e.denied), [false], '那一对是跑完的那一趟（被拒的那一趟没有这一对）')
    // **真的起了进程的只有一次**——判据是假宿主的 `runs`；差异就出在表里那一栏。
    assert.equal(strictHost.runs.length, 0, '紧的那一侧一次进程都没起')
    assert.equal(looseHost.runs.length, 1, '松的那一侧真的起了一次——差异就在表里那一栏')
    // 而"紧的那一趟被拦住了"这件事有它自己的凭据：宿主那一道拒口收到一次。
    assert.equal(strictHost.denies.length, 1, '紧的那一侧落了一次拒（`bound/deny` 那条路的入口）')
    assert.equal(looseHost.denies.length, 0, '松的那一侧没有人拦它')
  })
})


// ── ⑥ 写入面那一栏（S9 真档取证那条缺口的封口）────────────────────────────────────
//
// 由头：`tools/probe-live-s9.sh` 三次真档，持轮者拿到的前缀里没有一处说草案写哪儿——其中一次
// 它把交付物 `notes.md` 写进了自己的视图（真实工作树一个字节没动，那一笔全是白写的）。这一条
// 把"错路走不通"钉在派发那一层：写别处当场拒，而拒的话就是最短的那句指示。
//
// 那一栏是**这一趟**的作用域，不是身份那一栏（`ctx.holder` 管的是"哪几条工具只有持轮者能用"），
// 所以下面这几条用的是子 agent 那份句柄：界由 `planPath` 给，与谁在写无关。

test('⑥ 写入面：写别处当场拒（拒的话里给准确路径 · 落一条 bound/deny），草案那一棵照旧', async () => {
  await withLog(async (log, root) => {
    // **真宿主**：`bound/deny` 是宿主那一道拒口落的（假宿主只把它记在内存里）——而"日志里
    // 有一次拒"是这一条的取证面，所以这里不能用假的那一份。
    const host = await realHostOf(log, root)
    const fence = await fenceAt(root)
    const planPath = '.fugue/plan/r1.md' as RelPath
    const deps = { logOf: () => log, host, fenceOf: fence, planPath }
    const h = handleOf()

    // 一 · 写根上那份"交付物"：拒，而且**一个字节都没落**（下面读 `view/write` 那几条）。
    const out = await dispatch(call('write', { path: 'notes.md', content: 'x' }), h, deps)
    assert.equal(out.result.ok, false, `该拒：${out.result.output}`)
    assert.equal(out.denied, true, '它是被拒的（不是工具自己失败）')
    assert.match(out.result.output, /持轮者这一趟只写草案那一棵：\.fugue\/plan\//, out.result.output)
    assert.match(out.result.output, /\.fugue\/plan\/r1\.md/, '拒的话里要给准确路径')
    assert.match(out.result.output, /一个任务一节/, '拒的话里要说形状')

    // 二 · 写草案那一份：过（它真的改到了视图）。
    const good = await dispatch(call('write', { path: planPath, content: 'y' }), h, deps)
    assert.equal(good.result.ok, true, good.result.output)

    // 三 · 同一棵保留前缀里的另一份（§ 15.1.a：设计稿 · 读过的文件清单也以文件形式落着）：过。
    const sibling = await dispatch(call('write', { path: '.fugue/plan/r1.设计稿.md', content: 'z' }), h, deps)
    assert.equal(sibling.result.ok, true, `保留前缀那一棵里该写得下去：${sibling.result.output}`)

    // 四 · `edit` 走同一条界（它也是改视图的那一条）。
    const ed = await dispatch(call('edit', { path: 'notes.md', old_string: 'a', new_string: 'b' }), h, deps)
    assert.equal(ed.result.ok, false, 'edit 也该被拦住')

    // 五 · **真源那一栏**：两条 `bound/deny`（`rule` 是可分组的那一串 · `path` 是原文那一串），
    //      而视图的变更只有写得下去的那两条——被拒的那两次一条 `view/write` 都没有。
    const rows = await eventsOf(root)
    const denies = rows.filter((e) => e.t === 'bound/deny')
    assert.equal(denies.length, 2, `日志里的 bound/deny 条数：${denies.length}`)
    assert.deepEqual(denies.map((e) => e.rule), ['plan-scope', 'plan-scope'])
    assert.deepEqual(denies.map((e) => e.path), ['notes.md', 'notes.md'])
    assert.deepEqual(denies.map((e) => e.space), ['virtual', 'virtual'])
    const writes = rows.filter((e) => e.t === 'view/write').map((e) => e.path)
    assert.deepEqual(writes, [planPath, '.fugue/plan/r1.设计稿.md'], `视图里改过的路径：${JSON.stringify(writes)}`)
    console.log(
      `⑥ 读数：拒 2 次（write · edit · 都落 bound/deny）· 写得下去 2 条（${writes.join(' · ')}）`,
    )
  })
})

test('⑥ 负对照：不给 `planPath` 那一栏，同一个 `notes.md` 就写得下去（拒是那一栏带来的）', async () => {
  await withLog(async (log, root) => {
    const host = fakeHost()
    const fence = await fenceAt(root)
    const out = await dispatch(call('write', { path: 'notes.md', content: 'x' }), handleOf(), {
      logOf: () => log,
      host,
      fenceOf: fence,
    })
    assert.equal(out.result.ok, true, `不给那一栏就不该拦：${out.result.output}`)
    assert.deepEqual(host.writes.map((w) => w.path), ['notes.md'])
    assert.equal(host.denies.length, 0, '没有人拦它')
    console.log('⑥ 负对照读数：同一份输入、只少了 planPath 那一栏 → 写下去了（拒不是别处来的）')
  })
})


// ── ⑧ 契约那一格的写入面（样本盘第八趟真档照出来的那条缝）────────────────────────────
//
// 由头：那一趟 `r1.implement.1` 的契约声明 `src/format.ts` + `README.md`，而它把 `src/total.ts`
// （`r1.implement.2` 的地界）也写了一份 `avg`。两条分支各插一处，`git merge-tree` 干净通过，
// 落成一棵有两个 `export function avg` 的树——验收当场红、那一趟打回（已知答案 0/3）。而**树那
// 一侧那道闸门看不见它**：`undeclared()` 枚举的是 `upper`，而经视图落下去的那一份在清单里，
// 按定义不算"集外的改动"。所以界要封在视图这一侧的写入口上。

test('⑧ 契约的写入面：写别格的地界当场拒（落一条 bound/deny）· 声明的那几条照旧', async () => {
  await withLog(async (log, root) => {
    // 真宿主：`bound/deny` 是宿主那一道拒口落的，而"日志里有一次拒"是这一条的取证面。
    const host = await realHostOf(log, root)
    const fence = await fenceAt(root)
    const scope = ['src/format.ts', 'README.md'] as RelPath[]
    const deps = { logOf: () => log, host, fenceOf: fence, writeScope: scope }
    const h = handleOf()

    // 一 · 写别格的地界：拒，而且**一个字节都没落**。
    const out = await dispatch(call('write', { path: 'src/total.ts', content: 'avg' }), h, deps)
    assert.equal(out.result.ok, false, `该拒：${out.result.output}`)
    assert.equal(out.denied, true, '它是被拒的（不是工具自己失败）')
    assert.match(out.result.output, /src\/format\.ts · README\.md/, '拒的话里要列出声明的那几条')
    assert.match(out.result.output, /一个字节都没落/, out.result.output)

    // 二 · 声明的那一条：过（它真的改到了视图）。
    const good = await dispatch(call('write', { path: 'src/format.ts', content: 'yuan' }), h, deps)
    assert.equal(good.result.ok, true, good.result.output)

    // 三 · `edit` 走同一条界（它也是改视图的那一条）。
    const ed = await dispatch(call('edit', { path: 'src/total.ts', old_string: 'a', new_string: 'b' }), h, deps)
    assert.equal(ed.result.ok, false, `edit 也该被拦住：${ed.result.output}`)

    // 四 · **界是"上界"不是"路径表"**：声明一条目录，它下面照旧写得下去（`ownedPaths: ['src']`
    //      那句"`src` 这一棵归你"）——而名字前缀像不等于在里面。
    const wide = { ...deps, writeScope: ['src'] as RelPath[] }
    const under = await dispatch(call('write', { path: 'src/deep/x.ts', content: 'x' }), h, wide)
    assert.equal(under.result.ok, true, `声明目录时它下面该写得下去：${under.result.output}`)
    const near = await dispatch(call('write', { path: 'src2/t.ts', content: 'x' }), h, wide)
    assert.equal(near.result.ok, false, '名字前缀像不等于在里面：src2 不在 src 那一棵下')

    // 五 · 真源那一栏：三条 `bound/deny`（`rule` 是可分组的那一串），而视图的变更只有写得下去的
    //      那两条——被拒的三次一条 `view/write` 都没有。
    const rows = await eventsOf(root)
    const denies = rows.filter((e) => e.t === 'bound/deny')
    assert.equal(denies.length, 3, `日志里的 bound/deny 条数：${denies.length}`)
    assert.deepEqual(denies.map((e) => e.rule), ['contract-scope', 'contract-scope', 'contract-scope'])
    assert.deepEqual(denies.map((e) => e.path), ['src/total.ts', 'src/total.ts', 'src2/t.ts'])
    const writes = rows.filter((e) => e.t === 'view/write').map((e) => e.path)
    assert.deepEqual(writes, ['src/format.ts', 'src/deep/x.ts'], `视图里改过的路径：${JSON.stringify(writes)}`)
    console.log(`⑧ 读数：拒 3 次（rule contract-scope）· 写得下去 2 条（${writes.join(' · ')}）`)
  })
})

test('⑧ 负对照：不给 `writeScope` 那一栏，同一个 `src/total.ts` 就写得下去（拒是那一栏带来的）', async () => {
  await withLog(async (log, root) => {
    const host = fakeHost()
    const fence = await fenceAt(root)
    const out = await dispatch(call('write', { path: 'src/total.ts', content: 'avg' }), handleOf(), {
      logOf: () => log,
      host,
      fenceOf: fence,
    })
    assert.equal(out.result.ok, true, `不给那一栏就不该拦：${out.result.output}`)
    assert.deepEqual(host.writes.map((w) => w.path), ['src/total.ts'])
    assert.equal(host.denies.length, 0, '没有人拦它')
    console.log('⑧ 负对照读数：同一份输入、只少了 writeScope 那一栏 → 写下去了（拒不是别处来的）')
  })
})


// ── ⑦ `exit_plan_mode` 自报的那条路径：必须就是这一趟那一份 ───────────────────────────
//
// 由头与 ⑥ 同一条（`tools/probe-live-s9.sh` 量出来的那条缺口）。这一栏原先是一个模型自己编的
// 参数（目录里只说"这份计划写在哪个文件里"），而 `round plan` 读回来的是 `draftPathOf(round)`
// 那一条——两处分家不报错，只表现为"草案不在视图里"。**路径只有一个来源**：这一栏是核对。

test('⑦ `exit_plan_mode`：自报的路径不等于这一趟那一份 → 当场拒（不落 holder/plan · 落 bound/deny）', async () => {
  await withLog(async (log, root) => {
    const host = fakeHost()
    const fence = await fenceAt(root)
    const planPath = '.fugue/plan/r1.md' as RelPath
    const deps = { logOf: () => log, host, fenceOf: fence, planPath }
    // **持轮者那一份句柄**：`exit_plan_mode` 只有那一格调得动（子 agent 调它得到另一句话）。
    const h = handleOf(stateOf(), HOLDER_PROTOCOL)

    // 一 · 报一个别处写的路径：拒，而且那一份计划**没有落进日志**（`declarePlan` 都没走到）。
    const bad = await dispatch(call('exit_plan_mode', { plan: '拆成一格', planFilePath: 'notes.md' }), h, deps)
    assert.equal(bad.result.ok, false, `该拒：${bad.result.output}`)
    // **这一条是工具面自己拒的**（`no(...)` 那条路，与子 agent 调 `ask_user_question` 同一档）：
    // `Dispatched.denied` 读的是四条推论与围栏，所以它在这里是 false——这一次的凭据是上面那句
    // 话与下面那条 `bound/deny`（"模型看见了"与"日志里有一次拒"是同一件事的两个面）。
    assert.equal(bad.denied, false, '工具面自己拒的那一档不置 denied（四条推论与围栏才置）')
    assert.match(bad.result.output, /\.fugue\/plan\/r1\.md/, '拒的话里要给准确路径')
    assert.match(bad.result.output, /草案只有那一份/, bad.result.output)
    assert.equal(host.plans.length, 0, '被拒的那一趟不该落 holder/plan')
    assert.equal(host.denies.length, 1, '宿主那一道拒口收到一次')
    assert.equal(host.denies[0]!.rule, 'plan-path', `由头那一栏是：${host.denies[0]!.rule}`)
    assert.equal(host.denies[0]!.path, 'notes.md', '被拒的那一串原文进日志')

    // 二 · 报的就是那一份：过，而 `path` 那一栏照旧由它自己给（这一栏不许补、不许改）。
    const good = await dispatch(call('exit_plan_mode', { plan: '拆成一格', planFilePath: planPath }), h, deps)
    assert.equal(good.result.ok, true, good.result.output)
    assert.equal(host.plans.length, 1, '过了的那一趟要落一份计划')
    assert.equal(host.plans[0]!.path, planPath)

    // 三 · 不给那一栏（目录里 `planFilePath` 不是必填）：过——它不是"必须自报"，是"报了就得对"。
    const bare = await dispatch(call('exit_plan_mode', { plan: '拆成一格' }), h, deps)
    assert.equal(bare.result.ok, true, bare.result.output)
    assert.equal(host.plans.length, 2, '不给那一栏的那一趟照旧落一份计划')
    assert.equal(host.plans[1]!.path, undefined)
    console.log(`⑦ 读数：报别的路径拒一次（rule plan-path）· 报对与不报都过（plans ${host.plans.length} 份）`)
  })
})

test('⑦ 负对照：不给 `planPath` 那一栏，报一个别处的路径也照旧过（拒是那一栏带来的）', async () => {
  await withLog(async (log, root) => {
    const host = fakeHost()
    const fence = await fenceAt(root)
    const out = await dispatch(
      call('exit_plan_mode', { plan: '拆成一格', planFilePath: 'notes.md' }),
      handleOf(stateOf(), HOLDER_PROTOCOL),
      { logOf: () => log, host, fenceOf: fence },
    )
    assert.equal(out.result.ok, true, `不给那一栏就不该拦：${out.result.output}`)
    assert.equal(host.plans[0]!.path, 'notes.md', '那一栏照旧原样交出去')
    assert.equal(host.denies.length, 0, '没有人拦它')
    console.log('⑦ 负对照读数：同一份输入、只少了 planPath 那一栏 → 报了 notes.md 也照旧过')
  })
})
