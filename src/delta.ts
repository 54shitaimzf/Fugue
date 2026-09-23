// 变更：路径上有什么，怎么变。出处：架构 § 8.3 的 `Delta`，逐字。
//
// **它是三个模块唯一共享的东西**（§ 8.3）：`M2.diff()` 产出它，`M4` 与 `M6` 消费它，
// `M6.collect()` 产出它，`M2.applyDelta()` 消费它。住进 M2 的契约文件，M4/M6 就变成
// 反向 import M2——那句话（"三个模块只共享这一个类型，互不引用"）正是要挡掉这个。
//
// 共享的东西除了类型，还有 `mode` 那一栏的取值规则：**git 只把文件记成两种模式**，而
// `M2`（写进日志的那一步）与 `M6`（从缓存里读出来的那一步）都要归一到它们。规则只有
// `normMode` 一处——两处各写一遍的话，"chmod 644 落到一个 644 的文件上"这类判断就会
// 在上游漏掉（X0 收的就是这一处）。
import type { RelPath } from './terms.ts'

export type Delta =
  | { kind: 'add'; path: RelPath; bytes: Uint8Array; mode: number }
  | { kind: 'modify'; path: RelPath; bytes: Uint8Array; mode: number }
  | { kind: 'delete'; path: RelPath }
  | { kind: 'rename'; from: RelPath; to: RelPath }
  | { kind: 'chmod'; path: RelPath; mode: number }
  | { kind: 'symlink'; path: RelPath; target: string }

/** 模式的两档。**它们是 `Delta.mode` 的全部取值**，也是 git 的全部取值。 */
export const MODE_FILE = 0o100644
export const MODE_EXEC = 0o100755

/**
 * 归一只有这一处：有执行位就是 `100755`，否则 `100644`。
 *
 * `chmod 700` 落在一个 755 的文件上不是一次变更，判它的 `view/edit.ts` 的 `chmodNoop`
 * 也从这里出发；`M6` 收回来的产出带的是盘上的真实模式（可能是 `100600`），进日志之前
 * 同样过它——不然日志里那一栏与视图里那一个就不是同一个数（§ 8.3：`diff()` 在重放前后
 * 要逐字节一致）。
 */
export function normMode(mode: number): number {
  return (mode & 0o111) === 0 ? MODE_FILE : MODE_EXEC
}
