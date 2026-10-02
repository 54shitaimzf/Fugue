// 两个协议值：子 agent 一份 · 持轮者一份（架构 § 8.11 的两张表）。PLAN § 5.6 的 Z0。
//
// **两份值是同一段代码的两个输入。** 架构 § 8.11 末那句"持轮者用的是另一份 `Protocol` 值，
// 组装器的代码一行不改"——把两份一起交出来，这条纪律才被测过；只交一份的话，B 区那两段
// （`凝聚理解` · `凝聚前最近几次原文`）永远不会有一条真读数。
//
// **这里只声明，不装配。** 渲染与拼接在 Z1，段的源在 Z4。这一份的产出就是那两个值加一条
// 载入时的核对：**两份声明的段的域必须恰好等于区表的域**——多一段少一段都只是字节不同，
// 没有别的报错，所以它必须是当场炸，不能等。
//
// **工具名的定义处不在这里**，在 src/tools/catalog.ts（架构 § 8.10 的工具目录：名字 · 描述 ·
// parameters）。这一份只声明协议值，所以它读那一处，不另立一份；而目录的字节与它的指纹在
// catalog.ts 里，两者同源。转发一行是为了让 Z0 的消费者（探针 · 走查）不必改 import。
export { TOOL_NAMES } from '../tools/catalog.ts'
import { TOOL_NAMES } from '../tools/catalog.ts'
import type { Protocol, RendererId, SegmentId, Zone } from './contract.ts'
import { HOLDER_B, ZONE_SEGMENTS } from './contract.ts'

/**
 * 每段的渲染规则（架构 § 8.11 的 `renderers`）。
 *
 * 形状的由头逐条：`项目方针` · `系统状态` · `代码树` 是声明，`代码树` 给的是路径列表；
 * `文件内容` 要带路径才能读，所以是围栏块；`提交序列` 是一行一条；其余是原样文本。
 * **`我的任务` 是文本而不是 JSON**：契约为它追加的产物路径是机械拼在末尾的（§ 8.12），
 * 走结构化序列化就要为"末尾追加"造一个字段，那是把渲染规则塞进数据里。
 */
const RENDERERS: Readonly<Record<SegmentId, RendererId>> = {
  项目方针: 'text',
  系统状态: 'json',
  代码树: 'list',
  工作总目标: 'text',
  文件内容: 'file-block',
  提交序列: 'list',
  交接提示词: 'text',
  我的任务: 'text',
  凝聚理解: 'text',
  凝聚前最近几次原文: 'text',
  运行时上下文: 'text',
  信号摘要: 'list',
  上一步结果: 'text',
}

/** 三个区各自的那一串段：没给的那一区取 `ZONE_SEGMENTS`（子 agent 的形状）。 */
export type ZoneTable = Readonly<Partial<Record<Zone, readonly SegmentId[]>>>

/**
 * 段序 = A 区 → B 区 → C 区。**它是区表的投影，不是第二份数据。**
 *
 * 位置由区决定这条纪律落在这里：要挪一个段，挪的是区表里的位置，段序跟着变——没有一处地方
 * 能单独改段序而不改区表（`checkProtocolInvariant` 也核这一点）。
 */
export function protocolOf(zones: ZoneTable = {}): SegmentId[] {
  return [...(zones.A ?? ZONE_SEGMENTS.A), ...(zones.B ?? ZONE_SEGMENTS.B), ...(zones.C ?? ZONE_SEGMENTS.C)]
}

/**
 * 子 agent 的协议：B 区五段（`我的任务` 在最后——它是稳定部分的最后一句，§ 8.11）。
 */
export const SUBAGENT_PROTOCOL: Protocol = {
  version: 's6-1',
  segmentOrder: protocolOf(),
  toolCatalog: TOOL_NAMES,
  renderers: RENDERERS,
}

/**
 * 持轮者的协议：**同一个版本号**——两份值的差别是角色，不是协议版本。
 */
export const HOLDER_PROTOCOL: Protocol = {
  version: 's6-1',
  segmentOrder: protocolOf({ B: HOLDER_B }),
  toolCatalog: TOOL_NAMES,
  renderers: RENDERERS,
}

/**
 * 那一份协议值的名字，一处。**顺序就是 PROTOCOLS 的键序**（第一条是缺省那一份）。
 *
 * 它是函数不是常量：`PROTOCOLS` 的声明在这一份的下面，常量会在模块求值时踩到 TDZ；
 * 函数声明会提升，调用者读到的永远是"此刻的那张表"。
 *
 * 它是名字的值域，给两处读：命令行拒一个不认识的名字（protocolNamed），模型声明核对
 * "这个模型指的协议真的存在"（src/model/contract.ts 载入时那一次核对）。后者是本条
 * 存在的理由——声明里写错一个协议名，后果是**装配出来的前缀是别人的那一份**：多一段
 * 少一段都只是字节不同，没有别的报错，前缀缓存静默失效。
 */
