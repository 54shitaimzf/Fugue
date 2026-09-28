// 派：**判完之后那一步——契约发出去 · 分支起来 · 物化铺开**。出处：架构 § 8.13（`Planning` 的
// `contracts-issued` 与 `Delegated` 的 `branches-started` · 那条结构纪律"状态机只做转移"）·
// 架构 § 15.1.a 四步里的"派"与"门由人开" · 架构 § 8.14 的 C7 前半（轮次开始时钉住 base）·
// PLAN § 5.10 的 C4。
//
// **两个调用点共用这一份。** 配置那一档（`round new`：人把两栏写在配置里，从 `Idle` 起）与预备态
// 那一档（`round go`：持轮者写的草案落在日志里，从 `Planning` 起）——两处只差"这一批是从哪儿来的"，
// 而"发出去"这件事只有这一段实现：同一个函数，因此不会有一处漏发一条契约、或者少起一条分支。
//
// **放行那一批是重算出来的，不是存下来的。** 门上那一趟（`contract/gate.ts`）不留任何持久态：
// `round go` 从日志里读回**这一轮钉住的底**（`round/intent` 的 `base`）与**那一份草案**
//（`holder/distill` 的正文），拿同一个身份分配器再判一遍——集合是（草案 · 身份 · 底）的纯函数，
// 所以拿到的是同一批。这是"人批的是这一批"这句话的可核对处。
//
// **编号不作数。** `round/approve` 记着这一批的编号（`fingerprintOf`：拆分的形状），而它**不是
// 放行的凭证**：新的一批一律停在门口等人点头，哪怕与上一批同一个编号（架构 § 15.1.a）。编号的
// 用处只有一个——读日志的人一眼看得出"这一批与哪一批同形"（`RoundFacts.approvals`）。
//
// **再跑一次不重复触发。** 放行只在 `Planning` 那一处走：这一批发过之后处境已经不在门口，
// 第二次 `round go` 当场拒，**一个字节都不落**——不是静默成功，也不是发第二条契约。
import type { AgentId, CommitId, ContractId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { Log, LogReader } from '../log/events.ts'
import type { Roots } from '../roots/contract.ts'
import type { Truth } from '../truth/contract.ts'
import { refFor } from '../identity.ts'
import { baseFor } from '../view/lower.ts'
import { fork } from '../materialize/fork.ts'
import type { ForkResult } from '../materialize/fork.ts'
import { DEFAULT_MATERIALIZE } from '../materialize/contract.ts'
import type { Built, Identity } from '../contract/build.ts'
import { draftPathOf } from '../contract/draft.ts'
import type { SeedMeasurer } from '../contract/gate.ts'
import { fingerprintOf, gateOf } from '../contract/gate.ts'
import type { PrecheckResult } from '../contract/precheck.ts'
import type { Contract } from '../contract/types.ts'
import type { Cause, RoundState, StepContext } from './machine.ts'
import { step } from './machine.ts'
import type { SeedReading } from './seed.ts'
import { seedRulerAt } from './seed.ts'
import { lastOf, roundFactsOf } from './versions.ts'
import type { RoundFacts } from './versions.ts'

/** 这一层自己的失败：判不成器 · 这一轮不在门口 · 分支不是空的 · 物化没地方落。**说出是哪一步。** */
export class RoundStartError extends Error {}

/** 走过的一步：每一步都带着触发它的那一条事件（与 `RoundStart.trail` 同一形状）。 */
export interface TrailStep {
  readonly from: RoundState
  readonly on: Cause
  readonly to: RoundState
}

/**
 * 发出去要的那几样。**底与那一批契约由参数给**：这一份不认识草案、不认识门，也不认识命令行。
 *
 * `logForAgent` 只在物化那一档要：`mat/fork` 落在**那个 agent 自己的日志**里，而 `round/state` ·
 * `contract/issue` 落在持轮者那一份（§ 9.2 的栅栏按 writer 分文件）——两个写者，两个口。
 */
export interface IssueDeps {
  readonly roots: Roots
  readonly truth: Truth
  readonly log: Log
  readonly round: RoundId
  readonly logForAgent?: (a: AgentId) => Log
  /** 要不要在这一步就把物化铺出来（架构 § 14.1 的 `deferMaterialize`）。**缺省不铺。** */
  readonly materialize?: boolean
  readonly forkOpt?: typeof DEFAULT_MATERIALIZE
}

/** 发出去之后手上有什么。 */
export interface Issued {
  readonly owners: Readonly<Record<ContractId, AgentId>>
  readonly forks: readonly ForkResult[]
  readonly trail: readonly TrailStep[]
}

/**
 * 把一批**已经造好的**契约发出去：逐条 `contract/issue` · N 条分支定在同一个底上 · 可选物化 ·
 * 状态从 `from` 起走到 `Working`。
 *
 * **顺序是承重的**：契约在分支之前（`contract/issue` 里的 `owner` 要先定下来）；分支在物化之前
 *（物化的底就是那几条分支的底）；而**每一步的判决都来自 `machine.ts`**——这里只记转移与落事件。
 */
export async function issueAndStart(
  built: Built,
  base: CommitId,
  from: RoundState,
  deps: IssueDeps,
): Promise<Issued> {
  // **要起分支的那几条 = 这一批契约的持有者**。一个来源：构造器问身份分配器要的那个次序
  //（调查型在前）——再另给一份 agent 名单的话，两份次序一旦不同就错开一格，而那种错在日志里
  // 看不出来（两份身份都合法）。
  const agents = [...new Set(built.contracts.map((c) => c.agent as AgentId))]
  if (agents.length === 0) {
    throw new RoundStartError('这一批一份契约都没有：轮次至少要有一份契约与一条分支')
  }

  const trail: TrailStep[] = []
  let state: RoundState = from
  const move = async (on: Cause, ctx: StepContext = {}): Promise<void> => {
    const before = state
    state = step(before, on, ctx)
    trail.push({ from: before, on, to: state })
    await deps.log.append('round', { t: 'round/state', round: deps.round, from: before, to: state })
  }

  // 一 · 发契约：一份一条。**契约住日志里**（架构 § 8.12）——事件带正文，重放读得出。
  const owners: Record<ContractId, AgentId> = {}
  for (const c of built.contracts) {
    owners[c.id as ContractId] = c.agent as AgentId
    await deps.log.append('round', {
      t: 'contract/issue',
      round: deps.round,
      contract: c.id as ContractId,
      owner: c.agent as AgentId,
      paths: [...writeSetOfContract(c)],
      body: JSON.stringify(c),
    })
  }
  await move('contracts-issued')

  // 二 · 起分支：**N 条分支定在同一个 `base` 上**。用 git 直接指（§ 4：`fugue branch` 是一条
  // 方便的路，不是一个前提），CAS 的 `expectedOld` 是 `null`——"它必须还不存在"。
  // 已经指着同一个提交算成功（幂等的那一半），指着别处才拒。
  for (const a of agents) {
    const ref = refFor(a as WriterId)
    const now = await baseFor(deps.truth, a as WriterId)
    if (now === base) continue
    if (now !== null) {
      throw new RoundStartError(
        `第 ${a} 条分支不是空的：${ref} 现在指着 ${now}，而这一轮钉住的底是 ${base}\n` +
          `轮次要 N 条干净的分支——它不会搬一条已有的分支头。`,
      )
    }
    await deps.truth.advance(ref, base, null)
  }
  await move('branches-started')

  // 三 · 物化：**可选，缺省不做**（`deferMaterialize`，架构 § 14.1）。做了就 N 次 `fork`，
  // 逐次都用**同一个 base**，逐次落在那个 agent 自己的日志里。
  const forks: ForkResult[] = []
  if (deps.materialize === true) {
    if (deps.logForAgent === undefined) {
      throw new RoundStartError('要铺物化却没有给 logForAgent：那一步没地方落 `mat/fork`')
    }
    for (const a of agents) {
      const agentLog = deps.logForAgent(a)
      try {
        const opts = deps.forkOpt ?? DEFAULT_MATERIALIZE
        const r = await fork({ roots: deps.roots, log: agentLog, root: deps.roots.realRoot }, a, base, opts)
        if (r.base !== base) throw new RoundStartError(`fork 回来的底不是钉住的那一个：${r.base} ≠ ${base}`)
        forks.push(r)
      } finally {
        await (agentLog as { close?: () => Promise<void> }).close?.()
      }
    }
  }

  return { owners, forks, trail }
}

/**
 * 一份契约的写入面，给 `contract/issue` 的 `paths` 那一栏用。
 *
 * **它不问 `precheck.ts` 要**：那一份的 `writeSetOf` 收的是整份契约、给的是判相交用的那一份
 * （调查型给的是目录边界）。事件里 `paths` 那一栏是**给读日志的人看"这份契约要写哪儿"**，
 * 三种来源各自那一份更直白。
 */
function writeSetOfContract(c: Contract): readonly RelPath[] {
  if (c.kind === 'implement') return c.ownedPaths
  if (c.kind === 'resolve') return c.conflictPaths
  return c.evidenceRequired.map((e) => e.artifact)
}

/**
 * 这一轮的处境：把 `round/state` 那条链重放一次。**只认这一个轮次号**——同一份日志里住着好几轮。
 *
 * 一条都没有就是 `Idle`（这一轮还没落地）。链本身由 `machine.ts` 那 12 条边保着，所以这里
 * 不需要再判"走得对不对"：**落下来的每一条都是当时判过的**（架构 § 9.4 的重放口径）。
 */
export async function roundStateOf(log: LogReader, round: RoundId): Promise<RoundState> {
  // **读口只有一处**（`round/versions.ts`）：这一份与 `loggedOf` 是同一份读数的两个投影。
  return (await roundFactsOf(log, round)).state
}

/** 这一轮在日志里留下的那三样：钉住的底 · 轮级意图那一句 · 那一份草案的正文。 */
export interface LoggedRecord {
  readonly base: CommitId | null
  readonly goal: string
  readonly draft: string | null
}

/**
 * 从日志里读回这一轮的那三样。**同一条链上取最后一条**（`round/intent` 只写一次 ·
 * `holder/distill` 每次判草案都会写一条，最后一条就是这一轮当下的那一份）。
 *
 * **按轮次号选，不按"最后一条"选**：同一份日志里住着好几轮，第二轮起草之后回头放行第一轮时，
 * "最后一条 `holder/distill`"给的是错的草案。
 */
export async function loggedOf(log: LogReader, round: RoundId): Promise<LoggedRecord> {
  // 同一条读：钉住的底 · 意图那一句 · 那一份草案一次出来（`round/versions.ts`）。
  const f = await roundFactsOf(log, round)
  return { base: f.base, goal: f.goal, draft: lastOf(f)?.body ?? null }
}

/** 放行那一趟要的几样。**草案 · 底 · 意图从那一份读数来**（`facts`，不给就自己读一遍），其余由调用方注入。 */
export interface DispatchDeps {
  readonly roots: Roots
  readonly truth: Truth
  readonly log: Log
  /**
   * **这一轮的读数**（`roundFactsOf` 那一次读的产出）。给了它，这一趟就不再自己读日志——命令行
   * 那一层读一次递下来，于是「一趟命令读一遍」成立。不给就自己读一遍（直接调这一份的单测照旧）。
   */
  readonly facts?: RoundFacts
  readonly round: RoundId
  /**
   * 第 `n` 个 agent 的身份（从 0 起 · 构造次序）。**必须与判那一趟同一个分配器**，
   * 否则放行那一下拿到的不是人批的那一批（门只认这一批）。
   */
  readonly identityFor: (n: number) => Identity
  /** 绑好的动作表（配置里 `actions.<名字>`）：持轮者给的断言只能从这里选，不猜、不补。 */
  readonly actions?: Readonly<Record<string, readonly RelPath[]>>
  readonly seedLimit?: number
  /** **声明的模型上限**（`ModelDecl.contextLimit`）：`seed` 那条算式按它算，不按这一份的缺省。 */
  readonly modelLimit?: number
  readonly logForAgent?: (a: AgentId) => Log
  readonly materialize?: boolean
  readonly forkOpt?: typeof DEFAULT_MATERIALIZE
}

/** 放行的产出：门那一趟的读数 + 发出去之后的落地结果 + 这一批的编号。 */
export interface Dispatched extends Issued {
  /**
   * 这一趟放行的是哪一轮。**它与 `round/approve` 里那一栏是同一个值**。
   *
   * 它原先不在这一份里（`Issued` 那三样是从"发出去"那一头看的），而命令行那一层读的是
   * `r.round`——于是 `round go` 人面那一行的第一栏印的是 `undefined`、`--json` 那一份里干脆
   * 没有这个键（没有编译步骤，少一栏不会当场红：`dispatch.test.ts` ① 与 `chain.test.ts` 的 C4
   * 各有一条断言盯着它）。
   */
  readonly round: RoundId
  readonly base: CommitId
  readonly built: Built
  readonly precheck: PrecheckResult
  readonly seedRead: SeedReading
  /** 这一批的编号（拆分的形状）。**一个名字，不是放行的凭证**——见这一份开头那一段。 */
  readonly fingerprint: string
}

/**
 * **门口那一批的读法**（PLAN § 5.19 的 `T6`）：`round go` 与界面上那一行队列读的是这一份。
 *
 * 为什么值得单独一个口：门上那一批契约**不是存下来的，是重算出来的**（这一份开头那一段）。于是
 * "队列行印的那批契约与 `round go` 真发出去的是同一批"这句话，只有两处走同一个函数才成立——各自
 * 写一遍的话，两处迟早按不同的输入算出两批不同的东西，而用户看到的是"我批的与它发的不是同一批"。
 *
 * 三个出口：
 *
 *   · `none` —— **门口什么都没有**（这一轮没落地 · 已经发过了 · 钉住的底找不到）。`why` 是给人
 *     看的一整句，放行那一趟直接把它当错误抛出来、一字不改（**同一句话只说一遍**）；
 *   · `broken` —— 在门口，而这一批**造不出来**（草案缺键 · 断言指向没绑的动作 · 种子超限）。每一处
 *     报得出位置，一个字节都不落；
 *   · `held` —— 停在门口，`pending.built` 就是人这一次要点头的**那一批契约值**。
 *
 * **`truth` 给不给是两档，不是两种答案**：给了就按**轮次钉住的那个底**量种子（放行那一趟），不给
 * 就按路径估（观察者那一档：界面只读账，不开真源）。两档的**契约集合相同**，只有种子读数可能差
 * ——差在哪由 `seedRead.from` 说出来（`'given'` = 这一份没量）。
 */
export interface PendingDeps {
  readonly log: LogReader
  readonly round: RoundId
  /** 第 `n` 个 agent 的身份。**必须与判那一趟同一个分配器**，否则算出来的不是人批的那一批。 */
  readonly identityFor: (n: number) => Identity
  /** 这一轮的读数（给了就不再读日志：一趟命令读一遍）。 */
  readonly facts?: RoundFacts
  readonly actions?: Readonly<Record<string, readonly RelPath[]>>
  /** 种子的那一棵树（`seedRulerAt` 在它上面取内容）。**不给就按路径估**（观察者那一档）。 */
  readonly truth?: Truth
  readonly seedTokens?: (paths: readonly RelPath[]) => number
  readonly seedLimit?: number
  readonly modelLimit?: number
}

/** 门口那一批：**放行那一趟要发的就是这个对象**。 */
export interface Pending {
  readonly round: RoundId
  readonly base: CommitId
  readonly goal: string
  readonly built: Built
  readonly precheck: PrecheckResult
  /** 这一批的编号（拆分的形状）。**一个名字，不是放行的凭证**——见这一份开头那一段。 */
  readonly fingerprint: string
  /** 种子的量法读数。`from !== 'tree'` 就是"这一份没量"。 */
  readonly seedRead: SeedReading
  /** 账上放过的那几批里**与这一批同号**的那几轮（给人看的一个读数，换不来放行）。 */
  readonly same: readonly RoundId[]
}

/** 门口那一批的三种出口。 */
export type PendingVerdict =
  | { readonly kind: 'none'; readonly why: string }
  | { readonly kind: 'broken'; readonly problems: readonly string[] }
  | { readonly kind: 'held'; readonly pending: Pending }

export async function pendingOf(deps: PendingDeps): Promise<PendingVerdict> {
  const { log, round } = deps
  const facts = deps.facts ?? (await roundFactsOf(log, round))
  const state = facts.state
  // **放行只在门口走一次**：这一批发过之后处境已经不在 `Planning`，第二次当场拒（不是静默成功，
  // 也不是发第二条契约）。
  if (state !== 'Planning') {
    const why =
      state === 'Idle'
        ? '这一轮还没落地：先跑 `fugue round plan <目标>`（人写好了草案那一档加 --judge），再来放行'
        : '这一批已经发过了——放行只在门口走一次，第二次一个字节都不落'
    return { kind: 'none', why: `这一轮的处境是 ${state}：${why}（放行只在 Planning 那一处走）。` }
  }
  // 这一轮的那三样（同一份读数：钉住的底 · 意图那一句 · 那一份草案）。
  const at = { base: facts.base, goal: facts.goal, draft: lastOf(facts)?.body ?? null }
  if (at.base === null) {
    return {
      kind: 'none',
      why:
        `日志里找不到第 ${round} 轮钉住的底：` +
        '轮次开始时落的那一条 `round/intent` 记着它（架构 § 8.14 的 C7 前半），没有它就算不出人批的是哪一批。',
    }
  }
  // 判。**与判那一趟同一个函数**（门只认契约集合）：同一份草案 · 同一个分配器 · 同一个底。
  // 种子那一份的树是**轮次钉住的那个底**——初次派发量的就是这一批要拿到的内容。
  const ruler = deps.truth === undefined ? null : seedRulerAt(deps.truth, at.base)
  const gate = await gateOf(
    { from: 'draft', goal: at.goal, text: at.draft, where: draftPathOf(round) },
    {
      round,
      base: at.base,
      identityFor: deps.identityFor,
      ...(deps.actions === undefined ? {} : { actions: deps.actions }),
      ...(ruler === null ? {} : { seedRuler: ruler as SeedMeasurer }),
      ...(deps.seedTokens === undefined ? {} : { seedTokens: deps.seedTokens }),
      ...(deps.seedLimit === undefined ? {} : { seedLimit: deps.seedLimit }),
      ...(deps.modelLimit === undefined ? {} : { modelLimit: deps.modelLimit }),
    },
  )
  if (!gate.held || gate.built === null || gate.precheck === null) {
    return { kind: 'broken', problems: gate.problems }
  }
  const fingerprint = fingerprintOf(gate.built)
  return {
    kind: 'held',
    pending: {
      round,
      base: at.base,
      goal: at.goal,
      built: gate.built,
      precheck: gate.precheck,
      fingerprint,
      seedRead: ruler === null ? { from: 'given', loaded: 0, missing: [] } : ruler.reading,
      same: facts.approvals.filter((x) => x.fingerprint === fingerprint).map((x) => x.round),
    },
  }
}

/**
 * 放行：**把门上那一批契约发出去**（`round go` 那一趟）。
 *
 * 四段的次序与 `round plan` 那一趟逐段对上，只差最后一步：处境 → 从日志读回那三样 → 判
 *（同一个函数）→ 落 `round/approve` 并发。**不成器就一个字节都不落**：退回并报出每一处，
 * 与门那一趟同一句话。
 */
export async function dispatchRound(deps: DispatchDeps): Promise<Dispatched> {
  const { log, round, truth } = deps

  // 一 · 这一轮的读数**读一遍**（给了就用给的：`DispatchDeps.facts`）。处境是它的一个投影。
  const facts = deps.facts ?? (await roundFactsOf(log, round))
  const state = facts.state

  // 二 · 门上那一批：**只有一处读法**（`pendingOf`——界面上那一行队列读的是同一个函数）。不在门口
  // 当场拒、造不出来也当场拒，两句话都由那一份给（**同一句话只说一遍**）。
  const verdict = await pendingOf({
    log,
    round,
    facts,
    identityFor: deps.identityFor,
    truth,
    ...(deps.actions === undefined ? {} : { actions: deps.actions }),
    ...(deps.seedLimit === undefined ? {} : { seedLimit: deps.seedLimit }),
    ...(deps.modelLimit === undefined ? {} : { modelLimit: deps.modelLimit }),
  })
  if (verdict.kind === 'none') throw new RoundStartError(verdict.why)
  if (verdict.kind === 'broken') {
    throw new RoundStartError(`这一批放不出去（构造器不猜、不补）：\n  ${verdict.problems.join('\n  ')}`)
  }
  const { pending } = verdict
  const built = pending.built
  const fingerprint = pending.fingerprint

  // 四 · 落那一笔放行，然后发。**顺序反了的话，读日志的人会先看见契约、后看见谁批的。**
  await log.append('round', {
    t: 'round/approve',
    round,
    fingerprint,
    contracts: built.contracts.map((c) => c.id as ContractId),
  })
  const issued = await issueAndStart(built, pending.base, state, deps)

  return {
    ...issued,
    round,
    base: pending.base,
    built,
    precheck: pending.precheck,
    seedRead: pending.seedRead,
    fingerprint,
  }
}
