// M1 的契约。出处：架构 § 8.2——接口逐字照抄，不加不减。
//
// § 8.2 的签名里用了四个没有定义的类型名（`TreeEntry` · `EntryMeta` · `DirEntry` ·
// `Conflict`）。**条目那三个不在这里**：M2 读出去的也是同一组形状，所以它们住在
// `../entries.ts`，这一份只留 M1 自己的东西——冲突的形状与 `Truth`。
import type { BlobId, CommitId, RefName, RelPath, TreeId } from '../terms.ts'
import type { DirEntry, EntryMeta, TreeEntry } from '../entries.ts'

/**
 * `mergeTree` 冲突时的一行。出处：`git merge-tree --write-tree` 的 stdout 第二段，
 * 每个冲突路径给出 stage 1/2/3 各一个 `<mode> <object> <stage>\t<path>`。
 *
 * 按**路径**分组，而不是把三行平铺：M13 与 M6 拿到冲突后的下一个动作是"去解决这个
 * 文件"，按路径分组正是那个动作的单位。
 */
export interface ConflictStage {
  stage: 1 | 2 | 3
  mode: number
  id: BlobId
}

export interface Conflict {
  path: RelPath
  stages: ConflictStage[]
}

/** 架构 § 8.2 的 `Truth`，逐字。 */
export interface Truth {
  putBlob(bytes: Uint8Array): Promise<BlobId>
  putTree(entries: TreeEntry[]): Promise<TreeId>
  commit(tree: TreeId, parents: CommitId[], msg: string): Promise<CommitId>

  getBlob(id: BlobId): Promise<Uint8Array>
  statAt(commit: CommitId, path: RelPath): Promise<EntryMeta | null>
  readAt(commit: CommitId, path: RelPath): Promise<Uint8Array | null>
  listAt(commit: CommitId, dir: RelPath): Promise<DirEntry[]>

  advance(ref: RefName, to: CommitId, expectedOld: CommitId | null): Promise<void>
  resolve(ref: RefName): Promise<CommitId>
  mergeTree(bases: CommitId[]): Promise<{ tree: TreeId } | { conflicts: Conflict[] }>
}
