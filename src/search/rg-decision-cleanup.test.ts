import assert from 'node:assert/strict'
import test from 'node:test'
import { removeGeneratedDirectories } from '../../tools/rg-decision-cleanup.js'

test('one generated-directory removal failure still attempts all snapshots and fixture', () => {
  const visited: string[] = [], first = new Error('snapshot removal'), second = new Error('root removal')
  assert.throws(() => removeGeneratedDirectories(['snapshot-one', 'snapshot-two', 'fixture'], path => {
    visited.push(path)
    if (path === 'snapshot-one') throw first
    if (path === 'fixture') throw second
  }), (error: unknown) => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second)
  assert.deepEqual(visited, ['snapshot-one', 'snapshot-two', 'fixture'])
})
