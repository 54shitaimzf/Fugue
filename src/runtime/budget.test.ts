// B6 的断言：上下文上界 · 接续 · 交接（PLAN § 5.8 的 B6 行 · 架构 § 8.12 的 `seed` 两条准则 ·
// § 8.13.a 的循环重启 · § 8.11 的区表 · § 23 U6）。
// 跑法：cd ~/fugue && node --test src/runtime/budget.test.ts
//
//   ① 三个数印得出来，且它们的关系可核对（触发点在 (0, 上限) 之间 · 余量小于触发点）
//   ② 估账那把尺：同一份字节估两次是同一个数，非 ASCII 更贵；**账与尺是同一个口径**（账 ==
//      尺对同一份文本的读数，同样字数下中文多出来的账是英文的四倍以上），超限时报"超了多少"
//   ③ 三档分得开：没到触发点 `continue` · 到了且交接写不下 `stop` · 到了且塞得下 `restart`
//   ④ **负对照**：把触发点设在等于上限 → ① 的核对当场报出来，连"重试超界"都判不出来
//   ⑤ **修正**：账按真读数的比修（没有读数就一步不修）；真数 = 这一趟输入的总量（三个数相加），
//      全缺就是"没读数"，不拿 0 顶
//   ⑥ **凝聚理解那一栏的上限**（架构 § 15.1.a）：50 000 token 以内不报，超了报出来（带两个数，
//      不裁剪——它是模型的产物，没有"拒"的对象）
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
import { DISTILL_LIMIT_TOKENS, ENVELOPE_TOKENS, checkBudget, estimateTokens, estimateTokensOfText, overDistillLimit, planBudget } from './budget.ts'
import { calibrate, ratioOf, truthOf } from './calib.ts'
import type { BudgetAsk } from './budget.ts'

const DECL = modelDeclOf('deepseek-chat/anthropic')
const WHO: AgentCoord = { id: 'agent-1', branch: 'refs/heads/agent-1', outputPaths: [] }

/** 工具目录与 `seed` 那两段：**账里递的是正文**（怎么量归 `planBudget`，调用方不换算）。 */
const TOOLS = '工具目录：read_file · write_file · run_command'
const SEED = '把这一格的活干完，并把读数交回来。'

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

/** 一份"只有那一段文本"的状态：跟着长的只有 B 区里那一段文件内容。 */
function textState(text: string): AssembleState {
  return { ...fixtureState(7), files: [{ path: 'src/x.ts', text }] }
}

/**
 * 一份"账落在 `target` 之上"的状态。**尺寸只认那把尺的读数**：先按字节猜一个起点，量一次、
 * 按比例补足——换口径时这里跟着走，不用改任何一条断言。
 */
function stateWithUsed(target: number, decl: typeof DECL = DECL): AssembleState {
  let bytes = target
  for (let i = 0; i < 16; i++) {
    const state = bigState(bytes)
    const used = planBudget({ decl, prefix: prefixOf(state), tools: TOOLS, seed: SEED, handoff: '' }).used
    if (used >= target) return state
    bytes = Math.ceil(bytes * (target / used) * 1.05)
  }
  throw new Error(`撑不到 ${target}：那把尺量出来的读数一直在它下面`)
}

/** 交接提示词那一段正文：ASCII 每四个字节一个 token（这把尺自己的系数），于是"约 n 个 token"。 */
const handoffOf = (tokens: number): string => 'x'.repeat(tokens * 4)

/** 账上那几段接成的一段字节——**与 `planBudget` 里那一次量法是同一个形状**（用来核对"账 == 尺"）。 */
const bytesOfAsk = (ask: BudgetAsk): Uint8Array =>
  new Uint8Array(
    Buffer.concat([
      Buffer.from(ask.prefix.zoneA),
      Buffer.from(ask.prefix.zoneB),
      Buffer.from(ask.prefix.zoneC),
      Buffer.from(ask.tools, 'utf8'),
      Buffer.from(ask.seed, 'utf8'),
    ]),
  )

const askOf = (prefix: Prefix, over: Partial<BudgetAsk> = {}): BudgetAsk => ({
  decl: DECL,
  prefix,
  tools: TOOLS,
  seed: SEED,
  handoff: '',
  ...over,
})

// ── ① 三个数与它们的关系 ─────────────────────────────────────────────────────

