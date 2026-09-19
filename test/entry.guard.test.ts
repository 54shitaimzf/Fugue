// 入口的两条断言。它守的是"漏了不报错"——与文档里登记过的映射缺口同一种病：
// 少了一条没人报错，读数看起来是好的。`node --test` 自己在零发现时是成功退出
// （实测 tests 0 / pass 0 / fail 0 / exit 0），所以入口必须把发现数变成断言。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discover } from '../tools/test-entry.js'

const REPO = join(import.meta.dirname, '..')
const ENTRY = join(REPO, 'tools', 'test-entry.js')

test('发现数不为 0，且覆盖 test/ 与 src/ 两处', () => {
  const files = discover(REPO)
  assert.ok(files.length >= 2, `只发现 ${files.length} 个测试文件`)
  assert.ok(
    files.some((f) => f.endsWith('entry.guard.test.ts')),
    '入口的发现范围没有覆盖 test/',
  )
})

test('负对照：空目录下入口非零退出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-entry-'))
  try {
    const r = spawnSync(process.execPath, [ENTRY], { cwd: dir, encoding: 'utf8' })
    assert.notEqual(r.status, 0, `发现 0 个测试时退出码应为非 0，实得 ${r.status}`)
    assert.match(r.stderr, /发现 0 个测试文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
