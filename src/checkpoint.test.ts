// 提交这个操作的两条性质，以及它**必须能从面外被调用**。
//
// 它单独一处实现，是因为架构 § 9.6 说 `checkpoint`（模型侧）与 `fugue commit`（人侧）是
// 同一个操作的两个名字。同一个操作两处实现，迟早漂移成两套语义——所以这里的断言也守着
// 那一件事：这个操作不依赖任何一个面。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { checkpoint } from './checkpoint.ts'
import { refFor } from './refs.ts'
import { openLog } from './log/log.ts'
import { openTruth, RefConflictError } from './truth/truth.ts'
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
  const root = mkdtempSync(join(tmpdir(), 'fugue-ckpt-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

test('refFor：§ 4 的命名方案，writer → 它推进的 ref', () => {
  assert.equal(refFor('round'), 'refs/heads/main')
  assert.equal(refFor('agent/r1/1' as WriterId), 'refs/heads/agent/r1/1')
  assert.equal(refFor('agent/r2/7' as WriterId), 'refs/heads/agent/r2/7')
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
  const [a, b] = await Promise.allSettled([
    checkpoint({ log, truth, writer, entries: await mk('A'), rev: 1, msg: 'A' }),
    checkpoint({ log, truth, writer, entries: await mk('B'), rev: 1, msg: 'B' }),
  ])
  const ok = [a, b].filter((r) => r.status === 'fulfilled')
  const bad = [a, b].filter((r) => r.status === 'rejected')
  assert.equal(ok.length, 1, '恰一个成功')
  assert.equal(bad.length, 1)
  assert.ok(
    (bad[0] as PromiseRejectedResult).reason instanceof RefConflictError,
    '输的原因应当是 CAS',
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
  })
  assert.deepEqual(r2.parents, [r.commit])
})
