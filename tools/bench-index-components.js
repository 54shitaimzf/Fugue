// 开发测量：拆开0.4候选机制成本，不改默认、不把overlay读数当ext4验收。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { buildBlobIndex, encodeBlobIndex, decodeBlobIndex } from '../src/search/index-format.ts'
import { copyIndexSource } from '../src/search/index-source.ts'
import { createBlobIndexStore } from '../src/search/index-store.ts'

const root = await mkdtemp(join(tmpdir(), 'fugue-index-components-'))
const store = createBlobIndexStore(root)
const corpus = Array.from({ length: 8 }, (_, file) => {
  const lines = Array.from({ length: 6000 }, (_, row) =>
    `export const value_${file}_${row} = "part_${(row * 7919) % 65521}";\n`).join('')
  let seed = 0x1eaf + file
  const units = Array.from({ length: 30000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed & 0xffff
  })
  const kind = file < 4 ? 'repeated-code' : 'high-unit-entropy'
  const pattern = kind === 'repeated-code' ? lines : String.fromCharCode(...units)
  const bytes = Buffer.alloc(2 * 1024 * 1024)
  Buffer.from(pattern.repeat(Math.ceil(bytes.length / Buffer.byteLength(pattern)))).copy(bytes)
  const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  return { id, bytes, kind }
})
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const rounded = (value) => Math.round(value * 1000) / 1000
async function measure(operation) {
  const start = performance.now()
  const result = await operation()
  return { ms: performance.now() - start, result }
}
// 改前完整构建的独立参考，只用于同进程交替对照；不供产品调用。
function stringBuilderReference(blob, bytes) {
  const source = Buffer.from(bytes)
  const actual = createHash('sha1').update(`blob ${source.byteLength}\0`).update(source).digest('hex')
  assert.equal(actual, blob)
  const text = source.toString('utf8'), grams = new Set()
  for (let at = 0; at + 2 < text.length; at++) grams.add(text.slice(at, at + 3))
  return { format: 'fugue-blob-trigrams', version: 1, blob, sourceBytes: source.byteLength,
    textUnits: text.length, tables: { trigrams: [...grams].sort(), symbols: null } }
}
async function workerStartup() {
  const worker = new Worker('require("node:worker_threads").parentPort.postMessage("ready")', {
    eval: true, env: {}, stdout: true, stderr: true,
  })
  worker.stdout.resume(); worker.stderr.resume()
  try {
    await new Promise((resolve, reject) => {
      worker.once('message', (value) => value === 'ready' ? resolve() : reject(new Error('unexpected startup receipt')))
      worker.once('error', reject)
      worker.once('exit', (code) => reject(new Error(`startup exited before receipt: ${code}`)))
    })
  } finally { await worker.terminate() }
}
try {
  const startup = []
  for (let at = 0; at < 8; at++) startup.push((await measure(workerStartup)).ms)
  const samples = []
  for (const { id, bytes, kind } of corpus) {
    const copy = await measure(() => copyIndexSource(bytes))
    assert.ok(copy.result)
    assert.equal(copy.result.buffer.byteLength, bytes.byteLength)
    assert.notEqual(copy.result.buffer, bytes.buffer)
    assert.deepEqual(Buffer.from(copy.result), bytes)
    const beforeRuns = [], afterRuns = []
    let build
    for (let run = 0; run < 3; run++) {
      // 交换测量次序，减轻先后档受热身/共享机器波动的偏置。
      const before = () => measure(() => stringBuilderReference(id, bytes))
      const after = () => measure(() => buildBlobIndex(id, bytes))
      const pair = run % 2 === 0 ? [await before(), await after()] : await (async () => {
        const packed = await after(); return [await before(), packed]
      })()
      assert.deepEqual(pair[1].result, pair[0].result)
      beforeRuns.push(pair[0].ms); afterRuns.push(pair[1].ms); build = pair[1]
    }
    build.ms = median(afterRuns)
    const encode = await measure(() => encodeBlobIndex(build.result))
    const decode = await measure(() => decodeBlobIndex(encode.result, id))
    assert.deepEqual(decode.result, build.result)
    assert.equal(decodeBlobIndex(encode.result.slice(0, -1), id), null, 'truncated canonical record must miss')
    // 真源全表参考，避免某一层稳定漏表仍在 roundtrip 中自证相等。
    const text = bytes.toString('utf8'), expected = new Set()
    for (let at = 0; at + 2 < text.length; at++) expected.add(text.slice(at, at + 3))
    assert.deepEqual(build.result.tables.trigrams, [...expected].sort())
    const rebuild = await measure(() => store.rebuild(id, bytes))
    assert.equal(rebuild.result.stored, true)
    const reads = []
    for (let run = 0; run < 3; run++) {
      const read = await measure(() => store.read(id))
      assert.deepEqual(read.result, build.result)
      reads.push(read.ms)
    }
    samples.push({ kind, sourceBytes: bytes.byteLength, recordBytes: encode.result.byteLength,
      trigrams: expected.size, copyMs: rounded(copy.ms), buildMs: rounded(build.ms),
      stringBuilderMedianMs: rounded(median(beforeRuns)), builderRatio: rounded(build.ms / median(beforeRuns)),
      encodeMs: rounded(encode.ms), decodeMs: rounded(decode.ms), rebuildMs: rounded(rebuild.ms),
      repeatedDiskReadMedianMs: rounded(median(reads)) })
  }
  const stage = (key) => rounded(samples.reduce((sum, sample) => sum + sample[key], 0))
  console.log(JSON.stringify({ node: process.version, corpusFiles: corpus.length,
    corpusBytes: corpus.reduce((sum, row) => sum + row.bytes.byteLength, 0),
    workerStartupSamplesMs: startup.map(rounded), workerStartupMedianMs: rounded(median(startup)),
    stageTotalsMs: Object.fromEntries(['copyMs', 'stringBuilderMedianMs', 'buildMs', 'encodeMs', 'decodeMs', 'rebuildMs', 'repeatedDiskReadMedianMs'].map((key) => [key, stage(key)])),
    samples, notes: ['Mechanism samples, not end-to-end grep or activation acceptance.',
      'No OS page-cache flush: repeated disk reads are not physical cold-disk measurements.',
      'Rebuild includes source verification, encode, namespace creation and file/directory fsync.',
      'Stage totals are independent measurements; summing them is not a query latency.'] }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
