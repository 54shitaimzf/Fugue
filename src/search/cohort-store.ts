// Optional immutable cohort cache: no v1 leaf changes, source IO, or default activation.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BlobId } from '../terms.ts'
import { cohortKey, decodeCohortIndex, encodeCohortIndex, MAX_COHORT_BLOBS, MAX_COHORT_BYTES } from './cohort-format.ts'
import type { CohortIndex } from './cohort-format.ts'

export interface CohortStoreStats {
  readonly reads: number
  readonly writes: number
  readonly bytesRead: number
  readonly stored: number
  readonly failures: number
  readonly closeFailures: number
  readonly active: number
  readonly closed: boolean
}
export interface CohortIndexStore {
  read(blobs: readonly BlobId[]): Promise<CohortIndex | null>
  write(index: CohortIndex, temporaryId?: string): Promise<boolean>
  /** Refuses new work immediately; observes every already admitted IO and cleanup. */
  close(): Promise<void>
  stats(): CohortStoreStats
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CHAIN = ['.fugue', 'idx', 'v1', 'cohorts'] as const
const MAX_PENDING = 4
function owned(meta: BigIntStats): boolean {
  return typeof process.getuid === 'function' && meta.uid === BigInt(process.getuid())
}
function safeDirectory(meta: BigIntStats, shared: boolean): boolean {
  return meta.isDirectory() && owned(meta) && (meta.mode & (shared ? 0o002n : 0o077n)) === 0n
}
function safeOwnedLeaf(meta: BigIntStats): boolean {
  return meta.isFile() && owned(meta) && meta.nlink === 1n && (meta.mode & 0o077n) === 0n
}
function safeLeaf(meta: BigIntStats): boolean {
  return safeOwnedLeaf(meta) && meta.size >= 0n && meta.size <= BigInt(MAX_COHORT_BYTES)
}
function sameIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.uid === after.uid &&
    before.mode === after.mode && before.nlink === after.nlink
}
function sameEpoch(before: BigIntStats, after: BigIntStats): boolean {
  return sameIdentity(before, after) && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}
function at(directory: FileHandle, name: string): string { return `/proc/self/fd/${directory.fd}/${name}` }

/** Dense bounded capture: never invoke an input iterator or retain mutable caller arrays. */
function snapshotIds(input: readonly BlobId[]): readonly BlobId[] | null {
  try {
    if (!Array.isArray(input)) return null
    const count = input.length
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COHORT_BLOBS) return null
    const ids: BlobId[] = []
    for (let i = 0; i < count; i++) {
      const id = input[i]
      if (typeof id !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) return null
      ids.push(id)
    }
    ids.sort()
    for (let i = 1; i < ids.length; i++) if (ids[i] === ids[i - 1]) return null
    return Object.freeze(ids)
  } catch { return null }
}

