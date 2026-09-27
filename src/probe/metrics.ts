// M14 的余下八支：**那八个指标，从日志重算**。出处：架构 § 8.15（八元的 `MetricId` · 三个一线
// 指标 · "**不采集，只重算**——因此任何指标都能被复核，任何历史日志都能被重新分析" · 验证性质
// "重放同一份日志，得到同一组指标值"）· § 20 S8 的验证一二（零工具调用率与绕行率基线建立 ·
// 同一模型两个协议的指标可比）· § 13.3（协议成为可分发物）· § 8.13.a（`handoff-yield`）·
// § 8.15 的设计要点（`ensure-latency` 与 `git-calls-per-round` 是内核原生迁移那类判断的输入）。
//
// **这一份没有一处采集点。** 八个指标全部从 `M0` 的事件流里读出来，而"读哪几条 · 怎么数"写在
// `METRIC_HOW` 那一张表里（与数一起印出来，好让它与代码对得上）。于是同一份日志重放两次同值，
// 而两个人拿同一份日志按那八句话各算一遍也同值。
//
// **分母与分子都要印得出来**（PLAN § 5.8 的 B7 断言 ②）：所以每条读数带 `numerator` ·
// `denominator` · `how`，而"算不出来"与"算出来是 0"分得开——前者给 `null`。这一条是 `B7` 那
// 一次审的核心：**合成一个比值的时候分母是什么，必须写在数据里**。
import type { LogEvent } from '../log/events.ts'
import type { RoundId } from '../terms.ts'

/**
 * 八元（架构 § 8.15 的 `MetricId`，逐字）。**每一个都要有一句话说得清它是怎么从事件里数出来的**
 * ——说不清的那一个不该在这里（`METRIC_HOW` 是它的判据）。
 */
export type MetricId =
  | 'zero-tool-call-rate'
  | 'detour-rate'
  | 'prefix-hit-rate'
  | 'prefix-versions'
  | 'materialize-precision'
  | 'ensure-latency'
  | 'git-calls-per-round'
  | 'handoff-yield'

export const METRIC_IDS: readonly MetricId[] = [
  'zero-tool-call-rate',
  'detour-rate',
  'prefix-hit-rate',
  'prefix-versions',
  'materialize-precision',
  'ensure-latency',
  'git-calls-per-round',
  'handoff-yield',
]

/** 一条读数：那个值 · 分子 · 分母 · 一句话说清怎么数出来的。 */
export interface MetricValue {
  readonly metric: MetricId
  /** 比值或计数。**算不出来是 `null`**（比如一次调用都没有时的比率）。 */
  readonly value: number | null
  /** 分子。**算不出来是 `null`。** */
  readonly numerator: number | null
  /** 分母。**它是什么写在 `how` 里**，不能默认它对所有人都显然。 */
  readonly denominator: number | null
  /** 这一条怎么数出来的（人读的一句话，含分母是什么）。 */
  readonly how: string
  /** 附带的几个数（分布那一类指标的读法）。 */
  readonly detail?: Readonly<Record<string, number>>
}

/**
 * 八个指标的判据。**每一句话里都要有"分母是什么"**——这句话是给人核对用的，所以它不许写成
 * "命中率"这种只有名字的信息。
 */
