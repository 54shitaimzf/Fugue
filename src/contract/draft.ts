// 草案：持轮者写下的那一份文本 → 逐节的拆分。出处：架构 § 15.1.a 四步里的"拆"与"判" ·
// 架构 § 8.12（"构造器不猜、不补、不尽力解释"）· PLAN § 5.10 的 `C1`/`C2` 两行。
//
// **一份草案 = 一个任务一节，键就是契约的键。** 一节写在一个围栏块里（标 `json`），块外是模型
// 自己的话——"为什么这么拆"那一句由它写（§ 15.1.a），别处没有第二份来源，所以这一份把它原样
// 留着（`prose`），一个字都不解析。于是产物有两栏：逐节的值（给构造器）与那段散文（给门）。
//
// **它只读形态，值域不在这一份。** 哪一节该有哪几个键归这里；"路径合不合法 · 断言零条 ·
// `seed` 超限 · `actionOutputs ⊆ ownedPaths` · 断言的动作有没有绑上"归构造器（`build.ts` 调的
// `checkContract`，架构 § 8.12 的第二·三级）。分两处的理由：形态错是"没按形状交"，值域错是
// "这一批活干不成"——两句话退回给不同的东西改（前者退回重写草案，后者退回改方案）。
//
// **系统的键一个都不许给。** `id` 由构造器发 · `agent`/`branch` 由身份分配器发 ·
// `actionOutputs` 由动作绑定给（架构 § 8.12 那张值域持有者表）。草案给了就报出来，不静默丢掉：
// 静默丢掉的后果是"模型以为身份是它定的"这件事没有任何人知道。
//
// **顺序是承重的。** 草案里那一节的次序就是契约发身份 · 起分支 · 铺物化的次序（`build()` 与
// A4 读的是同一个序），所以最多一节调查型，且它必须排在第一节——`build()` 正是先造调查型、
// 再逐份造实现型。报出来，不替它重排：重排等于把"哪一节对应哪条分支"这件事替人定了。
import type { RelPath } from '../terms.ts'
import { isSegment } from '../roots/paths.ts'
import type { SplitAssignment } from './build.ts'
import type { Assertion, Deliverable } from './types.ts'
import { EVIDENCE_PREFIX, FIELD_RULES, VARIANT_FIELDS } from './types.ts'

/**
 * 草案认得的两节。**没有 `resolve`**：解决型契约由 `M13` 的冲突报告给，而冲突是折到那一步
 * 才知道的事——预备态里写不出一份"将来的冲突"（架构 § 8.12 那张表的最后两行）。
 */
export type DraftKind = 'implement' | 'investigate'

/** 两节的次序：调查型在前（与 `build()` 的构造次序同一件事）。 */
export const DRAFT_KINDS: readonly DraftKind[] = ['investigate', 'implement']

/**
 * 那一条**跨节的次序规则**，一处：判它的那两句（`checkDraft`）与写给模型看的那一段
 * （`draftRuleTextOf`）都从这一句来。
 *
 * 为什么收成一处：真档那一趟量到过它的缺席——草案的键与值都对（形状那一句进前缀之后），退回来的
 * 唯一一句就是"调查型那一节要排在第一节"，而那一句是**印给人的**。两处各写一遍的症状与形状那一栏
 * 一样：模型照提示写、判它不认。
 */
const SECTION_ORDER_RULE = 'at most one investigate section, and it comes first — contracts take their identity and branch from the order of the draft'

