// M5 的契约。出处：架构 § 8.6——`RunSpec` 与 `Executor` 逐字；`RunResult` 是那条签名
// （`Promise<RunResult>`）所要求的形状，字段取自 § 8.1 的 `run/end { exit, ms, denied }`。
//
// **`ConfinedArgv` 在 S4 是暂居的。** 架构 § 8.6 说它由能力层经 `M7.confine()` 包装后传进来，
// 而 `M7` 是 S5：这一站由命令面构造它（`confine.ts`），把"怎么包"收在一处，S5 落地时整体
// 收进策略——**不在命令面另立一层**（PLAN § 5.4 的两处口径）。
//
// **只有类型，没有行为。** 包装在 `confine.ts` · spawn 与流在 `exec.ts` · 动作绑定在
// `binding.ts`，三个消费者各自 import 这一份：换实现不动调用点。
import type { ActionName, AgentId, Enforcement, PolicyMode, RelPath } from '../terms.ts'

/** 一个已经包好的命令行：第一段就是沙箱自己。 */
export interface ConfinedArgv {
  /** 真正 spawn 的那个命令行。 */
  readonly argv: readonly string[]
  /**
   * 用哪一层关起来的：`bwrap`（挂载层。两层叠着时也记它——主层是它）· `landlock`（挂载层不在，
   * 第二层接过来，Y6 那一档）· `none`（两层都不在，X4 的退化档：命令行就是它自己）。
   */
  readonly mechanism: 'bwrap' | 'landlock' | 'none'
  /** 架构 § 8.8 的策略面：这一趟跑在哪个模式下（那个事件要它）。 */
  readonly mode: PolicyMode
  /** 如实报告，绝不夸大：`full` = 树只读 + 声明目录可写这一档真的关上了。 */
  readonly enforcement: Enforcement
}

export interface RunSpec {
  readonly action: ActionName
  readonly confined: ConfinedArgv
  /** 视图内的相对路径。S4 由 `confine` 落成 bwrap 的 `--chdir`（S5 收进 `M7` 时同一处）。 */
  readonly cwd: RelPath
  /** 已由调用方重写 HOME / TMPDIR / XDG_*：本 agent 的坐标，`binding.ts` 一处给。 */
  readonly env: Record<string, string>
}

export interface RunResult {
  readonly exit: number
  readonly ms: number
  /**
   * 这一趟里出现了沙箱的拒绝签名。
   *
   * **它是读出来的，不是内核给的**：子进程 `open()` 拿 errno 30 (EROFS)，而父进程手里只剩
   * 退出码与 stderr 那一句（S4 前那次实测）。所以这条读的是 stderr 上的那几种文案，
   * 判据写在 `exec.ts` 一处。
   */
  readonly denied: boolean
  readonly enforcement: Enforcement
  readonly stdout: string
  readonly stderr: string
}

export interface Executor {
  run(a: AgentId, spec: RunSpec, signal: AbortSignal): Promise<RunResult>
}
