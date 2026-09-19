// 变更：路径上有什么，怎么变。出处：架构 § 8.3 的 `Delta`，逐字。
//
// **它是三个模块唯一共享的类型**（§ 8.3）：`M2.diff()` 产出它，`M4` 与 `M6` 消费它，
// `M6.collect()` 产出它，`M2.applyDelta()` 消费它。住进 M2 的契约文件，M4/M6 就变成
// 反向 import M2——那句话（"三个模块只共享这一个类型，互不引用"）正是要挡掉这个。
import type { RelPath } from './terms.ts'

export type Delta =
  | { kind: 'add'; path: RelPath; bytes: Uint8Array; mode: number }
  | { kind: 'modify'; path: RelPath; bytes: Uint8Array; mode: number }
  | { kind: 'delete'; path: RelPath }
  | { kind: 'rename'; from: RelPath; to: RelPath }
  | { kind: 'chmod'; path: RelPath; mode: number }
  | { kind: 'symlink'; path: RelPath; target: string }
