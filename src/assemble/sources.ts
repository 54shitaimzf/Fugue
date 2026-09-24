// 十二个段各自的源。出处：架构 § 8.11 那张三区表（每一行的「源」那一栏）· PLAN § 5.6 的 Z4。
//
// **这一份在组装器之外，产出的是值。** 架构 § 13.4 的 P2（全部输入是值）在这里落地：段源读
// 文件 · 读配置 · 读日志，把它们变成 `SegmentValue`；`assemble()` 收的只有
// `{ protocol, model, segments }`——它不认识 `Truth` · `View` · `Materializer`，也不认识
// 这个模块。值的边界就是这一份的返回值。
//
// **键域与协议声明同域。** `sourcesFor()` 只产出这份协议真的排过序的那几段（架构 § 8.11：
// 「字典的键域与 `segmentOrder` 同域，因此"有一个段没被渲染"和"渲染了一个没人排过序的段"
// 都不成立」）。子 agent 那份十一段、持轮者那份十二段，同一个函数、两份声明——两份值的差别
// 不是代码里的分支，是传进来的协议（架构 § 8.11 末：「组装器的代码一行不改」）。
//
// **缺源不是异常，是空值**（PLAN § 5.6 的地板：代码树索引未建 · 工具目录那一档）。渲染规则
// 决定空值长什么样（`render.ts` 的 `emptyFor`）：文本给空串、列表给空数组、围栏块给空数组、
// JSON 给空对象。**判据是那一条：那个机制死掉的时候，系统是变慢，还是跑不起来。**
//
// **不是源的几样**：宿主绝对路径 · 主机名 · Signal 原文（架构 § 8.11 的约束 2 · 3 · 4）——
// 这一份一个字段都不给它们留位置，所以它们进不了前缀。真正接上运行时的那些源（凝聚理解 ·
// 压缩前最近几次原文 · 运行时上下文 · 上一步结果）今天由调用方给值，S7 · S8 才有人产它们。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Protocol, SegmentId, SegmentValue } from './contract.ts'
import { TOOL_ENTRIES } from '../tools/catalog.ts'

/**
 * 一个 agent 的坐标。**它不是段，是段的源要的那把钥匙。**
 *
 * `id` 与 `branch` 是系统的键，模型不据此做任何事，所以它们自己不进前缀（架构 § 8.11 的
 * 「我的任务」那一行）。进得去的是它们**决定的那几个字节**：产物路径 · 这个 agent 自己的段。
 */
export interface AgentCoord {
  readonly id: string
  readonly branch: string
  /** 契约要求的产物路径（架构 § 8.12）。空的时候不追加——不凭空造一个目录名。 */
  readonly outputPaths: readonly string[]
}

/** 持轮者：**没有 agent 这一栏**——它手里是全部契约，不是一份（架构 § 8.11）。 */
export const HOLDER: null = null

/** 装配这一步的全部输入。**每个字段都是值**，没有一处要现读视图或现读日志。 */
export interface AssembleState {
  /** 项目方针：`<realRoot>/AGENTS.md` 的字节，人编辑，不在视图里（架构 § 9.9）。 */
  /**
   * 这一步是第几步（从 0 起）。
   *
   * **它是这个形状里唯一"随步走"的坐标**：`llm/call` 那一条的 `step` 读它，而 B 区那些段
   * （跨步稳定）一个都不读它——所以它进状态、不进前缀。
   */
  readonly step: number
  /**
   * 这一步的工作目录（视图内的相对路径，`''` 就是根）。
   *
   * **它与 `step` 同类：是坐标，不是段。** 前缀十二段一个都不读它，所以它进状态、不进前缀
   * （B/C 两区的哈希因此与它无关）。工具面要它：`glob`/`grep` 不给 `path` 时相对它走，围栏
   * 拿它当 `cwd` 解相对路径（架构 § 8.4 的 `resolveVirtual(path, cwd)`）。
   */
  readonly cwd: string
  readonly policy: string
  /** 系统状态：配置对本工作区的投影（架构 § 15.3.a）。**这个仓库里的第一版**（Z5 接手）。 */
  readonly system: SegmentValue
  /** 代码树：索引的结构部分（架构 § 8.16.a）；索引未建时是 `[]`——地板那一档。 */
  readonly codeTree: readonly string[]
  readonly goal: string
  readonly files: readonly { readonly path: string; readonly text: string }[]
  readonly commits: readonly string[]
  readonly handoff: string
  /** 契约值（架构 § 8.12）。`seed` 的那一半由调用方给；逐 `kind` 的裁剪留到 S7。 */
  readonly task: {
    readonly goal: string
    readonly question: string
    readonly deliverables: readonly string[]
    readonly evidenceRequired: readonly string[]
    readonly assertions: readonly string[]
  }
  readonly distill: string
  readonly recent: string
  readonly runtime: string
  /**
   * **这一步那一段**（`Runtime.step` 往里追加：模型说了什么 · 工具回了什么）。
   *
   * 它是 C 区那个积累段（架构 § 8.11 的「运行时上下文」：**只追加、不进日志、跨进程即失**）。
   * 单独一栏而不是拼进 `runtime` 那个字符串，是因为"只追加"这条性质要在**值**上看得见：
   * 拼字符串的话，改一个字与追加一段在类型上分不开，而 `B4` 的断言 ② 量的正是这件事
   * （相邻两步 `hash(A+B)` 不变 · 只有 C 那一串往后长）。
   */
  readonly turns?: readonly string[]
  readonly signals: readonly string[]
  readonly lastStep: string
}

