// 基准参数/引用失败也不能留下分配过的临时目录。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { closeIndexBenchmark } from '../../tools/bench-index-cleanup.js'

const script = join(import.meta.dirname, '../../tools/bench-index-probes.js')
test('probe benchmark rejects invalid parameters/references before allocating any temporary workspace', () => {
  const temporary = tmpDir('fugue-probe-bench-negative-')
  for (const args of [[], ['--reference-root'], ['--reference-root', join(temporary, 'missing')], ['--runs', '0']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', maxBuffer: 64 * 1024,
    })
    assert.equal(result.status, 1, `bad benchmark input should fail: ${args.join(' ')}`)
    assert.deepEqual(readdirSync(temporary), [], 'failed input/import must not allocate a benchmark root')
  }
})

test('prepared benchmark actually invokes the reference backend and cleans up if its constructor fails', () => {
  const reference = tmpDir('fugue-probe-bench-reference-')
  const temporary = tmpDir('fugue-probe-bench-runtime-')
  const repository = join(import.meta.dirname, '../..')
  for (const path of ['src/tools/host.ts', 'src/search/current-view-candidates.ts', 'src/search/index-format.ts', 'src/search/index-store.ts']) {
    const target = join(reference, path)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(join(repository, path), target)
  }
  writeFileSync(join(reference, 'src/search/blob-index.ts'), "export function createBlobIndexLookup() { throw new Error('reference lookup sentinel') }\n")
  const result = spawnSync(process.execPath, [script, '--reference-root', reference, '--runs', '1', '--files', '1', '--lines', '1'], {
    env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', maxBuffer: 64 * 1024,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /reference lookup sentinel/, 'both sides must not silently share the current lookup')
  assert.deepEqual(readdirSync(temporary), [], 'constructor failure must close resources and remove generated benchmark work')
})


test('rejected reference close still observes both owned handles, including constructor absence', async () => {
  const events: string[] = []
  const error = new Error('reference close rejected')
  const log = { close: async () => { events.push('log') } }
  const truth = { close: async () => { events.push('truth') } }
  await assert.rejects(closeIndexBenchmark({ close: async () => { events.push('index'); throw error } }, log, truth), cause => cause === error)
  assert.deepEqual(events, ['index', 'log', 'truth'])
  events.length = 0
  await closeIndexBenchmark(undefined, log, truth)
  assert.deepEqual(events, ['log', 'truth'])
})

test('owned close failure still waits for the other handle and synchronous throws cannot skip it', async () => {
  const error = new Error('log close rejected')
  let release: () => void = () => {}
  const gate = new Promise<void>(done => { release = done })
  let returned = false
  let truthClosed = false
  const pending = closeIndexBenchmark(undefined, { close: async () => { throw error } }, {
    close: async () => { await gate; truthClosed = true },
  }).then(() => { returned = true; return null }, cause => { returned = true; return cause })
  try {
    await new Promise<void>(done => setImmediate(done))
    assert.equal(returned, false, 'failed log close must not race workspace cleanup ahead of Truth close')
    assert.equal(truthClosed, false)
  } finally { release() }
  assert.equal(await pending, error)
  assert.equal(truthClosed, true)
  let synchronousTruthClosed = false
  await assert.rejects(closeIndexBenchmark(undefined, { close: () => { throw error } }, {
    close: async () => { synchronousTruthClosed = true },
  }), cause => cause === error)
  assert.equal(synchronousTruthClosed, true)
})
