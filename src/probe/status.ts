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
//   ③ 用量与条数 —— `llm/call` 的四个数 + 思考那一栏的拆解（`reasoningTokens`）
//      （**缺项不拿 0 顶**：`missing` 那一栏就是"没量到"的条数，与"量到 0"分得开，`B1` 的那一条）。
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
//
// **序 32 给它加了一个出口**（PLAN § 5.12 那一格）：八元指标与打回三数原先只挂在 `round run` /
// `round work` 的 `--report --metrics` 上——**跑完才有，跑着读不到**——而 TUI 与第二个渲染器读的
// 正是"跑着"的那一份。`readings()` 就是那个出口：一遍读齐那几栏（0.3.0 ④ 起多了「每调用成本台账」
// 这一栏，表头与行都住 `probe/ledger.ts`），`--json` 吐出去的那一份去掉
// `width` / `height` 就是 `ui/frame.ts` 的 `FrameInput`（命令面与渲染器同一个输入契约）。
// 三栏各自的折法一处都没另立：快照是这一份自己的 `statusOf`，另两栏借 `probe/round.ts` 与
// `probe/metrics.ts` 那两处。
import type { Log, LogEvent } from '../log/events.ts'
import { costOf, formatUsd, matchModels, moneyText } from '../model/price.ts'
import type { Billable, Phase } from '../model/price.ts'
import type { Catalog } from '../model/catalog.ts'
import { EDGES, STATES, abortEdges } from '../round/machine.ts'
import type { Cause, Edge } from '../round/machine.ts'
import { countsOf, rejectsIn, linesOfReadings } from './round.ts'
import type { MetricReading } from './round.ts'
import { LEDGER_HEAD, ledgerLines, ledgerOf } from './ledger.ts'
import type { Ledger, LedgerInputs } from './ledger.ts'
import { lineOf, metricsOf } from './metrics.ts'
import type { MetricValue } from './metrics.ts'
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
  /**
   * **输出那一个数里的拆解**：思考花掉的那部分。**它不是第五个数**（`outputTokens` 已经含它），
   * 所以它不进 `src/model/price.ts` 那个算式——这一栏回答的是"想占了多少"。
   */
  readonly reasoningTokens: UsageTotal
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
  /**
   * **跳步数按边数**：图上找回来的每一条多步转移，**它那条路上超出第一条的那些边，一条记一次**
   * （一条两跳的转移记 1，三跳的记 2）。
   *
   * 为什么不是 `hops - transitions`（从前那一处就是那么印的）：那是拿两个不同来源的数相减，
   * 于是两种形态都错——图外边（一条转移零步）让总数变成负数，自环边（原地说了一次，零步而
   * 仍是一条转移）把别的转移里真的跳步抵掉。这一栏是**逐条转移累加**出来的，不做减法。
   *
   * 三条边界：**单边与自环都是零**（自环是一条转移，不是一次跳步）· **图外边不掺进来**
   * （`unrouted` 是另一种事实，它也不抵消别人）· 只数一次、只住这一处（两张读脸都读它）。
   *
   * **它是逐条累加出来的，按构造不可能为负**——`hops - transitions` 那种减法才会印出 -1，
   * 而"负数"本身就是"这个数不是这么算的"的证据。
   */
  readonly skips: number
  /** 打回了几次（`Verifying → Working` 的条数）。**判据在 `probe/round.ts` 那一份里**，这里只是转手。 */
  readonly rejects: number
  /** 图上走不通的那几条（**记数，不炸**）：它是"账与图对不上"的证据。 */
  readonly unrouted: number
  /** 人读的每一步：单边是 `from ──on──> to`，跳步是 `from ⇒ to（经 a · b）`。 */
  readonly edges: readonly string[]
}

/**
 * 跳步那一栏的字。**两张读脸都从这里取**（命令行的 `linesOf` 与 TUI 的 `ui/frame.ts`）：
 * 数只有一处（`RoundTrail.skips`），写法也只有一处——两处各写一遍，迟早有一处先漂，而漂了不报错。
 *
 * 0 就是没有跳步，一个字节都不印（与从前"没有跳步就不印"同形）。
 *
 * **负的不许被这道门吃掉**：判据要是退回到那个减法（`hops - transitions`），这一栏就得把那个
 * 负数**原样印出来**——读了它才知道判据坏了。原先那一处是 `skips > 0`，负的会静默变成"没有
 * 跳步"，与"真的没有跳步"长得一模一样，而那正是这一条要拦下的东西。
 */
