// 单区那一档（架构 § 3 的地板：装配那一层的退化档是**三区 → 单区**）。
//
// **它是走查的一步，不是产品的一部分。** 一行协议值：把段序收成只有 A 区那三段，于是
// `zoneB` 与 `zoneC` 是空字节，而三区哈希照常出得来、命令行照常跑。判据还是 § 3 那一条：
// 那个机制（分区）死掉的时候，系统是**变慢**（命中率掉下来 · 前缀变短），还是**跑不起来**。
//
// 三份协议值放在一起看：子 agent 十一段 · 持轮者十二段 · 单区三段。前两份是同一个版本号的
// 两个角色，第三份是**把分区本身退掉**——它连版本号都另起一个，因为它声明的东西不一样了。
import { assemble, hashOf } from '../src/assemble/assemble.ts'
import type { Protocol, SegmentId, SegmentValue } from '../src/assemble/contract.ts'
import { TOOL_NAMES, protocolOf } from '../src/assemble/protocol.ts'
import { SUBAGENT_PROTOCOL } from '../src/assemble/protocol.ts'
import { emptyState, sourcesFor } from '../src/assemble/sources.ts'

/** A 区那三段：`protocolOf(['A'])` 的段序就是它们。 */
const A_ONLY: Protocol = {
  version: 's6-1-single-zone',
  segmentOrder: protocolOf({ A: ['项目方针', '系统状态', '代码树'], B: [], C: [] }),
  toolCatalog: TOOL_NAMES,
  renderers: SUBAGENT_PROTOCOL.renderers,
}

const state = {
  ...emptyState(),
  policy: '# 项目方针\n\n- 单区那一档用的。\n',
  system: { workspace: 'fugue', platform: 'linux' },
  codeTree: ['src/index.ts'],
}

const segs = {} as Record<SegmentId, SegmentValue>
for (const id of A_ONLY.segmentOrder) segs[id] = sourcesFor(SUBAGENT_PROTOCOL, state, null)[id] as SegmentValue

const p = assemble({ protocol: A_ONLY, model: 'fugue-default', segments: segs })
const ok =
  p.zoneC.length === 0 &&
  p.zoneB.length === 0 &&
  p.zoneA.length > 0 &&
  hashOf(p.zoneA).length === 16 &&
  A_ONLY.segmentOrder.length === 3

console.log(`单区那一档 · 段序 ${A_ONLY.segmentOrder.join(' · ')}`)
console.log(`  A 区 ${p.zoneA.length} 字节 · ${hashOf(p.zoneA)}`)
console.log(`  B 区 ${p.zoneB.length} 字节 · C 区 ${p.zoneC.length} 字节（空字节是这一档的要义）`)
console.log(`  ${ok ? 'ok' : 'FAIL'}   单区那一档：三区哈希照常出得来，B 区与 C 区是空字节`)
process.exit(ok ? 0 : 1)
