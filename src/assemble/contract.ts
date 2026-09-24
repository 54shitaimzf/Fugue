// M10 的契约。出处：架构 § 8.11 的三份接口（`Prefix` · `Assembler` · `Protocol`）与 § 13.5 的
// `AssembleInput` 逐字照抄；`SegmentId` 与 `RendererId` 是它那两张表（十三个段名 · 三区）与
// § 8.10 那个目录所要求的形状。
//
// **"十二个段"与"十一个段"是同一件事的两种数法。** § 8.11 那个小标题数的是**一份声明排得下
// 的段**：工具目录 + 子 agent 的十一段；`segmentOrder` 管的是去掉工具目录那十一个。而两份
// 声明**合起来**出现的段名是**十三**个——持轮者的 B 区多两段、少一段。所以 `SegmentId` 是
// 十三元，每个协议值的段序是十一元，两者不是同一个数。
//
// **这一份只有类型。** 两个协议值在 `protocol.ts`，渲染与拼接在 `assemble.ts`（Z1），段的源在
// `sources.ts`（Z4）。消费者 import 的是 `Protocol` 与 `Prefix`，不是那几个实现：换渲染规则
// 不动调用点。
//
// **`工具目录` 不是这一份里的段。** 架构 § 8.11 把它列在区表的 A 区里（"十二个段"），可同一段
// 又写着 `segmentOrder` 管的是其中十一段——工具目录是 `tools` 字段，**位置由提供方定**，
// 我们对它只有稳定性要求（§ 8.10 的硬纪律 2）。所以它不进 `SegmentId`，也不进 `segmentOrder`：
// 它不是我们排的段，是随请求走的那份 schema。放进来的话，每个协议值都要为它补一条渲染规则，
// 而那条规则永远不该由我们写。
//
// **区不随协议变。** 区是稳定性等级（§ 8.11），对一切协议值成立；协议值声明的只是**段序与每段
// 的渲染规则**。所以区表是这一份里的常量 `ZONE_SEGMENTS`，两份协议各自用 `ZONE_SEGMENTS[zone]`
// 的顺序拼前缀。`protocol.ts` 在载入时核一次"两份声明的段的域 == 区表的域"，错了当场炸——
// **这条不变量跨两个文件，而它一旦破了，前缀缓存静默失效**（多一段少一段都只是字节不同，
// 没有别的报错）。
import type { AgentId, RoundId, RelPath } from '../terms.ts'

/** 模型目录里的那个名字（架构 § 10.2 的模型 · § 8.11 表外的"调用配置"）。 */
export type ModelId = string & { readonly __brand: 'ModelId' }

/** 一段的渲染规则。值域落在这一层：先只有实现的那几个（§ 8.11 的 `renderers`）。 */
export type RendererId = 'text' | 'file-block' | 'list' | 'json'

/**
 * 两份声明合起来出现的全部段名（架构 § 8.11 的区表 + 它下一张表）。
 *
 * **段的域定在这里，顺序不定在这里**——顺序在 `segmentOrder`（每个协议值自己一份：子 agent
 * 十一元 · 持轮者十二元）。
 */
export type SegmentId =
  | '项目方针'
  | '系统状态'
  | '代码树'
  | '工作总目标'
  | '文件内容'
  | '提交序列'
  | '交接提示词'
  | '我的任务'
  | '凝聚理解'
  | '压缩前最近几次原文'
  | '运行时上下文'
  | '信号摘要'
  | '上一步结果'

/** 三个区。区就是稳定性等级，它决定什么样的值放得进来（§ 8.11 的约束 3）。 */
export type Zone = 'A' | 'B' | 'C'

/**
 * 区表：每个区里段的顺序（架构 § 8.11 的第一张表逐字）。
 *
 * **区是稳定性等级，段的集合由协议值定。** 子 agent 与持轮者共用 A 区与 C 区，B 区各自一份
 * （持轮者多两段、少一段，见 `HOLDER_B`）——协议值声明的就是"哪些段 · 按什么序 · 怎么渲染"，
 * 而稳定性等级本身是架构里那三条，不随协议变。这一份给的是两个角色共用的那两区与子 agent
 * 那一份 B 区；持轮者的 B 区是下面那条常量。**两者都不是"唯一的区表"**。
 *
 * 缺的正是持轮者独占的那两段（`凝聚理解` · `压缩前最近几次原文`）：它们只出现在
 * `HOLDER_B` 里。于是"两份声明合起来十三个段名"这件事有一处定义，别处不重数一遍。
 */
export const ZONE_SEGMENTS: Readonly<Record<Zone, readonly SegmentId[]>> = {
  A: ['项目方针', '系统状态', '代码树'],
  B: ['工作总目标', '文件内容', '提交序列', '交接提示词', '我的任务'],
  C: ['运行时上下文', '信号摘要', '上一步结果'],
}

/** 持轮者的 B 区（§ 8.11 的第二张表）：多两段、少一段。 */
export const HOLDER_B: readonly SegmentId[] = [
  '工作总目标',
  '文件内容',
  '提交序列',
  '交接提示词',
  '凝聚理解',
  '压缩前最近几次原文',
]

/**
 * 一个段归哪个区：**分区是这一份里的常量，不是协议值里的一栏**。
 *
 * 十三元全部有值，而持轮者那份段序里没有 `我的任务` · 子 agent 那份里没有 `凝聚理解` 与
 * `压缩前最近几次原文`——**分区是全集的函数，段序是它的子集**。两者不同域这件事是刻意的：
 * 分区不随协议变（它是稳定性等级），协议变的是段序与渲染规则。
 */
