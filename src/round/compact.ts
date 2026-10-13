// **门停时人读几行可核对的浓缩件**（0.5.0 · 验收锚 ①）。出处：路线图 § 5 的 0.5.0 行（门视图浓缩件
// `T14`）· 架构 § 15.1.a（门由人开 · 放行的是这一批 · 新的一批一律重停）· 架构 § 9.2（账是唯一
// 的观察对象）。
//
// **它是什么**：门口那一批（`Pending`）与这一份账（`RoundFacts`）进去，出来的是**几行**——这一批
// 打算开几件事 · 改哪几条路径 · 按什么验收 · 与上一批已批准的那一批差在哪里。每一行都能对着账与
// 契约逐字核。
//
// **它为什么纯**：一、出的是**同一个账上的同一个值**——换一个进程、换一个壳（CLI · 界面 · 将来的
// 客户端）重算，逐字节相同；二、因此它可以有一条"重算得出来"的断言；三、它不许读真源、不许读
// 视图、不许读时刻——那三样都会让"同一个账出同一份"不成立。
//
// **三种档分得开**（验收锚 ① 的原话）：
//
//   · `first`   —— 账上**一条放行都没有**：这是第一确认，没有可比的对象（不是"与上一批相同"）；
//   · `same`    —— 这一批与**上一批已批准**的那一批同号（拆分的形状逐字节相同）；
//   · `changed` —— 与上一批**不同**：`diff` 逐条说差在哪一处（也可能是零条，见下）。
//
// **「零 diff」与「同号」是两件事**：同号比的是编号（拆分的形状），而 diff 比的是契约的**面**
// （目标 · 写入面 · 验收 · 交付物）。改一句 `goal` 而结构不变时编号会变，而面可能逐条相同——
// 那时 `changed` 配一个空的 `diff`，人读得出来"编号变了，面没变"。两种读法都在，人自己挑信哪个。
import { createHash } from 'node:crypto'
import type { Contract } from '../contract/types.ts'
import { WORDS } from '../words.ts'
import type { ApprovedBatch, RoundFacts } from './versions.ts'
import type { Pending } from './dispatch.ts'

/** 与上一批已批准的那一批比出来的三种档。 */
export type CompactCompare = 'first' | 'same' | 'changed'

/** 浓缩件。**几行**：一批一段 + 与前一批的比。 */
export interface Compact {
  readonly round: string
  /** 钉住的底（`round/intent` 那一栏）。**它是账上那一个值**，不是当下 HEAD。 */
  readonly base: string | null
  /** 这一批的编号（拆分的形状）。 */
  readonly fingerprint: string
  /** 这一批几份契约。 */
  readonly tasks: number
  /** 覆盖几条路径（`implement` 的写入面 + `resolve` 的冲突路径）。 */
  readonly paths: number
  /** 验收几条（`implement` 与 `resolve` 各条断言）。 */
  readonly accepts: number
  /** 这一批的契约 id，按构造次序。 */
  readonly ids: readonly string[]
  /** 上一批已批准的那一批（账上最后一条放行）；一条都没有就是 `null`。 */
  readonly lastApproved: { readonly round: string; readonly fingerprint: string } | null
  readonly compare: CompactCompare
  /** 与上一批的逐处差异（`first` 那一档没有可比的，给空）。 */
  readonly diff: readonly string[]
  /**
   * **这一份浓缩件的指纹**（那几行原文的 sha256 前十六位）。
   *
   * 它存在的理由：验收锚 ① 那句「可重算（同一个账跨进程重算一致）」要一条**可证伪**的形状——
   * 换一个进程把同一份账算一遍，这个串必须逐字节相同。它不进账、不进事件，只是一条判据。
   */
  readonly digest: string
}

/** 一份契约的面：浓缩件的数与差异的行都从这一处投影来（不各算各的）。 */
interface Face {
  readonly goal: string
  readonly paths: readonly string[]
  readonly accepts: readonly string[]
  readonly deliverables: readonly string[]
}

function faceOf(c: Contract): Face {
  if (c.kind === 'implement') {
    return {
      goal: c.goal,
      paths: [...c.ownedPaths],
      accepts: c.assertions.map((a) => `${a.name}（${a.action}）`),
      deliverables: c.deliverables.map((d) => `${d.path}（${d.form}）`),
    }
  }
  if (c.kind === 'resolve') {
    return {
      goal: c.goal,
      paths: [...c.conflictPaths],
      accepts: c.assertions.map((a) => `${a.name}（${a.action}）`),
      deliverables: [],
    }
  }
  return {
    goal: c.question,
    paths: [...c.evidenceRequired.map((e) => e.artifact)],
    accepts: [],
    deliverables: [],
  }
}

/** 一批的覆盖与验收两条数。**一处算术**（与 `ui/gate.ts` 的 `conclusionOf` 同一个口径）。 */
export function countsOf(contracts: readonly Contract[]): { readonly paths: number; readonly accepts: number } {
  let paths = 0
  let accepts = 0
  for (const c of contracts) {
    const f = faceOf(c)
    paths += f.paths.length
    accepts += f.accepts.length
  }
  return { paths, accepts }
}

/**
 * 两批契约的**逐处差异**（各一行人话）。**按契约 id 对齐**：
 *
 *   · 只有这一边有的 id → `多了一件 <id>` / `少了 <id>`；
 *   · 两边都有 → 逐面比（目标 · 写入面 · 验收 · 交付物），差一面出一行。
 *
 * 行序是**先多后少、再按 id 排**（不看输入的次序）——于是同一份差异在哪一个进程里算都是同样的行序。
 */
