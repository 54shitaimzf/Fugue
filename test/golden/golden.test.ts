// 黄金帧的**断言**（0.4.2 站）：今天两条脸印出来的字节，一条命令一条。
//
// 依据：施工单 § 五 ①「黄金帧**两面全录**——`--json` 面与人读缺省面……覆盖全量命令（以
// `FLAGS_OF` 为准）；先录帧、后外移渲染，一命令一单元渐进迁移」。
//
// 它是**特征测试**：锁的是今天的行为。行为要显式变的时候帧随提交改并写明（这一站只新增、
// 不翻转）；帧里非常数的来源（临时路径 · 钟 · 这台机器的文件系统档）由 `normalize.mjs` 那几张
// 掩码换掉——**换的是出处，不是形状**。
//
// 两条脸都跑：一条帧录的是哪一条脸，由它自己的 `steps` 说（最后一步给不给 `--json`）——所以
// 「人读缺省档漏了」这件事在这份断言里是一个缺口，而不是一个悄悄地通过。
//
// 重录：`node test/golden/record.mjs`（全量）或点名（`… status-人面`）。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { normalizeFace } from './normalize.mjs'
import { FRAMES, seedSnapshot } from './fixture.mjs'
import { PROBES, recordProbe } from './record.mjs'

/** 探针表（`record.mjs` 那一份）按 id 查。 */
const BY_ID = new Map(PROBES.map((p) => [p.id, p]))

let seed = null
before(() => {
  seed = seedSnapshot()
})
after(() => {
  if (seed !== null) rmSync(seed.root, { recursive: true, force: true })
})

/** 帧目录里那一份录制。**一条都没有就是红**——静默跳过等于把这一站的第一件丢在地上。 */
function frames() {
  let names
  try {
    names = readdirSync(FRAMES).filter((f) => f.endsWith('.json'))
  } catch {
    names = []
  }
  assert.ok(names.length > 0, `黄金帧一份都没有：${FRAMES}——先跑 node test/golden/record.mjs`)
  return names.map((f) => JSON.parse(readFileSync(join(FRAMES, f), 'utf8')))
}

test('黄金帧：今天两条脸印出来的字节（逐字节 · 逐命令）', () => {
  const all = frames()
  const report = []
  for (const frame of all) {
    const probe = BY_ID.get(frame.id)
    assert.ok(probe !== undefined, `帧 ${frame.id} 在探针表里找不到——录制与那张表漂了`)
    const { face, paths } = recordProbe(probe, seed)
    assert.ok(face !== null, `帧 ${frame.id} 没跑出被录的那一步`)
    const got = normalizeFace(face, paths)
    assert.equal(
      got.stdout,
      frame.face.stdout,
      `${frame.id} 的 stdout 与录制不同（${frame.steps.at(-1).argv.join(' ')}）`,
    )
    assert.equal(
      got.stderr,
      frame.face.stderr,
      `${frame.id} 的 stderr 与录制不同（${frame.steps.at(-1).argv.join(' ')}）`,
    )
    assert.equal(got.code, frame.face.code, `${frame.id} 的退出码与录制不同`)
    report.push(frame.id)
  }
  assert.ok(report.length >= 60, `黄金帧只有 ${report.length} 条——覆盖面掉了`)
})
