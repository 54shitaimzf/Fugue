import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, unlinkSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wireInTransport } from '../model/http.ts'
import { adaptWireIn, adaptedRequestOf } from '../../test/helpers/wire-catalog.ts'

const fixture = fileURLToPath(new URL('./__fixture__/wire-in/', import.meta.url))
test('catalog adaptation preserves original provenance on a repeated invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-wire-integrity-'))
  try {
    cpSync(fixture, root, { recursive: true })
    const before = readFileSync(join(root, 'provenance.json'))
    adaptWireIn(root, true)
    assert.deepEqual(readFileSync(join(root, 'provenance.json')), before)
    adaptWireIn(root, true)
    assert.deepEqual(readFileSync(join(root, 'provenance.json')), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


function snapshot(root: string, path = ''): Record<string, { bytes: string; mtimeMs: number }> {
  const result: Record<string, { bytes: string; mtimeMs: number }> = {}
  for (const name of readdirSync(join(root, path))) {
    const relative = join(path, name), at = join(root, relative), meta = statSync(at)
    if (meta.isDirectory()) Object.assign(result, snapshot(root, relative))
    else result[relative] = { bytes: readFileSync(at).toString('base64'), mtimeMs: meta.mtimeMs }
  }
  return result
}

test('repeat and dry-run preserve every byte and mtime, with truthful zero writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-wire-noop-'))
  try {
    cpSync(fixture, root, { recursive: true })
    for (const path of Object.keys(snapshot(root))) utimesSync(join(root, path), 0, 0)
    const before = snapshot(root), provenance = JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8'))
    for (const write of [false, true, true]) {
      const { writtenFiles, ...result } = adaptWireIn(root, write)
      assert.equal(writtenFiles, 0)
      assert.deepEqual(result, provenance)
      assert.deepEqual(snapshot(root), before)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('late corrupt seed, response, metadata, scenario and noncatalog request reject before any write', () => {
  const changes: [string, (root: string) => void][] = [
    ['source', root => writeFileSync(join(root, 'original/wire/call-0003/request.json'), 'changed seed')],
    ['manifest', root => writeFileSync(join(root, 'original/manifest.json'), '{}')],
    ['response', root => writeFileSync(join(root, 'wire/call-0003/response.sse'), 'changed response')],
    ['metadata', root => {
      const path = join(root, 'wire/call-0003/meta.json'), meta = JSON.parse(readFileSync(path, 'utf8'))
      meta.responseBytes++; writeFileSync(path, JSON.stringify(meta))
    }],
    ['scenario', root => writeFileSync(join(root, 'scenario.json'), '{}')],
    ['request', root => {
      const path = join(root, 'wire/call-0003/request.json'), request = JSON.parse(readFileSync(path, 'utf8'))
      request.messages = []; writeFileSync(path, JSON.stringify(request))
    }],
    ['missing target', root => unlinkSync(join(root, 'provenance.json'))],
  ]
  for (const [name, corrupt] of changes) {
    const root = mkdtempSync(join(tmpdir(), 'fugue-wire-corrupt-'))
    try {
      cpSync(fixture, root, { recursive: true })
      const first = join(root, 'wire/call-0001/request.json'), request = JSON.parse(readFileSync(first, 'utf8'))
      request.tools = []; writeFileSync(first, JSON.stringify(request))
      corrupt(root)
      const before = snapshot(root)
      assert.throws(() => adaptWireIn(root, true), undefined, name)
      assert.deepEqual(snapshot(root), before, name)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('immutable historical transport accepts its original request and rejects synthetic current catalog bytes', async () => {
  const original = join(fixture, 'original/wire'), path = join(original, 'call-0001/request.json')
  const recorded = readFileSync(path), adapted = adaptedRequestOf(recorded)
  assert.notDeepEqual(adapted, recorded)
  assert.ok((await Array.fromAsync(wireInTransport(original).post({} as never, recorded))).length > 0)
  await assert.rejects(Array.fromAsync(wireInTransport(original).post({} as never, adapted)), /不是那一次请求/)
})

test('actual write count reports only changed derivatives and keeps original provenance stable', () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-wire-write-count-'))
  try {
    cpSync(fixture, root, { recursive: true })
    const path = join(root, 'wire/call-0001/request.json'), expected = readFileSync(path)
    const request = JSON.parse(expected.toString('utf8')), provenance = readFileSync(join(root, 'provenance.json'))
    request.tools = []; writeFileSync(path, JSON.stringify(request))
    const before = snapshot(root)
    assert.equal(adaptWireIn(root, false).writtenFiles, 0)
    assert.deepEqual(snapshot(root), before)
    const result = adaptWireIn(root, true)
    assert.equal(result.writtenFiles, 1)
    assert.deepEqual(readFileSync(path), expected)
    assert.deepEqual(readFileSync(join(root, 'provenance.json')), provenance)
    assert.equal(adaptWireIn(root, true).writtenFiles, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('static output leaf and directory aliases cannot overwrite immutable original evidence', () => {
  for (const kind of ['symlink', 'hardlink', 'directory']) {
    const root = mkdtempSync(join(tmpdir(), 'fugue-wire-alias-'))
    try {
      cpSync(fixture, root, { recursive: true })
      const original = join(root, 'original/wire'), target = join(root, 'wire')
      if (kind === 'directory') { rmSync(target, { recursive: true }); symlinkSync(original, target) }
      else {
        const at = join(target, 'call-0001/request.json'), source = join(original, 'call-0001/request.json')
        unlinkSync(at)
        if (kind === 'symlink') symlinkSync(source, at)
        else linkSync(source, at)
      }
      const before = snapshot(root)
      assert.throws(() => adaptWireIn(root, true), /aliased|plain directory/, kind)
      assert.deepEqual(snapshot(root), before, kind)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})
