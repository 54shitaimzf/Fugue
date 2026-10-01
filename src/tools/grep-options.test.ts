// 已声明的 grep glob/output_mode/path 必须兑现；默认 content 回执保持原样。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import type { ToolHost, ToolContext } from './execute.ts'

const ctx: ToolContext = { agent:'reader', step:0, cwd:'', holder:false }
const grep = faceOf('grep')!
const glob = faceOf('glob')!
function hostFor(files: Record<string,string>) {
  const reads: string[] = []
  const batches: string[][] = []
  const host = {
    walk: async () => Object.keys(files),
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

test('a path pattern inside the scope matches the scope-relative path, not only the view-root one', async () => {
  // 模型在 `path:'src'` / `cwd:'src'` 之下给的最自然的模式就是 `*.ts`：它说的是"范围里的文件名"。
  // 原先只按视图根相对的全路径配，于是 `^[^/]*\.ts$` 配不上 `src/a.ts` —— 回的是**毫无限定的**
  // `no line matches hit.`，而发现类工具回空列表看起来只是"真没有"。
  const files = { 'top.ts':'hit', 'src/a.ts':'hit', 'src/sub/b.ts':'hit', 'src/c.js':'hit' }
  for (const scope of [{ path:'src' },{ cwd:'src' }] as const) {
    const b = hostFor(files)
    const where = 'cwd' in scope ? { ...ctx,cwd:'src' } : ctx
    const args = 'path' in scope ? { pattern:'hit',glob:'*.ts',path:'src' } : { pattern:'hit',glob:'*.ts' }
    const out = await grep(args,b.host,where)
    assert.equal(out.output,'1 lines:\nsrc/a.ts:1:hit',JSON.stringify(scope))
    assert.deepEqual(b.reads,['src/a.ts'],JSON.stringify(scope))
  }
  // 视图根相对的那一份照旧认（两边取并，不是换一套）。
  const b = hostFor(files)
  assert.equal((await grep({ pattern:'hit',glob:'src/**/*.ts' },b.host,ctx)).output,
    '2 lines:\nsrc/a.ts:1:hit\nsrc/sub/b.ts:1:hit')
  assert.equal((await glob({ pattern:'*.ts',path:'src' },b.host,ctx)).output,'1 paths:\nsrc/a.ts')
  assert.equal((await glob({ pattern:'**/*.ts' },b.host,ctx)).output,'3 paths:\ntop.ts\nsrc/a.ts\nsrc/sub/b.ts')
})

test('a scope with a trailing slash means the same thing as one without', async () => {
  // `path:'src/'` 不归一的话 `dir + '/'` 成了 `'src//'`、`path === dir` 也不成立 → 候选集空集。
  const files = { 'src/a.ts':'hit', 'src/sub/b.ts':'hit', 'other/c.ts':'hit' }
  for (const [slash, plain] of [['src/','src'],['src/a.ts/','src/a.ts']] as const) {
    const a = hostFor(files)
    const c = hostFor(files)
    assert.equal((await grep({ pattern:'hit',path:slash },a.host,ctx)).output,
      (await grep({ pattern:'hit',path:plain },c.host,ctx)).output,`grep path:${slash}`)
    assert.ok(a.reads.length > 0,`grep path:${slash} 一个文件都没读`)
    const ga = hostFor(files)
    const gc = hostFor(files)
    assert.equal((await glob({ pattern:'**/*.ts',path:slash },ga.host,ctx)).output,
      (await glob({ pattern:'**/*.ts',path:plain },gc.host,ctx)).output,`glob path:${slash}`)
  }
  // 范围直接指一条文件：`glob` 与 `grep` 从此是同一套语义（原先只有 `grep` 认）。
  const b = hostFor(files)
  assert.equal((await glob({ pattern:'**/*.ts',path:'src/a.ts' },b.host,ctx)).output,'1 paths:\nsrc/a.ts')
})

test('grep default content stays byte-identical, including trailing blank and invalid UTF-8 lines', async () => {
  const files = { 'a':'hit\n\nhit\n', 'b':'中文 hit\r\n', 'c':'nothing' }
  const b = hostFor(files)
  const expected = Object.entries(files).flatMap(([path,body]) => body.split('\n').flatMap((line,index) => /hit/.test(line) ? [`${path}:${index+1}:${line}`] : []))
  assert.equal((await grep({ pattern:'hit' },b.host,ctx)).output,`${expected.length} lines:\n${expected.join('\n')}`)
  assert.equal((await grep({ pattern:'^$',path:'a',output_mode:'count' },b.host,ctx)).output,'1 paths:\na:2')
  const raw = Buffer.from([0xff,0x68,0x69,0x74,10])
  const binaryHost = { walk:async () => ['raw'],readBytes:async () => ({ bytes:raw,mode:0o100644 }) } as ToolHost
  assert.equal((await grep({ pattern:'hit' },binaryHost,ctx)).output,'1 lines:\nraw:1:�hit')
})