export function skipsNote(skips: number): string {
  return skips === 0 ? '' : ` · 跳步 ${skips}`
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
  /** 这一份日志里出现过的模型名（`llm/call` 的 `model`，去重排序）。**价目那一栏按它查**。 */
  readonly models: readonly string[]
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
    // **不是数字的都算"没量到"**：盘上那些早先落下来的日志没有 `reasoningTokens` 这一栏
    // （字段是后加的），`undefined` 加进去会得到 NaN——一个 NaN 会把整行读数带走。
    if (typeof v === 'number') total += v
    else missing++
  }
  return { total, missing }
}

/** 折一条轮次链要的那点东西。**它是折的过程里的临时物**，出口那一份不带它。 */
interface RoundFold {
  state: RoundState
  transitions: number
  hops: number
  skips: number
  unrouted: number
  edges: string[]
  states: { from: RoundState; to: RoundState }[]
}

/** 每一步印成一句话：单边印边名，跳步把找回来的那几步印出来。 */
function renderRoute(from: RoundState, to: RoundState): { text: string; hops: number; skips: number; routed: boolean } {
  const route = routeOf(from, to)
  if (route === null) return { text: `${from} ⇒ ${to}（图上没有这条路）`, hops: 0, skips: 0, routed: false }
  if (route.length <= 1) {
    const e = route[0]
    return e === undefined
      ? { text: `${from} ⇒ ${to}（原地说了一次）`, hops: 0, skips: 0, routed: true }
      : { text: `${from} ──${e.on}──> ${to}`, hops: 1, skips: 0, routed: true }
  }
  return {
    text: `${from} ⇒ ${to}（跳步，经 ${route.map((e) => e.on).join(' · ')}）`,
    hops: route.length,
    // **一条边记一次**：跳掉的是一条转移里超出第一条的那些边——一条两跳的记 1，三跳的记 2。
    // **不是"这条路上一共几条边"**：那样一算，健康账（每一条转移都是单边、只有零星几条两跳）
    // 的读数也会跟着变，而这一站只该改那两种坏形态（黄金帧那一条钉的就是这件事）。
    skips: route.length - 1,
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
    reasoningTokens: [] as (number | null)[],
  }
  let calls = 0
  /** 账上出现过的模型名（`llm/call` 的 `model`）。出口排序——**价目那一栏按它查**。 */
  const models = new Set<string>()
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
        fold = { state: 'Idle', transitions: 0, hops: 0, skips: 0, unrouted: 0, edges: [], states: [] }
        rounds.set(e.round, fold)
        roundOrder.push(e.round)
      }
      const r = renderRoute(e.from, e.to)
      fold.state = e.to
      fold.transitions++
      fold.hops += r.hops
      fold.skips += r.skips
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
      usage.reasoningTokens.push(e.usage.reasoningTokens)
      models.add(e.model)
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
        skips: fold.skips,
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
      reasoningTokens: totalOf(usage.reasoningTokens),
    },
    models: [...models].sort(),
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
  return statusOf(await rowsOf(() => log.readMerged()))
}

/**
 * **序 32 的那个出口**：这一刻的处境，加那两份从账上重算的读数。
 *
 * `status --once --metrics --report --json` 吐的就是这一份，而**去掉 `width` / `height` 就是
 * `ui/frame.ts` 的 `FrameInput`**——TUI 的输入契约与命令面的 JSON 是同一份，不许有两份
 * （PLAN § 5.19 第五段）。第二个渲染器（另一个宿主 · 另一门语言 · 原生窗口）的入场券也在这里：
 * 没有它，那三份折叠只得被重写一遍。
 *
 * **快照那一份的形状一个字段都不动**：`StatusSnapshot` 是 `status --once` 的全部输出，八元与打回
 * 三数是**外套**在它上面的两栏，各自走各自那一处的折法（`metricsOf` · `countsOf`），这里不另立。
 *
 * **没要的那一栏不出现**（不是空数组）："没算"与"算出来是空"要分得开（`B1` 那条）。
 */
