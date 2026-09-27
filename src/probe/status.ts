// M14 的第三支：**这一刻的处境，从日志重放**。出处：架构 § 9.6 那张观察表 · 架构 § 23 U17
// （`top` 不做：它要的是跨轮可比的读数，这一版只有单轮）· PLAN § 5.18（W11 的两个新单元：
// `status --once` / `watch --follow`）· 架构 § 8.13（`round/state` 那条链与它的图）·
// § 8.15（"**不采集，只重算**——因此任何指标都能被复核"）。
//
// **它是纯读，也不开第二份真源。** 三样东西各有唯一的取值处，一处都不在这里另立：
//
//   ① 轮次状态 —— `round/state` 那几条件，按 `round` 归链。**图借 `round/machine.ts` 那一份**
//      （不在这里另立一张边表）：每一条记下来的转移都拿图核一遍它是"一条边"还是"跳了几步"。
//   ② 每一格走到哪儿 —— `llm/call` · `run/start` · `run/end` · `agent/stop` · `agent/handoff`
//      那几族事件按 writer 归拢。
//   ③ 用量与条数 —— `llm/call` 的四个数（**缺项不拿 0 顶**：`missing` 那一栏就是"没量到"的条数，
//      与"量到 0"分得开，`B1` 的那一条）。
//
// **实测照出来的一条事实（写在这里，免得下一个人重新推）：`round/state` 记的不是一条路径。**
// 打桩跑一趟 `round run`（两个格 · 三步），账上只有四条：`Idle→Planning` · `Planning→Delegated` ·
// `Delegated→Working` · `Verifying→Rebuilding`。中间那几步（`Working→Collecting→Merging→Verifying`
// 与 `Committed→Rebuilding`）**一条事件都没有**——`round/start.ts` 只落它那三步，而
// `round/execute.ts:424` 落的是**收尾那一条**（`from` 那里写的是字面量 `'Verifying'`，而它记下的
// `to` 可能已经跨过两条边：`verdict-pass` → `Committed`，`advanced` → `Rebuilding`）。
//
// 所以这一份**不做"链必须接得上"那条断言**（它不是真的，会当场炸掉一条正常的账），也不假装
// `from`/`to` 是一步：核得出单边就印那一条边，核不出就用 BFS 把图上那几步找回来印成"跳步"，
// 图上根本走不通的记进 `unrouted`（**读面不许因为一条奇怪的账就整份读不出来**）。
// 要"每一步都落一条事件"是一个**写面**的改动（会动前缀账、会让 W10 那条基线作废），不在这里做。
import type { Log, LogEvent } from '../log/events.ts'
import { EDGES, STATES, abortEdges } from '../round/machine.ts'
import type { Cause, Edge } from '../round/machine.ts'
import { rejectsIn } from './round.ts'
import type { AgentId, RoundId, RoundState } from '../terms.ts'

/** 交错的读侧那一份形状（`probe/metrics.ts` 的 `MergedRow` 逐字，两处共用同一条读法）。 */
export interface StatusRow {
  readonly pos: { readonly writer: string; readonly seq: number }
  readonly e: LogEvent
}

/** 四个用量数各自汇总：**`total` 是量到的和，`missing` 是没量到的条数**——两者都要印得出来。 */
export interface UsageTotal {
  readonly total: number
  readonly missing: number
}

/** 用量汇总。`calls` 是 `llm/call` 的条数（下面四个数的分母）。 */
export interface UsageTotals {
  readonly calls: number
  readonly inputTokens: UsageTotal
  readonly cacheReadTokens: UsageTotal
  readonly cacheWriteTokens: UsageTotal
  readonly outputTokens: UsageTotal
}

