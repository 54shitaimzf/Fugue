// 窗口读取：目录里声明的 read offset/limit 必须真的选行；不切整文件/图像那条字节路。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import type { ToolHost, ToolContext } from './execute.ts'
import { textWindowOf, numberedWindowOf } from './read-window.ts'
import { lineCount, capReceipt } from './receipt.ts'
import { CATALOG_STATES, catalog } from './catalog.ts'
import { createToolHost } from './host.ts'
import type { View } from '../view/contract.ts'
import type { Roots } from '../roots/contract.ts'

const ctx: ToolContext = { agent: 'reader', step: 0, cwd: '', holder: false }
const read = faceOf('read')!

function hostFor(text: string): ToolHost {
  return { readBytes: async () => ({ bytes: Buffer.from(text), mode: 0o100755 }) } as ToolHost
}

test('read offset/limit select and number only the requested original lines', async () => {
  const body = 'first\r\n第二\n\nlast\n'
  // 头里**先是整文件那两个数，再是这一份回执的窗口**；整文件那一档没有窗口可说。
  const head = (window: string) => `note (${Buffer.byteLength(body)} bytes · 4 lines · mode 100755${window})\n`
  assert.deepEqual(await read({ path: 'note', offset: 2, limit: 2 }, hostFor(body), ctx),
    { ok: true, output: head(' · lines 2–3 shown') + '2\t第二\n3\t' })
  assert.equal((await read({ path: 'note', limit: 1 }, hostFor(body), ctx)).output, head(' · line 1 shown') + '1\tfirst\r')
  assert.equal((await read({ path: 'note', offset: 4 }, hostFor(body), ctx)).output, head(' · line 4 shown') + '4\tlast')
  assert.equal((await read({ path: 'note', limit: 0 }, hostFor(body), ctx)).output, head(' · no lines shown'))
  assert.equal((await read({ path: 'note', offset: 20 }, hostFor(body), ctx)).output, head(' · no lines shown'))
  assert.equal((await read({ path: 'note' }, hostFor(body), ctx)).output, head('') + body)
})

test('only the sliced read carries line numbers, and the catalog says so instead of promising them outright', async () => {
  const body = 'first\nsecond\n'
  const whole = (await read({ path: 'note' }, hostFor(body), ctx)).output
  const sliced = (await read({ path: 'note', offset: 1 }, hostFor(body), ctx)).output
  assert.ok(whole.endsWith('\nfirst\nsecond\n'), `整文件那一档是原样字节，不带行号：${whole}`)
  assert.ok(sliced.endsWith('\n1\tfirst\n2\tsecond'), `切片那一档带原文件行号：${sliced}`)
  // **公布面 == 兑现面**（架构 § 8.10）：开头那句说的是「不给窗口时拿到什么」，而那一档不带
  // 行号——行号这件事只许挂在括号里那半句（切片）上，不许是无条件的承诺。
  const entry = catalog(CATALOG_STATES[0]!).find((t) => t.name === 'read')
  assert.ok(entry !== undefined)
  const opening = entry.description.slice(0, entry.description.indexOf('.') + 1)
  assert.doesNotMatch(opening, /line numbers/, `整文件读不带行号，开头那句不能无条件承诺行号：${opening}`)
  assert.match(entry.description, /a slice comes back with the original line numbers/, '切片带行号这件事仍要公布')
})

test('read rejects malformed windows before asking the host for content', async () => {
  let calls = 0
  const host = { readBytes: async () => { calls++; throw new Error('must not fetch') } } as ToolHost
  for (const offset of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    const result = await read({ path: 'note', offset }, host, ctx)
    assert.equal(result.ok, false)
    assert.match(result.output, /offset/)
  }
  for (const limit of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    const result = await read({ path: 'note', limit }, host, ctx)
    assert.equal(result.ok, false)
    assert.match(result.output, /limit/)
  }
  assert.equal(calls, 0)
})



function reference(bytes: Uint8Array, offset: number, limit?: number) {
  const body = Buffer.from(bytes).toString('utf8')
  const lines = body === '' ? [] : body.split('\n')
  if (body.endsWith('\n')) lines.pop()
  const selected = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit)
  return {
    text: selected.join('\n'), byteLength: bytes.byteLength, lines: lineCount(body), selectedLines: selected.length,
  }
}

