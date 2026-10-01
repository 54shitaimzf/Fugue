// 架构 § 8.9 / § 9.3：发现读当前 View，索引是派生体；M0 拒绝先于恢复写入。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { openTruth } from '../truth/truth.ts'
import { logFileOf, LogCorruptError, openLog } from '../log/log.ts'
import { encodeEvent } from '../log/envelope.ts'
import type { LogEvent } from '../log/events.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import { applyEdit } from '../view/edit.ts'
import { createRoots } from '../roots/roots.ts'
import { createBlobIndexLookup } from '../search/blob-index.ts'
import type { BlobIndexLookup } from '../search/blob-index.ts'
import { createBlobIndexStore } from '../search/index-store.ts'
import { MAX_INDEX_BYTES } from '../search/index-format.ts'
import { createToolHost } from './host.ts'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'
import type { AgentId, BlobId, RelPath, WriterId } from '../terms.ts'
import type { Delta } from '../delta.ts'

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
const grep = faceOf('grep')!
const mode = 0o100644
const context = (writer: WriterId): ToolContext => ({ agent: writer as AgentId, step: 0, cwd: '', holder: false })

async function fixture(files: Record<string, string | Uint8Array>) {
  const root = tmpDir('fugue-index-acceptance-')
  execFileSync('git', ['init', '-q', '--object-format=sha1', root], { env })
  const truth = openTruth(root), roots = createRoots(root), store = createBlobIndexStore(root)
  const entries = []
  for (const [name, content] of Object.entries(files)) {
    entries.push({ name, mode, id: await truth.putBlob(typeof content === 'string' ? Buffer.from(content) : content) })
  }
  const base = await truth.commit(await truth.putTree(entries), [], 'index acceptance fixture')
  const index = createBlobIndexLookup(root, id => truth.getBlob(id))
  const indices = [index]
  const logs: ReturnType<typeof openLog>[] = []
  async function target(name: string) {
    const writer = name as WriterId, log = openLog(root, { write: writer, sync: 'never' })
    logs.push(log)
    const view = await loadView(log, writer, { lower: lowerAt(truth, base) })
    const indexed = createToolHost(view, roots, { blobIndex: index }), plain = createToolHost(view, roots)
    return { writer, log, view, indexed, plain,
      change: (delta: Delta) => applyEdit({ view, log, truth, writer }, delta) }
  }
  async function warm(t: Awaited<ReturnType<typeof target>>) {
    for (const path of await t.indexed.walk()) {
      const meta = await t.view.stat(path as RelPath)
      if (meta?.kind !== 'file') continue
      const blob = meta.id as BlobId
      assert.equal((await store.rebuild(blob, await truth.getBlob(blob))).stored, true)
      await index.mightContain(blob, ['nee'])
    }
    await index.drain()
  }
  function failingIndex() {
    const handle = createBlobIndexLookup(root, async () => { throw new Error('optional source is unavailable') })
    indices.push(handle)
    return handle
  }
  async function close() {
    try { await Promise.all(indices.map(handle => handle.close())) }
    finally { try { await Promise.all(logs.map(log => log.close())) } finally { await truth.close() } }
  }
  return { root, truth, roots, store, base, index, target, warm, failingIndex, close }
}

type Target = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['target']>>
async function equalReceipt(t: Target, args: Record<string, unknown>, indexed: ToolHost = t.indexed) {
  const actual = await grep(args, indexed, context(t.writer))
  assert.deepEqual(actual, await grep(args, t.plain, context(t.writer)))
  return actual
}

const queries = [
  { pattern: 'needle' }, { pattern: '^needle\\r?$' },
  { pattern: 'nee.*le' }, { pattern: 'NEEDLE' },
  { pattern: '😀x' }, { pattern: '�ab' }, { pattern: 'needle|other' },
  { pattern: 'needle', path: 'dir', glob: '**/*.ts' },
]

async function allReceipts(t: Target, indexed: ToolHost = t.indexed) {
  for (const args of queries) {
    for (const output_mode of ['content', 'count', 'files_with_matches']) {
      await equalReceipt(t, { ...args, output_mode }, indexed)
    }
  }
}

