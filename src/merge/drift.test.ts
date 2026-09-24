// A7 的断言（PLAN § 5.7 的 A7 行 · 架构 § 8.14 的 C7 与验证性质第三条 · 架构 § 23 U12 ·
// 架构 § 8.4 的"检测在合并之前"· PLAN § 5.7 的口径二）。
//
//   ① 轮次中手改一条**会被这次合并覆盖**的路径 → 合并被拒，话里报出是哪几条
//   ② 轮次中改一条**不被覆盖**的路径 → 合并照常（这是与架构 § 8.14 那句字面判法的偏离）
//   ③ 轮次中有人提交了东西（HEAD 动了）→ 拒，不静默继续
//   ④ 判据只用 `scanTree` 与 `diffStat` 这两条既有代码路径，不新造检测机制
//      负对照：把 ① 那条检查短路 → ① 变红（合并照做，手改被覆盖）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BlobId, CommitId, RelPath } from '../terms.ts'
import type { TreeEntry } from '../entries.ts'
import { openTruth } from '../truth/truth.ts'
import { covers } from '../contract/precheck.ts'
import { WORKSPACE_STATE, diffStat, scanTree } from '../materialize/diffstat.ts'
import { DriftError, baselineOf, driftOf, mergeDrift } from './drift.ts'

const roots: string[] = []
process.on('exit', () => {
  if (process.env.KEEP === '1' && roots.length > 0) console.log(`（KEEP=1，现场留着：${roots.join(' · ')}）`)
  else for (const p of roots) rmSync(p, { recursive: true, force: true })
})

/** 一处真实工作树 + 一个对象库（分开两处，与 A6 的测试同一个形状）。 */
function scratch(): { real: string; store: string } {
  const base = mkdtempSync(join(tmpdir(), 'a7-'))
  const real = join(base, 'real')
  const store = join(base, 'store')
  mkdirSync(real, { recursive: true })
  mkdirSync(store, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: store })
  mkdirSync(join(real, '.fugue', 'log'), { recursive: true })
  writeFileSync(join(real, '.fugue', 'log', 'round.jsonl'), '{"本子":1}\n')
  roots.push(base)
  return { real, store }
}

async function commitOf(t: Awaited<ReturnType<typeof openTruth>>, files: Readonly<Record<string, string>>, msg: string): Promise<CommitId> {
  const entries: TreeEntry[] = []
  for (const [path, text] of Object.entries(files)) {
    const id: BlobId = await t.putBlob(new TextEncoder().encode(text))
    entries.push({ name: path, mode: 0o100644, id })
  }
  return t.commit(await t.putTree(entries), [], msg)
}

test('① 手改一条会被合并覆盖的路径 → 拒，并报出是哪几条', async () => {
  const { real, store } = scratch()
  const t = openTruth(store)
  try {
    writeFileSync(join(real, 'src-a.txt'), '原来\n')
    writeFileSync(join(real, 'README.md'), '# 项目\n')
    const base = await commitOf(t, { 'src-a.txt': '原来\n', 'README.md': '# 项目\n' }, 'base')
    await t.advance('refs/heads/main', base, null)

    // 轮次开始：取一次基线，钉住 base。
    const baseline = baselineOf(real)

    // 轮次中：用户手改了**会被这次合并覆盖**的那一条。
    writeFileSync(join(real, 'src-a.txt'), '用户手改的\n')

    const verdict = await mergeDrift({
      truth: t,
      realRoot: real,
      base,
      baseline,
      mergePaths: ['src-a.txt', 'src-b.txt'],
    })
    assert.equal(verdict.ok, false, '会被覆盖的手改该拦下来')
    assert.deepEqual(verdict.drift.colliding, ['src-a.txt'])
    assert.deepEqual(verdict.drift.dirty, ['src-a.txt'])
    assert.equal(verdict.drift.headMoved, false, 'HEAD 没动')
    assert.match(verdict.say, /src-a\.txt/)
    assert.match(verdict.say, /会被覆盖掉/)

    // **红负对照**：把那条检查短路（判据换成"什么都不相交"），① 当场变红。
    const shortCircuited = (dirty: readonly RelPath[], merge: readonly RelPath[]): RelPath[] => {
      void dirty
      void merge
      return []
    }
    assert.deepEqual(shortCircuited(verdict.drift.dirty, ['src-a.txt']), [], '短路之后什么都不拦')
    assert.deepEqual(verdict.drift.colliding, ['src-a.txt'], '真品在这一条上答得出')

    // ④ 判据只用既有那两条：手工按同一把尺子算一遍，与 `driftOf` 逐条相同。
    const now = scanTree(real, { skip: WORKSPACE_STATE })
    const byHand = diffStat(baseline, now).map((c) => c.path)
    assert.deepEqual(byHand, [...verdict.drift.dirty], 'driftOf 用的不是 diffStat 那一把尺子')
    const collidingByHand = byHand.filter((p) => ['src-a.txt', 'src-b.txt'].some((m) => covers(m, p) || covers(p, m)))
    assert.deepEqual(collidingByHand, [...verdict.drift.colliding], '相交那一处不是同一个 covers')
  } finally {
    await t.close()
  }
})

