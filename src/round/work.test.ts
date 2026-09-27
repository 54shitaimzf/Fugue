// 放行之后接着跑：**从日志把那一批契约读回来，接上同一条尾巴**（`fugue round work`）。
// 出处：架构 § 15.1.a（"派"之后那一环 · 门仍由人开）· 架构 § 8.12（契约住日志里）·
// PLAN § 5.10 的 C4 行 · § 5.11 的判据一句话（放行后真模型跑 · 真产物 · 真断言 · 逐字节一致）。
//
// 跑法：cd ~/fugue && node --test src/round/work.test.ts
//
//   ① **从日志读回那一批**：契约逐条（`id` · `kind` · 写入面）与放行时发出去的那一批相同 ·
//      底是 `round/intent` 里那一个 · 处境 `Working` · 预检与门那一趟同一个函数
//   ② **接着跑**：那一批跑完 → 验收过 → 定格 + 推进 → 工作树里就是那个提交的树
//   ③ **处境不对就拒**，而且每一档都指得出路：`Idle`（先 plan）· `Planning`（先 go）·
//      跑过之后（换轮次号）——**三条都是"拒"，不是静默成功**
//   ④ **已经交过卷的格不重跑**（这一条就是"错误成本"那一栏）：把第一格的分支推到它自己那个
//      提交 → 这一趟只补剩下的那几格（`reused` 报得出是哪一格）；**负对照**：分支还在底上的
//      那一档，那一格照旧要跑
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentId, CommitId, RelPath, RoundId, WriterId } from '../terms.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { createRoots } from '../roots/roots.ts'
import { openTruth } from '../truth/truth.ts'
import { identFor, refFor } from '../identity.ts'
import { declaredSetOf } from '../contract/types.ts'
import type { Contract } from '../contract/types.ts'
import { entriesOf } from '../merge/accept.ts'
import { dispatchRound, roundStateOf } from './dispatch.ts'
import type { AgentDriver } from './driver.ts'
import { runIssued } from './execute.ts'
import type { RunTailDeps } from './execute.ts'
import { RoundWorkError, issuedBatchOf, whyNotWorking } from './work.ts'

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

const A = 'src/parse.ts'
const B2 = 'src/render.ts'
const GOAL = '把解析器与渲染拆开'
const ROUND = 'r1' as RoundId

interface Bench {
  readonly root: string
  readonly log: LogHandle
  readonly truth: ReturnType<typeof openTruth>
  readonly base: CommitId
  readonly close: () => Promise<void>
}