/**
 * **每一节是独立的一格**——与上面那条次序规则同类：机器知道、模型无从得知，所以一处：
 * 印给模型的那一段（`draftRuleTextOf`）与判它的那一句都从这一句来。
 *
 * 由头：样本盘第一趟真档（`sh tools/scenario/board.sh --live --max-steps 16`，第 1 案
 * 「改码 · 记账库」）。持轮者把第一节写成调查型（README 该按哪个口径补），第二节的 `goal` 里
 * 写了「写法照第 1 节的结论」——那是一句**谁也兑现不了**的指路：每一格的分支都从同一个底起
 *（`issueAndStart` 那一句「N 条分支定在同一个 `base`」），第二节那一格跑的时候看不见第一节的
 * 产物；而调查型那一节的证据连折叠都不进（`round/execute.ts` 折叠那一行的
 * `.filter((c) => c.kind !== 'investigate')`）。那一格于是把 16 步里的大半花在找「第 1 节」上
 *（去读 `.fugue/mat/agent/r1/1/merged` · 别的格的日志，连持轮者那一趟的 `plan.out` 都读了），
 * 一次都没伸手写 `src/format.ts`，最后停在步数上界：那一份契约交了空卷，验收跟着红。
 *
 * 后半句那一栏（`seed`）也有它自己的坑：**`seed` 是底上那一棵树的指针**，指一条别节将来才
 * 产出的路径（比如 `evidence/...`）不会报错——`seedRulerOf` 只把读不到的那几条记进 `missing`
 *（一条读数，不判）。所以「底上就已经有的那几条」这半句必须一起说，不然这一句本身会引诱出
 * 下一个静默落空。
 */
const SECTION_ISOLATION_RULE =
  `each section is an independent task: all branches start from the same base and cannot see another section's output while running (the evidence an investigate section hands in is not in this round's work tree either) — so what a section needs must come from seeds that already exist on the base, or be written straight into that section's goal / deliverables by you; never point at "the conclusion of section N"`

/**
 * 草案不给的那几个键，逐变体。**它是一条减法，不是第二份字段表**：草案的键域 = 契约的字段表
 * （`VARIANT_FIELDS`）减去这里。于是"契约加了一个字段"这件事在下面那段载入核对里当场炸，
 * 而不会悄悄变成"草案少要一个键"——少要一个键的症状只是构造器报"缺键"，指向的却是模型。
 *
 * 调查型那一节多减一个 `goal`：轮级意图那一句只有一个来源（`round/intent`，`round plan <目标>`
 * 给的那一句）。草案再写一遍的后果是"这一轮到底要什么"有两个答案。
 */
const NOT_IN_DRAFT: Readonly<Record<DraftKind, readonly string[]>> = {
  implement: ['id', 'agent', 'branch', 'actionOutputs'],
  investigate: ['id', 'agent', 'branch', 'goal'],
}

/** 一节该有哪几个键：`kind` 加上契约字段表减去系统的那几个。 */
export const DRAFT_FIELDS: Readonly<Record<DraftKind, readonly string[]>> = {
  implement: VARIANT_FIELDS.implement.filter((f) => !NOT_IN_DRAFT.implement.includes(f)),
  investigate: VARIANT_FIELDS.investigate.filter((f) => !NOT_IN_DRAFT.investigate.includes(f)),
}

/**
 * 载入时的核对：**两边的并集恰好是契约的字段表，且两边不相交。**
 *
 * 它为什么必须是当场炸：`DRAFT_FIELDS` 与 `NOT_IN_DRAFT` 分居两行，而"某个字段两边都没算进去"
 * 的后果**只有一种**——草案里那个键从此不必给，构造器却照旧要它（或者反过来）。前者的症状是
 * 每次派发都退回、指着一个模型没被要求给的键。
 */
for (const kind of DRAFT_KINDS) {
  const want = [...VARIANT_FIELDS[kind]].sort().join(' ')
  const got = [...DRAFT_FIELDS[kind], ...NOT_IN_DRAFT[kind]].sort().join(' ')
  if (want !== got) {
    throw new Error(
      `草案的键域与契约的字段表对不上（${kind}）：\n` +
        `  契约是：${want}\n  草案该给的加系统的：${got}`,
    )
  }
  const both = DRAFT_FIELDS[kind].filter((f) => NOT_IN_DRAFT[kind].includes(f))
  if (both.length > 0) throw new Error(`这两栏都说要给（${kind}）：${both.join(' · ')}——一处说了算`)
  if (!DRAFT_FIELDS[kind].includes('kind')) throw new Error(`${kind} 那一节的键域里没有 kind：判它是哪一节要靠它`)
  // **每一笔都要有一句形状**：那一句是发给模型的那段提示念的（`draftRuleTextOf`）——少一笔的
  // 症状是那一段里印出一个"（没有一句形状）"，而它不报错。与 `types.ts` 那条同一条纪律。
  const noShape = DRAFT_FIELDS[kind].filter((f) => (FIELD_RULES[f]?.shape ?? '').trim() === '')
  if (noShape.length > 0) {
    throw new Error(`${kind} 那一节里这几笔没有一句形状（值域持有者表里那一格没写）：${noShape.join(' · ')}`)
  }
}

