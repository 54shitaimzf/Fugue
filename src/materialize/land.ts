// delta 落地：把视图的一条条变更落到物化树里。出处：架构 § 8.5 的六种情形 · 两条机制约束 ·
// "写回原内容的路径不碰盘" · 硬链接纪律。
//
// 四件事，各自的出处：
//
// 一 · **落地根不总是 `merged`。** `overlayfs` 档落在 `upper`：穿过 `merged` 写一个已在 lower
//      里的文件会触发 copy-up，本平台约 50 ms/文件，而直接写 `upper` 是 1.67 ms/文件（§ 8.5 的
//      第二条机制约束）。另两档没有 overlay，`merged` 就是那份树本身，只能落在它上面。
// 二 · **删除在 overlayfs 档是一条 whiteout**（字符设备 0:0），不是 unlink——unlink 到不了下层。
//      实测（内核 6.18 · WSL2 · ext4）：非特权 `mknod <p> c 0 0` 成功，而同一条路上的 `c 1 3`
//      与 `b 8 0` 都是 EPERM——内核对 0:0 留了豁免。whiteout 因此不要任何特权；老内核上没有这条
//      豁免时由 `capability.ts` 的 `whiteout` 那一档探出来。
// 三 · **写一律先落临时名再 rename。** 硬链接那一档里就地 `open(w)` 会截断共享的 inode，真源被
//      穿透（§ 8.5 硬链接纪律）；rename 顺带让每次落地是原子的。
// 四 · **"写回原内容"落成"落地根里不留这一条"。** 视图写回与底一模一样的内容（模型整份重写 ·
//      formatter 跑一遍没改动）时，底本来就给得出这一份——写进去只会让那条的 mtime 变，而按
//      修改时间判定新旧的工具链于是重新编译它（§ 8.5）。
//
// **落地是"让落地根与视图一致"，不是"照着 delta 敲一遍"。** delta 是序列（同一条路径可能先写
// 后删），磁盘只认终态；所以先把 delta 折成"这一批碰了哪些路径"，每条路径只问一句"视图要它是
// 什么、现在是什么"，不一样才动盘。**没动盘的报在 `untouched` 里**——"恰好 3 条"那把尺子量的
// 是盘，这一份是给人看的账。
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Delta } from '../delta.ts'
import type { EntryMeta } from '../entries.ts'
import type { AbsPath, RelPath } from '../terms.ts'
import { hashBytes } from './diffstat.ts'

export class LandError extends Error {
  readonly path: RelPath

  constructor(path: RelPath, why: string) {
    super(`${why}：${path}`)
    this.name = 'LandError'
    this.path = path
  }
}

/**
 * 视图那一侧的读口。**M4 不 import M2**（§ 8.3：三个模块只共享 `Delta`），所以由调用点注入
 * ——与 § 8.3 把 `lower` 注入 M2 是同一个手法，只是方向相反。`View` 结构上就满足它。
 */
export interface ViewReads {
  stat(path: RelPath): Promise<EntryMeta | null>
  read(path: RelPath): Promise<Uint8Array | null>
}

/**
 * 一条路径上"有什么"。比的是**内容与形状**：mtime · inode · 属主都不参与（§ 8.5 的差异集口径）。
 *
 * `bytes` 只是搭车：内容哈希本来就要把这份字节读出来（写回原样那条判断），落地时不再读第二遍。
 * 它不参与相等判断。
 */
export type EntryState =
  | { readonly kind: 'file'; readonly hash: string; readonly mode: number; readonly bytes?: Uint8Array }
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'dir' }
  | { readonly kind: 'other' }
  | { readonly kind: 'whiteout' }

export interface LandOptions {
  /** 落地根：`overlayfs` 档是 `upper`，另两档是 `merged`（§ 8.4 的四个坐标）。 */
  readonly target: AbsPath
  /** 底：真实工作树。"写回原样"那条判断比的就是它（§ 8.4）。 */
  readonly lower: AbsPath
  /** 删除怎么落：overlayfs 档造 whiteout，另两档直接删。 */
  readonly overlay: boolean
  /**
   * 造一条 whiteout。**只有 overlayfs 档要它**，而且它是注入的：`land.ts` 不认识挂载、也不认识
   * 平台事实——"这台机器上怎么造得出 whiteout"是 `capability.ts` 探出来的事实，由 `ensure` 接上。
   */
  readonly whiteout: ((abs: AbsPath) => void) | null
  readonly pruneEmptyDirs: boolean
  readonly view: ViewReads
}

