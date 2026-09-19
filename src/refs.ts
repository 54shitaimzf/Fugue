// 身份模型里的 ref 命名方案。出处：架构 § 4。
//
// ```
// refs/heads/main
// refs/heads/agent/<round>/<n>
// refs/agents/<round>/<n>/ckpt/<seq>     分支内提交点，不移动分支头
// refs/tags/round/<round>/merged
// ```
//
// **它单独在这里，因为它不属于任何一个模块。** M0 只认 writer，M1 只认 ref；把 writer
// 翻译成 ref 是身份模型的事，两边都不该认识对方那半。而它又不能住在面里：`fugue commit`
// 与模型侧的 `checkpoint` 是同一个操作（§ 9.6），两个面都要这一处翻译。
//
// 只有行为是纯函数、没有任何 import 之外的副作用——所以谁都可以 import 它。
import type { RefName, WriterId } from './terms.ts'

/** writer → 它推进的 ref。round 级的写者走主线。 */
export function refFor(writer: WriterId): RefName {
  return writer === 'round' ? 'refs/heads/main' : `refs/heads/${writer}`
}