/** 一格走到哪儿了。**每一栏都指得到事件**，一处推断都没有。 */
export interface AgentStatus {
  readonly agent: AgentId
  /** 调了几次模型（`llm/call` 条数）。 */
  readonly calls: number
  /** 走了几步（`llm/call` 的 `step` 去重之后的条数——一步一次调用，去重是防重放）。 */
  readonly steps: number
  /** 模型伸了几次手（`llm/call` 的 `invocations` 求和）。 */
  readonly invocations: number
  /** 起了几个进程（`run/start` 条数）。 */
  readonly actions: number
  /** 动作被内核拒了几次（`run/end` 的 `denied` 为真）。 */
  readonly denies: number
  /**
   * 边界挡了几次（`bound/deny` 条数）。**与上面那一栏分开**：一个是内核，一个是围栏。
   *
   * 这是**逐格**那一份；快照那一层的 `refusals` 是同一件事的总账（两个来源相加 · 按由头分组）。
   */
  readonly bounds: number
  /** 交了几次接（`agent/handoff` 条数）。 */
  readonly handoffs: number
  /** 走了几步才停（`agent/stop` 的 `steps`）。没停是 `null`。 */
  readonly stopSteps: number | null
  /** 为什么停（`agent/stop` 的 `stopped` **原样**）。没停是 `null`。 */
  readonly stopped: string | null
  /** 这一格最后一条事件的 `t`。 */
  readonly last: string | null
}

/** 一条轮次链重放出来的样子。 */
export interface RoundTrail {
  readonly round: RoundId
  /** 最后一条 `round/state` 说的那个状态（**账上最后那句原话**）。 */
  readonly state: RoundState
  /** 账上记了几条转移。 */
  readonly transitions: number
  /** 那几条在图上**一共走了几步**（单边算一步；跳步按最短路算）——它与上面那一栏不同就是跳步了。 */
  readonly hops: number
  /** 打回了几次（`Verifying → Working` 的条数）。**判据在 `probe/round.ts` 那一份里**，这里只是转手。 */
  readonly rejects: number
  /** 图上走不通的那几条（**记数，不炸**）：它是"账与图对不上"的证据。 */
  readonly unrouted: number
  /** 人读的每一步：单边是 `from ──on──> to`，跳步是 `from ⇒ to（经 a · b）`。 */
  readonly edges: readonly string[]
}

/** 验收的两半：过了几条断言 · 没过的几条。**"跑不起来"不进没过那一栏**（架构 § 8.12 末段）。 */
export interface AcceptTally {
  readonly pass: number
  readonly fail: number
  readonly accepts: number
}

/** 越界那一栏的一档由头（`bound/deny` 的 `rule`）：被挡了几次。 */
export interface RefusalRule {
  readonly rule: string
  readonly count: number
}

/**
 * **越界那一栏的读数**：想写到声明集之外的落点，被挡了几次。**它与打回那三个数分开**——§ 8.13.a
 * 那张表把它们当两样读：越界率说拆分切得干不干净，打回次数说这一轮过没过。
 *
 * 两个来源，各自是各自那一侧的事实：
 *
 *   · `byRule`（`bound/deny` 按 `rule` 分组）——**视图与围栏那一侧**：`write` / `edit` 落在声明集
 *     外（`contract-scope`）· 持轮者写到保留前缀之外（`plan-scope`）· `exit_plan_mode` 自报的路径
 *     不是这一趟那一份（`plan-path`）· 路径越出工作区（`fence:*`）。
 *   · `kernel`（`run/end` 里 `denied` 为真的条数）——**执行那一侧**：内核把未声明的写入当场拒
 *     （errno 30 那一档），也就是三数里那个 `denied`。
 *
 * **视图那一侧一条都不落 `run/end`**（那几条工具不起进程，`capability/dispatch.ts` 里只有执行层
 * 那一格才落那一对事件），所以三数里的 `denied` 看不见它们——这一栏单独立起来的理由就是它。
 *
 * `total` 是两者相加。**按由头分组**是这个读数的用处所在：§ 8.13.a 要判的是"子 agent 想写契约
 * 没声明的地方"，而那一族只认 `contract-scope` 这一档，不让总数替它说话。
 */
export interface RefusalTally {
  readonly total: number
  readonly kernel: number
  readonly byRule: readonly RefusalRule[]
}

