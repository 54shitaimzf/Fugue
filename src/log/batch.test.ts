// 只读批次的**代**：断言（上一版拆件，批 2026-10-06）。出处：架构 § 9.11「服务端可以记住派生物」
// 那一段——「一次只读批次固定在一个代上（期间有写入就整批作废，**两代不拼接**）」·「可弃可重算」。
//
// 盯四条（每条都配一个对手）：
//
//   ① 批次报得出自己的代，而且**同一份账上重复取是同一串**（可重算：换一个进程重算，读出来的
//      东西逐字节不变）；
//   ② **期间写入 → 整批作废**（`BatchStaleError`）——**负对照**：把「代」的判据写反/去掉，
//      两代拼接那一档当场变成通过，这条断言就红了；
//   ③ 弃掉重建之后，同一趟读出来的东西逐字节相同（可弃）；
//   ④ 空账也是一个代（空串）——不是「没有代」。
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { stdinOf, runCli } from '../../test/helpers/run-cli.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { BatchStaleError, batchOf, generationOf } from './batch.ts'

async function seededRoot(): Promise<{ dir: string; sys: string }> {
  const dir = tmpDir('fugue-batch-')
  const sys = join(dir, '.syshome')
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: dir }).status, 0)
  process.env.FUGUE_SYSTEM_DIR = sys
  try {
    const w = await runCli(['--root', dir, 'write', 'a.txt', '--stdin'], stdinOf('alpha\n'))
    assert.equal(w.code, 0, w.stderr)
  } finally {
    delete process.env.FUGUE_SYSTEM_DIR
  }
  return { dir, sys }
}

/** 一条写命令（把代推一下）。 */
async function write(root: { dir: string; sys: string }, name: string): Promise<void> {
  process.env.FUGUE_SYSTEM_DIR = root.sys
  try {
    const w = await runCli(['--root', root.dir, 'write', name, '--stdin'], stdinOf(`${name}\n`))
    assert.equal(w.code, 0, w.stderr)
  } finally {
    delete process.env.FUGUE_SYSTEM_DIR
  }
}

test('① 批次报得出自己的代；同一份账上重复取是同一串（可重算）', async () => {
  const root = await seededRoot()
  const a = batchOf(root.dir)
  const b = batchOf(root.dir)
  assert.notEqual(a.generation, '', '有账的时候代不是空串')
  assert.equal(a.generation, b.generation, '同一份账上两次取代是同一串')
  assert.equal(a.generation, generationOf(root.dir))
  const read = await a.read(() => 41 + 1)
  assert.equal(read, 42)
  // 弃掉重建：代照旧那一串
  assert.equal(batchOf(root.dir).generation, a.generation)
  console.log(`① 读数：代 = ${a.generation.split(',').join(' | ')}（两次取同一串）`)
})

test('② 期间写入 → 整批作废（负对照：判据反了就变成「两代拼接」）', async () => {
  const root = await seededRoot()
  const batch = batchOf(root.dir)
  const before = batch.generation
  // 这一批在读的中途出现了一次写入
  await assert.rejects(
    () =>
      batch.read(async () => {
        await write(root, 'b.txt')
        return '两代拼在一起的那一份'
      }),
    (err: unknown) => {
      assert.ok(err instanceof BatchStaleError, `要抛 BatchStaleError，拿到 ${String(err)}`)
      assert.equal(err.from, before)
      assert.notEqual(err.to, before)
      return true
    },
    '期间有写入，这一批必须整批作废',
  )
  // **负对照那一半**：清白的批次照旧通过（判据不是「一律作废」）
  const clean = await batchOf(root.dir).read(() => '同代的那一份')
  assert.equal(clean, '同代的那一份')
  console.log('② 读数：期间写入 → BatchStaleError（from/to 两串都在）；清白的批次照旧通过')
})

test('③ 弃掉重建之后，同一趟读出来逐字节相同（可弃）', async () => {
  const root = await seededRoot()
  const first = await batchOf(root.dir).read(() => generationOf(root.dir))
  const second = await batchOf(root.dir).read(() => generationOf(root.dir))
  assert.equal(first, second, '弃掉重建：读出来的东西逐字节不变')
  console.log('③ 读数：弃掉重建后代逐字节相同')
})

test('④ 空账也是一个代（空串），不是「没有代」', () => {
  const dir = tmpDir('fugue-batch-empty-')
  assert.equal(generationOf(dir), '')
  const b = batchOf(dir)
  assert.equal(b.generation, '')
  console.log('④ 读数：空账的代是空串（一条日志都没有）')
})
