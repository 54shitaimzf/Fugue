// W8 的断言：格内一致性——回写 · 删除 · 声明集是边界 · 双向同步（PLAN § 5.15 的 W8 行 · 架构 § 8.7）。
// 跑法：cd ~/fugue && node --test src/tools/w8.test.ts
//
//   ① **同格内 `write` 之后 `bash cat` 当场见到同一份字节**：回执里就是那一份（逐字节）
//   ③ **删除回写**：声明集内的文件与目录里的文件用 `bash rm` 删掉之后，收尾提交里**没有它们**
//      （两个源：base 里在 · 视图里动过）
//   ⑤ **声明集是边界**：集外的写进不了视图、进不了提交，只落 `mat/reclaim`
//   ⑥ **rev 没变时第二次 `ensure` 是空操作**：两条 `bash` 之间视图一个字节没动，第二条的
//      `mat/sync` 该是 `from === to`（不重复落）
//   ⑧ **双向同步 · `bash` 后写的赢**：`write p` → `bash` 改 p → 收尾提交里是 `bash` 那一版
//   ⑨ **双向同步 · `write` 后写的赢**：`bash` 改 p → `write p` → 收尾提交里是 `write` 那一版
//   ⑩ **`ensure` 前那次 `collect` 不是兜底变正常通道**：正常链路上它是空的（一条 spurious 的
//      `mat/reclaim` 都没有）。**另一半（人为造一条漏 collect 的路径做负对照）今天没有那道缝**
//      ——理由写在 ⑩ 那一条测试上面的那段注释里，不在这里重复
//
// 板子与 `round/driver.test.ts` 同一套（真 git 仓库 · 真日志 · 真视图 · 真 fork）；模型是脚本化的，不联网。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { createRoots } from '../roots/roots.ts'
import { matParts } from '../roots/paths.ts'
import { clearMaterialization, removeTree } from '../materialize/mount.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import type { AssembleState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import { modelDeclOf } from '../model/contract.ts'
import type { ModelEvent } from '../model/contract.ts'
import { scriptedModel } from '../runtime/step.ts'
import type { CallModel } from '../runtime/step.ts'
import { CATALOG_STATES, catalog } from './catalog.ts'
import { entriesOf } from '../merge/accept.ts'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, WriterId } from '../terms.ts'
import { realDriver } from '../round/driver.ts'
import { runRound } from '../round/execute.ts'
import type { RoundRunDeps } from '../round/execute.ts'

const AGENT = 'agent-1' as AgentId
const DECL = modelDeclOf('deepseek-chat/anthropic')
const CATALOG = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])

/** 测试自己起 git 时用同一套隔离：用户级配置不该决定测试的读数。 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

interface Bench {
  readonly root: string
  readonly log: LogHandle
  readonly truth: ReturnType<typeof openTruth>
  readonly base: CommitId
  readonly keep: (l: LogHandle) => void
  readonly close: () => Promise<void>
}

/**
 * 一份台子：一个真对象库 · 一个底（轮次要有 HEAD）· 持轮者那份日志。
 *
 * 底走 git 自己落：物化的底**就是工作树**（架构 § 8.4），所以「底」与「盘上」必须是同一份内容。
 * 盘上四样一起进底那个提交：`notes/` 也要在里面，否则模型删它时漂移检会拦下（那一拦是对的）。
 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-w8-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const truth = openTruth(root)
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  writeFileSync(join(root, 'README.md'), '底\n')
  writeFileSync(join(root, 'a.ts'), '（底）a.ts\n')
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'notes', 'keep.md'), '底：keep\n')
  writeFileSync(join(root, 'notes', 'gone.md'), '底：gone\n')
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const made = spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  assert.equal(base.length, 40, `读不出底那个提交：${base}`)
  await truth.advance('refs/heads/agent-1' as never, base, null)
  await truth.advance('refs/heads/main' as never, base, null)
  const extra: LogHandle[] = []
  return {
    root,
    log,
    truth,
    base,
    keep: (l) => extra.push(l),
    close: async () => {
      // 用产品那一份收尾（`clearMaterialization` · `removeTree`）：卸载之后内核在 `tmp/work/` 里
      // 留了一个 `root:root 000` 的 `work/work`，`fs.rmSync` 会先 `readdir` 而在它上面吃 `EACCES`。
      await log.close()
      for (const l of extra) await l.close().catch(() => undefined)
      await truth.close()
      clearMaterialization(
        matParts(root as never, AGENT).merged,
        (['agent-1'] as AgentId[]).flatMap((a) => {
          const p = matParts(root as never, a)
          return [p.upper, p.merged, p.temp]
        }),
      )
      removeTree(root as never)
    },
  }
}

/** 读出这一格落下的全部事件（持轮者那一份与这一格自己那一份）。 */
async function eventsOf(root: string): Promise<LogEvent[]> {
  const log = openLog(root)
  const got: LogEvent[] = []
  for (const w of ['round', 'agent-1'] as WriterId[]) {
    for await (const e of log.readByWriter(w)) got.push(e)
  }
  return got
}

