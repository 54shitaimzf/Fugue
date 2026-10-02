// tier: real —— §9.3 持久边界依赖真实 Git 进程；接缝异常不模拟掉电。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { Delta } from '../delta.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { BlobId, CommitId } from '../terms.ts'
import { openTruth } from '../truth/truth.ts'
import type { View } from './contract.ts'
import { applyEdit } from './edit.ts'
import { lowerAt } from './lower.ts'
import { loadView } from './view.ts'

const WRITER = 'stage'
const BYTES = Buffer.concat([Buffer.from('阶段内容\n', 'utf8'), Buffer.from([0, 255])])

/** 只替换一个接缝；其余方法仍绑定真实实例（View 的方法依赖 this）。 */
function replacing<T extends object>(port: T, replacements: Partial<T>): T {
  return new Proxy(port, {
    get(target, key) {
      if (Object.hasOwn(replacements, key)) return Reflect.get(replacements, key)
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function openBackends(root: string) {
  const truth = openTruth(root)
  try {
    const log = openLog(root)
    let closed = false
    return { truth, log, async close() {
      if (closed) return
      closed = true
      try { await log.close() } finally { await truth.close() }
    } }
  } catch (error) {
    await truth.close()
    throw error
  }
}

async function fixture(withBase = false) {
  const root = tmpDir('fugue-edit-stages-')
  const init = spawnSync('git', ['init', '-q', root], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  assert.equal(init.status, 0, init.stderr)
  const owned = await openBackends(root)
  try {
    const { truth, log } = owned
    let base: CommitId | null = null
    if (withBase) {
      const blob = await truth.putBlob(BYTES)
      const tree = await truth.putTree([{ name: 'source', mode: 0o100644, id: blob }])
      base = await truth.commit(tree, [], 'stage base')
    }
    const view = await loadView(log, WRITER, { lower: lowerAt(truth, base) })
    async function replay(inspect: (rows: LogEvent[], rebuilt: View) => Promise<void>) {
      // 关闭两个真实后端再新开：不允许原来的 blob / 日志缓存替持久证据兜底。
      await owned.close()
      const fresh = await openBackends(root)
      try {
        const rows: LogEvent[] = []
        for await (const row of fresh.log.readByWriter(WRITER)) rows.push(row)
        const rebuilt = await loadView(fresh.log, WRITER, { lower: lowerAt(fresh.truth, base) })
        await inspect(rows, rebuilt)
      } finally { await fresh.close() }
    }
    return { root, ...owned, view, replay }
  } catch (error) {
    await owned.close()
    throw error
  }
}

test('blob 已写而日志未写：孤儿对象可读，活视图与重放都没有路径', async () => {
  const f = await fixture()
  const stopped = new Error('after blob, before log')
  let blob: BlobId | undefined
  let appends = 0
  try {
    const truth = replacing(f.truth, { async putBlob(bytes) {
      blob = await f.truth.putBlob(bytes)
      throw stopped
    } })
    const log = replacing(f.log, { async append(writer, event) {
      appends += 1
      return await f.log.append(writer, event)
    } })
    await assert.rejects(applyEdit({ truth, log, view: f.view, writer: WRITER }, {
      kind: 'add', path: 'new', bytes: BYTES, mode: 0o100644,
    }), (error) => error === stopped)
    assert.equal(appends, 0)
    assert.equal(f.view.rev, 0)
    assert.equal(await f.view.read('new'), null)
    await f.replay(async (rows, rebuilt) => {
      assert.deepEqual(rows, [])
      assert.equal(rebuilt.rev, 0)
      assert.equal(await rebuilt.read('new'), null)
    })
    assert.ok(blob, '真实 putBlob 必须先返回持久对象的 ID')
    const fresh = openTruth(f.root)
    try { assert.deepEqual(Buffer.from(await fresh.getBlob(blob)), BYTES) }
    finally { await fresh.close() }
  } finally { await f.close() }
})

test('日志已写但确认失败：旧内存未改，新后端按完整行恢复全部字节', async () => {
  const f = await fixture()
  const stopped = new Error('after log, before memory')
  try {
    const log = replacing(f.log, { async append(writer, event) {
      await f.log.append(writer, event)
      throw stopped
    } })
    await assert.rejects(applyEdit({ ...f, log, writer: WRITER }, {
      kind: 'add', path: 'new', bytes: BYTES, mode: 0o100755,
    }), (error) => error === stopped)
    assert.equal(f.view.rev, 0)
    assert.equal(await f.view.read('new'), null)
    await f.replay(async (rows, rebuilt) => {
      assert.deepEqual(rows.map((row) => row.t), ['view/write'])
      assert.equal(rebuilt.rev, 1)
      assert.deepEqual(Buffer.from((await rebuilt.read('new'))!), BYTES)
      assert.equal((await rebuilt.stat('new'))?.mode, 0o100755)
    })
  } finally { await f.close() }
})

test('日志确认后、内存应用前停止：重开后端恢复已提交的路径', async () => {
  const f = await fixture()
  const stopped = new Error('before applyDelta')
  let applies = 0
  try {
    const view = replacing(f.view, { async applyDelta() {
      applies += 1
      throw stopped
    } })
    await assert.rejects(applyEdit({ ...f, view, writer: WRITER }, {
      kind: 'add', path: 'new', bytes: BYTES, mode: 0o100644,
    }), (error) => error === stopped)
    assert.equal(applies, 1)
    assert.equal(f.view.rev, 0)
    assert.equal(await f.view.read('new'), null)
    await f.replay(async (rows, rebuilt) => {
      assert.deepEqual(rows.map((row) => row.t), ['view/write'])
      assert.equal(rebuilt.rev, 1)
      assert.deepEqual(Buffer.from((await rebuilt.read('new'))!), BYTES)
    })
  } finally { await f.close() }
})

for (const kind of ['rename', 'chmod'] as const) {
  for (const persistedRows of [1, 2]) {
    test(`下层 ${kind} 在第 ${persistedRows} 条已提交日志后停止：恢复完整前缀`, async () => {
      const f = await fixture(true)
      const stopped = new Error(`after row ${persistedRows}`)
      let appends = 0
      try {
        const log = replacing(f.log, { async append(writer, event) {
          const seq = await f.log.append(writer, event)
          if (++appends === persistedRows) throw stopped
          return seq
        } })
        const delta: Delta = kind === 'rename'
          ? { kind, from: 'source', to: 'destination' }
          : { kind, path: 'source', mode: 0o100755 }
        await assert.rejects(applyEdit({ ...f, log, writer: WRITER }, delta), (error) => error === stopped)
        assert.equal(appends, persistedRows)
        assert.equal(f.view.rev, 0)
        assert.equal(f.view.hasUpper('source'), false)
        assert.deepEqual(Buffer.from((await f.view.read('source'))!), BYTES)
        assert.equal(await f.view.read('destination'), null)
        assert.equal((await f.view.stat('source'))?.mode, 0o100644)

        await f.replay(async (rows, rebuilt) => {
          assert.deepEqual(rows.map((row) => row.t), persistedRows === 1
            ? ['view/write'] : ['view/write', `view/${kind}`])
          assert.equal(rebuilt.rev, persistedRows)
          if (kind === 'rename' && persistedRows === 2) {
            assert.equal(await rebuilt.read('source'), null)
            assert.deepEqual(Buffer.from((await rebuilt.read('destination'))!), BYTES)
          } else {
            assert.deepEqual(Buffer.from((await rebuilt.read('source'))!), BYTES)
            assert.equal(rebuilt.hasUpper('source'), true, '第一条 pin 已是历史，不是原子的改名/改权限')
            assert.equal((await rebuilt.stat('source'))?.mode,
              kind === 'chmod' && persistedRows === 2 ? 0o100755 : 0o100644)
          }
        })
      } finally { await f.close() }
    })
  }
}