export function diffOf(before: readonly Contract[], after: readonly Contract[]): readonly string[] {
  const a = new Map(before.map((c) => [c.id, c]))
  const b = new Map(after.map((c) => [c.id, c]))
  const out: string[] = []
  for (const id of [...b.keys()].filter((x) => !a.has(x)).sort()) out.push(`多了一件 ${id}`)
  for (const id of [...a.keys()].filter((x) => !b.has(x)).sort()) out.push(`少了 ${id}`)
  for (const id of [...a.keys()].filter((x) => b.has(x)).sort()) {
    const left = a.get(id) as Contract
    const right = b.get(id) as Contract
    if (left.kind !== right.kind) {
      out.push(`${id}\t类型变了：${left.kind} → ${right.kind}`)
      continue
    }
    const lf = faceOf(left)
    const rf = faceOf(right)
    if (lf.goal !== rf.goal) out.push(`${id}\t目标变了：${lf.goal} → ${rf.goal}`)
    if (lf.paths.join(' · ') !== rf.paths.join(' · ')) {
      out.push(`${id}\t写入面变了：${lf.paths.join(' · ') || '（空）'} → ${rf.paths.join(' · ') || '（空）'}`)
    }
    if (lf.accepts.join(' · ') !== rf.accepts.join(' · ')) {
      out.push(`${id}\t验收变了：${lf.accepts.join(' · ') || '（空）'} → ${rf.accepts.join(' · ') || '（空）'}`)
    }
    if (lf.deliverables.join(' · ') !== rf.deliverables.join(' · ')) {
      out.push(
        `${id}\t交付物变了：${lf.deliverables.join(' · ') || '（空）'} → ${rf.deliverables.join(' · ') || '（空）'}`,
      )
    }
  }
  return out
}

/**
 * 一份浓缩件的**规范化原文**：逐字段一行。它是 `digest` 的输入，也是「跨进程重算一致」那句话
 * 量的东西——**逐字节**，不是"看起来一样"。
 */
export function canonicalOf(a: Omit<Compact, 'digest'>): string {
  return [
    `round\t${a.round}`,
    `base\t${a.base ?? '（没有）'}`,
    `fingerprint\t${a.fingerprint}`,
    `tasks\t${a.tasks}`,
    `ids\t${a.ids.join(' · ')}`,
    `paths\t${a.paths}`,
    `accepts\t${a.accepts}`,
    `last\t${a.lastApproved === null ? '（一条都没有）' : `${a.lastApproved.round}\t${a.lastApproved.fingerprint}`}`,
    `compare\t${a.compare}`,
    ...a.diff.map((d) => `diff\t${d}`),
  ].join('\n')
}

/** sha256 的前十六位（与 `contract/gate.ts` 的 `digestOf` 同一个口径：那两处各自私有，不互 import）。 */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * **一批 → 浓缩件**。纯函数：只读入参里的那两份值（门口那一批 + 这一份账）。
 *
 * `facts` 给的是**这一份账上的读数**（`roundFactsOf`）：钉住的底 · 放过的那几批（含各自的契约面）。
 * 于是"与上一批差在哪"是从账上重算的，不是从当下工作区里猜的——换一个进程读同一份账，这几行
 * 逐字节相同。
 */
export function compactOf(pending: Pending, facts: RoundFacts): Compact {
  const contracts = pending.built.contracts
  const counts = countsOf(contracts)
  const last: ApprovedBatch | null =
    facts.approvals.length === 0 ? null : (facts.approvals[facts.approvals.length - 1] ?? null)
  const compare: CompactCompare =
    last === null ? 'first' : last.fingerprint === pending.fingerprint ? 'same' : 'changed'
  const diff = last === null || compare === 'same' ? [] : diffOf(last.contracts, contracts)
  const body: Omit<Compact, 'digest'> = {
    round: pending.round,
    base: facts.base,
    fingerprint: pending.fingerprint,
    tasks: contracts.length,
    paths: counts.paths,
    accepts: counts.accepts,
    ids: contracts.map((c) => c.id),
    lastApproved: last === null ? null : { round: last.round, fingerprint: last.fingerprint },
    compare,
    diff,
  }
  return { ...body, digest: digestOf(canonicalOf(body)) }
}

/**
 * 浓缩件的人读那几行（**一处渲染**：命令行印的与将来别的壳印的是同一份）。
 *
 * 三行封顶 + 差异逐条跟在后面——**差异是要人核的东西，不折**（它有几条就几行）。
 */
export function compactLinesOf(a: Compact): readonly string[] {
  const out = [
    `  浓缩\t第 ${a.round} 轮\t底 ${a.base === null ? '（没有）' : a.base.slice(0, 8)}\t批号 ${a.fingerprint}`,
    `\t${a.tasks} 份${WORDS.task}：${a.ids.join(' · ') || '（空）'}\t覆盖 ${a.paths} 条${WORDS.paths}\t${WORDS.accepts} ${a.accepts} 条\t指纹 ${a.digest}`,
  ]
  if (a.compare === 'first') {
    out.push('\t与上一批：账上一条放行都没有——这是第一确认，没有可比的对象')
    return out
  }
  const last = a.lastApproved as { readonly round: string; readonly fingerprint: string }
  if (a.compare === 'same') {
    out.push(
      `\t与上一批：与 ${last.round} 放过的那一批同号（${last.fingerprint}）——编号只是一个名字，不作放行的凭证`,
    )
    return out
  }
  out.push(
    `\t与上一批：与 ${last.round} 放过的那一批（${last.fingerprint}）**不同**，${a.diff.length} 处` +
      (a.diff.length === 0 ? '（零 diff——契约的面逐条相同，只有编号变了）' : ''),
  )
  for (const d of a.diff) out.push(`\t  ${d}`)
  return out
}

