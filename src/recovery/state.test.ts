// D8 B / B10 的恢复判据：**五态从账上的发布事实 + 实际 ref + 盘上内容算出来**。
//
//   未写回（not-written）· 全写回（full）· 部分写回（partial）· 冲突（conflict）·
//   未验证（unverified）
//
// 这一份用真 Git 对象库与真工作树摆每一态，不做替身：判据本身就在这三个真源之间。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import { openPublishOf, publishFactsOf, recoverOf } from './state.ts'
import { runCli } from '../../test/helpers/run-cli.ts'
import type { CommitId, RelPath, RoundId } from '../terms.ts'

const ROUND = 'r1' as RoundId

interface Scene {
  readonly root: string
  readonly truth: TruthHandle
  readonly log: LogHandle
  readonly base: CommitId
  readonly target: CommitId
  readonly third: CommitId
}

async function commitOf(t: TruthHandle, files: Readonly<Record<string, string>>, parents: readonly CommitId[], msg: string): Promise<CommitId> {
  const entries = []
  for (const [name, text] of Object.entries(files)) {
    entries.push({ name, mode: 0o100644, id: await t.putBlob(new TextEncoder().encode(text)) })
  }
  return t.commit(await t.putTree(entries), [...parents], msg)
}

async function scene(): Promise<Scene> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-recover-'))
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: root }).status, 0)
  const truth = openTruth(root)
  const base = await commitOf(truth, { 'a.txt': '旧 a\n', 'b.txt': '旧 b\n' }, [], '底')
  const target = await commitOf(truth, { 'a.txt': '新的 a\n', 'b.txt': '旧 b\n', 'c.txt': '新 c\n' }, [base], '目标')
  const third = await commitOf(truth, { 'a.txt': '别人写的\n' }, [base], '第三份')
  await truth.advance('refs/heads/main', base, null)
  // 盘上铺成“发布前”那一份。
  writeFileSync(join(root, 'a.txt'), '旧 a\n')
  writeFileSync(join(root, 'b.txt'), '旧 b\n')
  mkdirSync(join(root, '.fugue', 'log'), { recursive: true })
  const log = openLog(root, { write: 'round', sync: 'each' })
  await log.append('round', { t: 'round/intent', round: ROUND, base, digest: 'd'.repeat(16), body: '{"goal":"改 a"}' })
  return { root, truth, log, base, target, third }
}

async function close(s: Scene): Promise<void> {
  await s.log.close()
  await s.truth.close()
  rmSync(s.root, { recursive: true, force: true })
}

async function begin(s: Scene, commit = s.target): Promise<void> {
  await s.log.append('round', {
    t: 'merge/publish',
    round: ROUND,
    commit,
    phase: 'begin',
    ref: 'refs/heads/main',
    expected: s.base,
  })
}

/** 发一份契约（收尾要从它正文里取断言清单）。 */
async function issue(s: Scene, names: readonly string[] = ['过']): Promise<void> {
  await s.log.append('round', {
    t: 'contract/issue',
    round: ROUND,
    contract: 'r1.implement.1' as never,
    owner: 'agent/r1/1' as never,
    paths: ['a.txt' as RelPath],
    body: JSON.stringify({
      kind: 'implement',
      id: 'r1.implement.1',
      agent: 'agent/r1/1',
      branch: 'refs/heads/agent/r1/1',
      goal: '改 a',
      ownedPaths: ['a.txt'],
      deliverables: [],
      assertions: names.map((name) => ({ action: 'ok', name })),
      seed: [],
      actionOutputs: {},
    }),
  })
}

function writeTarget(s: Scene): void {
  writeFileSync(join(s.root, 'a.txt'), '新的 a\n')
  writeFileSync(join(s.root, 'c.txt'), '新 c\n')
}

test('没有发布事实 → 没有需要恢复的（null）', async () => {
  const s = await scene()
  try {
    assert.equal(await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log }), null)
    assert.equal(openPublishOf([]), null)
  } finally {
    await close(s)
  }
})