export const METRIC_HOW: Readonly<Record<MetricId, string>> = {
  'zero-tool-call-rate':
    '分子：`llm/call` 里 **`invocations`（模型这一趟调了几条工具）为 0** 的条数（**它一次都没伸手**）；' +
    '分母：全部 `llm/call` 的条数。本架构最危险的失败模式：约束导致模型不伸手。' +
    '**分子用的是 `invocations`，不是 `toolCount`**：后者是"我们公布了几条"，与它伸不伸手无关。',
  'detour-rate':
    '分子：`run/start` 的 `argv` 里那一行命令**提到了某个已公布工具的名字**（`read` · `grep` · …）的条数' +
    '——模型绕开工具、用 shell 干同一件事；分母：全部 `run/start` 的条数。' +
    '**它是接口不兼容的唯一直接证据。**',
  'prefix-hit-rate':
    '分子：`llm/call` 里 `usage.cacheReadTokens > 0` 的条数（**上游说这一趟读到了缓存**）；' +
    '分母：全部 `llm/call` 的条数。**分母不是 token 数**——那是"省了多少"的读法，' +
    '而这里问的是"有几趟命中了"。',
  'prefix-versions':
    '**分子**：`prefix/assemble` 里 `(zoneAHash, zoneBHash)` **变化**的次数（第一次也算一次）——' +
    '跨步稳定的那一段被重装配了几版。**逐 writer 各数一份、再加起来**：B 区是逐 writer 一份' +
    '（架构 § 8.11），而事件流是**交错**的——合成一条链数的话，每换一个 writer 都算一次「变了」。' +
    '真档那一趟（53 次调用 · 5 个 writer）这一栏读出 51，逐 writer 查一遍是 5。**分母恒为 1**' +
    '（它是一个计数，不是一个比；`value` 就是分子）。',
  'materialize-precision':
    '分子：`mat/fork` 与 `mat/sync` 的 `paths` 条数之和（**物化碰过的路径**）；' +
    '分母：`mat/reclaim` 的 `changed` 条数之和（**实际变更的路径**）。' +
    '承重性质的度量化：两者应恒等；一旦不等，`tsc --incremental` 正在失效。',
  'ensure-latency':
    '**分子**：`mat/fork` 与 `mat/sync` 的条数（每一次 ensure 一趟）；**分母恒为 1**（计数类）。' +
    '`value` 是那些 `ms` 的**中位数**，`detail` 里给最小 · 最大 · 求和 · 条数。',
  'git-calls-per-round':
    '分子：一个轮次里会碰对象库的那几条事件的条数（`view/write` 与 `view/symlink` 各一次 `putBlob` ·' +
    '`mat/fork` 一次 fork · `ckpt/commit` 一次 `putTree` + 一次 `commit`）；分母：`round/state` 里' +
    '见到过几个不同的轮次号（**一个都没有时给全部**）。',
  'handoff-yield':
    '**分子**：每一次 `agent/handoff` 到它**后继那一个 agent** 头一次成功写视图（`view/*` 或 ' +
    '`ckpt/commit`）之间，属主落了几个 `llm/call`（**步数**）之和；**分母**：真的等到了一次产出' +
    '的交接条数。`value` 是平均值（步/交接）。接续的失败是静默的——不报错，只是重做已完成的工作；' +
    '这个数把它从感觉变成读数。',
}

/** 一个范围。**不给轮次就是全部**——与 `probe/round.ts` 那一份同一个口径。 */
export interface MetricsRange {
  readonly round?: RoundId
}

/** 交错的读侧那一条（`readMerged` 的全序流：`pos` 里有 `writer`）。 */
export type MergedRow = { readonly pos: { readonly writer: string; readonly seq: number }; readonly e: LogEvent }

/** `bash` 那一行命令里出现了哪个已公布工具的名字——**绕行的判据**。 */
const TOOL_WORDS: readonly string[] = ['read', 'write', 'edit', 'glob', 'grep', 'checkpoint', 'run_action']

/**
 * 一行命令算不算"绕行"。
 *
 * 判据是**这一行里提到了某个工具的名字**（词边界：`\bread\b`），而不是"它是不是在干工具能干的事"
 * ——后一句话今天没有可判定的形状（架构 § 8.10 的工具目录管的是"我们公布什么"，不是"shell 里
 * 不许出现什么字"）。所以这条读数**偏保守**：它会漏掉"用 `sed -n 1,20p` 代替 read"那一类，
 * 而不会把 `echo readme` 误判成绕行。
 */
export function looksLikeDetour(argv: readonly string[]): boolean {
  const line = argv.join(' ')
  return TOOL_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(line))
}

