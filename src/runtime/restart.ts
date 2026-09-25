// 接续与交接：**步数到了触发点就把这一格交给下一个 agent**。出处：架构 § 8.13.a（"循环重启：
// 同一分支上一个新 `AgentId`，机械要求写交接提示词；**轮级状态不变**"）· § 8.11（交接提示词住
// Zone B——同一 agent 跨步稳定的那一段）· § 9.7（会话内与会话外：`turns` 跨进程即失，所以它
// 不能是交接的载体）· § 23 U6。
//
// **它只做三件事**：写一份交接（`handoffOf`，纯函数）· 把它落到日志里（`agent/handoff`）·
// 给后继那一格装配一份新的状态（`successorOf`，纯函数）。**没有第四件**——派发与收编归调用方。
//
// **交接的载体为什么是 Zone B 而不是 Zone C。** C 区那个积累段（`turns`）"跨进程即失"（架构
// § 8.11）：它在内存里，重启之后就没了。所以能过界的只有**文本**，而它要落在**下一格跨步稳定
// 的那一段**上——Zone B 的「交接提示词」。落在 C 区的话它每步都在，而下一格的第一步之后就
// 被自己的回执淹掉了；更要紧的是它会跟着步数走，而"相邻两步只有 C 变"那条性质要求 B 区稳定。
import { createHash } from 'node:crypto'
import type { Log, LogEvent } from '../log/events.ts'
import type { AgentId, BranchId, ContractId, LogSeq, WriterId } from '../terms.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import type { BudgetPlan } from './budget.ts'

/** 交接的正文。**它是一份值，序列化成 JSON 进事件**（与 `round/intent` · `contract/issue` 同一路）。 */
export interface Handoff {
  /** 这一格要干成什么（契约那一句）。 */
  readonly goal: string
  /** 前任叫谁 · 在哪条分支上（同一个 branch——架构 § 8.13.a）。 */
  readonly from: string
  readonly branch: string
  /** 交到第几步。 */
  readonly step: number
  /** 已经发生了什么（这一步的收尾那一段文本）。 */
  readonly done: string
  /** 手里那些文件（路径与它现在是什么样，一行一个）。 */
  readonly files: readonly string[]
  /** 已经跑过、且值得下一格知道的命令。 */
  readonly commands: readonly string[]
  /** 下一格接着干什么（一到三条，短句）。 */
  readonly next: readonly string[]
  /** 为什么交接（预算那一句）。 */
  readonly why: string
}

/**
 * 写一份交接。**它是机械的**（架构 § 8.13.a 的"机械要求写交接提示词"）：不问模型，只把这一格
 * 手里那几样值抄成一份下一格读得懂的东西。
 *
 * **它为什么不做摘要**：摘要是模型的事，而这里是"轮到它说话了"之前的最后一步——这一步失败
 * 就没有下一格。抄一份确定的文本，比让模型在预算已经用完的时候再写一段更可靠。
 */
export function handoffOf(i: {
  readonly contract: ContractId
  readonly goal: string
  readonly from: AgentId
  readonly branch: BranchId
  readonly state: AssembleState
  readonly plan: BudgetPlan
  readonly commands: readonly string[]
}): Handoff {
  const done = i.state.lastStep.trim() === '' ? '（这一步没有留下回执）' : i.state.lastStep.trim()
  return {
    goal: i.goal,
    from: i.from,
    branch: i.branch,
    step: i.state.step,
    done,
    files: i.state.files.map((f) => `${f.path}（${Buffer.byteLength(f.text, 'utf8')} 字节）`),
    commands: [...i.commands],
    next: [
      `接着 ${i.contract} 这一格干：目标还是那一句。`,
      '上面"已经发生了什么"里的结论不用重做，从它停下的地方往下走。',
      '要动文件就用 read 先看它现在什么样——你手里的视图与前任是同一个。',
    ],
    why: i.plan.why,
  }
}

/** 交接提示词的正文（**它就是进 Zone B 的那一段文本**）。 */
export function promptOf(h: Handoff): string {
  const lines = [
    `【交接】从 ${h.from} 手里接过这一格（同一条分支 ${h.branch}，交到第 ${h.step} 步）。`,
    `目标：${h.goal}`,
    `为什么交接：${h.why}`,
    '已经发生了什么：',
    h.done,
  ]
  if (h.files.length > 0) lines.push('手里这些文件：', ...h.files.map((f) => `  ${f}`))
  if (h.commands.length > 0) lines.push('已经跑过的命令（结论照用，别重跑）：', ...h.commands.map((c) => `  ${c}`))
  lines.push('接着干什么：', ...h.next.map((n) => `  ${n}`))
  return lines.join('\n') + '\n'
}

