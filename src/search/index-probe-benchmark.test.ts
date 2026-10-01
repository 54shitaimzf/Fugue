// 基准参数/引用失败也不能留下分配过的临时目录。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'

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
