// 预备态那一趟：持轮者自己读 · 自己设计 · 自己拆。出处：架构 § 15.1.a（落地 · 四步里的"拆" ·
// "预备态的出口是一道默认为停的门" · "预备态就是 `Planning`"）· 架构 § 15.1 纪律 2（意图只写
// 一次）· 架构 § 8.13 的 `Idle → Planning`（守卫：意图快照已建立）· PLAN § 5.10 的 `C0`/`C1`。
//
// **这一份不认识模型是怎么调的，也不认识命令行**：`call`（怎么调模型）· `execute`（怎么执行一次
// 工具调用）· `openView`（持轮者写哪儿）都是注入的。它只按顺序做四件事：
//
//   一 · 钉住底，把轮级意图写进日志，走 `Idle → Planning`（判决来自 `machine.ts`，这里不自己判）
//   二 · 让持轮者跑一趟（`HOLDER_PROTOCOL` · 一个写者口 `round` · 没有契约 · 没有分支 · 没有物化）
//   三 · 把草案从视图里读回来、落成日志正文（`holder/distill` 那一路的 `digest` + 正文），
//        再用 `draftOf` 判它的键域
//   四 · 印每一格的预估占用（与 `contextLimit` 的差额），停在门口
//
// **出口三档，而判据只有一个。** 模型声明（`exit_plan_mode`）· Harness 判自然结束（`end-turn` ·
// 步数到顶 · 半截流）· 人喊停（`judgeOnly`：不请模型跑，拿视图里那一份直接判）——三条路收完
// 都走同一个判（`draftOf` 的键域）。所以"模型知不知道什么时候算拆完"这件事不押在模型身上：
// `exit_plan_mode` 是**快路**（省一趟），不是唯一出口（架构 § 15.1.a 的三条路）。
//
// **这一份一个契约都不发 · 一条分支都不起 · 一片物化都不铺。** 那三样归 `round go`（架构
// § 15.1.a："落地不是不可逆的一刻，派发才是"）。于是"这一趟跑完了"与"这一轮派发了"是两件事。
import type { CommitId, RelPath, RoundId } from '../terms.ts'
import type { AgentId } from '../terms.ts'
import type { Log, LogSeq } from '../log/events.ts'
import type { Truth } from '../truth/contract.ts'
import type { View } from '../view/contract.ts'
import type { AgentHandle, CallModel, ToolCallRequest, ToolExecutor, ToolResult } from '../runtime/step.ts'
import { createRuntime } from '../runtime/step.ts'
import type { ModelDecl } from '../model/contract.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import { emptyState, sourcesFor, stepBudgetLine } from '../assemble/sources.ts'
import { assemble } from '../assemble/assemble.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { estimateTokensOfText, planBudget } from '../runtime/budget.ts'
import { digestOf } from '../runtime/restart.ts'
import { baseFor } from '../view/lower.ts'
import type { Cause, RoundState, StepContext } from './machine.ts'
import { step } from './machine.ts'
import type { DraftKind, DraftSection } from '../contract/draft.ts'
import { draftPathOf, draftRuleTextOf } from '../contract/draft.ts'
import type { Identity } from '../contract/build.ts'
import { seedTextOf } from '../contract/build.ts'
import type { GateVerdict } from '../contract/gate.ts'
import { gateOf } from '../contract/gate.ts'
import type { SeedReading } from './seed.ts'
import { seedRulerOf } from './seed.ts'
import { landingOf, lastOf, roundFactsOf } from './versions.ts'
import type { DistillVersion, RoundFacts } from './versions.ts'

/** 这一层自己的失败：底钉不住 · 视图打不开。**草案不成立不是它**——那是门的一份读数（`gate.problems`）。 */
export class PlanError extends Error {}

/**
 * 这一趟是怎么收的工。**三档的名字就是架构 § 15.1.a 那张表的三行**，而它们**不改变判据**：
 *
 *   `declared` —— 模型调了 `exit_plan_mode`（快路：省一趟空转）；
 *   `natural`  —— Harness 判自然结束（`end-turn` · 步数到顶 · 半截流——"一轮工具调用之后没有
 *                 后续"也算）；
 *   `judged`   —— 人喊停（`--judge`：这一趟不请模型跑，拿手里那一份直接判）。
 *
 * 人工那一档是地板：模型换了 · 协议换了 · `exit_plan_mode` 哪天不叫这个名字了，人喊停那一下
 * 照样把门打开（PLAN § 5.10 那条"三档共一个判据"）。
 */
