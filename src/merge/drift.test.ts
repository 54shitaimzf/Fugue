// A7 · A10 的断言（PLAN § 5.7 的 A7 与 A10 两行 · 架构 § 8.14 的 C7 与验证性质第三条 ·
// 架构 § 23 U12 · 架构 § 8.4 的"检测在物化之前"· PLAN § 5.7 的口径二）。
//
// **判据是三方比出来的：底 · 盘上 · 目标树**（A10 换过来的那一处）。三条放行/拒法各一条断言：
//
//   ① **盘上 == 底**（用户没碰过）→ 放行。这是合并的正常样子：工作树干净，而合并本来就该改它。
//      少了这一条，任何一次"改文件"的合并都会被拒——那是把"钉住"读成了"冻结"。
//      **红负对照**：把这一条短路掉（只留"盘上 == 目标树"那一档）→ ① 当场变红。
//   ② **盘上 == 目标树**（用户那份恰好就是合并算出来的结果）→ 放行。
//   ③ **三个两两都不同** → 拒，并报出是哪几条。轮次**之前**就存在的手改落在这一档（A9 量到的
//      第一行读数：判据原先比的是"盘上 vs 盘上"，那种改动根本看不见）。
//   ④ **盘上有、目标树里没有的已存在路径**（只被删的那一条）→ 拒。A10 之前"会被覆盖"只算了写。
//   ⑤ HEAD 动了 · 判不了 → 拒。拒的时候盘上字节一个都没动（`driftOf` 只读）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BlobId, CommitId } from '../terms.ts'
import type { TreeEntry } from '../entries.ts'
import { openTruth } from '../truth/truth.ts'
import { WORKSPACE_STATE, hashBytes, scanTree } from '../materialize/diffstat.ts'
import { DriftError, driftOf, mergeDrift } from './drift.ts'

const roots: string[] = []
process.on('exit', () => {
  if (process.env.KEEP === '1' && roots.length > 0) console.log(`（KEEP=1，现场留着：${roots.join(' · ')}）`)
  else for (const p of roots) rmSync(p, { recursive: true, force: true })
})

/** 一处真实工作树 + 一个对象库（分开两处，与 A6 的测试同一个形状）。 */
function scratch(): { real: string; store: string } {
  const base = mkdtempSync(join(tmpdir(), 'a10-'))
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

type T = Awaited<ReturnType<typeof openTruth>>

async function commitOf(t: T, files: Readonly<Record<string, string>>, msg: string): Promise<CommitId> {
  const entries: TreeEntry[] = []
  for (const [path, text] of Object.entries(files)) {
    const id: BlobId = await t.putBlob(new TextEncoder().encode(text))
    entries.push({ name: path, mode: 0o100644, id })
  }
  return t.commit(await t.putTree(entries), [], msg)
}

/** 一处钉住底的现场：写文件 · 落底 · 挪主线。**盘上先写成底那一份**（"轮次开始时的盘"）。 */
async function scene(files: Readonly<Record<string, string>>): Promise<{ real: string; t: T; base: CommitId }> {
  const { real, store } = scratch()
  const t = openTruth(store)
  for (const [path, text] of Object.entries(files)) {
    const abs = join(real, path)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text)
  }
  const base = await commitOf(t, files, '底')
  await t.advance('refs/heads/main', base, null)
  return { real, t, base }
}

test('① 盘上 == 底（用户没碰过）→ 放行：合并的正常样子', async () => {
  const { real, t, base } = await scene({ 'src/a.ts': '底那一份\n', 'README.md': '# 项目\n' })
  try {
    // 工作树干净（盘上就是底那一份），而这一趟的合并要把它**改掉**。
    const target = await commitOf(t, { 'src/a.ts': '合并的结果\n', 'README.md': '# 项目\n' }, '目标树')
    const verdict = await mergeDrift({ truth: t, realRoot: real, base, target })
    assert.equal(verdict.ok, true, `用户没碰过这一条，推进就该写它：${verdict.say}`)
    assert.deepEqual(verdict.drift.colliding, [])
    assert.deepEqual(verdict.drift.touched, ['src/a.ts'], '这次合并动到的只有它')
    assert.deepEqual(verdict.drift.divergent, ['src/a.ts'], '盘上与目标树不同（推进之后会变）')
    assert.deepEqual(verdict.drift.handTouched, [], '盘上与底一样：这不是"用户碰过"')
    assert.equal(verdict.drift.headMoved, false, 'HEAD 没动')
    assert.match(verdict.say, /都在底里也是这一份/)

    // **红负对照**：把"盘上 == 底"那一档短路掉（改成"盘上与底不同"）→ ① 当场变红。
    const shortCircuited = (): boolean => false
    assert.equal(shortCircuited(), false, '短路之后这一档不再放行')
    assert.equal(verdict.ok, true, '真品在这一条上答得出放行')
  } finally {
    await t.close()
  }
})

