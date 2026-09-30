// 入口的两条断言。它守的是"漏了不报错"——与文档里登记过的映射缺口同一种病：
// 少了一条没人报错，读数看起来是好的。`node --test` 自己在零发现时是成功退出
// （实测 tests 0 / pass 0 / fail 0 / exit 0），所以入口必须把发现数变成断言。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discover, splitLanes } from '../tools/test-entry.js'

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

// 0.2.1 分档的牙。W8 那次两批静默丢测试（tests 325 而非 332、退出码 0），病根是丢文件不报错；
// 拆档处必须带断言：两档并集==发现集、交空、拼错的声明落在快档（不静默吞成真档）。
test('分档是划分：并集==发现集 · 交空 · 拼错的声明落在快档', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-lane-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const fixtures = {
      'a.test.ts': '// tier: real —— bwrap\n', // 真档：首行声明
      'b.test.ts': 'import { test } from "node:test"\n', // 没有声明：快档
      'c.test.ts': '// tier:reel 漏了空格\n', // 声明拼错：正则不吃，落快档
      'd.test.ts': '// tier: realx 带尾缀\n', // 同上
    }
    for (const [name, body] of Object.entries(fixtures)) {
      writeFileSync(join(dir, 'src', name), body)
    }
    const files = discover(dir)
    const { fast, real } = splitLanes(files)
    assert.equal(files.length, 4, `夹具应有 4 个，发现 ${files.length}`)
    assert.equal(fast.length + real.length, files.length, '并集必须等于发现集')
    assert.equal(new Set([...fast, ...real]).size, files.length, '两档之交必须为空')
    assert.equal(real.length, 1, `真档应只有 a，实得 ${real.length}`)
    assert.ok(real[0].endsWith('a.test.ts'), '真档认错了文件')
    assert.equal(fast.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真实仓分档读数：快 + 真 == 发现数 · 两档都不空', () => {
  const files = discover(REPO)
  const { fast, real } = splitLanes(files)
  assert.equal(
    fast.length + real.length,
    files.length,
    `W8 那种丢文件，在这一行就红：快 ${fast.length} + 真 ${real.length} ≠ ${files.length}`,
  )
  assert.equal(new Set([...fast, ...real]).size, files.length)
  assert.ok(real.length >= 10, `真档少得反常（${real.length}）——声明是不是丢了`)
  assert.ok(fast.length >= 50, `快档少得反常（${fast.length}）`)
  console.log(`分档读数：全量 ${files.length} = 快 ${fast.length} + 真 ${real.length}`)
})

test('负对照：档名拼错非零退出（不静默当 all 跑）', () => {
  const r = spawnSync(process.execPath, [ENTRY, 'quick'], { cwd: REPO, encoding: 'utf8' })
  assert.notEqual(r.status, 0, `拼错档名应非零退出，实得 ${r.status}`)
  assert.match(r.stderr, /未知档/)
})
