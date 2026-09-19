// 共享词汇：状态用到的标识符与小值域。
//
// **只有类型，没有行为，不依赖任何东西。** 依赖方向是单向的：谁都可以依赖它，
// 它不依赖谁。它存在的理由只有一条——同一个名字只有一处定义。
//
// 值域的出处逐个注明。凡架构里标为未决的，这里就停在未决，不替它定下来。

/** 架构 § 4：只品牌这三个。三者混淆的后果最严重，其余用 string 加命名约定。 */
export type Branded<T extends string> = string & { readonly __brand: T }

export type WorkspaceId = string
export type RoundId = string
export type ContractId = string
export type AgentId = Branded<'AgentId'>
export type BranchId = Branded<'BranchId'>
export type CommitId = Branded<'CommitId'>
export type StepId = string
export type ViewRev = number
export type SignalId = string

/** 视图内的相对路径。 */
export type RelPath = string

/** git 侧的名字，架构 § 17 把它们列为需先冻结的接口。 */
export type RefName = string
export type BlobId = string
export type TreeId = string

/** 日志的位置与序号。序号由该 writer 自己的计数器发放，从 1 起。 */
export type LogSeq = number
export type WriterId = AgentId | 'round'
export interface LogPos {
  writer: WriterId
  seq: LogSeq
}

/** 架构 § 8.13 的状态机取值。 */
export type RoundState =
  | 'Idle'
  | 'Planning'
  | 'Delegated'
  | 'Working'
  | 'Collecting'
  | 'Merging'
  | 'Verifying'
  | 'Committed'
  | 'Rebuilding'
  | 'Aborted'

/** 架构 § 8.8 的策略面：一份策略值，两个强制点。 */
export type PolicyMode = 'read-only' | 'workspace-write'
export type Enforcement = 'full' | 'partial'

/** 架构 § 8.5 的四档 fork 策略。 */
export type ForkStrategy = 'reflink' | 'overlayfs' | 'hardlink-ro' | 'copy'

/** 未决：架构 § 23 U4 —— `SignalKind` 的类型系统与触发判据都还没定。 */
export type SignalKind = string

/** 未决：架构 § 23 U9 —— 形状待补，值域持有者已指名（§ 8.12）。 */
export type AssertionResult = unknown