export interface LandResult {
  /** 落地之后的清单：相对底变了的路径 → 内容哈希（`''` = 这儿没有了）。 */
  readonly manifest: Map<RelPath, string>
  /** 真正动过盘的路径。 */
  readonly landed: RelPath[]
  /** 视图要它变、而盘上已经是对的（含"写回原样"）——没动盘。 */
  readonly untouched: RelPath[]
  readonly whiteouts: number
  readonly pruned: number
}

const WHITEOUT: EntryState = { kind: 'whiteout' }

/** 清单里那一条哈希该记什么：文件是内容的 sha256，软链是**目标那串**的（§ 8.5 的差异集口径）。 */
export function hashOfState(st: EntryState | null): string {
  if (st === null) return ''
  if (st.kind === 'file') return st.hash
  if (st.kind === 'symlink') return hashBytes(st.target)
  return ''
}

/** 两条路径上的东西是不是同一份。**形状不同就是不同**（文件与软链不是一份东西）。 */
export function sameEntry(a: EntryState | null, b: EntryState | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'file' && b.kind === 'file') return a.hash === b.hash && a.mode === b.mode
  if (a.kind === 'symlink' && b.kind === 'symlink') return a.target === b.target
  return true
}

/** 盘上一条路径的现状。**只对 delta 碰过的路径问**——落地因此是 O(改动数)，不是 O(树)。 */
export function diskEntry(abs: AbsPath, rel: RelPath): EntryState | null {
  let st
  try {
    st = lstatSync(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new LandError(rel, `看不动这一条：${(err as Error).message}`)
  }
  if (st.isSymbolicLink()) return { kind: 'symlink', target: readlinkSync(abs) }
  if (st.isFile()) return { kind: 'file', hash: hashBytes(readFileSync(abs)), mode: st.mode & 0o7777 }
  if (st.isDirectory()) return { kind: 'dir' }
  // 字符设备 0:0 是 overlay 的 whiteout，它说的是"这儿没有"。
  if (st.isCharacterDevice() && st.rdev === 0) return WHITEOUT
  return { kind: 'other' }
}

/**
 * 一个读口（视图 · 或者底那一侧）里那一条。读不出内容就说出来，不猜。
 *
 * **同一个函数读两边**：`verify-mat` 要拿视图与 base 比，两边各是一个 `ViewReads`，比的口径
 * 只有一处——不然"相等"这个词会在两个地方各定义一遍。
 */
export async function portEntry(view: ViewReads, rel: RelPath): Promise<EntryState | null> {
  const meta = await view.stat(rel)
  if (meta === null) return null
  if (meta.kind === 'dir') return { kind: 'dir' }
  // gitlink 看得见 · 读不动 · 写不得（§ 8.3），落地这一层只当它是"别的东西"：它只会以删除出现。
  if (meta.kind === 'gitlink') return { kind: 'other' }
  const bytes = await view.read(rel)
  if (bytes === null) throw new LandError(rel, `视图说它是 ${meta.kind}，却读不出内容`)
  if (meta.kind === 'symlink') return { kind: 'symlink', target: Buffer.from(bytes).toString('utf8') }
  return { kind: 'file', hash: hashBytes(bytes), mode: meta.mode & 0o7777, bytes }
}

/** 这一批 delta 碰了哪些路径，按出现次序。**改名算两处**：来源那条要落成"这儿没有了"。 */
export function touchedBy(deltas: readonly Delta[]): RelPath[] {
  const seen = new Set<RelPath>()
  const out: RelPath[] = []
  for (const d of deltas) {
    for (const p of d.kind === 'rename' ? [d.from, d.to] : [d.path]) {
      if (seen.has(p)) continue
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

export async function landDeltas(
  o: LandOptions,
  before: ReadonlyMap<RelPath, string>,
  deltas: readonly Delta[],
): Promise<LandResult> {
  const manifest = new Map(before)
  const landed: RelPath[] = []
  const untouched: RelPath[] = []
  let whiteouts = 0
  let pruned = 0

  for (const rel of touchedBy(deltas)) {
    const want = await portEntry(o.view, rel)
    const under = diskEntry(join(o.lower, rel), rel)
    // 清单：相对底变了就记，变回来了就划掉。
    if (sameEntry(want, under)) manifest.delete(rel)
    else manifest.set(rel, hashOfState(want))
    // 落地根里"要有什么"。
    //   overlayfs 档：底给得出的就不在 `upper` 里留第二条（留了要付 mtime 的代价）；视图里没有
    //   而底里有的，要一条 whiteout；其余照写。
    //   另两档：落地根本来就没有下层，视图要什么就是什么。
    const desired: EntryState | null = !o.overlay
      ? want
      : want === null
        ? under === null
          ? null
          : WHITEOUT
        : sameEntry(want, under)
          ? null
          : want
    const now = diskEntry(join(o.target, rel), rel)
    if (sameEntry(now, desired)) {
      untouched.push(rel)
      continue
    }
    const did = applyEntry(o, rel, desired, now)
    landed.push(rel)
    whiteouts += did.whiteout ? 1 : 0
    if (desired === null || desired.kind === 'whiteout') {
      pruned += o.pruneEmptyDirs ? pruneUp(o, rel) : 0
    }
  }
  return { manifest, landed, untouched, whiteouts, pruned }
}

/**
 * 让落地根里那一条变成 `want`（`null` = 这儿不该有条目）。`now` 是它此刻的样子。
 *
 * **内容一样、只有模式不同时就地 `chmod`。** 重写一遍会把 mtime 与 inode 一起换掉，而
 * § 8.5 的承重性质量的是未变文件的这四样——`chmod +x` 不该让按修改时间判定新旧的工具链
 * 把那个文件重编一遍。落地的六种情形里，只有 `chmod` 会走到这一支。
 */
function applyEntry(o: LandOptions, rel: RelPath, want: EntryState | null, now: EntryState | null): {
  whiteout: boolean
} {
  const abs = join(o.target, rel)
  // **就地改模式要抢在"让开那一条"前面**：让开就是把文件删掉，删了就没得 chmod 了。
  if (want !== null && want.kind === 'file' && now !== null && now.kind === 'file' && now.hash === want.hash) {
    try {
      chmodSync(abs, want.mode)
    } catch (err) {
      throw new LandError(rel, `模式改不动：${(err as Error).message}`)
    }
    return { whiteout: false }
  }
  clearEntry(rel, abs)
  if (want === null) return { whiteout: false }
  try {
    // **whiteout 也要先有目录**：那条字符设备与普通文件住在同一套目录里。
    mkdirSync(dirname(abs), { recursive: true })
  } catch (err) {
    throw new LandError(rel, `落地根里的目录建不出来：${(err as Error).message}`)
  }
  if (want.kind === 'whiteout') {
    if (o.whiteout === null) throw new LandError(rel, '这一档没有造 whiteout 的门路')
    try {
      o.whiteout(abs)
    } catch (err) {
      throw new LandError(rel, `whiteout 造不出来（${(err as Error).message}）`)
    }
    return { whiteout: true }
  }
  if (want.kind === 'file') {
    const tmp = tmpName(abs)
    try {
      writeFileSync(tmp, want.bytes ?? new Uint8Array(0))
      chmodSync(tmp, want.mode)
      renameSync(tmp, abs)
    } catch (err) {
      throw new LandError(rel, `写不进去：${(err as Error).message}`)
    }
    return { whiteout: false }
  }
  if (want.kind === 'symlink') {
    const tmp = tmpName(abs)
    try {
      symlinkSync(want.target, tmp)
      renameSync(tmp, abs)
    } catch (err) {
      throw new LandError(rel, `软链建不出来：${(err as Error).message}`)
    }
    return { whiteout: false }
  }
  throw new LandError(rel, `视图里这一条落不了地：${want.kind}`)
}

/** 让开那一条。目录只让得开空的——非空说明底与真实工作树已经对不上了，那要报出来。 */
function clearEntry(rel: RelPath, abs: AbsPath): void {
  let st
  try {
    st = lstatSync(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new LandError(rel, `看不动这一条：${(err as Error).message}`)
  }
  if (!st.isDirectory()) {
    unlinkSync(abs)
    return
  }
  try {
    rmdirSync(abs)
  } catch (err) {
    throw new LandError(rel, `落地根里这个路径是一个非空目录：${(err as Error).message}`)
  }
}

/** 临时名与目标同目录，rename 因此是同一次系统调用里换名（也就顺带断了硬链接）。 */
function tmpName(abs: AbsPath): AbsPath {
  return join(dirname(abs), `.fugue-tmp-${process.pid}-${Date.now().toString(36)}`)
}

/**
 * 空目录清理（§ 8.5 六种情形里的"`delete`（含空目录清理）"）。
 *
 * **只清我们自己造出来的**：底里有的目录就停手。`upper` 里一个空的同名目录什么也挡不住（overlay
 * 把两边的目录合起来看），而 `merged` 那一档删掉它就是真把它删了。
 */
function pruneUp(o: LandOptions, rel: RelPath): number {
  let n = 0
  let dir = dirname(rel)
  while (dir !== '' && dir !== '.') {
    if (lstatSync(join(o.lower, dir), { throwIfNoEntry: false }) !== undefined) break
    try {
      rmdirSync(join(o.target, dir))
    } catch {
      break
    }
    n++
    dir = dirname(dir)
  }
  return n
}

