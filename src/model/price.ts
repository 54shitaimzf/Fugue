/**
 * 钱那一栏：**官方价目表 + 一个纯函数**。
 *
 * 出处：架构 § 8.15（用量四个数是"钱"那一侧的读数）· 架构 § 10.3（两条线各自的价目来自同一张官方
 * 表）· PLAN § 5.12 序 25。价目照官方那一页（Models & Pricing）原样抄：**三个档 × 两个时段**，
 * 单位是**美元 / 每 100 万 token**——不做货币换算，"换出来的那个数"说的是我在哪儿换的钱，不是
 * 上游收了我多少钱。
 *
 * **三件事分开**：价目（`PRICE_BOOK` 那张表）· 档（`phaseOf`：官方那两个窗口 + 一个节假日参数）·
 * 算（`costOf`：只吃几个数）。所以换价 · 加模型 · 接节假日各是加一行或换一个参数，碰不到算的那一处。
 *
 * **钱只从 `USAGE_COUNTS` 那四样算。** 思考 token 是输出里的明细（`reasoningTokens`），它已经在
 * `outputTokens` 里了，再加一遍就是把同一笔钱算两回。
 */
import { MODEL_DECLS } from './contract.ts'

/** 三档价（**美元 / 每 100 万 token**）。官方那一页上就这三行。 */
export interface Rates {
  /** 输入里**没命中**缓存的那一部分。 */
  readonly cacheMiss: number
  /** 输入里**命中**缓存的那一部分（官方页：比未命中便宜 50 倍）。 */
  readonly cacheHit: number
  /** 输出那一个数（**思考与答案合在同一个数里**）。 */
  readonly output: number
}

/** 峰时还是谷时。官方页那一句：谷时一律是峰时的一半。 */
export type Phase = 'peak' | 'off-peak'

/** 价目表的一行：一个模型 × 两档。 */
export interface PriceRow {
  /** 官方定价页上那个名字。 */
  readonly model: string
  /**
   * 上游仍然接受、**按本行计价**的别的名字（官方页：旧名路由到同一个模型，价也照这一个算）。
   *
   * 这一栏只放**上游那边的名字**：账上写的是我们自己的键（`deepseek-chat/openai` 一类），那一头
   * 由 `wireNameOf` 折回发出去的名字——两边的名字不混在一张表里。
   */
  readonly aliases: readonly string[]
  readonly peak: Rates
  readonly offPeak: Rates
}

/**
 * 官方定价页（2026-09-10 那一版）上的价目。**改价的落地处就这一处。**
 *
 * `deepseek-chat` 与 `deepseek-reasoner` 是**我们自己发出去的名字**：官方页上已经没有它们
 * （2026-07-24 停用），而真档里它们照旧回来 `deepseek-flash`——那一趟就该按 Flash 那一栏算，所以
 * 它们在这张表里。**名字与价对不对得上，回执那一行把名字印出来给人核。**
 */
export const PRICE_BOOK: readonly PriceRow[] = [
  {
    model: 'deepseek-flash',
    aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner'],
    peak: { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 },
    offPeak: { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 },
  },
  {
    model: 'deepseek-v4-pro',
    aliases: [],
    peak: { cacheMiss: 1.32, cacheHit: 0.044, output: 3.96 },
    offPeak: { cacheMiss: 0.66, cacheHit: 0.022, output: 1.98 },
  },
]

/** 账上那个键（`ModelId`）→ 发出去的名字。不是账上的键就**当它是名字本身**（价目表按名字查）。 */
function wireNameOf(name: string): string {
  const d = MODEL_DECLS[name]
  return d === undefined ? name : d.model
}

/** 一个名字 → 一份价目行。**查不到是 `null`，不替它挑一行**——"没有价目"不是"免费的"。 */
export function priceOf(name: string | null, book: readonly PriceRow[] = PRICE_BOOK): PriceRow | null {
  if (name === null || name === '') return null
  const wire = wireNameOf(name)
  return book.find((r) => r.model === wire || r.aliases.includes(wire)) ?? null
}

/**
 * 官方那一页的峰谷窗：**周一至周五 01:00–04:00 与 06:00–10:00（UTC）是峰时**，其余时间谷时
 * （周末整天谷时）。中国法定节假日整天按谷时。
 *
 * **节假日那一栏故意留在参数上**：它是会变的一份数据，官方价目页也没给接口，写死在代码里就是一处
 * 会漂的真相。缺省是"一个节假日都不知道"——那一天会按峰时算，所以**回执那一行把档印出来**（算错
 * 档看得见）。改主意：真按节假日算的日子到了，把那一串 `YYYY-MM-DD` 递进来，接口已经在了。
 */
export function phaseOf(at: Date, holidays: readonly string[] = []): Phase {
  const dow = at.getUTCDay()
  if (dow === 0 || dow === 6) return 'off-peak'
  if (holidays.includes(at.toISOString().slice(0, 10))) return 'off-peak'
  const h = at.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 'peak' : 'off-peak'
}

