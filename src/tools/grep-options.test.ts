// 已声明的 grep glob/output_mode/path 必须兑现；默认 content 回执保持原样。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import type { ToolHost, ToolContext } from './execute.ts'

const ctx: ToolContext = { agent:'reader', step:0, cwd:'', holder:false }
const grep = faceOf('grep')!
function hostFor(files: Record<string,string>) {
  const reads: string[] = []
  const batches: string[][] = []
  const host = {
    walk: async () => Object.keys(files),
    walkDetailed: async () => ({ paths:Object.keys(files),truncated:false,limits:[] }),
    readBytes: async (path:string) => { reads.push(path); return { bytes:Buffer.from(files[path]!), mode:0o100644 } },
    prefetch: async (paths:readonly string[]) => { batches.push([...paths]) },
  } as ToolHost
  return { host, reads, batches }
}

test('grep glob filters reads and prefetch; direct file path can be searched', async () => {
  const b = hostFor({ 'src/a.ts':'hit\nmiss\nhit', 'src/b.js':'hit', 'other/c.ts':'hit' })
  const result = await grep({ pattern:'hit',path:'src',glob:'**/*.ts' },b.host,ctx)
  assert.deepEqual(result,{ ok:true,output:'2 lines:\nsrc/a.ts:1:hit\nsrc/a.ts:3:hit' })
  assert.deepEqual(b.reads,['src/a.ts'])
  assert.deepEqual(b.batches,[['src/a.ts']])
  const one = await grep({ pattern:'hit',path:'src/a.ts' },b.host,ctx)
  assert.equal(one.output,'2 lines:\nsrc/a.ts:1:hit\nsrc/a.ts:3:hit')
})

test('grep files_with_matches and count honor their declared output modes', async () => {
  const b = hostFor({ 'a':'hit\nhit\nmiss', 'b':'none', 'c':'hit' })
  assert.deepEqual(await grep({ pattern:'hit',output_mode:'files_with_matches' },b.host,ctx),
    { ok:true,output:'2 paths:\na\nc' })
  assert.deepEqual(await grep({ pattern:'hit',output_mode:'count' },b.host,ctx),
    { ok:true,output:'2 paths:\na:2\nc:1' })
  assert.deepEqual(await grep({ pattern:'hit',output_mode:'content' },b.host,ctx),
    await grep({ pattern:'hit' },b.host,ctx))
  assert.equal((await grep({ pattern:'absent',output_mode:'count' },b.host,ctx)).output,'no line matches absent.')
})

test('grep validates output mode and glob before touching the host', async () => {
  const host = { walk:async () => { throw new Error('must not walk') } } as ToolHost
  for (const output_mode of ['wrong','',null,1]) {
    const result = await grep({ pattern:'hit',output_mode },host,ctx)
    assert.equal(result.ok,false)
    assert.match(result.output,/output_mode/)
  }
  for (const glob of [null,1,[]]) {
    const result = await grep({ pattern:'hit',glob },host,ctx)
    assert.equal(result.ok,false)
    assert.match(result.output,/glob/)
  }
})

test('grep default content stays byte-identical, including trailing blank and invalid UTF-8 lines', async () => {
  const files = { 'a':'hit\n\nhit\n', 'b':'中文 hit\r\n', 'c':'nothing' }
  const b = hostFor(files)
  const expected = Object.entries(files).flatMap(([path,body]) => body.split('\n').flatMap((line,index) => /hit/.test(line) ? [`${path}:${index+1}:${line}`] : []))
  assert.equal((await grep({ pattern:'hit' },b.host,ctx)).output,`${expected.length} lines:\n${expected.join('\n')}`)
  assert.equal((await grep({ pattern:'^$',path:'a',output_mode:'count' },b.host,ctx)).output,'1 paths:\na:2')
  const raw = Buffer.from([0xff,0x68,0x69,0x74,10])
  const binaryHost = { walk:async () => ['raw'],walkDetailed:async () => ({ paths:['raw'],truncated:false,limits:[] }),readBytes:async () => ({ bytes:raw,mode:0o100644 }) } as ToolHost
  assert.equal((await grep({ pattern:'hit' },binaryHost,ctx)).output,'1 lines:\nraw:1:�hit')
})
