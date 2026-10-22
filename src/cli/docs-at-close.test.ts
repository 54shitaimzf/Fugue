// 收口那一格：**归并、验收、写回之后生成文档；它的失败不改轮次**（交接单 § 2.5 · § 3.5）。
//
// 判据：自动收口是版本触发点；生成失败只落在文档自己的结果里；打桩与回放两档不出网；
// 没配文档时收口一个字节都不多。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { commitFiles, tmpRepo } from '../../test/helpers/docs-repo.ts'
import { openTruth } from '../truth/truth.ts'
import type { ConfigDoc } from '../config.ts'
import type { Contract } from '../contract/types.ts'
import type { RoundRun } from '../round/execute.ts'
import type { CommitId } from '../terms.ts'
import { docsAtClose } from './docs-at-close.ts'
import type { DocCaller } from '../docs/contract.ts'
import { docsRootOf } from '../docs/contract.ts'

const CONFIG: ConfigDoc = {
  docs: {
    theme: 'primer',
    pages: [{ id: 'start', title: '开始', source: 'README.md', audience: '新人', role: '上手', prompt: '最短路径' }],
  },
}

const CONTRACT: Contract = {
  id: 'c1',
  agent: 'agent/r1/1',
  branch: 'refs/heads/agent/r1/1',
  goal: '写一份说明',
  kind: 'implement',
  ownedPaths: ['README.md'],
  deliverables: [],
  assertions: [],
  seed: [],
  actionOutputs: {},
}

const BODY = ['## 开始 {#begin}', '', '正文。'.repeat(400)].join('\n')

function fake(): DocCaller {
  return {
    model: 'fake/model',
    wireModel: 'fake',
    async call(req) {
      if (req.system.includes('只输出一个 JSON 对象')) return { text: '{"paths":[]}', usage: null }
      return { text: BODY, usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: null, model: null } }
    },
  }
}

function runOf(o: { accepted: boolean; commit: string }): RoundRun {
  return {
    round: 'r1',
    base: 'base0000000000000000000000000000000000000' as CommitId,
    batch: {
      round: 'r1',
      base: 'base0000000000000000000000000000000000000' as CommitId,
      contracts: [CONTRACT],
      precheck: { pairs: 0 } as never,
    },
    work: { c1: o.commit as CommitId },
    reused: [],
    precheckPlanning: 0,
    precheckMerge: { ok: true, count: 0 },
    drift: null,
    fold: { kind: 'folded', commit: o.commit as CommitId, tree: 't' as never, steps: 1 },
    conflictTree: null,
    report: { results: [], pass: 3, fail: o.accepted ? 0 : 2, unrunnable: 0, ok: o.accepted },
    advanced: o.accepted ? { written: ['README.md'], removed: [], skipped: [], commit: o.commit as CommitId } : null,
    state: 'Rebuilding' as never,
  } as unknown as RoundRun
}

async function repo(): Promise<{ root: string; commit: string }> {
  const root = tmpRepo()
  const commit = await commitFiles(root, { 'README.md': '# demo\n', 'package.json': JSON.stringify({ name: 'demo', version: '1.2.3' }) }, [], 'refs/heads/main')
  return { root, commit: String(commit) }
}

const flags = new Map<string, string | true>()

test('① 没配文档：收口返回 null（轮次的机器面一个字节都不多）', async (ctx) => {
  const { root, commit } = await repo()
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const out = await docsAtClose({ root, config: {}, flags, round: 'r1', run: runOf({ accepted: true, commit }), live: true, replay: false, caller: fake() })
  assert.equal(out, null)
  assert.equal(existsSync(docsRootOf(root)), false)
  console.log('① 读数：null · 产物目录没被建出来')
})

test('② 验收没过：不生成，话里说清（旧批次仍在原处）', async (ctx) => {
  const { root, commit } = await repo()
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const out = await docsAtClose({ root, config: CONFIG, flags, round: 'r1', run: runOf({ accepted: false, commit }), live: true, replay: false, caller: fake() })
  assert.ok(out !== null)
  assert.equal(out.ok, false)
  assert.ok(out.lines[0]!.includes('没有通过验收'), out.lines.join(' | '))
  assert.equal(existsSync(docsRootOf(root)), false)
  console.log(`② 读数：ok=false · ${out.lines[0]}`)
})

test('③ 打桩档与回放档都不出网：不生成，并指到 docs build', async (ctx) => {
  const { root, commit } = await repo()
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const stub = await docsAtClose({ root, config: CONFIG, flags, round: 'r1', run: runOf({ accepted: true, commit }), live: false, replay: false, caller: fake() })
  const replay = await docsAtClose({ root, config: CONFIG, flags, round: 'r1', run: runOf({ accepted: true, commit }), live: true, replay: true, caller: fake() })
  assert.ok(stub !== null && replay !== null)
  assert.ok(stub.lines[0]!.includes('打桩档') && stub.lines[0]!.includes('docs build'), stub.lines.join(' | '))
  assert.ok(replay.lines[0]!.includes('回放档'), replay.lines.join(' | '))
  assert.equal(existsSync(docsRootOf(root)), false, '两档都不该写产物')
  console.log(`③ 读数：打桩 → ${stub.lines[0]} · 回放 → ${replay.lines[0]}`)
})

test('④ 真档 + 通过验收：按写回的那个提交生成，材料记着本轮契约与验收读数', async (ctx) => {
  const { root, commit } = await repo()
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const out = await docsAtClose({ root, config: CONFIG, flags, round: 'r1', run: runOf({ accepted: true, commit }), live: true, replay: false, caller: fake() })
  assert.ok(out !== null)
  assert.equal(out.ok, true, out.lines.join(' | '))
  assert.ok(out.lines[0]!.includes('1 页已生成'), out.lines[0])
  assert.equal(existsSync(`${docsRootOf(root)}/index.html`), true)
  const materials = out.value.materials as { kind: string; contracts: { id: string; paths: string[] }[]; verify: { ok: boolean; passed: number } }
  assert.equal(materials.kind, 'round')
  assert.deepEqual(materials.contracts.map((c) => [c.id, c.paths]), [['c1', ['README.md']]])
  assert.deepEqual(materials.verify.ok, true)
  assert.equal(out.value.commit, commit, '文档对应的是写回的那个提交')
  console.log(`④ 读数：${out.lines[0]} · 契约 ${materials.contracts.length} 份 · 验收通过 ${materials.verify.passed}`)
})

test('⑤ 文档失败：返回 ok:false（轮次那一侧照旧按验收定退出码）', async (ctx) => {
  const { root, commit } = await repo()
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const bad: DocCaller = {
    ...fake(),
    async call() {
      throw new Error('模型端点连不上（夹具）')
    },
  }
  const out = await docsAtClose({ root, config: CONFIG, flags, round: 'r1', run: runOf({ accepted: true, commit }), live: true, replay: false, caller: bad })
  assert.ok(out !== null)
  assert.equal(out.ok, false)
  assert.ok(out.lines[0]!.includes('生成失败'), out.lines.join(' | '))
  assert.equal(existsSync(`${docsRootOf(root)}/manifest.json`), false)
  console.log(`⑤ 读数：${out.lines[0]}`)
})
