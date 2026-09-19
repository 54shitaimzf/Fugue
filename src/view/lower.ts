// M1 → M2 的适配：把 § 8.2 的三个按提交读的方法绑到一个提交上，交给视图当 lower 用。
//
// **它是接缝上的适配器，不是第二个 M1。** 视图那一侧只认 `Lower` 这个只读端口，所以
// M2 的代码里没有一处 import M1 的契约；换后端（内存假体 · 快照 · 将来的 Rust 侧）只需
// 要另写一个这样的小文件。`base` 为 null 时下层是空的——新仓库一个提交都没有。
import type { DirEntry, EntryMeta } from '../entries.ts'
import type { Truth } from '../truth/contract.ts'
import type { BlobId, CommitId, RelPath } from '../terms.ts'
import type { Lower } from './contract.ts'

export function lowerAt(truth: Truth, base: CommitId | null): Lower {
  return {
    base,
    readBlob: (id: BlobId) => truth.getBlob(id),
    stat: (path: RelPath): Promise<EntryMeta | null> =>
      base === null ? Promise.resolve(null) : truth.statAt(base, path),
    read: (path: RelPath): Promise<Uint8Array | null> =>
      base === null ? Promise.resolve(null) : truth.readAt(base, path),
    list: (dir: RelPath): Promise<DirEntry[]> =>
      base === null ? Promise.resolve([]) : truth.listAt(base, dir),
  }
}
