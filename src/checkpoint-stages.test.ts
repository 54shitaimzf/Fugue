// tier: real —— 真 Git / 日志接缝，观察 checkpoint 的对象 → CAS → 日志顺序。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { tmpDir } from '../test/helpers/tmp.ts'
import { checkpoint } from './checkpoint.ts'
import { refFor } from './identity.ts'
import { openLog } from './log/log.ts'
import type { CommitId, LogSeq, TreeId } from './terms.ts'
import { openTruth } from './truth/truth.ts'
import { applyEdit } from './view/edit.ts'
import { lowerFor } from './view/lower.ts'
import { snapshotOf } from './view/snapshot.ts'
import { loadView } from './view/view.ts'

const WRITER = 'checkpoint-stage'
const BYTES = Buffer.from([0, 255, 10, 65])

for (const stage of ['tree', 'object', 'cas-refused', 'cas-published', 'log-published'] as const) {
  test(`checkpoint ${stage} 停点：新后端只认已完成的 Git / M0 事实`, async () => {
    const root = tmpDir('fugue-checkpoint-stages-')
    const env = { PATH: process.env.PATH, HOME: root, LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8', env })
    assert.equal(init.status, 0, init.stderr)
    const truth = openTruth(root)
    let log: ReturnType<typeof openLog> | undefined
    let closed = false
    async function close() {
      if (closed) return
      closed = true
      try { await log?.close() } finally { await truth.close() }
    }
    try {
      log = openLog(root, { write: WRITER })
      const original = await truth.putBlob(Buffer.from('original'))
      const tree = await truth.putTree([{ name: 'original', mode: 0o100644, id: original }])
      const base = await truth.commit(tree, [], 'base')
      await truth.advance(refFor(WRITER), base, null)
      const view = await loadView(log, WRITER, { lower: await lowerFor(truth, WRITER) })
      await applyEdit({ truth, log, view, writer: WRITER }, {
        kind: 'add', path: 'added', bytes: BYTES, mode: 0o100755,
      })
      const stopped = new Error(`stop at ${stage}`)
      let createdTree: TreeId | undefined
      let created: CommitId | undefined
      let commitCalls = 0
      let casCalls = 0
      let logCalls = 0
      let persistedSeq: LogSeq | undefined
      const actualLog = log
      const faultTruth = { ...truth,
        async putTree(...args: Parameters<typeof truth.putTree>) {
          createdTree = await truth.putTree(...args)
          if (stage === 'tree') throw stopped
          return createdTree
        },
        async commit(...args: Parameters<typeof truth.commit>) {
          commitCalls += 1
          created = await truth.commit(...args)
          if (stage === 'object') throw stopped
          return created
        },
        async advance(...args: Parameters<typeof truth.advance>) {
          casCalls += 1
          if (stage === 'cas-refused') throw stopped
          await truth.advance(...args)
          if (stage === 'cas-published') throw stopped
        },
      }
      const faultLog = { ...log, async append(...args: Parameters<typeof actualLog.append>) {
        logCalls += 1
        persistedSeq = await actualLog.append(...args)
        throw stopped
      } }
      await assert.rejects(checkpoint({
        truth: faultTruth, log: faultLog, writer: WRITER,
        entries: await snapshotOf(view), rev: view.rev, msg: 'staged', expectedOld: base,
      }), (error) => error === stopped)
      assert.ok(createdTree, '真实树对象已完成')
      assert.equal(commitCalls, stage === 'tree' ? 0 : 1)
      if (stage === 'tree') assert.equal(created, undefined)
      else assert.ok(created, '真实提交对象已完成')

      // 清掉旧对象与日志缓存，新的读取不依赖故障调用者收到的返回值。
      await close()
      const freshTruth = openTruth(root)
      let freshLog: ReturnType<typeof openLog> | undefined
      try {
        freshLog = openLog(root)
        const published = stage === 'cas-published' || stage === 'log-published'
        assert.equal(await freshTruth.resolve(refFor(WRITER)), published ? created : base)
        const treeRead = spawnSync('git', ['--git-dir=' + join(root, '.git'),
          'ls-tree', '--name-only', createdTree], { encoding: 'utf8', env })
        assert.equal(treeRead.status, 0, treeRead.stderr)
        assert.equal(treeRead.stdout, 'added\noriginal\n', '孤儿树也在真实对象库内')
        if (created !== undefined) {
          assert.deepEqual(Buffer.from((await freshTruth.readAt(created, 'added'))!), BYTES,
            '未发布的提交也只是孤儿对象，不丢字节')
        }
        const rows = []
        for await (const row of freshLog.readByWriter(WRITER)) rows.push(row)
        assert.deepEqual(rows.map((row) => row.t), stage === 'log-published'
          ? ['view/write', 'ckpt/commit'] : ['view/write'])
        if (stage === 'log-published') {
          const row = rows[1]
          assert.equal(row.t, 'ckpt/commit')
          if (row.t === 'ckpt/commit') assert.equal(row.commit, created)
        }
        const rebuilt = await loadView(freshLog, WRITER, { lower: await lowerFor(freshTruth, WRITER) })
        assert.equal(rebuilt.rev, 1)
        assert.deepEqual(Buffer.from((await rebuilt.read('added'))!), BYTES)
        assert.equal((await rebuilt.stat('added'))?.mode, 0o100755)
        assert.equal(Buffer.from((await rebuilt.read('original'))!).toString(), 'original')
      } finally {
        try { await freshLog?.close() } finally { await freshTruth.close() }
      }
      assert.equal(casCalls, stage === 'tree' || stage === 'object' ? 0 : 1)
      assert.equal(logCalls, stage === 'log-published' ? 1 : 0)
      assert.equal(persistedSeq, stage === 'log-published' ? 2 : undefined)
    } finally {
      await close()
    }
  })
}
