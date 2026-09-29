// 条件等待（U17）：**问到条件成立再往下走**，不赌"睡这么久应该够"。
//
// 固定时长的睡有两副面孔，这里只换得动一副：「等某个异步效果出现」（四个孩子走到栅栏前 ·
// 子进程死透 · 快照稳定）——那一副赌时长，CI 慢一步就 flaky，快了又白等；换成每 10ms 问一次
// `cond`，真了立刻回，到 `ms` 还没真就**抛**（等不到是错，不是白等）。另一副换不动也不该换：
// 时钟垫层（保证两次读数隔着足够的墙钟差，`utimesSync` 前后那一睡）与并发窗口（子进程之间
// 按定义没有可共享的坐标——隔离正是被测性质，窗口只能用时长撑）仍是固定睡，落在各自的用例里。
import { setTimeout as sleep } from 'node:timers/promises'

/** 问的步长：再短就只是在量事件循环的空转（读数快照那一类条件本来就以十毫秒为单位变化）。 */
export const WAIT_STEP_MS = 10

/**
 * 等到 `cond` 为真。每 `WAIT_STEP_MS` 毫秒问一次；`ms` 是**上限不是目标**——条件早就真了
 * 就立刻回。到上限还没真就抛（带上 `what` 说在等什么），让"等不到"以失败的面目出现，
 * 而不是把慢一拍的下游变成串到下一个断言里的鬼影。
 */
export async function waitUntil(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (cond()) return
    if (Date.now() >= deadline) throw new Error(`等了 ${ms}ms 还没等到：${what}`)
    await sleep(WAIT_STEP_MS)
  }
}
