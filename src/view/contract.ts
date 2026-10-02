// M2 的契约。出处：架构 § 8.3——类型逐字照抄，五处补全是"把 § 8.3 写全"所必需的：
//
// 1. `loadView` 的第三个参数收一个 `lower`。§ 8.3 的正文明说 `lower` 按需从 M1 懒加载，
//    而它的签名里没有一条到 M1 的路。给的是一个**只读端口**（`Lower`）：视图拿不到写路径。
// 2. `base` 可以是 `null`——新仓库一个提交都没有，视图的上层就是全部。为了有个 base 去
//    造一个空提交，是把读变成写。
// 3. 五个变更方法与 `applyDelta` 是异步的。视图有一半是懒的：改一个只在 base 里有的路径
//    要先把它读上来（改名 · 改权限），同步签名只能靠漏掉这一半来维持。
// 4. `stat` / `list` 给出的 `id`：上层建出来的目录没有对象，给空树占位（`entries.ts`）；
//    判据是 `kind`，要内容走 `list`。
// 5. `state` 与 `snap`：快照（§ 9.4 的第一步）要一份**可持久的上层**，而它必须是
//    「日志前缀的折叠」而不是「此刻这棵树长什么样」——后者含下层，base 一前移就过期。
// 6. `kindOf`：一次写算新增还是改写，**只有视图答得对**。重放那边按上层重新定名
//    （`view.ts` 的 `kindFor`），所以装配体落日志前必须问同一句话，否则同一份日志在
//    活路径与重放上给出两份不同的 `diff()`——§ 8.3 要求它逐字节一致。
//
// 另有一步不属于 § 8.3 的读法但必须存在：`check`。日志行一旦落下就是历史，重放会照它
// 执行——所以"这个变更能不能做"必须在**追加之前**问出来，否则一个视图拒绝过的变更会
// 留在日志里，而"重放必须一致"是承重性质。`check` 与 `applyDelta` 用的是同一段判断。
import type { Delta } from '../delta.ts'
import type { DirEntry, EntryMeta } from '../entries.ts'
import type { Log } from '../log/events.ts'
import type { AgentId, BlobId, CommitId, LogSeq, RelPath, ViewRev } from '../terms.ts'

/**
 * 上层那一条的内容对象。**id 由下层给**（`Lower.putBlob`），视图一处都不自己算。
 *
 * 由头是一处真读数（`tools/probe-hashfmt.sh` 的 sha256 那一行）：内容地址的算法是**仓库的性质**，
 * 不是视图的性质——同一串字节在 sha1 库与 sha256 库里是两个 id，而视图原先按 sha1 算了一份，
 * 于是 sha256 库上 `mktree` 当场拒（`fatal: input format error`）。条目自己带着真源给的 id，
 * "这个内容的对象叫什么"就只剩一处答法。
 */
export type Entry =
  | { kind: 'file'; bytes: Uint8Array; mode: number; blob: BlobId }
  | { kind: 'symlink'; target: string; blob: BlobId }
  | { kind: 'dir' }

export type UpperEntry = Entry | { kind: 'tombstone' }

/**
 * 视图需要的下层：一个提交处的三样读，加上按 id 取对象。
 *
 * **按 id 取对象不是路径读**：重放时事件里带的是 blob，内容必须能取回来。这一份里**只有一处不是
 * 读**——`putBlob`：它答的是"这串字节在对象库里叫什么"，而对象库是内容寻址的，写与不写都不改变
 * 任何对象的身份。视图因此仍然不是第二处真源：它决定不了内容地址，只是把它取回来。
 */
export interface Lower {
  /** 视图铺在哪个提交上。`null`：还没有提交，下层是空的。 */
  readonly base: CommitId | null
  readBlob(id: BlobId): Promise<Uint8Array>
  /**
   * 一串字节在对象库里的 id。**它是 `Entry.blob` 的取值处**（实现走 `Truth.putBlob`）。
   *
   * 为什么视图要问它，而不是自己算：算法是仓库的性质（sha1 / sha256 是两把尺）。记录里带着 id
   * 的那两处（`view/write` 事件 · 文件快照条目）直接用记录里那一份；记录里没有的（`view/symlink`
   * 事件 · 软链快照条目）只有这一条来源——一条 `target` 算不出对象地址来。
   */
  putBlob(bytes: Uint8Array): Promise<BlobId>
  stat(path: RelPath): Promise<EntryMeta | null>
  read(path: RelPath): Promise<Uint8Array | null>
  list(dir: RelPath): Promise<DirEntry[]>
}

