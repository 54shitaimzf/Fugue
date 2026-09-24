// 段值缺源那一档（PLAN § 5.6 的地板）：**代码树那一段的源不在时，A 区仍是确定性的**。
//
// **它是走查的一步，不是产品的一部分。** 判据是 § 3 那一条：索引没建的时候，装配是**变慢**
// （A 区少一段 · 前缀变短），还是**跑不起来**。这里量三样：缺源那一段给的是空值不是异常、
// A 区照样出得来哈希、同一份输入再装一次逐字节相同。
import { assemble, hashOf } from '../src/assemble/assemble.ts'
import { SUBAGENT_PROTOCOL } from '../src/assemble/protocol.ts'
import { emptyState, sourcesFor } from '../src/assemble/sources.ts'

const st = { ...emptyState(), policy: '# 方针\n', system: { workspace: 'fugue' }, codeTree: [] }
const one = assemble({ protocol: SUBAGENT_PROTOCOL, model: 'fugue-default', segments: sourcesFor(SUBAGENT_PROTOCOL, st, null) })
const two = assemble({ protocol: SUBAGENT_PROTOCOL, model: 'fugue-default', segments: sourcesFor(SUBAGENT_PROTOCOL, st, null) })

const hasHash = /^[0-9a-f]{16}$/.test(hashOf(one.zoneA))
const deterministic = hashOf(one.zoneA) === hashOf(two.zoneA) && one.zoneA.length === two.zoneA.length
const nonEmpty = one.zoneA.length > 0

console.log(`段值缺源那一档 · 代码树那一段没有源（索引未建）`)
console.log(`  A 区 ${one.zoneA.length} 字节 · ${hashOf(one.zoneA)}`)
console.log(`  再装一次：${hashOf(two.zoneA)}`)
console.log(`  ${nonEmpty && hasHash && deterministic ? 'ok' : 'FAIL'}   缺源给的是空值不是异常：A 区少一段、仍然确定性`)
process.exit(nonEmpty && hasHash && deterministic ? 0 : 1)