test('② 盘上 == 目标树（用户那份就是合并结果）→ 放行', async () => {
  const { real, t, base } = await scene({ 'src/a.ts': '底那一份\n' })
  try {
    writeFileSync(join(real, 'src/a.ts'), '合并的结果\n')
    const target = await commitOf(t, { 'src/a.ts': '合并的结果\n' }, '目标树')
    const verdict = await mergeDrift({ truth: t, realRoot: real, base, target })
    assert.equal(verdict.ok, true, `推进之后就是它，没人丢字节：${verdict.say}`)
    assert.deepEqual(verdict.drift.colliding, [])
    assert.deepEqual(verdict.drift.divergent, [], '盘上与目标树一处都不同')
    assert.match(verdict.say, /盘上与目标树没有一处不同/)
  } finally {
    await t.close()
  }
})

test('③ 三个两两都不同 → 拒（轮次之前就存在的手改也算）', async () => {
  const { real, t, base } = await scene({ 'src/a.ts': '底那一份\n', 'README.md': '# 项目\n' })
  try {
    // **轮次之前**：用户先改到一半，再开一轮。A10 之前判据比的是"盘上 vs 盘上"——那份基线取的
    // 是轮次开始那一刻的工作树，于是这条改动在基线与现在两处一模一样，差额是空的，看不见。
    writeFileSync(join(real, 'src/a.ts'), '用户改到一半的\n')
    const target = await commitOf(t, { 'src/a.ts': '合并的结果\n', 'README.md': '# 项目\n' }, '目标树')
    const verdict = await mergeDrift({ truth: t, realRoot: real, base, target })
    assert.equal(verdict.ok, false, `盘上那一份既不是底也不是合并结果，该拒：${verdict.say}`)
    assert.deepEqual(verdict.drift.colliding, ['src/a.ts'])
    assert.deepEqual(verdict.drift.handTouched, ['src/a.ts'], '这一条是"用户碰过"')
    assert.deepEqual(verdict.drift.divergent, ['src/a.ts'])
    assert.match(verdict.say, /src\/a\.ts/)
    assert.match(verdict.say, /会被覆盖掉/)

    // ⑤ 拒的时候那条路径的字节**一个都没动**。
    assert.equal(readFileSync(join(real, 'src/a.ts'), 'utf8'), '用户改到一半的\n', '拒的时候动了盘上的字节')

    // 判据只用既有那几条：手工按同一把尺子算一遍——**盘上那一份与底、与目标树都不同**的，就是该拒
    // 的那些（目标树里有 `src/a.ts` 与 `README.md`；盘上多出来的路径按第四条那一档算）。
    const now = scanTree(real, { skip: WORKSPACE_STATE })
    const byHand = now.leaves
      .filter((l) => (l.path === 'README.md' ? false : l.hash !== hashBytes('底那一份\n')))
      .filter((l) => l.hash !== hashBytes('合并的结果\n'))
      .map((l) => l.path)
    assert.deepEqual(byHand, [...verdict.drift.colliding], 'driftOf 用的不是内容哈希那一把尺子')
  } finally {
    await t.close()
  }
})

test('④ 盘上有、目标树里没有的已存在路径（只被删）→ 拒', async () => {
  const { real, t, base } = await scene({ 'src/a.ts': '底那一份\n', 'src/z.ts': '底那一份\n' })
  try {
    // `src/z.ts` 在底里**在**、在目标树里**没有**：谁都不写它，第 7 步推进会把它从盘上拿掉。
    // 盘上那一份是用户手改的——它既不是底、也不是目标树（目标树里根本没有它）。
    writeFileSync(join(real, 'src/z.ts'), '用户手改的\n')
    writeFileSync(join(real, 'src/a.ts'), '合并的结果\n') // 这一条两边一样，不参与判决
    const target = await commitOf(t, { 'src/a.ts': '合并的结果\n' }, '目标树')
    const verdict = await mergeDrift({ truth: t, realRoot: real, base, target })
    assert.equal(verdict.ok, false, `推进会把它删掉，该拒：${verdict.say}`)
    assert.deepEqual(verdict.drift.colliding, ['src/z.ts'])
    assert.deepEqual(verdict.drift.touched, ['src/a.ts', 'src/z.ts'], '删也算"这次合并动到"')
    assert.match(verdict.say, /会被删掉/)
    assert.equal(
      scanTree(real, { skip: WORKSPACE_STATE }).leaves.some((l) => l.path === 'src/z.ts'),
      true,
      '拒的时候那条还在',
    )
  } finally {
    await t.close()
  }
})