export type HolderExit = 'declared' | 'natural' | 'judged'

/** 跑一趟要的东西。**全是值或注入的接缝**，这一份不读配置、不读命令行。 */
export interface PlanDeps {
  /**
   * **调用方钉住的底**（`pinnedBase` 一处读定）。视图也铺在它上面，所以这两栏必须同源：
   * 分开各读一次的症状是"视图的底与日志里那一句话不是同一个提交"，而两处都不报错。
   */
  readonly base: CommitId
  /**
   * 持轮者的视图。**写它的是这一份，判它读的也是这一份**——同一个对象，不是同一个对象的话
   * 判出来的是"草案不在视图里"（那正是产品里两处各开一份视图的症状）。
   */
  readonly view: View
  /**
   * **持轮者那一个写者口**（`round`）。
   *
   * 轮级事件只有这一个口（架构 § 9.2 的栅栏按 writer 分文件）：`round/intent` · `round/state` ·
   * `holder/distill` 都落在它上面。给第二张口就是"同一个 writer 的序号被两个进程领到"。
   */
  readonly log: Log
  /**
   * **这一轮的读数**（`roundFactsOf` 那一次读的产出）。给了它，这一趟就不再自己读日志——命令行
   * 那一层读一次递下来，于是「一趟命令读一遍」成立。不给就自己读一遍（直接调这一份的单测照旧）。
   */
  readonly facts?: RoundFacts
  readonly round: RoundId
  /** 轮级意图那一句（`round plan <目标>`）。**只写一次**（架构 § 15.1 纪律 2）。 */
  readonly goal: string
  /**
   * 持轮者那一步的句柄。**协议那一栏必须是 `HOLDER_PROTOCOL`**（`coord` 是 `null`：它手里是
   * 全部契约，不是一份——`src/capability/dispatch.ts` 的 `holder` 那一格就是按这个值判的）。
   */
  readonly handle: AgentHandle
  readonly decl: ModelDecl
  readonly call: CallModel
  readonly execute: ToolExecutor
  readonly tools?: readonly ToolEntry[]
  readonly maxSteps?: number
  /** 草案在视图里的路径。缺省 `draftPathOf(round)`（保留前缀那一处，架构 § 9.10）。 */
  readonly draftPath?: RelPath
  /**
   * **人喊停那一档**：不请模型跑，拿视图里那一份草案直接判。
   *
   * 它一个开关、不是一份新状态（PLAN § 5.10）：走的还是同一个判（键域），所以"人喊停"与
   * "模型说完了"收完的结果一样——差别只在谁触发的。
   */
  readonly judgeOnly?: boolean
  /**
   * 第 `n` 个 agent 的身份（从 0 起 · **构造次序**：调查型在前，其余按草案次序）。
   *
   * **门上这一份与派发那一轮该是同一个分配器**：门只认契约集合，而集合里每一份的
   * `agent`/`branch` 就是它给的（架构 § 14.1 第 1 步）——两处不同的话，放行那一下拿到的
   * 就不是人批的那一批。
   */
  readonly identityFor: (n: number) => Identity
  /**
   * 绑好的动作表：名字 → 它声明的产出（配置里 `actions.<名字>` 那一条）。
   *
   * **持轮者给的断言只能从这里选**（架构 § 8.12：`assertions` 的候选是工作区配置）——
   * 给一个没绑的名字就当场退回并指出有哪几个，不猜、不补、不替它挑（PLAN § 5.10 的 C1 ⑦）。
   * 一个都没绑也是一份合法的表：那时任何断言都退回。
   */
  readonly actions: Readonly<Record<string, readonly RelPath[]>>
  /** 每一格的预估占用要的那几样（给"规模对齐模型能力"那句一个能验的形状）。 */
  readonly occupancy: OccupancyContext
}

