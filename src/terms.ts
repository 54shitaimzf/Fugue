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

/**
 * 虚拟空间之外的绝对路径：一个物理落点（架构 § 8.4 的四个根 · § 8.6 把 `cwd` 翻成物理路径）。
 * 它在这里而不是在 M3 的契约里，因为 M3 · M4 · M5 都要说这个词，而它只该有一个定义。
 */
export type AbsPath = string

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

/**
 * 架构 § 8.6 的 `RunSpec.action` · § 15.3.a 的"动作名"：工作区配置里 `actions.<名字>` 的那个
 * 名字。它是一个键，不是一段路径——所以没有品牌，与 `StepId` 同一条口径。
 */
export type ActionName = string

/** 架构 § 8.8 的策略面：一份策略值，两个强制点。 */
export type PolicyMode = 'read-only' | 'workspace-write'
export type Enforcement = 'full' | 'partial'

/** 架构 § 8.8 的 `Policy.net`：网络那一档。缺省 `none`；动作在配置里点名才 `host`（§ 15.3.a）。 */
export type NetMode = 'none' | 'host'

/** 架构 § 8.8 的 `Policy.layers`：这一趟在场的层——**探出来的，不是人写的**（§ 15.7 的 E4）。 */
export type PolicyLayer = 'bwrap' | 'landlock'

/** 架构 § 8.5 的四档 fork 策略。 */
export type ForkStrategy = 'reflink' | 'overlayfs' | 'hardlink-ro' | 'copy'

/** 未决：架构 § 23 U4 —— `SignalKind` 的类型系统与触发判据都还没定。 */
export type SignalKind = string

/**
 * 一次验收的取值：**通过 · 没通过 · 跑不起来**（架构 § 8.12 末段 · § 23 U9「已定：S7 的 A0」）。
 *
 * **它进事件，所以只带取值。** 架构 § 8.1 的 `merge/accept` 那一行是 `assertions:
 * AssertionResult[]`，而事件联合只依赖这一份词汇表。三档一次定在这里、事件那一头直接引它，
 * 比在事件里另写一遍判别联合少一个会漂的副本。
 *
 * **档案（哪一条断言 · 退出码 · 几毫秒 · 为什么跑不起来）在 `contract/types.ts` 的
 * `AssertionResult` 里**：报告与打回率读那一份，事件这一头只读这个取值。
 */
export type AssertionVerdict = 'pass' | 'fail' | 'unrunnable'

/** 一条断言的判决：值域见 `AssertionVerdict`，形状见 `contract/types.ts`。 */
export type AssertionResult = { readonly assertion: string; readonly verdict: AssertionVerdict }
