// 每调用成本台账的**口径**（0.3.0 ④ · 本站的冻结面 · 路线图 § 9 的 0.3.0 行「成本台账口径：
// 一次调用怎么记账」）。
//
// **口径住这一份**：头几段回答那五个问题（一次调用记谁 · 耗时从哪来 · 钱与 token 怎么进账 ·
// `detour-rate` 的口径缺口在哪收口 · 读面挂哪），下面那几张表是**机器读得动的那一份口径**——
// 每一栏指得出源、每一个不进账的类别带理由与触发条件。实现（从日志重算）随下一个提交进来；
// 两个读者已经排队等着这一份：0.5.2 的按模型分账 · `T11` 的「值不值」提问。
//
// ── a · 一次「调用」记谁 ─────────────────────────────────────────────────────
//
// 两类进账，各记各的栏（逐栏见 `LEDGER_COLUMNS`）：
//
//   一 · **模型调用**（`llm/call`）：一次调用一行，分组键是**模型 · 线协议**。
//   二 · **起进程的工具调用**（`run/start` 与它那一条 `run/end`：`bash` · `run_action`）：
//        一次调用一行，耗时取 `run/end` 的 `ms`；分组键按同一格同一步那条 `llm/call` 补上
//        ——"这一步是哪个模型派的"只有那一处说得出来。
//
// **不进账的那几类逐条带理由与触发条件**（`EXCLUDED_CALLS`，不静默）。最要紧的一条：
// **不起进程的工具调用**（视图层那几条 + 日志层那几条）账上一条事件都没有——`run/start` 是
// "这一步要起一个进程"的凭据，而那几条不起进程。要它们进账得往事件联合里加一族新事件，而架构
// § 8.1 那张表住 `design/`（本站不动），加一族会让 `tools/check-events.js` 当红（它在快档里跑）。
// 于是这一版**如实少一份读数**，而不是伪造一种"每一次调用都记到了"的样子。
//
// ── b · 耗时从哪来 ───────────────────────────────────────────────────────────
//
// **耗时是区间读数，不是时刻**：单调钟（`performance.now()`）在那一趟的两头各取一次、相减
// （`TIME_HOW`）。模型调用那一栏是本站在事件联合上**新加**的（`llm/call.ms`——加栏不是改栏，
// 单独一提交，既有栏一个不碰）；工具调用那一栏是既有的 `run/end.ms`。**信封上不落任何时刻**：
// 要不要墙钟是 0.4.1 的前置审批件，本站不开那个题。没量到的那一档是「未量到」，不是 0。
//
// ── c · 钱与 token 怎么进账 ──────────────────────────────────────────────────
//
// **重算，不在落账时定格**（`MONEY_HOW`）：价目是外部事实（`models.json` 照抄官方），定格等于把
// 一个外部事实冻进账里，于是"同一份日志按不同价目看不出两笔账"。重算兑现的是"账面是派生体"那条
// 纪律——日志是唯一的源，账读的时候才算。价目里没有这个模型 → 算不出来（不拿 0 顶）。
//
// ── d · `detour-rate` 的口径缺口在这里收口 ───────────────────────────────────
//
// 缺口原话（归档 § 5.20）：那一支的分子只认 argv 里出现已公布工具的名字，**「清单里那条 argv
// 原样抄给 bash」那一种看不见**。收口落在**同一处判据**（`probe/metrics.ts` 的 `looksLikeDetour`）：
// 给它一串已绑定动作的命令行，`bash` 那一行的命令原文与其中一条逐字相同就计入——账上每一行于是
// 带"走法"那一栏，说出这一行命令本该走哪条路。**既有可见形态的读数不因修而变**（老那一条判据
// 一个字没动）；`detour-rate` 那一支自己照旧不传绑定，它的口径句写明这一点——改进归这本账
// （归档 § 5.20 原话："改进归 `T11` 的台账"）。
//
// ── e · 读面挂哪 ─────────────────────────────────────────────────────────────
//
// **不加新命令**：挂在既有的读命令族上（`status --ledger`，与 `--metrics` / `--report` 同一档、
// 同一份 `--json` 面）。每一行带分组键（模型 · 线协议），分组之后另有一份合计——0.5.2 的按模型
// 分账吃这一份。
//
// **它从日志重算，不采集**：同一份日志重算两次得到同一份账；改动之前的既有日志照读照重算
// （没量到的栏如实给「未量到」）。
import type { Catalog } from '../model/catalog.ts'
import type { Billable, Phase, TokenTotal } from '../model/price.ts'
import { costOf, formatUsd, matchModels } from '../model/price.ts'
import type { LogEvent } from '../log/events.ts'
import { looksLikeDetour } from './metrics.ts'

