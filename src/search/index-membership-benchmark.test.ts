import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { closeIndexBenchmark } from '../../tools/bench-index-cleanup.js'
const repository = join(import.meta.dirname, '../..')
const script = join(repository, 'tools/bench-index-membership.js')

test('membership benchmark rejects absent/bad references before allocating workspace', () => {
  const temporary = tmpDir('fugue-membership-invalid-')
  for (const args of [[], ['--product-root'], ['--product-root', repository, '--reference-root'], ['--product-root', repository, '--reference-root', join(temporary, 'missing')]]) {
    const result = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', maxBuffer: 64 * 1024 })
    assert.equal(result.status, 1)
    assert.deepEqual(readdirSync(temporary), [])
  }
})

test('reference constructor sentinel is invoked and owned benchmark handles/workspace close on failure', () => {
  const product = tmpDir('fugue-membership-product-'), reference = tmpDir('fugue-membership-reference-'), temporary = tmpDir('fugue-membership-run-')
  for (const file of ['truth/truth', 'log/log', 'view/view', 'view/lower', 'round/head', 'roots/roots']) {
    const target = join(product, `src/${file}.ts`)
    mkdirSync(dirname(target), { recursive: true }); symlinkSync(join(repository, `src/${file}.ts`), target)
  }
  for (const file of ['tools/host', 'tools/execute', 'search/current-view-candidates', 'search/regex-literal']) mkdirSync(dirname(join(product, `src/${file}.ts`)), { recursive: true })
  writeFileSync(join(product, 'src/tools/host.ts'), 'export function createToolHost(){return {}}\n')
  writeFileSync(join(product, 'src/tools/execute.ts'), 'export function faceOf(){return async()=>({output:"scan sentinel"})}\n')
  writeFileSync(join(product, 'src/search/current-view-candidates.ts'), '// owned test product\n')
  writeFileSync(join(product, 'src/search/regex-literal.ts'), '// owned test product\n')
  mkdirSync(join(reference, 'src/search'), { recursive: true })
  for (const file of ['index-store', 'index-format']) symlinkSync(join(repository, `src/search/${file}.ts`), join(reference, `src/search/${file}.ts`))
  writeFileSync(join(reference, 'src/search/blob-index.ts'), 'export function createBlobIndexLookup(){throw new Error("reference constructor sentinel")}\n')
  const result = spawnSync(process.execPath, [script, '--product-root', product, '--reference-root', reference, '--runs', '1', '--files', '1', '--lines', '1'], { env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', maxBuffer: 64 * 1024 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /reference constructor sentinel/)
  assert.deepEqual(readdirSync(temporary), [])
})

test('rejected/synchronous close cannot skip later owned resources or race cleanup', async () => {
  const events: string[] = [], error = new Error('close rejected')
  await assert.rejects(closeIndexBenchmark({ close: () => { events.push('index'); throw error } }, { close: async () => { events.push('log') } }, { close: async () => { events.push('truth') } }), cause => cause === error)
  assert.deepEqual(events, ['index', 'log', 'truth'])
  let release: () => void = () => {}, finished = false, returned = false
  const gate = new Promise<void>(done => { release = done })
  const pending = closeIndexBenchmark(undefined, { close: async () => { throw error } }, { close: async () => { await gate; finished = true } }).then(() => { returned = true; return null }, cause => { returned = true; return cause })
  await new Promise<void>(done => setImmediate(done)); assert.equal(finished, false); assert.equal(returned, false)
  release(); assert.equal(await pending, error); assert.equal(finished, true)
  await closeIndexBenchmark(undefined, undefined, { close: async () => {} })
})