/**
 * **一遍读完八个指标。**
 *
 * 为什么是一遍而不是八遍：八个指标读的是同一串事件，而"同一份日志重放两次得到同一组值"这条
 * 验证性质要求这一遍是确定的——一遍读完，就没有"某一支多读了什么"这种偏差。`compute` 那一支
 * 从这一份结果里取一条（架构那一份签名是 `compute(range, metric)`，这里是它的实现）。
 */
export function metricsOf(rows: readonly MergedRow[], range: MetricsRange = {}): readonly MetricValue[] {
  const inRange = (e: LogEvent): boolean => {
    if (range.round === undefined) return true
    // 不带轮次号的事件（`run/*` · `llm/call` · `view/*` · `agent/handoff`）**照数**——如实写在
    // `METRIC_HOW` 里（`probe/round.ts` 那条口径逐字：不假装筛过）。
    if ('round' in e && typeof e.round === 'string') return e.round === range.round
    return true
  }

  let calls = 0
  let zeroCalls = 0
  let cachedCalls = 0
  let starts = 0
  let detours = 0
  let prefixVersions = 0
  /** 逐 writer 各记一份——`(A,B)` 是逐 writer 的东西（B 区逐 writer 一份）。 */
  const lastAb = new Map<string, string>()
  let touched = 0
  let changed = 0
  const latencies: number[] = []
  let gitish = 0
  const rounds = new Set<string>()
  let handoffs = 0
  let yieldSum = 0
  let yields = 0
  /** 交接之后等着"头一次有效写"的那几个 agent（名字 → 已经数了几步）。 */
  const waiting = new Map<string, number>()

  for (const { e } of rows) {
    if (!inRange(e)) continue
    switch (e.t) {
      case 'llm/call': {
        calls += 1
        if (e.invocations === 0) zeroCalls += 1
        if ((e.usage.cacheReadTokens ?? 0) > 0) cachedCalls += 1
        for (const [who, n] of waiting) waiting.set(who, n + 1)
        break
      }
      case 'run/start': {
        starts += 1
        if (looksLikeDetour(e.argv ?? [e.argv0])) detours += 1
        // 起一次子进程本身不碰对象库；碰它的是产出被收上去那一步（`mat/reclaim`，那一条今天
        // 不带 git 的次数）。所以这一条不进 `gitish`——宁可少算，不把子进程当 git 调用。
        break
      }
      case 'prefix/assemble': {
        // **按 writer 各数一份。** 交错的流里「变了」大半是换了一个 writer，不是重装配：
        // 真档那一趟 53 次调用 · 5 个 writer 读出 51，而逐 writer 是 5。
        const ab = `${e.agent}/${e.zoneAHash}/${e.zoneBHash}`
        if (lastAb.get(e.agent) !== ab) {
          prefixVersions += 1
          lastAb.set(e.agent, ab)
        }
        break
      }
      case 'mat/fork':
      case 'mat/sync': {
        touched += e.paths.length
        latencies.push(e.ms)
        gitish += 1 // fork 那一步会碰对象库
        break
      }
      case 'mat/reclaim': {
        changed += e.changed.length
        break
      }
      case 'view/write':
      case 'view/symlink':
        gitish += 1 // putBlob
        settle(e.agent)
        break
      case 'ckpt/commit':
        gitish += 2 // putTree + commit
        settle(e.agent)
        break
      case 'view/remove':
      case 'view/rename':
      case 'view/chmod':
        settle(e.agent)
        break
      case 'agent/handoff': {
        handoffs += 1
        // 后继那一个 agent 从这一刻起开始等"头一次有效写"。
        waiting.set(e.successor, 0)
        break
      }
      case 'round/state': {
        rounds.add(e.round)
        break
      }
      default:
        break
    }
  }

  /** 某一个 agent 落了一次有效写：它（如果正在等）的步数就到手了。 */
  function settle(agent: string): void {
    const n = waiting.get(agent)
    if (n === undefined) return
    waiting.delete(agent)
    yields += 1
    yieldSum += n
  }

  const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den)
  const sorted = [...latencies].sort((a, b) => a - b)
  const median = sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!

  return [
    {
      metric: 'zero-tool-call-rate',
      value: rate(zeroCalls, calls),
      numerator: calls === 0 ? null : zeroCalls,
      denominator: calls === 0 ? null : calls,
      how: METRIC_HOW['zero-tool-call-rate'],
    },
    {
      metric: 'detour-rate',
      value: rate(detours, starts),
      numerator: starts === 0 ? null : detours,
      denominator: starts === 0 ? null : starts,
      how: METRIC_HOW['detour-rate'],
    },
    {
      metric: 'prefix-hit-rate',
      value: rate(cachedCalls, calls),
      numerator: calls === 0 ? null : cachedCalls,
      denominator: calls === 0 ? null : calls,
      how: METRIC_HOW['prefix-hit-rate'],
    },
    {
      metric: 'prefix-versions',
      value: prefixVersions,
      numerator: prefixVersions,
      denominator: 1,
      how: METRIC_HOW['prefix-versions'],
    },
    {
      metric: 'materialize-precision',
      value: rate(touched, changed),
      numerator: touched,
      denominator: changed,
      how: METRIC_HOW['materialize-precision'],
    },
    {
      metric: 'ensure-latency',
      value: median,
      numerator: latencies.length,
      denominator: 1,
      how: METRIC_HOW['ensure-latency'],
      detail:
        latencies.length === 0
          ? { count: 0 }
          : { count: latencies.length, min: sorted[0]!, max: sorted[sorted.length - 1]!, sum: sorted.reduce((a, b) => a + b, 0) },
    },
    {
      metric: 'git-calls-per-round',
      value: rate(gitish, rounds.size === 0 ? 1 : rounds.size),
      numerator: gitish,
      denominator: rounds.size === 0 ? 1 : rounds.size,
      how: METRIC_HOW['git-calls-per-round'],
      detail: { rounds: rounds.size },
    },
    {
      metric: 'handoff-yield',
      value: yields === 0 ? null : yieldSum / yields,
      numerator: yields === 0 ? null : yieldSum,
      denominator: yields === 0 ? null : yields,
      how: METRIC_HOW['handoff-yield'],
      detail: { handoffs, settled: yields },
    },
  ]
}