export function protocolNames(): readonly string[] {
  return Object.keys(PROTOCOLS)
}

/** 按名字取一份协议。名字就是 `fugue assemble <protocol>` 那个参数。 */
export const PROTOCOLS: Readonly<Record<string, Protocol>> = {
  subagent: SUBAGENT_PROTOCOL,
  holder: HOLDER_PROTOCOL,
}

/**
 * 按名字取一份协议。**查不到就拒，不替它挑一份**——打错一个字应当报出来，而不是装配出一份
 * 看起来对的前缀（命令行那一栏的用法在 Z6）。
 */
/**
 * 一个模型声明 → 它读的那一份协议。**这一份里唯一一处把声明翻成协议值的地方。**
 *
 * 为什么它必须是函数而不是调用点各查各的表：协议的选法原先散在调用点里（`handleFor` 那一处
 * 就写死过 `HOLDER_PROTOCOL`），于是"子 agent 拿哪一份"这件事有两个答案，而两者不一致的后果
 * **只有字节不同**——B 区少一段、前缀缓存静默失效，没有一处报错。收成一处之后，调用点只
 * 知道"按这个声明装配"，不知道有哪两份协议。
 *
 * 声明里那个名字是不是存在，`src/model/contract.ts` 载入时已经核过一遍（那里有名字的值域）；
 * 这里再核一次，理由是**这一份不该假设调用方核过**——命令行 `fugue assemble` 那一路拿到的
 * 名字直接来自参数，不经过模型声明。
 */
export function protocolFor(m: { readonly protocol: string }): Protocol {
  const p = PROTOCOLS[m.protocol]
  if (p === undefined) {
    throw new Error(`这个模型指的协议没有这一份：${m.protocol}（有的是 ${protocolNames().join(' · ')}）`)
  }
  return p
}

export function protocolNamed(name: string): Protocol {
  const p = PROTOCOLS[name]
  if (p === undefined) {
    throw new Error(`没有这一份协议：${name}（有的是 ${protocolNames().join(' · ')}）`)
  }
  return p
}

/**
 * 两份声明的段的域**恰好等于区表的域**（架构 § 8.11 的"十二个段，三个区，各有其拥有者"）。
 *
 * 它为什么非有不可：`Protocol.segmentOrder` 与 `ZONE_SEGMENTS` 分居两个文件，而两者不一致的
 * 后果**只有字节不同**——前缀缓存命中率掉下去，没有任何一方报错。少一段（某段源产出了值却没人
 * 排它的序）、多一段（排了序却没有源）、重复一段、渲染规则缺一条，四种都在这里报。
 *
 * **它是一条判据，不是一道闸**（清障批 ②）：原先它还在模块载入时被调一遍（不一致就 throw），
 * 现在那一道撤了，读它的地方是 `tools/check-invariants.ts` 第二节——挂在 fast 组，红了就是红
 * 了，而生产路径上不再为"我们自己的两份声明对不对得上"付一次载入时的核对。
 */
export function checkProtocolInvariant(p: Protocol, zoneB: readonly SegmentId[]): string[] {
  const bad: string[] = []
  const table = new Set<SegmentId>([...ZONE_SEGMENTS.A, ...zoneB, ...ZONE_SEGMENTS.C])
  const seen = new Set<SegmentId>()
  for (const id of p.segmentOrder) {
    if (seen.has(id)) bad.push(`段序里出现了两次：${id}`)
    seen.add(id)
    if (!table.has(id)) bad.push(`这一段不属于任何一个区：${id}`)
    if (p.renderers[id] === undefined) bad.push(`这一段没有渲染规则：${id}`)
  }
  for (const id of table) {
    if (!seen.has(id)) bad.push(`区表里有这一段，段序里没有：${id}`)
  }
  const names = [...p.toolCatalog]
  if (names.length === 0) bad.push('工具目录是空的')
  // **这里原先还有一句"协议里那一栏与目录那一份是不是同一份"——它是恒真的**（清障批 ②）：
  // 两份协议值的 `toolCatalog` 就是 `TOOL_NAMES` 这个**同一个数组引用**，拿它与自己逐元素比，
  // 永远相等。真正的跨文件那道缝（能力表 ↔ 工具目录）由 `tools/check-invariants.ts` 第一节守。
  return bad
}

// **载入时那道闸撤了**（清障批 ②）：两份协议值与区表对不对得上，由
// `tools/check-invariants.ts` 第二节判（正半真状态 0 处 · 负半六种坏声明各报一处），
// 挂在 `test/check-invariants.test.ts`（fast 组）。判据还在上面那个函数里，一处没变。