export interface StatusReadings {
  /** 读源一：那一刻的处境。**恒在**——不给那两个开关也读它。 */
  readonly snapshot: StatusSnapshot
  /** 读源二：八元指标。**给了 `--metrics` 才有这一栏**。 */
  readonly metrics?: readonly MetricValue[]
  /** 读源三：打回那三个数。**给了 `--report` 才有这一栏**。 */
  readonly report?: readonly MetricReading[]
  /**
   * 读源四：**每调用成本台账**（0.3.0 ④）。**给了 `--ledger` 才有这一栏**。
   *
   * 折法住 `probe/ledger.ts`（一处）：这一栏与上面那两栏读的是同一份行、同一个 `readings()` 出口，
   * 于是 `--json` 那一份对象去掉 `width` / `height` 还是 `ui/frame.ts` 的 `FrameInput`——第二个渲染器
   * 要吃这一份不用新开一条路。
   */
  readonly ledger?: Ledger
}

/** 那两个开关（与 `round run` / `round work` 上同名同义）。 */
export interface ReadingsOptions {
  readonly metrics?: boolean
  readonly report?: boolean
  /**
   * **每调用成本台账**（0.3.0 ④）：给了它才算这一栏。
   *
   * 与那两个布尔开关不同，它要几样读的人才知道的东西：价目与模型目录（钱的来源，**必给**）·
   * 峰谷档（不给就不印钱那一栏）· 已绑定动作的命令行（走法那一栏的第二半）。口径在 `probe/ledger.ts`。
   */
  readonly ledger?: LedgerInputs
  /**
   * **只读某一个 writer 的那一份**（`status --agent <x>`；`T8` 的"切过去"就是它）。口径与 `log
   * --agent` / `watch --agent` 是同一句：**只按 writer 选一份**（架构 § 9.6 那三行）。
   *
   * 不给就是整份账。**"不给"与"给了 `round`"不是一回事**：处境那一条链（`round/state`）住在持轮者
   * 那一份日志里，主线那一档要的是全部。
   */
  readonly agent?: string
}

/**
 * 读一次账，折出要的那几栏。**一遍读齐**：三份读数读的是同一串事件（架构 § 8.15 那条验证性质
 * 要求重放是确定的），所以这里不重复读日志——也不走 `snapshot(log)` 那一份单读一遍。
 *
 * 范围是**全部**（不按轮次筛）：`status` 读的是"这一刻的处境"，而处境是整份账的函数。**与跑完
 * 那一档不同源**：`round run` / `round work` 递的是 `{round}`（只数这一轮），所以同一个名字在
 * 两处印出来的数可以不一样——**这一点写在读数自己身上**（`countsOf` 那三行 `how` 开头的
 * `[本轮]` / `[整账]`），不靠读的人记得是谁印的。
 */
export async function readings(log: Pick<Log, 'readMerged'>, opts: ReadingsOptions = {}): Promise<StatusReadings> {
  const rows = await rowsOf(() => log.readMerged())
  // **`agent` 那一档在折之前筛**（不是折完再挑印哪几行）：两处（命令面与界面）筛的是同一批行，于是
  // `T8` 那句"切过去之后面板与 `status --agent <x> --once` 逐字相同"查得动（`status.test.ts` ⑫）。
  return readingsOf(opts.agent === undefined ? rows : rows.filter((r) => r.pos.writer === opts.agent), opts)
}

/**
 * 同一条折法，**收的是一整份行**（`readings` 读回来的就是它）。
 *
 * 为什么要这一个出口：TUI 每一趟读回来的那一份行要**同时**喂两处——三份读数（这一份）与永久行
 * 那一栏（`ui/stream.ts` 的 `permanentLinesOf`）。两处各读一遍日志的话，"同一份账两条读数"这件事
 * 就又有了第二条路（PLAN § 5.19 第五段的输入契约：命令面与渲染器读同一份）。
 */
export function readingsOf(rows: readonly StatusRow[], opts: ReadingsOptions = {}): StatusReadings {
  const out: {
    snapshot: StatusSnapshot
    metrics?: readonly MetricValue[]
    report?: readonly MetricReading[]
    ledger?: Ledger
  } = { snapshot: statusOf(rows) }
  if (opts.metrics === true) out.metrics = metricsOf(rows, {})
  if (opts.report === true) out.report = countsOf(rows, {})
  if (opts.ledger !== undefined) out.ledger = ledgerOf(rows, opts.ledger)
  return out
}

/** 交错那一份读侧 → 一整份行。**两处共用**：`snapshot` 要它折快照，`callLinesOf` 要它逐趟列。 */
export async function rowsOf(read: () => AsyncIterable<StatusRow>): Promise<StatusRow[]> {
  const rows: StatusRow[] = []
  for await (const r of read()) rows.push(r)
  return rows
}

