// tier: real —— 生成的真实 Git / 日志 / View，验证语义拒绝之前没有持久写入。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstat, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { assertRefusedWithoutMutation } from '../../test/helpers/refusal.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { Delta } from '../delta.ts'
import { openLog } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { applyEdit } from './edit.ts'
import { lowerAt } from './lower.ts'
import { loadView } from './view.ts'

const WRITER = 'refusal'
const bytes = Buffer.from('refused bytes never persisted\0')
const cases: { name: string; delta: Delta; reason: RegExp }[] = [
  { name: '父路径是上层文件', delta: { kind: 'add', path: 'upper/child', bytes, mode: 0o100644 }, reason: /是一个 file/ },
  { name: '覆盖下层目录', delta: { kind: 'add', path: 'dir', bytes, mode: 0o100644 }, reason: /是一个目录/ },
  { name: '下层改名目标已存在，pin 也不能落下', delta: { kind: 'rename', from: 'source', to: 'occupied' }, reason: /已经存在/ },
  { name: '下层目录改名', delta: { kind: 'rename', from: 'dir', to: 'moved' }, reason: /目录改名/ },
  { name: '删除不存在的路径', delta: { kind: 'delete', path: 'missing' }, reason: /不存在/ },
  { name: '改下层目录权限', delta: { kind: 'chmod', path: 'dir', mode: 0o100755 }, reason: /只对文件有意义/ },
  { name: '改上层符号链接权限', delta: { kind: 'chmod', path: 'link', mode: 0o100755 }, reason: /符号链接没有意义/ },
]

for (const { name, delta, reason } of cases) {
  test(`统一拒绝断言：${name}`, async () => {
    const root = tmpDir('fugue-edit-refusal-')
    const init = spawnSync('git', ['init', '-q', root], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: root, LANG: 'C',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    assert.equal(init.status, 0, init.stderr)
    const truth = openTruth(root)
    let log: ReturnType<typeof openLog> | undefined
    try {
      log = openLog(root, { write: WRITER })
      const baseBytes = await truth.putBlob(Buffer.from('base'))
      const tree = await truth.putTree([
        { name: 'source', mode: 0o100644, id: baseBytes },
        { name: 'occupied', mode: 0o100644, id: baseBytes },
        { name: 'dir/child', mode: 0o100644, id: baseBytes },
      ])
      const base = await truth.commit(tree, [], 'refusal fixture')
      const view = await loadView(log, WRITER, { lower: lowerAt(truth, base) })
      const target = { truth, log, view, writer: WRITER }
      // 初始化先完成：包含已取得的日志写者锁、已存在的日志与上层历史。
      await applyEdit(target, { kind: 'add', path: 'upper', bytes: Buffer.from('upper'), mode: 0o100644 })
      await applyEdit(target, { kind: 'symlink', path: 'link', target: 'outside' })
      assert.ok((await lstat(join(root, '.fugue', 'log', `${WRITER}.lock`))).isFile(),
        '快照之前已持有真实写者栅栏')
      await writeFile(join(root, 'human-file'), Buffer.from([0, 255]))
      await symlink('missing-outside-root', join(root, 'human-link'))
      let puts = 0
      const countedTruth = { ...truth, async putBlob(content: Uint8Array) {
        puts += 1
        return await truth.putBlob(content)
      } }
      await assertRefusedWithoutMutation(root, view,
        () => applyEdit({ ...target, truth: countedTruth }, delta), reason)
      assert.equal(puts, 0, '先校验所有 delta，连幂等 blob 写入也不开始')
    } finally {
      try { await log?.close() } finally { await truth.close() }
    }
  })
}
