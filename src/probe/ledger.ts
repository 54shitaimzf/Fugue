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
import type { Phase } from '../model/price.ts'

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
    { name: '被拒', from: 'run/end.denied', missing: '（这一栏恒在）' },
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
  readonly ms: number
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