/**
 * 一次调用那几个数的人读写法：**没量到的印「未量到」，不拿 0 顶**（与用量那一行同一条规矩）。
 */
function callNums(u: { readonly inputTokens: number | null; readonly cacheReadTokens: number | null; readonly cacheWriteTokens: number | null; readonly outputTokens: number | null; readonly reasoningTokens: number | null }): string {
  const at = (v: number | null): string => (typeof v === 'number' ? String(v) : '未量到')
  return (
    `input ${at(u.inputTokens)} · cacheRead ${at(u.cacheReadTokens)}` +
    ` · cacheWrite ${at(u.cacheWriteTokens)} · output ${at(u.outputTokens)}（思考 ${at(u.reasoningTokens)}）`
  )
}

/** 一次调用的钱。**只吃那四个数**（思考 token 是输出里的明细，再加一遍就是把同一笔钱算两回）。 */
function oneCallMoney(model: string, u: Parameters<typeof callNums>[0], phase: Phase, cat: Catalog): string {
  const row = matchModels([model], cat).row
  const b: Billable = {
    calls: 1,
    inputTokens: totalOf([u.inputTokens]),
    cacheReadTokens: totalOf([u.cacheReadTokens]),
    cacheWriteTokens: totalOf([u.cacheWriteTokens]),
    outputTokens: totalOf([u.outputTokens]),
  }
  const m = costOf(b, row, phase)
  if (m.usd === null) return `算不出来：${model} 不在价目表里——不拿 0 顶`
  return `${formatUsd(m.usd)}${m.missing > 0 ? `（下界：有 ${m.missing} 条没量到）` : ''}`
}

/**
 * **逐趟账**：每一条 `llm/call` 一行（`--report` 里那一栏 · PLAN § 5.9 的 `G5` 那句话）。
 *
 * 为什么要逐趟而不是只有合计：一趟里那几步的价钱差着量级——探路那几步几十 token，落笔那一步
 * 几百到几千。「这一轮花了多少」合计答得出，而"钱花在哪一步"只有逐趟答得出，那正是"预算被探路
 * 吃满"这个失败形状要看的那一栏。
 *
 * **每一行都指得到一条事件**（`llm/call` 的 `agent` · `step` · `stop` · `rawStop` · `thinking` ·
 * `usage`），没有一处推断。合计那一行走 `statusOf`（与 `status --once` 同一个汇总，不另算一份）。
 *
 * 钱的档由读的人给（账上没有时刻）：**不给档就不印钱**，而"不印"这件事在那一行里说出来
 * （与用量那一栏同一条规矩：少印要说，不拿 0 顶）。
 */
export function callLinesOf(rows: readonly StatusRow[], opts: LinesOptions): readonly string[] {
  const out: string[] = []
  for (const { e } of rows) {
    if (e.t !== 'llm/call') continue
    // 半截的流那一档（`stop` 为 `null`）：**不许当"走完了"**，所以它有自己的写法。
    const why = e.stop === null ? 'cut-stream（这一趟没走完）' : e.rawStop === null ? e.stop : `${e.stop}（${e.rawStop}）`
    const money =
      opts.phase === undefined ? ' · 钱 没印（读的时候没给峰谷档）' : ` · 钱 ${oneCallMoney(e.model, e.usage, opts.phase, opts.cat)}`
    out.push(`格 ${e.agent} · 步 ${e.step} · ${why} · 思考 ${e.thinking ?? '没声明'} · ${callNums(e.usage)}${money}`)
  }
  const s = statusOf(rows)
  const u = s.usage
  const one = (n: string, t: UsageTotal): string => `${n} ${t.total}${t.missing > 0 ? `（缺 ${t.missing} 条）` : ''}`
  const total =
    `合计 调用 ${u.calls} · ${one('input', u.inputTokens)} · ${one('cacheRead', u.cacheReadTokens)}` +
    ` · ${one('cacheWrite', u.cacheWriteTokens)} · ${one('output', u.outputTokens)} · ${one('思考', u.reasoningTokens)}`
  if (u.calls === 0) {
    out.push(`${total}——这一份日志里一次调用都还没有`)
    return out
  }
  if (opts.phase === undefined) {
    out.push(`${total} · 费用 没印：读的时候没给峰谷档（账上没有时刻，这一档只能由读的人给）——不拿 0 顶`)
    return out
  }
  const match = matchModels(s.models, opts.cat)
  out.push(`${total} · ${moneyText({ money: costOf(u, match.row, opts.phase), match, phase: opts.phase, models: s.models })}`)
  return out
}

