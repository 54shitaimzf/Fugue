// 身份模型：一个 writer 落在两侧的名字。出处：架构 § 4。
//
// ```
// refs/heads/main
// refs/heads/agent/<round>/<n>
// refs/agents/<round>/<n>/ckpt/<seq>     分支内提交点，不移动分支头
// refs/tags/round/<round>/merged
// ```
//
// **它单独在这里，因为它不属于任何一个模块。** M0 只认 writer，M1 只认 ref；把 writer
// 翻译成这两者之一，是身份模型的事，两边都不该认识对方那半。而它又不能住在面里：
// `fugue commit` 与模型侧的 `checkpoint` 是同一个操作（§ 9.6），两个面都要这一处翻译。
//
// **两处翻译，两种用途，各有各的归一。** `refFor` 给 git 侧——一次提交推到哪条分支；
// `agentFor` 给日志侧——这一行是谁写的。二者都从同一个 `WriterId` 出发，所以"谁是主线"
// 这个问题只有 § 4 一处答案，没有第二份。
//
// 只有行为是纯函数、没有任何 import 之外的副作用——所以谁都可以 import 它。
import type { AgentId, RefName, WriterId } from './terms.ts'

/** writer → 它推进的 ref。round 级的写者走主线。 */
export function refFor(writer: WriterId): RefName {
  return writer === 'round' ? 'refs/heads/main' : `refs/heads/${writer}`
}

/**
 * writer → 它落日志、落视图时用的 agent 署名。
 *
 * **`round` 是一个 agent 的名字，不是无名占位**：它标的是持轮者这个位置，而持轮者就是主
 * agent（§ 4）——第 3 轮与第 7 轮的持轮者可以是两个不同的 agent，位置上写的一直是这个名字。
 * 人敲 `fugue write` 写的也是它，人与持轮者因此落在同一条主干上。
 *
 * 之所以需要这一处：`WriterId` 比 `AgentId` 宽（`AgentId | 'round'`）。日志的 `append` 与
 * `readByWriter` 收的是位置——那里要的是"哪一份日志"；而事件的 `agent` 字段与 `View.id`
 * 要的是"哪个 agent"（§ 8.1 · § 8.3）。**这个转换只此一处**，面 · 视图 · 日志三处都不
 * 各自转一次。
 */
export function agentFor(writer: WriterId): AgentId {
  return writer as AgentId
}
