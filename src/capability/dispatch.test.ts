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
//      而视图层与真源层那些工具**不落**这两条
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
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
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

function handleOf(state: AssembleState = stateOf()): AgentHandle {
  return {
    agent: AGENT,
    coord: { id: AGENT, branch: 'refs/heads/agent-1', outputPaths: [] },
    branch: 'refs/heads/agent-1' as BranchId,
    contract: 'c-1' as ContractId,
    protocol: SUBAGENT_PROTOCOL,
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
  const { openTruth } = await import('../truth/truth.ts')
  const { loadView } = await import('../view/view.ts')
  const { lowerAt } = await import('../view/lower.ts')
  const { createRoots } = await import('../roots/roots.ts')
  const truth = openTruth(root)
  const view = await loadView(log, AGENT as WriterId, { lower: lowerAt(truth, null) })
  return createToolHost(view, createRoots(root as never), {
    actions: { writer: AGENT as WriterId, log, truth, expectedOld: null },
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
    await strict.execute(call('bash', { command: 'true', cwd: '../../escape' }), h)
    await loose.execute(call('bash', { command: 'true', cwd: '../../escape' }), h)
    // **一对事件两次调用各一对**（`run/start` 是"要起进程"的凭据，被拒的那一趟也走这里），
    // 而**真的起了进程的只有一次**——判据是假宿主的 `runs`。
    const rows = await eventsOf(root)
    const ends = rows.filter((e) => e.t === 'run/end')
    assert.equal(ends.length, 2, `两次调用各一对：${ends.length}`)
    assert.deepEqual(
      ends.map((e) => e.denied),
      [true, false],
      '第一对被拒 · 第二对跑完——拦住第一次的正是表里那一栏',
    )
    assert.equal(strictHost.runs.length, 0, '紧的那一侧一次进程都没起')
    assert.equal(looseHost.runs.length, 1, '松的那一侧真的起了一次——差异就在表里那一栏')
  })
})