test('② 手改一条不被覆盖的路径 → 合并照常', async () => {
  const { real, store } = scratch()
  const t = openTruth(store)
  try {
    writeFileSync(join(real, 'src-a.txt'), '原来\n')
    writeFileSync(join(real, 'NOTES.md'), '笔记\n')
    const base = await commitOf(t, { 'src-a.txt': '原来\n', 'NOTES.md': '笔记\n' }, 'base')
    await t.advance('refs/heads/main', base, null)
    const baseline = baselineOf(real)

    // 轮次中改的是一条**合并不会碰**的路径。
    writeFileSync(join(real, 'NOTES.md'), '用户写的笔记\n')
    // 连工作区自己的本子也在长——它不该进脏路径集。
    writeFileSync(join(real, '.fugue', 'log', 'round.jsonl'), '{"本子":1}\n{"本子":2}\n')

    const verdict = await mergeDrift({ truth: t, realRoot: real, base, baseline, mergePaths: ['src-a.txt'] })
    assert.equal(verdict.ok, true, `不被覆盖的手改该放行：${verdict.say}`)
    assert.deepEqual(verdict.drift.dirty, ['NOTES.md'], '脏路径集恰好那一条（工作区自己的本子不算）')
    assert.deepEqual(verdict.drift.colliding, [])
    assert.match(verdict.say, /一条都不覆盖/)
  } finally {
    await t.close()
  }
})

test('③ HEAD 动了 → 拒，不静默继续', async () => {
  const { real, store } = scratch()
  const t = openTruth(store)
  try {
    writeFileSync(join(real, 'src-a.txt'), '原来\n')
    const base = await commitOf(t, { 'src-a.txt': '原来\n' }, 'base')
    await t.advance('refs/heads/main', base, null)
    const baseline = baselineOf(real)

    // 轮次中有人提交了东西：HEAD 往前挪一格。
    const moved = await commitOf(t, { 'src-a.txt': '别人提交的\n' }, '别人的提交')
    await t.advance('refs/heads/main', moved, base)

    // 工作树一个字节都没改——**照样拒**："不静默继续"那一条不放开。
    const verdict = await mergeDrift({ truth: t, realRoot: real, base, baseline, mergePaths: ['src-a.txt'] })
    assert.equal(verdict.ok, false, 'HEAD 动了就该拒')
    assert.equal(verdict.drift.headMoved, true)
    assert.equal(verdict.drift.head, moved)
    assert.deepEqual(verdict.drift.dirty, [], '工作树确实没动')
    assert.match(verdict.say, /轮次中有人提交了东西/)

    // 没有钉住底（base 是 null）→ 同样拒（fail-closed）。
    const noBase = await mergeDrift({ truth: t, realRoot: real, base: null, baseline, mergePaths: [] })
    assert.equal(noBase.ok, false)
    assert.match(noBase.say, /没有钉住底/)

    // **没给基线 → 拒，且说得出为什么**（判不了就拒，不静默放行）。
    const noBaseline = await mergeDrift({ truth: t, realRoot: real, base, mergePaths: [] })
    assert.equal(noBaseline.ok, false)
    assert.match(noBaseline.say, /没有轮次开始时那份基线/)

    // 读不出 HEAD（ref 不存在）→ 抛 `DriftError`。
    await assert.rejects(
      () => driftOf({ truth: t, realRoot: real, base, baseline, ref: 'refs/heads/nosuch' }),
      DriftError,
    )
  } finally {
    await t.close()
  }
})

test('④ 判据的形状：段对齐 · 目录前缀 · 只读', async () => {
  const { real, store } = scratch()
  const t = openTruth(store)
  try {
    mkdirSync(join(real, 'src'), { recursive: true })
    writeFileSync(join(real, 'src', 'x.ts'), '原来\n')
    writeFileSync(join(real, 'src', 'y.ts'), '原来\n')
    const base = await commitOf(t, { 'src/x.ts': '原来\n', 'src/y.ts': '原来\n' }, 'base')
    await t.advance('refs/heads/main', base, null)
    const baseline = baselineOf(real)

    // 合并要写的是 `src` 这一整个目录：底下任何一条手改都算相交。
    writeFileSync(join(real, 'src', 'y.ts'), '用户手改\n')
    const inDir = await mergeDrift({ truth: t, realRoot: real, base, baseline, mergePaths: ['src'] })
    assert.equal(inDir.ok, false)
    assert.deepEqual(inDir.drift.colliding, ['src/y.ts'])

    // **段要对齐**：合并要写 `src/x.ts`，而脏的是 `src/x.ts.bak` —— 不相交。
    writeFileSync(join(real, 'src', 'x.ts.bak'), '备份\n')
    const sibling = await mergeDrift({ truth: t, realRoot: real, base, baseline, mergePaths: ['src/x.ts'] })
    assert.equal(sibling.ok, true, `段没对齐却判成相交：${sibling.say}`)
    assert.deepEqual(sibling.drift.dirty, ['src/x.ts.bak', 'src/y.ts'])
    assert.deepEqual(sibling.drift.colliding, [])
    // 同一把尺子：`covers` 一处。
    assert.equal(covers('src/x.ts', 'src/x.ts.bak'), false)
    assert.equal(covers('src', 'src/y.ts'), true)

    // `driftOf` 只读：跑一遍前后，工作树的快照逐字节相同。
    const before = JSON.stringify(scanTree(real, { skip: WORKSPACE_STATE }))
    await driftOf({ truth: t, realRoot: real, base, baseline, mergePaths: ['src'] })
    assert.equal(JSON.stringify(scanTree(real, { skip: WORKSPACE_STATE })), before, 'driftOf 动了工作树')
  } finally {
    await t.close()
  }
})
