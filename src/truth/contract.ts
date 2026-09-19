// M1 的契约与它的值域。出处：架构 § 8.2——接口逐字照抄，不加不减。
//
// **§ 8.2 的签名里用了四个没有定义的类型名**（`TreeEntry` · `EntryMeta` · `DirEntry` ·
// `Conflict`），全文找不到它们。这里给出**把 § 8.2 写全所必需的最小形状**：每个字段都
// 对应签名里必须传进、或必须回得来的一个事实，没有一个字段是为将来预留的。
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
  id: ObjectId
}

/**
 * 条目的四类。前三类出自架构 § 8.3 的 `Entry`（file · symlink · dir）。
 *
 * **`gitlink` 是第四类，架构 § 8.2 / § 8.3 没有给它位置**（mode `160000`，submodule）。
 * 给它一个自己的 kind，而不是报成 0 字节的文件，也不是让整棵树读不了：报成文件是在说谎，
 * 后面每一层（物化 · 合并）都会拿着错的形状干活；整棵树失败则把"一个 submodule"放大成
 * "这个仓库不可读"。两害相权，取一个说得出自己是什么的值。
 */
export type EntryKind = 'file' | 'symlink' | 'dir' | 'gitlink'

/** 条目的对象标识。**三样都可能**：文件是 blob、目录是 tree、gitlink 是提交。 */
export type ObjectId = BlobId | TreeId | CommitId

export interface EntryMeta {
  kind: EntryKind
  mode: number
  /**
   * 字节数。**dir 与 gitlink 恒为 0**——它们没有字节可数，这个 0 是形状要求的占位，
   * 不是读数（`git ls-tree -l` 对这两类同样给 `-`）。
   */
  size: number
  id: ObjectId
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