async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-work-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  // **HEAD 要落在 `main` 上**（产品挪的是 `refs/heads/main`：`refFor('round')`）。不设的话 HEAD 跟着
  // 初始分支名走，于是"主线停在定格那个提交上"这条断言会在一个错的 ref 上量（产品没问题，读数错）。
  assert.equal(spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const truth = openTruth(root)
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, A), 'export const parse = (s: string): string => s.trim()\n')
  writeFileSync(join(root, B2), 'export const render = (s: string): string => s\n')
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const made = spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  assert.equal(base.length, 40, `读不出底那个提交：${base}`)
  // **不另 advance 一次**：HEAD 已经在 `main` 上，那一条分支就是刚才那次提交落下的——再 advance
  // 一次是"它必须还不存在"，当场 CAS 输。
  return {
    root,
    log,
    truth,
    base,
    close: async () => {
      await log.close()
      await truth.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 两节的草案（键就是契约的键）：一格写一个文件——写入面不相交才能折得下去。 */
function draftText(): string {
  const one = (goal: string, path: string): Record<string, unknown> => ({
    kind: 'implement',
    goal,
    ownedPaths: [path],
    deliverables: [{ path, form: '模块' }],
    assertions: [{ name: '单元测试全过', action: 'test' }],
    seed: [],
  })
  return [
    '## 一 · 解析器',
    '',
    '为什么这么拆：两格各改一个文件，写入面不相交。',
    '',
    '```json',
    JSON.stringify(one('把解析拆成独立模块', A), null, 2),
    '```',
    '',
    '## 二 · 渲染器',
    '',
    '```json',
    JSON.stringify(one('把渲染拆成独立模块', B2), null, 2),
    '```',
  ].join('\n')
}

/** 把这一轮摆在门口：`round/intent`（钉住的底 + 意图）· `Idle → Planning` · `holder/distill`（草案）。 */
async function atGate(b: Bench, text: string = draftText()): Promise<void> {
  await b.log.append('round', { t: 'round/intent', round: ROUND, base: b.base, digest: 'd'.repeat(16), body: JSON.stringify({ goal: GOAL }) })
  await b.log.append('round', { t: 'round/state', round: ROUND, from: 'Idle', to: 'Planning' })
  await b.log.append('round', { t: 'holder/distill', round: ROUND, agent: 'round' as AgentId, digest: 'e'.repeat(16), body: text })
}

/**
 * 两节**写入面相交**的草案：第一格声明两条（其中一条与第二格重合），第二格声明那一条。
 *
 * 这一档正是要量的那件事——**申报有重叠，而实际没撞车**（夹具那一档只照契约声明的第一条路径写，
 * 于是两格各写各的：`A` 与 `B2`）。第十二趟之前，这种拆分到不了折叠：合并前那一档预检按**申报**
 * 相交当场拒，而格子的钱已经花掉了。
 */
function draftTextCrossing(): string {
  const one = (goal: string, owned: readonly string[]): Record<string, unknown> => ({
    kind: 'implement',
    goal,
    ownedPaths: [...owned],
    deliverables: [{ path: owned[0] as string, form: '模块' }],
    assertions: [{ name: '单元测试全过', action: 'test' }],
    seed: [],
  })
  return [
    '## 一 · 解析器',
    '',
    '为什么这么拆：两格的申报有一条重合（写入面相交——量这一档要的就是它）。',
    '',
    '```json',
    JSON.stringify(one('把解析拆成独立模块', [A, B2]), null, 2),
    '```',
    '',
    '## 二 · 渲染器',
    '',
    '```json',
    JSON.stringify(one('把渲染也拆成独立模块', [B2]), null, 2),
    '```',
  ].join('\n')
}

/** 放行（`round go` 那一半）：契约逐条落 · 两条分支定在同一个底上 · 处境 `Working`。 */
async function go(b: Bench) {
  return await dispatchRound({
    roots: createRoots(b.root as never),
    truth: b.truth,
    log: b.log,
    round: ROUND,
    identityFor: (n: number) => identFor(ROUND, n),
    actions: { test: [] as readonly RelPath[] },
  })
}

/** 一格一个日志口的持有者（与命令面同一套：一个 writer 一个口，跑完一起关）。 */
function logsOf(b: Bench) {
  const made = new Map<AgentId, LogHandle>()
  return {
    logOf: (a: AgentId): LogHandle => {
      const hit = made.get(a)
      if (hit !== undefined) return hit
      const one = openLog(b.root, { write: a as WriterId, sync: 'each' })
      made.set(a, one)
      return one
    },
    close: async (): Promise<void> => {
      for (const [a, l] of made) {
        made.delete(a)
        await l.close()
      }
    },
  }
}

/** 夹具那一档的驱动：给契约声明的第一条路径写一份内容，新树 = 底那棵树 + 这一条。 */
function stubOf(b: Bench, calls: string[]): AgentDriver {
  return async (ask) => {
    calls.push(ask.contract.id as string)
    const where = declaredSetOf(ask.contract)[0] ?? `stub-${ask.contract.id}.txt`
    const blob = await b.truth.putBlob(new TextEncoder().encode(`（夹具）${ask.contract.id} 改了 ${where}\n`))
    const merged = new Map((await entriesOf(b.truth, ask.base)).map((e) => [e.name, e]))
    merged.set(where, { name: where, mode: 0o100644, id: blob })
    return b.truth.commit(await b.truth.putTree([...merged.values()]), [ask.base], `（夹具）${ask.agent}`)
  }
}

/** 尾巴那一段的入参：**除了"这一批从哪儿来"，它与 `round run` 那一份是同一条**。 */
function tailDeps(b: Bench, calls: string[], logs: ReturnType<typeof logsOf>): RunTailDeps {
  return {
    roots: createRoots(b.root as never),
    truth: b.truth,
    log: b.log,
    round: ROUND,
    logOf: logs.logOf,
    stub: stubOf(b, calls),
    specsOf: (c: Contract) =>
      c.kind === 'investigate'
        ? []
        : c.assertions.map((a) => ({
            assertion: a,
            argv: ['/bin/sh', '-c', 'true'],
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' },
          })),
    // 漂移检在 `round run` 那一侧另有一套走查；这一份量的是"接着跑"那一段，所以关掉它。
    checkDrift: false,
  }
}

test('① 从日志读回那一批：契约 · 底 · 处境与放行那一趟逐条对得上', async () => {
  const b = await bench()
  const logs = logsOf(b)
  try {
    await atGate(b)
    const issued = await go(b)
    assert.equal(await roundStateOf(b.log, ROUND), 'Working', '放行之后处境该是 Working')

    const batch = await issuedBatchOf(b.log, ROUND)
    assert.equal(batch.base, b.base, '底该是 round/intent 里那一个')
    assert.deepEqual(
      batch.contracts.map((c) => c.id),
      issued.built.contracts.map((c) => c.id),
      '从日志读回来的契约与放行时发出去的不是同一批',
    )
    assert.deepEqual(
      batch.contracts.map((c) => declaredSetOf(c)),
      issued.built.contracts.map((c) => declaredSetOf(c)),
      '写入面对不上',
    )
    assert.deepEqual(batch.precheck.intersections, [], '两份契约的写入面不相交')
    console.log(
      `① 读数：处境 Working · 契约 ${batch.contracts.length} 份（${batch.contracts.map((c) => c.id).join(' · ')}）· ` +
        `底 ${batch.base.slice(0, 8)} · 预检 ${batch.contracts.reduce((n, c) => n + declaredSetOf(c).length, 0)} 条路径 0 对相交`,
    )
  } finally {
    await logs.close()
    await b.close()
  }
})

test('② 接着跑：那一批跑完 · 验收过 · 定格 + 推进（工作树里就是那个提交的树）', async () => {
  const b = await bench()
  const logs = logsOf(b)
  const calls: string[] = []
  try {
    await atGate(b)
    await go(b)
    const batch = await issuedBatchOf(b.log, ROUND)
    const run = await runIssued(tailDeps(b, calls, logs), batch)

    assert.equal(run.report.ok, true, `验收没过：${JSON.stringify(run.report.results)}`)
    assert.equal(run.report.pass, 2, `两条断言该都过：${JSON.stringify(run.report.results)}`)
    assert.equal(run.reused.length, 0, '这一趟是新跑的，一份都不该被复用')
    assert.equal(calls.length, batch.contracts.length, '每一格都该跑一次')
    assert.notEqual(run.advanced, null, '通过之后该推进真实工作树')
    assert.equal(run.state, 'Rebuilding', '通过那一档的终点是 Rebuilding（Committed ──advanced──> Rebuilding）')

    // **工作树里就是那个提交的树**：那一格写下的文件在盘上，内容与夹具那一份相同。
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: b.root, env: GIT_ENV, encoding: 'utf8' }).stdout.trim()
    assert.equal(head, run.advanced?.commit, '主线该停在定格那个提交上')
    const wrote = run.advanced?.written ?? []
    assert.ok(wrote.includes(A) && wrote.includes(B2), `推进该写下那两条：${JSON.stringify(wrote)}`)
    const onDisk = spawnSync('cat', [join(b.root, A)], { encoding: 'utf8' }).stdout
    assert.match(onDisk, /（夹具）/, '盘上那一份该是夹具写下的内容')
    console.log(
      `② 读数：验收 ${run.report.pass}/${run.report.fail} · 折叠 ${run.fold.kind === 'folded' ? `折了 ${run.fold.steps} 步` : '冲突'} · ` +
        `推进 写 ${wrote.length} 条（${wrote.join(' · ')}）· 处境 ${run.state} · 停因一份都没有（夹具那一档没有 llm/call）`,
    )
  } finally {
    await logs.close()
    await b.close()
  }
})

