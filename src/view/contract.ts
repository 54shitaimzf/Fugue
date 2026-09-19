// M2 的契约。出处：架构 § 8.3——类型逐字照抄，四处补全是"把 § 8.3 写全"所必需的：
//
// 1. `loadView` 的第三个参数收一个 `lower`。§ 8.3 的正文明说 `lower` 按需从 M1 懒加载，
//    而它的签名里没有一条到 M1 的路。给的是一个**只读端口**（`Lower`）：视图拿不到写路径。
// 2. `base` 可以是 `null`——新仓库一个提交都没有，视图的上层就是全部。为了有个 base 去
//    造一个空提交，是把读变成写。
// 3. 五个变更方法与 `applyDelta` 是异步的。视图有一半是懒的：改一个只在 base 里有的路径
//    要先把它读上来（改名 · 改权限），同步签名只能靠漏掉这一半来维持。
// 4. `stat` / `list` 给出的 `id`：上层建出来的目录没有对象，给空树占位（`entries.ts`）；
//    判据是 `kind`，要内容走 `list`。
//
// 另有一步不属于 § 8.3 的读法但必须存在：`check`。日志行一旦落下就是历史，重放会照它
// 执行——所以"这个变更能不能做"必须在**追加之前**问出来，否则一个视图拒绝过的变更会
// 留在日志里，而"重放必须一致"是承重性质。`check` 与 `applyDelta` 用的是同一段判断。
import type { Delta } from '../delta.ts'
import type { DirEntry, EntryMeta } from '../entries.ts'
import type { Log } from '../log/events.ts'
import type { AgentId, BlobId, CommitId, RelPath, ViewRev } from '../terms.ts'

export type Entry =
  | { kind: 'file'; bytes: Uint8Array; mode: number }
  | { kind: 'symlink'; target: string }
  | { kind: 'dir' }

export type UpperEntry = Entry | { kind: 'tombstone' }

/**
 * 视图需要的下层：一个提交处的三样读，加上按 id 取对象。
 *
 * **按 id 取对象不是路径读**：重放时事件里带的是 blob，内容必须能取回来。**全部是读**——
 * M2 从头到尾没有一处写路径，所以它不可能成为第二个真源。
 */
export interface Lower {
  /** 视图铺在哪个提交上。`null`：还没有提交，下层是空的。 */
  readonly base: CommitId | null
  readBlob(id: BlobId): Promise<Uint8Array>
  stat(path: RelPath): Promise<EntryMeta | null>
  read(path: RelPath): Promise<Uint8Array | null>
  list(dir: RelPath): Promise<DirEntry[]>
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
}

export interface LoadViewOptions {
  lower: Lower
  /** 只重放到这个 rev 为止（§ 9.4 的 `upToRev`）。 */
  upToRev?: ViewRev
}
