// ROADMAP § 4 / 0.3.1 · 派生索引落盘；所有失败退为 miss/未持久化，不阻断真源。
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises'
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
  /** 内容地址已核验后超出构建预算，调用方可记住不再重建；未核源身份的接收拒绝、读源失败不在此列。 */
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
  /** 兼容既有统计字段；未知临时对象保守保留，目前恒为0。 */
  readonly sweptTemporaries: number
}
export interface BlobIndexStore {
  read(blob: BlobId): Promise<BlobIndex | null>
  /** 只接真实原字节，不能把调用者传来的任意表直接存成可信构建结果。 */
  rebuild(blob: BlobId, bytes: Uint8Array, temporaryId?: string): Promise<IndexWrite>
  stats(): IndexStoreStats
}

export interface BatchBlobIndexStore extends BlobIndexStore {
  /** null 表示整批不可用；数组内的 null 是单条 miss。无生命周期外 fd 留存。 */
  readBatch(blobs: readonly BlobId[]): Promise<readonly (BlobIndex | null)[] | null>
}
export const MAX_INDEX_BATCH_ROWS = 128
export const MAX_INDEX_BATCH_BYTES = 16 * 1024 * 1024
export const MAX_INDEX_BATCH_GRAMS = 1_000_000
const BATCH_LANES = 4
interface ReadBudget { bytes(size: number): boolean; grams(count: number): boolean }

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
function validId(blob: unknown): blob is BlobId { return typeof blob === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blob) }
/** 临时叶的 nonce：只认原始字符串（不对对象调 toString/强转），且恰好 24 位小写十六进制。 */
function validTemporaryId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value) }
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
  const closed = await Promise.allSettled(opened.map((file) => Promise.resolve().then(() => file.close())))
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

async function readRecord(directory: FileHandle, blob: BlobId, budget?: ReadBudget): Promise<BlobIndex | null> {
  const file = await open(at(directory, `${blob}.json`), READ_FLAGS)
  try {
    const before = await file.stat()
    if (!safeFile(before) || (budget !== undefined && !budget.bytes(before.size))) return null
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
    const index = decodeBlobIndex(bytes.subarray(0, used), blob)
    return index === null || (budget !== undefined && !budget.grams(index.tables.trigrams.length)) ? null : index
  } finally { await file.close() }
}

