#!/usr/bin/env node
// 0.2.5 的读窗口量尺：旧的整段解码/拆行 vs 字节窗口；只比等价与读数，不断言速度。
// node tools/bench-read-window.js [--runs N]；不需要仓库、git、模型或凭据。
import assert from 'node:assert/strict'
import { textWindowOf, numberedWindowOf } from '../src/tools/read-window.ts'
import { lineCount } from '../src/tools/receipt.ts'

const at = process.argv.indexOf('--runs')
const runs = at === -1 ? 7 : Number(process.argv[at + 1])
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('--runs must be an integer from 1 to 100')
const body = 'read-window corpus 中😀 with unchanged line endings\r\n'.repeat(150_000)
const bytes = Buffer.from(body)
const window = { offset: 75_000, limit: 20 }
const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length/2)]
function legacy() {
  const decoded = bytes.toString('utf8')
  const rows = decoded.split('\n')
  if (decoded.endsWith('\n')) rows.pop()
  return { text:rows.slice(window.offset-1,window.offset-1+window.limit).map((line,i) => `${window.offset+i}\t${line}`).join('\n'), lines:lineCount(decoded), byteLength:bytes.byteLength }
}
function pushed() {
  const got = textWindowOf(bytes,window)
  return { text:numberedWindowOf(got,window.offset), lines:got.lines, byteLength:got.byteLength }
}
const expected = legacy()
assert.deepEqual(pushed(),expected)
const measure = fn => {
  const times = []
  for (let i=0;i<runs;i++) {
    const start = performance.now()
    assert.deepEqual(fn(),expected)
    times.push(performance.now()-start)
  }
  return { medianMs:Number(median(times).toFixed(3)), samplesMs:times.map(ms => Number(ms.toFixed(3))) }
}
// 两边预热同等次数；UTF-8 解码的字节量由选段长度直接给出，不把它混同 git I/O。
legacy(); pushed()
console.log(JSON.stringify({ bytes:bytes.byteLength, lines:150_000, window, runs,
  legacy:measure(legacy), pushed:measure(pushed),
  decodedBytes:{ legacy:bytes.byteLength, pushed:Buffer.byteLength(textWindowOf(bytes,window).text) },
  boundary:'full blob retrieval and line-count scan remain; only selected text is decoded',
},null,2))
