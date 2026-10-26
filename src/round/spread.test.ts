// 驱动循环的两个收口，都在快档量（假模型 · 假执行器 · 真 git 台子）：
//
//   ① **判词只摊一次**（U18 甲案的驱动侧）：轮内裁断回来的那句结论挂到下一步的「信号摘要」上
//      ——每步只摊**新增**的那几句。重摊的病灶是把整份 `notes` 每步再摊一遍：同一条判词在
//      C 区里越滚越多，而模型每一步都当新信息读。
//   ② **断在半路要落账**：步循环 `failed` 那一档（流半截）→ `DriverResult.failed` 与
//      `agent/stop` 的 `failed` 栏（重跑那一道闸吃它，判据在 work.test.ts ⑤）。
//
// 跑法：cd ~/fugue && node --test src/round/spread.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
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
import type { DriverAsk, DriverResult } from './driver.ts'
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

/** 一个 agent 在这个台子上的那一趟（真 git · 真日志 · 假模型 · 假执行器）。 */
interface Cell {
  readonly root: string
  readonly log: LogHandle
  readonly truth: TruthHandle
  readonly base: CommitId
  /** 每一次调用的请求正文（三区拼开的那份），按发生次序——判词摊没摊、摊了几遍，从这里读。 */
  readonly seen: readonly string[]
  readonly ask: DriverAsk
  run(): Promise<DriverResult>
  close(): Promise<void>
}