/** 一次「调用」是哪一类。**两类，没有第三类**（加一类要先动 `LEDGER_COLUMNS` 与那张不进账的表）。 */
export type LedgerKind = 'model' | 'tool'

export const LEDGER_KINDS: readonly LedgerKind[] = ['model', 'tool']

/**
 * 目录里**起进程**的那两条工具：工具那一类进账的只有它们。
 *
 * 判据不是名字而是凭据——**这一步落了 `run/start`**。而 `run/start.action` 那一栏写的名字两条不一样：
 * `bash` 那一条写 `'bash'`（`round/driver.ts` 给它拼的绑定名就是它），`run_action` 那一条写**被解析的
 * 那个动作名**（`actionFor` 的结果）。所以这一栏是"哪条路进来的"，不是"哪个工具"。
 */
export const LEDGER_SPAWNING_TOOLS: readonly string[] = ['bash', 'run_action']

/** 一栏：它叫什么 · **它的源在哪一处**（"一处真相"要能被指着问出来）· 没量到时印什么。 */
export interface LedgerColumn {
  readonly name: string
  readonly from: string
  readonly missing: string
}

/**
 * 逐栏的源。**每一栏都要指得出源**——指不出源的那一栏就是造出来的值（这一条是这张表的判据）。
 *
 * `from` 里点到的事件名必须真在 `src/log/events.ts` 的联合里（`ledger.test.ts` 拿它当断言逐条核，
 * 所以"口径写了一条联合里没有的事件"当场红）。
 */
export const LEDGER_COLUMNS: Readonly<Record<LedgerKind, readonly LedgerColumn[]>> = {
  model: [
    { name: '模型', from: 'llm/call.model', missing: '（这一栏恒在）' },
    { name: '线协议', from: 'llm/call.wire', missing: '（这一栏恒在）' },
    { name: '格', from: 'llm/call.agent', missing: '（这一栏恒在）' },
    { name: '步', from: 'llm/call.step', missing: '（这一栏恒在）' },
    { name: '耗时', from: 'llm/call.ms（0.3.0 新加的一栏；单调钟量的区间）', missing: '未量到' },
    { name: '输入', from: 'llm/call.usage.inputTokens', missing: '未量到' },
    { name: '缓存读', from: 'llm/call.usage.cacheReadTokens', missing: '未量到' },
    { name: '缓存写', from: 'llm/call.usage.cacheWriteTokens', missing: '未量到' },
    { name: '输出', from: 'llm/call.usage.outputTokens', missing: '未量到' },
    { name: '钱', from: '那一行四个 token 数 × 读的时候那份价目（重算，不落账时定格）', missing: '算不出来' },
  ],
  tool: [
    { name: '工具', from: 'run/start.action', missing: '（这一栏恒在）' },
    { name: '命令行首', from: 'run/start.argv0', missing: '（这一栏恒在）' },
    { name: '格', from: 'run/start.agent', missing: '（这一栏恒在）' },
    { name: '步', from: 'run/start.step', missing: '（这一栏恒在）' },
    { name: '耗时', from: 'run/end.ms', missing: '未量到' },
    { name: '退出码', from: 'run/end.exit', missing: '未量到' },
    { name: '被拒', from: 'run/end.denied', missing: '未量到（起了没落地的那几条没有 run/end）' },
    { name: '模型', from: '同一格同一步那条 llm/call.model（分组键）', missing: '未量到' },
    { name: '线协议', from: '同一格同一步那条 llm/call.wire（分组键）', missing: '未量到' },
    { name: '走法', from: 'argv 与已绑定动作的命令行比一次（probe/metrics.ts 的 looksLikeDetour）', missing: '（这一栏恒在）' },
  ],
}

/** 不进账的一类调用：**理由与"什么条件下改主意"都要写出来**——少记一笔就是少一份读数。 */
export interface ExcludedCall {
  readonly calls: string
  readonly why: string
  readonly when: string
}

/**
 * 不进账的那几类。**一条都不许静默**：读账的人要能一眼看出"这本账里没有哪一类调用"。
 *
 * 排在最前的那一条是这一版最要紧的一处**如实留白**（视图层那几张脸一次都记不到）。
 */
