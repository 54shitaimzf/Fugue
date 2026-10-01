// ROADMAP § 4 / 0.3.1 · 派生索引落盘；所有失败退为 miss/未持久化，不阻断真源。
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { BlobId } from '../terms.ts'
import { buildBlobIndex, decodeBlobIndex, encodeBlobIndex, MAX_INDEX_BYTES } from './index-format.ts'
import type { BlobIndex } from './index-format.ts'

export interface IndexWrite {
  readonly index: BlobIndex | null
  /** 文件与目录 fsync 都成功才为 true；不表示候选查询已经接线。 */
  readonly stored: boolean
}
export interface BlobIndexStore {
  read(blob: BlobId): Promise<BlobIndex | null>
  /** 只接真实原字节，不能把调用者传来的任意表直接存成可信构建结果。 */
  rebuild(blob: BlobId, bytes: Uint8Array, temporaryId?: string): Promise<IndexWrite>
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
function validId(blob: string): boolean { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blob) }
function owned(meta: Stats): boolean {
  return typeof process.getuid === 'function' && meta.uid === process.getuid() && (meta.mode & 0o022) === 0
}
function safeLeaf(meta: Stats): boolean {
  return meta.isFile() && owned(meta) && meta.nlink === 1
}
function safeFile(meta: Stats): boolean {
  return safeLeaf(meta) && meta.size <= MAX_INDEX_BYTES
}
function at(directory: FileHandle, name: string): string { return `/proc/self/fd/${directory.fd}/${name}` }

/** Linux 描述符锚：每一层只开真实目录，后续操作不再重新解析用户的路径祖先。 */
async function withShard<T>(root: string, blob: BlobId, create: boolean, run: (dir: FileHandle) => Promise<T>): Promise<T> {
  const opened: FileHandle[] = []
  try {
    let directory = await open(root, DIR_FLAGS)
    opened.push(directory)
    const rootMeta = await directory.stat()
    if (!rootMeta.isDirectory() || !owned(rootMeta)) throw new Error('index root is not a safe owned directory')
    for (const name of ['.fugue', 'idx', 'v1', blob.slice(0, 2)]) {
      const path = at(directory, name)
      if (create) {
        try { await mkdir(path, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        // 并发创建者可能只完成 mkdir；已有链接也在自己的父目录里同步一次。
        await directory.sync()
      }
      directory = await open(path, DIR_FLAGS)
      opened.push(directory)
      const meta = await directory.stat()
      if (!meta.isDirectory() || !owned(meta)) throw new Error('unsafe index directory')
    }
    return await run(directory)
  } finally {
    const closed = await Promise.allSettled(opened.reverse().map((file) => file.close()))
    const failure = closed.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}

async function readRecord(directory: FileHandle, blob: BlobId): Promise<BlobIndex | null> {
  const file = await open(at(directory, `${blob}.json`), READ_FLAGS)
  try {
    const before = await file.stat()
    if (!safeFile(before)) return null
    // 多读一个字节，文件在读期间增长也不能突破记录预算或冒充完整读。
    const bytes = Buffer.alloc(before.size + 1)
    let used = 0
    while (used < bytes.byteLength) {
      const next = await file.read(bytes, used, bytes.byteLength - used, used)
      if (next.bytesRead === 0) break
      used += next.bytesRead
    }
    const after = await file.stat()
    if (!safeFile(after) || used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null
    return decodeBlobIndex(bytes.subarray(0, used), blob)
  } finally { await file.close() }
}

async function replaceRecord(directory: FileHandle, blob: BlobId, bytes: Uint8Array, temporaryId?: string): Promise<void> {
  if (temporaryId !== undefined && !/^[0-9a-f]{24}$/.test(temporaryId)) throw new Error("invalid index temporary ID")
  const target = at(directory, `${blob}.json`)
  try {
    const existing = await lstat(target)
    if (!safeLeaf(existing)) throw new Error('refuse unsafe existing index leaf')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = at(directory, `.tmp-${process.pid}-${temporaryId ?? randomBytes(12).toString('hex')}`)
  let file: FileHandle | undefined
  let created = false
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, target)
    await directory.sync()
  } finally {
    if (file !== undefined) await file.close()
    if (created) {
      try { await unlink(temporary) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
}

/** 句柄不持长期 fd，不写日志、不修权限。共享可写/软链控制目录上磁盘索引直接缺席。 */
export function createBlobIndexStore(root: string): BlobIndexStore {
  const selectedRoot = resolve(root)
  return {
    async read(blob) {
      if (!validId(blob)) return null
      try { return await withShard(selectedRoot, blob, false, (directory) => readRecord(directory, blob)) }
      catch { return null }
    },
    async rebuild(blob, bytes, temporaryId) {
      let index: BlobIndex
      try { index = buildBlobIndex(blob, bytes) }
      catch { return { index: null, stored: false } }
      try {
        const encoded = encodeBlobIndex(index)
        await withShard(selectedRoot, blob, true, (directory) => replaceRecord(directory, blob, encoded, temporaryId))
        return { index, stored: true }
      } catch { return { index, stored: false } }
    },
  }
}


/** 只清本进程为已知后台任务保留的临时叶；特殊/共享叶不碰。 */
export async function cleanupIndexTemporary(root: string, blob: BlobId, temporaryId: string): Promise<void> {
  if (!validId(blob) || !/^[0-9a-f]{24}$/.test(temporaryId)) return
  try {
    await withShard(resolve(root), blob, false, async (directory) => {
      const path = at(directory, `.tmp-${process.pid}-${temporaryId}`)
      const meta = await lstat(path)
      if (safeFile(meta)) await unlink(path)
    })
  } catch { /* 不存在/权限故障也是安全退档，不清其它文件。 */ }
}
