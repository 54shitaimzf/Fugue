// U0 · 运行环境契约（架构 § 15.7）。
//
// 这四条不是"依赖"，是机制的前提：本文有几处做法直接建立在它们之上，任一不成立，
// 对应的机制要换。断言**在位**，不断言**快慢**——要进本文当常数的读数一律在一等档
// 主机上取（架构 § 8.2 实测基线）。快慢由工具量，不由测试断言。
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'

test('Node ≥ 22.6：.ts 直跑，无构建步骤', () => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  assert.ok(
    major > 22 || (major === 22 && minor >= 6),
    `当前 Node ${process.versions.node}；.ts 直跑需要 ≥ 22.6`,
  )
})

test('git ≥ 2.38：merge-tree --write-tree 在位（架构 § 8.2 硬约束 4）', () => {
  const v = execFileSync('git', ['--version'], { encoding: 'utf8' })
  const m = /(\d+)\.(\d+)/.exec(v)
  assert.ok(m, v)
  const major = Number(m[1])
  const minor = Number(m[2])
  assert.ok(major > 2 || (major === 2 && minor >= 38), v.trim())

  const h = spawnSync('git', ['merge-tree', '-h'], { encoding: 'utf8' })
  assert.match((h.stdout ?? '') + (h.stderr ?? ''), /--write-tree/)
})

test('zlib.crc32 在位：日志信封的校验字段不用手写（架构 § 9.2）', () => {
  assert.equal(typeof crc32, 'function')
  assert.equal(crc32('abc').toString(16), '352441c2')
})

test('代码工作区在 ext4 上：一等档文件系统（架构 § 15.7）', () => {
  const fs = execFileSync('findmnt', ['-no', 'FSTYPE', '-T', process.cwd()], {
    encoding: 'utf8',
  }).trim()
  assert.equal(
    fs,
    'ext4',
    `代码工作区 ${process.cwd()} 的文件系统是 ${fs}；本架构的实测基线取自 ext4`,
  )
})