export const EXCLUDED_CALLS: readonly ExcludedCall[] = [
  {
    calls:
      '不起进程的工具调用：`read` · `write` · `edit` · `read_image` · `glob` · `grep` · `checkpoint` · `todo_write` · `ask_user_question` · `exit_plan_mode`',
    why:
      '账上一条事件都没有——`run/start` 是"这一步要起一个进程"的凭据，而那几条不起进程（视图层与日志层都不落那一对事件）。要它们进账得往事件联合里加一族新事件，而架构 § 8.1 那张表住 `design/`（本站不动），加一族会让 `tools/check-events.js` 当红（它在快档里跑）。',
    when: '哪天要量视图层那几条的耗时：先动架构 § 8.1 与目录那一档（事件联合加一族走人审），再进站。',
  },
  {
    calls: '`mat/fork` · `mat/sync`（物化那一趟）',
    why: '它们不是"调用"，是内核内部的一步；它们带着 `ms`，而那一个是 `ensure-latency` 的源——同一件事不记两遍。',
    when: '要按"物化花了多少"分账时，那时它是一栏读数，不是一次调用。',
  },
  {
    calls: '`prefix/assemble`',
    why: '纯函数拼前缀，没有耗时可言（它落事件是为了三区指纹，不是为了计时）。',
    when: '拼前缀变成要花钱的操作时。',
  },
  {
    calls: '`view/*` · `ckpt/commit`',
    why: '账上的一次变更 · 一次提交，不是一次调用（它们的次数在 `git-calls-per-round` 那一支里）。',
    when: '要按「一次提交花了多少」分账时：那时它是账上的一栏读数，不是一类调用。',
  },
]

/** 钱的进账口径（`c` 那一问的答案）。**一句话，两处读**：这一份与台账那一行。 */
export const MONEY_HOW =
  '钱在**读的时候重算**：那一行的四个 token 数 × 读的时候那份价目（`models.json`）。' +
  '落账时定格会把一个外部事实（价目）冻进账里，于是同一份日志按不同价目看不出两笔账；' +
  '重算让"账面是派生体"这条纪律在钱这一栏上也成立。价目里没有这个模型 → 算不出来，不拿 0 顶。'

/** 耗时的进账口径（`b` 那一问的答案）。 */
export const TIME_HOW =
  '耗时是**区间读数**：单调钟（`performance.now()`）在那一趟的两头各取一次、相减。' +
  '信封上不落任何时刻（要不要墙钟是 0.4.1 的前置审批件）——账上读得到"花了多久"，读不到"什么时候"。' +
  '没量到 → 未量到，不拿 0 顶。'

/** 四个 token 数（与 `llm/call.usage` 那四样同一个口径：**没量到是 `null`**）。 */
export interface LedgerTokens {
  readonly input: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly output: number | null
}

/** 工具那一类多出来的那几栏。 */
export interface LedgerTool {
  readonly name: string
  readonly argv0: string
  readonly exit: number | null
  readonly denied: boolean | null
  /** 这一行命令是不是**本该走某个已绑定动作**（`detour-rate` 那个缺口点名的形态也在这一栏里计入）。 */
  readonly detour: boolean
}

/** 一行账。`kind` 决定哪几栏有话说（表在 `LEDGER_COLUMNS`）。 */
export interface LedgerCall {
  readonly kind: LedgerKind
  readonly agent: string
  readonly step: string
  readonly model: string | null
  readonly wire: string | null
  readonly ms: number | null
  readonly tokens: LedgerTokens | null
  readonly usd: number | null
  readonly tool: LedgerTool | null
}

/** 按分组键（模型 · 线协议）合计的那一份——**0.5.2 的按模型分账就吃它**。 */
export interface LedgerGroup {
  readonly model: string | null
  readonly wire: string | null
  readonly calls: number
  readonly toolCalls: number
  /** 这一组里所有调用（模型 + 工具）量到的耗时之和；**一条都没量到就是 `null`**（不拿 0 顶）。 */
  readonly ms: number | null
  readonly msMissing: number
  readonly tokens: LedgerTokens
  readonly tokensMissing: number
  readonly usd: number | null
  /** 这一组里有几条算不出钱（模型不在价目里 · 或没给峰谷档）。 */
  readonly usdMissing: number
}

