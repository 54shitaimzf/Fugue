// 索引只缩候选；最终仍按真实行正则验证，关闭/失败/不支持时回执与扫描相同。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'
import { createToolHost } from './host.ts'
import type { HostOptions } from './host.ts'
import type { Roots } from '../roots/contract.ts'
import type { View } from '../view/contract.ts'
import type { BlobId, CommitId, RelPath, TreeId, ViewRev } from '../terms.ts'
import type { EntryMeta, DirEntry } from '../entries.ts'

const ctx: ToolContext = { agent: 'reader', step: 0, cwd: '', holder: false }
const grep = faceOf('grep')!
function blobOf(bytes: Uint8Array): BlobId {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') as BlobId
}
function gramsOf(bytes: Uint8Array): Set<string> {
  const text = Buffer.from(bytes).toString('utf8')
  const grams = new Set<string>()
  for (let at = 0; at + 2 < text.length; at++) grams.add(text.slice(at, at + 3))
  return grams
}

function fixture(initial: Record<string, string>) {
  const files = new Map<string, { bytes: Uint8Array; mode: number }>()
  const blobs = new Map<BlobId, Uint8Array>()
  const view = {
    base: 'a'.repeat(40) as CommitId,
    rev: 0 as ViewRev,
    async stat(path: RelPath): Promise<EntryMeta | null> {
      const entry = files.get(path)
      return entry === undefined ? null : { kind: 'file', id: blobOf(entry.bytes), mode: entry.mode, size: entry.bytes.length }
    },
    async read(path: RelPath) { return files.get(path)?.bytes ?? null },
    async list(dir: RelPath): Promise<DirEntry[]> {
      const prefix = dir === '' ? '' : dir + '/'
      const entries = new Map<string, DirEntry>()
      for (const path of [...files.keys()].sort()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        const name = slash === -1 ? rest : rest.slice(0, slash)
        if (slash === -1) entries.set(name, { name, ...(await view.stat(path as RelPath))! })
        else entries.set(name, { name, kind: 'dir', id: 'd'.repeat(40) as TreeId, mode: 0o40000, size: 0 })
      }
      return [...entries.values()]
    },
  }
  function write(path: string, text: string) {
    const bytes = Buffer.from(text)
    files.set(path, { bytes, mode: files.get(path)?.mode ?? 0o100644 })
    blobs.set(blobOf(bytes), bytes)
    view.rev = (Number(view.rev) + 1) as ViewRev
  }
  for (const [path, text] of Object.entries(initial)) write(path, text)
  let queries = 0
  const blobIndex = {
    async mightContain(blob: BlobId, required: readonly string[]) {
      queries++
      const bytes = blobs.get(blob)
      if (bytes === undefined) return null
      const grams = gramsOf(bytes)
      return required.every(gram => grams.has(gram))
    },
  }
  const host = (indexed: boolean, override = blobIndex) => {
    const options = indexed ? { blobIndex: override } : {}
    const product = createToolHost(view as unknown as View, {} as Roots, options as HostOptions)
    const reads: string[] = []
    const prefetched: string[][] = []
    const wrapped = { ...product,
      readBytes: async (path: string) => { reads.push(path); return product.readBytes(path) },
      prefetch: async (paths: readonly string[]) => { prefetched.push([...paths]) },
    } as ToolHost
    return { host: wrapped, reads, prefetched }
  }
  return { view, files, blobs, write, blobIndex, host, queries: () => queries }
}

test('opt-in index candidates shrink content reads but preserve all result modes and regex verification', async () => {
  const b = fixture({ a: 'none', b: 'needle\nneedle\n', c: 'none' })
  for (const output_mode of ['content', 'files_with_matches', 'count']) {
    const indexed = b.host(true)
    const plain = b.host(false)
    const args = { pattern: 'needle', output_mode }
    assert.deepEqual(await grep(args, indexed.host, ctx), await grep(args, plain.host, ctx))
    assert.deepEqual(indexed.reads, ['b'])
    assert.deepEqual(indexed.prefetched, [['b']])
  }
  const falsePositive = fixture({ a: 'abc bcd cde def' })
  assert.equal((await grep({ pattern: 'abcdef' }, falsePositive.host(true).host, ctx)).output, 'no line matches abcdef.')
})

test('ambiguous regex and absent/null/throwing lookup use the unchanged scan path', async () => {
  const b = fixture({ a: 'ab', b: 'xyz' })
  const unsupported = await grep({ pattern: 'abc*|xyz' }, b.host(true).host, ctx)
  assert.equal(b.queries(), 0)
  assert.deepEqual(unsupported, await grep({ pattern: 'abc*|xyz' }, b.host(false).host, ctx))
  for (const mightContain of [async () => null, async () => { throw new Error('index unavailable') }]) {
    const indexed = b.host(true, { mightContain })
    assert.deepEqual(await grep({ pattern: 'xyz' }, indexed.host, ctx), await grep({ pattern: 'xyz' }, b.host(false).host, ctx))
    assert.deepEqual(indexed.reads, ['a', 'b'])
  }
})

test('add/modify/rename/chmod/remove and directory recreation use current view identities', async () => {
  const b = fixture({ 'dir/file': 'none' })
  const indexed = b.host(true)
  const plain = b.host(false)
  const check = async () => assert.deepEqual(await grep({ pattern: 'needle' }, indexed.host, ctx), await grep({ pattern: 'needle' }, plain.host, ctx))
  await check()
  b.write('dir/file', 'needle'); await check()
  b.write('dir/added', 'needle'); await check()
  b.files.set('renamed', b.files.get('dir/file')!); b.files.delete('dir/file'); b.view.rev = (Number(b.view.rev) + 1) as ViewRev; await check()
  b.files.get('renamed')!.mode = 0o100755; b.view.rev = (Number(b.view.rev) + 1) as ViewRev; await check()
  b.files.clear(); b.view.rev = (Number(b.view.rev) + 1) as ViewRev; await check()
  b.write('dir/new', 'needle'); await check()
  const other = fixture({ 'dir/new': 'none' })
  assert.equal((await grep({ pattern: 'needle' }, other.host(true).host, ctx)).output, 'no line matches needle.')
})