/** 一格（将来的一个子 agent）的预估占用。**它是估账，不是读数**——读数在 `llm/call` 里。 */
export interface OccupancyRow {
  /** 第几节（从 1 起，与身份发的序号同一个）。 */
  readonly at: number
  readonly kind: DraftKind
  readonly goal: string
  /** `seed` 那一段自己的估账（token，与 `used` 同一个口径）。 */
  readonly seed: number
  /** 三区 + 工具目录 + `seed`（**按那把尺估出来的 token**：与上限 · 触发点 · 余量同一个口径）。 */
  readonly used: number
  /** `contextLimit − used`，可以是负的。 */
  readonly headroom: number
  readonly trigger: number
  readonly handoffMargin: number
  /** **落在甜点区间里**（见 `occupancyOf` 那一段：口径由 `budget` 那三个数定，不是拍一个比例）。 */
  readonly sweet: boolean
  /** 一句人读的原因（进报告，不参与判断）。 */
  readonly why: string
}

/** 估账要的那几样。**`base` 那一份状态是配置的投影**（项目方针 · 系统状态 · 代码树照真的来）。 */
export interface OccupancyContext {
  readonly decl: ModelDecl
  readonly base: AssembleState
  readonly goal: string
  readonly round: RoundId
  readonly maxSteps?: number
  /** 工具目录那一段的**正文**（公布给模型的那一份序列化之后——架构 § 8.11 表外那一项）。 */
  readonly tools: string
  /**
   * 一份种子的**正文**：指针清单 + 在这棵树上取到的内容。
   *
   * **不给就只量指针那一侧**（`seedTextOf`）。预备态那一趟递的是在**持轮者这份视图**上取过内容
   * 的量法（`round/seed.ts`）：视图铺在同一个底上，而"这一格装得下装不下"量的是真的取得到的那
   * 份内容——只量清单的话，那个上界（模型上限 − Zone A − 交接余量）对着几行清单永远不响。
   */
  readonly seedText?: (paths: readonly RelPath[]) => string
}

/** 一趟之后手上有什么。**`held` 只由键域定**（"这一站唯一的门是键域完整性"，PLAN § 5.10）。 */
export interface PlanResult {
  readonly round: RoundId
  readonly base: CommitId
  readonly exit: HolderExit
  readonly steps: number
  /** 为什么停（`收敛` / `步数到顶（4）` / `cut-stream：…` / 人喊停那一句）。 */
  readonly stopped: string
  /** 草案文件的原文（视图里那一份，逐字节）。没写出来就是 `null`。 */
  readonly draftText: string | null
  /**
   * **这一趟落下的那一版**（`holder/distill` 那一格）。没落就是 `null`。
   *
   * 命令行拿它把那一版接回**开跑时读的那份读数**上（`withVersion`）——印版本那一栏因此不需要在
   * 写完之后再读一遍日志（读一次与读两次之差就在这一栏上）。
   */
  readonly landing: DistillVersion | null
  /**
   * 判出来的那一份：键域 · 值域 · 跨字段 · 绑定 · 预检（`contract/gate.ts` 一处）。
   *
   * **门停着的时候 `gate.built` 就是门后面那一批契约值**——一个字节都没发。放行那一下
   * （`round go`）把同一份草案再判一遍，得到的是同一批值。
   */
  readonly gate: GateVerdict
  /** 种子那一份的读数：取到几份内容 · 哪几条在这一棵树上没有（读数，不参与判断）。 */
  readonly seedRead: SeedReading
  readonly occupancy: readonly OccupancyRow[]
  /** 停在门口（键域完整）。**它不派发**——派发是 `round go`（架构 § 15.1.a：门仍由人开）。 */
  readonly held: boolean
  readonly seqs: readonly LogSeq[]
}

/**
 * 持轮者那一格拒绝的那几条，逐条一句指路的话。
 *
 * **工具目录不变**（架构 § 8.11 要求 Zone A 含工具目录，而 § 15.4 那一句写着"权限差别不能体现为
 * 额外的工具"）：持轮者拿到的还是那十二条，差别只落在**作用域**上——它没有物化树
 * （架构 § 15.1.a："预备态没有契约 · 没有分支 · 没有物化"），也**不提交**（'A′' 那一档：草案
 * 跟着事件进日志，盘上不落第三处）。所以这两类调用当场回一句实话，而不是抛。
 *
 * **回一句而不是抛**：抛出去在 `runtime/step.ts` 那里是一条 `tool-threw`，那一趟当场结束——
 * 而"它伸手拿了个这一格没有的东西"是**它要看见**的一件事（与 `exit_plan_mode` 对子 agent
 * 那一句同一个形状）。
 */