/** 一本账。**它是派生体**：读一份日志算一次，不落盘、不缓存。 */
export interface Ledger {
  readonly calls: readonly LedgerCall[]
  readonly groups: readonly LedgerGroup[]
  /** 读了几条事件（"从日志重算"那句话的凭据）。 */
  readonly events: number
  /** `llm/call` 里带着 `ms` 的条数 · 没带的条数（**旧账那一档就是这个数，不静默**）。 */
  readonly msSeen: number
  readonly msMissing: number
  /**
   * 读账的人递进来几条**已绑定动作的命令行**（账上「走法」那一栏的第二半用它）。
   *
   * `0` 说的是这一趟读账只认「命令里提到工具名」那一半——**少一份读数要说出来**，不静默。
   */
  readonly boundCommands: number
}

/** 读账的时候由读的人递进来的那几样（与钱那一栏的峰谷档同一个形状：账上没有，只有读的人知道）。 */
export interface LedgerInputs {
  /** 价目与模型目录（P2d：**必给**——不给就会按内置算，而文件档在场时那是另一份价目）。 */
  readonly cat: Catalog
  /** 峰时还是谷时（官方价目分两档；不给就不印钱那一栏，与 `status --once` 同一口径）。 */
  readonly phase?: Phase
  /**
   * **这一台机器上已绑定动作的命令行**（`boundary/binding.ts` 的 `readBinding` 那一处解析）。
   *
   * 它是 `d` 那一问的输入：缺口点名的形态是"把清单里那条 argv 原样抄给 bash"，而"清单里那条
   * argv 是什么"只有读账的人手里那份配置说得出来（日志里没有它）。**不给就是没有这一栏读数**
   * （老行为，不是坏掉）。
   */
  readonly bindings?: readonly (readonly string[])[]
}

/** 账那一块的表头（`status --ledger` 印它）。 */
export const LEDGER_HEAD = '每调用成本台账（从日志重算，不采集）：'

// ── 从日志重算：读面那一侧的唯一一处折法 ──────────────────────────────────────

/**
 * 读账那一侧递进来的行：`probe/status.ts` 的 `StatusRow` 与 `probe/metrics.ts` 的 `MergedRow`
 * 都满足它（只要带着事件本身那一栏）——**两条读路共用这一处折法**，不各折一份。
 */
export interface LedgerRow {
  readonly e: LogEvent
}

/** 一个数：量到的那些加起来；**一条都没量到就是 `null`**（不拿 0 顶）。 */
function sumOrNull(vals: readonly (number | null)[]): number | null {
  const seen = vals.filter((v): v is number => typeof v === 'number')
  return seen.length === 0 ? null : seen.reduce((a, b) => a + b, 0)
}

/** 那一行四个 token 数 × 读的时候那份价目。**没给峰谷档就不算钱**（与 `status --once` 同一口径）。 */
function usdOf(model: string, tokens: LedgerTokens, inputs: LedgerInputs): number | null {
  if (inputs.phase === undefined) return null
  const one = (v: number | null): TokenTotal => ({ total: v ?? 0, missing: v === null ? 1 : 0 })
  const b: Billable = {
    calls: 1,
    inputTokens: one(tokens.input),
    cacheReadTokens: one(tokens.cacheRead),
    cacheWriteTokens: one(tokens.cacheWrite),
    outputTokens: one(tokens.output),
  }
  return costOf(b, matchModels([model], inputs.cat).row, inputs.phase).usd
}

/** 分组键（模型 · 线协议）。**没量到的那一档自己一组**——`null` 与一个名字不许并成一组。 */
function groupKeyOf(model: string | null, wire: string | null): string {
  return `${model ?? '未量到'}\u0000${wire ?? '未量到'}`
}

/** 用量那四个数进账那一栏（`reasoningTokens` 不在钱里：它在 `outputTokens` 里面）。 */
function tokensOf(u: {
  readonly inputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly outputTokens: number | null
}): LedgerTokens {
  return { input: u.inputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens, output: u.outputTokens }
}

/**
 * **从一串事件重算一本账。** 纯函数：同一串行算两次得到同一本账；它不读文件、不碰时钟、不缓存。
 *
 * 两条调用各走各的路：
 *   · `llm/call` 一条一行（模型那一类）；同一格同一步的那一条同时进 `at` 那张表，给工具那一类当分组键。
 *   · `run/start` 进队、`run/end` 出队配成一次工具调用——**一个键一队**（同一步可以起两次）。
 *     起了没落地的那几条（日志从半截起读 · 那一趟没收尾）**照样进账**：耗时与退出码是「未量到」，
 *     而少记一笔就是少一份读数。
 */
