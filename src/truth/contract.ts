// M1 的契约与它的值域。出处：架构 § 8.2——接口逐字照抄，不加不减。
//
// **§ 8.2 的签名里用了四个没有定义的类型名**（`TreeEntry` · `EntryMeta` · `DirEntry` ·
// `Conflict`），全文找不到它们。这里给出**把 § 8.2 写全所必需的最小形状**：每个字段都
// 对应签名里必须传进、或必须回得来的一个事实，没有一个字段是为将来预留的。
//
// 这一处是本单元唯一的接口冻结点（PLAN § 4.1）：形状定错了，M2 与 M13 都要跟着改。
import type { BlobId, CommitId, RefName, RelPath, TreeId } from '../terms.ts'

/**
 * `putTree` 的输入。`name` 是**视图内的相对路径**，可以含 `/`——嵌套由 `putTree` 建。
 *
 * 这个选择不是自由发挥：`git mktree` 明确拒绝带斜杠的名字（实测
 * `fatal: path sub/c.txt contains slash`），而 `readAt` / `listAt` 收的是嵌套路径。
 * 摊平的名字 + 一个 `putTree` 把它们折成树，是两侧都成立的形状。
 */
export interface TreeEntry {
  name: RelPath
  mode: number
  id: BlobId | TreeId
}

/** 条目的三类。出处：架构 § 8.3 的 `Entry`。 */
export type EntryKind = 'file' | 'symlink' | 'dir'

export interface EntryMeta {
  kind: EntryKind
  mode: number
  /** 字节数。**目录恒为 0**——目录没有字节，这个 0 是形状要求的占位，不是读数。 */
  size: number
  id: BlobId | TreeId
}

/** `listAt` 的一行：`EntryMeta` 加上它在**所在目录里**的名字（不含前缀路径）。 */
export interface DirEntry extends EntryMeta {
  name: string
}

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
