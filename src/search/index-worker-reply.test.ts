import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeIndexWorkerReply } from './index-worker-reply.ts'
import { MAX_INDEX_BYTES } from './index-format.ts'

test('reply nonce prevents a late/foreign worker result from excluding current source', () => {
  const keys = Float64Array.from([0, 123, 0xffff_ffff_ffff])
  const message = { ok: true, temporaryId: 'current', stored: true, serializedBytes: 400, keys }
  assert.equal(decodeIndexWorkerReply(message, 'next-job'), null)
  const reply = decodeIndexWorkerReply(message, 'current')
  assert.ok(reply)
  keys[0] = 999
  assert.deepEqual([...reply.grams], [0, 123, 0xffff_ffff_ffff], 'retention snapshots validated keys')
})

test('malformed/noncanonical worker payloads fail open instead of returning exclusions', () => {
  const valid = { ok: true, temporaryId: 'job', stored: false, serializedBytes: 100, keys: Float64Array.from([1, 2]) }
  for (const value of [null, {}, { ...valid, ok: false }, { ...valid, stored: undefined },
    { ...valid, serializedBytes: MAX_INDEX_BYTES + 1 }, { ...valid, keys: [1, 2] },
    ...[[NaN], [-1], [0xffff_ffff_ffff + 1], [1, 1], [2, 1]].map(keys => ({ ...valid, keys: Float64Array.from(keys) }))]) {
    assert.equal(decodeIndexWorkerReply(value, 'job'), null)
  }
  assert.ok(decodeIndexWorkerReply(valid, 'job'))
})
