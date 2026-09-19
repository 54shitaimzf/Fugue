// 视图的全量读出，摊成 § 8.2 的 `putTree` 输入。
//
// **它就是 § 9.4 的快照**（`path → (blob, mode)`）：提交要一份，重放的加速项要一份，
// 两者是同一份投影。写到 `snap/<agent>/` 上是第四单元的事，本单元先给出这份投影本身。
//
// **一个字节的内容都不用读**：下层文件的 id 来自 `list` 的行，上层文件的 id 由视图自己
// 算（内容就在手里），gitlink 的 id 就是那个提交。于是"把整棵树读出来"这件事与仓库的
// 字节数无关，只与路径数有关。
import type { TreeEntry } from '../entries.ts'
import type { View } from './contract.ts'

export async function snapshotOf(view: View): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const row of await view.list(dir)) {
      const path = dir === '' ? row.name : `${dir}/${row.name}`
      if (row.kind === 'dir') {
        await walk(path)
        continue
      }
      out.push({ name: path, mode: row.mode, id: row.id })
    }
  }
  await walk('')
  return out
}