test('two nonempty Views sharing immutable indices retain their own paths, mutations and replayed whiteouts', async () => {
  const f = await fixture({ 'dir/a.ts': 'none', 'dir/b.ts': 'needle\n', 'same.ts': 'none' })
  try {
    const a = await f.target('a'), b = await f.target('b')
    await a.change({ kind: 'modify', path: 'same.ts', bytes: Buffer.from('needle A\n'), mode })
    await b.change({ kind: 'modify', path: 'dir/b.ts', bytes: Buffer.from('quiet B\n'), mode })
    await b.change({ kind: 'modify', path: 'dir/a.ts', bytes: Buffer.from('needle B\n'), mode })
    // 工作树是诱饵；两个工具面都必须只问各自的 View。
    writeFileSync(join(f.root, 'same.ts'), 'needle HOST\n')
    await f.warm(a); await f.warm(b)
    const beforeA = await equalReceipt(a, { pattern: 'needle' })
    const beforeB = await equalReceipt(b, { pattern: 'needle' })
    assert.match(beforeA.output, /same.ts:1:needle A/)
    assert.match(beforeB.output, /dir\/a.ts:1:needle B/)
    assert.doesNotMatch(beforeB.output, /same.ts|dir\/b.ts|HOST/)
    await a.change({ kind: 'rename', from: 'same.ts', to: 'renamed.ts' })
    await a.change({ kind: 'chmod', path: 'renamed.ts', mode: 0o100755 })
    await a.change({ kind: 'delete', path: 'dir' })
    await a.change({ kind: 'add', path: 'dir/reborn.ts', bytes: Buffer.from('needle recreated\n'), mode })
    await f.warm(a); await allReceipts(a); await allReceipts(b)
    assert.deepEqual(await grep({ pattern: 'needle' }, b.indexed, context(b.writer)), beforeB, 'another writer cannot change this View')
    const live = await equalReceipt(a, { pattern: 'needle' })
    assert.match(live.output, /dir\/reborn.ts:1:needle recreated/)
    assert.match(live.output, /renamed.ts:1:needle A/)
    assert.doesNotMatch(live.output, /dir\/a.ts|dir\/b.ts|same.ts|HOST/)
    await a.log.close()
    const replay = await f.target('a')
    assert.deepEqual(replay.view.state(), a.view.state())
    assert.deepEqual(replay.view.diff(), a.view.diff())
    await allReceipts(replay)
    assert.deepEqual(await equalReceipt(replay, { pattern: 'needle' }), live)
  } finally { await f.close() }
})

test('fresh lookups fall back for missing, corrupt, oversized and unknown-version records with exact diverse scan receipts', async () => {
  const f = await fixture({ 'dir/hit.ts': 'before\r\nneedle\r\nNEEDLE\r\nafter\r\n',
    'dir/miss.ts': 'other\n', emoji: '😀xy\n', invalid: Buffer.from([0xff, 0x61, 0x62, 0x0a]) })
  try {
    const t = await f.target('fallback'), before = t.view.state()
    const blob = (await t.view.stat('dir/hit.ts'))!.id as BlobId
    const path = join(f.root, '.fugue/idx/v1', blob.slice(0, 2), `${blob}.json`)
    for (const damage of ['missing', 'corrupt', 'oversize', 'unknown']) {
      assert.equal((await f.store.rebuild(blob, await f.truth.getBlob(blob))).stored, true)
      if (damage === 'missing') rmSync(path)
      else if (damage === 'corrupt') writeFileSync(path, '{"torn":')
      else if (damage === 'oversize') writeFileSync(path, Buffer.alloc(MAX_INDEX_BYTES + 1))
      else writeFileSync(path, readFileSync(path, 'utf8').replace('"version":1', '"version":99'))
      assert.equal(await f.store.read(blob), null, damage)
      const damaged = damage === 'missing' ? null : readFileSync(path)
      // 每格新句柄，不能被前一格的内存命中遮住磁盘损坏。
      const index = f.failingIndex(), host = createToolHost(t.view, f.roots, { blobIndex: index })
      const reads: string[] = []
      const measured = { ...host, readBytes: async (name: string) => { reads.push(name); return host.readBytes(name) } }
      const hit = await equalReceipt(t, { pattern: 'needle' }, measured)
      assert.match(hit.output, /dir\/hit.ts:2:needle/)
      assert.deepEqual(reads, await t.plain.walk(), `${damage} cannot hide current View files`)
      await allReceipts(t, host); await index.drain()
      assert.ok(index.stats().scanFallbacks > 0)
      assert.equal(index.stats().builds, 0)
      if (damaged !== null) assert.deepEqual(readFileSync(path), damaged, 'failed optional source cannot rewrite the bad record')
      else assert.equal(existsSync(path), false, 'failed optional source cannot publish a missing record')
      assert.deepEqual(t.view.state(), before, 'optional index work cannot mutate authoritative View state')
    }
  } finally { await f.close() }
})

