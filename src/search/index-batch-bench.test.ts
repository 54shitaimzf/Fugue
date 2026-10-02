import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = fileURLToPath(new URL('../../tools/bench-index-batch.js', import.meta.url))
function run(args: string[]) {
  const temporary = mkdtempSync(join(tmpdir(), 'fugue-index-bench-test-'))
  try {
    const result = spawnSync(process.execPath, [tool, ...args], {
      encoding: 'utf8', maxBuffer: 1 << 20, env: { ...process.env, TMPDIR: temporary },
    })
    assert.deepEqual(readdirSync(temporary), [], 'benchmark leaked its generated corpus')
    return result
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

test('group replay reports the actual reference batch and validates small full-source records', () => {
  const result = run(['--compare-batch', '4', '--batch', '32', '--files', '2', '--lines', '2', '--runs', '1'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.referenceBatchRows, 4); assert.equal(output.batchRows, 32)
  for (const phase of [output.before, output.after]) assert.equal(phase[0].unknownRecords, 0)
})

test('budget replay exposes skipped valid records and paid disk recovery with full-reference equality', () => {
  const result = run(['--compare-batch', '4', '--batch', '32', '--files', '24', '--entropy-chars', '50000', '--recover-unknown', '--runs', '1'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.sourceBytes, 2_400_000)
  assert.equal(output.before[0].batchUnknownRecords, 0)
  assert.equal(output.after[0].batchUnknownRecords, 4)
  assert.equal(output.after[0].fallbackReads, 4)
  assert.equal(output.after[0].unknownRecords, 0)
})

test('invalid comparison and entropy bounds fail before corpus allocation', () => {
  for (const args of [['--compare-batch', '0'], ['--compare-batch', '129'], ['--entropy-chars', '200001']]) {
    const result = run(args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must be an integer/)
  }
})


test('aggregate entropy work is rejected before allocation even when individual limits are valid', () => {
  const result = run(['--files', '1024', '--entropy-chars', '200000'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /aggregate entropy work/)
})