/**
 * 一支（架构那一份签名的实现）：`compute(range, metric)`。
 *
 * `merged` 是一**个函数**而不是一条流：交错读侧是一次性的迭代器，而八个指标各要自己那一遍
 * （`probe/round.ts` 那条口径）。`metricsOf` 收的是已经读好的数组——用它的人可以只读一遍。
 */
export async function compute(
  merged: () => AsyncIterable<MergedRow>,
  range: MetricsRange,
  metric: MetricId,
): Promise<MetricValue> {
  const rows: MergedRow[] = []
  for await (const r of merged()) rows.push(r)
  const all = metricsOf(rows, range)
  const one = all.find((m) => m.metric === metric)
  if (one === undefined) throw new Error(`没有这个指标：${metric}（有的是 ${METRIC_IDS.join(' · ')}）`)
  return one
}

/** 八个一次算齐（走一遍）。 */
export async function computeAllMetrics(merged: () => AsyncIterable<MergedRow>, range: MetricsRange): Promise<readonly MetricValue[]> {
  const rows: MergedRow[] = []
  for await (const r of merged()) rows.push(r)
  return metricsOf(rows, range)
}

/** 一条读数印成一行（`--report --metrics` 那一栏）。**分子与分母一起印**（断言 ②）。 */
export function lineOf(m: MetricValue): string {
  const v = m.value === null ? '算不出来' : String(m.value)
  const d = m.detail === undefined ? '' : `　[${Object.entries(m.detail).map(([k, n]) => `${k}=${n}`).join(' ')}]`
  return `${m.metric}\t${v}\t分子 ${m.numerator ?? '—'} / 分母 ${m.denominator ?? '—'}${d}\t${m.how}`
}

