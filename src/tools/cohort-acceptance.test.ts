// tier: real —— 当前 View、真实 Git 对象、M0 重放与派生 cohort 的工具面合成。
import assert from 'node:assert/strict'
import { readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { truthViewFixture } from '../../test/helpers/truth-view.ts'
import { createCohortIndexStore } from '../search/cohort-store.ts'
import type { CohortIndexStore } from '../search/cohort-store.ts'
import { buildCohortIndex, cohortKey, encodeCohortIndex, MAX_COHORT_BYTES } from '../search/cohort-format.ts'
import { buildBlobIndex } from '../search/index-format.ts'
import { createViewCohortLookup } from '../search/view-cohort.ts'
import { createToolHost } from './host.ts'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'
import type { AgentId, BlobId, RelPath } from '../terms.ts'
import type { Delta } from '../delta.ts'

const grep = faceOf('grep')!
const mode = 0o100644
const corpus = { 'dir/hit.ts': 'before\r\nneedle\r\nneedle\r\nafter\r\n', 'dir/miss.ts': 'other\n',
  'alias.ts': 'before\r\nneedle\r\nneedle\r\nafter\r\n', emoji: '😀xy\n', invalid: Buffer.from([0xff, 0x61, 0x62, 10]),
  falsePositive: 'abc bcd cde def\n' }
type Fixture = Awaited<ReturnType<typeof truthViewFixture>>
type Target = Awaited<ReturnType<Fixture['target']>>
const context = (t: Target): ToolContext => ({ agent: t.writer as AgentId, step: 0, cwd: '', holder: false })
function attach(f: Fixture, t: Target, store: Pick<CohortIndexStore, 'read' | 'write'>, enumerate = () => t.plain.walk()) {
  const index = f.own(createViewCohortLookup(t.view, enumerate, store))
  return { index, host: createToolHost(t.view, f.roots, { cohortIndex: index }) }
}
async function ids(t: Target): Promise<BlobId[]> {
  const blobs = new Set<BlobId>()
  for (const path of await t.plain.walk()) {
    const meta = await t.view.stat(path as RelPath)
    if (meta?.kind === 'file') blobs.add(meta.id as BlobId)
  }
  return [...blobs].sort()
}
async function equalReceipt(t: Target, host: ToolHost, args: Record<string, unknown> = { pattern: 'needle' }) {
  const result = await grep(args, host, context(t))
  assert.deepEqual(result, await grep(args, t.plain, context(t)))
  return result
}
async function diverseReceipts(t: Target, host: ToolHost) {
  for (const args of [{ pattern: 'needle' }, { pattern: '^needle\\r?$' }, { pattern: 'nee.*le' },
    { pattern: '😀x' }, { pattern: '�ab' }, { pattern: 'abcdef' }, { pattern: 'needle|other' },
    { pattern: 'needle', path: 'dir', glob: '**/*.ts' }]) {
    for (const output_mode of ['content', 'count', 'files_with_matches']) await equalReceipt(t, host, { ...args, output_mode })
  }
}
function measured(host: ToolHost) {
  const reads: string[] = []
  return { reads, host: { ...host, readBytes: async (path: string) => { reads.push(path); return host.readBytes(path) } } }
}
function held<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}

test('fresh prepared artifacts serve exact tool receipts for two nonempty Views with shared IDs and isolated ownership', async () => {
  const f = await truthViewFixture(corpus)
  try {
    const store = f.own(createCohortIndexStore(f.root)), a = await f.target('a'), b = await f.target('b')
    await b.change({ kind: 'modify', path: 'dir/hit.ts', bytes: Buffer.from('quiet B\n'), mode })
    await b.change({ kind: 'modify', path: 'dir/miss.ts', bytes: Buffer.from('needle B\n'), mode })
    writeFileSync(join(f.root, 'ghost.ts'), 'needle HOST\n')
    for (const t of [a, b]) {
      const preparing = attach(f, t, store)
      assert.equal(await preparing.index.prepare(blob => f.truth.getBlob(blob)), true)
      assert.equal(preparing.index.stats().builds, 1)
    }
    const freshA = attach(f, a, store), freshB = attach(f, b, store)
    const checked = measured(freshA.host)
    const hit = await equalReceipt(a, checked.host)
    assert.deepEqual(checked.reads, ['alias.ts', 'dir/hit.ts'], 'distinct paths sharing one blob must both survive')
    assert.doesNotMatch(hit.output, /HOST|ghost.ts/)
    await diverseReceipts(a, freshA.host); await diverseReceipts(b, freshB.host)
    for (const { index } of [freshA, freshB]) {
      assert.equal(index.stats().diskReads, 1, 'one current-set artifact is shared across query batches/modes')
      assert.equal(index.stats().sourceReads, 0); assert.equal(index.stats().builds, 0)
    }
    const before = freshA.index.stats().queries
    const foreign = measured(createToolHost(b.view, f.roots, { cohortIndex: freshA.index }))
    const own = await equalReceipt(b, foreign.host)
    assert.deepEqual(foreign.reads, await b.plain.walk(), 'cross-View adapter attachment must scan')
    assert.match(own.output, /dir\/miss.ts:1:needle B/)
    assert.doesNotMatch(own.output, /dir\/hit.ts/)
    assert.equal(freshA.index.stats().queries, before)
    let legacyCalls = 0
    const combined = createToolHost(a.view, f.roots, { cohortIndex: freshA.index,
      blobIndex: { mightContain: async () => { legacyCalls++; return false } } })
    await equalReceipt(a, combined)
    assert.equal(legacyCalls, 0, 'a valid prepared cohort has explicit precedence over the optional v1 seam')
    assert.equal(a.plain.filterCandidates, undefined, 'default host remains scan-only')
  } finally { await f.close() }
})

