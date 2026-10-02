// 内容地址由真源给：**sha256 对象库上的判据**与它的负对照。出处：路线图维护批那一行 ③
// （`Entry` 带 git 发的 id · 视图不再自己算一份）。
//
// 这一份为什么非有不可：`tools/probe-hashfmt.sh` 那一行是取证读数（人跑 · 人读），而这一条挂在
// 常驻验收里——**同一个内容，视图给出去的 id 必须就是 git 给的那一把**。由头是一次真事故
// （`tools/probe-hashfmt.sh` 的那份读数）：视图原先按 sha1 自己算（`sha1("blob <n>\0" + 内容)`），
// 在 sha1 库里恰好对得上，在 sha256 库里 `mktree` 当场拒——两份都是"像 id 的字符串"，错的只有一处。
//
// **两把尺都测**：sha1 库是对照（两把尺在它上面同值，所以它单独证不了什么），sha256 库是判据
// 那一档。负对照把"按 sha1 自己算"的那一份直接喂给 `putTree`，看它是不是真的拒——不拒的话，
// 上面那条断言就抓不住"视图又自己算"这个变异。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { openLog } from '../log/log.ts'
import type { AgentId, BlobId, WriterId } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import { openTruth } from '../truth/truth.ts'
import { applyEdit } from './edit.ts'
import { lowerFor } from './lower.ts'
import { snapshotOf } from './snapshot.ts'
import { loadView } from './view.ts'

const AGENT = 'round' as AgentId

/** 一个空仓库，对象格式由参数定。**判据就在这一栏上**。 */
function tmpRepo(fmt: 'sha1' | 'sha256'): string {
  const root = tmpDir(`fugue-hashfmt-${fmt}-`)
  const init = spawnSync('git', ['init', '-q', `--object-format=${fmt}`, '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, `git init --object-format=${fmt} 没跑成：${init.stderr}`)
  return root
}

/** git 自己给的那把 id。**这一臂不经过产品的任何一行代码**——它才是"真源"。 */
function gitBlobId(root: string, bytes: Uint8Array): string {
  const r = spawnSync('git', ['-C', root, 'hash-object', '--stdin'], { input: Buffer.from(bytes) })
  assert.equal(r.status, 0, `git hash-object 没跑成：${String(r.stderr)}`)
  return r.stdout.toString('utf8').trim()
}

/** 旧口径：按 sha1 自己算一份。**只在负对照里出现**——产品里那一处已经删了。 */
function sha1Way(bytes: Uint8Array): string {
  const h = createHash('sha1')
  h.update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
  h.update(bytes)
  return h.digest('hex')
}

for (const fmt of ['sha1', 'sha256'] as const) {
  test(`条目带的 id 就是 git 给的那一把（${fmt} 库）：文件 · 软链 · 快照 · 重放四处同源`, async () => {
    const root = tmpRepo(fmt)
    const truth: Truth = openTruth(root)
    const log = openLog(root, { sync: 'never' })
    try {
      const view = await loadView(log, AGENT, { lower: await lowerFor(truth, AGENT) })
      const bytes = Buffer.from('第一版\n')
      // 产品的写路径本身（`view/edit.ts`：先 putBlob，再落日志，最后改内存）。
      await applyEdit({ log, truth, view, writer: AGENT as WriterId }, { kind: 'add', path: 'a.txt', bytes, mode: 0o100644 })
      await applyEdit({ log, truth, view, writer: AGENT as WriterId }, { kind: 'symlink', path: 'link', target: 'a.txt' })

      const want = gitBlobId(root, bytes)
      const linkWant = gitBlobId(root, Buffer.from('a.txt', 'utf8'))
      assert.equal(want.length, fmt === 'sha256' ? 64 : 40, 'git 给的 id 长度与这一档对不上——夹具本身不对')
      assert.notEqual(want, linkWant)
      assert.equal((await view.stat('a.txt'))?.id, want, '文件条目带的 id 不是 git 给的那一把')
      assert.equal((await view.stat('link'))?.id, linkWant, '软链条目带的 id 不是 git 给的那一把')
      assert.deepEqual(
        (await view.list('')).map((r) => r.id).sort(),
        [want, linkWant].sort(),
        '`list` 给出去的 id 与 `stat` 不是同一把',
      )
      // **树装得出来**：哈希格式探测那个红读数（`fatal: input format error`）的正面。
      await truth.putTree(await snapshotOf(view))
      // 快照那一面：折上层时带的是同一个 id（重放从它起，不再算一遍）。
      assert.deepEqual(
        view.state().upper.map((e) => (e.kind === 'file' ? e.blob : `（${e.kind}）`)),
        [want, '（symlink）'],
        '快照里文件那一条的 blob 不是同一把',
      )
      // 重放那一档：从日志重建——文件那条从事件里取 id，软链那条事件不带 id，问真源要。
      const again = await loadView(log, AGENT, { lower: await lowerFor(truth, AGENT) })
      assert.equal((await again.stat('a.txt'))?.id, want, '重放之后文件条目的 id 变了')
      assert.equal((await again.stat('link'))?.id, linkWant, '重放之后软链条目的 id 变了（它问的是真源）')
      await truth.putTree(await snapshotOf(again))
    } finally {
      log.close()
      await truth.close()
    }
  })
}

test('负对照：按 sha1 自己算的那一份在 sha256 库里装不出树', async () => {
  const root = tmpRepo('sha256')
  const truth: Truth = openTruth(root)
  try {
    const bytes = Buffer.from('第一版\n')
    const good = gitBlobId(root, bytes)
    const wrong = sha1Way(bytes)
    assert.notEqual(good, wrong, '两把尺在 sha256 库里本来就该不同——不同不了，这条负对照是空的')
    await truth.putBlob(bytes)
    // 好的那一份装得出来。
    await truth.putTree([{ name: 'a.txt', mode: 0o100644, id: good as BlobId }])
    // 旧的算法那一份装不出来——哈希格式探测实测的那句话就是它。
    await assert.rejects(
      () => truth.putTree([{ name: 'b.txt', mode: 0o100644, id: wrong as BlobId }]),
      /input format error/,
    )
  } finally {
    await truth.close()
  }
})
