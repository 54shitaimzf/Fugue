// 提交这个操作的两条性质，以及它**必须能从面外被调用**。
//
// 它单独一处实现，是因为架构 § 9.6 说 `checkpoint`（模型侧）与 `fugue commit`（人侧）是
// 同一个操作的两个名字。同一个操作两处实现，迟早漂移成两套语义——所以这里的断言也守着
// 那一件事：这个操作不依赖任何一个面。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { tmpDir } from '../test/helpers/tmp.ts'
import { checkpoint } from './checkpoint.ts'
import { refFor, agentFor } from './identity.ts'
import type { Log, LogEvent } from './log/events.ts'
import { logFileOf, openLog } from './log/log.ts'
import { openTruth, RefConflictError } from './truth/truth.ts'
import type { Truth } from './truth/contract.ts'
import type { TreeEntry } from './entries.ts'
import type { AgentId, WriterId } from './terms.ts'

const REPO = join(import.meta.dirname, '..')
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function tmpRoot(): string {
  const root = tmpDir('fugue-ckpt-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

test('refFor：§ 4 的命名方案，writer → 它推进的 ref', () => {
  assert.equal(refFor('round'), 'refs/heads/main')
  assert.equal(refFor('agent/r1/1' as WriterId), 'refs/heads/agent/r1/1')
  assert.equal(refFor('agent/r2/7' as WriterId), 'refs/heads/agent/r2/7')
})

test('agentFor：writer → 它落日志与视图时用的 agent 署名（§ 4 · § 8.1 · § 8.3）', () => {
  // 主线的写者署名是一句**名字**，不是空白占位：它就是持轮者那个位置上写的名字。
  assert.equal(agentFor('round'), 'round')
  assert.equal(agentFor('agent/r1/1' as WriterId), 'agent/r1/1')
  // 两处翻译都从同一个 WriterId 出发，所以主线只有一种说法（§ 4 的 ref 方案 + 署名）。
  assert.equal(agentFor('round'), agentFor('round' as unknown as WriterId))
  assert.equal(refFor(agentFor('round') as unknown as WriterId), 'refs/heads/main')
})

test('checkpoint：两个写者抢同一个 ref → 恰一个成功，**输的那个在日志里一句都不留**', async (ctx) => {
  const root = tmpRoot()
  const writer = 'agent/r1/1' as WriterId
  const log = openLog(root, { sync: 'never' })
  ctx.after(() => log.close())
  const truth = openTruth(root)
  ctx.after(() => truth.close())

  const mk = async (what: string): Promise<TreeEntry[]> => {
    const blob = await truth.putBlob(Buffer.from(`${what}\n`))
    return [{ name: 'f.txt', mode: 0o100644, id: blob }]
  }
  // 两个都从"这个 ref 还不存在"出发：expectedOld 都是 null，所以恰一个能赢。
  // **期望由调用者给**，所以这一条不再取决于"谁先读到 ref"——两次推进对同一个旧值做 CAS，
  // git 保证恰一个成功。要是让 `checkpoint` 自己去读 ref，后读的那个会读到赢家的提交，
  // 于是两个都成功："恰一个"就成了时序的运气。
  const [a, b] = await Promise.allSettled([
    checkpoint({ log, truth, writer, entries: await mk('A'), rev: 1, msg: 'A', expectedOld: null }),
    checkpoint({ log, truth, writer, entries: await mk('B'), rev: 1, msg: 'B', expectedOld: null }),
  ])
  const ok = [a, b].filter((r) => r.status === 'fulfilled')
  const bad = [a, b].filter((r) => r.status === 'rejected')
  assert.equal(ok.length, 1, '恰一个成功')
  assert.equal(bad.length, 1)
  const reason = (bad[0] as PromiseRejectedResult).reason as Error
  assert.ok(
    reason instanceof RefConflictError,
    `输的原因应当是 CAS，实际是 ${reason.name}：${reason.message}`,
  )

  const events = []
  for await (const e of log.readByWriter(writer)) events.push(e)
  assert.equal(events.length, 1, 'CAS 输了的那次不该留下任何一行——日志记的是已发布的提交')
  assert.equal((events[0] as { t: string }).t, 'ckpt/commit')
  const won = (ok[0] as PromiseFulfilledResult<{ commit: string }>).value
  assert.equal(events[0].commit, won.commit)
  assert.equal(await truth.resolve(refFor(writer)), won.commit, 'ref 停在赢家那个提交上')
})

test('CLI 可以被 import 而不执行任何命令（负对照）', () => {
  // 命令行的实现要能被面外复用：`refFor` 曾经住在这里，而它 import 即跑 main()，
  // 于是谁都不能复用它。这条断言就是那个性质——**import 之后什么都不该发生**。
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(CLI).href)})`],
    { encoding: 'utf8', env: GIT_ENV },
  )
  assert.equal(r.status, 0, `import 不该非零退出：${r.stderr}`)
  assert.equal(r.stdout, '', `import 不该打印任何东西，实际打了：${JSON.stringify(r.stdout)}`)
  assert.equal(r.stderr, '')
})

test('面外调用：日志的 writer 标识进得去，提交点回得来', async (ctx) => {
  const root = tmpRoot()
  const writer = 'agent/r1/2' as WriterId
  const log = openLog(root, { sync: 'never' })
  ctx.after(() => log.close())
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const blob = await truth.putBlob(Buffer.from('面外的内容\n'))
  await log.append(writer, {
    t: 'view/write',
    agent: writer as AgentId,
    path: 'src/a.ts',
    rev: 1,
    blob,
    mode: 0o100644,
  })
  const r = await checkpoint({
    log,
    truth,
    writer,
    entries: [{ name: 'src/a.ts', mode: 0o100644, id: blob }],
    rev: 1,
    msg: '面外提交',
    expectedOld: null,
  })
  assert.equal(r.ref, 'refs/heads/agent/r1/2')
  assert.deepEqual(r.parents, [])
  assert.equal(r.entries, 1)
  assert.equal((await truth.readAt(r.commit, 'src/a.ts'))?.toString(), '面外的内容\n')
  // 第二次：parent 接上
  const r2 = await checkpoint({
    log,
    truth,
    writer,
    entries: [{ name: 'src/a.ts', mode: 0o100644, id: blob }],
    rev: 1,
    msg: '第二次',
    expectedOld: r.commit,
  })
  assert.deepEqual(r2.parents, [r.commit])
})

// ────────────────────────────────── 0.2.6 ② · 崩溃注入矩阵（提交那一族）
//
// 出处：PR15 审查件 § 2 采纳 2——"它不去 hook 产品代码，而是**照着产品会写下的样子，手工把
// 中间态摆出来**"；同一门手法在轮次那条路上摆了 CAS **之前**与**之后**各一格。
//
// **不 hook 产品代码**是怎么做到的：`checkpoint()` 要的 `Log` 与 `Truth` 是**从参数进来的**，
// 所以一只 spy 转手就能把产品真调的顺序**量出来**——先跑一趟正常提交，把次序记下来，再照那个
// 次序手工把两格摆出来。**形状一变这一格当场红**（量出来的那一串与写死的那一串对不上），
// 这正是"夹具跟形状走"要的效果。

/** 账文件此刻的原文（`logFileOf` 是 M0 自己那一处算文件名的口）。 */
function logText(root: string, w: WriterId): string {
  return readFileSync(logFileOf(root, w), 'utf8')
}

test('0.2.6 ② · checkpoint 的中间态两格：CAS 之前 / CAS 之后日志之前', async (ctx) => {
  const root = tmpRoot()
  const writer = 'agent/r1/1' as WriterId
  const ref = refFor(writer)
  const log = openLog(root, { sync: 'never' })
  ctx.after(() => log.close())
  const truth = openTruth(root)
  ctx.after(() => truth.close())

  const mk = async (what: string): Promise<TreeEntry[]> => {
    const blob = await truth.putBlob(Buffer.from(`${what}\n`))
    return [{ name: 'f.txt', mode: 0o100644, id: blob }]
  }
  const base = await checkpoint({ log, truth, writer, entries: await mk('基线'), rev: 1, msg: '基线', expectedOld: null })

  // ── 一 · 把产品真调的顺序量出来（spy 只转手，不改一个字节的行为）。
  const seen: string[] = []
  const spyLog: Log = {
    ...log,
    append: (w, e) => {
      seen.push('log.append')
      return log.append(w, e)
    },
  }
  const spyTruth: Truth = {
    ...truth,
    putTree: (es) => {
      seen.push('truth.putTree')
      return truth.putTree(es)
    },
    commit: (t, ps, m) => {
      seen.push('truth.commit')
      return truth.commit(t, ps, m)
    },
    advance: (r, c, o) => {
      seen.push('truth.advance')
      return truth.advance(r, c, o)
    },
  }
  const second = await checkpoint({
    log: spyLog,
    truth: spyTruth,
    writer,
    entries: await mk('第二'),
    rev: 2,
    msg: '第二',
    expectedOld: base.commit,
  })
  assert.deepEqual(
    seen,
    ['truth.putTree', 'truth.commit', 'truth.advance', 'log.append'],
    '§ 9.3 的次序：对象 → CAS 推进 → 日志（**产品改了次序这一句就红**，下面两格照着的就是它）',
  )

  // ── 格 A · **CAS 之前**：对象落好了（tree 与 commit 都回来了），ref 没推进，账上没那一行。
  const atA = logText(root, writer)
  const treeA = await truth.putTree(await mk('A'))
  const commitA = await truth.commit(treeA, [second.commit], 'A')
  assert.equal(
    Buffer.from((await truth.readAt(commitA, 'f.txt')) ?? []).toString(),
    'A\n',
    '对象真在盘上——这一格的前提就是"提交造出来了，只是没推进 ref"',
  )
  assert.equal(await truth.resolve(ref), second.commit, 'ref 还停在老地方：CAS 那一步没做')
  assert.equal(logText(root, writer), atA, '账一个字节没动')
  // **恢复成功**：下一次提交拿老 ref 当期望，照走——那半个提交没成事。
  const stepA = await checkpoint({
    log,
    truth,
    writer,
    entries: await mk('A 之后'),
    rev: 3,
    msg: 'A 之后',
    expectedOld: second.commit,
  })
  assert.deepEqual(stepA.parents, [second.commit], '接在**老 ref** 上')
  assert.equal(await truth.resolve(ref), stepA.commit)
  assert.ok(logText(root, writer).startsWith(atA), '旧状态没被改坏：账是接着往后长的')

  // ── 格 B · **CAS 之后、日志之前**：ref 推到新提交了，账上还没有那一行。
  const atB = logText(root, writer)
  const treeB = await truth.putTree(await mk('B'))
  const commitB = await truth.commit(treeB, [stepA.commit], 'B')
  await truth.advance(ref, commitB, stepA.commit)
  assert.equal(await truth.resolve(ref), commitB, 'ref 推到了新提交——这一格的前提')
  assert.equal(logText(root, writer), atB, '账一个字节没动：那一行还没落')
  // **恢复成功**：下一次提交拿**新 ref** 当期望，照走；账接着往后长。
  const stepB = await checkpoint({
    log,
    truth,
    writer,
    entries: await mk('B 之后'),
    rev: 4,
    msg: 'B 之后',
    expectedOld: commitB,
  })
  assert.deepEqual(stepB.parents, [commitB])
  assert.ok(logText(root, writer).startsWith(atB), '旧状态没被改坏：账是接着往后长的')
  assert.ok(logText(root, writer).length > atB.length, '**下一次操作照常成功**：账上多了一行')

  // 账上一共四条：基线 · 第二 · A 之后 · B 之后。**两格各自那半个提交一条都不留**——
  // § 9.3 把"日志"排在做 CAS **之后**，要躲的正是"输掉的那次也在权威来源里留下一行"。
  const rows: LogEvent[] = []
  for await (const e of log.readByWriter(writer)) rows.push(e)
  assert.equal(rows.length, 4)
  assert.equal(rows.every((e) => e.t === 'ckpt/commit'), true)
})
