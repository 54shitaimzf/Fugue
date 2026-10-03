#!/usr/bin/env node
// 完整受控codec表→有界gram事实；512/256循环与多查询，仍核源文本答案。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { buildBlobIndex, encodeBlobIndex, decodeBlobIndex } from '../src/search/index-format.ts'
import { createIndexFactCache } from '../src/search/index-gram-facts.ts'
const key = gram => gram.charCodeAt(0) * 0x1_0000_0000 + gram.charCodeAt(1) * 0x1_0000 + gram.charCodeAt(2)
const corpus = Array.from({ length: 512 }, (_, at) => {
  const bytes = Buffer.concat([Buffer.from(`row ${at} ${at % 4 ? 'hay' : 'needle'} common ${at % 3 ? '' : '😀x'}\n` + 'steady source row\n'.repeat(64)), Buffer.from([0xff, 0, 0x61, 0x62])])
  const blob = createHash(at % 2 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  return { blob, text: bytes.toString('utf8'), encoded: encodeBlobIndex(buildBlobIndex(blob, bytes)) }
})
function scanner(useFacts) {
  const decoded = new Map(), facts = createIndexFactCache()
  let tableLoads = 0, factHits = 0
  return {
    pass(pattern) {
      const required = [...new Set(Array.from({ length: pattern.length - 2 }, (_, at) => key(pattern.slice(at, at + 3))))]
      const before = tableLoads, start = performance.now(), candidates = []
      for (const item of corpus) {
        let answer = useFacts ? facts.query(item.blob, required) : null
        if (answer !== null) factHits++
        else {
          let table = decoded.get(item.blob)
          if (table === undefined) {
            const index = decodeBlobIndex(item.encoded, item.blob)
            assert.ok(index)
            table = new Set(index.tables.trigrams.map(key)); tableLoads++
            if (decoded.size >= 256) decoded.delete(decoded.keys().next().value)
          }
          decoded.delete(item.blob); decoded.set(item.blob, table)
          const observations = required.map(value => [value, table.has(value)])
          answer = observations.every(([, present]) => present)
          if (useFacts) facts.remember(item.blob, observations)
        }
        if (answer !== false) candidates.push(item)
      }
      const hits = candidates.filter(item => item.text.includes(pattern)).map(item => item.blob)
      const ms = performance.now() - start
      assert.deepEqual(hits, corpus.filter(item => item.text.includes(pattern)).map(item => item.blob))
      const stats = facts.stats()
      assert.ok(stats.blobs <= 2048 && stats.facts <= 32768 && stats.logicalBytes <= 1024 * 1024)
      return { pattern, ms: Math.round(ms * 1000) / 1000, tableLoads: tableLoads - before, hits: hits.length, factHits, facts: stats }
    },
    close() { facts.clear(); decoded.clear(); assert.equal(facts.stats().facts, 0) },
  }
}
const plain = scanner(false), cached = scanner(true)
try {
  const patterns = ['needle', 'needle', 'hay', 'common', '😀x', '\u0000ab', '\ufffd\u0000a', 'row 42', 'not-present', 'common']
  const passes = patterns.map(pattern => ({ plain: plain.pass(pattern), cached: cached.pass(pattern) }))
  assert.equal(passes[1].plain.tableLoads, 512)
  assert.equal(passes[1].cached.tableLoads, 0)
  console.log(JSON.stringify({ corpusFiles: corpus.length, decodedCapacity: 256, passes,
    boundary: 'Mechanism-only canonical decode model, not filesystem IO/product grep/ext4/default activation. Unknown facts always load the complete validated table.' }, null, 2))
} finally { plain.close(); cached.close() }