const HOLDER_REFUSAL: Readonly<Record<string, string>> = {
  bash: '这一格没有可执行的树：预备态不物化（架构 § 15.1.a）。读文件用 read · glob · grep，要写用 write · edit。',
  run_action: '同上：预备态不物化，动作没有地方跑（架构 § 15.1.a）。要判什么，等派发之后由验收那一档跑。',
  checkpoint: '预备态不提交：草案跟着事件进日志就够了（架构 § 15.1.a——退回讨论态时没有东西要撤销）。',
}

/** `holderFace` 的那一栏：模型说了"预备态做完了"那一下。 */
export interface HolderFaceOptions {
  readonly onDeclare?: () => void
}

/**
 * 把一份工具执行器收成**持轮者那一格的形状**：作用域之外的那几条回一句实话，`exit_plan_mode`
 * 的那一下记下来（这一趟是"模型声明"那一档收的工）。
 *
 * **它不改工具目录**：公布的还是那十二条（`catalog.ts` 一处给）。这一层只按名字拦三条，而名字
 * 全部来自目录——没有一处现编一个名字。
 */
export function holderFace(inner: ToolExecutor, opts: HolderFaceOptions = {}): ToolExecutor {
  return {
    async execute(call: ToolCallRequest, h: AgentHandle): Promise<ToolResult> {
      const why = HOLDER_REFUSAL[call.name]
      if (why !== undefined) return { ok: false, output: why }
      const r = await inner.execute(call, h)
      if (call.name === 'exit_plan_mode' && r.ok && r.halt === true) opts.onDeclare?.()
      return r
    },
  }
}

/**
 * **持轮者那一趟的收工口径**：这一格最多几步 · 这一格没有可执行的树。
 *
 * 它与上面那张 `HOLDER_REFUSAL` 是一件事的两面：这里是**先说在前面**，那里是它伸手之后回的那
 * 一句。两面都要有，因为只有后面那一面的后果是**一步一次**的——真档读数（`tools/scenario/
 * board.sh` 第一趟 · 两案都在步数上界上停住 · `--dump-wire` 实录）里，持轮者最后四步全在调
 * `bash`：目标那一句说"check 不通过"、项目方针那一句说"写完就核"，两处都在催它去跑，而预备态
 * 没有树。四步烧完，草案一个字节都没写，门退回。
 *
 * **这里不说"别调工具了，说完交卷"**（子 agent 那一份有这一句）：架构 § 15.1.a 那一句"拆完了
 * 不借工具调用表达"——持轮者那一趟的收工由 `end-turn` 与那道门判，不押在它的自觉上。所以这一
 * 份只说它无从得知的事实：几步 · 有没有树 · **这一趟的产物是哪一份、不碰什么**。
 *
 * 步数那一句与 `runtime/step.ts` 停下来用的那个数**同源**：两处读的都是 `wire.maxSteps`
 * （`cli/fugue.ts` 的 `holderWiringOf` 与 `roundPlan`）——一个数的两处用法，不是两个数。
 */
export function holderClosingRuleLines(maxSteps?: number): readonly string[] {
  return [
    ...stepBudgetLine(maxSteps),
    '这一格没有可执行的树：预备态不物化，`bash` 与 `run_action` 试也不会通——要判什么，派发之后由验收那一档跑。',
    // 另两句是**这一趟的产物与它的边界**（样本盘第二趟真档照出来的两处）：一趟 4 步自然收工
    // 而草案空——它觉得自己说完了；一趟把 `write` 打在 `src/fields.js` 上被 `plan-scope` 当场
    // 拒——它把目标那一句"改这个文件"当成了自己的活，那一趟就废了。两处都不是"拒绝得不对"，
    // 是**伸手之前没人告诉它这一趟要交什么、不碰什么**。
    '这一趟的产物是那份草案文件（写哪儿 · 什么形状见下）：它没写出来，这一趟就等于没跑。',
    '这一趟不动工作树里的源码：你要交的是"怎么拆"，改代码是拆分之后那些格的事。',
  ]
}