test('rename, chmod, edits, whiteout/recreation and M0 replay preserve current View receipts across generations', async () => {
  const f = await truthViewFixture(corpus)
  try {
    const store = f.own(createCohortIndexStore(f.root)), a = await f.target('mutating'), b = await f.target('independent')
    const first = attach(f, a, store), other = attach(f, b, store)
    assert.equal(await first.index.prepare(blob => f.truth.getBlob(blob)), true)
    const unchanged = await equalReceipt(b, other.host)
    const sourceReads = first.index.stats().sourceReads, builds = first.index.stats().builds
    for (const delta of [
      { kind: 'rename', from: 'dir/hit.ts', to: 'renamed.ts' },
      { kind: 'chmod', path: 'renamed.ts', mode: 0o100755 },
      { kind: 'modify', path: 'dir/miss.ts', bytes: Buffer.from('needle edited\n'), mode },
      { kind: 'delete', path: 'dir' },
      { kind: 'add', path: 'dir/reborn.ts', bytes: Buffer.from('needle recreated\n'), mode },
      { kind: 'delete', path: 'alias.ts' },
    ] as Delta[]) {
      await a.change(delta)
      await diverseReceipts(a, first.host)
      assert.deepEqual(await equalReceipt(b, other.host), unchanged)
    }
    assert.equal(first.index.stats().sourceReads, sourceReads, 'generation misses never pay for source preparation')
    assert.equal(first.index.stats().builds, builds)
    assert.ok(first.index.stats().fallbacks > 0)
    assert.equal(await first.index.prepare(blob => f.truth.getBlob(blob)), true, 'explicit preparation resets cached generation miss')
    await a.log.close()
    const fresh = attach(f, a, store), replay = await f.target('mutating')
    assert.deepEqual(replay.view.state(), a.view.state()); assert.deepEqual(replay.view.diff(), a.view.diff())
    const replayed = attach(f, replay, store)
    await diverseReceipts(a, fresh.host); await diverseReceipts(replay, replayed.host)
    const live = await equalReceipt(a, fresh.host)
    assert.deepEqual(await equalReceipt(replay, replayed.host), live)
    assert.match(live.output, /dir\/reborn.ts:1:needle recreated/)
    assert.doesNotMatch(live.output, /dir\/hit.ts|dir\/miss.ts|alias.ts/)
    assert.equal(replayed.index.stats().sourceReads, 0); assert.equal(replayed.index.stats().diskReads, 1)
  } finally { await f.close() }
})

test('fresh missing/corrupt/oversize/unknown-version/wrong-set cohort records fail open without source or build work', async () => {
  const f = await truthViewFixture(corpus)
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('damage'), preparing = attach(f, t, store)
    const key = cohortKey(await ids(t))!, path = join(f.root, '.fugue/idx/v1/cohorts', `${key}.bin`)
    const wrongBytes = Buffer.from('different source'), wrongID = await f.truth.putBlob(wrongBytes)
    const wrong = encodeCohortIndex(buildCohortIndex([buildBlobIndex(wrongID, wrongBytes)]))
    for (const damage of ['missing', 'corrupt', 'oversize', 'unknown', 'wrong-set']) {
      assert.equal(await preparing.index.prepare(blob => f.truth.getBlob(blob)), true)
      if (damage === 'missing') rmSync(path)
      else if (damage === 'corrupt') writeFileSync(path, Buffer.from('torn'))
      else if (damage === 'oversize') truncateSync(path, MAX_COHORT_BYTES + 1)
      else if (damage === 'wrong-set') writeFileSync(path, wrong)
      else { const bytes = readFileSync(path); bytes.writeUInt16BE(99, 8); writeFileSync(path, bytes) }
      const before = store.stats().writes, fresh = attach(f, t, store), checked = measured(fresh.host)
      await equalReceipt(t, checked.host)
      assert.deepEqual(checked.reads, await t.plain.walk(), damage)
      await diverseReceipts(t, fresh.host)
      assert.equal(fresh.index.stats().sourceReads, 0); assert.equal(fresh.index.stats().builds, 0)
      assert.equal(fresh.index.stats().diskReads, 1, 'generation miss is shared rather than repeatedly probing a broken artifact')
      assert.equal(store.stats().writes, before, 'queries never repair derived artifacts')
      assert.ok(fresh.index.stats().fallbacks > 0)
    }
  } finally { await f.close() }
})

