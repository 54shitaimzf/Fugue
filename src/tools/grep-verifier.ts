// 0.3.3: complete regex verification is a bounded, private concrete-host cache.
// No ToolHost fields, disk state or query/index activation are added here.
import { createHash } from 'node:crypto'
import type { BlobId, RelPath } from '../terms.ts'
import type { EntryMeta } from '../entries.ts'
import type { View } from '../view/contract.ts'
import type { ToolHost } from './execute.ts'
import { searchLines, SEARCH_PREFETCH_MAX_ROWS } from './search-receipt.ts'

export const MAX_VERIFICATION_SOURCE_BYTES = 1024 * 1024
export const MAX_VERIFICATION_RECORD_BYTES = 64 * 1024
export const MAX_VERIFICATION_MATCHES = 4096
export const MAX_VERIFICATION_BYTES = 2 * 1024 * 1024
export const MAX_VERIFICATION_ENTRIES = 1024
const MAX_PATTERN_UNITS = 4096
type Match = { readonly line: string; readonly number: number }
type Mark = Pick<View, 'base' | 'rev'>
type CacheRecord = { readonly matches: readonly Match[]; readonly bytes: number }
type Pattern = { readonly source: string; readonly flags: string }
export interface VerifiedGrepScan {
  readonly matches: Iterable<Match>
  /** Recheck after the tool's await, before consuming a cached negative. */
  current(): boolean
}
export interface VerifiedGrepBatch {
  /** Recheck immediately before prefetch elision, after candidate filtering awaits. */
  current(): boolean
  /** The same concrete metadata prefix policy, for an ordered subset of the original proof. */
  covered(paths: readonly string[]): number | undefined
}
type PrefixPlanner = {
  current(): boolean
  covered(metas: readonly EntryMeta[]): number | undefined
}
const prototype = RegExp.prototype
const test = prototype.test, exec = prototype.exec
const sourceOf = Object.getOwnPropertyDescriptor(prototype, 'source')!.get!
const flagGetters = ['hasIndices', 'global', 'ignoreCase', 'multiline', 'dotAll', 'unicode', 'unicodeSets', 'sticky']
  .map((name, at) => ({ get: Object.getOwnPropertyDescriptor(prototype, name)?.get, flag: 'dgimsuvy'[at]! }))
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!

function patternOf(re: RegExp): Pattern | null {
  try {
    if (Object.getPrototypeOf(re) !== prototype || Object.hasOwn(re, 'test') || Object.hasOwn(re, 'exec')) return null
    if (Object.getOwnPropertyDescriptor(prototype, 'test')?.value !== test || Object.getOwnPropertyDescriptor(prototype, 'exec')?.value !== exec) return null
    const source = sourceOf.call(re) as string
    const flags = flagGetters.filter(({ get }) => get?.call(re) === true).map(({ flag }) => flag).join('')
    if (source.length > MAX_PATTERN_UNITS || flags.includes('g') || flags.includes('y')) return null
    return { source, flags }
  } catch { return null }
}
function blobId(value: unknown): value is BlobId {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}
function matches(re: RegExp, text: string): Generator<Match> {
  return (function* () {
    for (const line of searchLines(text)) if (test.call(re, line.line)) yield line
  })()
}
interface Bound {
  readonly read: ToolHost['readBytes']
  scan(path: string, re: RegExp): Promise<VerifiedGrepScan | null | undefined>
  ready(paths: readonly string[], re: RegExp): Promise<VerifiedGrepBatch | undefined>
  stats(): { hits: number; misses: number; sourceReads: number; testedLines: number; verifiedSources: number; rejectedSources: number; installed: number; evictions: number; entries: number; bytes: number }
}
const hosts = new WeakMap<ToolHost, Bound>()

