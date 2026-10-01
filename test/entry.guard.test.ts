// 入口的两条断言。它守的是"漏了不报错"——与文档里登记过的映射缺口同一种病：
// 少了一条没人报错，读数看起来是好的。`node --test` 自己在零发现时是成功退出
// （实测 tests 0 / pass 0 / fail 0 / exit 0），所以入口必须把发现数变成断言。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { discover, splitLanes, auditFast } from '../tools/test-entry.js'

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

// 0.2.1 分档的判据。W8 那次两批静默丢测试（tests 325 而非 332、退出码 0），病根是丢文件不报错；
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

test('点名子集：只跑点名的那些 · 点名不在所选档里当场红', () => {
  // 正路：点名本仓快档里的一个文件，只跑它（stderr 那行写出 1 个文件）。
  const ok = spawnSync(process.execPath, [ENTRY, 'fast', 'test/version.test.ts'], { cwd: REPO, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /档 fast：1 个文件/)
  // 点名一个真档文件却选了快档 → 当场红（不静默跳过）。
  const real = splitLanes(discover(REPO)).real[0]
  const wrongLane = spawnSync(process.execPath, [ENTRY, 'fast', relative(REPO, real)], { cwd: REPO, encoding: 'utf8' })
  assert.notEqual(wrongLane.status, 0, '点名另一档的文件应当红')
  assert.match(wrongLane.stderr, /不在「fast」档里/)
  // 点名一个不存在的路径 → 同样当场红。
  const nope = spawnSync(process.execPath, [ENTRY, 'fast', 'src/nope.test.ts'], { cwd: REPO, encoding: 'utf8' })
  assert.notEqual(nope.status, 0, '点名不存在的路径应当红')
  assert.match(nope.stderr, /不在「fast」档里/)
})

test('审计的判据：快档出现真依赖调用形状即报（闭合清单 · 字面匹配）', () => {
  // 形状字面量拆开拼：守卫自己是快档，整串写进源码会咬到自己——这正是被审对象与
  // 审计器同文件的自指，拼开是唯一不设豁免的解法。
  const bwrapShape = "spawnSync('bw" + "rap'"
  const dir = mkdtempSync(join(tmpdir(), 'fugue-audit-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'clean.test.ts'), 'import { test } from "node:test"\n')
    writeFileSync(join(dir, 'src', 'dirty.test.ts'), 'const r = ' + bwrapShape + ', [])\n')
    const { fast } = splitLanes(discover(dir))
    const hits = auditFast(fast)
    assert.equal(hits.length, 1, `应恰好报一条，实得 ${JSON.stringify(hits)}`)
    assert.ok(hits[0].file.endsWith('dirty.test.ts'), '报错了文件')
    assert.equal(hits[0].shape, bwrapShape)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // 真实仓：当前快档必须零命中——将来谁往快档文件写真依赖调用，这一行就红
  const { fast } = splitLanes(discover(REPO))
  assert.deepEqual(
    auditFast(fast),
    [],
    '快档含真依赖形状——该文件要么改断言，要么首行声明 // tier: real',
  )
})