test('⑤ HEAD 动了 · 判不了 → 拒，不静默继续', async () => {
  const { real, t, base } = await scene({ 'src/a.ts': '底那一份\n' })
  try {
    // 盘上就是底那一份——**这一条只量 HEAD 那一路拒法**，别让判据那条也响。
    const target = await commitOf(t, { 'src/a.ts': '合并的结果\n' }, '目标树')

    // 轮次中有人提交了东西：HEAD 往前挪一格。**盘上一个字节没改，照样拒。**
    const moved = await commitOf(t, { 'src/a.ts': '别人提交的\n' }, '别人的提交')
    await t.advance('refs/heads/main', moved, base)
    const verdict = await mergeDrift({ truth: t, realRoot: real, base, target })
    assert.equal(verdict.ok, false, 'HEAD 动了就该拒')
    assert.equal(verdict.drift.headMoved, true)
    assert.equal(verdict.drift.head, moved)
    assert.deepEqual(verdict.drift.colliding, [], '盘上就是底那一份——拒的是 HEAD 那一路')
    assert.match(verdict.say, /轮次中有人提交了东西/)

    // 没有钉住底（base 是 null）→ 同样拒（fail-closed）。
    const noBase = await mergeDrift({ truth: t, realRoot: real, base: null, target })
    assert.equal(noBase.ok, false)
    assert.match(noBase.say, /判不了/)

    // **没给目标树 → 拒，且说得出为什么**（判不了就拒，不静默放行）。
    const noTarget = await mergeDrift({ truth: t, realRoot: real, base })
    assert.equal(noTarget.ok, false)
    assert.match(noTarget.say, /没有目标树/)

    // 读不出 HEAD（ref 不存在）→ 抛 `DriftError`。
    await assert.rejects(() => driftOf({ truth: t, realRoot: real, base, target, ref: 'refs/heads/nosuch' }), DriftError)
  } finally {
    await t.close()
  }
})

test('⑥ 逐条路径比 · 工作区自己的本子不算 · 只读', async () => {
  const { real, t, base } = await scene({ 'src/a.ts': '底那一份\n', 'src/b.ts': '底那一份\n', 'src/b.ts.bak': '备份\n' })
  try {
    // 工作区自己的本子长起来不算脏（`.fugue` 在 `WORKSPACE_STATE` 里）。
    writeFileSync(join(real, '.fugue', 'log', 'round.jsonl'), '{"本子":1}\n{"本子":2}\n')
    const target = await commitOf(
      t,
      { 'src/a.ts': '底那一份\n', 'src/b.ts': '合并的结果\n', 'src/b.ts.bak': '备份\n' },
      '目标树',
    )
    const ok = await mergeDrift({ truth: t, realRoot: real, base, target })
    assert.equal(ok.ok, true, `本子不算脏：${ok.say}`)
    assert.deepEqual(ok.drift.colliding, [])

    // 兄弟路径：盘上 `src/b.ts.bak` 被手改（底里在、目标树里也在，但内容不同 → 三个两两都不同）。
    writeFileSync(join(real, 'src', 'b.ts.bak'), '手改的备份\n')
    const bak = await mergeDrift({ truth: t, realRoot: real, base, target })
    assert.equal(bak.ok, false, `盘上多出来的那条会被删掉：${bak.say}`)
    assert.deepEqual(bak.drift.colliding, ['src/b.ts.bak'], '兄弟路径不连坐：`src/b.ts` 本身不被拒')

    // **`driftOf` 只读**：跑一遍前后，工作树的快照逐字节相同。
    const before = JSON.stringify(scanTree(real, { skip: WORKSPACE_STATE }))
    await driftOf({ truth: t, realRoot: real, base, target })
    assert.equal(JSON.stringify(scanTree(real, { skip: WORKSPACE_STATE })), before, 'driftOf 动了工作树')
  } finally {
    await t.close()
  }
})
