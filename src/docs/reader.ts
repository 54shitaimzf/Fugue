// 读取：**模型点名，宿主去读**（交接单 § 2.5）。这一份只管"读"这一件事。
//
// 一条边界把它与提示词分开：**模型说不出要读哪里，读多少由宿主定**。所以这里有三样东西只在
// 这一层成立——
//
//   · **预算**：单份开头贴多少字符 · 一页所有摘录加起来的上界。超了就不再多贴，账记在这一层。
//   · **去重**：同一趟里重复点名的路径只读一次；已经读过的那一份再来点名，走"补读行段"而不是
//     重读一遍开头。两趟与自由读共用这一条，不各写一份。
//   · **轨迹**：点名了哪些、读到哪些、缺哪些、每一份贴出来的行段。清单里的 `evidence` 就是它。
//
// 它不认识模型、不认识提示词：调用方把"模型说了什么"解析成 `ReadAsk`，把读到的摘录拿去拼
// 写作输入。`two-pass` 与 `loop` 的差别因此只在调用方怎么一轮轮地问。
import type { Truth } from '../truth/contract.ts'
import type { CommitId } from '../terms.ts'
import type { PageContent } from './contract.ts'
import { excerptAt } from './facts.ts'
import type { Excerpt } from './facts.ts'
import { EVIDENCE_MAX, EXCERPT_BUDGET, EXCERPT_LIMIT, RANGE_MAX } from './prompt.ts'

/** 一次点名：路径，可带一段行（行号从 1 起）。 */
export interface ReadAsk {
  readonly path: string
  readonly from: number | null
  readonly to: number | null
}

/** 这一趟的预算。`head` 是单份开头的上界，`total` 是一页所有摘录加起来的上界。 */
export interface ReadBudget {
  readonly head: number
  readonly total: number
  /** 一趟点名最多收几份。 */
  readonly paths: number
  /** 一趟补读最多收几段。 */
  readonly ranges: number
}

/** 两趟那一档：一份 24k 字符 · 一页 120k 字符 · 12 份 · 8 段（今天的行为）。 */
export const TWO_PASS_BUDGET: ReadBudget = {
  head: EXCERPT_LIMIT,
  total: EXCERPT_BUDGET,
  paths: EVIDENCE_MAX,
  ranges: RANGE_MAX,
}

/** 自由读那一档：一页放宽到 180k 字符，每一轮最多 6 处点名（轮数由策略管）。 */
export const LOOP_BUDGET: ReadBudget = {
  head: EXCERPT_LIMIT,
  total: 180_000,
  paths: 6,
  ranges: 6,
}

/** 一次点名读到了什么。**没读到的也要说**（清单里 `missing` 那一栏）。 */
export interface ReadTurn {
  readonly found: readonly string[]
  readonly missing: readonly string[]
  /** 这一趟之后还没读全的那几份（补读的候选）。 */
  readonly truncated: readonly Excerpt[]
}

/** 清单里的读取轨迹（`PageContent['evidence']` 的形状，`mode` 由调用方给）。 */
export interface ReadLog {
  readonly requested: readonly string[]
  readonly found: readonly string[]
  readonly missing: readonly string[]
  readonly ranges: PageContent['evidence']['ranges']
}

export interface ReadSession {
  /** 第一趟：点名要读哪几份（可带行段）。**同一趟里重复的路径只读一次**。 */
  read(asks: readonly ReadAsk[]): Promise<ReadTurn>
  /** 第二趟：对已读的那几份补读行段；没读过的路径一律不认。 */
  extend(asks: readonly ReadAsk[]): Promise<ReadTurn>
  /** 自由读：一条条自动分流——没读过的读开头，读过的带行段就补读。 */
  ask(asks: readonly ReadAsk[]): Promise<ReadTurn>
  /** 已经读到的摘录（按点名次序）。 */
  readonly excerpts: readonly Excerpt[]
  /** 读取轨迹（清单与页面都从这一份取）。 */
  readonly log: ReadLog
  /** 这一页已经贴出去多少字符（预算的账）。 */
  readonly chars: number
  /** 还读不读得动（预算没用完）。 */
  readonly room: boolean
  /** 没读全的那几份，一句话一条（调用方拼进 note）。 */
  unread(): string[]
}