// ── 归因三处对照（闸四 · PLAN § 5.9.1 与 § 5.9.3 判据卡那一栏）──────────────────────
//
// **归因不走"我们声明了什么"，走"命中落在哪一段"**（§ 5.9.1 闸四那两段）：闸四这一档是隐式缓存
// （提供方自己按前缀命中、报 `prompt_cache_hit_tokens`），所以它验的是结果（钱认了多少），不是声明。
// 三处够了：
//
//   一 · **冷**：第一个 agent 的第 0 步。**"第 0 步命中 ≈ 0"不靠"它是第一趟"来保证**——提供方的
//        隐式缓存跨进程、跨趟（实测过 `call-0001` 就报了 1,280 命中）。要一处破坏对照：改 A 区
//        一个字节再跑一趟，这一处应当掉下去；掉不下去，说明命中的不是前缀，那条读数就不能进账。
//   二 · **共享头**：第二个 agent 的第 0 步——两格读的是同一段 A 区，该命中。
//   三 · **同一 agent 第 k 步**：同一格的最后一次调用——命中**不该随步数增长**（前缀就那么长）。
//
// **三行恒在**：位置不存在（这一趟只有一格 · 这一格只走了一步 · 一条 `llm/call` 都没有）时，那一行
// 给的是「没有读数」加一句为什么——**不拿 0 顶**（判据卡那两条纪律）。这一份只读 `llm/call`
// （与 `prefix-hit-rate` 同一个源），不读别的状态，也**不假定任何一处"应该命中"**：日志说什么就报什么。

/** 一处对照的读数。 */
export interface AttributionReading {
  /** 那一处怎么读（例：`agent/r1/1 第 0 步（冷）`）。 */
  readonly where: string
  /** 那一处是哪个 agent · 第几步；**位置不存在时是 `null`**（与"上游没报这个数"分得开）。 */
  readonly agent: string | null
  readonly step: number | null
  /** 上游报回来的两个数（`cacheReadTokens` 是这一处要读的那一个）。 */
  readonly inputTokens: number | null
  readonly cacheReadTokens: number | null
  /** 这一处的读数意味着什么；没有读数时写清为什么。 */
  readonly note: string
}

/** 三处各自的判据（与数一起印出来）。 */
export const ATTRIBUTION_HOW: readonly string[] = [
  '冷 = 第一个 agent 的第 0 步。**"第 0 步命中 ≈ 0"不靠"它是第一趟"保证**（隐式缓存跨进程、跨趟）：破坏对照是改 A 区一个字节再跑一趟，这一处该掉下去。',
  '共享头 = 第二个 agent 的第 0 步。两格读的是同一段 A 区，**该命中**。',
  '第 k 步 = 同一格的最后一次调用。与它自己第 0 步比，命中**不该随步数增长**。',
]

/** 一次调用在哪一处。 */
interface CallAt {
  readonly agent: string
  readonly step: number
  readonly inputTokens: number | null
  readonly cacheReadTokens: number | null
}

/**
 * `llm/call` 按 agent 分组、按步号升序。
 *
 * **"第几个 agent"按名字末尾那个数排**，不按名字的字典序：`agent/r1/10` 的字典序在
 * `agent/r1/2` 前面，而"第二个 agent"指的是 2 那一格。末尾不是数的（走查里那种 `agent-1-2`）
 * 排在后面，再按名字比。
 */
function callsByAgent(rows: readonly MergedRow[]): Map<string, CallAt[]> {
  const by = new Map<string, CallAt[]>()
  for (const { e } of rows) {
    if (e.t !== 'llm/call') continue
    const n = Number(String(e.step).split('/').pop())
    const list = by.get(e.agent) ?? []
    list.push({
      agent: e.agent,
      step: Number.isInteger(n) ? n : list.length,
      inputTokens: e.usage.inputTokens,
      cacheReadTokens: e.usage.cacheReadTokens,
    })
    by.set(e.agent, list)
  }
  for (const list of by.values()) list.sort((a, b) => a.step - b.step)
  return by
}

