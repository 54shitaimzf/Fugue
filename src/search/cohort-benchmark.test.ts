import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withCohortBenchmarkHandles } from '../../tools/cohort-benchmark-owned.js'

test('benchmark setup failure preserves original error and closes partially owned handles', async () => {
  const error = new Error('setup'), closed: string[] = []
  await assert.rejects(withCohortBenchmarkHandles(async owned => {
    owned.truth = { close: () => { closed.push('truth') } }
    owned.log = { close: () => { closed.push('log'); throw new Error('cleanup') } }
    throw error
  }, () => assert.fail('setup must fail')), e => e === error)
  assert.deepEqual(closed, ['log', 'truth'])
})

test('benchmark awaits every cleanup even after an earlier rejection', async () => {
  const error = new Error('close'), closed: string[] = []
  let release!: () => void, entered!: () => void, returned = false
  const blocked = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { entered = r })
  const result = withCohortBenchmarkHandles(async owned => {
    owned.index = { close: () => { closed.push('index'); throw error } }
    owned.store = { close: async () => { closed.push('store') } }
    owned.truth = { close: async () => { entered(); await blocked; closed.push('truth') } }
  }, () => 'result')
  result.then(() => { returned = true }, () => { returned = true })
  await ready
  assert.equal(returned, false)
  release()
  await assert.rejects(result, e => e === error)
  assert.deepEqual(closed, ['index', 'store', 'truth'])
})

test('benchmark returns successful result after all four owned handles close', async () => {
  let count = 0
  const value = await withCohortBenchmarkHandles(async owned => {
    for (const name of ['index', 'store', 'log', 'truth']) owned[name] = { close: async () => { count++ } }
  }, () => 42)
  assert.equal(value, 42)
  assert.equal(count, 4)
})