test('⑤ 声明相交不再当场拒：判决照旧进读数、折叠照做；`strictMergeGate` 那一档照旧 fail-closed', async () => {
  // 一 · 严那一档（`--strict-merge-gate`）：照旧拒——旧严宽留着，改主意的条件写在那一栏的注释里。
  const strict = await bench()
  const strictLogs = logsOf(strict)
  try {
    await atGate(strict, draftTextCrossing())
    await go(strict)
    const batch = await issuedBatchOf(strict.log, ROUND)
    assert.equal(batch.precheck.intersections.length, 1, `这一档该有 1 对相交，实际 ${batch.precheck.intersections.length}`)
    await assert.rejects(
      async () => await runIssued({ ...tailDeps(strict, [], strictLogs), strictMergeGate: true }, batch),
      /合并前的写入集预检不放行/,
      '严那一档该照旧拒',
    )
  } finally {
    await strictLogs.close()
    await strict.close()
  }

  // 二 · 缺省那一档：**不拒**。判决照旧进 `precheckMerge`（报告那一行印出来），折叠照做；
  //      真撞车由折叠报出、走冲突环；折得干净而合起来坏的，由验收在**推进之前**拦住。
  const b = await bench()
  const logs = logsOf(b)
  try {
    await atGate(b, draftTextCrossing())
    await go(b)
    const batch = await issuedBatchOf(b.log, ROUND)
    const run = await runIssued(tailDeps(b, [], logs), batch)
    assert.equal(run.precheckMerge.count, 1, '相交那对数该照旧进读数（只报不拒的"报"就是它）')
    assert.equal(run.precheckMerge.ok, false, '判决本身照旧是"有相交"')
    assert.equal(run.report.ok, true, `折完验完该过：${JSON.stringify(run.report.results)}`)
    assert.notEqual(run.advanced, null, '缺省那一档该照做（验收过了就推进）')
    console.log(
      `⑤ 读数：声明相交 ${run.precheckMerge.count} 对 → 不拒 · 折叠 ${run.fold.kind === 'folded' ? `折了 ${run.fold.steps} 步` : '走到冲突环'} · ` +
        `验收 ${run.report.pass}/${run.report.fail} · 推进 ${run.advanced === null ? '没有' : `写 ${(run.advanced.written ?? []).join(' ')}`}`,
    )
  } finally {
    await logs.close()
    await b.close()
  }
})

