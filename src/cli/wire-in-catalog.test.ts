// 回放夹具里的工具目录必须与当前 `catalog()` 一致——**在 fast 档就红**，而不是等 `full` 档里的
// real 测试（`chain.test.ts` 序 1）整条验收不再执行。来历见 `__fixture__/wire-in/PROVENANCE.md`。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { hashOf } from '../assemble/assemble.ts'
import { wireInTransport } from '../model/http.ts'
import { CATALOG_STATES, catalog, catalogHash } from '../tools/catalog.ts'
import { adaptedRequestOf, callsIn } from '../../test/helpers/wire-catalog.ts'

const ROOT = fileURLToPath(new URL('./__fixture__/wire-in/', import.meta.url))
const WIRE = join(ROOT, 'wire')
const CALLS = callsIn(WIRE)

/** `sha256sum -c` 认得的那一把（`*.sha256` 那两栏就是给它用的）。 */
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

test('每一份录下来的请求里的工具目录与当前 catalog() 逐字节一致（漂了就在 fast 档红）', () => {
  assert.ok(CALLS.length > 0, `${WIRE} 里一条调用都没有`)
  const entries = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
  const expected = entries.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  for (const name of CALLS) {
    const bytes = readFileSync(join(WIRE, name, 'request.json'))
    const request = JSON.parse(bytes.toString('utf8')) as { tools: unknown }
    // 一 · 这一栏逐条对上（名字 · 描述 · schema 一个字段都不差）。
    assert.deepEqual(request.tools, expected, `${name}：录下来的工具目录与当前 catalog() 不同`)
    // 二 · **整份请求的字节**与"按当前目录改齐"的结果相同：键序、转义、别的栏一个字节都不许漂。
    //      改了描述忘了跑 `node tools/adapt-wire-in.ts`，红在这一句。
    assert.ok(
      Buffer.from(adaptedRequestOf(bytes)).equals(bytes),
      `${name}：请求字节与当前目录不一致——跑 node tools/adapt-wire-in.ts 改齐它`,
    )
  }
})

test('夹具自己先自洽：请求那三栏派生值与盘上字节对得上，响应那几栏一个字节都没动', () => {
  for (const name of CALLS) {
    const at = join(WIRE, name)
    const request = readFileSync(join(at, 'request.json'))
    const response = readFileSync(join(at, 'response.sse'))
    const meta = JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8')) as Record<string, unknown>
    assert.equal(meta['requestBytes'], request.length, `${name}：requestBytes`)
    assert.equal(meta['requestHash'], hashOf(request), `${name}：requestHash（回放核的就是这一栏）`)
    assert.equal(meta['responseBytes'], response.length, `${name}：responseBytes`)
    assert.equal(meta['responseHash'], hashOf(response), `${name}：responseHash`)
    // `sha256sum -c request.sha256` 那一栏（给人用的标准 sha256，不是那把 16 字符短指纹）。
    for (const [file, bytes] of [['request.json', request], ['response.sse', response]] as const) {
      const line = readFileSync(join(at, `${file.split('.')[0]}.sha256`), 'utf8')
      assert.equal(line, `${sha256(bytes)}  ${file}\n`, `${name}：${file} 的 sha256 栏`)
    }
    // A 区从发出去的 `system` 复算：目录的描述今天不在 A 区里，这一句就是那句话的断言。
    const system = (JSON.parse(request.toString('utf8')) as { system: unknown }).system
    if (typeof system === 'string') {
      assert.equal(meta['zoneAHash'], hashOf(Buffer.from(system, 'utf8')), `${name}：zoneAHash`)
    }
  }
})

test('来历那一份写明：请求离线适配 · 响应是历史的 · 一次 live 都没发', () => {
  const got = JSON.parse(readFileSync(join(ROOT, 'provenance.json'), 'utf8')) as Record<string, unknown>
  assert.equal(got['liveRequestSent'], false)
  assert.equal(got['historicalResponseAndUsage'], true)
  assert.equal(got['catalogHash'], catalogHash(catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])))
  assert.equal((got['calls'] as unknown[]).length, CALLS.length)
})

test('负对照：改齐之后仍然"录下来的字节被改过就当场拒"——改一个字节，回放不收', async () => {
  const at = join(WIRE, CALLS[0] as string)
  const bytes = readFileSync(join(at, 'request.json'))
  const replay = wireInTransport(WIRE)
  // 原样那一份收（这一句同时是"盘上这一份就是产品今天会发的那一份"的读数）。
  assert.ok((await Array.fromAsync(replay.post({} as never, bytes))).length > 0)
  const flipped = Buffer.from(bytes)
  flipped[0] = flipped[0] === 0x7b ? 0x5b : 0x7b
  await assert.rejects(Array.fromAsync(wireInTransport(WIRE).post({} as never, flipped)), /不是那一次请求/)
})
