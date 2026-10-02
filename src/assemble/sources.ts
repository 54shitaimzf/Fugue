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
// **读不出东西时给空值，不是异常**（PLAN § 5.6 的地板：代码树索引未建 · 工具目录那一档）。
// 渲染规则决定空值长什么样（`render.ts` 的 `emptyFor`）：文本给空串、列表给空数组、围栏块给
// 空数组、JSON 给空对象。**判据是那一条：那个机制死掉的时候，系统是变慢，还是跑不起来。**
//
// **而"这一段压根没有源"不是那一档**（0.2.9 ④）：`SOURCES` 以 `SegmentId` 这个封闭联合为键，
// 十三个段全在里头，协议声明的段序也从同一个联合来——所以"没有源"只可能来自一次越界的 cast。
// 原先那一支给它一个空值照跑，那是**造值**。判据搬进了 `tools/check-invariants.ts` 第三节
// （每个协议声明的段都有一份源；负对照里塞一段没有源的段，当场红），这里不再兜底。
//
// **不是源的几样**：宿主绝对路径 · 主机名 · Signal 原文（架构 § 8.11 的约束 2 · 3 · 4）——
// 这一份一个字段都不给它们留位置，所以它们进不了前缀。真正接上运行时的那些源（凝聚理解 ·
// 凝聚前最近几次原文 · 运行时上下文 · 上一步结果）今天由调用方给值，S7 · S8 才有人产它们。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Protocol, SegmentId, SegmentValue } from './contract.ts'

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
    /**
     * **这一格的写入面**（契约那一条 `declaredSetOf(contract)`：实现型是 `ownedPaths` · 解决型是
     * 冲突路径集 · 调查型是它那几份证据的路径）。
     *
     * 它与 `maxSteps` 同一档：逐 agent 不同、逐 agent 稳定，所以进 B 区；`undefined` 就是不写那
     * 一句（地板那一档：那一段短一行、装配照跑）。**投影只有一处**——派发那一层建句柄时从契约拿
     * （`src/cli/fugue.ts` 的 `stateFor`），与执行那一侧 `writeScope` · 回收那一侧 `declaredSetOf`
     * 读的是同一个集合（架构 § 8.9：产出经声明集回写）。
     */
    readonly ownedPaths?: readonly string[]
  }
  /**
   * **这一格最多走几步**（运行时那道花钱的上界 · `--max-steps`）。它同时也是一句要发给模型的话。
   *
   * 它进 B 区（同一格跨步稳定：这个数在整个轮次里不变），而且**只以"上限"的样子进去**——绝不
   * 写成"这是第几步"：那个字每步都变，B 区跨步复用那条性质当场破掉（`step` 到今天为止都不进
   * 前缀，正是同一个道理）。`undefined` 就不写这一句（地板那一档：那一段短一行，装配照跑）。
   *
   * 它为什么在状态里而不是在 `step()` 里现拼：装配有两处（`step` 里那一次与驱动算预算用的
   * `prefixOf` 那一次），两处读的必须是同一串字节——现拼就会各差这一段。
   */
  readonly maxSteps?: number
  readonly distill: string
  readonly recent: string
  readonly runtime: string
  /**
   * **这一步那一段**（`Runtime.step` 往里追加：每一步一个 `Turn`）。
   *
   * 结构化那一面与文本那一面同源：文本由 `turnText` 一处渲染，字节那一面（三区指纹 · 只追加）
   * 量的就是它，而发出去的那一面是 `ModelRequest.turns`（原生轮次）。两处不许各写一份。
   *
   * 它是 C 区那个积累段（架构 § 8.11 的「运行时上下文」：**只追加、不进日志、跨进程即失**）。
   * 单独一栏而不是拼进 `runtime` 那个字符串，是因为"只追加"这条性质要在**值**上看得见：
   * 拼字符串的话，改一个字与追加一段在类型上分不开，而 `B4` 的断言 ② 量的正是这件事
   * （相邻两步 `hash(A+B)` 不变 · 只有 C 那一串往后长）。
   */
  readonly turns?: readonly Turn[]
  readonly signals: readonly string[]
  readonly lastStep: string
}

/**
 * **C 区那一段的头**：只追加那条尾巴**之前**的那一半（架构 § 8.11：这一趟里那条自然增长的流，
 * 头是「人说的那一句」，尾巴是模型自己的输出与工具结果）。
 *
 * 它是那一段组成规则的**唯一一处说法**：`运行时上下文` 那一条源按它拼全文（头 + 尾巴），而
 * `runtime/step.ts` 按它把头发给适配器（`ModelRequest.cHead`）——适配器发原生轮次时尾巴换成
 * 轮次，头照旧要发。两处各写一句 `state.runtime` 的话，将来给这一段加一种前缀时，发出去的那
 * 一份不会跟着变，而**那不会报错**。
 */
