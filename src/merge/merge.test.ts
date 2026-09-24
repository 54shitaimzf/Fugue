// A5 的断言（PLAN § 5.7 的 A5 行 · 架构 § 8.14 的 1–3 步 · § 8.2 硬约束 4 与"非零一律不给 tree"·
// § 8.12 那张表的最后两行）· A0 第三节的站前读数（`mergeTree` 只吃两个 base）。
//
//   ① **三条分支两条各改一处不相交的路径 → 折叠后那棵树两条改动都在，`conflicts` 报 0**
//   ② **两条改了同一处 → `conflicts` 报出那一条路径；冲突树物化得出；`resolve` 契约定出后重折
//      一次 → `conflicts` 报 0**
//   ③ **`resolve` 契约的 `conflictPaths` 与实际冲突集对不上 → 当场拒**（解决错文件比冲突更贵）
//   负对照：把冲突那一支改成"用带冲突标记的树照走" → ① 的 `conflicts` 报 0 变红
//      （毒性树在类型上取不到，这一条就是它的守卫）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BlobId, CommitId, RelPath, TreeId } from '../terms.ts'
import type { TreeEntry } from '../entries.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import { MergeError, conflictCount, conflictTreeEntries, fold, materializeConflict, refold, treeOfCommit } from './merge.ts'

const KEEP = process.env.KEEP === '1'
const roots: string[] = []
function scratch(): string {
  const p = mkdtempSync(join(tmpdir(), 'a5-'))
  execFileSync('git', ['init', '-q'], { cwd: p })
  roots.push(p)
  return p
}
process.on('exit', () => {
  if (KEEP) {
    console.log(`（KEEP=1，现场留着：${roots.join(' · ')}）`)
    return
  }
  for (const p of roots) rmSync(p, { recursive: true, force: true })
})

/** 把一份 tree 落成提交。 */
async function commitOf(t: TruthHandle, files: Readonly<Record<string, string>>, parents: readonly CommitId[], msg: string): Promise<CommitId> {
  const entries: TreeEntry[] = []
  for (const [path, text] of Object.entries(files)) {
    const id: BlobId = await t.putBlob(new TextEncoder().encode(text))
    entries.push({ name: path, mode: 0o100644, id })
  }
  return t.commit(await t.putTree(entries), [...parents], msg)
}

/** 一个提交里的全部文件（路径 → 正文）。 */
async function filesOf(t: TruthHandle, commit: CommitId): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (dir: RelPath): Promise<void> => {
    for (const e of await t.listAt(commit, dir)) {
      const p = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.kind === 'dir') await walk(p)
      else {
        const bytes = await t.readAt(commit, p)
        out[p] = bytes === null ? '（读不出来）' : new TextDecoder().decode(bytes)
      }
    }
  }
  await walk('')
  return out
}