test('① 三个数印得出来，且关系可核对（触发点在 (0, 上限) 之间 · 余量小于触发点）', () => {
  assert.deepEqual(checkBudget(DECL), [], '这份声明的三个数是自洽的')
  assert.equal(DECL.budget.trigger, triggerAt(DECL.contextLimit), '触发点是那一个函数算出来的')
  assert.equal(DECL.contextLimit, 1_048_576, '上游报的上下文窗（`GET /models`），不是"1M"那个取整')
  assert.equal(DECL.budget.trigger, 367_001)
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

test('② 那把尺与那笔账是同一个口径 · 同样字数下中文更贵 · 超限时报出超了多少', () => {
  const ascii = new Uint8Array(Buffer.from('a'.repeat(400), 'utf8'))
  const cjk = new Uint8Array(Buffer.from('字'.repeat(400), 'utf8'))
  assert.equal(estimateTokens(ascii), estimateTokens(ascii), '同一份字节两次同一个数')
  assert.equal(estimateTokens(ascii), Math.ceil(400 / 4) + ENVELOPE_TOKENS, `400 个 ASCII 字节：${estimateTokens(ascii)}`)
  assert.equal(estimateTokens(cjk), Math.ceil(1200 / 2) + ENVELOPE_TOKENS, `400 个汉字（1200 字节）：${estimateTokens(cjk)}`)
  assert.ok(estimateTokens(cjk) > estimateTokens(ascii), '同样的"字符数"下非 ASCII 更贵')

  // **账就是那把尺量出来的**：三区 + 工具目录 + `seed` 接成一段，两条路各量一次，逐数相同。
  const ask = askOf(prefixOf(fixtureState(7)))
  const plan = planBudget(ask)
  assert.equal(plan.used, estimateTokens(bytesOfAsk(ask)), `账该是尺对同一份文本的读数：${plan.used}`)

  // **负对照（口径）**：同样字数下，中文那一段多出来的账是英文的四倍以上——按字节记账时这个比
  // 是 3（一个汉字三字节），过不了这条，于是"口径是 token 还是字节"在这里分得开。
  const n = 4_000
  const base = planBudget(askOf(prefixOf(fixtureState(7)))).used
  const grow = (text: string): number => planBudget(askOf(prefixOf(textState(text)))).used - base
  const cjkGrow = grow('字'.repeat(n))
  const asciiGrow = grow('a'.repeat(n))
  assert.ok(cjkGrow > asciiGrow * 4, `同样 ${n} 个字：中文多 ${cjkGrow} · 英文多 ${asciiGrow}——中文该多出四倍以上`)

  // 一份撑到超限的状态：判 `stop`，而话里要说出**超了多少**（架构 § 8.12 那一条）。
  const huge = stateWithUsed(DECL.contextLimit + 20_000)
  const stop = planBudget(askOf(prefixOf(huge), { handoff: handoffOf(4_000) }))
  assert.equal(stop.kind, 'stop', `撑爆了该停：${stop.why}`)
  assert.match(stop.why, /还差 \d+ 写不下/, `停的话里要说清差多少：${stop.why}`)
  assert.ok(stop.headroom < 0, `还剩多少是负的：${stop.headroom}`)
  console.log(`② 读数：ASCII 400 字节 → ${estimateTokens(ascii)} token · 汉字 400 个 → ${estimateTokens(cjk)} token · 同样 ${n} 字：中文多 ${cjkGrow} · 英文多 ${asciiGrow} · 超限那一档：${stop.why}`)
})

// ── ③ 三档分得开 ─────────────────────────────────────────────────────────────

test('③ 三档分得开：没到触发点 · 到了且写不下 · 到了且塞得下', () => {
  // (a) 没到触发点。
  const small = planBudget(askOf(prefixOf(emptyState())))
  assert.equal(small.kind, 'continue')

  // (b) 到了触发点，而交接塞得下 → `restart`。
  const near = stateWithUsed(DECL.budget.trigger)
  const mid = planBudget(askOf(prefixOf(near), { handoff: handoffOf(2_000) }))
  assert.equal(mid.kind, 'restart', `到了触发点该交接：${mid.why}`)
  assert.ok(mid.used >= mid.trigger, `用过了触发点：${mid.used} ≥ ${mid.trigger}`)
  assert.ok(mid.used + 2_000 + mid.handoffMargin <= mid.limit, '交接加余量塞得下')

  // (c) 到了触发点，而**交接已经写不下** → `stop`（地板那一档：明确报出为什么停）。
  const tooBig = stateWithUsed(DECL.contextLimit - DECL.budget.handoffMargin)
  const stop = planBudget(askOf(prefixOf(tooBig), { handoff: handoffOf(DECL.budget.handoffMargin * 4) }))
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
  assert.match(bad[0]!, new RegExp(`触发点 ${DECL.contextLimit} 不在 \\(0, ${DECL.contextLimit}\\) 之间`))

  // 而"三个数"里那一栏被改坏之后，判出来的那一档是 `stop` 而不是 `restart`——**交接这一步
  // 再也走不到了**。这正是坏预算的害处：它不报错，只是让"该交接的时候"变成"已经写不下了"。
  // 一份"过了正常触发点、又还在正常上限之内"的状态（用量 `U` 落在
  // `[trigger, limit - margin)` 这一段里）：正常预算下判"交接"，坏预算下**连触发都到不了**
  // ——它一直在 `continue` 里转，直到某一步直接撑爆（那一步是 `stop`，而交接已经写不下了）。
  const mid = stateWithUsed(DECL.budget.trigger + 4_000) // 用量落在 [350000, 984000) 里
  const good = planBudget(askOf(prefixOf(mid)))
  assert.equal(good.kind, 'restart', `正常预算下：${good.kind}——${good.why}`)
  const plan = planBudget(askOf(prefixOf(mid), { decl: broken }))
  assert.equal(plan.kind, 'continue', `坏预算下判出来的：${plan.kind}——${plan.why}`)
  // 再撑一点就撑爆：那一档是 `stop`，而"该交接"这一步再也走不到。
  const over = planBudget(askOf(prefixOf(stateWithUsed(DECL.contextLimit, broken)), { decl: broken }))
  assert.equal(over.kind, 'stop', `坏预算撑爆那一档：${over.why}`)
  assert.match(over.why, /交接还差 \d+ 写不下/)
})

// ── ⑤ 真读数修正 ───────────────────────────────────────────────────────────────

test('⑤ 修正：账按真读数的比修，缺省一步不修 · 真数是这一趟输入的总量', () => {
  const ask = askOf(prefixOf(fixtureState(7)))
  const plain = planBudget(ask)
  assert.equal(plain.raw, plain.used, '没有修正时账就是那把尺的原始读数')

  // **修正改的是账，不是尺**：`raw` 留着，下一次算比值用的是它（不然修正会自己乘自己）。
  const fixed = planBudget({ ...ask, calib: { ratio: 2, samples: 3 } })
  assert.equal(fixed.raw, plain.raw, '尺的原始读数不因修正而变')
  assert.equal(fixed.used, Math.ceil(plain.raw * 2), `修过之后的账：${fixed.used}`)
  assert.equal(fixed.kind, 'continue')
  assert.match(fixed.why, /按 3 份真读数修 ×2\.00/, fixed.why)

  // 真读数那一头：**三个数相加**（未命中 + 命中缓存 + 写进缓存），全缺就是"没读数"。
  const NONE = { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, model: null }
  assert.equal(truthOf(null), null)
  assert.equal(truthOf(NONE), null, '全缺是"没读数"，不拿 0 顶')
  const heard = truthOf({ ...NONE, inputTokens: 88, cacheReadTokens: 24_000, cacheWriteTokens: 0 })
  assert.equal(heard, 24_088, `真数该是三个数之和：${heard}`)
  assert.equal(ratioOf(heard, plain.raw), 24_088 / plain.raw, '比值 = 真 ÷ 估')
  assert.equal(ratioOf(null, plain.raw), null, '没读数就量不出比值')
  assert.equal(ratioOf(100, 0), null, '估账为 0 也量不出来')

  // 修正取**最近八份的中位数**：一条离谱的不该把后面每一步都带歪。
  assert.deepEqual(calibrate([]), { ratio: 1, samples: 0 })
  assert.deepEqual(calibrate([2, 2, 9]), { ratio: 2, samples: 3 })
  assert.equal(calibrate(Array.from({ length: 12 }, () => 3)).samples, 8, '只留最近八份')
  console.log(`⑤ 读数：尺 ${plain.raw} · 修 ×2 → ${fixed.used} · 真数（88 + 24000 + 0）= ${heard} · 中位数修正 ${JSON.stringify(calibrate([2, 2, 9]))}`)
})

// ── ⑥ 凝聚理解那一栏的上限 ────────────────────────────────────────────────────

test('⑥ 凝聚理解的上限：50 000 token 以内不报，超了报出来（不裁剪）', () => {
  assert.equal(DISTILL_LIMIT_TOKENS, 50_000)

  // 那把尺：ASCII n 字节 ≈ ceil(n / 4) + 8（信封）。取两档贴着这条线站。
  const ok = 'a'.repeat(199_000)
  const over = 'a'.repeat(200_000)
  const okTokens = estimateTokensOfText(ok)
  const overTokens = estimateTokensOfText(over)
  assert.ok(okTokens <= DISTILL_LIMIT_TOKENS, `限度内：${okTokens}`)
  assert.ok(overTokens > DISTILL_LIMIT_TOKENS, `越线：${overTokens}`)

  assert.equal(overDistillLimit(ok), null, '在限度之内不报')
  assert.equal(overDistillLimit('字'.repeat(1_000)), null, '一份正常大小的理解不报')

  const said = overDistillLimit(over)
  assert.notEqual(said, null, '超了要报出来')
  assert.match(said!, /凝聚理解 50008 token 超过上限 50000 token/)
  assert.match(said!, /超 8；/)
  assert.match(said!, /不裁剪/)
  console.log(`⑥ 读数：${okTokens} token 不报 · ${overTokens} token 报「${said}」`)
})