/** 一节草案读出来的值。**每一栏都给全**（那几节没有的那几栏是空值，不是 `undefined`）。 */
export interface DraftSection {
  readonly kind: DraftKind
  readonly goal: string
  readonly ownedPaths: readonly RelPath[]
  readonly deliverables: readonly Deliverable[]
  readonly assertions: readonly Assertion[]
  readonly question: string
  readonly evidenceRequired: readonly { readonly note: string }[]
  readonly seed: readonly RelPath[]
}

/** 一份草案：逐节的值 · 给构造器的两栏 · 模型写的那段散文。 */
export interface Draft {
  readonly sections: readonly DraftSection[]
  /** 实现型那几节，**按草案里的次序**（身份与分支也按这个序发）。 */
  readonly split: readonly SplitAssignment[]
  /** 调查型那一节给的问题（没有那一节就是 `undefined`——"不派调查"不是缺省，是缺席）。 */
  readonly question?: string
  readonly evidenceRequired?: readonly { readonly note: string }[]
  /**
   * 逐节的 `seed`，**与契约的构造次序同序**（调查型在前，其余按草案次序）。
   *
   * 它是给 `build()` 的 `seedOf(n)` 用的那一栏：`n` 是构造次序里的第 `n` 个 agent，而那个
   * 次序就是 `sections` 的次序——两处同序这件事由上面那条"调查型排第一节"的核对保着。
   */
  readonly seeds: readonly (readonly RelPath[])[]
  /**
   * 块外那段话（模型写的"为什么这么拆"）。**去掉标题行**——`## 一 · 拆解析器` 这一类是这一份的
   * 骨架（每一节的名字在它的 `goal` 里已经有了），不是要说的话；门渲染那一栏要的是话。
   * 判据仍然是"不判、不截"：它一个字都不进任何一条核对，原样交给读的人。
   */
  readonly prose: string
}

/** 这一份自己的失败：草案不成立。**报出每一处**，不是只报第一处。 */
export class DraftError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`草案不成立（${problems.length} 处）：\n  ${problems.join('\n  ')}`)
    this.name = 'DraftError'
    this.problems = problems
  }
}

/**
 * 草案住在视图里的哪一条路径（架构 § 9.10 的保留前缀：`.fugue/plan/`）。
 *
 * **它在视图里，不在真实工作树里**：`M13` 推进时跳过保留前缀（架构 § 8.14），所以模型写它的
 * 那一下一个字节都不落在用户拿得到的那棵树上——这正是 `C1` 断言②要的"真实工作树一个字节不动"。
 * 名字里带轮次：同一份工作区里，两轮的草案不互相盖。
 */
export function draftPathOf(round: string): RelPath {
  if (!isSegment(round)) {
    throw new DraftError([`轮次号要是一个段（不含 / 与 \\，不以点开头）：${JSON.stringify(round)}`])
  }
  return `.fugue/plan/${round}.md` as RelPath
}

/**
 * **这一趟的产物那一句**（给模型看的那一段正文）：写哪儿 · 什么形状。
 *
 * 它是 S9 真档取证量出来的那条缺口的封口（`tools/probe-live-s9.sh` 三次真档：持轮者拿到的前缀里
 * 没有一处说草案写哪儿 · 什么形状，于是真模型写不出草案）。两个要点：
 *
 *   · **位置由调用方拼在「工作总目标」那一段的末尾**（`goalWithDraftRule`）：那是这一趟里模型
 *     读到的最后一处（`round plan` 那一趟 C 区是空的），而"要什么产物"本来就是意图的一部分；
 *   · **键从 `DRAFT_FIELDS` 念、形状从 `FIELD_RULES` 念**，两样都不在这里另抄一份：判键域与
 *     判值域用的就是那两份（架构 § 8.12「构造器不猜、不补」）。抄一份的后果是提示词与判据
 *     各说各话，而它一个错都不报——症状只有一个：模型老是写不中。
 */