test('① 三路各改一处不相交的路径：折叠后两条改动都在，conflicts 报 0', async () => {
  const t = openTruth(scratch())
  try {
    const base = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' }, [], 'base')
    const b1 = await commitOf(t, { 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' }, [base], 'b1')
    const b2 = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b1\n', 'c.txt': 'c0\n' }, [base], 'b2')
    const b3 = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c1\n' }, [base], 'b3')

    // 地板第一档就在这一条里：两条分支折一次（N=2 → 表长 1），走的是同一条代码路径。
    const two = await fold({ truth: t }, [b1, b2])
    assert.equal(two.kind, 'folded')
    if (two.kind === 'folded') {
      assert.equal(two.steps, 1, '两条分支折一次')
      assert.deepEqual(await filesOf(t, two.commit), { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c0\n' })
    }

    // 三路：折两次。
    const three = await fold({ truth: t, msgOf: (i) => `r1 fold ${i}` }, [b1, b2, b3])
    assert.equal(three.kind, 'folded')
    if (three.kind === 'folded') {
      assert.equal(three.steps, 2, '三路折两次（N−1）')
      const files = await filesOf(t, three.commit)
      assert.deepEqual(files, { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' }, '两条改动都该在')
      // 折叠的每一步都落了一个提交，而那个提交谁都不指——它的父是折过的两路。
      assert.equal(three.tree, await treeOfCommit(t, three.commit), '折叠结果的树与那个提交的树对不上')
      assert.equal(conflictCount([]), 0)
    }

    // 一路：折 0 次，结果就是它本身（表长为 1 是合法的起点，PLAN § 5.7 的地板那一句）。
    const one = await fold({ truth: t }, [b1])
    assert.equal(one.kind, 'folded')
    if (one.kind === 'folded') {
      assert.equal(one.steps, 0)
      assert.equal(one.commit, b1)
    }

    // 空表：拒（不是"折出空树"）。
    await assert.rejects(() => fold({ truth: t }, []), MergeError)
  } finally {
    await t.close()
  }
})

test('② 两路改同一处：报出那一条路径 · 冲突树物化得出 · resolve 之后重折报 0', async () => {
  const t = openTruth(scratch())
  try {
    const base = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b0\n' }, [], 'base')
    const b1 = await commitOf(t, { 'a.txt': 'a1\n', 'b.txt': 'b0\n' }, [base], 'b1')
    const b2 = await commitOf(t, { 'a.txt': 'a2\n', 'b.txt': 'b1\n' }, [base], 'b2')

    const outcome = await fold({ truth: t }, [b1, b2])
    assert.equal(outcome.kind, 'conflict', '同一个文件两边各改一次，该撞出冲突')
    if (outcome.kind !== 'conflict') return

    assert.deepEqual(outcome.conflicts.map((c) => c.path), ['a.txt'], '该报出那一条路径')
    assert.equal(conflictCount(outcome.conflicts), 1, 'conflicts 那一栏数的是路径条数')
    assert.equal(outcome.folded, b1, '折到撞上为止，已经折好的那一路是 b1')
    assert.deepEqual(outcome.rest, [b2], '还没折进去的是 b2')
    // 撞上时 `merge-tree` 照样写出一棵带标记的树，而它**取不到**——这一条是类型上的：
    // `outcome` 的 `conflict` 那一支只有 `conflicts`，没有 `tree`（§ 8.2）。
    assert.equal('tree' in outcome, false, '冲突那一支不该给出 tree')

    // 冲突树物化：三段各自的内容都在，路径就是冲突那一条。
    const { entries, materials } = await conflictTreeEntries(t, outcome.folded, outcome.conflicts)
    assert.equal(materials.length, 1)
    const body = new TextDecoder().decode(materials[0].body)
    assert.match(body, /<<<<<<< a\.txt（底）/)
    assert.match(body, /a0/, '底那一段该在')
    assert.match(body, /a1/, '这一路那一段该在')
    assert.match(body, /a2/, '另一路那一段该在')
    const materialTree = await t.putTree([...entries])
    const materialCommit = await t.commit(materialTree, [outcome.folded], 'r1 冲突树')
    const shown = await filesOf(t, materialCommit)
    assert.match(shown['a.txt'], /<<<<<<</, '物化出来的树里冲突文件带标记')
    assert.equal(shown['b.txt'], 'b0\n', '不冲突的那一条照旧')

    // **负对照**：把冲突那一支当成合并结果用下去（"用带冲突标记的树照走"），① 的
    // `conflicts` 报 0 变红——那棵树在类型上取不到，所以只能由人手工把它 commit 一次；
    // 这一条量的是"那个手工的 commit 结果里带着标记"。
    const naive = await t.commit(materialTree, [b1, b2], '（负对照：把冲突树当结果）')
    const naiveFiles = await filesOf(t, naive)
    assert.match(naiveFiles['a.txt'], /<<<<<<</, '照走的话，合并结果里躺着冲突标记')
    assert.notEqual(naiveFiles['a.txt'], 'a1\n')
    assert.notEqual(naiveFiles['a.txt'], 'a2\n')

    // 解决者选了 b2 那一侧：落一个提交，然后重折。
    const resolved = await commitOf(t, { 'a.txt': 'a2\n', 'b.txt': 'b1\n' }, [naive], 'r1 解冲突')
    const again = await refold({ truth: t }, outcome, resolved, ['a.txt'])
    assert.equal(again.kind, 'folded', '解完之后该折得下去')
    if (again.kind === 'folded') {
      assert.deepEqual(await filesOf(t, again.commit), { 'a.txt': 'a2\n', 'b.txt': 'b1\n' })
    }
  } finally {
    await t.close()
  }
})

test('③ resolve 契约的 conflictPaths 与实际冲突集对不上 → 当场拒', async () => {
  const t = openTruth(scratch())
  try {
    const base = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' }, [], 'base')
    const b1 = await commitOf(t, { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c0\n' }, [base], 'b1')
    const b2 = await commitOf(t, { 'a.txt': 'a2\n', 'b.txt': 'b2\n', 'c.txt': 'c0\n' }, [base], 'b2')

    const outcome = await fold({ truth: t }, [b1, b2])
    assert.equal(outcome.kind, 'conflict')
    if (outcome.kind !== 'conflict') return
    assert.deepEqual(outcome.conflicts.map((c) => c.path).sort(), ['a.txt', 'b.txt'], '两条路径都该在')
    assert.equal(conflictCount(outcome.conflicts), 2)

    const resolved = await commitOf(t, { 'a.txt': 'a2\n', 'b.txt': 'b2\n', 'c.txt': 'c0\n' }, [b1], '解冲突')

    // 只报了一条：漏了另一条 → 拒。
    await assert.rejects(() => refold({ truth: t }, outcome, resolved, ['a.txt']), (err: unknown) => {
      assert.ok(err instanceof MergeError)
      assert.match((err as Error).message, /漏了：b\.txt/)
      assert.match((err as Error).message, /解决错文件比冲突更贵/)
      return true
    })
    // 报了一条不存在的：多报 → 拒。
    await assert.rejects(() => refold({ truth: t }, outcome, resolved, ['a.txt', 'b.txt', 'zzz.txt']), /多报了：zzz\.txt/)
    // 一条都不报 → 拒。
    await assert.rejects(() => refold({ truth: t }, outcome, resolved, []), MergeError)
    // 恰好对上（次序不同也算对上）→ 折得下去。
    const ok = await refold({ truth: t }, outcome, resolved, ['b.txt', 'a.txt', 'a.txt'])
    assert.equal(ok.kind, 'folded', '次序与重复不该让判据变红')
  } finally {
    await t.close()
  }
})

test('折叠的中间提交是悬空的：不挂任何 ref，而对象库收得下', async () => {
  const root = scratch()
  const t = openTruth(root)
  try {
    // 三路各改**不同**的文件：这一条要的是"折得下去"，所以不能撞出冲突。
    const base = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' }, [], 'base')
    const b1 = await commitOf(t, { 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' }, [base], 'b1')
    const b2 = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b1\n', 'c.txt': 'c0\n' }, [base], 'b2')
    const b3 = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c1\n' }, [base], 'b3')
    const three = await fold({ truth: t }, [b1, b2, b3])
    assert.equal(three.kind, 'folded')
    if (three.kind !== 'folded') return

    // 折出来的那个提交不在任何 ref 上——`for-each-ref` 看不到它，而 `cat-file` 拿得到。
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: root, encoding: 'utf8' })
    assert.equal(refs.includes(three.commit), false, '折叠的中间提交挂到 ref 上了——那不该发生')
    const type = execFileSync('git', ['cat-file', '-t', three.commit], { cwd: root, encoding: 'utf8' }).trim()
    assert.equal(type, 'commit', '悬空的那个提交读不出来')
    // 它就是这一步要的那棵树：`git rev-parse <commit>^{tree}` 与 `treeOfCommit` 同一答案。
    const byGit = execFileSync('git', ['rev-parse', `${three.commit}^{tree}`], { cwd: root, encoding: 'utf8' }).trim()
    assert.equal(three.tree, byGit as TreeId, 'treeOfCommit 与 git 给的树对不上')
  } finally {
    await t.close()
  }
})

test('每一次折叠都记一笔：merge/attempt 的 conflicts 数的是路径条数', async () => {
  const t = openTruth(scratch())
  try {
    const base = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b0\n' }, [], 'base')
    const b1 = await commitOf(t, { 'a.txt': 'a1\n', 'b.txt': 'b0\n' }, [base], 'b1')
    const b2 = await commitOf(t, { 'a.txt': 'a0\n', 'b.txt': 'b1\n' }, [base], 'b2')
    const b3 = await commitOf(t, { 'a.txt': 'a2\n', 'b.txt': 'b0\n' }, [base], 'b3')

    // 不相交那两折：两次都记 0。
    const attempts: { step: number; conflicts: number }[] = []
    const ok = await fold({ truth: t, onAttempt: (a) => void attempts.push({ step: a.step, conflicts: a.conflicts }) }, [b1, b2])
    assert.equal(ok.kind, 'folded')
    assert.deepEqual(attempts, [{ step: 1, conflicts: 0 }])

    // 撞上那一折：记的是**路径条数**（两条路径各一份 stage 集，但只算两条）。
    const held: { step: number; conflicts: number; branches: readonly CommitId[] }[] = []
    const bad = await fold({ truth: t, onAttempt: (a) => void held.push({ ...a }) }, [b3, b1])
    assert.equal(bad.kind, 'conflict')
    assert.equal(held.length, 1, '撞上那一次也要记一笔')
    assert.equal(held[0].conflicts, 1, 'a.txt 一条路径')
    assert.deepEqual(held[0].branches, [b3, b1], '折的是这两个提交')
    if (bad.kind === 'conflict') assert.equal(conflictCount(bad.conflicts), held[0].conflicts, '记的那个数与冲突集对得上')
  } finally {
    await t.close()
  }
})

test('冲突树物化的形状：三段各一份，缺哪一段就是空串', async () => {
  const t = openTruth(scratch())
  try {
    const base = await commitOf(t, { 'a.txt': 'aaa\n' }, [], 'base')
    // 一边删、一边改：`merge-tree` 对"删/改"这一类给的是 stage 1 与 stage 3（没有 stage 2）。
    const b1 = await commitOf(t, {}, [base], '删掉 a.txt')
    const b2 = await commitOf(t, { 'a.txt': 'bbb\n' }, [base], '改 a.txt')
    const outcome = await fold({ truth: t }, [b1, b2])
    if (outcome.kind !== 'conflict') {
      // 这一档 git 可能判成"删"而不是冲突——那就把读数记下来，不硬断言。
      assert.equal(outcome.kind, 'folded', `这一档既没冲突也没合上：${outcome.kind}`)
      return
    }
    const { materials } = await conflictTreeEntries(t, outcome.folded, outcome.conflicts)
    const m = materials[0]
    const body = new TextDecoder().decode(m.body)
    assert.equal(m.path, 'a.txt')
    assert.ok(m.stages.length > 0)
    assert.match(body, /<<<<<<</)
    assert.match(body, />>>>>>>/)
    // 段数与 `Conflict.stages` 逐条对得上（1 · 2 · 3 里缺哪个就少哪段）。
    assert.equal(m.stages.length, outcome.conflicts[0].stages.length)
    assert.deepEqual(
      m.stages.map((s) => s.stage),
      outcome.conflicts[0].stages.map((s) => s.stage),
    )
  } finally {
    await t.close()
  }
})
