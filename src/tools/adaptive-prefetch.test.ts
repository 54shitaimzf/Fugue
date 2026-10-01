// 分批策略按回执占用调节；第一批仍小，不牺牲密集命中的早停。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import { MAX_RECEIPT_BYTES } from './receipt.ts'
import type { ToolHost, ToolContext } from './execute.ts'

const ctx: ToolContext = { agent: 'reader', step: 0, cwd: '', holder: false }
const grep = faceOf('grep')!
function corpus(body: string | ((index: number) => string)) {
  const paths = Array.from({ length: 256 }, (_, index) => `file-${index}`)
  const batches: number[] = []
  let reads = 0
  const host = {
    walk: async () => paths,
    walkDetailed: async () => ({ paths, truncated: false, limits: [] }),
    prefetch: async (paths: readonly string[]) => { batches.push(paths.length) },
    readBytes: async (path: string) => {
      reads++
      const content = typeof body === 'function' ? body(Number(path.slice(5))) : body
      return { bytes: Buffer.from(content), mode: 0o100644 }
    },
  } as ToolHost
  return { host, batches, reads: () => reads }
}

test('sparse and no-hit scans grow bounded batches after the initial probe', async () => {
  const b = corpus('none')
  assert.equal((await grep({ pattern: 'hit' }, b.host, ctx)).output, 'no line matches hit.')
  assert.deepEqual(b.batches, [32, 128, 96])
  assert.equal(b.reads(), 256)
})

test('a dense first file still stops after one read and one small prefetch', async () => {
  const b = corpus(('hit ' + 'x'.repeat(100) + '\n').repeat(500))
  const out = await grep({ pattern: 'hit' }, b.host, ctx)
  assert.match(out.output, /Search stopped/)
  assert.deepEqual(b.batches, [32])
  assert.equal(b.reads(), 1)
})

test('a substantially filled receipt keeps later prefetch small', async () => {
  const b = corpus('hit ' + 'x'.repeat(64))
  const out = await grep({ pattern: 'hit' }, b.host, ctx)
  assert.match(out.output, /Search stopped/)
  assert.ok(b.batches.length > 1)
  assert.ok(b.batches.every(size => size === 32))
  assert.ok(b.reads() < 256)
})


test('a sparse-to-dense transition overfetches at most the current large batch and still stops', async () => {
  const dense = ('hit ' + 'x'.repeat(100) + '\n').repeat(500)
  const b = corpus(index => index < 32 ? 'none' : dense)
  const out = await grep({ pattern: 'hit' }, b.host, ctx)
  assert.match(out.output, /Search stopped/)
  assert.deepEqual(b.batches, [32, 128])
  assert.equal(b.reads(), 33)
  assert.ok(Buffer.byteLength(out.output) <= MAX_RECEIPT_BYTES)
})

test('a byte-capped prefetch covers only a prefix: grep reads that prefix and re-batches from the first uncovered path', async () => {
  const paths = Array.from({ length: 100 }, (_, index) => `file-${index}`)
  const asked: string[][] = []
  const read: string[] = []
  const host = {
    walk: async () => paths,
    walkDetailed: async () => ({ paths, truncated: false, limits: [] }),
    prefetch: async (batch: readonly string[]) => { asked.push([...batch]); return 10 },
    readBytes: async (path: string) => { read.push(path); return { bytes: Buffer.from('none'), mode: 0o100644 } },
  } as ToolHost
  assert.equal((await grep({ pattern: 'hit' }, host, ctx)).output, 'no line matches hit.')
  assert.deepEqual(read, paths, '每个文件仍然恰好读一次，顺序不变')
  assert.deepEqual(asked.map(batch => batch[0]), paths.filter((_, index) => index % 10 === 0), '下一轮从没覆盖的第一条起')
})

test('a prefetch that covers nothing still advances by one path', async () => {
  const paths = ['a', 'b', 'c']
  const host = {
    walk: async () => paths,
    walkDetailed: async () => ({ paths, truncated: false, limits: [] }),
    prefetch: async () => 0,
    readBytes: async () => ({ bytes: Buffer.from('none'), mode: 0o100644 }),
  } as ToolHost
  assert.equal((await grep({ pattern: 'hit' }, host, ctx)).output, 'no line matches hit.')
})

test('the per-batch prefetch byte budget leaves room in the default blob cache for the previous batch', async () => {
  const { PREFETCH_BYTE_BUDGET } = await import('./host.ts')
  const { DEFAULT_BLOB_CACHE_BYTES } = await import('../truth/truth.ts')
  assert.ok(PREFETCH_BYTE_BUDGET * 2 <= DEFAULT_BLOB_CACHE_BYTES)
})
