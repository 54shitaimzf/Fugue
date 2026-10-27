// 有序事实：C 区（每步尾部）的唯一来源。出处：0.5.4 施工交接单 § 一 · 外部审查报告 § 4.7
// （「把动态部分改成一份有序记录：人的输入、一次完整模型回复及其工具结果、轮内裁断结论、
// 交接结论」）。
//
// **这里只有一份值，没有第二份拼法。** 一份 `Fact[]` 按时间排下来；三个读者各自投影：
//
//   · 文本预览（`sources.ts` 的那三段）按**段**取：人那一句与回合进「运行时上下文」·
//     判词进「信号摘要」· 最后一条回合进「上一步结果」——段的顺序由协议定，不由这一份定；
//   · 两根 wire 的编码按**序**取：人是一句 · 回合是原生轮次（`turnsOf`）· 判词接在相应回合
//     之后（0.5.4 幕②接上）；
//   · 预算读数从同一份值或已编码请求的统计里取（0.5.4 幕③接上）。
//
// **为什么判词与交接各是一种事实，而不是塞进字符串或塞进回合。** 它们是两种不同的读者承诺：
// 判词是 harness 对模型的回答，交接那一句是"你接手的这一格"的开场——两者都不是模型自己说的话。
// 编成一条 `Turn` 的文本再拼回字符串，就等于把"谁说的"这件事丢掉，而丢掉了不报错。四种事实
// 各自留下自己的种类，编码是 wire 的事（报告 § 4.7：「角色决定哪些内容可见，wire 决定如何合法
// 编码」）。
//
// **上一版为什么错。** 从前 C 区有两套组合规则：`assemble/sources.ts` 把 `runtime` + `turns` +
// `signals` + `lastStep` 拼成文本，而 `runtime/step.ts` 只把 `runtime`（`cHead`）与 `turns`
// 交给 wire——轮次一非空，`signals` 与 `lastStep` 就从请求里消失，且**那不会报错**（外部审查
// § 3.11：实际请求里判词出现 0 次）。收成一份值之后，"文本里有、请求里没有"这件事在结构上
// 不复存在：两个读者读的是同一串事实，差异只剩各自怎么投影。
//
// **不在这里的事**：段的顺序与渲染（`protocol.ts` 与 `assemble.ts`）· 事件的账（`log/`）·
// 工具目录与 B 区。事实只回答"这一趟里发生了什么、按什么序"。
import type { Turn } from '../model/contract.ts'

/** 人说的那一句（这一趟的输入）。一次持轮者那一趟只有一条；子 agent 那一格没有。 */
export interface HumanFact {
  readonly kind: 'human'
  readonly text: string
}

/** 一次完整的模型回复及其工具结果。结构化那一面与文本那一面同源（`turnText` 一处渲染）。 */
export interface TurnFact {
  readonly kind: 'turn'
  readonly turn: Turn
}

/** 轮内裁断回来的那一句结论（只带结论，推敲不进）。 */
export interface RulingFact {
  readonly kind: 'ruling'
  readonly text: string
}

/**
 * 交接那一句：后继那一格的第一步读到它，位置与"人说的那一句"相同（都是给模型的开场）。
 *
 * **它不碰 B 区的「交接提示词」。** 交接的正文（`agent/handoff` 那一份）是另一段：它在 B 区、
 * 逐 agent 稳定、跨进程还在；这一条只是"你从这一步接手"这句开场白，属于这一格自己的会话。
 * 同一份交接在两处投影（B 区一段文本 · 这里一句开场），而**零处第二份组合规则**——B 区那一份
 * 由 `restart.ts` 的 `promptOf` 一处渲染，这里这一条由 `successorOf` 一处产生。
 */
export interface HandoffFact {
  readonly kind: 'handoff'
  readonly turn: Turn
}

export type Fact = HumanFact | TurnFact | RulingFact | HandoffFact

/** 空的这一份：没有人的话、没有回合、没有判词。 */
export const NO_FACTS: readonly Fact[] = []

/** 追加一条事实。**顺序就是发生顺序**——这一处只往后长，不改中部（架构 § 8.11 的约束 1）。 */
export function withFact(facts: readonly Fact[], fact: Fact): readonly Fact[] {
  return [...facts, fact]
}

