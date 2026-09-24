// B6 的断言：上下文上界 · 接续 · 交接（PLAN § 5.8 的 B6 行 · 架构 § 8.12 的 `seed` 两条准则 ·
// § 8.13.a 的循环重启 · § 8.11 的区表 · § 23 U6）。
// 跑法：cd ~/fugue && node --test src/runtime/budget.test.ts
//
//   ① 三个数印得出来，且它们的关系可核对（触发点在 (0, 上限) 之间 · 余量小于触发点）
//   ② 估账那把尺：同一份字节估两次是同一个数，非 ASCII 更贵，超限时报"超了多少"
//   ③ 三档分得开：没到触发点 `continue` · 到了且交接写不下 `stop` · 到了且塞得下 `restart`
//   ④ **负对照**：把触发点设在等于上限 → ① 的核对当场报出来，连"重试超界"都判不出来
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelDeclOf, triggerAt } from '../model/contract.ts'
import type { ModelDecl } from '../model/contract.ts'
import { assemble, readPrefix } from '../assemble/assemble.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { sourcesFor } from '../assemble/sources.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import { emptyState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import type { Prefix } from '../assemble/contract.ts'
import { ENVELOPE_TOKENS, checkBudget, estimateTokens, planBudget } from './budget.ts'
import type { BudgetAsk } from './budget.ts'

const DECL = modelDeclOf('deepseek-chat/anthropic')
const WHO: AgentCoord = { id: 'agent-1', branch: 'refs/heads/agent-1', outputPaths: [] }

function prefixOf(state: AssembleState, coord: AgentCoord = WHO, decl: ModelDecl = DECL): Prefix {
  return assemble({ protocol: SUBAGENT_PROTOCOL, model: decl.id, segments: sourcesFor(SUBAGENT_PROTOCOL, state, coord) })
}

/** 一份够到触发点的状态：`files` 里塞够多的字节（B 区那一段会跟着长）。 */
function bigState(target: number): AssembleState {
  const line = 'const x = 1 // 一行代码，用来把这棵树撑起来\n'
  const per = Buffer.byteLength(line, 'utf8')
  const n = Math.ceil(target / per)
  return { ...fixtureState(7), files: [{ path: 'src/big.ts', text: line.repeat(n) }] }
}

const askOf = (prefix: Prefix, over: Partial<BudgetAsk> = {}): BudgetAsk => ({
  decl: DECL,
  prefix,
  tools: 6_637,
  seed: 1_200,
  handoff: 0,
  ...over,
})

// ── ① 三个数与它们的关系 ─────────────────────────────────────────────────────

test('① 三个数印得出来，且关系可核对（触发点在 (0, 上限) 之间 · 余量小于触发点）', () => {
  assert.deepEqual(checkBudget(DECL), [], '这份声明的三个数是自洽的')
  assert.equal(DECL.budget.trigger, triggerAt(DECL.contextLimit), '触发点是那一个函数算出来的')
  assert.equal(DECL.contextLimit, 128_000)
  assert.equal(DECL.budget.trigger, 96_000)
  assert.equal(DECL.budget.handoffMargin, 16_000)

  const plan = planBudget(askOf(prefixOf(emptyState())))
  assert.equal(plan.limit, DECL.contextLimit)
  assert.equal(plan.trigger, DECL.budget.trigger)
  assert.equal(plan.handoffMargin, DECL.budget.handoffMargin)
  assert.equal(plan.used, plan.limit - plan.headroom, '用了多少 = 上限 − 还剩多少')
  assert.equal(plan.kind, 'continue', `空状态该是 continue：${plan.why}`)
  assert.match(plan.why, /还没到触发点/)
  console.log(`① 读数：上限 ${plan.limit} · 触发点 ${plan.trigger} · 余量 ${plan.handoffMargin} · 空状态用了 ${plan.used}`)
})

// ── ② 估账那把尺 ─────────────────────────────────────────────────────────────

test('② 估账：同一份字节估两次同一个数 · 非 ASCII 更贵 · 超限时报出超了多少', () => {
  const ascii = new Uint8Array(Buffer.from('a'.repeat(400), 'utf8'))
  const cjk = new Uint8Array(Buffer.from('字'.repeat(400), 'utf8'))
  assert.equal(estimateTokens(ascii), estimateTokens(ascii), '同一份字节两次同一个数')
  assert.equal(estimateTokens(ascii), Math.ceil(400 / 4) + ENVELOPE_TOKENS, `400 个 ASCII 字节：${estimateTokens(ascii)}`)
  assert.equal(estimateTokens(cjk), Math.ceil(1200 / 2) + ENVELOPE_TOKENS, `400 个汉字（1200 字节）：${estimateTokens(cjk)}`)
  assert.ok(estimateTokens(cjk) > estimateTokens(ascii), '同样的"字符数"下非 ASCII 更贵')

  // 一份撑到超限的状态：判 `stop`，而话里要说出**超了多少**（架构 § 8.12 那一条）。
  const huge = bigState(DECL.contextLimit * 2)
  const plan = planBudget(askOf(prefixOf(huge), { handoff: 4_000 }))
  assert.equal(plan.kind, 'stop', `撑爆了该停：${plan.why}`)
  assert.match(plan.why, /还差 \d+ 写不下/, `停的话里要说清差多少：${plan.why}`)
  assert.ok(plan.headroom < 0, `还剩多少是负的：${plan.headroom}`)
  console.log(`② 读数：ASCII 400 字节 → ${estimateTokens(ascii)} token · 汉字 400 个 → ${estimateTokens(cjk)} token · 超限那一档：${plan.why}`)
})

// ── ③ 三档分得开 ─────────────────────────────────────────────────────────────

test('③ 三档分得开：没到触发点 · 到了且写不下 · 到了且塞得下', () => {
  // (a) 没到触发点。
  const small = planBudget(askOf(prefixOf(emptyState())))
  assert.equal(small.kind, 'continue')

  // (b) 到了触发点，而交接塞得下 → `restart`。
  const near = bigState(DECL.budget.trigger - 6_637 - 1_200)
  const mid = planBudget(askOf(prefixOf(near), { handoff: 2_000 }))
  assert.equal(mid.kind, 'restart', `到了触发点该交接：${mid.why}`)
  assert.ok(mid.used >= mid.trigger, `用过了触发点：${mid.used} ≥ ${mid.trigger}`)
  assert.ok(mid.used + 2_000 + mid.handoffMargin <= mid.limit, '交接加余量塞得下')

  // (c) 到了触发点，而**交接已经写不下** → `stop`（地板那一档：明确报出为什么停）。
  const tooBig = bigState(DECL.budget.trigger - 1)
  const stop = planBudget(askOf(prefixOf(tooBig), { handoff: DECL.budget.handoffMargin * 4 }))
  assert.equal(stop.kind, 'stop', `交接待写不下该停：${stop.why}`)
  console.log(`③ 读数：continue used=${small.used} · restart used=${mid.used} · stop used=${stop.used}`)
})

// ── ④ 负对照 ────────────────────────────────────────────────────────────────

test('④ 负对照：触发点设在等于上限 → 关系核对当场报出来', () => {
  const broken: ModelDecl = {
    ...DECL,
    budget: { trigger: DECL.contextLimit, handoffMargin: DECL.budget.handoffMargin },
  }
  const bad = checkBudget(broken)
  assert.equal(bad.length, 1, `核对该报一条：${bad.join(' / ')}`)
  assert.match(bad[0]!, /触发点 128000 不在 \(0, 128000\) 之间/)

  // 而"三个数"里那一栏被改坏之后，判出来的那一档是 `stop` 而不是 `restart`——**交接这一步
  // 再也走不到了**。这正是坏预算的害处：它不报错，只是让"该交接的时候"变成"已经写不下了"。
  // 一份"过了正常触发点、又还在正常上限之内"的状态（用量 `U` 落在
  // `[trigger, limit - margin)` 这一段里）：正常预算下判"交接"，坏预算下**连触发都到不了**
  // ——它一直在 `continue` 里转，直到某一步直接撑爆（那一步是 `stop`，而交接已经写不下了）。
  const U = DECL.budget.trigger + 14_000 // = 110000：落在 [96000, 112000) 里
  const mid = bigState(U - 6_637 - 1_200)
  const good = planBudget({ decl: DECL, prefix: prefixOf(mid), tools: 6_637, seed: 1_200, handoff: 0 })
  assert.equal(good.kind, 'restart', `正常预算下：${good.kind}——${good.why}`)
  const plan = planBudget({ decl: broken, prefix: prefixOf(mid), tools: 6_637, seed: 1_200, handoff: 0 })
  assert.equal(plan.kind, 'continue', `坏预算下判出来的：${plan.kind}——${plan.why}`)
  // 再撑一点就撑爆：那一档是 `stop`，而"该交接"这一步再也走不到。
  const over = planBudget({ decl: broken, prefix: prefixOf(bigState(DECL.contextLimit)), tools: 6_637, seed: 1_200, handoff: 0 })
  assert.equal(over.kind, 'stop', `坏预算撑爆那一档：${over.why}`)
  assert.match(over.why, /交接还差 \d+ 写不下/)
})