export function cZoneHeadOf(s: AssembleState): string {
  return s.runtime
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
    task: { goal: '', question: '', deliverables: [], evidenceRequired: [], assertions: [], ownedPaths: [] },
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

// **这里原先有一个 `emptyFor(id, protocol)`**：段序里出现一个没有源的段时，它按渲染规则给一个
// 空值，装配照跑（0.2.9 ④ 撤了，理由见文件头那一段）。撤掉之后这个函数一个消费者都没有了，
// 所以一并删掉——留着它就是"两处真相"（它与 `render.ts` 的 `emptyFor` 是同一口径的两份实现，
// 而 `assemble()` 那一份才是路径上的那一份）。

/**
 * 一份路径清单 → **去重之后的清单**（次序照第一次出现）。
 *
 * 由头是一条真读数（第十五趟 · 案一 · `r1/2` 那一格的「我的任务」正文）：
 * `交付物：src/format.ts · src/format.ts · src/total.ts · README.md`——持轮者那份草案把同一条
 * 路径写了两遍，而这一行是**给模型看的**：重复的那一条只占地方，一个字的信息都不添（这一行
 * 本来只印路径，不印 `form`）。同一份草案若把同一条路径声明两次而 `form` 不同，**人读的那一份
 * 照旧印原始的那一对对**（`fugue round plan` 与门那份读数印的是 `路径（形状）`）——草案写了
 * 什么，报告里就要看得出什么，那是草案的毛病，不该在模型那一行里顺带抹掉。
 *
 * **它只归这一行与写入面那一行**：`Deliverables` 与 `Write surface` 说的都是"哪几条归你"，
 * 而"哪几条"天然是一个集合。断言的名单 · 证据的名单不在此列——那两句是出题人/草案的原话。
 */
export function pathSet(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

/**
 * **这一格最多几步**：这一格的预算那一句（人给的那个数，缺省不写）。**一处给**——子 agent 的
 * 「我的任务」与持轮者那一趟的收工口径（`round/plan.ts` 的 `holderClosingRuleLines`）念的是
 * 同一句。两处各写一份的症状是"两句话慢慢不一样了"，而它一个错都不报。
 *
 * 这个数整个轮次不变（同一格跨步稳定），所以它在 B 区那一段里占一行；而**绝不写成"这是第几步"**
 * ——那个字每步都变，B 区跨步复用那条性质当场破掉（`AssembleState.maxSteps` 那一段同一条理由）。
 *
 * **不替它挑一个数**：上界由人给（`runtime/step.ts` 那一段）；`undefined` 就是不写这一句，
 * 那一段短一行、装配照跑（地板那一档）。
 */
export function stepBudgetLine(maxSteps?: number): readonly string[] {
  return maxSteps === undefined ? [] : [`At most ${maxSteps} steps for this task.`]
}

/** **剩几步以内开始说**（`left ≤ 3`）：上界 8 那一档从第 5 步起，第 5 · 6 · 7 步各说一次
 * （第 8 步那一次模型已经用不上——步数到了就停）。它是个数，不是开关：留给模型"把产物落下去"
 * 的最小余量。
 *
 * **一个窗口管两格**（持轮者那一格 · 契约那一格）：它是"落产物的最小余量"这个量，不是上界的
 * 比例——上界 4 那一档因此从第 1 步起就说（那一档本来就只剩四步，那是实话）。
 */
export const STEPS_HINT_AT = 3

/**
 * **语言那一句**（谁读谁的语言：这一格是"模型面"那半）。
 *
 * 由头是第十六趟与第二十二趟那两组读数：模型自己的话**摇摆**——持轮者的收工话是中文
 * （`写好了 .fugue/plan/r1.md（本 pass 的交付物）…`）、子 agent 那一支两次英文一次中文
 * （`Done — README.md is the only file touched…` / `完成。README.md 已补上那句用法…`），
 * 而两趟的目标与材料都是中文。**那一句话哪里都不落**（提交信息是契书那一句 · `work.json`
 * 只有步数与停因 · `agent/stop` 只有 `steps` 与 `stopped`），所以它不是判据、是读数——
 * 可它是**唯一一处模型自己挑语言的地方**，而按已决口径（模型面英文 · 人面中文 · 双读者按模型
 * 那一侧）这一处该是英文。
 *
 * **两半都写出来**：模型自己的话（想什么 · 收工说什么）是模型面 → 英文；它交付的那些文件是
 * 人读的 → 注释与说明用中文。只写前一半的话，模型会把"英文"顺手带到产物的注释上（那正是人
 * 读的那一半）。**它进的是 B 区**（与那三句收工口径同一档：逐 agent 稳定、每步不重付），
 * 而"产物路径"仍然是最后一行（架构 § 8.11 那句"近因最好"）。
 *
 * **一处给**：子 agent 的「我的任务」与持轮者那一趟的收工口径（`round/plan.ts`）念的是同一句
 * ——两处各写一份，症状是"两句话慢慢不一样了"，而它一个错都不报。
 */
export const MODEL_FACING_LANGUAGE_LINE =
  'Say it in English: your own words here are read by the harness, not by a person. The files you deliver are read by people — write their comments and notes in Chinese.'

/**
 * **预算快用完时，回执末尾多一句"还剩几步"**。空串 = 不加。
 *
 * 由头有两处，同一个缺少：
 *   · **持轮者那一格**（样本盘第十一趟 · 案一 · 上界 8 · `--dump-wire` 实录）：那一趟 8 步全是
 *     读 / `glob` / `grep`，一个字节都没写——`.fugue/plan/r1.md` 不在视图里，门当场退回。B 区里
 *     已经有"这一格最多 8 步"与"草案没写出来这一趟就等于没跑"两句，而它们是**每趟只出现一次**
 *     的静态事实：那 8 步里没有一处提醒它"预算正在用完"。
 *   · **契约那一格**（样本盘第十六趟 · 案一 cap 16 第五趟）：持轮者这一趟没拆（整件事一格），
 *     那一格 16 步里 **10 步在视图之外找 TypeScript 编译器**，而工作第 5–6 步就做完了，最后停在
 *     16 步上界。它手里也有"这一格最多几步"（「我的任务」那一句），同样没有"正在用完"。
 *
 * **收工口径的第三面。** 它与写进「我的任务」那几句（先说在前面 · 每趟一次）· 拒的话（伸手之后
 * 回的那一句 · 一步一次）是同一件事的三面：先说 · 拒时再说 · 快用完时说。三面读的都是**同一个数**
 * （`--max-steps` 给的那个，也就是 `runtime` 停下来用的那个）——不另立一处"它以为还剩几步"的账
 * （W11 那一轮照出来的那一条）。
 *
 * **一处减法，两句话**：`left` 只在这里算一次；两格念的是同一个数、同一个句式，**收工那半句各自
 * 不同**（持轮者要的是那份草案，契约那一格要的是产物落下去），所以由调用方给。
 *
 * **上界那一刀在 `capReceipt` 之后再收一次**（调用方那一层已经收过）：这一句是常数长度，所以只在
 * 正文真到 8 KiB 时才动第二刀，而"单条回执 8 KiB"这条上界照旧成立。
 */
export function stepsLeftTail(step: number, maxSteps: number | undefined, closing: string): string {
  if (maxSteps === undefined) return ''
  const left = maxSteps - step - 1
  if (left < 0 || left > STEPS_HINT_AT) return ''
  return `\n(At most ${maxSteps} steps for this task · this is step ${step + 1}: ${left} left. ${closing})`
}

/**
 * **这一格的写入面**：哪几条归它（含它们下面），以及"别处一个字节都不要动"。
 *
 * 由头（样本盘第八 · 九 · 十趟真档 · 同一件事连着出现）：契约 `r1.implement.1` 声明
 * `src/format.ts` + `README.md`，而它看见 `legacy/old-format.js` 那份过时的死代码就 `rm -f` 掉
 * ——删的是**别的格**的地界。`write` / `edit` 那两条路当场拒（`writeScope`），而 `bash` 那一条
 * 按架构 § 8.7 只报不拒（拒 = 不收它 + 记事件），于是"别动别人的地界"这件事在**输入**这一侧没人
 * 说过。这一句补的就是它：与"我的任务"那几项同一档——模型无从得知、而这一趟非知道不可。
 *
 * **它只说边界，不说怎么干活**：写哪儿（产物路径）仍然排在最后一行（架构 § 8.11 的近因那条）。
 * 空集不写（没有边界可说的那一格：不凭空造一句）。
 */
export function writeScopeLine(paths: readonly string[] | undefined): readonly string[] {
  if (paths === undefined || paths.length === 0) return []
  return [
    `Write surface: ${pathSet(paths).join(' · ')} — these paths are yours, including everything under them.` +
      ' Do not change a single byte anywhere else, deleting included: if you find something stale, say so in your conclusion instead of clearing it away.',
  ]
}

/**
 * 我的任务那一段的文本：契约的几项 + **这一格的收工口径**，末尾按序追加产物路径。
 *
 * **收工口径那三句为什么在这里**（W11 那一轮真档照出来的）：那一格把活干完了，然后一直在
 * 自证与重写，直到步数到顶——"这一格最多几步" · "做完怎么交卷" · "断言谁跑" 三样事实它手里
 * 一件都没有。它们与产物路径同一档：逐 agent 不同、逐 agent 稳定，所以进 B 区（不是每步都要
 * 重付一遍的 C 区）。
 *
 * **产物路径仍然是最后一行**：架构 § 8.11 那句"近因最好"要的就是它落在模型动手的那个位置，
 * 所以这三句排在它**前面**——排在 `断言` 后面。
 *
 * **持轮者那一份另有两句**（`round/plan.ts` 的 `holderClosingRuleLines`）：它那一格没有可执行
 * 的树，而"这一格没有树"与"断言由 harness 跑"是同一件事的两面——区别只在那一格伸不伸得出手。
 */
function taskText(t: AssembleState['task'], outputs: readonly string[], maxSteps?: number): string {
  const lines: string[] = [`Goal: ${t.goal}`, `Question: ${t.question}`]
  if (t.deliverables.length > 0) lines.push(`Deliverables: ${pathSet(t.deliverables).join(' · ')}`)
  // **写入面排在交付物后面**：交付物是"交什么"，这一句是"哪几条归你"——同一档的两件事，
  // 而收工口径那三句照旧排在它们之后（它们与产物路径是一组）。
  lines.push(...writeScopeLine(t.ownedPaths))
  if (t.evidenceRequired.length > 0) lines.push(`Evidence required: ${t.evidenceRequired.join(' · ')}`)
  if (t.assertions.length > 0) lines.push(`Assertions: ${t.assertions.join(' · ')}`)
  // 三句收工口径。第一句是这一格的预算（人给的那个数，缺省不写）；另两句是常量：交卷那一下只能
  // 是"话说完了"（`end-turn`），而断言由 harness 跑、由它判过不过（架构 § 8.12 的分工表）。
  lines.push(...stepBudgetLine(maxSteps))
  lines.push('When the work is done, say so in one message and stop calling tools — handing in is ending the turn.')
  lines.push('The harness runs the assertions, not you.')
  // 语言那一句（`MODEL_FACING_LANGUAGE_LINE`）：模型自己的话是模型面，产物的注释是人面。
  lines.push(MODEL_FACING_LANGUAGE_LINE)
  if (outputs.length > 0) lines.push(`Output paths: ${outputs.join(' · ')}`)
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
  return `${text === '' ? '' : `${text}\n`}Output paths: ${outputs.join(' · ')}`
}

/**
 * 一个 `Turn` → 它那一段文本。**这是结构化那一面唯一的文本投影**（两处不许各写一份）。
 *
 * 里面只有两样：模型说的话，与每一条工具回了什么。**不带修订号、不带执行序号**——那些是架构
 * 内部的坐标，模型不需要看，看了也只是噪声（架构 § 8.11 约束 3 在 C 区这一侧的读法）。
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

/** 段值从哪来：一句纯函数，收到（协议 · 状态 · 坐标）给出这一段的值。 */
interface SourceRule {
  readonly value: (s: AssembleState, who: AgentCoord | null) => SegmentValue
}

/**
 * 十二个段的源，一处。**键就是段的身份**（架构 § 8.11 的十二段）。
 *
 * 持轮者独占的两段（凝聚理解 · 凝聚前最近几次原文）在这里也有源——它们的值今天由调用方给；
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
  我的任务: { value: (s, who) => taskText(s.task, who === null ? [] : who.outputPaths, s.maxSteps) },
  凝聚理解: { value: (s) => s.distill },
  凝聚前最近几次原文: { value: (s) => s.recent },
  // 运行时上下文是**积累段**：一句话加一串只追加的尾巴。空串与空尾巴都不产出分隔符。
  运行时上下文: {
    value: (s) => {
      const turns = (s.turns ?? []).map(turnText)
      const head = cZoneHeadOf(s)
      if (turns.length === 0) return head
      return head === '' ? turns.join('\n') : `${head}\n${turns.join('\n')}`
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
    // **没有兜底**（0.2.9 ④）：`SOURCES` 覆盖 `SegmentId` 的每一个字面量，而段序只可能由这个联合
    // 构成——"盖住了"这件事由 `tools/check-invariants.ts` 第三节量（负对照可红）。所以这里直接取，
    // 取不到是 TypeError 当场红，不是给一个空值继续装。
    out[id] = SOURCES[id].value(state, who)
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