test('未写回：begin 之后文件与主线都还是发布前', async () => {
  const s = await scene()
  try {
    await begin(s)
    const r = await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log })
    assert.equal(r?.state, 'not-written')
    assert.equal(r?.commit, s.target)
    assert.equal(r?.refNow, s.base)
    assert.match(String(r?.next.join(' ')), /round work/)
    // 发布事实的机器读法：begin 一条、没有 done、没有 accept。
    const facts = publishFactsOf(await factsOf(s.log))
    assert.equal(facts.length, 1)
    assert.equal(facts[0]?.phase, 'begin')
    assert.equal(facts[0]?.accepted, false)
  } finally {
    await close(s)
  }
})

test('部分写回：文件已经到目标、主线还在发布前', async () => {
  const s = await scene()
  try {
    await begin(s)
    writeTarget(s)
    const r = await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log })
    assert.equal(r?.state, 'partial')
    assert.equal(r?.refNow, s.base)
    assert.ok((r?.paths ?? []).includes('a.txt' as RelPath), `部分写回要报出已经变的路径：${JSON.stringify(r?.paths)}`)
    assert.match(String(r?.say), /主线还在/)
  } finally {
    await close(s)
  }
})

test('全写回：文件与主线都到目标，accept 未落也不虚报成功', async () => {
  const s = await scene()
  try {
    await begin(s)
    writeTarget(s)
    await s.truth.advance('refs/heads/main', s.target, s.base)
    const r = await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log })
    assert.equal(r?.state, 'full')
    assert.equal(r?.refNow, s.target)
    assert.match(String(r?.say), /全写回/)
    assert.match(String(r?.next.join(' ')), /接受事件在中断前没有落下/)

    // done + accept 落齐之后就没有未收尾的发布了。
    await s.log.append('round', { t: 'merge/publish', round: ROUND, commit: s.target, phase: 'done', ref: 'refs/heads/main', expected: s.base })
    await s.log.append('round', {
      t: 'merge/accept',
      round: ROUND,
      commit: s.target,
      assertions: [{ assertion: '过', verdict: 'pass' }],
    })
    assert.equal(await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log }), null)
  } finally {
    await close(s)
  }
})

test('冲突：盘上是中断之后的新内容 / 用户删了目标还留着的路径', async () => {
  const s = await scene()
  try {
    await begin(s)
    writeFileSync(join(s.root, 'a.txt'), '用户手写的一版\n')
    const r = await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log })
    assert.equal(r?.state, 'conflict')
    assert.deepEqual(r?.paths, ['a.txt'])

    // 用户删除也是冲突：目标树还留着 b.txt，盘上没了。
    writeFileSync(join(s.root, 'a.txt'), '旧 a\n')
    unlinkSync(join(s.root, 'b.txt'))
    const gone = await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log })
    assert.equal(gone?.state, 'conflict')
    assert.deepEqual(gone?.paths, ['b.txt'])
  } finally {
    await close(s)
  }
})

test('未验证：目标对象读不出来 / 主线被第三个人挪走', async () => {
  const s = await scene()
  try {
    await begin(s, 'f'.repeat(40) as CommitId)
    const missing = await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log })
    assert.equal(missing?.state, 'unverified')
    assert.match(String(missing?.say), /读不出来/)

    // 换成真目标，但主线被挪到第三份。
    await s.log.append('round', { t: 'merge/publish', round: ROUND, commit: s.target, phase: 'begin', ref: 'refs/heads/main', expected: s.base })
    await s.truth.advance('refs/heads/main', s.third, s.base)
    const moved = await recoverOf({ truth: s.truth, realRoot: s.root, log: s.log })
    assert.equal(moved?.state, 'conflict')
    assert.match(String(moved?.say), /别人在中断之后动过主线/)
  } finally {
    await close(s)
  }
})

