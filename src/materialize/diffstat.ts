// 物化那一组的尺子：全树 `(mtime, size, hash)` 快照，与两次快照之间的差异。
// 出处：架构 § 9.6 的物化行 · § 9.8 的 `fugue diff-stat` · § 8.5 的第一条验证性质
// （"改 3 个文件后，全树快照必须恰好 3 条变化"）。
//
// **它是一把尺子，不是物化的一部分。** 物化负责让树对；这把尺子负责让人看得出树变没变。
// 所以它**只读**：不动物化树、不动挂载态（§ 8.5 把 `diff-stat` 与 `verify-mat` 并列写成只读），
// 也不认识视图与日志——它只认一棵物理树的一条绝对路径。
//
// 五条口径，都写死在这里：
//
//   一 · **只记叶子**（文件 · 软链 · 别的）。目录没有内容，而它的 mtime 会因为增删条目的
//        自己变——记上它，一次改名报 4 条而不是 2 条，噪声盖过信号。
//   二 · **快照里不带时间**。静置的树两次快照要**逐字节相同**（这是 V1 的第一条断言），
//        带一个墙上时间就永远做不到。要问"什么时候"，那是每个叶子自己的 mtime。
//   三 · **按路径排序**，路径用 `/` 分段。于是同一棵树在任何时候扫出来的字节都一样。
//   四 · **mode 记整模式**（`0o100755` 那个数）。§ 8.5 的差异集把 mode 与内容哈希并列着比，
//        物化树里的权限也是它要重现的东西之一——所以不在这里抹掉它。
//   五 · **不跟软链**。`readdir` 给软链的 dirent 不报目录，于是它自然落进叶子里；跟过去就
//        会走出这棵树（软链可以指向任何地方），也会把同一个文件数两遍。
//
// `mtimeNs` 是**十进制串**：今天的时间戳约 1.7e18 ns，而 double 在 2^53 ≈ 9.0e15 之上就
// 开始丢整数（换算成时间约 256 ns 一档）。用串就没有这个问题，JSON 里也还是它本身。
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AbsPath, RelPath } from '../terms.ts'

/** 叶子有三类：文件 · 软链 · 别的（fifo · socket · 设备）。别的这一类**不读内容**——读它会挂住。 */
export type LeafKind = 'file' | 'symlink' | 'other'

export interface Leaf {
  readonly path: RelPath
  readonly kind: LeafKind
  /** 整模式，`0o100755` 那种。 */
  readonly mode: number
  /** 文件是字节数；软链是目标的长度；别的恒为 0（它没有内容的字节可数）。 */
  readonly size: number
  /** 纳秒时间戳的十进制串——见文件头第四条。 */
  readonly mtimeNs: string
  /** 文件是内容的 sha256；软链是**目标那串字符**的 sha256；别的是空串。 */
  readonly hash: string
}

export interface TreeStat {
  readonly root: AbsPath
  readonly leaves: readonly Leaf[]
}

export class TreeStatError extends Error {}

/**
 * 工作区自己的状态（§ 9.1 的那张表 · § 9.2 的布局）：对象库 · 日志 · 快照 · 配置 · 物化的根。
 *
 * **尺子不看它们。** 它们是工作区的本子，不是被物化的内容；不跳，`diff-stat` 会把
 * `log/*.jsonl` 自己长大、`mat/<agent>/upper` 里刚落下的 delta 都报成"树变了"，于是
 * "恰好 3 条变化"那句永远不成立。**默认不跳**：取舍留给调用方（这一份只提供这个名字）。
 */
export const WORKSPACE_STATE: readonly RelPath[] = ['.git', '.fugue']

export interface ScanOptions {
  /** 跳过哪些路径（相对 root 的目录按前缀，文件按全名）。默认一个都不跳。 */
  readonly skip?: readonly RelPath[]
}

const CHUNK = 1 << 20

/**
 * 一份字节的 sha256。**差异集与物化清单共用这一个口径**（§ 8.5）：文件比的是内容，软链比的是
 * 它指向的那串字符（`leafOf` 那一处）。落地那一侧（`land.ts`）算的也是它——两把尺子要对得上，
 * 口径就只能写一遍。
 */
export function hashBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 分块算哈希：整份读进内存在大文件上会白占一整个文件的内存。
 *
 * **导出是给 `land.ts` 的**：那边问"盘上这条是什么"时只要一个内容哈希，要的正是这一份实现
 * ——文件的内容哈希在整个物化组里只该有一条路（口径一处，代价也一处）。
 */
/**
 * **看一条路径在不在：`ENOTDIR` 与 `ENOENT` 同义。**
 *
 * `lstat` 一条路径，取不回来给 `null`。两件事各是一个坑：
 *
 *   · **`{ throwIfNoEntry: false }` 不够。** 它只吞 `ENOENT`——父亲**不存在**时给 `undefined`，
 *     而父亲**不是目录**时照抛 `ENOTDIR`（Node v24.21.0 本地实测：`legacy` 是一个普通文件时
 *     `lstat('<root>/legacy/old-format.js', { throwIfNoEntry: false })` 抛 `ENOTDIR`）。
 *   · **"祖先不是目录"就是"这条路径不存在"**（`land.ts` 开头那条口径）：文件换成目录、以及一条
 *     whiteout（字符设备 0:0）挡在中间时都会撞上它。
 *
 * 真档那一趟（样本盘第 1 案 · `agent/r1/4`）：同格 `bash rm` 删掉 `legacy/old-format.js` 之后
 * `upper/legacy` 是那次 `rm` 留下的白障，**下一趟回收**去 `lstat` 那条叶子路径（`topLevel()`
 * 给的是路径本身，不是它那一段）→ `ENOTDIR` 穿出工具面（`tool-threw`），那一格就此收场
 * （`agent/stop` 的 `stopped` 里就是那句话），判据③ 因此停在 3/4。同一个工作区里 `land.ts` 的
 * `diskEntry` 已经认这条口径，少的是两处**回收读口**。
 */
