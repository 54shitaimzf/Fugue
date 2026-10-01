// ROADMAP § 4 / 0.3.1 · 派生索引落盘；所有失败退为 miss/未持久化，不阻断真源。
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { open, mkdir, lstat, readdir, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { BlobId } from '../terms.ts'
import { buildBlobIndex, decodeBlobIndex, encodeBlobIndex, IndexBudgetError, MAX_INDEX_BYTES } from './index-format.ts'
import type { BlobIndex } from './index-format.ts'

export interface IndexWrite {
  readonly index: BlobIndex | null
  /** 文件与目录 fsync 都成功才为 true；不表示候选查询已经接线。 */
  readonly stored: boolean
  /** 这份字节超出构建预算：永远建不出来，调用方可以记住、不再重读重建。读源失败等暂时故障不在此列。 */
  readonly unindexable?: boolean
}
export interface IndexStoreStats {
  /** 控制目录链整体不可用的次数。退档不全静默：区分「单条记录 miss」和「整盘缺席」。 */
  readonly directoryRefusals: number
  /** 发布/读取已经完成、只是回收目录描述符失败的次数；不改变 stored/读结果。 */
  readonly closeFailures: number
  /** 收走的无主临时对象个数（进程被杀留下的那些）。 */
  readonly sweptTemporaries: number
}
export interface IndexStoreStats {
  /** 控制目录链整体不可用的次数。退档不全静默：区分「单条记录 miss」和「整盘缺席」。 */
  readonly directoryRefusals: number
  /** 发布/读取已经完成、只是回收目录描述符失败的次数；不改变 stored/读结果。 */
  readonly closeFailures: number
  /** 收走的无主临时对象个数（进程被杀留下的那些）。 */
  readonly sweptTemporaries: number
}
export interface BlobIndexStore {
  read(blob: BlobId): Promise<BlobIndex | null>
  /** 只接真实原字节，不能把调用者传来的任意表直接存成可信构建结果。 */
  rebuild(blob: BlobId, bytes: Uint8Array, temporaryId?: string): Promise<IndexWrite>
  stats(): IndexStoreStats
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
function validId(blob: string): boolean { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blob) }
function ownedBy(meta: Stats): boolean {
  return typeof process.getuid === 'function' && meta.uid === process.getuid()
}
/**
 * 工作区根与 `.fugue` 由调用者和别的子系统按各自的 umask 建出：`umask 002` 下
 * `mkdir` 得到 0775，`src/config.ts` / `src/log/log.ts` 建 `.fugue` 也不带 mode。
 * 这两层只拒「其他人可写」——拒组可写等于在同组工作区上永久关掉整个磁盘索引。
 */
function sharedDir(meta: Stats): boolean { return ownedBy(meta) && (meta.mode & 0o002) === 0 }
/** `idx` / `v1` / `<分片>` 全由本模块以 `mode: 0o700` 创建（去位不受 umask 影响），必须恰好私有。 */
function privateDir(meta: Stats): boolean { return ownedBy(meta) && (meta.mode & 0o077) === 0 }
/** 记录与临时对象都由本模块以 0o600 创建，同样按「组和其他人一位都没有」判，不看 umask。 */
function safeLeaf(meta: Stats): boolean {
  return meta.isFile() && ownedBy(meta) && (meta.mode & 0o077) === 0 && meta.nlink === 1
}
function safeFile(meta: Stats): boolean {
  return safeLeaf(meta) && meta.size <= MAX_INDEX_BYTES
}
function self(directory: FileHandle): string { return `/proc/self/fd/${directory.fd}` }
function at(directory: FileHandle, name: string): string { return `${self(directory)}/${name}` }

interface ShardNotes { directoryRefusals: number; closeFailures: number; sweptTemporaries: number }
/** 回收描述符需要的最小面；收窄成这个形状，判据才能脱离 Linux 描述符锚直接断言。 */
interface Closable { close(): Promise<unknown> }
export interface ShardAttempt<T> {
  readonly outcome?: T
  readonly failure?: unknown
  readonly failed: boolean
  /** 控制目录链就没建起来（不含「还没创建」的 ENOENT）。 */
  readonly refused: boolean
}

/**
 * 先定下 run 的结局，再回收描述符。不能写成 `finally { … throw }`：`finally` 里
 * throw 会丢掉 try 的返回值，于是一次 rename 与 fsync 都已经成功的发布会退成
 * stored:false，run 自己的真实错因也会被关句柄的异常顶掉。原始错误优先；
 * 发布完成之后关句柄失败只记一笔，不改结果。导出只为让这条判据可直接断言。
 */
export async function settleShard<T>(attempt: ShardAttempt<T>, opened: readonly Closable[], notes?: ShardNotes): Promise<T> {
  const closed = await Promise.allSettled(opened.map((file) => file.close()))
  if (notes !== undefined) {
    if (attempt.refused) notes.directoryRefusals++
    notes.closeFailures += closed.filter((result) => result.status === 'rejected').length
  }
  if (attempt.failed) throw attempt.failure
  return attempt.outcome as T
}

/** 已知自建临时叶的收尾：原始操作错误优先，所有cleanup都尝试并逐个观察。 */
export async function settleOwnedTemporary<T>(
  attempt: Pick<ShardAttempt<T>, 'outcome' | 'failure' | 'failed'>,
  close: (() => Promise<unknown>) | undefined,
  remove: (() => Promise<unknown>) | undefined,
): Promise<T> {
  let failed = attempt.failed, failure = attempt.failure
  for (const cleanup of [close, remove]) {
    if (cleanup === undefined) continue
    try { await cleanup() }
    catch (error) { if (!failed) { failed = true; failure = error } }
  }
  if (failed) throw failure
  return attempt.outcome as T
}

/** Linux 描述符锚：每一层只开真实目录，后续操作不再重新解析用户的路径祖先。 */
async function withShard<T>(root: string, blob: BlobId, create: boolean, run: (dir: FileHandle) => Promise<T>, notes?: ShardNotes): Promise<T> {
  const opened: FileHandle[] = []
  let outcome: T | undefined
  let failure: unknown
  let failed = false
  let entered = false
  try {
    let directory = await open(root, DIR_FLAGS)
    opened.push(directory)
    const rootMeta = await directory.stat()
    if (!rootMeta.isDirectory() || !sharedDir(rootMeta)) throw new Error('index root is not a safe owned directory')
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
      const safe = name === '.fugue' ? sharedDir(meta) : privateDir(meta)
      if (!meta.isDirectory() || !safe) throw new Error('unsafe index directory')
    }
    entered = true
    outcome = await run(directory)
  } catch (error) { failed = true; failure = error }
  // 目录还不存在是正常的空缓存，不是拒绝；只记真正判不安全/够不到的那些。
  const refused = failed && !entered && (failure as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT'
  return await settleShard({ outcome, failure, failed, refused }, opened.reverse(), notes)
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

/**
 * 进程在 `open(O_EXCL)` 之后、`rename` 之前被 SIGKILL，就会留下一个最多 8 MiB 的
 * `.tmp-<pid>-<nonce>`：nonce 随进程消失、pid 也不再匹配，`cleanupIndexTemporary`
 * 永远认不出它，累积量随崩溃次数线性增长。发布成功之后顺手扫一次本分片——目录句柄
 * 已经在手里，代价为零。判据刻意保守：只动 `.tmp-` 前缀、`safeFile` 为真（普通文件 /
 * 本 uid / 单硬链接 / 不超记录预算）、而且 mtime 够老的叶。那条时限保证踩不到另一个
 * **正在**写的并发操作（包括同 pid 的另一个任务），「别人的临时文件一律不动」照旧成立。
 */
const STALE_TEMPORARY_MS = 60 * 60 * 1000
async function sweepStaleTemporaries(directory: FileHandle, keep: string, now: number): Promise<number> {
  let swept = 0
  for (const name of await readdir(self(directory))) {
    if (name === keep || !name.startsWith('.tmp-')) continue
    try {
      const meta = await lstat(at(directory, name))
      if (!safeFile(meta) || now - meta.mtimeMs < STALE_TEMPORARY_MS) continue
      await unlink(at(directory, name))
      swept++
    } catch { /* 并发已经收走、或者够不到：孤儿清理从来不是发布成功的前提。 */ }
  }
  return swept
}

async function replaceRecord(directory: FileHandle, blob: BlobId, bytes: Uint8Array, temporaryId?: string, notes?: ShardNotes): Promise<void> {
  if (temporaryId !== undefined && !/^[0-9a-f]{24}$/.test(temporaryId)) throw new Error("invalid index temporary ID")
  const target = at(directory, `${blob}.json`)
  try {
    const existing = await lstat(target)
    if (!safeLeaf(existing)) throw new Error('refuse unsafe existing index leaf')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const name = `.tmp-${process.pid}-${temporaryId ?? randomBytes(12).toString('hex')}`
  const temporary = at(directory, name)
  let file: FileHandle | undefined
  let created = false, failed = false
  let failure: unknown
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, target)
    created = false // 临时名称已被rename消耗；后来复用nonce的叶不属于本操作。
    await directory.sync()
    try { const swept = await sweepStaleTemporaries(directory, name, Date.now()); if (notes !== undefined) notes.sweptTemporaries += swept }
    catch { /* 扫不动不能把一次已经发布成功的记录退成 stored:false。 */ }
  } catch (error) { failed = true; failure = error }
  const remainingFile = file
  await settleOwnedTemporary({ failed, failure },
    remainingFile === undefined ? undefined : () => remainingFile.close(),
    created ? async () => {
      try { await unlink(temporary) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    } : undefined,
  )
}

/** 句柄不持长期 fd，不写日志、不修权限。共享可写/软链控制目录上磁盘索引直接缺席。 */
export function createBlobIndexStore(root: string): BlobIndexStore {
  const selectedRoot = resolve(root)
  const notes: ShardNotes = { directoryRefusals: 0, closeFailures: 0, sweptTemporaries: 0 }
  return {
    async read(blob) {
      if (!validId(blob)) return null
      try { return await withShard(selectedRoot, blob, false, (directory) => readRecord(directory, blob), notes) }
      catch { return null }
    },
    async rebuild(blob, bytes, temporaryId) {
      let index: BlobIndex
      try { index = buildBlobIndex(blob, bytes) }
      catch (error) { return error instanceof IndexBudgetError ? { index: null, stored: false, unindexable: true } : { index: null, stored: false } }
      try {
        const encoded = encodeBlobIndex(index)
        await withShard(selectedRoot, blob, true, (directory) => replaceRecord(directory, blob, encoded, temporaryId, notes), notes)
        return { index, stored: true }
      } catch { return { index, stored: false } }
    },
    stats() { return { directoryRefusals: notes.directoryRefusals, closeFailures: notes.closeFailures, sweptTemporaries: notes.sweptTemporaries } },
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
