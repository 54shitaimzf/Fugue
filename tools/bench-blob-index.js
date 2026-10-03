#!/usr/bin/env node
// 0.3.2：主查询不等缺索引构建；单独记准备成本与超 LRU 容量的循环扫描。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBlobIndexLookup } from '../src/search/blob-index.ts'
import { createBlobIndexStore } from '../src/search/index-store.ts'

const made = [], handles = []
const required = ['nee', 'eed', 'edl', 'dle']
function corpus(count, repeats) {
  const root = mkdtempSync(join(tmpdir(), 'fugue-bench-blob-index-')); made.push(root)
  const blobs = new Map()
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(`file ${i} ${i % 2 === 0 ? 'needle' : 'haystack'}\n` + 'fixed corpus row\n'.repeat(repeats))
    blobs.set(createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'), bytes)
  }
  let reads = 0
  const source = async (id) => { reads++; const bytes = blobs.get(id); if (bytes === undefined) throw new Error('missing fixture blob'); return bytes }
  const lookup = (options) => { const value = createBlobIndexLookup(root, source, options); handles.push(value); return value }
  return { root, blobs, source, lookup, reads: () => reads }
}
async function pass(f, lookup) {
  const beforeReads = f.reads(), beforeStats = lookup.stats(), start = performance.now()
  const candidates = []; let unknown = 0
  for (const id of f.blobs.keys()) {
    const answer = await lookup.mightContain(id, required)
    if (answer === null) unknown++
    if (answer !== false) candidates.push(id)
  }
  const hits = candidates.filter((id) => f.blobs.get(id).toString('utf8').includes('needle'))
  const ms = performance.now() - start
  // 不只比阶段之间的命中数：直接对未过滤的全体真源逐 ID 核同一个答案。
  const reference = [...f.blobs.keys()].filter((id) => f.blobs.get(id).toString('utf8').includes('needle'))
  assert.deepEqual(hits, reference, 'index exclusion changed the full-source reference answer')
  const after = lookup.stats()
  return { ms: Number(ms.toFixed(3)), sourceReads: f.reads() - beforeReads,
    diskHits: after.diskHits - beforeStats.diskHits, memoryHits: after.memoryHits - beforeStats.memoryHits,
    unknown, candidates: candidates.length, hits: hits.length, stats: after }
}
async function prepareAll(f, lookup) {
  const before = f.reads(), start = performance.now()
  await lookup.drain()
  for (const id of f.blobs.keys()) { await lookup.mightContain(id, required); await lookup.drain() }
  return { ms: Number((performance.now() - start).toFixed(3)), sourceReads: f.reads() - before, stats: lookup.stats() }
}
try {
  const f = corpus(16, 8192), original = f.lookup()
  const firstMissing = await pass(f, original)
  const preparation = await prepareAll(f, original)
  const hot = await pass(f, original)
  const restarted = await pass(f, f.lookup())
  const bytes = Buffer.from('new immutable needle blob'), id = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
  f.blobs.set(id, bytes)
  const incrementalLookup = f.lookup(), incrementalMiss = await pass(f, incrementalLookup)
  await incrementalLookup.drain()
  const incrementalHot = await pass(f, incrementalLookup)
  const corruptId = f.blobs.keys().next().value
  writeFileSync(join(f.root, '.fugue/idx/v1', corruptId.slice(0, 2), `${corruptId}.json`), '{"incomplete":')
  const repairLookup = f.lookup(), corruptMiss = await pass(f, repairLookup)
  await repairLookup.drain(); const repaired = await pass(f, repairLookup)
  const overflow = corpus(257, 1), store = createBlobIndexStore(overflow.root)
  // 单列开发准备，不把这些原字节构建成本藏在“热查询”里。
  const prepStart = performance.now()
  for (const [blob, body] of overflow.blobs) assert.ok((await store.rebuild(blob, body)).stored)
  const overflowPreparationMs = Number((performance.now() - prepStart).toFixed(3))
  const cyclic = overflow.lookup({ maxRecords: 256 })
  const overflowCold = await pass(overflow, cyclic), overflowSecond = await pass(overflow, cyclic)
  console.log(JSON.stringify({ corpusBytes: [...f.blobs.values()].reduce((sum, body) => sum + body.byteLength, 0),
    firstMissing, preparation, hot, restarted, incrementalMiss, incrementalHot, corruptMiss, repaired,
    overCapacity: { corpusRecords: 257, maxRecords: 256, preparationMs: overflowPreparationMs, first: overflowCold, second: overflowSecond } }))
} finally {
  await Promise.all(handles.map((handle) => handle.close()))
  for (const root of made) rmSync(root, { recursive: true, force: true })
}