/** Construction-only binding. The exact object and its original reader own the cache. */
export function bindGrepVerifier(host: ToolHost, view: View, prefixPlanner?: PrefixPlanner): void {
  const read = host.readBytes
  let prefetch: ToolHost['prefetch']
  try { prefetch = host.prefetch } catch { prefetch = undefined }
  const cache = new Map<string, CacheRecord>()
  let bytes = 0
  const counts = { hits: 0, misses: 0, sourceReads: 0, testedLines: 0, verifiedSources: 0, rejectedSources: 0, installed: 0, evictions: 0 }
  const changed = (mark: Mark): boolean => {
    try { return view.base !== mark.base || view.rev !== mark.rev }
    catch { return true }
  }
  function install(key: string, record: CacheRecord): void {
    const prior = cache.get(key)
    if (prior !== undefined) { bytes -= prior.bytes; cache.delete(key) }
    while (cache.size >= MAX_VERIFICATION_ENTRIES || bytes + record.bytes > MAX_VERIFICATION_BYTES) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      bytes -= cache.get(oldest)!.bytes
      cache.delete(oldest); counts.evictions++
    }
    cache.set(key, record); bytes += record.bytes; counts.installed++
  }
  const bound: Bound = {
    read,
    async ready(paths, re) {
      // An empty cache has no proof; return before any additional metadata work for this batch.
      if (cache.size === 0 || prefixPlanner === undefined || typeof prefetch !== 'function') return undefined
      const pattern = patternOf(re)
      if (pattern === null) return undefined
      const captured: string[] = []
      let mark: Mark
      try {
        if (!Array.isArray(paths)) return undefined
        const count = paths.length
        if (!Number.isSafeInteger(count) || count <= 0 || count > SEARCH_PREFETCH_MAX_ROWS) return undefined
        for (let at = 0; at < count; at++) {
          if (!Object.hasOwn(paths, at)) return undefined
          const path = paths[at]
          if (typeof path !== 'string') return undefined
          captured.push(path)
        }
        mark = { base: view.base, rev: view.rev }
      } catch { return undefined }
      const keys: string[] = []
      const metas = new Map<string, EntryMeta>()
      const current = (): boolean => {
        try {
          const now = patternOf(re)
          return host.readBytes === read && host.prefetch === prefetch && prefixPlanner.current() && !changed(mark) && now?.source === pattern.source && now.flags === pattern.flags &&
            keys.every(key => cache.has(key))
        } catch { return false }
      }
      // Metadata-only proof of every original candidate: no source, index, prefetch or cache installation.
      try {
        for (const path of captured) {
          if (!current()) return undefined
          const meta = await view.stat(path as RelPath)
          if (!current() || meta?.kind !== 'file') return undefined
          const id = meta.id
          if (!blobId(id)) return undefined
          const size = meta.size, mode = meta.mode
          if (!Number.isSafeInteger(size) || size < 0) return undefined
          const key = JSON.stringify([id, pattern.source, pattern.flags])
          if (!cache.has(key)) return undefined
          const prior = metas.get(path)
          if (prior !== undefined && (prior.id !== id || prior.size !== size)) return undefined
          metas.set(path, { kind: 'file', id, size, mode })
          keys.push(key)
        }
      } catch { return undefined }
      const covered = (paths: readonly string[]): number | undefined => {
        try {
          if (!current() || !Array.isArray(paths)) return undefined
          const count = paths.length
          if (!Number.isSafeInteger(count) || count < 0 || count > captured.length) return undefined
          const selected: EntryMeta[] = []
          let at = 0
          for (let row = 0; row < count; row++) {
            if (!Object.hasOwn(paths, row)) return undefined
            const path = paths[row]
            while (at < captured.length && captured[at] !== path) at++
            if (at === captured.length) return undefined
            at++
            selected.push(metas.get(path)!)
          }
          const value = prefixPlanner.covered(selected)
          return current() && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= count ? value : undefined
        } catch { return undefined }
      }
      return current() ? { current, covered } : undefined
    },
    async scan(path, re) {
      const pattern = patternOf(re)
      if (pattern === null) return undefined
      let mark: Mark, blob: BlobId
      try {
        mark = { base: view.base, rev: view.rev }
        const meta = await view.stat(path as RelPath)
        if (changed(mark) || meta?.kind !== 'file') return undefined
        const id = meta.id
        if (!blobId(id)) return undefined
        blob = id
      } catch { return undefined }
      const current = (): boolean => {
        const now = patternOf(re)
        return host.readBytes === read && !changed(mark) && now?.source === pattern.source && now.flags === pattern.flags
      }
      if (!current()) return undefined
      const key = JSON.stringify([blob, pattern.source, pattern.flags])
      const hit = cache.get(key)
      if (hit !== undefined && !changed(mark)) {
        cache.delete(key); cache.set(key, hit); counts.hits++
        return { matches: hit.matches, current }
      }
      counts.misses++; counts.sourceReads++
      const got = await read.call(host, path)
      if (!current()) return undefined
      if (got === null) return null
      const source = got.bytes
      const length = lengthOf.call(source) as number
      const window = new Uint8Array(bufferOf.call(source), offsetOf.call(source), length)
      // The original reader already returned full bytes. Large/stale sources retain
      // the original lazy scanner, with no owned copy or hash work for this cache.
      if (length > MAX_VERIFICATION_SOURCE_BYTES || changed(mark)) return { matches: matches(re, Buffer.from(window.buffer, window.byteOffset, window.byteLength).toString('utf8')), current }
      const owned = Buffer.from(window)
      const text = owned.toString('utf8')
      return { current, matches: (function* () {
        let cost = 96 + key.length * 2
        let collected: Match[] | null = cost <= MAX_VERIFICATION_RECORD_BYTES ? [] : null
        for (const line of searchLines(text)) {
          counts.testedLines++
          if (!test.call(re, line.line)) continue
          if (collected !== null) {
            cost += 16 + line.line.length * 2
            if (cost > MAX_VERIFICATION_RECORD_BYTES || collected.length >= MAX_VERIFICATION_MATCHES) collected = null
            else collected.push(Object.freeze({ ...line }))
          }
          yield line
        }
        // Reaching this statement proves exhaustion. Consumer return()/throw()
        // (receipt early stop or files_with_matches) never installs partial rows.
        if (collected === null || !current()) return
        const hash = createHash(blob.length === 40 ? 'sha1' : 'sha256').update(`blob ${owned.byteLength}\0`).update(owned).digest('hex')
        if (hash !== blob) { counts.rejectedSources++; return }
        counts.verifiedSources++
        // V8 can retain the entire decoded source behind a tiny sliced line.
        // Detach only a complete, hash-verified, budget-admitted record. Lines
        // originated in UTF-8 decoding, so this owned UTF-8 round trip is exact.
        const detached = collected.map(line => Object.freeze({
          number: line.number, line: Buffer.from(line.line, 'utf8').toString('utf8'),
        }))
        install(key, { matches: Object.freeze(detached), bytes: cost })
      })() }
    },
    stats: () => ({ ...counts, entries: cache.size, bytes }),
  }
  hosts.set(host, bound)
}

/** Undefined means preserve the original generic/wrapped/replaced-reader path. */
export function verifiedGrepMatches(host: ToolHost, path: string, re: RegExp): Promise<VerifiedGrepScan | null | undefined> {
  const bound = hosts.get(host)
  return bound === undefined || host.readBytes !== bound.read ? Promise.resolve(undefined) : bound.scan(path, re)
}
/** Complete proof for every original batch candidate, never a loading verifier call. */
export function readyGrepBatch(host: ToolHost, paths: readonly string[], re: RegExp): Promise<VerifiedGrepBatch | undefined> {
  try {
    const bound = hosts.get(host)
    return bound === undefined || host.readBytes !== bound.read ? Promise.resolve(undefined) : bound.ready(paths, re)
  } catch { return Promise.resolve(undefined) }
}
/** A synchronous check lets unbound default hosts keep their original awaits. */
export function hasGrepVerifier(host: ToolHost): boolean {
  try {
    const bound = hosts.get(host)
    return bound !== undefined && host.readBytes === bound.read
  } catch { return false }
}
/** Developer observation only; no cache state is exposed through ToolHost. */
export function grepVerificationStats(host: ToolHost): ReturnType<Bound['stats']> | null {
  return hosts.get(host)?.stats() ?? null
}