/**
 * 持轮者那一趟「工作总目标」那一段的正文：人的意图 + **收工口径那两句** + 末尾那一句产物说明。
 *
 * **那两句为什么跟着这一句走**：持轮者的 B 区里没有「我的任务」那一段（架构 § 8.11：它手里是
 * 全部契约，不是一份），而"这一格最多几步" · "这一格有没有可执行的树"是**每一格**都要有的两样
 * 事实——子 agent 那一份由「我的任务」带，持轮者这一份没有那一段可挂。
 *
 * **位置**：收工口径在产物说明**之前**，末尾留给"这一趟写哪儿 · 写成什么形状"（架构 § 8.12 那
 * 句"近因最好"要的就是它落在模型动手的那个位置）；把收工口径放末尾，模型读完就先收工、后写草案。
 *
 * **讨论态那一趟不走这里**（`draftPath` 那一栏不给）：那一趟的产物是那场对话的凝聚，不落文件。
 */
export function holderGoalText(
  goal: string,
  draftPath: RelPath,
  actionNames: readonly string[] = [],
  maxSteps?: number,
): string {
  return `${goal}\n\n${holderClosingRuleLines(maxSteps).join('\n')}\n\n${draftRuleTextOf(draftPath, actionNames)}`
}

/**
 * 每一格的预估占用：`Zone A + Zone B + seed + 交接余量` 与 `contextLimit` 的差额。
 *
 * **它是"拆分规模对齐模型能力"这句话唯一能验的形状**（PLAN § 5.10 的 C1 断言④）。口径分两半：
 *
 *   · **规模由模型控制**——拆几格、每格写哪些路径，都是它的事，这一份一个数都不替它定；
 *   · **甜点区间那个数是架构的**——`used + 交接余量 ≤ 触发点`。两个端点都从 `ModelDecl.budget`
 *     读（`triggerAt(contextLimit)` 与 `handoffMargin`），所以它不是拍一个比例：**这一格从头
 *     跑到尾不用交接，且交接余量也放得下**。`B7` 的读数将来只用来收窄这条带，不改形状。
 *
 * 三区怎么来的：拿**子 agent 那一份协议**（`SUBAGENT_PROTOCOL`）与一节草案拼一次真装配
 * （`assemble` 是纯函数），`seed` 那一段交给同一把尺估——**"这一格装得下装不下"与上限 · 触发点 · 余量因此落在同一个口径上**。`base` 那一份状态由调用方给（项目方针 ·
 * 系统状态 · 代码树都是真的），这一份只按节覆盖"这一格自己的那几段"。
 *
 * **估账不是读数**：真读数在 `llm/call` 的 `usage` 里（派发之后才有）。这一份的用处只有一处
 * ——在派发之前把"这一格装得下装不下"印给人看。
 */
