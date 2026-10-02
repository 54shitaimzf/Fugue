// M1 → M2 的适配：把 § 8.2 的三个按提交读的方法绑到一个提交上，交给视图当 lower 用。
//
// **它是接缝上的适配器，不是第二个 M1。** 视图那一侧只认 `Lower` 这个只读端口，所以
// M2 的代码里没有一处 import M1 的契约；换后端（内存假体 · 快照 · 将来的 Rust 侧）只需
// 要另写一个这样的小文件。`base` 为 null 时下层是空的——新仓库一个提交都没有。
import type { DirEntry, EntryMeta } from '../entries.ts'
import { refFor } from '../identity.ts'
import { RefNotFoundError } from '../truth/truth.ts'
import type { Truth } from '../truth/contract.ts'
import type { BlobId, CommitId, RelPath, WriterId } from '../terms.ts'
import type { Lower } from './contract.ts'

export function lowerAt(truth: Truth, base: CommitId | null): Lower {
  return {
    base,
    readBlob: (id: BlobId) => truth.getBlob(id),
    // **id 的算法住真源那一侧**：视图不再自己拼 `blob <n>\0` 那一段，改问 git（内容寻址、幂等）。
    putBlob: (bytes: Uint8Array) => truth.putBlob(bytes),
    stat: (path: RelPath): Promise<EntryMeta | null> =>
      base === null ? Promise.resolve(null) : truth.statAt(base, path),
    read: (path: RelPath): Promise<Uint8Array | null> =>
      base === null ? Promise.resolve(null) : truth.readAt(base, path),
    list: (dir: RelPath): Promise<DirEntry[]> =>
      base === null ? Promise.resolve([]) : truth.listAt(base, dir),
  }
}

/**
 * 一个 writer 的视图铺在哪个提交上：它自己的 ref 现在指着的那个（§ 4 的 ref 方案）。
 * **不存在就是 `null`**——新仓库还没有提交，那是正常状态，不是错误。
 *
 * 与 `lowerAt` 同一个理由住在这里：CLI 的两条命令与崩溃实验的写者都要这一句，抄三份
 * 就是三处会漂移的地方。
 */
export async function baseFor(truth: Truth, writer: WriterId): Promise<CommitId | null> {
  try {
    return await truth.resolve(refFor(writer))
  } catch (err) {
    if (err instanceof RefNotFoundError) return null
    throw err
  }
}

/** `baseFor` + `lowerAt`：从"这是哪个 writer"一步到"它的下层"。 */
export async function lowerFor(truth: Truth, writer: WriterId): Promise<Lower> {
  return lowerAt(truth, await baseFor(truth, writer))
}