/** 正文的指纹（进事件那一栏，与 `round/intent` 同一个口径）。 */
export function digestOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 落一条 `agent/handoff`。**它是这一份里唯一写日志的地方。**
 *
 * `successor` 与 `agent` **同一条 branch**（架构 § 8.13.a）：分支是这一格的产物线，换人不换线
 * ——换线就等于把前面的产物丢在另一条分支上，而"同一分支上一个新 `AgentId`"那句话说的正是
 * 这件事。
 */
export async function recordHandoff(
  log: Log,
  writer: WriterId,
  i: {
    readonly agent: AgentId
    readonly successor: AgentId
    readonly contract: ContractId
    readonly prompt: string
  },
): Promise<LogSeq> {
  const e: LogEvent = {
    t: 'agent/handoff',
    agent: i.agent,
    successor: i.successor,
    contract: i.contract,
    digest: digestOf(i.prompt),
    body: i.prompt,
  }
  return log.append(writer, e)
}

/**
 * 后继那一格的状态。**纯函数，而且它是"接续"这件事在值上的全部**：
 *
 *   · `handoff` 那一栏进 Zone B（交接提示词那一段）——**下一格第一步的 B 区里就有它**；
 *   · `turns` 与 `lastStep` **清空**：那是前任的会话内积累（架构 § 8.11："跨进程即失"）；
 *     不清的话下一格会以为那些工具结果是它自己刚做的；
 *   · `step` 归零：**它的步数是它自己的**（触发点按它自己的步数算）；
 *   · 其余（方针 · 系统 · 代码树 · 目标 · 文件 · 提交 · 契约 · 摘要 · 信号）照旧——
 *     它们要么来自视图与日志（重新装配得出），要么本来就是跨 agent 稳定的那几段。
 *
 * 返回的那个 `turns` 里那一条"你接手了"是**给模型看的第一句**（它与前任收到的第一句同一个
 * 位置），不是回执——回执是工具跑完之后才有的东西。
 */
export function successorOf(
  state: AssembleState,
  prompt: string,
  coord: AgentCoord,
): AssembleState {
  return {
    ...state,
    step: 0,
    handoff: prompt,
    turns: [{ text: `【接手】${coord.id} 从这一步开始。上面"交接"那一段是前任留下的。`, calls: [], results: [] }],
    lastStep: '',
  }
}

/**
 * 把交接**写进日志**并给出后继那一份状态。**这是这一步的全部动作**：
 *
 *   1. 写一份交接（`handoffOf`，机械的）；
 *   2. 落一条 `agent/handoff`（`recordHandoff`）；
 *   3. 给后继装配状态（`successorOf`）。
 *
 * **轮级状态一个字节都不碰**（架构 § 8.13.a 的"轮级状态不变"）：`round/state` 那条事件不在这
 * 一份里，也不在它上面的调用链里——这一份只认识"某一格内部的接续"。
 */
export async function handoffAt(i: {
  readonly log: Log
  readonly writer: WriterId
  readonly agent: AgentId
  readonly successor: AgentId
  readonly contract: ContractId
  readonly branch: BranchId
  readonly goal: string
  readonly state: AssembleState
  readonly coord: AgentCoord
  readonly plan: BudgetPlan
  readonly commands: readonly string[]
}): Promise<{ readonly handoff: Handoff; readonly prompt: string; readonly seq: LogSeq; readonly next: AssembleState }> {
  const handoff = handoffOf({
    contract: i.contract,
    goal: i.goal,
    from: i.agent,
    branch: i.branch,
    state: i.state,
    plan: i.plan,
    commands: i.commands,
  })
  const prompt = promptOf(handoff)
  const seq = await recordHandoff(i.log, i.writer, {
    agent: i.agent,
    successor: i.successor,
    contract: i.contract,
    prompt,
  })
  return { handoff, prompt, seq, next: successorOf(i.state, prompt, i.coord) }
}

/** 后继的名字：`<前任>-2` · `<前任>-3`……**同一个分支上的一个新 `AgentId`**。 */
export function successorNameOf(agent: string, nth: number): string {
  return nth <= 1 ? `${agent}-2` : `${agent}-${nth + 1}`
}
