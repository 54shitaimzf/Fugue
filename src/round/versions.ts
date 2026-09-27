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
import type { Draft, DraftSection } from '../contract/draft.ts'
import { DraftError, draftOf } from '../contract/draft.ts'
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
  /**
   * **改自哪一版**：**上一趟落地**那一版的正文 `digest`。第一版没有这一栏（`null`）。
   *
   * **它是「上一条落地」，不是「上一个不同的内容」。** 重落那一趟这个数就是它自己
   * （`against === digest`）——链上因此看得见「又落了一遍同一版」（架构 § 15.1.a 的 `against` 栏）。
   * 于是整条链由**落地次序**给出：第 i 条的 `against` 就是第 i-1 条那一版的指纹，按它一步步
   * 往回走、每一步都用 `bodyOf` 取回正文，就走回了第一版（C5.a 的「按坐标取回」走的就是它）。
   */
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
 * 这一轮**当下那一版**的人面读数（链尾那一版：讨论态是理解 · 预备态是草案）。一次都没落过就是
 * `null`。
 *
 * **一次读 → 一张读数 → 两个渲染器**：人面印的那几行（`cli/fugue.ts` 的 `versionLinesOf`）与
 * 机器面那几栏（`--json`）都从这一张出来——PLAN § 5.12 的 C5.b 那一句「与 `--json` 那两栏同源」
 * 落的就是它：两个渲染器不会各算各的（口径只有一处：`versionFaceOf`）。
 */
export function latestFaceOf(facts: RoundFacts): VersionFace | null {
  const v = lastOf(facts)
  return v === null ? null : versionFaceOf(facts, v)
}

/**
 * **第几版**（**内容坐标**，从 1 起）：链上第几个**不同的内容**——那一份 `digest` 第一次出现
 * 时，它前面已经有过几个不同的 `digest`，加一。
 *
 * **重落同一版不涨号。** 预备态里"只判不跑"那一趟落的是同一份正文（`digest` 相同），那种落地
 * 不该让"这是第 3 版"变成"第 4 版"——号是**内容**的号（`against` 链上"改了一版"那一步才涨号），
 * 落地次数是 `at` 那一栏。
 *
 * **不是"第几次落地"**：数落地序号的话，只要有一趟重落，后面的号就全部虚高（链上
 * `v1 · v2 · v2 · v3` 的第四格该是第 3 版，而落地序号给的是 4）——C5.b 那条断言量的就是它。
 * 找不到就是 `null`。
 */
export function versionIndexOf(facts: RoundFacts, digest: string): number | null {
  const seen: string[] = []
  for (const v of facts.versions) {
    if (!seen.includes(v.digest)) seen.push(v.digest)
    if (v.digest === digest) return seen.length
  }
  return null
}

/** 按 `digest` 取回那一版的正文（"按坐标取回"今天用的坐标：内容指纹）。找不到就是 `null`。 */
export function bodyOf(facts: RoundFacts, digest: string): string | null {
  return facts.versions.find((v) => v.digest === digest)?.body ?? null
}

/** 一版的人面读数：**第几版 · 第几次落地 · 与上一版差在哪几节**（PLAN § 5.12 的 C5.b）。 */
export interface VersionFace {
  /** 这一版是**第几版**（内容坐标，从 1 起；重落同一版不涨号）。 */
  readonly version: number
  /** 这一轮里**第几次落地**（`DistillVersion.at`：重落也占一格）。 */
  readonly landing: number
  /** 与上一趟落的那一版**逐字节相同**（"只判不跑"那一趟会遇到）。 */
  readonly same: boolean
  /** 逐节与开头那段散文的差异，一行一句。`same` 为真、或印不出差异时是空的。 */
  readonly lines: readonly string[]
  /** 印不出逐节差异的原因（这一版读不成一份草案）；能印就是 `null`。 */
  readonly why: string | null
}

/**
 * 一版的人面读数。
 *
 * **比的是"上一个内容版本"，不是"上一次落地"**：同一份内容重落过几趟，上一版仍旧是那一个
 * 不同的内容——否则"改了一版"与"又落了一遍"会混成同一格（架构 § 15.1.a 的 `against` 那一栏
 * 记的正是这个区别）。
 *
 * 逐节那一半走 `draftOf`：**讨论态那一趟落的是话**（凝聚理解），它不是草案——那时 `why` 说得
 * 出来原因，`lines` 是空的。
 */
export function versionFaceOf(facts: RoundFacts, v: DistillVersion): VersionFace {
  const version = versionIndexOf(facts, v.digest) ?? v.at
  const prev = v.at === 1 ? null : (facts.versions[v.at - 2] ?? null)
  const same = prev !== null && prev.digest === v.digest
  const head = { version, landing: v.at, same }
  if (same) return { ...head, lines: [], why: null }
  const lines = sectionDiffOf(previousBodyOf(facts, version), v.body)
  return lines === null
    ? { ...head, lines: [], why: '这一版不是一份草案（读不成逐节）：没有逐节差异可印' }
    : { ...head, lines, why: null }
}

/** 上一个内容版本（第 `version - 1` 版）的正文：链上第一次落到那一份内容的那一条。 */
function previousBodyOf(facts: RoundFacts, version: number): string | null {
  if (version <= 1) return null
  return facts.versions.find((x) => versionIndexOf(facts, x.digest) === version - 1)?.body ?? null
}

/** 逐节要比的那几栏（`DraftSection` 的那八栏；少一栏就是漏比一栏）。 */
const SECTION_FIELDS: readonly (keyof DraftSection)[] = [
  'kind',
  'goal',
  'ownedPaths',
  'deliverables',
  'assertions',
  'question',
  'evidenceRequired',
  'seed',
]

/**
 * 两版之间的逐节差异（**纯函数**：不认识日志、不认识视图）。`null` = 有一版读不成一份草案
 * （讨论态那一段话 · 空串）——**不猜**：读不成就不印差异，而不是给一行空差异。
 *
 * 对齐靠**节序**（第 n 节对第 n 节）：草案的节序就是身份与分支的次序（`contract/draft.ts`），
 * 所以"第几节"在两版之间是同一个东西。一行一句：
 *   `+ 第 n 节：<goal>`（多出来的）· `- 第 n 节：<goal>`（少掉的）· `~ 第 n 节：<哪几栏> 变了`。
 */
export function sectionDiffOf(before: string | null, after: string): readonly string[] | null {
  const b = asDraft(after)
  if (b === null) return null
  if (before === null) return b.sections.map((s, i) => `+ 第 ${i + 1} 节：${s.goal}`)
  const a = asDraft(before)
  if (a === null) return null
  const lines: string[] = []
  if (a.prose !== b.prose) lines.push('~ 开头那段（为什么这么拆）变了')
  const n = Math.max(a.sections.length, b.sections.length)
  for (let i = 0; i < n; i++) {
    const x = a.sections[i]
    const y = b.sections[i]
    if (x === undefined) {
      lines.push(`+ 第 ${i + 1} 节：${y?.goal ?? ''}`)
      continue
    }
    if (y === undefined) {
      lines.push(`- 第 ${i + 1} 节：${x.goal}`)
      continue
    }
    const fields = SECTION_FIELDS.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]))
    if (fields.length > 0) lines.push(`~ 第 ${i + 1} 节：${fields.join(' · ')} 变了`)
  }
  return lines
}

/** 读成一份草案；读不成是 `null`（**只吞 `DraftError`**：别的错照旧抛——那是真的坏了）。 */
function asDraft(text: string): Draft | null {
  try {
    return draftOf(text)
  } catch (err) {
    if (err instanceof DraftError) return null
    throw err
  }
}
