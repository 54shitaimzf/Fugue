// M12 轮起头：钉住底 · 发契约 · 起分支。出处：架构 § 8.13（`Idle → Planning` 的触发与守卫 ·
// `Planning → Delegated` · `Delegated → Working`）· 架构 § 8.14 的 C7 前半（"轮次开始时钉住
// base"）· 架构 § 4（`fork` 定物化的底、`branch` 定视图的底，两者必须同一个提交）·
// 架构 § 8.12 的写入集预检第一次调用（`Planning` 那一档）· PLAN § 5.7 的 A4 行。
//
// **这一份把五件事按顺序做完，一件事都不是新机制**（架构 § 14.1 那七步里的 1 · 2 · 4 · 6）：
//
//   1. **钉住底**：`baseFor(truth, 'round')` 读一次 HEAD。**读一次，然后传下去**——契约里的底、
//      N 条分支的底、N 次 `fork` 的底都是这同一个值。这就是 C7 前半那句话的落地：
//      轮次开始时钉住 base，之后 HEAD 再动也不影响这一轮的判据（A7 的漂移检测读的正是它）。
//   2. **量一遍种子**（架构 § 8.12 的 `seed` 那两条准则）：在这一轮钉住的底上把每一份种子取
//      一次内容，量成 token。契约里那一栏因此是**判过的**，不是一条谁也不看的清单。
//   3. **构造契约**（A1）并在 `Planning` 那一档跑一次预检（A2 的第一个调用点）。
//   4. **发契约**：N 条 `contract/issue`。契约**住日志里**（架构 § 8.12），所以事件带正文；
//      这一条边就是"契约之于派发，正如视图之于日志"。
//   5. **起分支**：N 条 `refs/heads/<agent>` 定在**同一个 base** 上。
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
import type { AgentId, BranchId, CommitId, ContractId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import { refFor } from '../identity.ts'
import { baseFor } from '../view/lower.ts'
import { fork } from '../materialize/fork.ts'
import type { ForkResult } from '../materialize/fork.ts'
import { DEFAULT_MATERIALIZE } from '../materialize/contract.ts'
import type { Built, BuildDeps, Intent, SplitAssignment } from '../contract/build.ts'
import { build } from '../contract/build.ts'
import type { Contract } from '../contract/types.ts'
import type { PrecheckResult } from '../contract/precheck.ts'
import { planningGate } from '../contract/precheck.ts'
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
 *   `seedOf` · `actionOutputsOf` 是预备态与动作绑定给的（§ 8.12 那张字段来源表）。
 */
export interface RoundStartDeps {
  readonly roots: Roots
  readonly truth: Truth
  readonly log: Log
  readonly round: RoundId
  readonly intent: Intent
  readonly split: readonly SplitAssignment[]
  readonly agents: readonly AgentId[]
  readonly branchOf: (agent: AgentId) => BranchId
  readonly seedOf: (agent: AgentId) => readonly RelPath[]
  readonly actionOutputsOf?: (agent: AgentId) => Readonly<Record<string, readonly RelPath[]>>
  /**
   * 一份种子的量法。**不给就按这一轮钉住的那个底取一次内容**（`seedRulerAt`）：种子是路径的
   * 指针，而账量的是「这些指针取出多少」（架构 § 8.12）——只量清单那一侧的话，那个上界
   * （模型上限 − Zone A − 交接余量）对着一条几行的清单永远不响。给了就用给的：测试与
   * "从别的树取"那一档从这个口进来。
   */
  readonly seedTokens?: (paths: readonly RelPath[]) => number
  readonly seedLimit?: number
  /**
   * 第 `n` 个 agent 的日志口。**`mat/fork` 落在那个 agent 自己的日志里**，所以物化那一步要它。
   * 不给就是"这一轮不物化"（`materialize` 也就无从谈起）。
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
  /** `Planning` 那一档的预检结果（报出相交而照发；见 PLAN § 5.7 的口径一）。 */
  readonly precheck: PrecheckResult
  /** 铺出来的那几棵树。**没铺就是空的**——`deferMaterialize` 缺省为真。 */
  readonly forks: readonly ForkResult[]
  readonly trail: readonly { readonly from: RoundState; readonly on: Cause; readonly to: RoundState }[]
}

/**
 * 轮起头。**顺序是承重的**：钉底在构造之前（契约里的底要那个值）· 构造在派发之前 ·
 * 预检在移出 `Planning` 之前（架构 § 8.12：第一次预检是 `Planning` 的**权威判定**）·
 * 分支在契约之后（`contract/issue` 里的 `owner` 要先定下来）。
 */
export async function startRound(deps: RoundStartDeps): Promise<RoundStart> {
  const { roots, truth, log, round, agents } = deps
  if (agents.length === 0) throw new RoundStartError('一个 agent 都没有：轮次至少要有一条分支')

  // 一 · 钉住底。**读一次，然后一路传下去**——这就是 C7 前半。
  const base = await baseFor(truth, 'round')
  if (base === null) {
    throw new RoundStartError(
      '真实工作树的 HEAD 还不存在：轮次的底就是它（架构 § 8.14 的 C7）。先提交一次，再来开轮次。',
    )
  }

  // 二 · 量一遍种子，再构造契约。**顺序是承重的**：量法要一个已经装好的值（`build` 是纯函数），
  // 而"装"这一步要这一轮钉住的底——所以它在构造之前，与钉底之后。
  //
  // **逐份的种子在这里取一次定下来**，构造器读的就是这一份：两处各调一次 `deps.seedOf` 的症状
  // 是"量的那一批与发出去的那一批可以不是同一批"（`seedOf` 是调用方给的函数，没有纯的保证）。
  const seeds = new Map<AgentId, readonly RelPath[]>()
  for (const a of agents) seeds.set(a, deps.seedOf(a))
  const ruler = deps.seedTokens === undefined ? seedRulerAt(truth, base) : null
  if (ruler !== null) await ruler.load([...seeds.values()].flat())
  const seedTokens = ruler === null ? deps.seedTokens : ruler.tokensOf

  // 三 · 构造契约。`agent` 逐份不同，所以 `identityFor` 从 `agents` 里取。
  const buildDeps: BuildDeps = {
    round,
    base,
    identityFor: (n: number) => {
      const a = agents[n]
      if (a === undefined) throw new RoundStartError(`拆分草案要第 ${n + 1} 个 agent，而这一轮只有 ${agents.length} 个`)
      return { agent: a, branch: deps.branchOf(a) }
    },
    split: deps.split,
    seedOf: (n: number) => {
      const a = agents[n]
      if (a === undefined) throw new RoundStartError(`种子要第 ${n + 1} 个 agent，而这一轮只有 ${agents.length} 个`)
      const got = seeds.get(a)
      if (got === undefined) throw new RoundStartError(`第 ${n + 1} 个 agent 的种子没量过：${a}`)
      return got
    },
    actionOutputsOf: (n: number) => {
      const a = agents[n]
      if (a === undefined || deps.actionOutputsOf === undefined) return {}
      return deps.actionOutputsOf(a)
    },
    ...(seedTokens === undefined ? {} : { seedTokens }),
    ...(deps.seedLimit === undefined ? {} : { seedLimit: deps.seedLimit }),
  }
  const built = build(deps.intent, buildDeps)

  // 四 · 状态机那三步。每一步的判决都来自 `machine.ts`，这里只记转移与落事件。
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

  // 五 · 第一次写入集预检：`Planning` 那一档的**权威判定**（架构 § 8.12）。
  const gate = planningGate(built.contracts)
  if (!gate.ok) {
    // 这一站的口径是"报出照发"，所以这里到不了。留着它是为了让"改主意的代价是一处"这句话成立：
    // 把 `planningGate` 的 `ok` 改成 `false`，这一条就接住了。
    await move('abort')
    throw new RoundStartError(`写入集预检不放行（${round}）：\n  ${gate.result.lines.join('\n  ')}`)
  }

  // 六 · 发契约：一份一条。**契约住日志里**（架构 § 8.12）——事件带正文，重放读得出。
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

  // 七 · 起分支：**N 条分支定在同一个 `base` 上**。用 git 直接指（§ 4：`fugue branch` 是一条
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

  // 八 · 物化：**可选，缺省不做**（`deferMaterialize`，架构 § 14.1）。做了就 N 次 `fork`，
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
    precheck: gate.result,
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