export function draftRuleTextOf(draftPath: RelPath): string {
  const lines = DRAFT_KINDS.map(
    (k) => `  ${k}: ${DRAFT_FIELDS[k].map((f) => `${f}: ${FIELD_RULES[f]?.shape ?? '(no shape given)'}`).join(' · ')}`,
  )
  return (
    `Write the split into \`${draftPath}\`: one task per section, each section in a fenced block tagged \`json\`;` +
    " inside the block give the keys for that section's kind, with each value in the shape shown:\n" +
    lines.join('\n') +
    `\n${SECTION_ORDER_RULE}.\n` +
    `${SECTION_ISOLATION_RULE}.\n` +
    // `assertions` 里那个 `action` **只能从工作区绑好的动作里挑**（PLAN § 5.10 的 C1 ⑦：不猜、
    // 不补、不替它挑）。清单不再内联在这一句里（P3b2 撤掉模型侧枚举注入）：它就在 A 区的
    // 系统状态那一栏（`actions`：名字 + argv），与跑它的人同一份来源——提示词不可能与配置漂移。
    // 之所以必须有那一条路：只给名字那一版真档照出过一次后果——那一趟为了弄清哪个动作核哪一处，
    // 去找工作区的配置（猜 `*.json` / `*.yaml` / `*.toml`），8 步里烧掉四步（`--dump-wire` 实录）。
    `the action in assertions can only come from the actions bound in this workspace — the list (name + argv) is in the system state; if it lists none, bind one first with fugue config set actions.<name>.\n` +
    'Keep the prose outside the blocks — that is where "why split it this way" belongs. Another path does not count as this pass\'s deliverable.'
  )
}

/** 「工作总目标」那一段的正文：人的意图那一句 + **末尾**那一句产物说明（近因：末处说什么，它做什么）。 */
export function goalWithDraftRule(goal: string, draftPath: RelPath): string {
  return `${goal}\n\n${draftRuleTextOf(draftPath)}`
}