export const ZONE_OF: Readonly<Record<SegmentId, Zone>> = {
  项目方针: 'A',
  系统状态: 'A',
  代码树: 'A',
  工作总目标: 'B',
  文件内容: 'B',
  提交序列: 'B',
  交接提示词: 'B',
  我的任务: 'B',
  凝聚理解: 'B',
  压缩前最近几次原文: 'B',
  运行时上下文: 'C',
  信号摘要: 'C',
  上一步结果: 'C',
}

/**
 * 一个段归哪一区（`zoneSplit` 的判据）。
 *
 * **它是这个函数、不是一张查表**：装配那一层拿到的就是它，于是「把某一段挪到另一个区」在
 * 测试里是一次显式的传参（Z1 的断言 ④），不需要动 `assemble()` 的签名。
 */
export type Partition = (id: SegmentId) => Zone

/** 分区：`ZONE_OF` 那张常量表。 */
export const DEFAULT_PARTITION: Partition = (id) => ZONE_OF[id]

/**
 * 段序 → 三个区（**排序的落点**，架构 § 13.4 的 P1）。
 *
 * `assemble()` 调的就是它，装配与测试因此共用同一条实现；给一份别的分区就得到另一份切法，
 * 而那份切法正是 Z1 断言 ④ 的红负对照。
 *
 * **没处可归就当场炸**：`ZONE_OF` 覆盖全部十三元，所以这里拒的只可能是「往 `SegmentId`
 * 里加了新段而没在 `ZONE_OF` 里给它一个区」——那种情况下少的是整个区的一段字节，没有别的报错。
 */
export function zoneSplit(
  order: readonly SegmentId[],
  partition: Partition = DEFAULT_PARTITION,
): Record<Zone, SegmentId[]> {
  const out: Record<Zone, SegmentId[]> = { A: [], B: [], C: [] }
  for (const id of order) {
    const z = partition(id)
    if (z !== 'A' && z !== 'B' && z !== 'C') throw new Error(`这一段不属于任何一个区：${id}`)
    out[z].push(id)
  }
  return out
}

/** 段的值。**值，不是句柄**（架构 § 13.4 的 P2）——所以它们只能是这四种形状。 */
export type SegmentValue =
  | string
  | readonly string[]
  | readonly { readonly path: RelPath; readonly text: string }[]
  | Readonly<Record<string, unknown>>

/**
 * 一个协议值：段序 · 每段的渲染规则 · 工具目录那十一分之一（架构 § 8.11）。
 *
 * **加一种段就是加一个键，类型不动**（§ 24 纪律 8）。这里唯一会长的是 `SegmentId` 那个联合，
 * 而它长的时候 `segmentOrder` 与 `renderers` 的键域跟着长——三处同域，编译期就管住了。
 */
export interface Protocol {
  readonly version: string
  readonly segmentOrder: readonly SegmentId[]
  readonly toolCatalog: readonly string[]
  readonly renderers: Readonly<Record<SegmentId, RendererId>>
}

/** 本轮前缀：三个区各一段字节（架构 § 8.11 的 `Prefix`）。 */
export interface Prefix {
  readonly zoneA: Uint8Array
  readonly zoneB: Uint8Array
  readonly zoneC: Uint8Array
}

/**
 * 一段字节的指纹：`sha256` 的前 16 位十六进制（口径在 `.fugue/backlog/s6-stitch.md` § 4）。
 *
 * **16 位是刻意的一半**：它不承担密码学强度，承担的是「同一份状态装配两次逐字节相同」这条读数
 * 在命令行上印得出来。前一轮的站前读数取的就是它，Z1 起由这一处算——探针里那份留着是为了
 * 对账（同一份字节两处各算一次，指纹不等就是某一处漂了）。
 */
export type Hash16 = string

/** 一区的读数：多少字节 · 指纹。**读数不是断言**——它是步骤审与走查看的材料。 */
export interface Reading {
  readonly bytes: number
  readonly hash: Hash16
}

/** 一份前缀的读数（架构 § 9.6 装配那一行的两栏）。`whole` 是 `A + B + C`，`ab` 是 `A + B`。 */
export interface PrefixReading {
  readonly zoneA: Reading
  readonly zoneB: Reading
  readonly zoneC: Reading
  readonly ab: Reading
  readonly whole: Reading
}

/**
 * 组装器的输入（架构 § 13.5 的 `AssembleInput`）。
 *
 * **全部输入是值，无服务句柄**（§ 13.4 的 P2）：签名里不出现 `ctx` · `Truth` · `View` ·
 * `Materializer`。段的源住在 `sources.ts`，它读状态、产出值，然后把值交给这里。
 */
export interface AssembleInput {
  readonly protocol: Protocol
  readonly model: ModelId
  /** 键域 = `protocol.segmentOrder` 的域（§ 8.11）。 */
  readonly segments: Readonly<Partial<Record<SegmentId, SegmentValue>>>
}

/**
 * 组装器（架构 § 8.11）。**只做三件事：排序 · 渲染 · 拼接**（§ 13.4 的 P1）——纯函数，
 * 不查环境、不写状态，所以给一份状态快照就能离线测（P3）。
 */
export interface Assembler {
  assemble(i: AssembleInput): Prefix
}

/** 装配一次要读谁的视图（§ 9.6：`--agent` 等价于选一份日志；`round` 是主线）。 */
export interface AssembleWho {
  readonly agent: AgentId
  readonly round: RoundId
}
