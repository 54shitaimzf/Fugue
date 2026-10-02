import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'

test('scoped-reader benchmark bad bounds fail before allocating its temporary root', () => {
  const temporary = tmpDir('fugue-batch-bench-negative-')
  const script = join(import.meta.dirname, '../../tools/bench-index-batch.js')
  for (const args of [['--batch', '129'], ['--runs', '0'], ['--files', '1025'], ['--lines']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', maxBuffer: 64 * 1024,
    })
    assert.equal(result.status, 1)
    assert.deepEqual(readdirSync(temporary), [])
  }
})