/** 一个围栏块：语言那一栏与正文。**不标语言的不算节**（它多半是示意）。 */
const BLOCK = /```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 那个键属于哪几节——报"多了一个键"时用它指路。 */
function kindOfField(field: string): DraftKind[] {
  return DRAFT_KINDS.filter((k) => DRAFT_FIELDS[k].includes(field))
}

/**
 * 读一节。**一次把这一节的每一处都说出来**（缺键 · 多键 · 类型不对三样并行），而不是报第一处
 * 就返回——退回一次要能改完，不然就是让人陪着一处一处试。
 */
function readSection(raw: unknown, at: number, problems: string[]): DraftSection | null {
  const where = `第 ${at} 节`
  if (!isObject(raw)) {
    problems.push(`${where}不是一个 JSON 对象（拿到的是 ${Array.isArray(raw) ? '数组' : typeof raw}）`)
    return null
  }
  const kind = raw['kind']
  if (kind !== 'implement' && kind !== 'investigate') {
    if (kind === 'resolve') {
      problems.push(`${where}的 kind 是 resolve：解决型契约由冲突报告给，不在草案里（架构 § 8.12）`)
    } else {
      problems.push(`${where}的 kind 要是 implement 或 investigate，拿到的是 ${JSON.stringify(kind)}`)
    }
    return null
  }

  const want = DRAFT_FIELDS[kind]
  const got = Object.keys(raw)
  for (const k of want) {
    if (!got.includes(k)) problems.push(`${where}缺一个键：${k}`)
  }
  for (const k of got) {
    if (k === 'kind' || want.includes(k)) continue
    if (NOT_IN_DRAFT[kind].includes(k)) {
      problems.push(
        `${where}多了一个键 ${k}：那是系统的键——身份由分配器发 · 序号由构造器发 · 动作产出由绑定给（架构 § 8.12），草案不给`,
      )
    } else {
      const owners = kindOfField(k)
      problems.push(
        `${where}多了一个键 ${k}：${kind} 那一节没有它` +
          (owners.length > 0 ? `（它是 ${owners.join(' · ')} 那一节的键）` : ''),
      )
    }
  }

  const bad: string[] = []
  const goal = nonEmpty(raw['goal'])
  const question = nonEmpty(raw['question'])
  // **缺键已经在上面的键域那条报过**：同一个根因说两次是噪声，两次说的还不是同一句话。
  if (got.includes('goal') && want.includes('goal') && goal === null) bad.push('goal 要是一句非空的话')
  if (got.includes('question') && want.includes('question') && question === null) bad.push('question 要是一句非空的话')

  const paths = (v: unknown, field: string): RelPath[] | null => {
    if (!Array.isArray(v)) {
      bad.push(`${field} 要是一个路径数组`)
      return null
    }
    const out: RelPath[] = []
    for (const [i, one] of v.entries()) {
      const s = nonEmpty(one)
      if (s === null) {
        bad.push(`${field} 第 ${i + 1} 条要是一条非空路径`)
        continue
      }
      out.push(s as RelPath)
    }
    return out
  }

  // **给了才核**（缺键已在上面的键域那条报过）：同一个根因说两次是噪声。
  const has = (f: string): boolean => want.includes(f) && got.includes(f)
  const ownedPaths = has('ownedPaths') ? paths(raw['ownedPaths'], 'ownedPaths') : []
  const seed = has('seed') ? paths(raw['seed'], 'seed') : []
  // **`seed` 里不许指别节的产物**（见 `SECTION_ISOLATION_RULE` 后半句）：`evidence/` 那一段归
  // 构造器、只有调查型那一节写得进去，而它跑的时候谁也看不见。指了不是「读不到就算了」得好听：
  // `seedRulerOf` 只把读不到的那几条记进 `missing`（一条读数，不判），于是这一个指路静默落空。
  for (const one of seed ?? []) {
    if (one === EVIDENCE_PREFIX || one.startsWith(`${EVIDENCE_PREFIX}/`)) {
      bad.push(`seed 里有一条指着 ${EVIDENCE_PREFIX}/：${one}——${SECTION_ISOLATION_RULE}`)
    }
  }

  let deliverables: Deliverable[] = []
  if (has('deliverables')) {
    const v = raw['deliverables']
    if (!Array.isArray(v)) {
      bad.push('deliverables 要是一个数组（没有交付物就给空数组——空不等于缺省）')
    } else {
      deliverables = v.flatMap((one, i) => {
        if (!isObject(one)) {
          bad.push(`deliverables 第 ${i + 1} 条要是一个对象（path · form）`)
          return []
        }
        const path = nonEmpty(one['path'])
        const form = nonEmpty(one['form'])
        if (path === null) bad.push(`deliverables 第 ${i + 1} 条缺 path`)
        if (form === null) bad.push(`deliverables 第 ${i + 1} 条缺 form（这一条交付物是什么形状）`)
        return path === null || form === null ? [] : [{ path: path as RelPath, form }]
      })
    }
  }

  let assertions: Assertion[] = []
  if (has('assertions')) {
    const v = raw['assertions']
    if (!Array.isArray(v)) {
      bad.push('assertions 要是一个数组：零条断言会让「打回率低」这句话没有分母（PLAN § 5.7 的地板第二档）')
    } else {
      assertions = v.flatMap((one, i) => {
        if (!isObject(one)) {
          bad.push(`assertions 第 ${i + 1} 条要是一个对象（action · name）`)
          return []
        }
        const action = nonEmpty(one['action'])
        const name = nonEmpty(one['name'])
        if (action === null) bad.push(`assertions 第 ${i + 1} 条缺 action（已绑好的动作名）`)
        if (name === null) bad.push(`assertions 第 ${i + 1} 条缺 name（报出来时用它指认）`)
        if (action === null || name === null) return []
        const where0 = nonEmpty(one['where'])
        const expect = one['expect']
        if (expect !== undefined && (typeof expect !== 'number' || !Number.isInteger(expect) || expect < 0 || expect > 255)) {
          bad.push(`assertions 第 ${i + 1} 条的 expect 要是一个 0–255 之间的整数`)
        }
        return [
          {
            action: action as Assertion['action'],
            name,
            ...(where0 === null ? {} : { where: where0 as RelPath }),
            ...(expect === undefined ? {} : { expect: expect as number }),
          },
        ]
      })
    }
  }

  let evidenceRequired: { readonly note: string }[] = []
  if (has('evidenceRequired')) {
    const v = raw['evidenceRequired']
    if (!Array.isArray(v)) {
      bad.push('evidenceRequired 要是一个数组（要它交什么证据；不派调查型那一节就没有它）')
    } else {
      evidenceRequired = v.flatMap((one, i) => {
        if (!isObject(one)) {
          bad.push(`evidenceRequired 第 ${i + 1} 条要是一个对象（note）`)
          return []
        }
        const note = nonEmpty(one['note'])
        if (note === null) bad.push(`evidenceRequired 第 ${i + 1} 条缺 note（要求的形状）`)
        return note === null ? [] : [{ note }]
      })
    }
  }

  for (const b of bad) problems.push(`${where}：${b}`)
  if (bad.length > 0) return null

  return {
    kind,
    goal: goal ?? '',
    ownedPaths: ownedPaths ?? [],
    deliverables,
    assertions,
    question: question ?? '',
    evidenceRequired,
    seed: seed ?? [],
  }
}

/**
 * 读一份草案。**有问题就抛 `DraftError`，里面带每一处。**
 *
 * 抛而不是返回两栏（值 + 问题）的理由：调用点只有两种处理——"不成立就退回"与"看每一处"，
 * 而后者从异常里也拿得到（`.problems`）。返回两栏的话，每个调用点都要自己判"值是不是空的"，
 * 而漏判的那一处会把一份半成品当成品用——那正是这一站最不能出的错（门只认键域完整性）。
 */
export function draftOf(text: string): Draft {
  const problems: string[] = []
  const blocks: string[] = []
  const prose: string[] = []
  let rest = 0
  BLOCK.lastIndex = 0
  for (;;) {
    const m = BLOCK.exec(text)
    if (m === null) break
    const lang = (m[1] ?? '').toLowerCase()
    prose.push(text.slice(rest, m.index))
    rest = m.index + m[0].length
    if (lang === 'json') blocks.push(m[2] ?? '')
  }
  prose.push(text.slice(rest))

  if (blocks.length === 0) {
    const anyFence = text.includes('```')
    throw new DraftError([
      anyFence
        ? '草案里一个任务节都没有：每一节写在一个标 `json` 的围栏块里（块外的话不算节）'
        : '草案里一个任务节都没有：每一节写在一个标 `json` 的围栏块里，一个任务一节',
    ])
  }

  const sections: DraftSection[] = []
  blocks.forEach((body, i) => {
    const at = i + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (err) {
      problems.push(`第 ${at} 节不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const one = readSection(parsed, at, problems)
    if (one !== null) sections.push(one)
  })

  const investigate = sections.filter((s) => s.kind === 'investigate')
  if (investigate.length > 1) {
    problems.push(`草案里有 ${investigate.length} 节调查型：${SECTION_ORDER_RULE}（它们都问同一个轮级的问题）`)
  }
  if (investigate.length === 1 && sections[0]?.kind !== 'investigate') {
    problems.push(`调查型那一节没在第一节：${SECTION_ORDER_RULE}（架构 § 8.12 · A4）`)
  }
  if (problems.length > 0) throw new DraftError(problems)

  const first = investigate[0]
  return {
    sections,
    split: sections
      .filter((s): s is DraftSection & { kind: 'implement' } => s.kind === 'implement')
      .map((s) => ({
        goal: s.goal,
        ownedPaths: [...s.ownedPaths],
        deliverables: [...s.deliverables],
        assertions: [...s.assertions],
      })),
    ...(first === undefined ? {} : { question: first.question, evidenceRequired: first.evidenceRequired }),
    seeds: sections.map((s) => s.seed),
    // **标题行不算话**（见 `Draft.prose`）：去掉它们之后把连着的空行收成一空行，别的照原样。
    prose: prose
      .join('')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  }
}

/** 只核不抛：给"报出来、照发"那一侧与报告用（空数组就是成立）。**一处实现**，不另写一遍。 */
export function checkDraft(text: string): readonly string[] {
  try {
    draftOf(text)
    return []
  } catch (err) {
    if (err instanceof DraftError) return err.problems
    throw err
  }
}