/** agent 名的次序：末尾那个数小的在前，不是数的排后面（再按名字比）。 */
function agentOrder(a: string, b: string): number {
  const tail = (x: string): number => {
    const n = Number(x.split('/').pop())
    return Number.isInteger(n) ? n : Number.MAX_SAFE_INTEGER
  }
  return tail(a) - tail(b) || (a < b ? -1 : a > b ? 1 : 0)
}

const show = (v: number | null): string => (v === null ? '没有读数' : String(v))

/** 一处：有那一处就给读数，没有就给「没有读数」加一句为什么。 */
function oneAt(
  where: string,
  at: CallAt | undefined,
  note: (a: CallAt) => string,
  missing: string,
): AttributionReading {
  if (at === undefined) {
    return { where, agent: null, step: null, inputTokens: null, cacheReadTokens: null, note: missing }
  }
  return { where, agent: at.agent, step: at.step, inputTokens: at.inputTokens, cacheReadTokens: at.cacheReadTokens, note: note(at) }
}

/** 三处对照。**恒三行**，次序就是上面那三处（冷 · 共享头 · 第 k 步）。 */
export function attributionOf(rows: readonly MergedRow[]): readonly AttributionReading[] {
  const by = callsByAgent(rows)
  const agents = [...by.keys()].sort(agentOrder)
  const first = agents[0]
  const second = agents[1]
  const cold = first === undefined ? undefined : by.get(first)?.[0]
  const shared = second === undefined ? undefined : by.get(second)?.[0]
  const own = first === undefined ? [] : (by.get(first) ?? [])
  const last = own.length > 1 ? own[own.length - 1] : undefined
  const coldHit = cold?.cacheReadTokens ?? null
  return [
    oneAt(
      `${first ?? '（没有 agent）'} 第 0 步（冷）`,
      cold,
      (a) =>
        `命中 ${show(a.cacheReadTokens)}（输入 ${show(a.inputTokens)}）。**它不是天然为 0**：` +
        '破坏对照是改 A 区一个字节再跑一趟，这一处该掉下去',
      '没有读数：这一趟一条 `llm/call` 都没有（打桩那一档就是这一种）',
    ),
    oneAt(
      `${second ?? '（没有第二个 agent）'} 第 0 步（共享头）`,
      shared,
      (a) =>
        `命中 ${show(a.cacheReadTokens)}（输入 ${show(a.inputTokens)}）。与冷那一处比：${show(coldHit)} → ${show(a.cacheReadTokens)}` +
        '——两格读的是同一段 A 区',
      second === undefined
        ? '没有读数：这一趟只有一格（共享头要两格才读得到）'
        : '没有读数：第二个 agent 一条 `llm/call` 都没有',
    ),
    oneAt(
      last === undefined ? `${first ?? '（没有 agent）'} 第 k 步` : `${last.agent} 第 ${last.step} 步（同一格第 k 步）`,
      last,
      (a) =>
        `命中 ${show(a.cacheReadTokens)}（输入 ${show(a.inputTokens)}）· 它自己第 0 步是 ${show(coldHit)}` +
        '——命中不随步数增长（前缀就那么长）',
      '没有读数：这一格只走了一步（第 k 步与第 0 步是同一处）',
    ),
  ]
}

/** 三处对照一次读齐（与八元指标同一个形状：收一个"再来一遍"的函数）。 */
export async function computeAttribution(
  merged: () => AsyncIterable<MergedRow>,
): Promise<readonly AttributionReading[]> {
  const rows: MergedRow[] = []
  for await (const r of merged()) rows.push(r)
  return attributionOf(rows)
}

/** 一处印成一行（`--report` 那一栏）。 */
export function lineOfAttribution(a: AttributionReading): string {
  return `${a.where}\t命中 ${a.cacheReadTokens ?? '没有读数'} / 输入 ${a.inputTokens ?? '没有读数'}\t${a.note}`
}
