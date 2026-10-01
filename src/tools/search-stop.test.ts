// 0.3.0：回执足够后真早停，不把未遍历/未扫描的总数说成知道。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import type { ToolHost, ToolContext } from './execute.ts'
import { MAX_RECEIPT_BYTES } from './receipt.ts'
import { SearchRows, searchLines } from './search-receipt.ts'

const ctx: ToolContext = { agent:'reader',step:0,cwd:'',holder:false }
const grep = faceOf('grep')!
const glob = faceOf('glob')!
function hostFor(files: Record<string,string>, limits: readonly ('rows'|'depth')[] = []) {
  const reads: string[] = []
  const batches: string[][] = []
  const paths = Object.keys(files)
  const host = {
    walk: async () => paths,
    walkDetailed: async () => ({ paths,truncated:limits.length > 0,limits }),
    readBytes: async (path:string) => { reads.push(path); return { bytes:Buffer.from(files[path]!),mode:0o100644 } },
    prefetch: async (paths: readonly string[]) => { batches.push([...paths]) },
  } as ToolHost
  return { host,reads,batches }
}

test('grep stops reading and bounded prefetch stops requesting later files when receipt fills', async () => {
  const files = Object.fromEntries(Array.from({ length:100 },(_,i) => [`file-${i}`, 'hit '.repeat(30)+'\n']))
  files['file-0'] = ('hit '+'x'.repeat(100)+'\n').repeat(500)
  const b = hostFor(files)
  const out = await grep({ pattern:'hit' },b.host,ctx)
  assert.equal(out.ok,true)
  assert.match(out.output,/search stopped.*receipt budget/i)
  assert.match(out.output,/incomplete/i)
  assert.equal(b.reads.length,1)
  assert.ok(b.batches.flat().length < 100,'prefetch must not fetch the entire tree before early-stop')
  assert.ok(Buffer.byteLength(out.output) <= MAX_RECEIPT_BYTES)
  assert.doesNotMatch(out.output,/bytes omitted|500 lines:/)
})

test('a long single hit remains UTF-8 safe and explicitly shortened', async () => {
  const b = hostFor({ 'big': 'hit '+'中😀'.repeat(5000), 'later':'hit' })
  const out = await grep({ pattern:'hit' },b.host,ctx)
  assert.match(out.output,/last result line shortened/i)
  assert.match(out.output,/search stopped/i)
  assert.ok(out.output.startsWith('1 lines shown:'))
  assert.ok(Buffer.byteLength(out.output) <= MAX_RECEIPT_BYTES)
  assert.ok(!out.output.includes('�'))
  assert.deepEqual(b.reads,['big'])
})

test('walk rows/depth truncation is shown even if filtered search has no matches', async () => {
  for (const limits of [['rows'],['depth'],['rows','depth']] as const) {
    const b = hostFor({ 'visited':'nothing' },limits)
    for (const invoke of [() => grep({ pattern:'hit',path:'unvisited',glob:'**/*.ts' },b.host,ctx), () => glob({ pattern:'unvisited/**' },b.host,ctx)]) {
      const out = await invoke()
      assert.match(out.output,/enumeration incomplete/i)
      for (const reason of limits) assert.ok(out.output.includes(reason))
      assert.doesNotMatch(out.output,/^no (line|path) matches/)
      assert.doesNotMatch(out.output,/\d+ files omitted/)
    }
  }
})

test('legacy walk status is unknown rather than silently complete', async () => {
  const host = { walk:async () => [],readBytes:async () => null } as ToolHost
  for (const out of [await grep({ pattern:'hit' },host,ctx),await glob({ pattern:'**' },host,ctx)]) {
    assert.match(out.output,/enumeration completeness unavailable/i)
    assert.doesNotMatch(out.output,/^no (line|path) matches/)
  }
})

test('count and file modes remain exact for scanned files while stopped search is partial', async () => {
  const files = Object.fromEntries(Array.from({ length:100 },(_,i) => [`file-${i}-`+'a'.repeat(120),'hit\nhit\nmiss']))
  for (const output_mode of ['count','files_with_matches']) {
    const b = hostFor(files)
    const out = await grep({ pattern:'hit',output_mode },b.host,ctx)
    assert.match(out.output,/search stopped/i)
    assert.ok(b.reads.length < 100)
    assert.ok(Buffer.byteLength(out.output) <= MAX_RECEIPT_BYTES)
    if (output_mode === 'count') assert.match(out.output,/:2(?:\n|$)/)
    assert.doesNotMatch(out.output,/100 paths:/)
  }
})

test('line iterator preserves split semantics without an eager line array', () => {
  for (const text of ['', '\n', 'a\n', 'a\r\nb\r', 'a\u2028b\n😀']) {
    assert.deepEqual([...searchLines(text)],text.split('\n').map((line,i) => ({ line,number:i+1 })))
  }
})

test('complete small searches retain exact receipts; empty and shortened receipts remain bounded', async () => {
  const b = hostFor({ 'a':'hit\nno', 'b':'hit' })
  assert.equal((await grep({ pattern:'hit' },b.host,ctx)).output,'2 lines:\na:1:hit\nb:1:hit')
  assert.equal((await grep({ pattern:'miss' },b.host,ctx)).output,'no line matches miss.')
  assert.equal((await glob({ pattern:'*' },b.host,ctx)).output,'2 paths:\na\nb')
  for (const row of ['中😀'.repeat(10000),'x'.repeat(7680),'x'.repeat(7681)]) {
    const rows = new SearchRows()
    rows.add(row)
    const out = rows.render('paths','empty',{ known:false,truncated:true,limits:['rows','depth'] })
    assert.ok(Buffer.byteLength(out) <= MAX_RECEIPT_BYTES)
    assert.ok(!out.includes('�'))
  }
})

test('an exact-budget stop reports unknown further matches rather than inventing incompleteness', async () => {
  // path/line prefix a:1: adds4bytes; content reaches exactly7680bytes.
  const b = hostFor({ a:'hit'+'x'.repeat(7673) })
  const out = await grep({ pattern:'hit' },b.host,ctx)
  assert.match(out.output,/further matches and completeness are unknown/)
  assert.doesNotMatch(out.output,/results are incomplete/)
  assert.ok(Buffer.byteLength(out.output) <= MAX_RECEIPT_BYTES)
})
