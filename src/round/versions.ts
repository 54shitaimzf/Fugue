// 这一轮的日志读数：**版本链取回**。一次读，几处用。出处：架构 § 15.1.a（讨论态与预备态落
// 同一条 `holder/distill` 链 · `against` 指回上一版）· § 9.4（重放口径：落下来的每一条都是当时
// 判过的）· § 9.10（保留前缀那一处）· PLAN § 5.12 的 C5.a（"同一轮的草案历史留在日志里按坐标取回"）。
//
// **纯读。** 这一份只读日志、只答问题：这一轮当下的处境是什么 · 钉住的底与意图是哪一条 · 当下
// 那一版草案/理解的正文是哪一份 · 链上第几版是什么内容。它不写、不判、不认识视图——所以预备态 ·
// 讨论态 · 放行那一趟与命令行的读数能共用同一份。
//
// **这就是 C5.a 那一条**：`roundStateOf`（`round/dispatch.ts`）· `loggedOf`（同处）·
// `lastDistillOf`（`cli/fugue.ts`）· `lastDistillDigestOf`（`round/plan.ts`）原先各读一遍全量，
// 四处读的是同一份日志上的同一条历史。这里合成一次读，四处变成它的投影。
//
// **为什么非合成不可**：分几次读出来的是**几个时刻**的快照——中间落了一条，几样就对不上了
// （预备态那一趟在写 · 讨论态那一趟也在写）。一次读出来的是一份自洽的读数。
//
// **按轮次号逐条比，不按"最后一条"选。** 同一份日志里住着好几轮：第二轮起草之后回头放行第一轮，
// "最后一条 `holder/distill`"给的是错的草案。轮级事件带轮次号（架构 § 15.1.a），就是为这一处。
//
// **只读 `round` 那一个写者**：轮级事件只有一个口（架构 § 9.2 的栅栏按 writer 分文件）。
import type { LogReader } from '../log/events.ts'
import type { WriterId } from '../terms.ts'
import type { CommitId, RoundId } from '../terms.ts'
import type { RoundState } from './machine.ts'

/** 一版落地：链上的一条 `holder/distill`。 */
export interface DistillVersion {
  /**
   * **链上第几次落地**（从 1 起）。**重落同一版也占一格**——它是日志里的事实，不是内容的编号。
   * 给人看的"第几版"用 `versionIndexOf`（那是内容的号）。
   */
  readonly at: number
  /** 这一版正文的指纹（`digestOf`：sha256 的前十六位）。**正文逐字节相同则指纹相同**。 */
  readonly digest: string
  /** **改自哪一版**：上一版正文的 `digest`。第一版没有这一栏（`null`）。 */
  readonly against: string | null
  /** 这一版的正文（逐字节就是视图里那一份）。 */
  readonly body: string
}

/** 这一轮在日志里的几样读数：**一次读出来的一份自洽快照**。 */
export interface RoundFacts {
  readonly round: RoundId
  /** `round/state` 那条链的终点。一条都没有 = 这一轮还没落地 → `Idle`。 */
  readonly state: RoundState
  /** 钉住的底（`round/intent` 那一栏）。没有就是 `null`。 */
  readonly base: CommitId | null
  /** 轮级意图那一句。没有就是空串。 */
  readonly goal: string
  /** 逐版，按落地次序（第一版在头）。**含重落同一版的那些**。 */
  readonly versions: readonly DistillVersion[]
}

/**
 * 读一次日志，答出这一轮的那几样。
 *
 * 收的是**读侧那一半**（`LogReader`：只要 `readByWriter`）——重放与读数都不写日志，所以它们在
 * 签名上就够不着 `append`（`log/events.ts` 那条纪律）。
 */
export async function roundFactsOf(log: LogReader, round: RoundId): Promise<RoundFacts> {
  let state: RoundState = 'Idle'
  let base: CommitId | null = null
  let goal = ''
  const versions: DistillVersion[] = []
  for await (const e of log.readByWriter('round' as WriterId)) {
    if (e.t === 'round/state') {
      if (e.round === round) state = e.to
      continue
    }
    if (e.t === 'round/intent') {
      if (e.round !== round) continue
      base = e.base
      goal = goalOf(e.body)
      continue
    }
    if (e.t === 'holder/distill' && e.round === round) {
      versions.push({ at: versions.length + 1, digest: e.digest, against: e.against ?? null, body: e.body })
    }
  }
  return { round, state, base, goal, versions }
}

/**
 * 意图的正文是 JSON（`startRound` 落的是 `JSON.stringify(intent)`）：读出 `goal` 那一栏。
 *
 * **读不出来当场抛，不吞**——与 `loggedOf` 原先那一处同一档：一行坏掉的正文是日志坏了，
 * 而"吞掉给空串"会让坏日志长得像"这一轮没有意图"（地板不许这么降）。
 */
function goalOf(body: string): string {
  const parsed = JSON.parse(body) as { goal?: unknown }
  return typeof parsed.goal === 'string' ? parsed.goal : ''
}

/** 最后一次落地。**它就是当下那一版**（讨论态是理解 · 预备态是草案）；一次都没落过就是 `null`。 */
export function lastOf(facts: RoundFacts): DistillVersion | null {
  return facts.versions.length === 0 ? null : (facts.versions[facts.versions.length - 1] ?? null)
}

/**
 * **第几版**（内容坐标，从 1 起）：那一份 `digest` 第一次出现的位置。
 *
 * **重落同一版不涨号。** 预备态里"只判不跑"那一趟落的是同一份正文（`digest` 相同），那种落地
 * 不该让"这是第 3 版"变成"第 4 版"——号是**内容**的号（`against` 链上"改了一版"那一步才涨号），
 * 落地次数是 `at` 那一栏。找不到就是 `null`。
 */
export function versionIndexOf(facts: RoundFacts, digest: string): number | null {
  const i = facts.versions.findIndex((v) => v.digest === digest)
  return i < 0 ? null : i + 1
}

/** 按 `digest` 取回那一版的正文（"按坐标取回"今天用的坐标：内容指纹）。找不到就是 `null`。 */
export function bodyOf(facts: RoundFacts, digest: string): string | null {
  return facts.versions.find((v) => v.digest === digest)?.body ?? null
}