test('generation changes during metadata/index work restore all candidates before real reads', async () => {
  const b = fixture({ a: 'none', b: 'none' })
  let calls = 0
  const racing = {
    async mightContain() {
      calls++
      if (calls === 2) b.write('a', 'needle')
      return false
    },
  }
  const indexed = b.host(true, racing)
  const out = await grep({ pattern: 'needle' }, indexed.host, ctx)
  assert.match(out.output, /a:1:needle/)
  assert.deepEqual(indexed.reads, ['a', 'b'])
})

test('optional candidate seam cannot inject/duplicate paths or turn a failure into an exclusion', async () => {
  const b = fixture({ a: 'needle', b: 'needle' })
  const baseline = await grep({ pattern: 'needle' }, b.host(false).host, ctx)
  for (const filterCandidates of [
    async () => ['outside'], async () => ['a', 'a'], async () => null as never,
    async () => { throw new Error('candidate unavailable') },
  ]) {
    const product = b.host(false)
    assert.deepEqual(await grep({ pattern: 'needle' }, { ...product.host, filterCandidates }, ctx), baseline)
    assert.deepEqual(product.reads, ['a', 'b'])
  }
  const reordered = b.host(false)
  assert.deepEqual(await grep({ pattern: 'needle' }, { ...reordered.host, filterCandidates: async () => ['b', 'a'] }, ctx), baseline)
  assert.deepEqual(reordered.reads, ['a', 'b'])
})

test('candidate exclusion does not hide incomplete or unknown enumeration receipts', async () => {
  const b = fixture({ a: 'none' })
  const indexed = b.host(true)
  const plain = b.host(false)
  const walkDetailed = async () => ({ paths: ['a'], truncated: true, limits: ['rows' as const] })
  const args = { pattern: 'needle', path: 'beyond-walk', glob: '*.ts' }
  const output = await grep(args, { ...indexed.host, walkDetailed }, ctx)
  assert.deepEqual(output, await grep(args, { ...plain.host, walkDetailed }, ctx))
  assert.match(output.output, /incomplete/)
  const unknown = { ...indexed.host, walkDetailed: undefined }
  assert.match((await grep({ pattern: 'needle' }, unknown, ctx)).output, /completeness.*unavailable/i)
})

test('index queries stop with the current dense batch, before later prefetch or metadata work', async () => {
  const files = Object.fromEntries(Array.from({ length: 256 }, (_, at) => [String(at).padStart(3, '0'), 'needle' + 'x'.repeat(9000)]))
  const b = fixture(files)
  const indexed = b.host(true)
  const plain = b.host(false)
  assert.deepEqual(await grep({ pattern: 'needle' }, indexed.host, ctx), await grep({ pattern: 'needle' }, plain.host, ctx))
  assert.equal(b.queries(), 32)
  assert.deepEqual(indexed.prefetched.map(paths => paths.length), [32])
  assert.deepEqual(indexed.reads, ['000'])
})

test('candidate provider input mutations cannot inject paths, reorder receipts or alter later conditions', async () => {
  const files = Object.fromEntries(Array.from({ length: 33 }, (_, at) => [String(at).padStart(3, '0'), 'needle']))
  const b = fixture(files)
  const baseline = await grep({ pattern: 'needle' }, b.host(false).host, ctx)
  for (const mutate of [
    (paths: string[], _grams: string[]) => { paths.reverse() },
    (paths: string[], _grams: string[]) => { paths.push('injected') },
    (paths: string[], _grams: string[]) => { paths.splice(0) },
    (_paths: string[], grams: string[]) => { grams[0] = 'bad' },
  ]) {
    let calls = 0
    const seen: string[][] = []
    const host = b.host(false)
    const filterCandidates = async (paths: readonly string[], required: readonly string[]) => {
      seen.push([...required]); calls++
      assert.ok(Object.isFrozen(paths)); assert.ok(Object.isFrozen(required))
      if (calls === 1) mutate(paths as string[], required as string[])
      return [...paths].reverse()
    }
    assert.deepEqual(await grep({ pattern: 'needle' }, { ...host.host, filterCandidates }, ctx), baseline)
    assert.equal(calls, 2)
    assert.deepEqual(seen[0], seen[1])
    assert.deepEqual(host.reads, Object.keys(files))
  }
})

test('a byte-capped prefetch prefix composes with candidate filtering: each kept path is read once, in order, and none are dropped', async () => {
  const paths = Array.from({ length: 100 }, (_, index) => `file-${String(index).padStart(3, '0')}`)
  const kept = paths.filter((_, index) => index % 2 === 0)
  const asked: string[][] = []
  const read: string[] = []
  const host = {
    walk: async () => paths,
    walkDetailed: async () => ({ paths, truncated: false, limits: [] }),
    filterCandidates: async (batch: readonly string[]) => batch.filter(path => kept.includes(path)),
    prefetch: async (batch: readonly string[]) => { asked.push([...batch]); return 10 },
    readBytes: async (path: string) => { read.push(path); return { bytes: Buffer.from('none'), mode: 0o100644 } },
  } as ToolHost
  assert.equal((await grep({ pattern: 'needle' }, host, ctx)).output, 'no line matches needle.')
  assert.deepEqual(read, kept)
  assert.deepEqual(asked.map(batch => batch[0]), kept.filter((_, index) => index % 10 === 0))
})