test('命令面：recover --json 报五态之一 · 人面说清下一步 · 没有发布就直说', async () => {
  const s = await scene()
  try {
    await begin(s)
    // CLI 要另开句柄：先把写句柄放掉。
    await s.log.close()
    const one = await runCli(['--root', s.root, '--json', 'recover'])
    assert.equal(one.code, 0, one.stderr)
    const parsed = JSON.parse(one.stdout) as { state: string; commit: string; next: string[] }
    assert.equal(parsed.state, 'not-written')
    assert.equal(parsed.commit, s.target)
    assert.ok(parsed.next.length > 0)
    const human = await runCli(['--root', s.root, 'recover'])
    assert.equal(human.code, 0, human.stderr)
    assert.match(human.stdout, /恢复 · r1 · 未写回/)
    assert.match(human.stdout, /下一步/)
    // 收尾之后再跑：没有未收尾的发布。
    await s.truth.advance('refs/heads/main', s.target, s.base)
    writeTarget(s)
    const two = await runCli(['--root', s.root, 'recover'])
    assert.equal(two.code, 0, two.stderr)
    assert.match(two.stdout, /全写回/)
    // **没有发布事实**的那一档：直说，不印一个空报告让人猜。
    const fresh = await scene()
    try {
      await fresh.log.close()
      const none = await runCli(['--root', fresh.root, 'recover'])
      assert.equal(none.code, 0, none.stderr)
      assert.match(none.stdout, /没有未收尾的发布/)
    } finally {
      await close(fresh)
    }
    console.log(`命令面读数：${readFileSync(join(s.root, 'a.txt'), 'utf8').trim()}`)
  } finally {
    // `close` 里的 log.close() 幂等吗？这一条已经先关过一次——句柄的 close 幂等（M0 的契约）。
    await close(s)
  }
})

/** 读一遍账上的事件（发布事实的判据只吃事件）。 */
async function factsOf(log: LogHandle): Promise<readonly import('../log/events.ts').LogEvent[]> {
  const out: import('../log/events.ts').LogEvent[] = []
  for await (const { e } of log.readMerged()) out.push(e)
  return out
}

// R2：全写回之后，`fugue recover` 的下一步必须真能执行——补落 done + accept，不重放写，
// 收完账上没有未收尾的发布（下一轮的守卫因此放行）。
test('R2 · 全写回后照 recover 的下一步收尾：落 done+accept、不重放写、新轮能开', async () => {
  const s = await scene()
  try {
    await begin(s)
    await issue(s, ['过', '也过'])
    writeTarget(s)
    await s.truth.advance('refs/heads/main', s.target, s.base)
    await s.log.close()
    const before = await runCli(['--root', s.root, 'recover'])
    assert.equal(before.code, 0, before.stderr)
    assert.match(before.stdout, /fugue recover --finish/, '下一步要给出能照做的收尾命令')
    const disk = (): string => readFileSync(join(s.root, 'a.txt'), 'utf8') + '|' + readFileSync(join(s.root, 'c.txt'), 'utf8')
    const unchanged = disk()
    const fin = await runCli(['--root', s.root, 'recover', '--finish'])
    assert.equal(fin.code, 0, fin.stderr)
    assert.match(fin.stdout, /全写回/)
    assert.match(fin.stdout, /收尾事实已落/)
    assert.equal(disk(), unchanged, '收尾不能碰工作树（不重放写）')
    const after = await runCli(['--root', s.root, 'recover'])
    assert.equal(after.code, 0, after.stderr)
    assert.match(after.stdout, /没有未收尾的发布/)
    const log = openLog(s.root)
    try {
      const events = await factsOf(log)
      assert.equal(openPublishOf(events), null, '收尾后没有未收尾的发布（下一轮能开）')
      const accepts = events.filter((e) => e.t === 'merge/accept')
      assert.equal(accepts.length, 1)
      const one = accepts[0]
      assert.ok(one !== undefined && one.t === 'merge/accept')
      assert.deepEqual(one.assertions, [
        { assertion: '过', verdict: 'pass' },
        { assertion: '也过', verdict: 'pass' },
      ])
      assert.equal(events.filter((e) => e.t === 'merge/publish' && e.phase === 'done').length, 1)
    } finally {
      await log.close()
    }
  } finally {
    await close(s)
  }
})

// R2 的负对照：不是全写回就不落账。`--finish` 退出码 1，一条事实都不补。
test('R2 · 不是全写回时 --finish 拒：退出码 1，一条事实都不落', async () => {
  const s = await scene()
  try {
    await begin(s)
    await issue(s)
    await s.log.close()
    const r = await runCli(['--root', s.root, 'recover', '--finish'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /不是全写回/)
    const log = openLog(s.root)
    try {
      const events = await factsOf(log)
      assert.equal(events.filter((e) => e.t === 'merge/accept').length, 0)
      assert.equal(events.filter((e) => e.t === 'merge/publish').length, 1)
      assert.equal(openPublishOf(events)?.phase, 'begin')
    } finally {
      await log.close()
    }
  } finally {
    await close(s)
  }
})