/**
 * **树那一侧的越界读数**：子进程在物化树里改了声明集之外的东西——`mat/reclaim` 里 `changed`
 * 非空的那几条。**它与 `refusals` 不是一件事**：那一栏量的是"被挡"（内核拒 · 围栏拦 · 写入面
 * 拒），这一栏量的是"报了但没挡"——`workspace-write` 那一档里内核不拦未声明的写入，回收如实
 * 报出来、也不收它（§ 8.7），于是它既没进三数、也没进 `refusals`。
 *
 * `rows` 是报出来的条数 · `paths` 是那些改动**去重排序**之后的路径。同一格跑几趟会把同一条
 * 路径再报一次——那是"报了几趟"，而"动过哪儿"要看路径集。
 */
export interface OutsideTally {
  readonly rows: number
  readonly paths: readonly string[]
}

/** 一次快照。**它是 `status --once` 的全部输出，也是 TUI 的那个读源。** */
export interface StatusSnapshot {
  /** 账上见过的每一条轮次链，按第一次出现的次序。 */
  readonly rounds: readonly RoundTrail[]
  /** 最后一条 `round/state` 落在哪一轮——"现在在跑的是哪一轮"。一条都没有是 `null`。 */
  readonly current: RoundId | null
  readonly agents: readonly AgentStatus[]
  readonly contracts: number
  readonly attempts: number
  readonly conflicts: number
  readonly accepts: AcceptTally
  /** 越界那一栏（`bound/deny` 与内核拒合起来的那一份读数）。**与打回那三个数分开**。 */
  readonly refusals: RefusalTally
  /** 树那一侧那一栏（`mat/reclaim` 里 `changed` 非空的那些）。**与"被挡"分开**。 */
  readonly outside: OutsideTally
  readonly usage: UsageTotals
  /** 一共读了几条事件。 */
  readonly events: number
  readonly last: { readonly writer: string; readonly seq: number; readonly t: string } | null
}

/** 图上的全部边（正边 + `Aborted` 那一条"从任意状态可达"）。**一处取值处。** */
function allEdges(): readonly Edge[] {
  return [...EDGES, ...abortEdges()]
}

/**
 * 图上从 `from` 走到 `to` 的一条**最短**路。走不通是 `null`。
 *
 * **它存在的原因是账记的是跳步**（这一份文件头上那条事实）：一条 `Verifying → Rebuilding` 在图上
 * 是 `verdict-pass` 与 `advanced` 两步，而账上只有一头一尾。把中间那几步找回来印给人看，
 * 比"印一句看不懂的 from/to"有用；而"找不回来"这件事本身也是个读数（`unrouted`）。
 */
export function routeOf(from: RoundState, to: RoundState): readonly Edge[] | null {
  if (from === to) return []
  const edges = allEdges()
  const seen = new Set<RoundState>([from])
  const queue: { state: RoundState; path: Edge[] }[] = [{ state: from, path: [] }]
  while (queue.length > 0) {
    const head = queue.shift() as { state: RoundState; path: Edge[] }
    // 广度优先：**先到的那一条就是最短的**（边不带权，图上也没有负环可言）。
    for (const e of edges) {
      if (e.from !== head.state || seen.has(e.to)) continue
      const path = [...head.path, e]
      if (e.to === to) return path
      seen.add(e.to)
      queue.push({ state: e.to, path })
    }
  }
  return null
}

/** 一步就是一条边的话，那一条边的 `on`。**图上没有这一条就当场拒**（`machine.ts` 的那条纪律）。 */
export function causeOf(from: RoundState, to: RoundState): Cause {
  const hit = allEdges().find((e) => e.from === from && e.to === to)
  if (hit === undefined) {
    const known = allEdges().filter((e) => e.from === from).map((e) => e.to)
    throw new Error(
      `图上没有这条边：${from} ──> ${to}（从 ${from} 出发到得了的是：${known.join(' · ') || '（哪都到不了）'}）`,
    )
  }
  return hit.on
}

function totalOf(list: readonly (number | null)[]): UsageTotal {
  let total = 0
  let missing = 0
  for (const v of list) {
    if (v === null) missing++
    else total += v
  }
  return { total, missing }
}

/** 折一条轮次链要的那点东西。**它是折的过程里的临时物**，出口那一份不带它。 */
interface RoundFold {
  state: RoundState
  transitions: number
  hops: number
  unrouted: number
  edges: string[]
  states: { from: RoundState; to: RoundState }[]
}