/** 一份价目行在一个档上的三档价。 */
export function ratesOf(row: PriceRow, phase: Phase): Rates {
  return phase === 'peak' ? row.peak : row.offPeak
}

/** 汇总出来的一个数：**量到的和 + 没量到的条数**（与 `probe/status.ts` 的 `UsageTotal` 同形状）。 */
export interface TokenTotal {
  readonly total: number
  readonly missing: number
}

/** 计价吃进去的那几样。**这里没有 `reasoningTokens`**——它在 `outputTokens` 里面。 */
export interface Billable {
  readonly calls: number
  readonly inputTokens: TokenTotal
  readonly cacheReadTokens: TokenTotal
  readonly cacheWriteTokens: TokenTotal
  readonly outputTokens: TokenTotal
}

/** 一笔钱。`usd` 是 `null` = **没有价目**（不是 0 元）。 */
export interface Money {
  readonly usd: number | null
  /** 有几条没量到：**这一笔是下界**，回执那一行要说出来。 */
  readonly missing: number
}

/**
 * 一笔钱的算法，一处。
 *
 * **写进缓存的那一部分按未命中价算**：官方那张表上只有"命中"与"未命中"两栏，而"命中"说的是读到了，
 * 写入不是读；把它丢掉就是**少报钱**。这条线上它一直是 0（隐式缓存没有写入那一档），所以今天
 * 这一步不动读数。
 */
export function costOf(b: Billable, row: PriceRow | null, phase: Phase): Money {
  const missing =
    b.inputTokens.missing + b.cacheReadTokens.missing + b.cacheWriteTokens.missing + b.outputTokens.missing
  if (row === null) return { usd: null, missing }
  const r = ratesOf(row, phase)
  const usd =
    ((b.inputTokens.total + b.cacheWriteTokens.total) * r.cacheMiss +
      b.cacheReadTokens.total * r.cacheHit +
      b.outputTokens.total * r.output) /
    1_000_000
  return { usd, missing }
}

/** 名字与价目表对不上时的三种由头。**三种分开报**：少了名字、两种价混在一趟、账上还没有调用。 */
export type PriceMiss = 'empty' | 'unknown' | 'mixed'

export interface PriceMatch {
  readonly row: PriceRow | null
  readonly miss: PriceMiss | null
}

/**
 * 一趟里用到的几个名字 → **一份**价目行。
 *
 * 三种情形都不给行：一个名字都没有（账上还没有调用）· 有一个名字不在表里 · 几个名字指向**两行不同
 * 的价**（那一趟的钱要按模型分开算，这里不合成一个数）。
 */
export function matchModels(models: readonly string[], book: readonly PriceRow[] = PRICE_BOOK): PriceMatch {
  if (models.length === 0) return { row: null, miss: 'empty' }
  const rows = new Set<PriceRow>()
  for (const m of models) {
    const r = priceOf(m, book)
    if (r === null) return { row: null, miss: 'unknown' }
    rows.add(r)
  }
  return rows.size === 1 ? { row: [...rows][0] as PriceRow, miss: null } : { row: null, miss: 'mixed' }
}

/** 钱的写法：**小到百万分之一美元也看得出差别**（这一档的读数常在千分之一美分上）。 */
export function formatUsd(x: number): string {
  return `$${x.toFixed(6)}`
}

/** 钱那一行的材料。 */
export interface MoneyReading {
  readonly money: Money
  readonly match: PriceMatch
  readonly phase: Phase
  readonly models: readonly string[]
}

/**
 * 钱那一行的人读写法。**价与档都印在同一行里**：这个数是怎么来的要在一行里答得出。而"没有价目"
 * 与"0 元"必须分得开（与用量那一栏同一条规矩：不拿 0 顶）。
 */
export function moneyText(o: MoneyReading): string {
  const names = o.models.length === 0 ? '一次调用都还没有' : o.models.join(' · ')
  if (o.match.row === null) {
    const why =
      o.match.miss === 'empty'
        ? '账上还没有一次调用'
        : o.match.miss === 'mixed'
          ? '这一趟用了两种价，钱要按模型分开算'
          : '账上用的名字不在价目表里'
    return `费用 算不出来：${why}（${names}）——不拿 0 顶`
  }
  const row = o.match.row
  if (o.money.usd === null) return `费用 算不出来：${row.model} 没有价目——不拿 0 顶`
  const r = ratesOf(row, o.phase)
  const bound = o.money.missing === 0 ? '' : `（有 ${o.money.missing} 条没量到，这一笔是下界）`
  // 账上那个名字也印出来（`A → B`）：名字与价对不上时（旧名路由到另一个模型）看得见。
  return (
    `费用 ≈ ${formatUsd(o.money.usd)}（${o.phase === 'peak' ? '峰时' : '谷时'} · ${names} → ${row.model}：` +
    `未命中 $${r.cacheMiss}/M · 命中 $${r.cacheHit}/M · 输出 $${r.output}/M）${bound}`
  )
}
