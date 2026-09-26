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
import { emptyState, sourcesFor } from '../assemble/sources.ts'
import { assemble } from '../assemble/assemble.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { planBudget } from '../runtime/budget.ts'
import { digestOf } from '../runtime/restart.ts'
import { baseFor } from '../view/lower.ts'
import type { Cause, RoundState, StepContext } from './machine.ts'
import { step } from './machine.ts'
import type { Draft, DraftKind, DraftSection } from '../contract/draft.ts'
import { DraftError, draftOf, draftPathOf } from '../contract/draft.ts'
import { utf8Bytes } from '../contract/build.ts'

/** 这一层自己的失败：底钉不住 · 视图打不开。**草案不成立不是它**——那是一件读数（`problems`）。 */
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
  /** 每一格的预估占用要的那几样（给"规模对齐模型能力"那句一个能验的形状）。 */
  readonly occupancy: OccupancyContext
}

/** 一格（将来的一个子 agent）的预估占用。**它是估账，不是读数**——读数在 `llm/call` 里。 */
export interface OccupancyRow {
  /** 第几节（从 1 起，与身份发的序号同一个）。 */
  readonly at: number
  readonly kind: DraftKind
  readonly goal: string
  /** `seed` 的字节数。 */
  readonly seed: number
  /** 三区 + 工具目录 + `seed`（**按字节算的那把上界尺**：1 token ≥ 1 字节，与 `seed` 两条准则同一个口径）。 */
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
  /** 工具目录那一段的字节（公布给模型的那一份序列化之后——架构 § 8.11 表外那一项）。 */
  readonly toolBytes: number
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
  /** 读出来的那一份（键域不完整时是 `null`——不猜、不补）。 */
  readonly draft: Draft | null
  /** 键域那一条报出来的每一处。**空数组 = 停在门口**。 */
  readonly problems: readonly string[]
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
 * （`assemble` 是纯函数），`seed` 按 UTF-8 字节算。`base` 那一份状态由调用方给（项目方针 ·
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
    const seed = utf8Bytes(s.seed)
    const plan = planBudget({ decl: ctx.decl, prefix, tools: ctx.toolBytes, seed, handoff: 0 })
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
 * 这一轮的处境：把 `round/state` 那条链重放一次。**只认这一个轮次号**——同一份日志里住着好几轮。
 *
 * 一条都没有就是 `Idle`（这一轮还没落地）。链本身由 `machine.ts` 那 12 条边保着，所以这里
 * 不需要再判"走得对不对"：**落下来的每一条都是当时判过的**（架构 § 9.4 的重放口径）。
 */
async function roundStateOf(log: Log, round: RoundId): Promise<RoundState> {
  let state: RoundState = 'Idle'
  for await (const e of log.readByWriter('round')) {
    if (e.t === 'round/state' && e.round === round) state = e.to
  }
  return state
}

/**
 * 跑一趟预备态。**停在门口，不派发。**
 *
 * 返回里的 `problems` 就是那道门的判据：空数组 = 键域完整 = 停在门口；非空 = 退回并报出每一处
 * （架构 § 15.1.a 的"判"与"停"，`M11` 的构造器不猜不补）。**这一份不去拦"拆得好不好"**——
 * 拆分没有事前判据（架构 § 8.12 自己写着"拆得太粗与拆得太细都没有事前判据"），所以规模与耦合
 * 只印出来、照发；那一问归 `round go` 那一次批。
 */
export async function planRound(deps: PlanDeps): Promise<PlanResult> {
  const { base, log, round, goal } = deps
  // **底由调用方钉住**（`pinnedBase`）。这一份不去读第二次 HEAD：视图已经铺在那个提交上了，
  // 再读一次的结果可能已经不是它——而两处不一致的症状只是"视图里少了一条路径"。
  if (base === '') throw new PlanError('钉住的底是空的：轮次的底是 `pinnedBase()` 读出来的那个提交')
  const draftPath = deps.draftPath ?? draftPathOf(round)
  const seqs: LogSeq[] = []

  // 一 · 轮次的处境**从日志重放出来**，不假定 `Idle`。同一轮里再跑一趟预备态（人喊停那一档、
  // 或者改完草案再判一遍）不该造出第二条 `Idle → Planning`——那种日志会让重放出来的处境是假的。
  let state: RoundState = await roundStateOf(log, round)
  const move = async (on: Cause, ctx: StepContext = {}): Promise<void> => {
    const from = state
    state = step(from, on, ctx)
    seqs.push(await log.append('round', { t: 'round/state', round, from, to: state }))
  }
  if (state === 'Idle') {
    // **拦级意图只写一次**（架构 § 15.1 纪律 2）。守卫是意图快照已建立（§ 8.13 的第一个关键点）：
    // 先落 `round/intent`、再走那一步——顺序反了那条守卫就该不成立。
    const intentBody = bodyOf({ goal })
    seqs.push(await log.append('round', { t: 'round/intent', round, digest: digestOf(intentBody), body: intentBody }))
    await move('land', { intent: true })
  } else if (state !== 'Planning') {
    throw new PlanError(
      `这一轮的处境是 ${state}：预备态只在 Idle（还没落地）与 Planning（在预备态里）两处跑。` +
        '要重新拆一遍就开新的一轮——意图与契约集合都不在轮内改写（架构 § 15.1 纪律 3）。',
    )
  }

  // 二 · 持轮者跑一趟。**三档出口在下面那个循环里归一**：`declared` 由 `holderFace` 记下来的那
  // 一下定，其余都算 Harness 判的自然结束（步数到顶 · 半截流也是"这一格停了"）。
  let declared = false
  const face = holderFace(deps.execute, { onDeclare: () => (declared = true) })
  const maxSteps = deps.maxSteps
  let handle: AgentHandle = deps.handle
  let steps = 0
  let stopped = '收敛'
  let exit: HolderExit = 'natural'
  if (deps.judgeOnly === true) {
    exit = 'judged'
    stopped = '人喊停：这一趟不请模型跑，拿手里那一份直接判'
  } else {
    const runtime = createRuntime({
      logOf: () => log,
      call: deps.call,
      execute: face,
      ...(deps.tools === undefined ? {} : { tools: deps.tools }),
      ...(maxSteps === undefined ? {} : { maxSteps }),
    })
    for (;;) {
      const r = await runtime.step(handle, new AbortController().signal)
      steps += 1
      if (r.outcome.kind === 'failed') {
        // **失败也要走到判那一步**：它是"这一格停了"的一种，`problems` 会说出草案缺什么。
        stopped = `${r.outcome.error.why}：${r.outcome.error.message}`
        break
      }
      handle = { ...handle, state: r.next }
      if (r.outcome.kind === 'done') {
        exit = declared ? 'declared' : 'natural'
        break
      }
      if (maxSteps !== undefined && steps >= maxSteps) {
        stopped = `到了你给的上界（${maxSteps} 步）`
        break
      }
    }
  }

  // 三 · 草案从视图里读回来。**它落在日志里**（`holder/distill` 那一路的 `digest` + 正文）：
  // 真源仍然只有两处（git 对象库 + `M0` 日志），盘上不落第三处。
  //
  // 视图是调用方给的**那一份**：持轮者写它的那一下与这里读它的这一下是同一个对象——
  // 两处各开一份视图的症状是"草案不在视图里"（读的那一份早于写的那一份建出来）。
  const bytes = await deps.view.read(draftPath)
  const draftText = bytes === null ? null : new TextDecoder().decode(bytes)
  let draft: Draft | null = null
  let problems: readonly string[] = []
  if (draftText === null) {
    problems = [
      `草案不在视图里：${draftPath}——持轮者这一趟没写出那一份` +
        `（一个任务一节，每节一个标 json 的围栏块，键就是契约的键）`,
    ]
  } else {
    seqs.push(await log.append('round', { t: 'holder/distill', agent: 'round' as AgentId, digest: digestOf(draftText), body: draftText }))
    try {
      draft = draftOf(draftText)
    } catch (err) {
      if (!(err instanceof DraftError)) throw err
      problems = err.problems
    }
  }

  // 四 · 印每一格的预估占用。**印，不判**（规模归模型；甜点区间那条带归架构，而它只把差额说出来）。
  const occupancy = draft === null ? [] : occupancyOf(draft.sections, deps.occupancy)

  return {
    round,
    base,
    exit,
    steps,
    stopped,
    draftText,
    draft,
    problems,
    occupancy,
    held: problems.length === 0,
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