/** 一个提交里的文件（相对根的路径，排序）——走产品自己那一份（`entriesOf`），不调 git。 */
async function commitFiles(b: Bench, commit: string): Promise<string[]> {
  const all = await entriesOf(b.truth, commit as never)
  return all.map((e) => e.name).sort()
}

/** 一个提交里某一条路径的字节（走 `Truth` 那两条读）。 */
async function commitBytes(b: Bench, commit: string, rel: string): Promise<string> {
  const segs = rel.split('/')
  let dir = ''
  for (const [i, seg] of segs.entries()) {
    const rows = await b.truth.listAt(commit as never, dir as never)
    const hit = rows.find((r) => r.name === seg)
    if (hit === undefined) throw new Error(`${commit} 里没有 ${rel}`)
    if (i === segs.length - 1) return Buffer.from((await b.truth.getBlob(hit.id as never)) ?? new Uint8Array()).toString('utf8')
    dir = dir === '' ? seg : `${dir}/${seg}`
  }
  throw new Error('走到了不可能的一条')
}

/** 一个 agent 一个日志口（同一份日志被轮次那一步与驱动那一步各要一次）。 */
function depsOf(b: Bench, call: CallModel, owned: readonly string[] = ['a.ts']): RoundRunDeps {
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
    closeAgentLogs: async () => undefined,
    round: 'r1' as never,
    intent: { goal: '把一件事做完' },
    split: [
      {
        goal: '写一份 a.ts',
        ownedPaths: owned as readonly RelPath[],
        deliverables: [{ path: 'a.ts' as RelPath, form: '一份文件' }],
        assertions: [{ name: '总是过', action: 'ok' }],
      },
    ],
    identityFor: () => ({ agent: AGENT, branch: `refs/heads/${AGENT}` as BranchId }),
    seeds: [] as readonly (readonly RelPath[])[],
    stub: realDriver({}),
    driver: {
      state: (agent: AgentId) => stateOf(agent),
      handle: (agent: AgentId, state: AssembleState) => handleOf(agent, state),
      decl: DECL,
      call,
      tools: CATALOG,
    },
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

function stateOf(agent: AgentId): AssembleState {
  const base = { ...emptyState(), ...fixtureState(0), step: 0, cwd: '' }
  return {
    ...base,
    goal: `把「${agent}」那一格做完。`,
    task: { ...(base.task as NonNullable<AssembleState['task']>), goal: `把「${agent}」那一格做完。` },
  }
}

function handleOf(agent: AgentId, state: AssembleState): ReturnType<NonNullable<RoundRunDeps['driver']>['handle']> {
  return {
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
  } as never
}

/** 一条工具调用（三段），按 `--live` 下适配器解出的那种形状。 */
function callOne(index: number, id: string, name: string, args: unknown): ModelEvent[] {
  const text = JSON.stringify(args)
  return [
    { t: 'tool-start', index, id, name },
    { t: 'tool-delta', index, args: text },
    { t: 'tool-call', index, id, name, arguments: text },
  ]
}

const USAGE = { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64, rawStop: null, model: null }

/** 说完了（`end-turn` 那一条）：脚本用完之后一直用它。 */
const DONE: readonly ModelEvent[] = [
  { t: 'delta', text: '干完了。' },
  { t: 'usage', usage: USAGE },
  { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
]

/** 一步：调一条工具。 */
const oneCall = (name: string, args: unknown): readonly ModelEvent[] => [
  ...callOne(0, `c_${name}`, name, args),
  { t: 'usage', usage: USAGE },
  { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
]

// ── ③ 删除回写 · 声明集是边界 ─────────────────────

test('③ 同格内 `bash rm`：声明集内的文件删得掉；声明集外的写不进提交，只落一条 `mat/reclaim`', async () => {
  const b = await bench()
  try {
    // 一步里几件事：删两条声明过的、删一棵声明过的子树、往声明集内写一条、往声明集外写一条。
    const scripts: readonly (readonly ModelEvent[])[] = [
      oneCall('bash', {
        command:
          '/bin/rm -f notes/keep.md; /bin/rm -f notes/gone.md; /bin/mkdir -p notes/deep; /bin/echo 深 > notes/deep/x.txt; /bin/rm -rf notes/deep; /bin/mkdir -p scope; /bin/echo 回写的 > scope/ok.txt; /bin/echo 声明外 > r1.txt',
      }),
      DONE,
    ]
    // 声明面 = 契约的 `ownedPaths`（W8 冻结点第 4 句）。漂移检这一趟关掉，写在明面上：模型删的是
    // 盘上真有的那两条（这正是要量的事），于是工作树与「底」在那两条上不一致，漂移检当场把它拦下
    // ——它拦的是「夹具自己把盘改了」，不是 W8 要看的那件事。
    const run = await runRound({
      ...depsOf(b, scriptedModel(scripts), ['a.ts', 'notes/keep.md', 'notes/gone.md', 'scope']),
      checkDrift: false,
    })
    assert.equal(run.report.ok, true, '验收该过（唯一的判决）')
    const commit = run.advanced !== null ? String(run.advanced.commit) : ''
    assert.equal(commit.length, 40, `真工作树该被推进，而那个提交号是：${commit}`)

    // 声明集内删掉的那几条都不在收尾提交里。
    const files = await commitFiles(b, commit)
    assert.equal(files.includes('notes/keep.md'), false, `删掉的单文件不该在提交里：${files.join(' ')}`)
    assert.equal(files.includes('notes/gone.md'), false, `两个源跟同一条路径也删得掉：${files.join(' ')}`)
    assert.equal(files.includes('notes/deep/x.txt'), false, `删掉目录里的叶子也不该在：${files.join(' ')}`)
    // 声明集内写的那一条收回来了（反向通道的正常那一半）。
    assert.ok(files.includes('scope/ok.txt'), `声明集内的新写该进来：${files.join(' ')}`)
    // 声明集外的写一条都不进（D7 的边界）。
    assert.equal(files.includes('r1.txt'), false, `声明集外的写不该进提交：${files.join(' ')}`)

    // 越声明的改动落 `mat/reclaim`：每一次执行之后各一条（那一条东西还在树里，它不进视图也就不被清理）。
    const rows = await eventsOf(b.root)
    const reclaims = rows.filter((e) => e.t === 'mat/reclaim')
    assert.ok(reclaims.length >= 1, `越声明的改动该落 mat/reclaim，实际 ${reclaims.length} 条`)
    for (const e of reclaims) {
      const r = e as Extract<LogEvent, { t: 'mat/reclaim' }>
      assert.deepEqual([...r.changed], ['r1.txt'], `越界的那一条：${JSON.stringify(r.changed)}`)
    }
  } finally {
    await b.close()
  }
})

// ── ⑧ 双向同步 · 后写的赢 ─────────────────────

test('⑧ `write` 之后 `bash` 改同一份：收尾提交里是 `bash` 那一版', async () => {
  const b = await bench()
  try {
    const scripts: readonly (readonly ModelEvent[])[] = [
      oneCall('write', { path: 'notes/keep.md', content: 'view 版\n' }),
      oneCall('bash', { command: '/bin/echo bash 版 > notes/keep.md' }),
      DONE,
    ]
    // 声明面 = 契约的 `ownedPaths`（W8 冻结点第 4 句）。漂移检同上一条理由关掉。
    const run = await runRound({
      ...depsOf(b, scriptedModel(scripts), ['a.ts', 'notes']),
      checkDrift: false,
    })
    assert.equal(run.report.ok, true, `验收该过：${JSON.stringify(run.report)}`)
    const commit = run.advanced !== null ? String(run.advanced.commit) : ''
    assert.equal(commit.length, 40, `真工作树该被推进，而那个提交号是：${commit}`)
    // 收尾提交里是 `bash` 那一版（不是先前 `write` 的那一版）——`collect` 把它收回了读面。
    assert.equal(await commitBytes(b, commit, 'notes/keep.md'), 'bash 版\n', '后写的那一版就是提交里的那一版')
  } finally {
    await b.close()
  }
})

// ── ⑥ rev 没变 → 第二次 `ensure` 是空操作 ─────────────────────

test('⑥ 视图 rev 没变 → 第二条 `bash` 的那一次 `ensure` 不落 `mat/sync`（noop 就是"不重复落"）', async () => {
  const b = await bench()
  try {
    // 前两条命令都**只读**（`cat`）：视图在它们之间一个字节没动。第三条 `write` 是正对照——
    // 视图动了，那之后必须**真的**落一条 `mat/sync`（否则"零条"这个读数可以被"压根不落"冒充）。
    const scripts: readonly (readonly ModelEvent[])[] = [
      oneCall('bash', { command: '/bin/cat README.md' }),
      oneCall('bash', { command: '/bin/cat a.ts' }),
      oneCall('write', { path: 'a.ts', content: '（模型写的）a.ts\n' }),
      oneCall('bash', { command: '/bin/cat a.ts' }),
      DONE,
    ]
    const run = await runRound({ ...depsOf(b, scriptedModel(scripts)), checkDrift: false })
    assert.equal(run.report.ok, true, `验收该过：${JSON.stringify(run.report)}`)

    const rows = await eventsOf(b.root)
    const syncs = rows.filter((e) => e.t === 'mat/sync') as Extract<LogEvent, { t: 'mat/sync' }>[]
    const forks = rows.filter((e) => e.t === 'mat/fork')
    // 这一格第一次要跑子进程时 fork 一次，之后 rev 有变才再同步：三条 `bash` 里只有最后一条
    // （前面那次 `write` 改了视图）该落 `mat/sync`——前两条之间视图没动，那两次 `ensure` 是空操作。
    assert.equal(forks.length, 1, `这一格只该 fork 一次，实际 ${forks.length} 条 mat/fork`)
    assert.equal(syncs.length, 1, `视图只动过一次，所以只该落一条 mat/sync，实际 ${syncs.length} 条`)
    const only = syncs[0]!
    // 那一条落的正是 `write` 推出来的那个修订点（`from < to`：真的落了东西）。
    assert.ok(only.from < only.to, `那一条该真的落了东西（from=${only.from} to=${only.to}）`)
    assert.ok([...only.paths].includes('a.ts'), `清单里该有 a.ts：${JSON.stringify(only.paths)}`)
    // 三条命令各自都跑到了（不是"一条都没跑"被当成没问题）。
    const starts = rows.filter((e) => e.t === 'run/start')
    assert.equal(starts.length, 3, `三条 bash 各落一条 run/start，实际 ${starts.length} 条`)
  } finally {
    await b.close()
  }
})

// ── ⑨ 双向同步 · `write` 后写的赢 ─────────────────────

test('⑨ `bash` 改过之后 `write` 同一份：收尾提交里是 `write` 那一版', async () => {
  const b = await bench()
  try {
    const scripts: readonly (readonly ModelEvent[])[] = [
      oneCall('bash', { command: '/bin/echo bash 版 > notes/keep.md' }),
      oneCall('write', { path: 'notes/keep.md', content: 'view 版\n' }),
      DONE,
    ]
    // 声明面 = 契约的 `ownedPaths`；漂移检同上一条理由关掉。
    const run = await runRound({
      ...depsOf(b, scriptedModel(scripts), ['a.ts', 'notes']),
      checkDrift: false,
    })
    assert.equal(run.report.ok, true, `验收该过：${JSON.stringify(run.report)}`)
    const commit = run.advanced !== null ? String(run.advanced.commit) : ''
    assert.equal(commit.length, 40, `真工作树该被推进，而那个提交号是：${commit}`)
    // 收尾提交里是 `write` 那一版——时间上最后的那个写者赢，而 `bash` 那一版被它盖掉。
    assert.equal(await commitBytes(b, commit, 'notes/keep.md'), 'view 版\n', '最后写的那一版就是提交里的那一版')
  } finally {
    await b.close()
  }
})

// ── ① `bash cat` 当场见到 `write` 的字节（回执逐字节）· ⑩ 的读法说明 ─────────────────────

test('① 同格内 `write` 之后 `bash cat`：回执里就是那一份字节（逐字节）', async () => {
  const b = await bench()
  try {
    const bytes = '（模型写的）这一行就是要看到的那一份\n'
    const scripts: readonly (readonly ModelEvent[])[] = [
      oneCall('write', { path: 'notes/keep.md', content: bytes }),
      oneCall('bash', { command: '/bin/cat notes/keep.md' }),
      DONE,
    ]
    // 一次跑到底：`write` 进视图 → `execCwd()` 把它铺到物化树 → `bash` 在新进程里读同一棵树。
    // 判据落在**回执**上（模型真看见的那串字节），不落在"我们说它铺过去了"。
    const run = await runRound({ ...depsOf(b, scriptedModel(scripts), ['a.ts', 'notes']), checkDrift: false })
    assert.equal(run.report.ok, true, `验收该过：${JSON.stringify(run.report)}`)

    const rows = await eventsOf(b.root)
    const ends = rows.filter((e) => e.t === 'run/end') as Extract<LogEvent, { t: 'run/end' }>[]
    assert.equal(ends.length, 1, `这一格只起过一次进程，实际 ${ends.length} 条 run/end`)
    assert.equal(ends[0]!.exit, 0, '`cat` 该读成（读不到才是非零：`No such file or directory`）')
    assert.equal(ends[0]!.denied, false, '这一趟不是被拒的')
    // **回执本身**：`view/write` 落的是模型写的那一份，而 `bash` 改过视图没有——这一格里
    // `bash` 只读。两次写事件都是那一份字节（模型那一次 + collect 那一次）。
    const writes = rows.filter((e) => e.t === 'view/write') as Extract<LogEvent, { t: 'view/write' }>[]
    assert.ok(writes.length >= 1, '这一份字节该经视图那条路落下来')
    assert.deepEqual([...new Set(writes.map((e) => e.path))], ['notes/keep.md'], '落的路径就是那一条')
    // 收尾提交里也是它（没有别的写者改过它）。
    const commit = run.advanced !== null ? String(run.advanced.commit) : ''
    assert.equal(commit.length, 40, `真工作树该被推进，而那个提交号是：${commit}`)
    assert.equal(await commitBytes(b, commit, 'notes/keep.md'), bytes, '提交里就是那一份字节')
  } finally {
    await b.close()
  }
})

/**
 * **⑩ 只兑现了一半，另一半如实记在这里**（不是"没做"，是"今天的缝够不着"）。
 *
 * 兑现的那一半：`ensure` 前那次 `collect` 在正常链路上恒为空——它由 `execCwd()` → `syncTo()`
 * 那一趟跑，而 `afterRun()` 每次执行完都收过一遍，所以那一次没有东西可收。读数就是"正常链路上
 * 一条 spurious 的 `mat/reclaim` 都没有"（③ 与 ⑥ 两条测试里各自量得到）。
 *
 * 够不着的那一半：要人为造一条"执行后漏 collect"的路径（负对照），得让某一条执行路径**跳过**
 * `afterRun()` 第三步的 `collect`。今天没有那道缝：
 *   · 从外面写 `upper` 不行——`overlayfs` 那一档的写侧只有挂载着的进程能看到，宿主这一侧写
 *     进去的字节随后被挂载/卸载吃掉（实测：写完之后 `readdirSync(upper)` 里没有它，而
 *     `undeclared()` 枚举 `upper` 得到的是空集）；
 *   · 写 `merged`（挂载点）也不行——同上，`ensure` 一挂一卸就没了；
 *   · 给产品加一个测试专用的开关（"跳过第三步的 collect"）不行——那是在产品面上多一道只有测试
 *     会用的缝，与"任何单元都不许让地板变低"同一类问题。
 * 所以这一条负对照要等一个真能造出那条路径的接缝（或者等整链测试那一档从外面注入一次执行）。
 */
// ── ⑪ 同格内先 `write` 后 `bash rm`：那一条删除要活到收尾提交 ─────────

/**
 * **这一条是 W8 判据 ④ 漏掉的那一档，也是这一块改动的由头。**
 *
 * ③ 量的是"`bash rm` 一条底里就有的文件"，⑥ 量的是"视图没动就不重复落"，① 量的是"`write`
 * 之后 `bash cat` 读得到"。三条都过，而**同一格里先 `write p` 再 `bash rm p`** 照样可以是错的：
 * `write` 推出来的那份 delta 在 `bash` 之前的那一次 `ensure` 里被铺到树上，而那时算 delta 的
 * 基点取错了（拿了"这一格历史上写过几次"那个号），于是同一条 delta **又落了一遍**——`rm` 留下
 * 的白洞被它覆盖，回写报不出删除，收尾提交把模型已经删掉的那一份又交上去。**静默错**：不报错、
 * 验收照过、提交里是错的。
 *
 * **写的必须是一条底里没有的新路径**：改一条底里就有的文件（`a.ts`）走的是 `modify`，那一档
 * 删除回得来（实测 HEAD 上就过）；`add` 那一档才是"重新铺一遍"发生的形状。
 *
 * 判据落在**收尾提交的那一份**上（唯一能看到它的地方）：`p` 不在里面、而 `README.md` 还在
 * （否则"什么都没提交"也能让前一条断言过）。
 */
test('⑪ 同格内先 `write` 后 `bash rm` 同一路径（新文件那一档）：收尾提交里没有它', async () => {
  const b = await bench()
  try {
    const scripts: readonly (readonly ModelEvent[])[] = [
      oneCall('write', { path: 'fresh.txt', content: '先写这一份，随后把它删掉\n' }),
      oneCall('bash', { command: '/bin/rm -f fresh.txt' }),
      DONE,
    ]
    const run = await runRound({ ...depsOf(b, scriptedModel(scripts), ['a.ts', 'fresh.txt']), checkDrift: false })
    assert.equal(run.report.ok, true, `验收该过：${JSON.stringify(run.report)}`)
    const commit = run.advanced !== null ? String(run.advanced.commit) : ''
    assert.equal(commit.length, 40, `真工作树该被推进，而那个提交号是：${commit}`)
    const files = await commitFiles(b, commit)
    assert.equal(files.includes('fresh.txt'), false, `模型删掉的那一份不该在提交里：${files.join(' ')}`)
    assert.equal(files.includes('README.md'), true, `底里那一份要还在（否则"空提交"也过）：${files.join(' ')}`)
    // 而 `bash rm` 真跑到了（不是"一条都没起进程"被当成"删成功"）。
    const rows = await eventsOf(b.root)
    assert.equal(rows.filter((e) => e.t === 'run/start').length, 1, '那一条 rm 该起过一次进程')
  } finally {
    await b.close()
  }
})

test('⑩ 正常链路上 `ensure` 前那次 `collect` 是空的（一条 spurious 的 `mat/reclaim` 都没有）', async () => {
  const b = await bench()
  try {
    // 两条命令都只读：既不改视图（⑥ 量过），也不落 `mat/reclaim`（这一条量它）。
    // 若那一次 collect 会"顺手报一条"，两趟之后这里就会多出两条。
    const scripts: readonly (readonly ModelEvent[])[] = [
      oneCall('bash', { command: '/bin/cat README.md' }),
      oneCall('bash', { command: '/bin/cat a.ts' }),
      DONE,
    ]
    const run = await runRound({ ...depsOf(b, scriptedModel(scripts)), checkDrift: false })
    assert.equal(run.report.ok, true, `验收该过：${JSON.stringify(run.report)}`)
    const rows = await eventsOf(b.root)
    const reclaims = rows.filter((e) => e.t === 'mat/reclaim')
    assert.equal(reclaims.length, 0, `正常链路上不该有 mat/reclaim，实际 ${reclaims.length} 条`)
    // 而两条命令都真跑到了（不是"一条都没起进程"被当成"没东西要收"）。
    assert.equal(rows.filter((e) => e.t === 'run/start').length, 2, '两条 bash 各起过一次')
  } finally {
    await b.close()
  }
})
