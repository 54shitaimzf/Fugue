// M12 轮起头（配置那一档）：钉住底 · 判一遍 · 落意图 · 发契约 · 起分支。出处：架构 § 8.13
// （`Idle → Planning` 的触发与守卫 · `Planning → Delegated` · `Delegated → Working`）· 架构
// § 8.14 的 C7 前半（"轮次开始时钉住 base"）· 架构 § 4（`fork` 定物化的底、`branch` 定视图的底，
// 两者必须同一个提交）· 架构 § 8.12 的写入集预检第一次调用（`Planning` 那一档）· PLAN § 5.7 的
// A4 行 · PLAN § 5.10 的 C4。
//
// **这一份走的是配置那一档：人把两栏（意图 · 拆分）写给命令行，一条命令走完。** 持轮者自己拆的
// 那一档（`round plan`）停在门口，放行由 `round go` 走——两条路**判是同一处**（`contract/gate.ts`）、
// **派是同一处**（`round/dispatch.ts`），差别只在"这一批是从哪儿来的"。
//
// 这一份自己做完的两件：
//
//   1. **钉住底**：`baseFor(truth, 'round')` 读一次 HEAD。**读一次，然后传下去**——契约里的底、
//      N 条分支的底、N 次 `fork` 的底都是这同一个值。这就是 C7 前半那句话的落地：
//      轮次开始时钉住 base，之后 HEAD 再动也不影响这一轮的判据（A7 的漂移检测读的正是它）。
//      它同时落进 `round/intent`：**放行那一趟（`round go`）要拿同一个底把同一份草案重算一遍**，
//      不记它，两处算出来的就不是同一批契约。
//   2. **判一遍**（`contract/gate.ts`）：人写的那两栏（意图 · 拆分）进去，**一批契约值 + 一次预检**
//      出来——键域 · 值域 · 跨字段 · `seed` 超限都在那一处。量法（一份种子的账 = 指针清单 + 它
//      在这一轮钉住的底上取到的内容）由这一份装好交给门（`seedRulerAt`）——架构 § 8.12 那两条准则。
//
// 后两件归 `round/dispatch.ts`，与预备态那一档共用同一段代码：
//
//   3. **发契约**：N 条 `contract/issue`。契约**住日志里**（架构 § 8.12），所以事件带正文；
//      这一条边就是"契约之于派发，正如视图之于日志"。
//   4. **起分支**：N 条 `refs/heads/<agent>` 定在**同一个 base** 上——要起的那几条，
//      就是这一批契约的持有者（一个来源：身份分配器给的那个次序）。
//
// **这一档没有"停在门口"那一停。** 人写的那两栏不成立就是一次用法错（人自己能改），所以判不成器
// 当场拒、一个字节都不落；而"值不值"那一级——门默认为停那一处——是持轮者那条路的事。
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
import type { AgentId, CommitId, ContractId, RelPath, RoundId } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import { baseFor } from '../view/lower.ts'
import type { ForkResult } from '../materialize/fork.ts'
import { DEFAULT_MATERIALIZE } from '../materialize/contract.ts'
import type { Built, Identity, Intent, SplitAssignment } from '../contract/build.ts'
import { gateOf } from '../contract/gate.ts'
import type { PrecheckResult } from '../contract/precheck.ts'
import type { Cause, RoundState, StepContext } from './machine.ts'
import { step } from './machine.ts'
import type { SeedReading } from './seed.ts'
import { SEED_FROM_GIVEN, seedRulerAt } from './seed.ts'
// **判完之后那一步与预备态那一档共用**（`issueAndStart`）——同一个函数，因此两处不会各发一份。
import { RoundStartError, issueAndStart } from './dispatch.ts'
import type { TrailStep } from './dispatch.ts'

export { RoundStartError }

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
   * **声明的模型上限**（`ModelDecl.contextLimit`）。`seed` 那一条的算式要它——它是"模型上限 −
   * Zone A − 交接余量"的第一个数，而这一份不认识模型目录：命令面那一层取一次递下来（`round new` ·
   * `round run` · `round go` 三处递的是同一个数）。
   */
  readonly modelLimit?: number
  /**
   * 第 `n` 个 agent 的日志口。
**`mat/fork` 落在那个 agent 自己的日志里**，所以物化那一步要它。
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
  readonly trail: readonly TrailStep[]
}

/**
 * 轮起头。**顺序是承重的**：钉底在判之前（契约里的底要那个值，而量种子也在它上）·
 * 判在落地之前（这一档是一条命令走完，所以不成批就一个字节都不落；判据与 `Planning` 那一档
 * 是同一个，见 `contract/gate.ts`）· 意图在落地那一步之前（守卫问的是它）· 契约在分支之前
 * （`contract/issue` 里的 `owner` 要先定下来）。
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
      ...(deps.modelLimit === undefined ? {} : { modelLimit: deps.modelLimit }),
    },
  )
  if (!gate.held || gate.built === null || gate.precheck === null) {
    // **不成立就退回，不是裁剪后照发**（架构 § 8.12）。这一档没有"停在门口"：
    // 人写的那两栏不成立就是一次用法错（人自己能改），而门那一档留给持轮者那条路（`round/plan.ts`）。
    throw new RoundStartError(`这一轮派不出去（构造器不猜、不补）：\n  ${gate.problems.join('\n  ')}`)
  }
  const built = gate.built

  // 三 · `Idle → Planning`：**守卫是意图快照已建立**（架构 § 8.13 的第一个关键点）。意图进日志，
  // 与交接提示词 · 凝聚理解同一形状（`digest` + 正文）——重启之后"这一轮要干什么"重放得出。
  // **钉住的底跟着它一起落**：放行那一趟要拿同一个底把同一份草案重算一遍（`round/intent` 的 `base`）。
  const intentBody = JSON.stringify(deps.intent)
  await log.append('round', { t: 'round/intent', round, base, digest: digestOf(intentBody), body: intentBody })
  const trail: TrailStep[] = []
  let state: RoundState = 'Idle'
  const move = async (on: Cause, ctx: StepContext = {}): Promise<void> => {
    const from = state
    state = step(from, on, ctx)
    trail.push({ from, on, to: state })
    await log.append('round', { t: 'round/state', round, from, to: state })
  }
  await move('land', { intent: true })

  // 四 · 发契约 · 起分支 · 物化：**与预备态那一档（`round go`）同一段**（`round/dispatch.ts`）。
  const issued = await issueAndStart(built, base, state, {
    roots,
    truth,
    log,
    round,
    ...(deps.logForAgent === undefined ? {} : { logForAgent: deps.logForAgent }),
    ...(deps.materialize === undefined ? {} : { materialize: deps.materialize }),
    ...(deps.forkOpt === undefined ? {} : { forkOpt: deps.forkOpt }),
  })

  return {
    round,
    base,
    built,
    seedRead: ruler === null ? SEED_FROM_GIVEN : ruler.reading,
    owners: issued.owners,
    precheck: gate.precheck,
    forks: issued.forks,
    trail: [...trail, ...issued.trail],
  }
}

/** 正文的摘要：日志里 `digest` 那一栏要一个短标识。**sha256 的前十六位**，与别处同一个口径。 */
function digestOf(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}