/**
 * 一个 `Turn` → 它那一段文本。**这是结构化那一面唯一的文本投影**（两处不许各写一份）。
 *
 * 里面只有两样：模型说的话，与每一条工具回了什么。**不带修订号、不带执行序号**——那些是架构
 * 内部的坐标，模型不需要看，看了也只是噪声（架构 § 8.11 约束 3 在 C 区这一侧的读法）。思考
 * 不进文本：它走原生轮次那一路（`Turn.thinking`），写进文本面等于同一份东西发两遍。
 */
export function turnText(turn: Turn): string {
  const lines: string[] = []
  if (turn.text !== undefined && turn.text !== '') lines.push(`Model: ${turn.text}`)
  turn.results.forEach((r, i) => {
    const name = turn.calls[i]?.name ?? '?'
    lines.push(`${r.isError ? 'Tool (failed)' : 'Tool'} ${name} (call ${i + 1}):\n${r.output}`)
  })
  return lines.join('\n')
}

/** 人说的那几（一）句：按序接起来。多条人话之间用换行——它们本来就是分开的两次输入。 */
export function humanTextOf(facts: readonly Fact[]): string {
  return facts.flatMap((f) => (f.kind === 'human' ? [f.text] : [])).join('\n')
}

/** 这一份里全部回合的 `Turn`（含交接后那一句【接手】）：wire 发原生轮次时要的就是这一串。 */
export function turnsOf(facts: readonly Fact[]): readonly Turn[] {
  return facts.flatMap((f) => (f.kind === 'turn' || f.kind === 'handoff' ? [f.turn] : []))
}

/**
 * 「运行时上下文」那一段的正文：**头（人说的那一句）+ 只追加的尾巴（每一条回合）**。
 *
 * 空串与空尾巴都不产出分隔符——与从前那一条源逐字节相同（`src/assemble/__fixture__/c-parity.json`
 * 绑着它）。**这是 C 区里唯一一处把"头"与"尾巴"接起来的地方**；wire 那一侧不接这一份，它发
 * 原生轮次（头单独发）。两处读的是同一份事实，各自按自己的合法形状投影。
 */
export function runtimeTextOf(facts: readonly Fact[]): string {
  const head = humanTextOf(facts)
  const turns = turnsOf(facts).map(turnText)
  if (turns.length === 0) return head
  return head === '' ? turns.join('\n') : `${head}\n${turns.join('\n')}`
}

/** 「信号摘要」那一段的值：这一趟里判回来的每一条结论，按发生序。 */
export function rulingTextsOf(facts: readonly Fact[]): readonly string[] {
  return facts.flatMap((f) => (f.kind === 'ruling' ? [f.text] : []))
}

/** 最后一条**回合**（不含交接那一句【接手】——它不是一步的结果）。 */
export function lastTurnOf(facts: readonly Fact[]): Turn | undefined {
  for (let at = facts.length - 1; at >= 0; at -= 1) {
    const f = facts[at] as Fact
    if (f.kind === 'turn') return f.turn
  }
  return undefined
}

/**
 * 「上一步结果」那一段的值：**最后一条回合的文本**，没有回合就是空串。
 *
 * 它在运行时那条路上就是"最后一步的回执"（`step.ts` 从前把同一个 `turnOf` 值同时写进
 * `turns` 与 `lastStep`）；交接那一格把它清空——`successorOf` 只留人话与判词、换成一条
 * 【接手】，所以这里取不到回合，与从前的 `lastStep: ''` 逐字节相同。
 *
 * **它读的是同一份事实，不是另一份状态。** 疑点 3 的判据因此落在这里：这一段是最后一条回合的
 * 文本投影，读它的第二处是 `runtime/restart.ts` 的 `handoffOf`（交接提示词里"已经发生了什么"）。
 */
export function lastStepTextOf(facts: readonly Fact[]): string {
  const turn = lastTurnOf(facts)
  return turn === undefined ? '' : turnText(turn)
}

/**
 * 交接之后那一格的事实：**留下人话与判词，丢掉前任的回合，接上【接手】那一句**。
 *
 * 与从前的 `successorOf` 逐字节相同（它保住 `runtime` 与 `signals`、清掉 `turns` 与
 * `lastStep`）。前任的回合是"跨进程即失"的会话内积累（架构 § 8.11），不能留给下一格——
 * 下一格会以为那些工具结果是它自己刚做的。
 */
export function factsAfterHandoff(facts: readonly Fact[], opening: Turn): readonly Fact[] {
  return [
    ...facts.filter((f) => f.kind === 'human' || f.kind === 'ruling'),
    { kind: 'handoff', turn: opening },
  ]
}
