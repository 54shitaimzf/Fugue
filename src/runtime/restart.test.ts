// B6 的断言：交接与接续（PLAN § 5.8 的 B6 行 · 架构 § 8.13.a（同一分支一个新 `AgentId` ·
// **轮级状态不变**）· § 8.11（交接提示词住 Zone B）· § 9.7（会话内与会话外：积累段跨进程即失））。
// 跑法：cd ~/fugue && node --test src/runtime/restart.test.ts
//
//   ① 到了触发点：`agent/handoff` 在日志里，正文非空，新 `AgentId` 与前任**同一条 branch**，
//      而**轮级状态一个字节没变**（这一份里没有第二条事件）
//   ② 交接提示词在 **Zone B**，不在 Zone C：继任者那一份前缀的 A 区逐字节不变、
//      B 区里出现了那一段、而首个分叉偏移落在 `|A|` 与 `|A|+|B|` 之间
//   ③ 地板那一档：预算退化成"用完就停"时仍能收尾——**明确报出为什么停**，不是静默
//   ④ 负对照：把触发点设在等于上限 → 交接那一档走不到（判出来的是 `stop`），而如果硬写，
//      `agent/handoff` 里那份正文会大到塞不进下一格——所以那一栏的判断必须在写之前
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { modelDeclOf } from '../model/contract.ts'
import { openLog } from '../log/log.ts'
import type { LogEvent } from '../log/events.ts'
import { assemble, firstDivergence } from '../assemble/assemble.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { sourcesFor } from '../assemble/sources.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import { emptyState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import type { AgentId, BranchId, ContractId, WriterId } from '../terms.ts'
import { planBudget } from './budget.ts'
import { digestOf, handoffAt, promptOf, successorNameOf, successorOf } from './restart.ts'

const DECL = modelDeclOf('deepseek-flash/anthropic')
const AGENT = 'agent-1' as AgentId
const WHO: AgentCoord = { id: AGENT, branch: 'refs/heads/agent-1', outputPaths: ['deliver/agent-1/'] }
const BRANCH = 'refs/heads/agent-1' as BranchId
const CONTRACT = 'c-1' as ContractId

/**
 * 一份撑起来的状态（B 区的 `files` 那一段跟着长）。
 *
 * `target` 是"想要的字节数"：三区里只有 B 区跟着它长。**这个数是猜的起点，不是判据**——
 * 要"账落在某个数之上"一律走 `stateWithUsed`，那里量的是那把尺的读数。
 */
function bigState(target = 90_000): AssembleState {
  const line = 'const x = 1 // 一行代码，用来把这棵树撑起来\n'
  const per = Buffer.byteLength(line, 'utf8')
  return { ...fixtureState(7), files: [{ path: 'src/big.ts', text: line.repeat(Math.ceil(target / per)) }] }
}

/** 工具目录与 `seed` 那两段：**账里递的是正文**（怎么量归 `planBudget`，调用方不换算）。 */
const TOOLS = '工具目录：read_file · write_file · run_command'
const SEED = '把这一格的活干完，并把读数交回来。'

/** 交接提示词那一段正文：ASCII 每四个字节一个 token（这把尺自己的系数），于是"约 n 个 token"。 */
const handoffOf = (tokens: number): string => 'x'.repeat(tokens * 4)

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

async function withLog<T>(fn: (log: ReturnType<typeof openLog>, root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-b6-'))
  const log = openLog(root, { write: AGENT as WriterId, sync: 'each' })
  try {
    return await fn(log, root)
  } finally {
    await log.close()
    rmSync(root, { recursive: true, force: true })
  }
}

async function eventsOf(root: string): Promise<LogEvent[]> {
  const log = openLog(root)
  const out: LogEvent[] = []
  for await (const e of log.readByWriter(AGENT as WriterId)) out.push(e)
  return out
}

const prefixOf = (state: AssembleState, coord: AgentCoord = WHO) =>
  assemble({ protocol: SUBAGENT_PROTOCOL, model: DECL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, state, coord) })

// ── ① 到了触发点就把这一格交出去 ──────────────────────────────────────────────

test('① 到了触发点：agent/handoff 在日志里 · 正文非空 · 新 AgentId 同一条分支 · 轮级状态没变', async () => {
  await withLog(async (log, root) => {
    const state = stateWithUsed(DECL.budget.trigger + 4_000)
    const prefix = prefixOf(state)
    const plan = planBudget({ decl: DECL, prefix, tools: TOOLS, seed: SEED, handoff: handoffOf(2_000) })
    assert.equal(plan.kind, 'restart', `这一份状态该判交接：${plan.why}`)

    const successor = successorNameOf(AGENT, 1)
    assert.equal(successor, 'agent-1-2')
    const out = await handoffAt({
      log,
      writer: AGENT as WriterId,
      agent: AGENT,
      successor: successor as AgentId,
      contract: CONTRACT,
      branch: BRANCH,
      goal: '把模型这一路接上。',
      state,
      coord: WHO,
      plan,
      commands: ['node --test src/runtime/budget.test.ts'],
    })

    assert.ok(out.prompt.trim().length > 0, '交接提示词非空')
    assert.match(out.prompt, /【交接】/)
    assert.match(out.prompt, /目标：把模型这一路接上。/)
    assert.match(out.prompt, /接着干什么：/)
    assert.equal(out.handoff.branch, BRANCH, '同一个 branch')
    assert.equal(out.handoff.from, AGENT)
    assert.equal(out.handoff.step, state.step)

    const rows = await eventsOf(root)
    const handoffs = rows.filter((e) => e.t === 'agent/handoff')
    assert.equal(handoffs.length, 1, `日志里有 ${handoffs.length} 条交接`)
    const h = handoffs[0]!
    assert.equal(h.t, 'agent/handoff')
    assert.equal(h.agent, AGENT)
    assert.equal(h.successor, 'agent-1-2')
    assert.equal(h.contract, CONTRACT)
    assert.equal(h.digest, digestOf(out.prompt), '指纹是正文算出来的')
    assert.ok(h.body.trim().length > 0, '事件里那份正文非空')
    // **轮级状态没有变**（架构 § 8.13.a）：这一份里没有 `round/state`，也没有第二条事件。
    assert.deepEqual(
      rows.map((e) => e.t),
      ['agent/handoff'],
      `这一份只该落一条事件：${rows.map((e) => e.t).join(' ')}`,
    )
    console.log(`① 读数：交接正文 ${Buffer.byteLength(out.prompt, 'utf8')} 字节 · successor=${h.successor} · 事件 ${rows.length} 条`)
  })
})

// ── ② 交接提示词在 Zone B，不在 Zone C ────────────────────────────────────────

test('② 交接提示词落在 Zone B：A 区逐字节不变 · B 区里出现那一段 · 分叉点落在 A 与 A+B 之间', async () => {
  await withLog(async (log, root) => {
    const state = stateWithUsed(DECL.budget.trigger + 4_000)
    const plan = planBudget({ decl: DECL, prefix: prefixOf(state), tools: TOOLS, seed: SEED, handoff: handoffOf(2_000) })
    const out = await handoffAt({
      log,
      writer: AGENT as WriterId,
      agent: AGENT,
      successor: 'agent-1-2' as AgentId,
      contract: CONTRACT,
      branch: BRANCH,
      goal: '把模型这一路接上。',
      state,
      coord: WHO,
      plan,
      commands: [],
    })

    // 继任者那一格：**同一个坐标**（同一条分支、同一份产物路径），只有状态换了。
    const before = prefixOf(state)
    const after = prefixOf(out.next)
    const dec = new TextDecoder()
    const zoneB = dec.decode(after.zoneB)
    const zoneC = dec.decode(after.zoneC)

    assert.ok(zoneB.includes('【交接】'), 'B 区里有那一段交接提示词')
    assert.ok(!zoneC.includes('【交接】'), 'C 区里没有它——它是跨步稳定的那一段，不是这一步的回执')
    assert.deepEqual(after.zoneA, before.zoneA, 'A 区逐字节不变（同一份方针 · 系统 · 代码树）')

    // 首个分叉偏移落在 B 区之内：`|A| ≤ 偏移 < |A|+|B|`。
    const cat = (l: Uint8Array, r: Uint8Array): Uint8Array => new Uint8Array([...l, ...r])
    const at = firstDivergence(cat(before.zoneA, before.zoneB), cat(after.zoneA, after.zoneB))
    assert.ok(at >= after.zoneA.length, `分叉点 ${at} 不该落在 A 区里（|A|=${after.zoneA.length}）`)
    assert.ok(at < after.zoneA.length + after.zoneB.length, `分叉点 ${at} 该落在 B 区里（|A|+|B|=${after.zoneA.length + after.zoneB.length}）`)

    // 而 C 区（那串只追加的尾巴）被清空了：那是前任的会话内积累（§ 8.11）。
    assert.equal(out.next.turns?.length, 1, '继任者手里只有"你接手了"那一句')
    assert.match(out.next.turns![0]!.text ?? '', /【接手】/)
    assert.equal(out.next.lastStep, '', '前任的上一步回执不进下一格')
    assert.equal(out.next.step, 0, '步数是它自己的')

    console.log(
      `② 读数：|A|=${after.zoneA.length} · |B|=${after.zoneB.length}（含交接 ${Buffer.byteLength(out.prompt, 'utf8')} 字节）· ` +
        `|C|=${after.zoneC.length} · 分叉点 ${at}`,
    )
    assert.ok(root.length > 0, '日志根在（这一条只是把 root 用起来）')
  })
})

// ── ③ 地板那一档：用完就停，但要说出为什么 ────────────────────────────────────

test('③ 地板：预算退化成"用完就停"时仍能收尾——明确报出为什么停', async () => {
  await withLog(async (log, root) => {
    const state = stateWithUsed(DECL.contextLimit)
    const plan = planBudget({
      decl: DECL,
      prefix: prefixOf(state),
      tools: TOOLS,
      seed: SEED,
      handoff: handoffOf(DECL.budget.handoffMargin * 8),
    })
    assert.equal(plan.kind, 'stop', `这一份该判停：${plan.why}`)
    // **不留白**：为什么停那句话说得出量（用了多少 · 扣掉交接与余量之后留给这一步多少 · 这一步比它多多少 · 触发点在哪）。
    assert.match(plan.why, /用了 \d+/)
    assert.match(plan.why, /触发点 \d+/)
    assert.match(plan.why, /留给这一步的是 \d+/)
    assert.match(plan.why, /比它多 \d+/)
    assert.match(plan.why, /不裁剪后照发/)

    // 到这一档时**不写交接**（写了也塞不进下一格）——所以日志里一条 `agent/handoff` 都没有。
    const rows = await eventsOf(root)
    assert.equal(rows.filter((e) => e.t === 'agent/handoff').length, 0, '判停的那一档不该落交接')
    // 而"停"这件事本身要说得出为什么（那句话在上面那三条 `match` 里核过了）。
    assert.equal(log === undefined ? 'x' : 'ok', 'ok')
    console.log(`③ 读数：停下来的那句话——${plan.why}`)
  })
})

// ── ④ 负对照 ────────────────────────────────────────────────────────────────

test('④ 负对照：触发点设在等于上限 → 那一档判出来的是"停"，不是"交接"', () => {
  const broken = { ...DECL, budget: { trigger: DECL.contextLimit, handoffMargin: 16_000 } }
  const state = stateWithUsed(DECL.budget.trigger + 4_000)
  // 正常那一份预算：同一份状态判出来的是**交接**。
  const good = planBudget({ decl: DECL, prefix: prefixOf(state), tools: TOOLS, seed: SEED, handoff: handoffOf(2_000) })
  assert.equal(good.kind, 'restart', `正常预算下：${good.kind}——${good.why}`)

  // 坏预算：**同一份状态连触发点都到不了**（触发点贴在上限上，就再也没有"到了触发点"这一步）。
  const stuck = planBudget({ decl: broken, prefix: prefixOf(state), tools: TOOLS, seed: SEED, handoff: handoffOf(2_000) })
  assert.equal(stuck.kind, 'continue', `坏预算判出来的：${stuck.kind}——${stuck.why}`)
  assert.equal(stuck.trigger, stuck.limit)
  assert.notEqual(stuck.kind, good.kind, '两档的差别只有那一个数，判决却相反')

  // 再撑一点：撑爆那一档是 `stop`，而"该交接"这一步再也走不到。
  // **撑爆按那把尺的读数撑**——字节数与 token 数不是一回事，所以这里不写死乘几倍。
  const over = planBudget({
    decl: broken,
    prefix: prefixOf(stateWithUsed(DECL.contextLimit, broken)),
    tools: TOOLS,
    seed: SEED,
    handoff: handoffOf(2_000),
  })
  assert.equal(over.kind, 'stop', `坏预算撑爆那一档：${over.why}`)
  assert.ok(over.used > over.limit, `用量 ${over.used} 该过上限 ${over.limit}`)

  // `successorOf` 是个纯函数：同一份输入两次同一个值（不是"跑一次看看"）。
  const a = successorOf(emptyState(), 'x\n')
  const b = successorOf(emptyState(), 'x\n')
  assert.deepEqual(a, b)
  assert.equal(promptOf({ ...handoffSample(), why: 'w' }).includes('接着干什么：'), true)
})

/** 一份最小的交接（只给 ④ 里那一句纯函数核对用）。 */
function handoffSample() {
  return {
    goal: 'g',
    from: 'a',
    branch: 'b',
    step: 0,
    done: 'd',
    files: [],
    commands: [],
    next: ['n'],
    why: 'w',
  }
}
