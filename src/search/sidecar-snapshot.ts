// 开发侧sidecar决策探针：只取指定View，不把物理工作树冒充真源。
import { mkdir, writeFile, lstat, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { View } from '../view/contract.ts'

function capturePaths(paths: readonly string[]) {
  if (!Array.isArray(paths) || paths.length > 1024) throw new Error('snapshot file budget exceeded')
  const count = paths.length
  const captured: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < count; index++) {
    if (!Object.hasOwn(paths, index)) throw new Error('invalid snapshot path')
    const path = paths[index]
    if (typeof path !== 'string' || !path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(path)) {
      throw new Error('invalid snapshot path')
    }
    seen.add(path)
    captured.push(path)
  }
  return captured
}

export async function snapshotForSidecar(view: Pick<View, 'base' | 'rev' | 'stat' | 'read'>, paths: readonly string[], root: string) {
  const captured = capturePaths(paths)
  const selectedRoot = resolve(root)
  const base = view.base, rev = view.rev
  const directory = await lstat(selectedRoot)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0 || (await readdir(selectedRoot)).length !== 0) {
    throw new Error('snapshot requires an empty private owned directory')
  }
  let bytes = 0
  const current = () => {
    if (view.base !== base || view.rev !== rev) throw new Error('view changed during snapshot')
  }
  for (const path of captured) {
    current()
    const meta = await view.stat(path)
    if (meta?.kind !== 'file') throw new Error('snapshot only accepts current-view files')
    const body = await view.read(path)
    current()
    if (body === null) throw new Error('snapshot file disappeared')
    bytes += body.byteLength
    if (bytes > 32 * 1024 * 1024) throw new Error('snapshot byte budget exceeded')
    const owned = Uint8Array.from(body)
    const target = join(selectedRoot, path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, owned, { flag: 'wx', mode: 0o600 })
  }
  current()
  return { base, rev, bytes, files: captured.length }
}