test('real View generation changes undo an earlier negative and observe all held concurrent probes before scanning', { timeout: 15_000 }, async () => {
  const f = await fixture(Object.fromEntries(Array.from({ length: 12 }, (_, at) => [String(at).padStart(2, '0'), `none ${at}`])))
  const releases: (() => void)[] = []
  let entered!: () => void
  const held = new Promise<void>(resolve => { entered = resolve })
  let calls = 0, active = 0, returned = false
  let excluded!: BlobId
  const lookup: BlobIndexLookup = { async mightContain(blob) {
    calls++
    if (blob === excluded) return false // 先成功排除 00，再让四个在途探测停住。
    active++
    await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 4) entered() })
    active--
    return false
  } }
  try {
    const t = await f.target('racing')
    excluded = (await t.view.stat('00'))!.id as BlobId
    const host = createToolHost(t.view, f.roots, { blobIndex: lookup })
    const reads: string[] = []
    const measured = { ...host, readBytes: async (path: string) => { reads.push(path); return host.readBytes(path) } }
    const pending = grep({ pattern: 'needle' }, measured, context(t.writer)).then(value => { returned = true; return value })
    try {
      await held
      assert.equal(calls, 5); assert.equal(active, 4)
      await t.change({ kind: 'modify', path: '00', bytes: Buffer.from('needle\n'), mode })
      await t.change({ kind: 'delete', path: '02' })
      releases[0]()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(returned, false, 'one finished probe cannot leave three unobserved')
      assert.equal(calls, 5, 'detected generation change must stop scheduling')
    } finally { for (const release of releases) release() }
    const result = await pending
    assert.deepEqual(result, await grep({ pattern: 'needle' }, t.plain, context(t.writer)))
    assert.match(result.output, /00:1:needle/)
    assert.equal(active, 0)
    assert.deepEqual(reads, Array.from({ length: 12 }, (_, at) => String(at).padStart(2, '0')), 'entire enumerated batch returns to scan, including prior exclusions')
  } finally { for (const release of releases) release(); await f.close() }
})

test('nested escaped duplicate refusal precedes torn-tail repair; repaired M0 replays the same indexed whiteout View', async () => {
  const f = await fixture({ 'dir/old.ts': 'needle old\n', 'outside.ts': 'none' })
  try {
    const t = await f.target('recovery')
    await t.change({ kind: 'delete', path: 'dir' })
    await t.change({ kind: 'add', path: 'dir/new.ts', bytes: Buffer.from('needle new\n'), mode })
    await f.warm(t)
    const live = await equalReceipt(t, { pattern: 'needle' })
    await t.log.close()
    const file = logFileOf(f.root, t.writer), prefix = readFileSync(file)
    const next = encodeEvent(3, t.writer, { t: 'view/write', agent: t.writer, path: 'bad.ts', rev: 3,
      blob: (await t.view.stat('dir/new.ts'))!.id, mode, probe: { scope: 'kept' } } as unknown as LogEvent)
    const duplicate = next.replace('"probe":{"scope":"kept"}', '"probe":{"\\u0073cope":"hidden","scope":"kept"}')
    assert.notEqual(duplicate, next)
    const tail = Buffer.concat([Buffer.from('{"partial":"'), Buffer.from([0xe7, 0x94])])
    appendFileSync(file, Buffer.concat([Buffer.from(duplicate + '\n'), tail]))
    const before = readFileSync(file), writer = openLog(f.root, { write: t.writer, sync: 'each' })
    const reader = openLog(f.root, { sync: 'never' })
    try {
      await assert.rejects(loadView(reader, t.writer, { lower: lowerAt(f.truth, f.base) }), LogCorruptError)
      await assert.rejects(writer.append(t.writer, { t: 'view/remove', agent: t.writer, path: 'outside.ts', rev: 3 } as LogEvent), /重复/)
      assert.deepEqual(readFileSync(file), before, 'complete nested corruption forbids destructive tail repair')
      // 只修本测试生成的坏整行；同一失败过的 writer 必须可重试，然后恢复尾巴。
      writeFileSync(file, Buffer.concat([prefix, tail]))
      const view = await loadView(reader, t.writer, { lower: lowerAt(f.truth, f.base) })
      await applyEdit({ view, truth: f.truth, log: writer, writer: t.writer }, { kind: 'add', path: 'after.ts', bytes: Buffer.from('needle after\n'), mode })
    } finally { await reader.close(); await writer.close() }
    const replay = await f.target('recovery')
    await f.warm(replay); await allReceipts(replay)
    const result = await equalReceipt(replay, { pattern: 'needle' })
    assert.match(live.output, /dir\/new.ts:1:needle new/)
    assert.match(result.output, /after.ts:1:needle after/)
    assert.match(result.output, /dir\/new.ts:1:needle new/)
    assert.doesNotMatch(result.output, /dir\/old.ts|bad.ts|partial|hidden/)
    assert.equal(await replay.view.stat('dir/old.ts'), null, 'recovery must preserve the lower-directory whiteout')
    assert.ok(readFileSync(file).subarray(0, prefix.length).equals(prefix), 'repair leaves all committed prefix bytes unchanged')
  } finally { await f.close() }
})
