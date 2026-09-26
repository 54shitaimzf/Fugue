// M12 轮起头：钉住底 · 判一遍 · 发契约 · 起分支。出处：架构 § 8.13（`Idle → Planning` 的触发与守卫 ·
// `Planning → Delegated` · `Delegated → Working`）· 架构 § 8.14 的 C7 前半（"轮次开始时钉住
// base"）· 架构 § 4（`fork` 定物化的底、`branch` 定视图的底，两者必须同一个提交）·
// 架构 § 8.12 的写入集预检第一次调用（`Planning` 那一档）· PLAN § 5.7 的 A4 行。
//
// **这一份把四件事按顺序做完，一件事都不是新机制**（架构 § 14.1 那七步里的 1 · 2 · 4 · 6）：
//
//   1. **钉住底**：`baseFor(truth, 'round')` 读一次 HEAD。**读一次，然后传下去**——契约里的底、
//      N 条分支的底、N 次 `fork` 的底都是这同一个值。这就是 C7 前半那句话的落地：
//      轮次开始时钉住 base，之后 HEAD 再动也不影响这一轮的判据（A7 的漂移检测读的正是它）。
//   2. **判一遍**（`contract/gate.ts`）：人写的那两栏（意图 · 拆分）进去，**一批契约值 + 一次预检**出来——
//      键域 · 值域 · 跨字段 · `seed` 超限都在那一处。量法（一份种子的账 = 指针清单 + 它在这一轮钉住
//      的底上取到的内容）由这一份装好交给门（`seedRulerAt`）——架构 § 8.12 那两条准则。
//   3. **发契约**：N 条 `contract/issue`。契约**住日志里**（架构 § 8.12），所以事件带正文；
//      这一条边就是"契约之于派发，正如视图之于日志"。
//   4. **起分支**：N 条 `refs/heads/<agent>` 定在**同一个 base** 上——要起的那几条，
//      就是这一批契约的持有者（一个来源：身份分配器给的那个次序）。
//
// **物化是可选的一步，而且缺省不做。** 架构 § 14.1 的 `SpawnOptions.deferMaterialize` 缺省 `true`
// ——「走 D3（按需物化）」：这一轮开起来的时候，N 个 agent 一次都还没跑，铺 N 棵树是为还没发生的
// 执行付钱。所以 `materialize: true` 才 `fork`；不给就只有分支与契约。**这不是省事**：`fork` 每
// 一次都往那个 agent 的日志里落一条 `mat/fork`，而物化的底是真实工作树——把这一步挂在"开轮次"
// 上，等于要求开轮次那一刻真实工作树就是 `base` 那棵树，而 § 8.4 明说那一步不做检测。
//
// **一条分支一个写者。** `mat/fork` 落在**那个 agent 自己的日志**里（`fork` 收的 `Log` 是它的），
// 而 `round/state` · `round/intent` · `contract/issue` 落在持轮者那一份（`round`）里——契约由
// 持轮者发出去，物化是那个 agent 自己的事。于是这一份要两个口：`log`（持轮者）与
// `logForAgent`（每一个）。栅栏按 writer 分文件（§ 9.2），所以这是**两个写者**，不是一个写者
// 写两份日志：那个禁令要防的是"同一个 writer 的序号被两个进程领到"，这里每个 writer 恰好一个口。
//
// **状态机只做转移**（A3 的纪律）：这一份里每一次 `step()` 之后跟着一条 `round/state`，
// 而转移的判决全部来自 `machine.ts`——这里不自己判"能不能到那儿"。
import { createHash } from 'node:crypto'
import type { Log } from '../log/events.ts'
import type { Roots } from '../roots/contract.ts'
import type { AgentId, CommitId, ContractId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import { refFor } from '../identity.ts'
import { baseFor } from '../view/lower.ts'
import { fork } from '../materialize/fork.ts'
import type { ForkResult } from '../materialize/fork.ts'
import { DEFAULT_MATERIALIZE } from '../materialize/contract.ts'
import type { Built, Identity, Intent, SplitAssignment } from '../contract/build.ts'
import { gateOf } from '../contract/gate.ts'
import type { Contract } from '../contract/types.ts'
import type { PrecheckResult } from '../contract/precheck.ts'
import type { Cause, RoundState } from './machine.ts'
import { step } from './machine.ts'
import type { SeedReading } from './seed.ts'
import { SEED_FROM_GIVEN, seedRulerAt } from './seed.ts'

/** 这一层自己的失败：底钉不住 · 预检不放行 · 分支定不下来。**拒，并且说出是哪一步。** */
export class RoundStartError extends Error {}

/**
 * 一次轮起头的**全部输入**。逐样都指得出出处，且**没有一样是这一份自己推出来的**：
 *
 *   `intent` · `split` 是持轮者给的（架构 § 15.1 的意图 + § 15.1.a 的拆分草案）；
 *   `agent` · `branch` 由身份分配器给（§ 14.1 第 1 步）；这一份不认识它是怎么发出来的；
 *   `seeds` · `actionOutputsOf` 是预备态与动作绑定给的（§ 8.12 那张字段来源表）。
 */
export interface RoundStartDeps {
  readonly roots: Roots
  readonly truth: Truth
  readonly log: Log
  readonly round: RoundId
  readonly intent: Intent
  readonly split: readonly SplitAssignment[]
  /**
   * 第 `n` 个 agent 的身份（从 0 起 · **构造次序**：调查型在前，其余按草案次序）。
   *
   * **一个来源。** 契约里的身份 · 那几条分支 · 物化都从它来——再另给一份 agent 名单的
   * 症状是"两份次序不是同一个"：先派调查型契约时错开一格（第一份实现型拿到第二个身份），而两份
   * 身份都合法——那种错在日志里看不出来（架构 § 14.1 第 1 步）。
   */
  readonly identityFor: (n: number) => Identity
  /**
   * 逐份的种子（指针清单），**与构造次序同序**。**给值而不是给函数**：量的那一批与
   * 发出去的那一批要是同一批（一个函数没有纯的保证）。不给就是这一轮没有种子。
   */
  readonly seeds?: readonly (readonly RelPath[])[]
  /** 动作绑定声明的产出：逐份给（动作名 → 产出路径）。不给就是这一批一份都不声明。 */
  readonly actionOutputsOf?: (n: number) => Readonly<Record<string, readonly RelPath[]>>
  /**
   * 一份种子的量法。**不给就按这一轮钉住的那个底取一次内容**（`seedRulerAt`）：种子是路径的指针，
   * 而账量的是「这些指针取出多少」（架构 § 8.12）——只量清单那一侧的话，那个上界（模型上限 − Zone A −
   * 交接余量）对着一条几行的清单永远不响。给了就用给的：测试与“从别的树取”那一档从这个口进来。
   */
  readonly seedTokens?: (paths: readonly RelPath[]) => number
  readonly seedLimit?: number
  /**
   * 第 `n` 个 agent 的日志口。**`mat/fork` 落在那个 agent 自己的日志里**，所以物化那一步要它。
   * 不给就是“这一轮不物化”（`materialize` 也就无从谈起）。
   */
  readonly logForAgent?: (a: AgentId) => Log
  /**
   * 要不要在这一步就把物化铺出来（架构 § 14.1 的 `deferMaterialize`）。**缺省不铺。**
   * 给了 `true` 而没给 `logForAgent` → 当场拒：那一步没地方落事件。
   */
  readonly materialize?: boolean
  /** 铺物化那一档的选项（不给按 `DEFAULT_MATERIALIZE`）。 */
  readonly forkOpt?: typeof DEFAULT_MATERIALIZE
}

/** 一次轮起头的产出：那几份契约 · 那个底 · 那几条分支的落地结果。 */
export interface RoundStart {
  readonly round: RoundId
  /** **钉住的那个底**——契约里的底、四条分支的底、四次 `fork` 的底都是它。 */
  readonly base: CommitId
  readonly built: Built
  /** 种子那一份的读数：量法 · 取到几份内容 · 哪几条在这一棵树上没有（读数，不参与判断）。 */
  readonly seedRead: SeedReading
  readonly owners: Readonly<Record<ContractId, AgentId>>
  /** 第一次写入集预检的结果（门里跑的 · 报出相交而照发；见 PLAN § 5.7 的口径一）。 */
  readonly precheck: PrecheckResult
  /** 铺出来的那几棵树。**没铺就是空的**——`deferMaterialize` 缺省为真。 */
  readonly forks: readonly ForkResult[]
  readonly trail: readonly { readonly from: RoundState; readonly on: Cause; readonly to: RoundState }[]
}

/**
 * 轮起头。**顺序是承重的**：钉底在判之前（契约里的底要那个值，而量种子也在它上）·
 * 判在落地之前（这一档是一条命令走完，所以不成批就一个字节都不落；判据与 `Planning` 那一档
 * 是同一个，见 `contract/gate.ts`）· 契约在分支之前（`contract/issue` 里的 `owner` 要先定下来）。
 */
export async function startRound(deps: RoundStartDeps): Promise<RoundStart> {
  const { roots, truth, log, round } = deps

  // 一 · 钉住底。**读一次，然后一路传下去**——这就是 C7 前半。
  const base = await baseFor(truth, 'round')
  if (base === null) {
    throw new RoundStartError(
      '真实工作树的 HEAD 还不存在：轮次的底就是它（架构 § 8.14 的 C7）。先提交一次，再来开轮次。',
    )
  }

  // 二 · 判：这两栏（意图 · 拆分）与逐份种子进去，一批契约值加一次预检出来。
  //
  // **量法在这一处装**：不给 `seedTokens` 就按这一轮钉住的那个底把每一份种子取
  // 一次内容——同一份尺同时给了门里的度量与这一份的读数（`seedRead`）。
  const seeds = deps.seeds ?? []
  const ruler = deps.seedTokens === undefined ? seedRulerAt(truth, base) : null
  const gate = await gateOf(
    { from: 'split', intent: deps.intent, split: deps.split, seeds },
    {
      round,
      base,
      identityFor: deps.identityFor,
      ...(deps.actionOutputsOf === undefined ? {} : { actionOutputsOf: deps.actionOutputsOf }),
      ...(ruler === null ? { seedTokens: deps.seedTokens } : { seedRuler: ruler }),
      ...(deps.seedLimit === undefined ? {} : { seedLimit: deps.seedLimit }),
    },
  )
  if (!gate.held || gate.built === null || gate.precheck === null) {
    // **不成立就退回，不是裁剪后照发**（架构 § 8.12）。这一档没有"停在门口"：
    // 人写的那两栏不成立就是一次用法错（人自己能改），而门那一档留给持轮者那条路（`round/plan.ts`）。
    throw new RoundStartError(`这一轮派不出去（构造器不猜、不补）：\n  ${gate.problems.join('\n  ')}`)
  }
  const built = gate.built

  // **要起分支的那几条 = 这一批契约的持有者**。一个来源：身份分配器给的那个
  // 次序（调查型在前）——再另给一份 agent 名单的话，两份次序一旦不同就错开一格，
  // 而那种错在日志里看不出来。
  const agents = [...new Set(built.contracts.map((c) => c.agent as AgentId))]
  if (agents.length === 0) {
    throw new RoundStartError('这一批一份契约都没有：轮次至少要有一份契约与一条分支')
  }

  // 三 · 状态机那三步。每一步的判决都来自 `machine.ts`，这里只记转移与落事件。
  const trail: { from: RoundState; on: Cause; to: RoundState }[] = []
  let state: RoundState = 'Idle'
  const move = async (on: Cause, ctx: Parameters<typeof step>[2] = {}): Promise<void> => {
    const from = state
    state = step(from, on, ctx)
    trail.push({ from, on, to: state })
    await log.append('round', { t: 'round/state', round, from, to: state })
  }

  // `Idle → Planning`：**守卫是意图快照已建立**（架构 § 8.13 的第一个关键点）。意图进日志，
  // 与交接提示词 · 凝聚理解同一形状（`digest` + 正文）——重启之后"这一轮要干什么"重放得出。
  const intentBody = JSON.stringify(deps.intent)
  await log.append('round', { t: 'round/intent', round, digest: digestOf(intentBody), body: intentBody })
  await move('land', { intent: true })

  // 四 · 发契约：一份一条。**契约住日志里**（架构 § 8.12）——事件带正文，重放读得出。
  const owners: Record<ContractId, AgentId> = {}
  for (const c of built.contracts) {
    owners[c.id] = c.agent as AgentId
    await log.append('round', {
      t: 'contract/issue',
      round,
      contract: c.id,
      owner: c.agent as AgentId,
      paths: [...writeSetOfContract(c)],
      body: JSON.stringify(c),
    })
  }
  await move('contracts-issued')

  // 五 · 起分支：**N 条分支定在同一个 `base` 上**。用 git 直接指（§ 4：`fugue branch` 是一条
  // 方便的路，不是一个前提），CAS 的 `expectedOld` 是 `null`——"它必须还不存在"。
  // 已经指着同一个提交算成功（幂等的那一半），指着别处才拒。
  for (const a of agents) {
    const ref = refFor(a as WriterId)
    const now = await baseFor(truth, a as WriterId)
    if (now === base) continue
    if (now !== null) {
      throw new RoundStartError(
        `第 ${a} 条分支不是空的：${ref} 现在指着 ${now}，而这一轮钉住的底是 ${base}\n` +
          `轮次要 N 条干净的分支——它不会搬一条已有的分支头。`,
      )
    }
    await truth.advance(ref, base, null)
  }
  await move('branches-started')

  // 六 · 物化：**可选，缺省不做**（`deferMaterialize`，架构 § 14.1）。做了就 N 次 `fork`，
  // 逐次都用**同一个 base**，逐次落在那个 agent 自己的日志里。
  const forks: ForkResult[] = []
  if (deps.materialize === true) {
    if (deps.logForAgent === undefined) {
      throw new RoundStartError('要铺物化却没有给 logForAgent：那一步没地方落 `mat/fork`')
    }
    for (const a of agents) {
      const agentLog = deps.logForAgent(a)
      try {
        const r = await fork({ roots, log: agentLog, root: roots.realRoot }, a, base, deps.forkOpt ?? DEFAULT_MATERIALIZE)
        if (r.base !== base) throw new RoundStartError(`fork 回来的底不是钉住的那一个：${r.base} ≠ ${base}`)
        forks.push(r)
      } finally {
        await (agentLog as { close?: () => Promise<void> }).close?.()
      }
    }
  }

  return {
    round,
    base,
    built,
    seedRead: ruler === null ? SEED_FROM_GIVEN : ruler.reading,
    owners,
    precheck: gate.precheck,
    forks,
    trail,
  }
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

/** 正文的摘要：日志里 `digest` 那一栏要一个短标识。**sha256 的前十六位**，与别处同一个口径。 */
function digestOf(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}