/** 一份最小的输入：十二个段各有其空值，测试与走查从一个确定的形状出发。 */
export function emptyState(): AssembleState {
  return {
    step: 0,
    cwd: '',
    policy: '',
    system: {},
    codeTree: [],
    goal: '',
    files: [],
    commits: [],
    handoff: '',
    task: { goal: '', question: '', deliverables: [], evidenceRequired: [], assertions: [] },
    distill: '',
    recent: '',
    runtime: '',
    signals: [],
    lastStep: '',
  }
}

/**
 * 段源住在组装器之外的那一层失败：一个 agent 的名字查不出坐标。
 *
 * **拒，不替它挑一份**：给主线当默认会让一次打错名字的装配看起来成功——而前缀的字节正是
 * 后面每一条哈希断言量到的东西。名字要报出来（架构 § 8.4 纪律 2 的同一条纪律）。
 */
export class SourceError extends Error {}

/** 按名字取一个 agent 的坐标：拿不到就**拒绝**，不返回空坐标。 */
export type AgentResolver = (agent: string) => AgentCoord

/**
 * 按 id 查一张坐标表，查不到就拒。
 *
 * 它是 `--agent` 那一栏的取值处（PLAN § 5.6 的疑点清单把 `--agent` 与 `AssembleWho` 记在 Z4）：
 * 「不给」= 持轮者那条路，「给了一个不存在的」= 拒。**两件事不许混。**
 */
export function resolverFor(coords: readonly AgentCoord[]): AgentResolver {
  const table = new Map(coords.map((c) => [c.id, c]))
  return (agent: string): AgentCoord => {
    const found = table.get(agent)
    if (found === undefined) {
      const names = [...table.keys()]
      throw new SourceError(
        `没有这个 agent：${agent}——${names.length > 0 ? `有的是 ${names.join(' · ')}` : '一个都还没有'}。` +
          `不给 --agent 走的是持轮者那条路，两者不是一回事（架构 § 8.11）。`,
      )
    }
    return found
  }
}

/** 这个渲染器收到空值时给什么：与 `render.ts` 的 `emptyFor` 同一个口径。 */
function emptyFor(id: SegmentId, protocol: Protocol): SegmentValue {
  switch (protocol.renderers[id]) {
    case 'text':
      return ''
    case 'list':
      return []
    case 'file-block':
      return []
    case 'json':
      return {}
    default:
      return ''
  }
}