async function cell(agent: string, scripts: readonly (readonly ModelEvent[])[], make: (one: never, at: number) => ToolResult, signal?: AbortSignal): Promise<Cell> {
  const AGENT = agent as AgentId
  const root = mkdtempSync(join(tmpdir(), 'fugue-spread-'))
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  assert.equal(spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  // 这一格那条分支先立起来（产品里这一步是 `startRound` 第 4 步起的分支；这里直接把 ref 指到底上）。
  assert.equal(spawnSync('git', ['update-ref', `refs/heads/${agent}`, base], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)

  const truth = openTruth(root)
  const log: LogHandle = openLog(root, { write: AGENT as WriterId, sync: 'each' })

  const c = {
    id: 'c1',
    agent: AGENT,
    branch: `refs/heads/${agent}`,
    goal: '把一件事做完',
    kind: 'implement',
    ownedPaths: ['src/a.ts'],
    deliverables: [{ path: 'src/a.ts', form: '模块' }],
    assertions: [],
    seed: [],
    actionOutputs: {},
  } as unknown as Contract

  const state = { ...emptyState(), goal: c.goal }
  const seen: string[] = []
  const decoder = new TextDecoder()
  const inner = scriptedModel(scripts)
  const call: CallModel = (request, signal) => {
    seen.push(
      decoder.decode(request.prefix.zoneA) + decoder.decode(request.prefix.zoneB) + decoder.decode(request.prefix.zoneC),
    )
    return inner(request, signal)
  }
  const exec = recordingExecutor(make as never)

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
      coord: { id: AGENT, branch: `refs/heads/${agent}`, outputPaths: ['src/a.ts'] },
      branch: `refs/heads/${agent}` as DriverAsk['handle']['branch'],
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
    ...(signal === undefined ? {} : { signal }),
  }
  return {
    root,
    log,
    truth,
    base,
    seen,
    ask,
    run: () => runAgentOnce(ask),
    close: async () => {
      await log.close()
      await truth.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('① 两步各带一问：后一步的前缀里每条判词恰好一遍（重摊那一版是两遍）', async () => {
  // 脚本五趟：格子第一步（带第一问回）→ 裁断 → 格子第二步（带第二问回）→ 裁断 → 格子第三步（说完）。
  const c = await cell('agent-1', [
    [...callOne(0, 'q1', 'ask_user_question', { question: '第一问' }), { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }],
    ruling('第一问的判词'),
    [...callOne(0, 'q2', 'ask_user_question', { question: '第二问' }), { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }],
    ruling('第二问的判词'),
    [{ t: 'delta', text: '干完了。' }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }],
  ], (_one, at) =>
    at === 0
      ? { ok: true, output: '把第一问带回了。', asks: [{ question: '第一问' }] }
      : at === 1
        ? { ok: true, output: '把第二问带回了。', asks: [{ question: '第二问' }] }
        : { ok: true, output: '好。' },
  )
  try {
    const r = await c.run()
    assert.equal(r.stopped, '收敛', `这一格该自己说完：${r.stopped}`)
    // 五次调用的次序：格子 · 裁断 · 格子 · 裁断 · 格子（裁断那两趟不带「信号摘要」那一段）。
    assert.equal(c.seen.length, 5, `五趟调用（三步格子 + 两次裁断），拿到 ${c.seen.length}`)
    const count = (hay: string, needle: string): number => hay.split(needle).length - 1
    // 负对照：第一步带回来的判词，第二步的前缀里就该有一遍（两版都绿——判据是"该在"）。
    assert.equal(count(c.seen[2] as string, '第一问的判词'), 1, '第二步前缀里第一问的判词该恰有一遍')
    // 红断言：第三步的前缀里，每条判词都只许一遍——重摊那一版第一问出现两遍。
    assert.equal(
      count(c.seen[4] as string, '第一问的判词'),
      1,
      `第三步前缀里第一问的判词该恰有一遍（重摊会摊成 ${count(c.seen[4] as string, '第一问的判词')} 遍）`,
    )
    assert.equal(count(c.seen[4] as string, '第二问的判词'), 1, '第三步前缀里第二问的判词该恰有一遍')
    console.log(
      `① 读数：五趟调用（3 格子 + 2 裁断）· 第三步前缀里 第一问判词 ×${count(c.seen[4] as string, '第一问的判词')} · 第二问判词 ×${count(c.seen[4] as string, '第二问的判词')}——各恰一遍`,
    )
  } finally {
    await c.close()
  }
})

test('② 断在半路要落账：failed 那一档进 DriverResult 与 agent/stop（正常收工那一档一栏都不多）', async () => {
  // 甲：第一趟调用就没有 stop——半截的流，`checkEvents` 在账上就把它拦下来（cut-stream）。
  const broke = await cell('agent-1', [
    [{ t: 'delta', text: '说到一半，流被掐了' }],
    [{ t: 'delta', text: '干完了。' }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }],
  ], () => ({ ok: true, output: '好。' }))
  // 乙：正常说完。
  const fine = await cell('agent-2', [
    [{ t: 'delta', text: '干完了。' }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }],
  ], () => ({ ok: true, output: '好。' }))
  try {
    const r1 = await broke.run()
    assert.equal(r1.failed, true, '断在半路的那一格，回执要带 failed')
    assert.match(r1.stopped, /^cut-stream：/, `停下来的那句话该是 cut-stream 开头：${r1.stopped}`)
    let stop1: { stopped: string; failed?: boolean } | null = null
    for await (const e of broke.log.readByWriter('agent-1' as WriterId)) {
      if (e.t === 'agent/stop') stop1 = e
    }
    assert.notEqual(stop1, null, 'agent/stop 要落账')
    assert.equal((stop1 as { failed?: boolean })?.failed, true, '断掉那一档的 agent/stop 带 failed: true')

    const r2 = await fine.run()
    assert.equal(r2.failed, false, '正常收工的那一格不带 failed')
    assert.equal(r2.stopped, '收敛')
    let stop2: { stopped: string; failed?: boolean } | null = null
    for await (const e of fine.log.readByWriter('agent-2' as WriterId)) {
      if (e.t === 'agent/stop') stop2 = e
    }
    assert.equal('failed' in (stop2 as object), false, '正常收工那一档一个字节都不多（栏不出现）')
    console.log(`② 读数：断流那格 stopped=${JSON.stringify(r1.stopped.slice(0, 24))}… failed=true · 收敛那格 failed 不出现`)
  } finally {
    await broke.close()
    await fine.close()
  }
})

test('③ 喊停的那条线真的接得上：循环顶先看一眼，停在那一步之前（已取消也算没干完）', async () => {
  const halt = new AbortController()
  // 脚本三趟（两条工具调用 + 一次说完）；执行器第二次伸手时喊停——第三步不再发起。
  const c = await cell(
    'agent-1',
    [
      [...callOne(0, 't1', 'read', { path: 'src/a.ts' }), { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }],
      [...callOne(0, 't2', 'read', { path: 'src/a.ts' }), { t: 'stop', reason: 'tool-calls', raw: 'tool_use' }],
      [{ t: 'delta', text: '干完了。' }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }],
    ],
    (_one, at) => {
      if (at === 1) halt.abort()
      return { ok: true, output: '好。' }
    },
    halt.signal,
  )
  try {
    const r = await c.run()
    assert.match(r.stopped, /^已取消/, `停因该是已取消那一档：${r.stopped}`)
    assert.equal(r.failed, true, '喊停的那一格也没干完——重跑闸不把它当交过卷')
    assert.equal(r.steps, 2, `第三步不该再发起（喊停停在那一步之前）：实际走了 ${r.steps} 步`)
    console.log(`③ 读数：第二步伸手时喊停 → steps=${r.steps} · stopped=${JSON.stringify(r.stopped)} · failed=true`)
  } finally {
    await c.close()
  }
})