/** New store owns no lifetime descriptors and never sweeps unknown temporary names. */
export function createCohortIndexStore(root: string): CohortIndexStore {
  const selectedRoot = resolve(root)
  const active = new Set<Promise<void>>()
  let closed = false
  let closing: Promise<void> | undefined
  const counts = { reads: 0, writes: 0, bytesRead: 0, stored: 0, failures: 0, closeFailures: 0 }

  // Reserve before any codec/caller access. A reentrant close sees the reservation too.
  function admit<T>(fallback: T, run: () => Promise<T>): Promise<T> {
    if (closed || active.size >= MAX_PENDING) return Promise.resolve(fallback)
    let finish!: () => void
    const reservation = new Promise<void>(resolve => { finish = resolve })
    active.add(reservation)
    let result: Promise<T>
    try { result = run() }
    catch { result = Promise.resolve(fallback) }
    return result.catch(() => { counts.failures++; return fallback }).finally(() => {
      active.delete(reservation)
      finish()
    })
  }

  async function closeHandles(handles: readonly FileHandle[]): Promise<void> {
    const results = await Promise.allSettled(handles.map(handle => Promise.resolve().then(() => handle.close())))
    const failed = results.filter(result => result.status === 'rejected')
    counts.closeFailures += failed.length
    if (failed.length > 0) throw new Error('cohort descriptor cleanup failed')
  }

  async function withDirectory<T>(create: boolean, run: (directory: FileHandle) => Promise<T>): Promise<T> {
    const handles: FileHandle[] = []
    try {
      if (closed) throw new Error('cohort store closed')
      let directory = await open(selectedRoot, DIR_FLAGS)
      handles.push(directory)
      if (!safeDirectory(await directory.stat({ bigint: true }), true)) throw new Error('unsafe cohort root')
      for (const name of CHAIN) {
        if (closed) throw new Error('cohort store closed')
        if (create) {
          try { await mkdir(at(directory, name), { mode: 0o700 }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
          await directory.sync()
        }
        directory = await open(at(directory, name), DIR_FLAGS)
        handles.push(directory)
        if (!safeDirectory(await directory.stat({ bigint: true }), name === '.fugue')) throw new Error('unsafe cohort ancestor')
      }
      // Creating descendants legitimately changes their parent epochs; capture after setup.
      const before = await Promise.all(handles.map(handle => handle.stat({ bigint: true })))
      const result = await run(directory)
      if (closed) throw new Error('cohort store closed')
      const validate = (index: number, now: BigIntStats): boolean =>
        safeDirectory(now, index <= 1) &&
        (create && index === handles.length - 1 ? sameIdentity(before[index], now) : sameEpoch(before[index], now))
      for (let i = 0; i < handles.length; i++) {
        if (!validate(i, await handles[i].stat({ bigint: true }))) throw new Error('cohort ancestor epoch changed')
      }
      // Reopen the actual namespace; a surviving old inode is not enough after replacement.
      const current: FileHandle[] = []
      try {
        let selected = await open(selectedRoot, DIR_FLAGS)
        current.push(selected)
        if (!validate(0, await selected.stat({ bigint: true }))) throw new Error('cohort root binding changed')
        for (let i = 0; i < CHAIN.length; i++) {
          selected = await open(at(selected, CHAIN[i]), DIR_FLAGS)
          current.push(selected)
          if (!validate(i + 1, await selected.stat({ bigint: true }))) throw new Error('cohort namespace changed')
        }
      } finally { await closeHandles(current.reverse()) }
      return result
    } finally { await closeHandles(handles.reverse()) }
  }

  async function readFile(directory: FileHandle, key: string, ids: readonly BlobId[]): Promise<CohortIndex | null> {
    if (closed) return null
    const file = await open(at(directory, `${key}.bin`), READ_FLAGS)
    try {
      const before = await file.stat({ bigint: true })
      if (!safeLeaf(before)) return null
      const bytes = Buffer.alloc(Number(before.size) + 1)
      let used = 0
      while (used < bytes.length) {
        const { bytesRead } = await file.read(bytes, used, bytes.length - used, used)
        if (bytesRead === 0) break
        used += bytesRead
      }
      counts.bytesRead += used
      const after = await file.stat({ bigint: true })
      if (!safeLeaf(after) || !sameEpoch(before, after) || after.size !== before.size || BigInt(used) !== before.size) return null
      return decodeCohortIndex(bytes.subarray(0, used), ids)
    } finally { await closeHandles([file]) }
  }

  async function publish(directory: FileHandle, key: string, bytes: Uint8Array, nonce: string): Promise<void> {
    const target = at(directory, `${key}.bin`)
    // A too-large corrupt cache can be replaced without reading/allocating its old bytes.
    try { if (!safeOwnedLeaf(await lstat(target, { bigint: true }))) throw new Error('unsafe cohort destination') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temporary = at(directory, `.tmp-${process.pid}-${nonce}`)
    let file: FileHandle | undefined
    let temporaryIdentity: BigIntStats | undefined
    let created = false
    let failed = false
    let failure: unknown
    try {
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      temporaryIdentity = await file.stat({ bigint: true })
      if (!safeLeaf(temporaryIdentity)) throw new Error('unsafe new cohort temporary')
      const directoryEpoch = await directory.stat({ bigint: true })
      if (!safeDirectory(directoryEpoch, false)) throw new Error('unsafe cohort publication directory')
      await file.writeFile(bytes)
      if (closed) throw new Error('cohort store closed')
      await file.sync()
      await closeHandles([file])
      file = undefined
      if (closed) throw new Error('cohort store closed')
      if (!sameEpoch(directoryEpoch, await directory.stat({ bigint: true }))) throw new Error('cohort publication epoch changed')
      await rename(temporary, target)
      created = false // The name is consumed; a later same-nonce publisher owns its new leaf.
      await directory.sync()
    } catch (error) { failed = true; failure = error }
    // Persistent close rejection must not skip owned unlink; never remove foreign collisions.
    for (const cleanup of [file === undefined ? undefined : () => closeHandles([file!]),
      created && temporaryIdentity !== undefined ? async () => {
        try {
          const current = await lstat(temporary, { bigint: true })
          if (current.isFile() && owned(current) && current.nlink === 1n &&
            current.dev === temporaryIdentity!.dev && current.ino === temporaryIdentity!.ino) await unlink(temporary)
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      } : undefined]) {
      if (cleanup === undefined) continue
      try { await cleanup() }
      catch (error) { if (!failed) { failed = true; failure = error } }
    }
    if (failed) throw failure
  }

  return {
    read(input) {
      return admit(null, async () => {
        const ids = snapshotIds(input)
        if (ids === null || closed) return null
        const key = cohortKey(ids)
        if (key === null || !/^[0-9a-f]{64}$/.test(key)) return null
        counts.reads++
        return await withDirectory(false, directory => readFile(directory, key, ids))
      })
    },
    write(index, temporaryId) {
      return admit(false, async () => {
        const bytes = encodeCohortIndex(index)
        const ids = snapshotIds(index.blobs)
        const key = ids === null ? null : cohortKey(ids)
        const nonce = temporaryId ?? randomBytes(12).toString('hex')
        if (closed || key === null || key !== index.key || !/^[0-9a-f]{64}$/.test(key) ||
          typeof nonce !== 'string' || !/^[0-9a-f]{24}$/.test(nonce) || bytes.byteLength > MAX_COHORT_BYTES) return false
        counts.writes++
        await withDirectory(true, directory => publish(directory, key, bytes, nonce))
        counts.stored++
        return true
      })
    },
    close() {
      if (closing === undefined) {
        closed = true
        closing = Promise.all([...active]).then(() => undefined)
      }
      return closing
    },
    stats() { return { ...counts, active: active.size, closed } },
  }
}