export function occupancyOf(sections: readonly DraftSection[], ctx: OccupancyContext): readonly OccupancyRow[] {
  return sections.map((s, i) => {
    const agent = `agent/${ctx.round}/${i + 1}`
    const coord: AgentCoord = {
      id: agent,
      branch: `refs/heads/${agent}`,
      // 产物路径那一栏与 `outputsOf` 同一口径：只有只读型的产物由构造器按位置定名。
      outputPaths: s.kind === 'investigate' ? [`deliver/${agent}/`] : [],
    }
    const state: AssembleState = {
      ...ctx.base,
      goal: ctx.goal,
      ...(s.kind === 'implement' ? { files: s.ownedPaths.map((path) => ({ path, text: '' })) } : {}),
      task: {
        goal: s.kind === 'implement' ? s.goal : ctx.goal,
        question: s.kind === 'investigate' ? s.question : '',
        deliverables: s.kind === 'implement' ? s.deliverables.map((d) => d.path) : [],
        evidenceRequired: s.kind === 'implement' ? s.assertions.map((a) => a.name) : s.evidenceRequired.map((e) => e.note),
        assertions: s.kind === 'implement' ? s.assertions.map((a) => a.name) : [],
      },
      ...(ctx.maxSteps === undefined ? {} : { maxSteps: ctx.maxSteps }),
    }
    const prefix = assemble({
      protocol: SUBAGENT_PROTOCOL,
      model: ctx.decl.id,
      segments: sourcesFor(SUBAGENT_PROTOCOL, state, coord),
    })
    const seedText = (ctx.seedText ?? seedTextOf)(s.seed)
    const plan = planBudget({ decl: ctx.decl, prefix, tools: ctx.tools, seed: seedText, handoff: '' })
    // 单独印的那一栏：同一把尺对 `seed` 那一段的读数（与 `used` 里那一份是同一段正文）。
    const seed = estimateTokensOfText(seedText)
    const sweet = plan.used + plan.handoffMargin <= plan.trigger
    return {
      at: i + 1,
      kind: s.kind,
      goal: s.kind === 'implement' ? s.goal : s.question,
      seed,
      used: plan.used,
      headroom: plan.headroom,
      trigger: plan.trigger,
      handoffMargin: plan.handoffMargin,
      sweet,
      why: sweet
        ? `用了 ${plan.used}，触发点 ${plan.trigger}——离触发点还有 ${plan.trigger - plan.used}，这一格不用交接`
        : `用了 ${plan.used}（加交接余量 ${plan.handoffMargin}）越过了触发点 ${plan.trigger}：这一格走到一半就要交接` +
          `（差额 ${plan.headroom}）`,
    }
  })
}

/** 一条事件的正文指纹：与 `round/intent` · `holder/distill` 同一个口径（`digestOf` 一处给）。 */
function bodyOf(v: unknown): string {
  return JSON.stringify(v)
}


/**
 * 持轮者那一趟跑完之后的读数。**两个状态共用这一个循环**（讨论态说一句话 · 预备态改草案再判）：
 * 差别不在这一层——差别在产物与"这句话这一趟落哪儿"（架构 § 15.1.a 那张表）。
 */
export interface HolderPassResult {
  readonly steps: number
  readonly exit: HolderExit
  /** 为什么停（`收敛` / `步数到顶（4）` / `cut-stream：…` / 人喊停那一句）。 */
  readonly stopped: string
  /**
   * **它最后说的那一段话。** 讨论态拿它当"修正后的理解"（架构 § 15.1.a：人在讨论里说了一句话，
   * 那一趟的产物就是修正后的理解）；预备态不用它——那里的产物是那份草案文件。
   *
   * 空串 = 这一趟没说什么（半截流 · 一步就失败 · 人喊停那一档）。
   */
  readonly said: string
}

/**
 * 跑一趟持轮者。**三档出口在这里归一**（架构 § 15.1.a 那张表的三行）：`declared` 由
 * `holderFace` 记下来的那一下定，其余都算 Harness 判的自然结束（步数到顶 · 半截流也是"这一格
 * 停了"），而人喊停那一档一步都不跑。
 *
 * **它不认识草案、也不认识会话记录**：产物落在哪儿由调用方读，这一份只把"它跑到哪儿 · 为什么
 * 停 · 最后说了什么"交出来。判据也不在这里（键域在 `contract/gate.ts`，那一趟归 `planRound`）。
 */
