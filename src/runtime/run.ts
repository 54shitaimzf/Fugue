// 一个 agent 的收敛：`step` 至收敛（架构 § 14.2 的 `Runtime.run`）。PLAN § 5.8 的 `B4`。
//
// **它是一层皮，不是第二种循环。** 收敛的判据、步数的上限、下一步的状态都归 `step.ts` 的
// `createRuntime().run`（一处实现）；这一份只把"一个 agent 跑到底"的返回值摆成一个有名字的
// 形状（`RunResult`），别处 import 它就不必知道 `Runtime` 的形状里还有别的什么。
//
// **两种停法分得开**：`done`（它说完了）· `failed`（它没能说完 / 流半截 / 工具抛了 / 步数到顶）。
// 预算那一条线（`B6` 的交接）到触发点时**先停**——那时这一层报的是 `done` 还是 `failed`，
// 由 `B6` 决定（今天没有预算这一档，所以只有那两种停法）。
import type { AgentHandle, Runtime, StepResult } from './step.ts'

/** 一个 agent 跑到底的产出：最后那一步 + 走过的步数。 */
export interface RunResult {
  readonly last: StepResult
  readonly steps: number
}

/** `step` 至收敛。**就是 `Runtime.run`**（这一份只是把它摆成一个带名字的入口）。 */
export function runSteps(rt: Runtime, h: AgentHandle, signal: AbortSignal): Promise<RunResult> {
  return rt.run(h, signal)
}