/** 工具目录那一段：名字 · 描述 · 参数面，与 `M9` 的目录同一份（Z3）。 */
function toolCatalogValue(): SegmentValue {
  return TOOL_ENTRIES.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

/** 我的任务那一段的文本：契约的几项，末尾按序追加产物路径。 */
function taskText(t: AssembleState['task'], outputs: readonly string[]): string {
  const lines: string[] = [`总目标：${t.goal}`, `问题：${t.question}`]
  if (t.deliverables.length > 0) lines.push(`交付物：${t.deliverables.join(' · ')}`)
  if (t.evidenceRequired.length > 0) lines.push(`要交的证据：${t.evidenceRequired.join(' · ')}`)
  if (t.assertions.length > 0) lines.push(`断言：${t.assertions.join(' · ')}`)
  if (outputs.length > 0) lines.push(`产物路径：${outputs.join(' · ')}`)
  return lines.join('\n')
}

/**
 * 契约要求的产物路径**机械追加在最后一段的末尾**（架构 § 8.11 · § 8.12）。
 *
 * 「机械」指的是这里没有判断：目录名怎么定是 `M11` 的事，这里只是把它拼进那一段的末尾——
 * 而末尾选得对（同一 agent 跨步不变 · 每步不重付 · 近因最好）是架构那一段的论证，不是这一
 * 份的选择。空清单不追加：不凭空造一个目录名。
 */
export function appendOutputs(text: string, outputs: readonly string[]): string {
  if (outputs.length === 0) return text
  return `${text === '' ? '' : `${text}\n`}产物路径：${outputs.join(' · ')}`
}

/** 段值从哪来：一句纯函数，收到（协议 · 状态 · 坐标）给出这一段的值。 */
interface SourceRule {
  readonly value: (s: AssembleState, who: AgentCoord | null) => SegmentValue
}

/**
 * 十二个段的源，一处。**键就是段的身份**（架构 § 8.11 的十二段）。
 *
 * 持轮者独占的两段（凝聚理解 · 压缩前最近几次原文）在这里也有源——它们的值今天由调用方给；
 * 「谁排进段的序」是协议的事，不是这一份的事。
 */
const SOURCES: Readonly<Record<SegmentId, SourceRule>> = {
  项目方针: { value: (s) => s.policy },
  系统状态: { value: (s) => s.system },
  代码树: { value: (s) => [...s.codeTree] },
  工作总目标: { value: (s) => s.goal },
  文件内容: {
    value: (s) =>
      s.files.map((f) => ({
        path: f.path,
        text: f.text,
      })),
  },
  提交序列: { value: (s) => [...s.commits] },
  交接提示词: { value: (s) => s.handoff },
  我的任务: { value: (s, who) => taskText(s.task, who === null ? [] : who.outputPaths) },
  凝聚理解: { value: (s) => s.distill },
  压缩前最近几次原文: { value: (s) => s.recent },
  // 运行时上下文是**积累段**：一句话加一串只追加的尾巴。空串与空尾巴都不产出分隔符。
  运行时上下文: {
    value: (s) => {
      const turns = s.turns ?? []
      if (turns.length === 0) return s.runtime
      return s.runtime === '' ? turns.join('\n') : `${s.runtime}\n${turns.join('\n')}`
    },
  },
  信号摘要: { value: (s) => [...s.signals] },
  上一步结果: { value: (s) => s.lastStep },
}

/** 十二个段的身份，按架构 § 8.11 那张表自上而下。 */
export const SOURCE_IDS: readonly SegmentId[] = Object.keys(SOURCES) as SegmentId[]

/**
 * 按这份协议产出它声明过的那些段的值。**键域 = 协议声明的段序**，一个不多一个不少。
 *
 * `who` 的两档不是两条代码路径：持轮者那一档是 `null`，于是「我的任务」没有产物路径可追加，
 * 而那一段本来也不在它的段序里（架构 § 8.11：它手里是全部契约）。谁排进序由协议说，不是
 * 由这里说。
 */
export function sourcesFor(protocol: Protocol, state: AssembleState, who: AgentCoord | null = HOLDER): Record<SegmentId, SegmentValue> {
  const out = {} as Record<SegmentId, SegmentValue>
  for (const id of protocol.segmentOrder) {
    const rule = SOURCES[id]
    out[id] = rule === undefined ? emptyFor(id, protocol) : rule.value(state, who)
  }
  return out
}

/** 十二个段各自的源都认得：`SOURCES` 的键域就是架构 § 8.11 那张表的两份声明合起来的段名。 */
export const SOURCE_NAMES: readonly SegmentId[] = SOURCE_IDS

/**
 * 项目方针那一段的源：`<realRoot>/AGENTS.md` 的字节。
 *
 * **它在真实工作树里，不在视图里**（架构 § 9.9）：模型只有视图内的相对路径，而这一份是给人
 * 编辑的——位置即纪律。读不到就给空串（地板那一档：那一段短了，装配照跑），不抛。
 */
export function readPolicy(realRoot: string): string {
  try {
    return readFileSync(join(realRoot, 'AGENTS.md'), 'utf8')
  } catch {
    return ''
  }
}