export async function holderPass(deps: {
  readonly handle: AgentHandle
  /** 轮级事件那一个口（`round`）：这一趟落的 `llm/call` · `tool/*` 都走它。 */
  readonly log: Log
  readonly call: CallModel
  readonly execute: ToolExecutor
  readonly tools?: readonly ToolEntry[]
  readonly maxSteps?: number
  /** 人喊停那一档：不请模型跑。 */
  readonly judgeOnly?: boolean
}): Promise<HolderPassResult> {
  if (deps.judgeOnly === true) {
    return { steps: 0, exit: 'judged', stopped: '人喊停：这一趟不请模型跑，拿手里那一份直接判', said: '' }
  }
  let declared = false
  const face = holderFace(deps.execute, { onDeclare: () => (declared = true) })
  const runtime = createRuntime({
    logOf: () => deps.log,
    call: deps.call,
    execute: face,
    ...(deps.tools === undefined ? {} : { tools: deps.tools }),
    ...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
  })
  let handle: AgentHandle = deps.handle
  let steps = 0
  let stopped = '收敛'
  let exit: HolderExit = 'natural'
  let said = ''
  for (;;) {
    const r = await runtime.step(handle, new AbortController().signal)
    steps += 1
    // **最后说的那一段**：一步的产物在 `next.turns` 的末尾那一条里（`turnText` 那一面是它的
    // 文本投影，这里直接读结构化那一面，不重述一遍）。
    const last = (r.next.turns ?? []).at(-1)
    if (last?.text !== undefined && last.text !== '') said = last.text
    if (r.outcome.kind === 'failed') {
      // **失败也要走到判那一步**：它是"这一格停了"的一种，`gate.problems` 会说出草案缺什么。
      stopped = `${r.outcome.error.why}：${r.outcome.error.message}`
      break
    }
    handle = { ...handle, state: r.next }
    if (r.outcome.kind === 'done') {
      exit = declared ? 'declared' : 'natural'
      break
    }
    if (deps.maxSteps !== undefined && steps >= deps.maxSteps) {
      stopped = `到了你给的上界（${deps.maxSteps} 步）`
      break
    }
  }
  return { steps, exit, stopped, said }
}

/**
 * 跑一趟预备态。**停在门口，不派发。**
 *
 * 返回里的 `gate` 就是那道门的判据：`gate.problems` 空数组 = 停在门口；非空 = 退回
 * 并报出是哪一节哪一个键（架构 § 15.1.a 的"判"与"停"，`M11` 的构造器不猜不补）。
 * **这一份不去拦"拆得好不好"**——
 * 拆分没有事前判据（架构 § 8.12 自己写着"拆得太粗与拆得太细都没有事前判据"），所以规模与耦合
 * 只印出来、照发；那一问归 `round go` 那一次批。
 */
