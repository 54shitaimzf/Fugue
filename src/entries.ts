// 条目：路径上有什么。**M1 读回来的与 M2 读出去的，是同一组形状。**
//
// 出处：架构 § 8.2 与 § 8.3 的签名里用了 `TreeEntry` · `EntryMeta` · `DirEntry` 三个
// 名字，全文没有给它们形状。留在任一侧的契约文件里，另一侧就得反向 import 一个模块的
// 契约——放在这里，它是 import 图上的事实，不是一句约定。
import type { BlobId, CommitId, RelPath, TreeId } from './terms.ts'

/**
 * 条目的四类。`file` · `symlink` · `dir` 是树里的三种日常模式，`gitlink`（`160000`）是
 * 第四种：它指的是**另一个仓库里的一个提交**，submodule 的入口。
 *
 * **第四类不是替将来留的位置，是今天就会撞上的情形**——`<root>/.git` 就是项目自己的
 * 仓库，项目带 submodule，它的树里就有 `160000`。给它一个说得出自己是什么的取值：报成
 * 0 字节的文件是在说谎，后面每一层（物化 · 合并）都会拿着错的形状干活；认不出来就整棵
 * 树失败，则把"一个 submodule"放大成"这个仓库不可读"。
 */
export type EntryKind = 'file' | 'symlink' | 'dir' | 'gitlink'

/** 条目的对象标识。**三样都可能**：文件是 blob、目录是 tree、gitlink 是提交。 */
export type ObjectId = BlobId | TreeId | CommitId

/**
 * `putTree` 的输入。`name` 是**视图内的相对路径**，可以含 `/`——嵌套由 `putTree` 建。
 *
 * 这个选择不是自由发挥：`git mktree` 明确拒绝带斜杠的名字（实测
 * `fatal: path sub/c.txt contains slash`），而读路径收的是嵌套路径。摊平的名字 + 一个
 * `putTree` 把它们折成树，是两侧都成立的形状。
 */
export interface TreeEntry {
  name: RelPath
  mode: number
  id: ObjectId
}

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

/** 列目录的一行：`EntryMeta` 加上它在**所在目录里**的名字（不含前缀路径）。 */
export interface DirEntry extends EntryMeta {
  name: string
}

/**
 * git 的空树。**两个用处，都不是"随便找个值填上"**：
 *
 * - `putTree([])` 的定值——空目录在 git 里没有条目，只有空树。
 * - **视图里只有一个入口的目录**（上层写过 `d/x` 而 `d` 自己没人写过）没有自己的对象，
 *   而 `EntryMeta.id` 要一个值。空树是"这个目录的对象是空的"，判据是 `kind`，
 *   要内容走 `list`——这不是谎，是它唯一的真话：那个目录在上层确实不作为对象存在。
 */
export const EMPTY_TREE_ID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' as TreeId