// 年龄、pid、nonce 均不能证明未知临时对象已无写者；只清自己认领的任务叶。
async function replaceRecord(directory: FileHandle, blob: BlobId, bytes: Uint8Array, temporaryId?: string): Promise<void> {
  if (temporaryId !== undefined && !validTemporaryId(temporaryId)) throw new Error("invalid index temporary ID")
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

function sameDirectory(before: Stats, after: Stats): boolean {
  return after.isDirectory() && ownedBy(after) && before.dev === after.dev && before.ino === after.ino &&
    before.uid === after.uid && before.mode === after.mode && before.nlink === after.nlink &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}

/** 仅本批共享固定祖先；每个 shard/leaf 保留原检查，结束前重核祖先 epoch 与 root 名称绑定。 */
async function readBatch(root: string, input: readonly BlobId[]): Promise<readonly (BlobIndex | null)[] | null> {
  const length = input.length
  if (!Array.isArray(input) || !Number.isSafeInteger(length) || length < 0 || length > MAX_INDEX_BATCH_ROWS) return null
  // 按已验证长度取稠密索引快照，不让自定义 iterator 扩大预算或无限分配。
  const ids = Array.from({ length }, (_, at) => input[at])
  if (ids.length === 0) return []
  if (ids.some(id => !validId(id))) return null
  const opened: FileHandle[] = []
  const before: Stats[] = []
  let usedBytes = 0, retainedGrams = 0
  const budget: ReadBudget = {
    bytes(size) { if (size > MAX_INDEX_BATCH_BYTES - usedBytes) return false; usedBytes += size; return true },
    grams(count) { if (count > MAX_INDEX_BATCH_GRAMS - retainedGrams) return false; retainedGrams += count; return true },
  }
  try {
    let directory = await open(root, DIR_FLAGS)
    opened.push(directory)
    const rootMeta = await directory.stat()
    if (!rootMeta.isDirectory() || !sharedDir(rootMeta)) return null
    before.push(rootMeta)
    for (const name of ['.fugue', 'idx', 'v1']) {
      directory = await open(at(directory, name), DIR_FLAGS)
      opened.push(directory)
      const meta = await directory.stat()
      // 与单条读同一套目录策略：根与 `.fugue` 只拒「其他人可写」（umask 002 的工作区照常），其余必须私有。
      if (!meta.isDirectory() || !(name === '.fugue' ? sharedDir(meta) : privateDir(meta))) return null
      before.push(meta)
    }
    const parent = directory
    const records: (BlobIndex | null)[] = Array(ids.length).fill(null)
    let next = 0
    const lane = async (): Promise<void> => {
      while (next < ids.length) {
        const index = next++
        let shard: FileHandle | undefined
        try {
          shard = await open(at(parent, ids[index].slice(0, 2)), DIR_FLAGS)
          const meta = await shard.stat()
          if (meta.isDirectory() && privateDir(meta)) records[index] = await readRecord(shard, ids[index], budget)
        } catch { records[index] = null }
        finally {
          if (shard !== undefined) {
            try { await shard.close() } catch { records[index] = null }
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BATCH_LANES, ids.length) }, lane))
    for (let index = 0; index < opened.length; index++) {
      if (!sameDirectory(before[index], await opened[index].stat())) return null
    }
    // 原 root 名称被替换/变软链时，不能只凭还活着的旧 inode 给出本批判断。
    const currentRoot = await open(root, DIR_FLAGS)
    try { if (!sameDirectory(before[0], await currentRoot.stat())) return null }
    finally { await currentRoot.close() }
    return records
  } catch { return null }
  finally {
    // 所有已打开祖先都尝试并观察关闭；任何关闭故障取消整批结果。
    const closed = await Promise.allSettled(opened.reverse().map(file => Promise.resolve().then(() => file.close())))
    const failure = closed.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}

/** 句柄不持长期 fd，不写日志、不修权限。共享可写/软链控制目录上磁盘索引直接缺席。 */
export function createBlobIndexStore(root: string): BatchBlobIndexStore {
  const selectedRoot = resolve(root)
  const notes: ShardNotes = { directoryRefusals: 0, closeFailures: 0, sweptTemporaries: 0 }
  return {
    async readBatch(blobs) {
      try { return await readBatch(selectedRoot, blobs) } catch { return null }
    },
    async read(blob) {
      if (!validId(blob)) return null
      try { return await withShard(selectedRoot, blob, false, (directory) => readRecord(directory, blob), notes) }
      catch { return null }
    },
    async rebuild(blob, bytes, temporaryId) {
      // 坏 nonce 在碰文件系统之前就拒（不建任何派生目录，也不对非原始值强转）。
      if (temporaryId !== undefined && !validTemporaryId(temporaryId)) return { index: null, stored: false }
      let index: BlobIndex
      try { index = buildBlobIndex(blob, bytes) }
      catch (error) { return error instanceof IndexBudgetError ? { index: null, stored: false, unindexable: true } : { index: null, stored: false } }
      try {
        const encoded = encodeBlobIndex(index)
        await withShard(selectedRoot, blob, true, (directory) => replaceRecord(directory, blob, encoded, temporaryId), notes)
        return { index, stored: true }
      } catch { return { index, stored: false } }
    },
    stats() { return { directoryRefusals: notes.directoryRefusals, closeFailures: notes.closeFailures, sweptTemporaries: notes.sweptTemporaries } },
  }
}


/**
 * Compatibility no-op: root/blob/PID/nonce identify a name, never ownership of its current leaf.
 * Only the exclusive creator's live replaceRecord operation may clean its unconsumed temporary.
 * Abruptly stopped workers can leave unknown derived temporaries; retain them conservatively.
 */
export async function cleanupIndexTemporary(_root: string, _blob: BlobId, _temporaryId: string): Promise<void> {
}