export function statOrNull(abs: AbsPath): Stats | null {
  try {
    return lstatSync(abs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
}

export function hashFile(abs: AbsPath): string {
  const h = createHash('sha256')
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

function leafOf(root: AbsPath, rel: RelPath): Leaf {
  const abs = join(root, rel)
  // 一次 `lstat`，bigint：`mtimeNs` 只有 bigint 给得全（`Stat` 那一面是毫秒浮点）。
  // `lstat` 而不是 `stat`：软链记的是**它自己**（目标是它的内容），不跟过去。
  const st = lstatSync(abs, { bigint: true })
  const kind: LeafKind = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other'
  // **`readlink` 而不是 `readFile`。** 软链的内容就是它指向的那一串，不是那份被指向的字节：
  // `readFileSync` 会跟过去读，于是两条指向不同、内容相同的链看起来一样，而悬空的那条直接把
  // 整棵树扫崩。§ 8.5 的差异集口径写的是"符号链接比目标"（PLAN § 5.2 的 V1.2 行）。
  const target = kind === 'symlink' ? readlinkSync(abs) : ''
  const hash =
    kind === 'file'
      ? hashFile(abs)
      : kind === 'symlink'
        ? hashBytes(target)
        : ''
  return {
    path: rel,
    kind,
    mode: Number(st.mode),
    size: Number(st.size),
    mtimeNs: String(st.mtimeNs),
    hash,
  }
}

/** 扫一棵树。叶子按路径排序——同一棵树扫几次都是同一串字节。 */
export function scanTree(root: AbsPath, opts: ScanOptions = {}): TreeStat {
  const skip = opts.skip ?? []
  const skipped = (rel: RelPath): boolean =>
    skip.some((s) => rel === s || rel.startsWith(s + '/'))
  const leaves: Leaf[] = []
  const walk = (rel: RelPath): void => {
    const abs = rel === '' ? root : join(root, rel)
    const entries = readdirSync(abs, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (skipped(child)) continue
      if (e.isDirectory()) walk(child)
      else leaves.push(leafOf(root, child))
    }
  }
  walk('')
  leaves.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { root, leaves }
}

export type ChangeStatus = 'added' | 'removed' | 'changed'

/** 变了哪几列。`touch` 只给 `mtime`；改内容给 `size` · `content` · `mtime`。 */
export type ChangeColumn = 'kind' | 'mode' | 'size' | 'mtime' | 'content'

export interface Change {
  readonly path: RelPath
  readonly status: ChangeStatus
  readonly columns: readonly ChangeColumn[]
}

function columnsOf(before: Leaf, after: Leaf): ChangeColumn[] {
  const cols: ChangeColumn[] = []
  if (before.kind !== after.kind) cols.push('kind')
  if (before.mode !== after.mode) cols.push('mode')
  if (before.size !== after.size) cols.push('size')
  if (before.hash !== after.hash) cols.push('content')
  if (before.mtimeNs !== after.mtimeNs) cols.push('mtime')
  return cols
}

/** 两份快照的差异，按路径排序。**只列叶子**——两边都是同一个口径扫出来的。 */
export function diffStat(before: TreeStat, after: TreeStat): Change[] {
  const out: Change[] = []
  const a = before.leaves
  const b = after.leaves
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].path < b[j].path)) {
      out.push({ path: a[i].path, status: 'removed', columns: [] })
      i++
      continue
    }
    if (i >= a.length || b[j].path < a[i].path) {
      out.push({ path: b[j].path, status: 'added', columns: [] })
      j++
      continue
    }
    const cols = columnsOf(a[i], b[j])
    if (cols.length > 0) out.push({ path: a[i].path, status: 'changed', columns: cols })
    i++
    j++
  }
  return out
}

/**
 * 存一份基线。**先写临时名再改名**（读者看到的要么是旧份要么是新份）——与配置那条写路径
 * 同一个道理：一份写了一半的基线会被下一次 `--baseline` 读成"树变了 3000 条"。
 */
export function storeTreeStat(file: AbsPath, stat: TreeStat): void {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 换行收尾：与仓库里其它 JSON 落盘一致，也让 diff 好看
    writeFileSync(tmp, JSON.stringify(stat, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw new TreeStatError(`基线写不进去：${file} —— ${(err as Error).message}`)
  }
}

/** 读一份基线。**读不动或解析不了就拒绝**，不当成"什么都没变"（与配置同一条纪律）。 */
export function loadTreeStat(file: AbsPath): TreeStat {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new TreeStatError(`基线读不出来：${file} —— ${(err as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new TreeStatError(`基线不是一份完整的 JSON：${file} —— ${(err as Error).message}`)
  }
  const s = raw as TreeStat
  if (typeof s !== 'object' || s === null || !Array.isArray(s.leaves)) {
    throw new TreeStatError(`基线里没有 leaves：${file}`)
  }
  return s
}
