// 0.2.5：目录里声明的 read offset/limit 必须真的选行；不切整文件/图像那条字节路。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import type { ToolHost, ToolContext } from './execute.ts'
import { textWindowOf, numberedWindowOf } from './read-window.ts'
import { lineCount, capReceipt } from './receipt.ts'
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
  const head = `note (${Buffer.byteLength(body)} bytes · 4 lines · mode 100755)\n`
  assert.deepEqual(await read({ path: 'note', offset: 2, limit: 2 }, hostFor(body), ctx),
    { ok: true, output: head + '2\t第二\n3\t' })
  assert.equal((await read({ path: 'note', limit: 1 }, hostFor(body), ctx)).output, head + '1\tfirst\r')
  assert.equal((await read({ path: 'note', offset: 4 }, hostFor(body), ctx)).output, head + '4\tlast')
  assert.equal((await read({ path: 'note', limit: 0 }, hostFor(body), ctx)).output, head)
  assert.equal((await read({ path: 'note', offset: 20 }, hostFor(body), ctx)).output, head)
  assert.equal((await read({ path: 'note' }, hostFor(body), ctx)).output, head + body)
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
  assert.equal((await read({ path:'note',offset:2,limit:1 },host,ctx)).output,'note (9 bytes · 2 lines · mode 100755)\n2\tline')
  body = Buffer.from('changed\nnow\n')
  assert.equal((await read({ path:'note',offset:2,limit:1 },host,ctx)).output,'note (12 bytes · 2 lines · mode 100755)\n2\tnow')
  for (kind of ['dir','symlink','absent']) {
    assert.equal((await read({ path:'note',limit:1 },host,ctx)).ok,false)
    assert.equal(await host.readBytes('note'),null)
  }
})

test('receipt cap still applies to large selected windows with original line numbers', async () => {
  const body = '中😀 long content\n'.repeat(1000)
  const out = await read({ path:'note',offset:100,limit:500 },hostFor(body),ctx)
  const selected = reference(Buffer.from(body),100,500)
  const expected = `note (${Buffer.byteLength(body)} bytes · 1000 lines · mode 100755)\n${numberedWindowOf(selected,100)}`
  assert.equal(out.output,expected)
  assert.equal(capReceipt(out.output),capReceipt(expected))
  assert.match(capReceipt(out.output),/bytes omitted/)
})
