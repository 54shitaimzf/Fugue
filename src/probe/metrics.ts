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
    '分子：`llm/call` 里 `toolCount` 为 0 的条数（**它一次都没伸手**）；分母：全部 `llm/call` 的条数。' +
    '本架构最危险的失败模式：约束导致模型不伸手。',
  'detour-rate':
    '分子：`run/start` 的 `argv` 里那一行命令**提到了某个已公布工具的名字**（`read` · `grep` · …）的条数' +
    '——模型绕开工具、用 shell 干同一件事；分母：全部 `run/start` 的条数。' +
    '**它是接口不兼容的唯一直接证据。**',
  'prefix-hit-rate':
    '分子：`llm/call` 里 `usage.cacheReadTokens > 0` 的条数（**上游说这一趟读到了缓存**）；' +
    '分母：全部 `llm/call` 的条数。**分母不是 token 数**——那是"省了多少"的读法，' +
    '而这里问的是"有几趟命中了"。',
  'prefix-versions':
    '**分子**：`prefix/assemble` 里 `(zoneAHash, zoneBHash)` **变化**的次数（第一次也算一次）' +
    '——跨步稳定的那一段被重装配了几版；**分母恒为 1**（它是一个计数，不是一个比；`value` 就是分子）。',
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
  let lastAb: string | null = null
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
        if (e.toolCount === 0) zeroCalls += 1
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
        const ab = `${e.zoneAHash}/${e.zoneBHash}`
        if (ab !== lastAb) {
          prefixVersions += 1
          lastAb = ab
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