/**
 * 上层状态里的一条，**能写成 JSON 的那一种**（§ 9.4 的 `path → (blob, mode)`）。
 *
 * 内容存 id 不存字节：blob 已经在对象库里，而写日志的顺序保证了它在（§ 9.3）。墓碑也在
 * 这张表里——"读到过 remove 而其后没有同名 write"，这条判断的结论必须跟着快照走，
 * 否则从快照起重放会把下层已经删掉的路径又放回来。
 */
export type SnapEntry =
  | { path: RelPath; kind: 'file'; blob: BlobId; mode: number }
  | { path: RelPath; kind: 'symlink'; target: string }
  | { path: RelPath; kind: 'tombstone' }

/**
 * 视图状态的**可持久形式**：这个 writer 的日志前缀折叠出来的上层。
 *
 * **它和日志一样相对 base**，所以 base 前移不影响它——这正是快照可以只按 `(writer, seq)`
 * 存放、而不用记下"当时铺在哪个提交上"的原因。
 */
export interface ViewState {
  rev: ViewRev
  /** 该 writer 到 `rev` 为止的全部修订点（不含 0）。`revs` 要能报出快照之前的那些。 */
  points: ViewRev[]
  upper: SnapEntry[]
}

/**
 * 一份**已经找到的**快照：定位是 M0 的（`seq` · 日志当时的字节数），状态是 M2 的。
 *
 * `logBytes` 是"这份快照不比日志新"的凭据。日志丢了尾（崩溃 · 截断）而快照留下时，从
 * 快照起重建会得到一份**日志里没有**的视图——那就宁可不用它，从 0 重放。快照是加速项，
 * 它没有资格比日志更权威。
 */
export interface ViewSnapshot {
  seq: LogSeq
  logBytes: number
  state: ViewState
}

export interface View {
  readonly id: AgentId
  readonly base: CommitId | null
  /** 已重放的最大 rev。 */
  readonly rev: ViewRev
  /** 全部可达修订点，升序。0 是 base 本身，所以 `diff(0)` 等于"全部"。 */
  readonly revs: ViewRev[]

  stat(path: RelPath): Promise<EntryMeta | null>
  read(path: RelPath): Promise<Uint8Array | null>
  list(dir: RelPath): Promise<DirEntry[]>

  write(path: RelPath, bytes: Uint8Array, mode?: number): Promise<ViewRev>
  writeSymlink(path: RelPath, target: string): Promise<ViewRev>
  remove(path: RelPath): Promise<ViewRev>
  rename(from: RelPath, to: RelPath): Promise<ViewRev>
  chmod(path: RelPath, mode: number): Promise<ViewRev>

  /** 自 `since` 以来的**变更序列**（不是净差异）。见 `view.ts` 顶部的第三条规则。 */
  diff(since?: ViewRev): Delta[]
  applyDelta(deltas: Delta[]): Promise<ViewRev>

  /** 这个变更做得成吗。**问答与执行共用一段判断**，所以答"做得成"就一定做得成。 */
  check(d: Delta): Promise<void>

  /**
   * 视图自己的历史里有没有这条路径（下层有没有不算）。
   *
   * 装配体问这一句只为一件事：只有下层才有的内容，重放时读不回来（base 会随提交前移），
   * 所以那种变更要先把内容钉进日志。见 `edit.ts`。
   */
  hasUpper(path: RelPath): boolean

  /**
   * 这次写在上层是新增还是改写。**只看上层**：下层会随 base 前移而变，同一条 `view/write`
   * 在活路径上可能是 `add`、重放时就成了 `modify`。装配体按它给日志里那次写定名。
   */
  kindOf(path: RelPath): 'add' | 'modify'

  /**
   * 上层状态的折叠（§ 9.4 的快照内容）。**不含下层**——与日志同一个参照系。
   *
   * 它与 `snapshotOf` 不是一份东西，别混：那个是"这棵树现在长什么样"（上层 + 下层，
   * 提交要的），这个是"这个 writer 的日志前缀折叠成了什么"（重放要的）。
   */
  state(): ViewState
}

export interface LoadViewOptions {
  lower: Lower
  /** 只重放到这个 rev 为止（§ 9.4 的 `upToRev`）。 */
  upToRev?: ViewRev
  /**
   * 从这份快照起，而不是从 seq=0（§ 9.4 的第一步）。
   *
   * **它换掉的是历史，不是状态**：从快照起的视图给不出更早的变更序列，所以
   * `diff(since < 快照的 rev)` 会抛错——要历史就全量重放。这也是一条结构性的限制，
   * 不是实现偷懒：状态里不含有过哪些变更。
   *
   * `upToRev` 比快照更早时，这份快照被忽略（宁可慢，不可错）。
   */
  snap?: ViewSnapshot
}