export async function planRound(deps: PlanDeps): Promise<PlanResult> {
  const { base, log, round, goal } = deps
  // **这一轮的读数：一遍**（给了就用给的：`PlanDeps.facts`）——处境与「上一版是哪一版」都是它的
  // 投影，两处各读一遍读出来的是两个时刻的快照，而中间那一段正是这一趟在写。
  const facts = deps.facts ?? (await roundFactsOf(log, round))
  // **底由调用方钉住**（`pinnedBase`）。这一份不去读第二次 HEAD：视图已经铺在那个提交上了，
  // 再读一次的结果可能已经不是它——而两处不一致的症状只是"视图里少了一条路径"。
  if (base === '') throw new PlanError('钉住的底是空的：轮次的底是 `pinnedBase()` 读出来的那个提交')
  const draftPath = deps.draftPath ?? draftPathOf(round)
  const seqs: LogSeq[] = []

  // 一 · 轮次的处境**从日志重放出来**，不假定 `Idle`。同一轮里再跑一趟预备态（人喊停那一档、
  // 或者改完草案再判一遍）不该造出第二条 `Idle → Planning`——那种日志会让重放出来的处境是假的。
  let state: RoundState = facts.state
  const move = async (on: Cause, ctx: StepContext = {}): Promise<void> => {
    const from = state
    state = step(from, on, ctx)
    seqs.push(await log.append('round', { t: 'round/state', round, from, to: state }))
  }
  if (state === 'Idle') {
    // **拦级意图只写一次**（架构 § 15.1 纪律 2）。守卫是意图快照已建立（§ 8.13 的第一个关键点）：
    // 先落 `round/intent`、再走那一步——顺序反了那条守卫就该不成立。
    const intentBody = bodyOf({ goal })
    seqs.push(await log.append('round', { t: 'round/intent', round, base, digest: digestOf(intentBody), body: intentBody }))
    await move('land', { intent: true })
  } else if (state !== 'Planning') {
    throw new PlanError(
      `这一轮的处境是 ${state}：预备态只在 Idle（还没落地）与 Planning（在预备态里）两处跑。` +
        '要重新拆一遍就开新的一轮——意图与契约集合都不在轮内改写（架构 § 15.1 纪律 3）。',
    )
  }

  // 二 · 持轮者跑一趟。**三档出口在 `holderPass` 那一处归一**（声明 · 自然结束 · 人喊停）——
  // 讨论态那一趟走的是同一个循环（`sayRound`），两个状态在这一层没有分岔。
  const pass = await holderPass({
    handle: deps.handle,
    log,
    call: deps.call,
    execute: deps.execute,
    ...(deps.tools === undefined ? {} : { tools: deps.tools }),
    ...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
    ...(deps.judgeOnly === true ? { judgeOnly: true } : {}),
  })
  const { steps, exit, stopped } = pass

  // 三 · 草案从视图里读回来，**接着就判**：键域 · 值域 · 跨字段 · 绑定 · 预检全在
  // `contract/gate.ts` 那一处。放行那一下（`round go`）走的是同一段判据——**门只认契约集合**，
  // 所以两处必须给出同一个答案。
  //
  // 真源仍然只有两处（git 对象库 + `M0` 日志），盘上不落第三处：草案跟着 `holder/distill` 的
  // 正文进日志。视图是调用方给的**那一份**：持轮者写它的那一下与这里读它的这一下是同一个对象。
  const bytes = await deps.view.read(draftPath)
  const draftText = bytes === null ? null : new TextDecoder().decode(bytes)
  // **这一趟落下的那一版**：`at` 与 `against` 由 `landingOf` 一处定（与读侧同一条口径）。
  let landing: DistillVersion | null = null
  if (draftText !== null) {
    // **上一版是哪一版**：开跑时读的那一份读数里链尾那一版（不是「上一趟跑了什么」——人直接改
    // 草案那一档也走同一条链）。`judgeOnly` 那一档落的是同一份正文，于是 `digest` 相同而
    // `against` 指回上一版：「又落了一遍同一版」在链上也看得见。
    landing = landingOf(facts, digestOf(draftText), draftText)
    seqs.push(
      await log.append('round', {
        t: 'holder/distill',
        round,
        agent: 'round' as AgentId,
        digest: landing.digest,
        ...(landing.against === null ? {} : { against: landing.against }),
        body: landing.body,
      }),
    )
  }

  // `seed` 那一段的量法：在**持轮者这份视图**上取一次内容——它与派发那一趟是同一把尺
  // （`round/seed.ts`），所以门上印的差额与派发时判的那个数说的是同一件事。**装在这一处**：
  // 门里要用它量每一份种子的上限，而下面印占用要用同一份读数。
  const ruler = seedRulerOf((p) => deps.view.read(p))
  const gate = await gateOf(
    { from: 'draft', goal, text: draftText, where: draftPath },
    {
      round,
      base,
      identityFor: deps.identityFor,
      actions: deps.actions,
      seedRuler: ruler,
      // **声明那一份上限接进 `seed` 那一条**（`PlanDeps.decl` 原先只喂占用估账）：上界是
      // "模型上限 − Zone A − 交接余量"，而"模型上限"这一栏只有调用方手上那份声明里有。
      modelLimit: deps.decl.contextLimit,
    },
  )

  // 四 · 印每一格的预估占用。**印，不判**（规模归模型；甜点区间那条带归架构，而它只把差额说出来）。
  const occupancy =
    gate.draft === null ? [] : occupancyOf(gate.draft.sections, { ...deps.occupancy, seedText: ruler.textOf })

  return {
    round,
    base,
    exit,
    steps,
    stopped,
    draftText,
    landing,
    gate,
    seedRead: ruler.reading,
    occupancy,
    held: gate.held,
    seqs,
  }
}

/**
 * 钉住这一轮的底：**读一次，然后传下去**（架构 § 8.14 的 C7 前半 · 架构 § 4 的"两条分支与视图
 * 必须同一个提交"）。
 *
 * 它住在这里而不是住在每个调用点：`round plan` 与 `round go` 都要它，而"HEAD 不存在"那句话
 * 只有一处说法的时候，两处的行为才一致。
 */
export async function pinnedBase(truth: Truth): Promise<CommitId> {
  const base = await baseFor(truth, 'round')
  if (base === null) {
    throw new PlanError(
      '真实工作树的 HEAD 还不存在：轮次的底就是它（架构 § 8.14 的 C7）。先提交一次，再来开预备态。',
    )
  }
  return base
}

/** 十二个段之外，这一份要用到的那个空状态（估账的底）。**转发一行**：调用点不必同时 import 两处。 */
export { emptyState }
