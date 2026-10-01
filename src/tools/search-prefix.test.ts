// ROADMAP §10：搜索描述字节一次改齐，离线请求重录，响应/凭据不动。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { adaptSearchWire } from '../../test/helpers/search-wire.ts'
import { wireInTransport } from '../model/http.ts'
import { hashOf } from '../assemble/assemble.ts'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { catalog, catalogHash, CATALOG_STATES } from './catalog.ts'
import type { ToolEntry } from './catalog.ts'

const names = ['deepseek-flash-anthropic.json','deepseek-flash-openai.json','deepseek-flash-openai-thinking.json']

test('all offline request fixtures capture the new stable search catalog bytes', () => {
  const hashes = CATALOG_STATES.map(state => catalogHash(catalog(state)))
  assert.equal(new Set(hashes).size,1)
  const expected = catalog(CATALOG_STATES[0]!)
  for (const name of names) {
    const fixture = JSON.parse(readFileSync(new URL(`../model/fixtures/${name}`,import.meta.url),'utf8'))
    assert.deepEqual(fixture.tools,expected,name)
    assert.equal(catalogHash(fixture.tools as ToolEntry[]),hashes[0])
    assert.match(fixture.tools.find((tool: ToolEntry) => tool.name === 'grep').description,/receipt budget.*incomplete/)
    assert.match(fixture.tools.find((tool: ToolEntry) => tool.name === 'glob').description,/limited traversal or unknown coverage/)
  }
})

test('CLI offline adaptation preserves historical recording and changes only search descriptions', async () => {
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const base = new URL('../cli/__fixture__/',import.meta.url)
  const target = tmpDir('fugue-search-prefix-offline-')
  adaptSearchWire(fileURLToPath(new URL('wire-in/',base)),target)
  const adapted = pathToFileURL(target + '/')
  const provenance = JSON.parse(readFileSync(new URL('provenance.json',adapted),'utf8'))
  assert.equal(provenance.liveRequestSent,false)
  assert.equal(provenance.catalogHash,catalogHash(catalog(CATALOG_STATES[0]!)))
  const expected = new Map(catalog(CATALOG_STATES[0]!).filter(tool => ['grep','glob'].includes(tool.name)).map(tool => [tool.name,tool.description]))
  assert.deepEqual(readFileSync(join(target,'scenario.json')),readFileSync(new URL('wire-in/scenario.json',base)))
  const replay = wireInTransport(join(target,'wire'))
  for (const call of provenance.calls) {
    const oldBytes = readFileSync(new URL(`wire-in/wire/${call.call}/request.json`,base))
    const newBytes = readFileSync(new URL(`wire/${call.call}/request.json`,adapted))
    const oldResponse = readFileSync(new URL(`wire-in/wire/${call.call}/response.sse`,base))
    const newResponse = readFileSync(new URL(`wire/${call.call}/response.sse`,adapted))
    assert.equal(digest(oldBytes),call.sourceRequestSha256)
    assert.equal(digest(newBytes),call.requestSha256)
    const oldMeta = JSON.parse(readFileSync(new URL(`wire-in/wire/${call.call}/meta.json`,base),'utf8'))
    const newMeta = JSON.parse(readFileSync(new URL(`wire/${call.call}/meta.json`,adapted),'utf8'))
    const { provenance:details, ...metadata } = newMeta
    assert.deepEqual(metadata,{ ...oldMeta,requestBytes:newBytes.length,requestHash:hashOf(newBytes) })
    assert.equal(details.liveRequestSent,false)
    assert.deepEqual(newResponse,oldResponse)
    const request = JSON.parse(oldBytes.toString('utf8'))
    for (const tool of request.tools) if (expected.has(tool.name)) tool.description=expected.get(tool.name)
    assert.deepEqual(JSON.parse(newBytes.toString('utf8')),request)
    assert.equal(digest(newResponse),call.responseSha256)
    assert.equal(call.liveRequestSent,false)
    const chunks = await Array.fromAsync(replay.post({} as never,newBytes))
    assert.deepEqual(Buffer.concat(chunks.map(bytes=>Buffer.from(bytes))),oldResponse)
  }
  const first = readFileSync(join(target,'wire','call-0001','request.json'))
  const historical = wireInTransport(fileURLToPath(new URL('wire-in/wire/',base)))
  await assert.rejects(Array.fromAsync(historical.post({} as never,first)),/不是那一次请求/)
})
