// 判词只摊一次（U18 甲案的驱动侧收口）：轮内裁断回来的那句结论，挂到下一步的「信号摘要」上
// ——**每步只摊新增的那几句**，不许把攒下的全部重摊一遍。重摊的病灶在 `driver.ts` 那一行
// `signals: [...r.next.signals, ...notes]`：`notes` 是整格攒的，而 `r.next.signals` 里已经躺着
// 前面摊过的那几句，于是同一条判词在模型眼前出现两三遍——C 区越摊越胖，而它每一步都当新信息读。
//
// 跑法：cd ~/fugue && node --test src/round/spread.test.ts
//
//   ① 两步各带一问：第三步的前缀里**每条判词恰好一遍**（重摊那一版是两遍——红断言）；
//      第一步带回来的判词，第二步的前缀里就该有一遍（这一条两版都绿，是"该在"的负对照）
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import { BUILTIN_CATALOG, modelDeclOf } from '../model/catalog.ts'
import type { ModelEvent } from '../model/contract.ts'
import { scriptedModel } from '../runtime/step.ts'
import type { CallModel, ToolResult } from '../runtime/step.ts'
import { recordingExecutor } from '../runtime/step.ts'
import { runAgentOnce } from './driver.ts'
import type { DriverAsk } from './driver.ts'
import type { AgentId, CommitId, ContractId, WriterId } from '../terms.ts'
import type { Contract } from '../contract/types.ts'

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

const AGENT = 'agent-1' as AgentId
const DECL = modelDeclOf('deepseek-flash/anthropic', BUILTIN_CATALOG)

/** 一条工具调用（起点 · 分片 · 收尾三段，字段照 `B1` 的 `ModelEvent`）。 */
function callOne(index: number, id: string, name: string, args: unknown): ModelEvent[] {
  const text = JSON.stringify(args)
  return [
    { t: 'tool-start', index, id, name },
    { t: 'tool-delta', index, args: text },
    { t: 'tool-call', index, id, name, arguments: text },
  ]
}

/** 裁断那一次的回复：`verdictOf` 认的那两行（档 · 判词）。 */
function ruling(say: string): ModelEvent[] {
  return [
    { t: 'delta', text: `tier: contract\nruling: ${say}` },
    { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
  ]
}

test('① 两步各带一问：后一步的前缀里每条判词恰好一遍（重摊那一版是两遍）', async () => {
  // 台子：一棵只有一个文件的底（真 git，与 work.test.ts 同一套隔离）。
  const root = mkdtempSync(join(tmpdir(), 'fugue-spread-'))
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  // 这一格那条分支先立起来（产品里这一步是 `startRound` 第 4 步起的分支；这里直接把 ref 指到底上）。
  assert.equal(
    spawnSync('git', ['update-ref', 'refs/heads/agent-1', base], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status,
    0,
  )

  const truth = openTruth(root)
  const log: LogHandle = openLog(root, { write: AGENT as WriterId, sync: 'each' })

  const c = {
    id: 'c1',
    agent: AGENT,
    branch: 'refs/heads/agent/agent-1',
    goal: '把一件事做完',
    kind: 'implement',
    ownedPaths: ['src/a.ts'],
    deliverables: [{ path: 'src/a.ts', form: '模块' }],
    assertions: [],
    seed: [],
    actionOutputs: {},
  } as unknown as Contract

  const state = { ...emptyState(), goal: c.goal }

  // 脚本五趟：格子第一步（带第一问回）→ 裁断 → 格子第二步（带第二问回）→ 裁断 → 格子第三步（说完）。
  const scripts: readonly (readonly ModelEvent[])[] = [
    [...callOne(0, 'q1', 'ask_user_question', { question: '第一问' }), { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }],
    ruling('第一问的判词'),
    [...callOne(0, 'q2', 'ask_user_question', { question: '第二问' }), { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }],
    ruling('第二问的判词'),
    [{ t: 'delta', text: '干完了。' }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }],
  ]

  /** 每一次调用的请求正文（三区拼开的那份），按发生次序。 */
  const seen: string[] = []
  const decoder = new TextDecoder()
  const inner = scriptedModel(scripts)
  const call: CallModel = (request, signal) => {
    seen.push(
      decoder.decode(request.prefix.zoneA) + decoder.decode(request.prefix.zoneB) + decoder.decode(request.prefix.zoneC),
    )
    return inner(request, signal)
  }

  // 执行器：前两步各把一问带回来（ToolResult.asks），第三步没有工具可调。
  const exec = recordingExecutor((one, at): ToolResult =>
    at === 0
      ? { ok: true, output: '把第一问带回了。', asks: [{ question: '第一问' }] }
      : at === 1
        ? { ok: true, output: '把第二问带回了。', asks: [{ question: '第二问' }] }
        : { ok: true, output: '好。' },
  )

  const ask: DriverAsk = {
    agent: AGENT,
    contract: c,
    base,
    openView: async () => loadView(log, AGENT as WriterId, { lower: lowerAt(truth, base) }),
    logOf: () => log,
    truth,
    writer: AGENT as WriterId,
    state,
    handle: {
      agent: AGENT,
      coord: { id: AGENT, branch: 'refs/heads/agent/agent-1', outputPaths: ['src/a.ts'] },
      branch: 'refs/heads/agent/agent-1',
      contract: 'c1' as ContractId,
      protocol: SUBAGENT_PROTOCOL,
      model: DECL.id,
      wireModel: DECL.model,
      target: { wire: { name: DECL.wire } } as unknown as DriverAsk['handle']['target'],
      adapter: { name: DECL.wire },
      state,
    },
    decl: DECL,
    call,
    execute: exec,
  }

  try {
    const r = await runAgentOnce(ask)
    assert.equal(r.stopped, '收敛', `这一格该自己说完：${r.stopped}`)
    // 五次调用的次序：格子 · 裁断 · 格子 · 裁断 · 格子（裁断那两趟不带「信号摘要」那一段）。
    assert.equal(seen.length, 5, `五趟调用（三步格子 + 两次裁断），拿到 ${seen.length}`)
    const count = (hay: string, needle: string): number => hay.split(needle).length - 1
    // 负对照：第一步带回来的判词，第二步的前缀里就该有一遍（两版都绿——判据是"该在"）。
    assert.equal(count(seen[2] as string, '第一问的判词'), 1, '第二步前缀里第一问的判词该恰有一遍')
    // 红断言：第三步的前缀里，每条判词都只许一遍——重摊那一版第一问出现两遍。
    assert.equal(count(seen[4] as string, '第一问的判词'), 1, `第三步前缀里第一问的判词该恰有一遍（重摊会摊成 ${count(seen[4] as string, '第一问的判词')} 遍）`)
    assert.equal(count(seen[4] as string, '第二问的判词'), 1, '第三步前缀里第二问的判词该恰有一遍')
    console.log(
      `① 读数：五趟调用（3 格子 + 2 裁断）· 第三步前缀里 第一问判词 ×${count(seen[4] as string, '第一问的判词')} · 第二问判词 ×${count(seen[4] as string, '第二问的判词')}——各恰一遍`,
    )
  } finally {
    await log.close()
    await truth.close()
    rmSync(root, { recursive: true, force: true })
  }
})