/**
 * 一份快照排成人读的几行。**`--json` 那一档直接吐对象，不走这里。**
 *
 * 跳步（`skipsNote`，数与写法都住 `probe/status.ts` 那一处）与"图上没有这条路"都在这里印出来：
 * 读面不许把"账与图对不上"这件事咽下去。
 */
export interface LinesOptions {
  /**
   * 读的时候是峰时还是谷时（官方价目分两档）。**不给就不印钱那一栏**——账上没有时刻，这一档只能由
   * 读的人给（`src/model/price.ts` 的 `phaseOf` 拿当时的钟算）。
   */
  readonly phase?: Phase
  /** 价目与模型目录算在哪一份上（P2d）：**必给**——`phase` 给了它就一定用得到；调用方
   * （命令面）拿 `readCatalog()` 的那份，不缺省回内置（缺省会让文件档在场时钱按内置算）。 */
  readonly cat: Catalog
}

export function linesOf(s: StatusSnapshot, opts: LinesOptions): readonly string[] {
  const out: string[] = []
  if (s.rounds.length === 0) out.push('一条轮次状态都没有：这份日志里还没开过轮次')
  for (const r of s.rounds) {
    const here = r.round === s.current ? ' · 最近一条落在这一轮' : ''
    // 跳步那一栏与 TUI 逐字同源（`skipsNote`）：**这两个数从前各写各的减法，两处都能印出负数**。
    // `hops` 不再单独印一句——每一跳印在哪几条边上，下面那几行边自己写着。
    const odd = r.unrouted > 0 ? ` · 图外 ${r.unrouted} 条` : ''
    out.push(`轮次 ${r.round} · 状态 ${r.state} · 转移 ${r.transitions} 条${skipsNote(r.skips)} · 打回 ${r.rejects} 次${odd}${here}`)
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
      ` · ${one('cacheWrite', u.cacheWriteTokens)} · ${one('output', u.outputTokens)}` +
      ` · ${one('思考', u.reasoningTokens)}`,
  )
  // 钱那一栏：**读的人给了档才印**（账上没有时刻）。算不出来时那一行会说"算不出来"，不拿 0 顶。
  if (opts.phase !== undefined) {
    const match = matchModels(s.models, opts.cat)
    out.push(moneyText({ money: costOf(u, match.row, opts.phase), match, phase: opts.phase, models: s.models }))
  } else {
    // **少印要说**：原先这一档静默地少一行，于是"没给档"与"这一份日志没有钱那一栏"长得一样。
    out.push('费用 没印：读的时候没给峰谷档（账上没有时刻，这一档只能由读的人给）——不拿 0 顶')
  }
  out.push(
    s.last === null
      ? '事件 0 条'
      : `事件 ${s.events} 条 · 最近 ${s.last.t}（writer=${s.last.writer} seq=${s.last.seq}）`,
  )
  return out
}

/** 打回读数那一块的表头。**一处取值处**：`status` 与跑完那一档印的是同一句。 */
export const REPORT_HEAD = '打回读数（从日志重算，不采集）：'

/** 八元指标那一块的表头。同上——两处读法逐字相同，靠的就是这两个常数。 */
export const METRICS_HEAD = '八元指标（从日志重算，不采集；分子与分母一起印）：'

/**
 * `status` 那一份的文字面：快照那几行，加**要了的**那两栏。**一处渲染**——命令面因此只有一行
 * `emitLine`，而"两处读法逐字相同"这句话在文字面上也立得住（表头是上面那两个常数，行是
 * `linesOfReadings` 与 `lineOf` 那两处）。
 */
export function readingsLines(r: StatusReadings, opts: LinesOptions): readonly string[] {
  const out = [...linesOf(r.snapshot, opts)]
  if (r.report !== undefined) out.push(REPORT_HEAD, ...linesOfReadings(r.report).map((l) => `  ${l}`))
  if (r.metrics !== undefined) out.push(METRICS_HEAD, ...r.metrics.map((m) => `  ${lineOf(m)}`))
  if (r.ledger !== undefined) out.push(LEDGER_HEAD, ...ledgerLines(r.ledger).map((l) => `  ${l}`))
  return out
}