export function ledgerOf(rows: readonly LedgerRow[], inputs: LedgerInputs): Ledger {
  const calls: LedgerCall[] = []
  /** 同一格同一步那条 `llm/call`（工具那一类的分组键）。**后写的那条盖前一条**。 */
  const at = new Map<string, { readonly model: string; readonly wire: string }>()
  /** 起了还没落地的 `run/start`：**一个键一队**。 */
  const open = new Map<string, { readonly action: string; readonly argv0: string; readonly argv: readonly string[] }[]>()
  const bound = inputs.bindings ?? []

  /** 一条工具调用：分组键从 `at` 那张表补（补不到就是「未量到」）。 */
  const toolOf = (
    agent: string,
    step: string,
    one: { readonly action: string; readonly argv0: string; readonly argv: readonly string[] } | undefined,
    end: { readonly ms: number; readonly exit: number; readonly denied: boolean } | null,
  ): LedgerCall => {
    const g = at.get(`${agent}\u0000${step}`)
    return {
      kind: 'tool',
      agent,
      step,
      model: g?.model ?? null,
      wire: g?.wire ?? null,
      ms: end === null ? null : end.ms,
      tokens: null,
      usd: null,
      tool: {
        name: one?.action ?? '（没等到 run/start 的那一条）',
        argv0: one?.argv0 ?? '',
        exit: end === null ? null : end.exit,
        denied: end === null ? null : end.denied,
        detour: looksLikeDetour(one?.argv ?? [], bound),
      },
    }
  }

  for (const { e } of rows) {
    if (e.t === 'llm/call') {
      const tokens = tokensOf(e.usage)
      at.set(`${e.agent}\u0000${e.step}`, { model: e.model, wire: e.wire })
      calls.push({
        kind: 'model',
        agent: e.agent,
        step: e.step,
        model: e.model,
        wire: e.wire,
        // **没量到就不是 0**：旧日志没有这一栏（0.3.0 之前的账）。
        ms: typeof e.ms === 'number' ? e.ms : null,
        tokens,
        usd: usdOf(e.model, tokens, inputs),
        tool: null,
      })
      continue
    }
    if (e.t === 'run/start') {
      const k = `${e.agent}\u0000${e.step}`
      const one = { action: e.action, argv0: e.argv0, argv: e.argv ?? [e.argv0] }
      const q = open.get(k)
      if (q === undefined) open.set(k, [one])
      else q.push(one)
      continue
    }
    if (e.t === 'run/end') {
      const k = `${e.agent}\u0000${e.step}`
      const q = open.get(k)
      const one = q?.shift()
      calls.push(toolOf(e.agent, e.step, one, { ms: e.ms, exit: e.exit, denied: e.denied }))
    }
  }
  // 起了没落地的那几条：**照样进账**（日志从半截起读那一档就是这样）。
  for (const [k, q] of open) {
    const parts = k.split('\u0000')
    const agent = parts[0] ?? ''
    const step = parts[1] ?? ''
    for (const one of q) calls.push(toolOf(agent, step, one, null))
  }

  // 分组那一份：按分组键排序（**结果与事件次序无关**：同一份账重算两次逐字相同）。
  const keyed = calls.map((c) => ({ k: groupKeyOf(c.model, c.wire), c }))
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
  const groups: LedgerGroup[] = []
  for (let i = 0; i < keyed.length; ) {
    const k = keyed[i]?.k ?? ''
    const list: LedgerCall[] = []
    while (i < keyed.length && keyed[i]?.k === k) {
      const one = keyed[i]?.c
      if (one !== undefined) list.push(one)
      i += 1
    }
    const models = list.filter((x) => x.kind === 'model')
    const tok = (pick: (t: LedgerTokens) => number | null): number | null =>
      sumOrNull(models.map((x) => (x.tokens === null ? null : pick(x.tokens))))
    groups.push({
      model: list[0]?.model ?? null,
      wire: list[0]?.wire ?? null,
      calls: models.length,
      toolCalls: list.length - models.length,
      ms: sumOrNull(list.map((x) => x.ms)),
      msMissing: list.filter((x) => x.ms === null).length,
      tokens: {
        input: tok((t) => t.input),
        cacheRead: tok((t) => t.cacheRead),
        cacheWrite: tok((t) => t.cacheWrite),
        output: tok((t) => t.output),
      },
      tokensMissing: models.filter(
        (x) =>
          x.tokens === null ||
          x.tokens.input === null ||
          x.tokens.cacheRead === null ||
          x.tokens.cacheWrite === null ||
          x.tokens.output === null,
      ).length,
      usd: sumOrNull(list.map((x) => x.usd)),
      // **工具那几条不算「算不出来」**：它们本来就不进钱那一栏（不是少给了价目）。
      usdMissing: models.filter((x) => x.usd === null).length,
    })
  }

  const modelCalls = calls.filter((c) => c.kind === 'model')
  return {
    calls,
    groups,
    events: rows.length,
    msSeen: modelCalls.filter((c) => c.ms !== null).length,
    msMissing: modelCalls.filter((c) => c.ms === null).length,
    boundCommands: bound.length,
  }
}