/** 每一步印成一句话：单边印边名，跳步把找回来的那几步印出来。 */
function renderRoute(from: RoundState, to: RoundState): { text: string; hops: number; routed: boolean } {
  const route = routeOf(from, to)
  if (route === null) return { text: `${from} ⇒ ${to}（图上没有这条路）`, hops: 0, routed: false }
  if (route.length <= 1) {
    const e = route[0]
    return e === undefined
      ? { text: `${from} ⇒ ${to}（原地说了一次）`, hops: 0, routed: true }
      : { text: `${from} ──${e.on}──> ${to}`, hops: 1, routed: true }
  }
  return {
    text: `${from} ⇒ ${to}（跳步，经 ${route.map((e) => e.on).join(' · ')}）`,
    hops: route.length,
    routed: true,
  }
}

/**
 * 把一串事件折成一份快照。**纯函数**——同一串事件折两次给同一份（架构 § 8.15 的那条验证性质），
 * 所以"重放同一份日志得同一份快照"这条断言不需要任何仪器。
 *
 * 每一步都按 **writer** 归拢 agent；轮次那一条按事件自己的 `round` 归链。
 */
export function statusOf(rows: readonly StatusRow[]): StatusSnapshot {
  const roundOrder: RoundId[] = []
  const rounds = new Map<RoundId, RoundFold>()
  const agents = new Map<string, AgentStatus & { steps: Set<string> }>()
  const usage = {
    inputTokens: [] as (number | null)[],
    cacheReadTokens: [] as (number | null)[],
    cacheWriteTokens: [] as (number | null)[],
    outputTokens: [] as (number | null)[],
  }
  let calls = 0
  let contracts = 0
  let attempts = 0
  let conflicts = 0
  let pass = 0
  let fail = 0
  let accepts = 0
  /** 越界那一栏的两个来源：内核那一档（与 `denied` 同一个计数点）· `bound/deny` 按由头。 */
  let kernelDenies = 0
  const refusalRules = new Map<string, number>()
  /** 树那一侧那一栏：报了几条，加它们动过的那些路径（去重）。 */
  let outsideRows = 0
  const outsidePaths = new Set<string>()
  let current: RoundId | null = null
  let last: StatusSnapshot['last'] = null

  /** 一格那一栏：没有就现建一条（`steps` 那只集合是折的过程里的临时物，出口那一份不带它）。 */
  const slotOf = (w: string): AgentStatus & { steps: Set<string> } => {
    const hit = agents.get(w)
    if (hit !== undefined) return hit
    const made: AgentStatus & { steps: Set<string> } = {
      agent: w as AgentId,
      calls: 0,
      steps: new Set<string>(),
      invocations: 0,
      actions: 0,
      denies: 0,
      bounds: 0,
      handoffs: 0,
      stopSteps: null,
      stopped: null,
      last: null,
    }
    agents.set(w, made)
    return made
  }

  for (const { pos, e } of rows) {
    last = { writer: pos.writer, seq: pos.seq, t: e.t }
    if (e.t === 'round/state') {
      // **两个状态都得是图上认识的那十一个**：不认识的当场说清楚（账坏了），不往下折。
      if (!STATES.includes(e.from) || !STATES.includes(e.to)) {
        throw new Error(`不认识的轮次状态：${e.from} ──> ${e.to}（图上是：${STATES.join(' · ')}）`)
      }
      let fold = rounds.get(e.round)
      if (fold === undefined) {
        fold = { state: 'Idle', transitions: 0, hops: 0, unrouted: 0, edges: [], states: [] }
        rounds.set(e.round, fold)
        roundOrder.push(e.round)
      }
      const r = renderRoute(e.from, e.to)
      fold.state = e.to
      fold.transitions++
      fold.hops += r.hops
      if (!r.routed) fold.unrouted++
      fold.edges.push(r.text)
      fold.states.push({ from: e.from, to: e.to })
      current = e.round
      continue
    }
    if (e.t === 'round/intent') continue
    if (e.t === 'contract/issue') {
      contracts++
      continue
    }
    if (e.t === 'merge/attempt') {
      attempts++
      conflicts += e.conflicts
      continue
    }
    if (e.t === 'merge/accept') {
      accepts++
      for (const a of e.assertions) {
        if (a.verdict === 'pass') pass++
        else if (a.verdict === 'fail') fail++
        // "跑不起来"那一档既不进 pass 也不进 fail（架构 § 8.12 末段：仪器故障不算活干错了）。
      }
      continue
    }
    if (e.t === 'llm/call') {
      calls++
      const a = slotOf(pos.writer)
      a.calls++
      a.steps.add(e.step)
      a.invocations += e.invocations
      a.last = e.t
      usage.inputTokens.push(e.usage.inputTokens)
      usage.cacheReadTokens.push(e.usage.cacheReadTokens)
      usage.cacheWriteTokens.push(e.usage.cacheWriteTokens)
      usage.outputTokens.push(e.usage.outputTokens)
      continue
    }
    if (e.t === 'run/start') {
      const a = slotOf(pos.writer)
      a.actions++
      a.last = e.t
      continue
    }
    if (e.t === 'run/end') {
      const a = slotOf(pos.writer)
      if (e.denied) {
        a.denies++
        kernelDenies++
      }
      a.last = e.t
      continue
    }
    if (e.t === 'bound/deny') {
      const a = slotOf(pos.writer)
      a.bounds++
      // 越界那一栏按由头分组：**怎么算在这一个地方**（§ 8.13.a 那一族要的是"哪一种越界"）。
      refusalRules.set(e.rule, (refusalRules.get(e.rule) ?? 0) + 1)
      a.last = e.t
      continue
    }
    if (e.t === 'mat/reclaim') {
      // **树那一侧那一栏**：`changed` 非空的是"子进程在树里改了声明之外的东西"；空的那些是
      // "照例读到空集"那个读数（默认档里每一次都取），不是越界——两样不许混。
      if (e.changed.length > 0) {
        outsideRows++
        for (const p of e.changed) outsidePaths.add(p)
      }
      slotOf(pos.writer).last = e.t
      continue
    }
    if (e.t === 'agent/handoff') {
      const a = slotOf(pos.writer)
      a.handoffs++
      a.last = e.t
      continue
    }
    if (e.t === 'agent/stop') {
      const a = slotOf(pos.writer)
      a.stopped = e.stopped
      a.stopSteps = e.steps
      a.last = e.t
      continue
    }
    // 其余各族的最近一条也算"这一格最后一条事件"（`view/*` · `mat/*` · `holder/*` · `prefix/*`）。
    slotOf(pos.writer).last = e.t
  }

  // **排序定死**：同一串事件折两次要给同一份快照（④ 那条验证性质），而 `Map` 的次序不是判据。
  const byRule: RefusalRule[] = [...refusalRules.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((x, y) => (x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : 0))
  const refusals: RefusalTally = {
    total: kernelDenies + byRule.reduce((n, r) => n + r.count, 0),
    kernel: kernelDenies,
    byRule,
  }

  return {
    rounds: roundOrder.map((r) => {
      const fold = rounds.get(r) as RoundFold
      return {
        round: r,
        state: fold.state,
        transitions: fold.transitions,
        hops: fold.hops,
        // **同一个数不许有两份写法**：打回那一条的判据在 `probe/round.ts` 里。
        rejects: rejectsIn(fold.states),
        unrouted: fold.unrouted,
        edges: fold.edges,
      }
    }),
    current,
    agents: [...agents.values()].map((a) => ({
      agent: a.agent,
      calls: a.calls,
      steps: a.steps.size,
      invocations: a.invocations,
      actions: a.actions,
      denies: a.denies,
      bounds: a.bounds,
      handoffs: a.handoffs,
      stopSteps: a.stopSteps,
      stopped: a.stopped,
      last: a.last,
    })),
    contracts,
    attempts,
    conflicts,
    accepts: { pass, fail, accepts },
    refusals,
    outside: { rows: outsideRows, paths: [...outsidePaths].sort() },
    usage: {
      calls,
      inputTokens: totalOf(usage.inputTokens),
      cacheReadTokens: totalOf(usage.cacheReadTokens),
      cacheWriteTokens: totalOf(usage.cacheWriteTokens),
      outputTokens: totalOf(usage.outputTokens),
    },
    events: rows.length,
    last,
  }
}

/**
 * 读一份日志，给一份快照。**一次读齐，不留游标**——`--once` 就是这个意思：看一眼，不开账本。
 *
 * 走 `readMerged`（交错那条全序）：按 writer 读要先把 writer 枚举出来，而"有哪些 writer"
 * 只有日志目录知道——交错那一条一处都不用枚举，也不会漏掉某个 agent（`probe/round.ts` 的同一句话）。
 */
export async function snapshot(log: Pick<Log, 'readMerged'>): Promise<StatusSnapshot> {
  const rows: StatusRow[] = []
  for await (const r of log.readMerged()) rows.push(r)
  return statusOf(rows)
}

/**
 * 一份快照排成人读的几行。**`--json` 那一档直接吐对象，不走这里。**
 *
 * 跳步与"图上没有这条路"都在这里印出来：读面不许把"账与图对不上"这件事咽下去。
 */
export function linesOf(s: StatusSnapshot): readonly string[] {
  const out: string[] = []
  if (s.rounds.length === 0) out.push('一条轮次状态都没有：这份日志里还没开过轮次')
  for (const r of s.rounds) {
    const here = r.round === s.current ? ' · 最近一条落在这一轮' : ''
    const hops = r.hops === r.transitions ? '' : `（图上走了 ${r.hops} 步：${r.transitions} 条里有跳步）`
    const odd = r.unrouted > 0 ? ` · 图外 ${r.unrouted} 条` : ''
    out.push(`轮次 ${r.round} · 状态 ${r.state} · 转移 ${r.transitions} 条${hops} · 打回 ${r.rejects} 次${odd}${here}`)
    for (const e of r.edges) out.push(`  ${e}`)
  }
  for (const a of s.agents) {
    const stop = a.stopped === null ? '没停' : `${a.stopSteps} 步 · ${a.stopped}`
    out.push(
      `格 ${a.agent} · 调 ${a.calls} 次 · ${a.steps} 步 · 工具调用 ${a.invocations} · 动作 ${a.actions}` +
        ` · 内核拒 ${a.denies} · 边界挡 ${a.bounds} · 交接 ${a.handoffs} · 停：${stop} · 最近 ${a.last ?? '（空）'}`,
    )
  }
  const u = s.usage
  out.push(
    `契约 ${s.contracts} · 折叠尝试 ${s.attempts} · 冲突 ${s.conflicts} · 验收 ${s.accepts.accepts} 次` +
      `（过 ${s.accepts.pass} / 没过 ${s.accepts.fail}）`,
  )
  // **恒印这一行**（零也印）：少了它，"没量到"与"量到 0"就分不开——与用量那一行同一条规矩。
  // 两半分开写：**被挡**（内核 · 围栏 · 写入面）与**报了没挡**（树里那些集外改动）不是一件事。
  out.push(
    `越界 被挡 ${s.refusals.total} 次（内核拒 ${s.refusals.kernel}` +
      `${s.refusals.byRule.length === 0 ? '' : ` · ${s.refusals.byRule.map((r) => `${r.rule} ${r.count}`).join(' · ')}`}）` +
      ` · 树上报了没挡的 ${s.outside.rows} 条` +
      `${s.outside.paths.length === 0 ? '' : `（${s.outside.paths.join(' · ')}）`}`,
  )
  const one = (n: string, t: UsageTotal): string => `${n} ${t.total}${t.missing > 0 ? `（缺 ${t.missing} 条）` : ''}`
  out.push(
    `用量 调用 ${u.calls} · ${one('input', u.inputTokens)} · ${one('cacheRead', u.cacheReadTokens)}` +
      ` · ${one('cacheWrite', u.cacheWriteTokens)} · ${one('output', u.outputTokens)}`,
  )
  out.push(
    s.last === null
      ? '事件 0 条'
      : `事件 ${s.events} 条 · 最近 ${s.last.t}（writer=${s.last.writer} seq=${s.last.seq}）`,
  )
  return out
}