test('③ 处境不对就拒：Idle · Planning · 跑过之后，每一档都指得出路', async () => {
  const b = await bench()
  const logs = logsOf(b)
  try {
    // 一 · Idle
    const idle = await issuedBatchOf(b.log, ROUND).then(
      () => null,
      (err: unknown) => err,
    )
    assert.ok(idle instanceof RoundWorkError, `Idle 那一档该拒，实得 ${String(idle)}`)
    assert.match(idle.message, /round plan/, '该指得出"先 plan"这条路')

    // 二 · Planning（停在门口）
    await atGate(b)
    const planning = await issuedBatchOf(b.log, ROUND).then(
      () => null,
      (err: unknown) => err,
    )
    assert.ok(planning instanceof RoundWorkError, `Planning 那一档该拒，实得 ${String(planning)}`)
    assert.match(planning.message, /round go/, '该指得出"先放行"这条路')

    // 三 · 跑过之后（Working 之外的处境）
    await go(b)
    const batch = await issuedBatchOf(b.log, ROUND)
    await runIssued(tailDeps(b, [], logs), batch)
    const after = await issuedBatchOf(b.log, ROUND).then(
      () => null,
      (err: unknown) => err,
    )
    assert.ok(after instanceof RoundWorkError, `跑过之后该拒，实得 ${String(after)}`)
    assert.match(after.message, /round\.id/, '该指得出"换轮次号"这条路')
    assert.equal(whyNotWorking('Delegated').includes('branches-started'), true, 'Delegated 那一档该说清缺的是哪一步')
    console.log(
      `③ 读数：Idle「${idle.message.slice(0, 24)}…」· Planning「${planning.message.slice(0, 22)}…」· ` +
        `跑过之后「${after.message.slice(0, 24)}…」——三档都是拒，各自指一条路`,
    )
  } finally {
    await logs.close()
    await b.close()
  }
})

test('④ 已经交过卷的格不重跑：只补没交卷的那几格（负对照：还在底上就照旧跑）', async () => {
  const b = await bench()
  const logs = logsOf(b)
  try {
    await atGate(b)
    const issued = await go(b)
    const batch = await issuedBatchOf(b.log, ROUND)
    const first = batch.contracts[0] as Contract
    const firstAgent = first.agent as AgentId

    // 手工把第一格"交卷"：那条分支推到它自己那个提交（这就是接着跑那一档看到的样子）。
    const blob = await b.truth.putBlob(new TextEncoder().encode('（手工）第一格交过卷了\n'))
    const merged = new Map((await entriesOf(b.truth, b.base)).map((e) => [e.name, e]))
    merged.set('手工-第一格.txt', { name: '手工-第一格.txt', mode: 0o100644, id: blob })
    const done = await b.truth.commit(await b.truth.putTree([...merged.values()]), [b.base], '（手工）第一格')
    await b.truth.advance(refFor(firstAgent as WriterId), done, b.base)

    const calls: string[] = []
    const run = await runIssued(tailDeps(b, calls, logs), batch)
    assert.deepEqual(run.reused, [first.id], `该只复用第一格：${JSON.stringify(run.reused)} / 期望 ${first.id}`)
    assert.equal(run.work[first.id], done, '复用的该是那条分支上那个提交')
    assert.equal(calls.includes(first.id as string), false, `第一格不该被重跑：${JSON.stringify(calls)}`)
    assert.equal(calls.length, batch.contracts.length - 1, `只该跑剩下的 ${batch.contracts.length - 1} 格`)
    assert.equal(run.report.ok, true, '复用那一格之后验收照过')

    console.log(
      `④ 读数：复用 ${run.reused.length} 格（${run.reused.join(' · ')}）· 真跑了 ${calls.length} 格（${calls.join(' · ')}）· ` +
        `验收 ${run.report.pass}/${run.report.fail} · 契约一共 ${issued.built.contracts.length} 份`,
    )
  } finally {
    await logs.close()
    await b.close()
  }
})