/** 一个数的人读写法：**没量到就写「未量到」**，不拿 0 顶。 */
function numText(v: number | null, unit: string): string {
  return v === null ? `未量到${unit}` : `${v}${unit}`
}

/**
 * 账那一块的人读几行（**不含表头**：表头是 `LEDGER_HEAD`，与打回读数 · 八元指标同一处取值处）。
 *
 * 文字面印**分组**那一份（模型 · 线协议 → 调用 · 耗时 · 钱 · 四个 token 数），逐条那一份在 `--json`
 * 里（`Ledger.calls`）：一份账几万条调用时逐条印满屏，等于把「这一轮花了多少」这件事淹掉。**这里不
 * 截断也不静默**——一条都不少印的是合计与分组，而「逐条在哪」写在下面那一行里。
 */
export function ledgerLines(l: Ledger): readonly string[] {
  const out: string[] = []
  const models = l.calls.filter((c) => c.kind === 'model').length
  const tools = l.calls.length - models
  const ms = sumOrNull(l.calls.map((c) => c.ms))
  const msMissing = l.calls.filter((c) => c.ms === null).length
  const usd = sumOrNull(l.calls.map((c) => c.usd))
  const usdMissing = l.calls.filter((c) => c.kind === 'model' && c.usd === null).length
  const tok = (v: number | null): string => (v === null ? '未量到' : String(v))
  out.push(
    `合计 模型调用 ${models} 次 · 起进程 ${tools} 次 · 耗时 ${numText(ms, ' ms')}（未量到 ${msMissing} 条）` +
      ` · 钱 ${usd === null ? '算不出来（没有一条能算）' : formatUsd(usd)}` +
      `${usdMissing === 0 ? '' : `（${usdMissing} 条算不出来）`}`,
  )
  for (const g of l.groups) {
    out.push(
      `模型 ${g.model ?? '未量到'} · 线 ${g.wire ?? '未量到'} · 模型调用 ${g.calls} 次 · 起进程 ${g.toolCalls} 次` +
        ` · 耗时 ${numText(g.ms, ' ms')}${g.msMissing === 0 ? '' : `（未量到 ${g.msMissing} 条）`}` +
        ` · 钱 ${g.usd === null ? '算不出来' : formatUsd(g.usd)}${g.usdMissing === 0 ? '' : `（${g.usdMissing} 条算不出来）`}` +
        ` · input ${tok(g.tokens.input)} · cacheRead ${tok(g.tokens.cacheRead)}` +
        ` · cacheWrite ${tok(g.tokens.cacheWrite)} · output ${tok(g.tokens.output)}` +
        `${g.tokensMissing === 0 ? '' : `（缺 ${g.tokensMissing} 条）`}`,
    )
  }
  out.push(`读了 ${l.events} 条事件 · 逐条那一份在 --json 里（${l.calls.length} 条）——这一本账是读的时候从日志重算的，不落盘、不缓存`)
  if (l.msMissing > 0) {
    out.push(
      `耗时那一栏有 ${l.msMissing} 条模型调用没量到（0.3.0 之前的日志没有 llm/call.ms 那一栏——回放照旧，不去猜它）`,
    )
  }
  if (l.boundCommands === 0) {
    out.push('走法那一栏只用了「命令里提到工具名」那一半：这一趟读账没拿到已绑定动作的命令行')
  }
  out.push(`不进账的：${EXCLUDED_CALLS.map((x) => x.calls).join('；')}——理由与改主意的条件写在 probe/ledger.ts`)
  return out
}
