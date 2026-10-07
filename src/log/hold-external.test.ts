// `Hold` 外置的**断言**（上一版拆件，批 2026-10-06）。出处：施工单 § 五 ⑤ 第一件 · 决策材料
// § 2.4 选择 2 那句已批的拆件句——`LogOptions` 加一栏「已经拿到的 `Hold`」，`holdWriter` 的调用
// **可以离开 `openLog` 单独发生**；**不动 `Log` 的方法面**（架构 § 8.1 三个方法一个不增）。
//
// 盯四条，每条都点得出自己的对手：
//
//   ① `holdWriter` 拿到的 `Hold` 与 `openLog({write})` 拿到的是同一把（同一个锁文件）；
//   ② **`openLog` 收一把已经拿到的 `Hold`**：句柄照常写、`close()` 里放；跨 writer 追加当场拒；
//   ③ **「先拿全再开口」**：多 writer 的命令先一条条 `holdWriter` 拿全，再一条条开句柄——中途
//      撞上任何一把，**已经拿到的全部放掉**，先拿到的那一份日志一个字节都没写；
//   ④ **负对照**：把「全部放掉」那一圈拆掉（只当第二个 `holdWriter` 失败时不去放第一个），
//      ③ 的「锁不在盘上」当场红——这一条抓的就是「半放」。
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { logDir, openLog } from './log.ts'
import type { LogHandle } from './log.ts'
import { LogHeldError, holdWriter, lockFileOf } from './hold.ts'
import type { Hold } from './hold.ts'
import type { WriterId } from '../terms.ts'

/** 一次「要 N 把栅栏」的请求：先拿全，再开口（`openLog` 的 `hold` 那一栏）。 */
async function acquireAll(root: string, writers: readonly WriterId[]): Promise<LogHandle[]> {
  const holds: Hold[] = []
  try {
    for (const w of writers) holds.push(holdWriter(root, w))
  } catch (err) {
    // **已经拿到的全部放掉**（不留半份日志 · 不领重复序号）
    for (const h of holds) h.release()
    throw err
  }
  return holds.map((h) => openLog(root, { hold: h }))
}

/** 一份日志文件在不在（**写过一个字节没有**的证据）。 */
function logFileOf(root: string, writer: string): string {
  const parts = writer.split('/')
  return join(logDir(root), ...parts.slice(0, -1), `${parts.at(-1)}.jsonl`)
}

test('① `holdWriter` 拿到的与 `openLog({write})` 拿到的是同一把（同一个锁文件）', () => {
  const root = tmpDir('fugue-hold-')
  const held = holdWriter(root, 'round')
  assert.equal(held.path, lockFileOf(root, 'round'))
  assert.ok(existsSync(held.path))
  // 同一把已经在手：第二条路当场拒（`LogHeldError`），**并且报出持者的 pid**
  assert.throws(() => openLog(root, { write: 'round' }), (err: unknown) => {
    assert.ok(err instanceof LogHeldError)
    assert.equal(err.holder?.pid, process.pid)
    return true
  })
  held.release()
  const again = holdWriter(root, 'round')
  assert.ok(existsSync(again.path))
  again.release()
  console.log('① 读数：holdWriter 与 openLog({write}) 是同一把；拿住时第二条路报出持者 pid')
})

test('② `openLog` 收一把已经拿到的 `Hold`：照常写 · `close()` 里放 · 跨 writer 追加当场拒', async () => {
  const root = tmpDir('fugue-hold-')
  const hold = holdWriter(root, 'agent/r1/1')
  const log = openLog(root, { hold })
  const seq = await log.append('agent/r1/1' as WriterId, {
    t: 'run/start',
    agent: 'agent/r1/1',
    step: 's1',
    action: 'build',
    argv0: 'true',
  } as never)
  assert.equal(seq, 1)
  await assert.rejects(
    () => log.append('round' as WriterId, { t: 'ckpt/commit' } as never),
    /一次命令只写一个 writer/,
  )
  await log.close()
  assert.ok(!existsSync(hold.path), 'close() 里把锁放了')
  console.log('② 读数：外置的 Hold 经 openLog 照常写、照常放；跨 writer 追加当场拒')
})

test('③ 「先拿全再开口」：中途撞锁 → 已拿到的全部放掉 · 一个字节都没写', async () => {
  const root = tmpDir('fugue-hold-')
  // 另一条命令正写着 a2
  const busy = holdWriter(root, 'agent/r1/2')
  try {
    await assert.rejects(
      () => acquireAll(root, ['agent/r1/1' as WriterId, 'agent/r1/2' as WriterId]),
      (err: unknown) => {
        assert.ok(err instanceof LogHeldError, '撞锁是 LogHeldError')
        return true
      },
    )
    // **已经拿到的那一把全部放掉**：a1 的锁不在盘上
    assert.ok(!existsSync(lockFileOf(root, 'agent/r1/1')), '中途撞锁之后，先拿到的那一把要放掉')
    // **一个字节都没写**：a1 的那份日志根本没建起来
    assert.ok(!existsSync(logFileOf(root, 'agent/r1/1')), '先拿到的那一份日志一个字节都没写')
  } finally {
    busy.release()
  }
  console.log('③ 读数：中途撞锁 → 先拿到的那一把放掉、那一份日志一个字节都没写')
})

test('④ 负对照：把「全部放掉」那一圈拆掉 → ③ 的「锁不在盘上」当场红', async () => {
  const root = tmpDir('fugue-hold-')
  const busy = holdWriter(root, 'agent/r1/2')
  try {
    // 与 `acquireAll` 同一个现场，**只差收尾那一圈**（这就是「半放」）
    const holds: Hold[] = []
    try {
      for (const w of ['agent/r1/1', 'agent/r1/2'] as WriterId[]) holds.push(holdWriter(root, w))
      assert.fail('第二个 writer 应当撞锁')
    } catch (err) {
      assert.ok(err instanceof LogHeldError)
    }
    // 半放的现场：先拿到的那一把照旧在盘上——③ 的「全部放掉」那句在这一档上会红。
    assert.ok(
      existsSync(lockFileOf(root, 'agent/r1/1')),
      '半放这一档：先拿到的那一把留在盘上（③ 的全部放掉那一圈正是拆掉它就会红的那一处）',
    )
    // 收拾：把它放掉，两种现场分得开
    for (const h of holds) h.release()
    assert.ok(!existsSync(lockFileOf(root, 'agent/r1/1')), '全放之后锁不在盘上')
  } finally {
    busy.release()
  }
  console.log('④ 读数：半放那一档先拿到的锁留在盘上；全放之后不在——③ 抓到的是同一处')
})