export interface ReadOptions {
  readonly truth: Truth
  readonly commit: CommitId
  /** 提交 C 里真有的路径（点名不在这张表里的一律算"缺"）。 */
  readonly known: ReadonlySet<string>
  readonly budget?: ReadBudget
}

/** 一段行印成给人看的样子：`共 900 行，只贴了 1–169 · 600–760`。 */
function rangesText(x: Excerpt): string {
  const shown = x.shown.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)).join(' · ')
  return `共 ${x.lines} 行，只贴了 ${shown}`
}

export function openRead(o: ReadOptions): ReadSession {
  const budget = o.budget ?? TWO_PASS_BUDGET
  const excerpts: Excerpt[] = []
  const requested: string[] = []
  const found: string[] = []
  const missing: string[] = []
  const asked = new Set<string>()
  let chars = 0

  const room = (): number => Math.max(1, budget.total - chars)
  const truncated = (): Excerpt[] => excerpts.filter((x) => x.truncated)

  const head = async (ask: ReadAsk): Promise<Excerpt | null> =>
    excerptAt(o.truth, o.commit, ask.path, {
      limit: Math.min(budget.head, room()),
      ...(ask.from === null ? {} : { ranges: [{ from: ask.from, to: ask.to ?? ask.from + 200 }] }),
    })

  const turn = (before: number): ReadTurn => ({
    found: found.slice(before),
    missing: missing.slice(before),
    truncated: truncated(),
  })

  const readOne = async (ask: ReadAsk): Promise<void> => {
    requested.push(ask.path)
    asked.add(ask.path)
    if (!o.known.has(ask.path)) {
      missing.push(ask.path)
      return
    }
    const x = await head(ask)
    if (x === null) {
      missing.push(ask.path)
      return
    }
    chars += x.text.length
    excerpts.push(x)
    found.push(ask.path)
  }

  const extendOne = async (ask: ReadAsk): Promise<void> => {
    const at = excerpts.findIndex((x) => x.path === ask.path)
    if (at < 0) return
    const before = excerpts[at]!
    const more = await excerptAt(o.truth, o.commit, ask.path, {
      limit: Math.min(budget.head, room()),
      ranges: [{ from: ask.from ?? 1, to: ask.to ?? (ask.from ?? 1) + 200 }],
    })
    if (more === null) return
    chars += Math.max(0, more.text.length - before.text.length)
    excerpts[at] = more
  }

  const session: ReadSession = {
    async read(asks) {
      const before = found.length
      for (const ask of asks.slice(0, budget.paths)) {
        if (asked.has(ask.path)) continue // 同一趟（或前一趟）重复点名的，只算一次
        await readOne(ask)
      }
      return turn(before)
    },
    async extend(asks) {
      const before = found.length
      for (const ask of asks.slice(0, budget.ranges)) await extendOne(ask)
      return turn(before)
    },
    async ask(asks) {
      const before = found.length
      for (const ask of asks.slice(0, budget.paths)) {
        if (!asked.has(ask.path)) {
          await readOne(ask)
          continue
        }
        if (ask.from !== null) await extendOne(ask)
      }
      return turn(before)
    },
    get excerpts() {
      return excerpts
    },
    get log() {
      return { requested, found, missing, ranges: excerpts.map((x) => ({ path: x.path, lines: x.lines, chars: x.chars, shown: x.shown, truncated: x.truncated })) }
    },
    get chars() {
      return chars
    },
    get room() {
      return chars < budget.total
    },
    unread() {
      const still = truncated().map((x) => `${x.path}（${rangesText(x)}）`)
      if (still.length === 0) return []
      return [`有文件没读全：${still.join(' · ')}——正文里引用后面的内容时写明缺哪一段`]
    },
  }
  return session
}
