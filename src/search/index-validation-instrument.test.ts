import assert from 'node:assert/strict'
import test from 'node:test'
import { observeIndexReads } from '../../tools/index-validation-instrument.js'

test('own-process observer preserves receiver/arguments/results and restores the open binding', async () => {
  const seen: unknown[] = [], answer = { size: 3 }, marker = new Error('read failed')
  const file = {
    async stat(...args: unknown[]) { assert.equal(this, file); seen.push(['stat', ...args]); return answer },
    read() { assert.equal(this, file); throw marker },
    async close() { assert.equal(this, file); seen.push(['close']); return undefined },
  }
  const api = { async open(...args: unknown[]) { assert.equal(this, api); seen.push(['open', ...args]); return file } }
  const original = api.open
  let synchronizations = 0
  const observed = observeIndexReads(api, () => synchronizations++)
  try {
    const got = await api.open('owned-fixture', 123)
    assert.equal(got, file)
    assert.equal(await got.stat('argument'), answer)
    await assert.rejects(got.read(), error => error === marker)
    await got.close()
    assert.deepEqual(seen, [['open', 'owned-fixture', 123], ['stat', 'argument'], ['close']])
    assert.equal(observed.metrics().open.calls, 1)
    assert.equal(observed.metrics().read.calls, 1)
  } finally { observed.restore() }
  observed.restore()
  assert.equal(api.open, original)
  assert.equal(synchronizations, 2)
})

test('failed open is observed without replacing its original error', async () => {
  const marker = new Error('open failed')
  const api = { open() { throw marker } }, original = api.open
  const observed = observeIndexReads(api, () => {})
  try {
    await assert.rejects(api.open(), error => error === marker)
    assert.equal(observed.metrics().open.calls, 1)
  } finally { observed.restore() }
  assert.equal(api.open, original)
})

test('failed installation sync rolls back the open binding and preserves the first hook error', () => {
  const marker = new Error('initial sync failed'), later = new Error('rollback sync failed')
  const api = { async open() { throw new Error('not called during setup') } }, original = api.open
  let calls = 0
  assert.throws(() => observeIndexReads(api, () => { throw ++calls === 1 ? marker : later }), error => error === marker)
  assert.equal(api.open, original)
  assert.equal(calls, 2, 'rollback attempts to resynchronize named exports too')
})
