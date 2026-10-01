import assert from 'node:assert/strict'
import { chmod, mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { assertRefusedWithoutMutation, captureTree } from './helpers/refusal.ts'
import { tmpDir } from './helpers/tmp.ts'

test('快照不跟随链接，逐项保留文件、目录、模式和链接目标', async () => {
  const root = tmpDir('fugue-refusal-tree-')
  const outside = tmpDir('fugue-refusal-outside-')
  await writeFile(join(outside, 'hidden'), 'outside')
  await mkdir(join(root, 'dir'))
  await chmod(join(root, 'dir'), 0o750)
  await writeFile(join(root, 'dir', 'bytes'), Buffer.from([0, 255, 10]))
  await chmod(join(root, 'dir', 'bytes'), 0o640)
  await symlink(outside, join(root, 'link'))
  await symlink('missing', join(root, 'dangling'))
  const rows = await captureTree(root)
  assert.deepEqual(rows.map((row) => row.path), ['', 'dangling', 'dir', 'dir/bytes', 'link'])
  assert.deepEqual(rows.find((row) => row.path === 'dir/bytes'), {
    path: 'dir/bytes', kind: 'file', mode: 0o640, bytes: Buffer.from([0, 255, 10]),
  })
  assert.deepEqual(rows.find((row) => row.path === 'dir'), { path: 'dir', kind: 'dir', mode: 0o750 })
  assert.equal(rows.find((row) => row.path === 'link')?.kind, 'symlink')
  const before = await captureTree(root)
  await writeFile(join(outside, 'hidden'), 'changed outside')
  assert.deepEqual(await captureTree(root), before, '外部链接目标的内容不属于工作区快照')
  await unlink(join(root, 'link'))
  await symlink('elsewhere', join(root, 'link'))
  assert.notDeepEqual(await captureTree(root), before, '链接目标变化可见')
})

test('负对照：字节、执行位、新路径和文件类型改变都改变快照', async () => {
  for (const change of ['bytes', 'mode', 'new', 'type']) {
    const root = tmpDir('fugue-refusal-negative-')
    const file = join(root, 'file')
    await writeFile(file, 'before')
    await chmod(file, 0o644)
    const before = await captureTree(root)
    if (change === 'bytes') await writeFile(file, 'after')
    if (change === 'mode') await chmod(file, 0o755)
    if (change === 'new') await writeFile(join(root, 'new'), 'new')
    if (change === 'type') {
      await unlink(file)
      await symlink('before', file)
    }
    assert.notDeepEqual(await captureTree(root), before, change)
  }
})

test('统一断言保留独立的 state/diff 副本，共享引用不能掩盖内存变化', async () => {
  for (const change of ['state', 'diff']) {
    const root = tmpDir('fugue-refusal-memory-')
    const state = { rev: 0, points: [], upper: [] }
    const history = [{ kind: 'add' as const, path: 'a', mode: 0o100644, bytes: Buffer.from('before') }]
    const view = { state: () => state, diff: () => history }
    await assert.rejects(() => assertRefusedWithoutMutation(root, view, async () => {
      if (change === 'state') state.rev = 1
      else history[0].bytes[0] = 0
      throw new Error('refused')
    }, /refused/), /semantic refusal mutated view/)
  }
})

test('统一断言抓住拒绝前的磁盘写入，且拒绝符号链接根', async () => {
  const root = tmpDir('fugue-refusal-write-')
  const view = { state: () => ({ rev: 0, points: [], upper: [] }), diff: () => [] }
  await assert.rejects(() => assertRefusedWithoutMutation(root, view, async () => {
    await writeFile(join(root, 'unexpected'), 'written before refusal')
    throw new Error('refused')
  }, /refused/), /semantic refusal mutated filesystem/)
  const other = tmpDir('fugue-refusal-root-link-')
  const alias = join(other, 'alias')
  await symlink(root, alias)
  await assert.rejects(() => captureTree(alias), /must be a real directory/)
})

test('链接目标按原始字节保存，两个无效 UTF8 目标不能折成同一份状态', async () => {
  const root = tmpDir('fugue-refusal-raw-link-')
  const link = join(root, 'link')
  await symlink(Buffer.from([255]), link)
  const before = await captureTree(root)
  assert.deepEqual(before.find((row) => row.path === 'link'), {
    path: 'link', kind: 'symlink', mode: 0o777, target: Buffer.from([255]),
  })
  await unlink(link)
  await symlink(Buffer.from([254]), link)
  assert.notDeepEqual(await captureTree(root), before)
})
