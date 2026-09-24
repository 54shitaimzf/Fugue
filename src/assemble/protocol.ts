// 两个协议值：子 agent 一份 · 持轮者一份（架构 § 8.11 的两张表）。PLAN § 5.6 的 Z0。
//
// **两份值是同一段代码的两个输入。** 架构 § 8.11 末那句"持轮者用的是另一份 `Protocol` 值，
// 组装器的代码一行不改"——把两份一起交出来，这条纪律才被测过；只交一份的话，B 区那两段
// （`凝聚理解` · `压缩前最近几次原文`）永远不会有一条真读数。
//
// **这里只声明，不装配。** 渲染与拼接在 Z1，段的源在 Z4。这一份的产出就是那两个值加一条
// 载入时的核对：**两份声明的段的域必须恰好等于区表的域**——多一段少一段都只是字节不同，
// 没有别的报错，所以它必须是当场炸，不能等。
//
// **工具名的定义处不在这里**，在 src/capability/table.ts（架构 § 8.10 的工具目录 · § 8.9 的
// 能力表以它为键）。这一份只声明协议值，所以它读那一处，不另立一份：两份名字表不一致时，
// 前缀字节只是不同，没有别的报错。转发一行是为了让 Z0 的消费者（探针 · 走查）不必改 import。
export { TOOL_NAMES } from '../capability/table.ts'
import { TOOL_NAMES } from '../capability/table.ts'
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
  压缩前最近几次原文: 'text',
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

/** 按名字取一份协议。名字就是 `fugue assemble <protocol>` 那个参数。 */
export const PROTOCOLS: Readonly<Record<string, Protocol>> = {
  subagent: SUBAGENT_PROTOCOL,
  holder: HOLDER_PROTOCOL,
}

/**
 * 按名字取一份协议。**查不到就拒，不替它挑一份**——打错一个字应当报出来，而不是装配出一份
 * 看起来对的前缀（命令行那一栏的用法在 Z6）。
 */
export function protocolNamed(name: string): Protocol {
  const p = PROTOCOLS[name]
  if (p === undefined) {
    throw new Error(`没有这一份协议：${name}（有的是 ${Object.keys(PROTOCOLS).join(' · ')}）`)
  }
  return p
}

/**
 * 载入时的核对：**两份声明的段的域恰好等于区表的域**（架构 § 8.11 的"十二个段，三个区，
 * 各有其拥有者"）。
 *
 * 它为什么必须是当场炸：`Protocol.segmentOrder` 与 `ZONE_SEGMENTS` 分居两个文件，而两者
 * 不一致的后果**只有字节不同**——前缀缓存命中率掉下去，没有任何一方报错。少一段（某段源
 * 产出了值却没人排它的序）、多一段（排了序却没有源）、重复一段、渲染规则缺一条，四种都在这
 * 里拒。**它是这一站唯一一条"错了会静默"的地方的封口。**
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
  if (p.toolCatalog.length === 0) bad.push('工具目录是空的')
  return bad
}

for (const [name, p] of [
  ['subagent', SUBAGENT_PROTOCOL],
  ['holder', HOLDER_PROTOCOL],
] as const) {
  const bad = checkProtocolInvariant(p, name === 'holder' ? HOLDER_B : ZONE_SEGMENTS.B)
  if (bad.length > 0) {
    throw new Error(`协议 ${name} 与区表不一致：\n  ${bad.join('\n  ')}`)
  }
}