test('two held current-View query probes roll back their earlier exclusions after a real edit/delete', { timeout: 15_000 }, async () => {
  const f = await truthViewFixture(Object.fromEntries(Array.from({ length: 12 }, (_, at) => [String(at).padStart(2, '0'), `none ${at}`])))
  const gate = held<void>(), entered = held<void>()
  let blocking = false, calls = 0
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('racing'), indexed = attach(f, t, store)
    assert.equal(await indexed.index.prepare(blob => f.truth.getBlob(blob)), true)
    const stat = t.view.stat.bind(t.view)
    t.view.stat = async path => {
      if (blocking && path === '01') { if (++calls === 2) entered.release(); await gate.promise }
      return stat(path)
    }
    blocking = true
    const queries = ['needle', 'other'].map(pattern => {
      const check = measured(indexed.host)
      return { ...check, pattern, result: grep({ pattern }, check.host, context(t)) }
    })
    try {
      await entered.promise
      assert.equal(indexed.index.stats().active, 2)
      await t.change({ kind: 'modify', path: '00', bytes: Buffer.from('needle other\n'), mode })
      await t.change({ kind: 'delete', path: '02' })
    } finally { blocking = false; gate.release() }
    for (const query of queries) {
      const result = await query.result
      assert.deepEqual(result, await grep({ pattern: query.pattern }, t.plain, context(t)))
      assert.match(result.output, /00:1:needle other/)
      assert.deepEqual(query.reads, Array.from({ length: 12 }, (_, at) => String(at).padStart(2, '0')), 'whole enumerated batch includes the earlier excluded path')
    }
    assert.equal(indexed.index.stats().active, 0)
  } finally { blocking = false; gate.release(); await f.close() }
})

test('actual tool queries fail open at admitted-work and complete-View enumeration budgets', async () => {
  const f = await truthViewFixture({ a: 'none', b: 'needle\n' })
  const disk = held<void>(), entered = held<void>()
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('bounded'), preparing = attach(f, t, store)
    assert.equal(await preparing.index.prepare(blob => f.truth.getBlob(blob)), true)
    let diskCalls = 0
    const indexed = attach(f, t, { read: async blobs => { diskCalls++; entered.release(); await disk.promise; return store.read(blobs) }, write: index => store.write(index) })
    const pending = Array.from({ length: 4 }, () => grep({ pattern: 'needle' }, indexed.host, context(t)))
    try {
      await entered.promise
      assert.equal(indexed.index.stats().active, 4)
      const fifth = measured(indexed.host)
      await equalReceipt(t, fifth.host)
      assert.deepEqual(fifth.reads, ['a', 'b'], 'nonadmitted query uses the exact scan path')
      assert.equal(diskCalls, 1)
    } finally { disk.release() }
    for (const result of await Promise.all(pending)) assert.deepEqual(result, await grep({ pattern: 'needle' }, t.plain, context(t)))
    assert.equal(indexed.index.stats().sourceReads, 0); assert.equal(indexed.index.stats().builds, 0)
    const wide = await f.target('wide')
    await wide.view.applyDelta(Array.from({ length: 5001 }, (_, at) => ({ kind: 'add', path: String(at).padStart(5, '0') as RelPath,
      bytes: Buffer.from('none'), mode })))
    const oversized = attach(f, wide, store, async () => (await wide.view.list('')).map(entry => entry.name))
    let sourceCalls = 0
    assert.equal(await oversized.index.prepare(async blob => { sourceCalls++; return f.truth.getBlob(blob) }), false)
    const checked = measured(oversized.host)
    const result = await equalReceipt(wide, checked.host, { pattern: 'needle', path: '00000' })
    assert.deepEqual(checked.reads, ['00000'])
    assert.match(result.output, /incomplete/)
    assert.equal(oversized.index.stats().diskReads, 0); assert.equal(sourceCalls, 0)
  } finally { disk.release(); await f.close() }
})
