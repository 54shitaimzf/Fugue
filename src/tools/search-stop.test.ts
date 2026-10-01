// 0.3.0：回执足够后真早停，不把未遍历/未扫描的总数说成知道。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import type { ToolHost, ToolContext } from './execute.ts'
import { MAX_RECEIPT_BYTES, capReceipt } from './receipt.ts'
import { MAX_RUNTIME_TAIL_BYTES, SEARCH_ROW_BYTES, SearchRows, searchLines } from './search-receipt.ts'
import { stepsLeftTail } from '../assemble/sources.ts'
import { AGENT_LAND_NOW } from '../round/driver.ts'
import { HOLDER_LAND_NOW } from '../round/plan.ts'

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
  for (const row of ['中😀'.repeat(10000),'x'.repeat(SEARCH_ROW_BYTES),'x'.repeat(SEARCH_ROW_BYTES + 1)]) {
    const rows = new SearchRows()
    rows.add(row)
    const out = rows.render('paths','empty',{ known:false,truncated:true,limits:['rows','depth'] })
    assert.ok(Buffer.byteLength(out) <= MAX_RECEIPT_BYTES)
    assert.ok(!out.includes('�'))
  }
})

test('an exact-budget stop reports unknown further matches rather than inventing incompleteness', async () => {
  // 行前缀 `a:1:` 占 4 字节，正文刚好把那一条行凑到 SEARCH_ROW_BYTES。
  const b = hostFor({ a:'hit'+'x'.repeat(SEARCH_ROW_BYTES - 7) })
  const out = await grep({ pattern:'hit' },b.host,ctx)
  assert.match(out.output,/further matches and completeness are unknown/)
  assert.doesNotMatch(out.output,/results are incomplete/)
  assert.ok(Buffer.byteLength(out.output) <= MAX_RECEIPT_BYTES)
})

test('glob reports the real total when enumeration is complete, and only says unknown when it is not', async () => {
  // `glob` 只配路径、一个文件都不读：枚举完整时命中总数是白捡的。原先它只报放得下的前缀 +
  // `Further matches are unknown`——把**已知**的数说成未知，模型因此丢掉"该收紧模式"这个信号。
  const files = Object.fromEntries(Array.from({ length:5000 },(_,i) => [`dir/file-${String(i).padStart(6,'0')}.ts`,'x']))
  const b = hostFor(files)
  const out = await glob({ pattern:'**/*.ts' },b.host,ctx)
  assert.equal(out.ok,true)
  const head = out.output.split('\n')[0] as string
  const shown = /^(\d+) of (\d+) paths shown:$/.exec(head)
  assert.ok(shown !== null,`头里没有报出总数：${head}`)
  assert.equal(Number(shown[2]),5000,'总数就是真总数')
  assert.ok(Number(shown[1]) < 5000 && Number(shown[1]) > 0,`显示的是前缀：${head}`)
  assert.equal(out.output.split('\n').length - 1,Number(shown[1]) + 1,'列出的行数与头里那个数一致')
  assert.doesNotMatch(out.output,/further matches are unknown/i,'总数已知就不许说未知')
  assert.match(out.output,new RegExp(`${5000 - Number(shown[1])} more paths are not shown`))
  assert.ok(Buffer.byteLength(out.output) <= MAX_RECEIPT_BYTES)
  assert.equal(b.reads.length,0,'路径匹配不读任何文件')

  // 枚举自己不全：`hit.length` 不是总数，那一档仍然不报（也不报一个假的总数）。
  const cut = hostFor(files,['rows'])
  const partial = await glob({ pattern:'**/*.ts' },cut.host,ctx)
  assert.doesNotMatch(partial.output,/ of \d+ paths shown/,'枚举不全时不许冒充总数')
  assert.match(partial.output,/further matches are unknown/i)
  assert.match(partial.output,/enumeration incomplete/i)

  // grep 不读完文件确实不知道还有多少命中：那一侧的措辞不许跟着变。
  const g = hostFor(Object.fromEntries(Array.from({ length:300 },(_,i) => [`f-${i}`,('hit '+'y'.repeat(100)+'\n').repeat(5)])))
  assert.match((await grep({ pattern:'hit' },g.host,ctx)).output,/further matches are unknown/i)
})

test('the row budget leaves room for the worst case header, notes and runtime step tail', () => {
  // 原先这个留量是拍出来的（`MAX_RECEIPT_BYTES - 512`），而最坏情况下只剩 42 字节余量：
  // 任何一句措辞加长就把搜索回执挤到 `capReceipt` 去中段截掉——正是这一单元声称要避免的事。
  // 而且**没有一条测试能发现它**：所有字节断言都落在追加步预算那一句之前的 face 输出上。
  for (const closing of [AGENT_LAND_NOW,HOLDER_LAND_NOW]) {
    const tail = stepsLeftTail(9_999_998,9_999_999,closing)
    assert.notEqual(tail,'')
    assert.ok(Buffer.byteLength(tail) <= MAX_RUNTIME_TAIL_BYTES,
      `运行时那一句 ${Buffer.byteLength(tail)} 字节，超过留量 ${MAX_RUNTIME_TAIL_BYTES}`)
  }
  // 说明块四条全上 + 结果头最长那一份 + 首条命中过长（走 shortened 分支）。
  const rows = new SearchRows()
  rows.add('中😀'.repeat(10000))
  const worst = rows.render('paths','empty',{ known:false,truncated:true,limits:['rows','depth'] },9_999_999)
  const withTail = worst + stepsLeftTail(998,1000,AGENT_LAND_NOW)
  assert.equal(capReceipt(withTail),withTail,'回执连同运行时那一句一个字节都不该被截')
  assert.ok(Buffer.byteLength(withTail) <= MAX_RECEIPT_BYTES,`${Buffer.byteLength(withTail)} > ${MAX_RECEIPT_BYTES}`)
  assert.doesNotMatch(capReceipt(withTail),/bytes omitted/)
})