test('byte windows match decode-then-split including CRLF, invalid UTF-8 and byte subarrays', () => {
  const bodies = ['', '\n', '\n\n', 'abc', 'first\r\nsecond\n', 'a\rb\u2028c\n😀\n末尾']
  const corpus = [...bodies.map(body => Buffer.from(body)), Buffer.from([0xff, 10, 0xe2, 0x82, 10, 0, 0xfe])]
  for (const bytes of corpus) {
    const storage = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')])
    const subarray = storage.subarray(6, 6 + bytes.length)
    for (const offset of [1, 2, 4, Number.MAX_SAFE_INTEGER]) {
      for (const limit of [undefined, 0, 1, 3, Number.MAX_SAFE_INTEGER]) {
        const got = textWindowOf(subarray, { offset, ...(limit === undefined ? {} : { limit }) })
        assert.deepEqual(got, reference(bytes, offset, limit))
        const numbered = reference(bytes,offset,limit)
        const expected = numbered.selectedLines === 0 ? '' : numbered.text.split('\n').map((line,i) => `${offset+i}\t${line}`).join('\n')
        assert.equal(numberedWindowOf(got,offset),expected)
      }
    }
  }
})

test('optional window host is used only by sliced reads; absent hosts keep the same answer', async () => {
  const body = 'first\nsecond\nthird\n'
  let windowCalls = 0
  let rawCalls = 0
  const fallback = hostFor(body)
  const pushed = {
    readBytes: async () => { rawCalls++; return { bytes: Buffer.from(body), mode: 0o100755 } },
    readTextWindow: async (_path, window) => { windowCalls++; return { ...textWindowOf(Buffer.from(body),window), mode:0o100755 } },
  } as ToolHost
  for (const args of [{ path:'note',offset:2,limit:1 }, { path:'note',limit:0 }]) {
    assert.deepEqual(await read(args,pushed,ctx),await read(args,fallback,ctx))
  }
  assert.equal(windowCalls,2)
  assert.equal(rawCalls,0)
  await read({ path:'note' },pushed,ctx)
  await faceOf('read_image')!({ path:'note' },pushed,ctx)
  assert.equal(windowCalls,2)
  assert.equal(rawCalls,2)
  const missing = { readTextWindow:async () => null } as ToolHost
  assert.equal((await read({ path:'missing',limit:1 },missing,ctx)).ok,false)
})

test('product host shares file checks and current view content with the raw byte path', async () => {
  let body = Buffer.from('old\nline\n')
  let kind = 'file'
  const view = {
    stat: async () => kind === 'absent' ? null : ({ kind, mode:0o100755 }),
    read: async () => body,
  } as unknown as View
  const host = createToolHost(view,{} as Roots)
  assert.ok(host.readTextWindow)
  assert.equal((await read({ path:'note',offset:2,limit:1 },host,ctx)).output,'note (9 bytes · 2 lines · mode 100755 · line 2 shown)\n2\tline')
  body = Buffer.from('changed\nnow\n')
  assert.equal((await read({ path:'note',offset:2,limit:1 },host,ctx)).output,'note (12 bytes · 2 lines · mode 100755 · line 2 shown)\n2\tnow')
  for (kind of ['dir','symlink','absent']) {
    assert.equal((await read({ path:'note',limit:1 },host,ctx)).ok,false)
    assert.equal(await host.readBytes('note'),null)
  }
})

test('a large window names its own range, and the cap mark counts the receipt rather than the file', async () => {
  const body = '中😀 long content\n'.repeat(1000)
  const out = await read({ path:'note',offset:100,limit:500 },hostFor(body),ctx)
  const selected = reference(Buffer.from(body),100,500)
  const expected = `note (${Buffer.byteLength(body)} bytes · 1000 lines · mode 100755 · lines 100–599 shown)\n${numberedWindowOf(selected,100)}`
  assert.equal(out.output,expected)
  const capped = capReceipt(out.output)
  assert.match(capped,/bytes omitted/)
  // **两套数各有所指**：头里的 31000/1000 是文件，标记里的那两个是这一条回执。原先这一格写的是
  // `capReceipt(out.output) === capReceipt(expected)`——那在上一句成立之后是恒等式，一个字都守不住。
  const mark = /…\((\d+) bytes omitted · (\d+) bytes and (\d+) lines in all\)…/.exec(capped)
  assert.ok(mark !== null,`截断标记没出现：${capped.slice(0,160)}`)
  assert.equal(Number(mark[2]),Buffer.byteLength(out.output),'标记里的字节数是这一条回执的')
  assert.equal(Number(mark[3]),lineCount(out.output),'标记里的行数是这一条回执的')
  assert.notEqual(Number(mark[2]),Buffer.byteLength(body),'回执字节与文件字节本来就不是一个数')
  assert.match(capped,/lines 100–599 shown/,'截断之后头里那句窗口仍在（头留在前 4 KiB 里）')
})
