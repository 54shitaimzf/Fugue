// 视图的两个投影，**不是一份东西**：
//
//   `snapshotOf(view)`  = 上层 + 下层的全量读出 → § 8.2 的 `putTree` 输入（提交要的）
//   `View.state()`      = 只折上层（含墓碑）      → § 9.4 的快照（重放要的）
//
// 判据是"base 前移时它还能不能用"：前者含下层，提交一前移就过期；后者与日志同一个参照系，
// 所以快照可以只按 `(writer, seq)` 存放，不必记下"当时铺在哪个提交上"。
//
// 存放：`<realRoot>/.fugue/snap/<writer>/<seq>.json`（§ 9.2）。**快照从不阻塞写入，也从不
// 阻塞读出**（§ 9.4）：写不成就当没写，读不动就当没有。它没有任何独有数据——凡是只在快照
// 里的东西，都不该存在。所以这里的三条失守一律降级为"从 0 全量重放"：
//
//   1. 文件读不出来 · JSON 解析不了 · 形状不对
//   2. 信封里的 seq 与文件名不符（与 M0 对日志行做的是同一件事）
//   3. **它比日志新**：写快照时日志有 N 字节，现在不足 N 字节——日志丢了尾（崩溃 · 截断），
//      这时快照会给出日志里没有的视图。快照没有资格比日志更权威。
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertWriterId, logFileOf } from '../log/log.ts'
import type { TreeEntry } from '../entries.ts'
import type { LogSeq, ViewRev, WriterId } from '../terms.ts'
import type { SnapEntry, View, ViewSnapshot, ViewState } from './contract.ts'

export function snapDir(root: string, w: WriterId): string {
  assertWriterId(w)
  return join(root, '.fugue', 'snap', w)
}

/** 视图内相对路径的形状检查。与 `view.ts` 的 `pathOf` 同一套规矩，这里只判真假。 */
function okPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.startsWith('/') || p.includes('\\')) return false
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false
  }
  return true
}

function int(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function parseEntry(raw: unknown): SnapEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (!okPath(e.path)) return null
  if (e.kind === 'tombstone') return { path: e.path, kind: 'tombstone' }
  if (e.kind === 'symlink') {
    return typeof e.target === 'string' ? { path: e.path, kind: 'symlink', target: e.target } : null
  }
  if (e.kind === 'file') {
    if (typeof e.blob !== 'string' || typeof e.mode !== 'number') return null
    return { path: e.path, kind: 'file', blob: e.blob, mode: e.mode }
  }
  return null
}

/** 形状与信封都对，才是一份能用的快照。`seq` 从文件名来，两边互相校对。 */
export function parseSnapshot(text: string, seq: LogSeq): ViewSnapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.seq !== seq || !int(o.logBytes)) return null
  const st = o.state
  if (typeof st !== 'object' || st === null) return null
  const s = st as Record<string, unknown>
  if (!int(s.rev) || !Array.isArray(s.points) || !s.points.every(int)) return null
  if (!Array.isArray(s.upper)) return null
  const upper: SnapEntry[] = []
  for (const raw of s.upper) {
    const e = parseEntry(raw)
    if (e === null) return null
    upper.push(e)
  }
  return { seq, logBytes: o.logBytes, state: { rev: s.rev, points: s.points, upper } }
}

async function logBytesOf(root: string, w: WriterId): Promise<number> {
  try {
    return (await stat(logFileOf(root, w))).size
  } catch {
    return 0
  }
}

/**
 * 找一份能用的快照：`≤ upToRev` 里 rev 最大的那一份（§ 9.4 的第一步）。
 *
 * 逐份读、逐份校。快照的份数由提交点决定，是几十的量级；为它建索引是拿一处要维护的
 * 一致性换一点读目录的时间，不值。
 */
export async function readSnapshot(
  root: string,
  writer: WriterId,
  opts: { upToRev?: ViewRev } = {},
): Promise<ViewSnapshot | null> {
  const dir = snapDir(root, writer)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const size = await logBytesOf(root, writer)
  // **从新到旧找，第一份能用的就是要的那一份。** 同一个 writer 的 rev 随 seq 单调不减
  // （提交不改视图内容，只把当刻的 rev 再记一次），所以 § 9.4 的"≤ upToRev 里最大的一份"
  // 就是倒着找到的第一份。顺序反过来也照样对，但那样每敲一条命令都要把历史上每一份快照
  // 都读一遍，而份数是随提交数长的。
  for (const name of names.sort().reverse()) {
    const m = /^([0-9]+)[.]json$/.exec(name)
    if (m === null) continue
    let text: string
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    const snap = parseSnapshot(text, Number(m[1]))
    if (snap === null) continue
    if (snap.logBytes > size) continue
    if (opts.upToRev !== undefined && snap.state.rev > opts.upToRev) continue
    return snap
  }
  return null
}

/**
 * 原子地写一份快照（先写临时名再改名，所以读者看到的要么是旧份要么是新份）。
 *
 * **返回有没有写成，但调用者不必管**：写不成就是这次没加速。§ 9.4 的原话是快照从不阻塞
 * 写入——它没有任何独有数据，所以"写失败要报错"在这里没有正确的接收方。
 */
export async function writeSnapshot(
  root: string,
  writer: WriterId,
  snap: ViewSnapshot,
): Promise<boolean> {
  const dir = snapDir(root, writer)
  const tmp = join(dir, `${snap.seq}.json.tmp-${process.pid}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tmp, JSON.stringify(snap) + '\n')
    await rename(tmp, join(dir, `${snap.seq}.json`))
    return true
  } catch {
    return false
  }
}

/** 把一个视图此刻的状态存成 seq 处的快照。提交点调它（§ 9.5 把提交点与检查点列在同一档）。 */
export async function saveSnapshot(
  root: string,
  writer: WriterId,
  view: View,
  seq: LogSeq,
): Promise<boolean> {
  const logBytes = await logBytesOf(root, writer)
  return await writeSnapshot(root, writer, { seq, logBytes, state: view.state() })
}

/**
 * 视图的全量读出，摊成 § 8.2 的 `putTree` 输入（提交要的那一份，见本文件顶部）。
 *
 * **一个字节的内容都不用读**：下层的 id 来自 `list` 的行，上层那条目自己带着真源给的 id
 * （`Entry.blob`），gitlink 的 id 就是那个提交。于是"把整棵树读出来"这件事与仓库的
 * 字节数无关，只与路径数有关。
 */
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
