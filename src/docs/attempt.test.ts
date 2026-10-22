// 一次尝试的记账：形状（纯函数）与落盘（`last.json`）各一条。
//
// 从 `build.ts` 搬出来时补的断言：搬之前 `./attempt.ts` 不存在（导入即失败）。判据来自
// 复审 R8（早期失败也要在“最近一次”里）与交接单 § 3.3。
import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpRepo } from '../../test/helpers/docs-repo.ts'
import { attemptOf, recordAttemptFailure } from './attempt.ts'
import { readLast } from './publish.ts'

const MATERIALS = { kind: 'manual', note: 'n' } as const

test('① 尝试的形状：成功与失败同一组栏 · usagePages 只在真有时出现 · 用量原样带过', () => {
  const ok = attemptOf({
    ok: true,
    at: '2026-10-22T00:00:00.000Z',
    commit: 'abc1234',
    fingerprint: 'sha256:ff',
    pages: 2,
    theme: 'primer',
    model: 'fake/model',
    materials: MATERIALS,
    usage: { calls: 3, inputTokens: 10, outputTokens: 5 },
    usagePages: [{ id: 'start' } as never],
    reason: null,
    at_stage: null,
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.pages, 2)
  assert.equal(ok.usage.calls, 3)
  assert.deepEqual(ok.usagePages, [{ id: 'start' }], '传了就原样带')

  const bad = attemptOf({
    ok: false,
    at: '2026-10-22T00:00:00.000Z',
    commit: null,
    fingerprint: null,
    pages: 0,
    theme: null,
    model: null,
    materials: MATERIALS,
    usage: { calls: 0, inputTokens: null, outputTokens: null },
    reason: '模型不存在',
    at_stage: 'model',
  })
  assert.equal(Object.hasOwn(bad, 'usagePages'), false, '没传就不要这一栏（不给 0 顶）')
  assert.equal(bad.at_stage, 'model')
  console.log('① 读数：成功 1 例 / 失败 1 例 · usagePages 有则带、无则缺')
})

test('② 早期失败也落账：recordAttemptFailure 写进 `.fugue/docs-last.json`，status 才看得到', async () => {
  const root = tmpRepo()
  await recordAttemptFailure({
    root,
    reason: '模型或凭据缺席：没有这个模型',
    at_stage: 'model',
    commit: null,
    materials: MATERIALS,
    model: 'fake/model',
    theme: null,
    usage: { calls: 1, inputTokens: 2, outputTokens: 3 },
  })
  const back = await readLast(root)
  assert.ok(back !== null, '写进去了才读得到')
  assert.equal(back.ok, false)
  assert.equal(back.at_stage, 'model')
  assert.equal(back.reason, '模型或凭据缺席：没有这个模型')
  assert.equal(back.usage.calls, 1)
  assert.equal(back.usage.inputTokens, 2)
  console.log(`② 读数：last.json ok=${back.ok} · at_stage=${back.at_stage} · calls=${back.usage.calls}`)
})
