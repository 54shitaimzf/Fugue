// 生成的测试工作区：拒绝必须保留路径、类型、模式、字节和链接目标。拒绝不等于 IO 故障。
import assert from 'node:assert/strict'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { View } from '../../src/view/contract.ts'

type TreeRow =
  | { path: string; kind: 'dir'; mode: number }
  | { path: string; kind: 'file'; mode: number; bytes: Buffer }
  | { path: string; kind: 'symlink'; mode: number; target: Buffer }

/** 不跟随符号链接；不比较读操作本身可能影响的 atime，也不把 inode 当产品状态。 */
export async function captureTree(root: string): Promise<TreeRow[]> {
  const rows: TreeRow[] = []
  async function visit(path: string): Promise<void> {
    const absolute = path === '' ? root : join(root, path)
    const meta = await lstat(absolute)
    const mode = meta.mode & 0o7777
    if (meta.isSymbolicLink()) {
      rows.push({ path, kind: 'symlink', mode, target: await readlink(absolute, { encoding: 'buffer' }) })
    } else if (meta.isFile()) {
      rows.push({ path, kind: 'file', mode, bytes: await readFile(absolute) })
    } else if (meta.isDirectory()) {
      rows.push({ path, kind: 'dir', mode })
      for (const name of (await readdir(absolute)).sort()) {
        await visit(path === '' ? name : `${path}/${name}`)
      }
    } else {
      throw new Error(`refusal fixture has unsupported file type: ${path}`)
    }
  }
  const rootMeta = await lstat(root)
  assert.ok(rootMeta.isDirectory(), 'refusal fixture root must be a real directory')
  await visit('')
  return rows
}

/** 只用于完成初始化且由测试独占的根；含 .git 与日志，不排除持久对象或锁文件。 */
export async function assertRefusedWithoutMutation(
  root: string,
  view: Pick<View, 'state' | 'diff'>,
  action: () => Promise<unknown>,
  reason: RegExp,
): Promise<void> {
  const tree = await captureTree(root)
  const state = structuredClone(view.state())
  const diff = structuredClone(view.diff())
  await assert.rejects(action, reason)
  assert.deepEqual(await captureTree(root), tree, 'semantic refusal mutated filesystem state')
  assert.deepEqual(structuredClone(view.state()), state, 'semantic refusal mutated view state/revision')
  assert.deepEqual(structuredClone(view.diff()), diff, 'semantic refusal mutated view history')
}
