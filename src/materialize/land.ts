// delta 落地：把视图的一条条变更落到物化树里。出处：架构 § 8.5 的六种情形 · 两条机制约束 ·
// "写回原内容的路径不碰盘" · 硬链接纪律。
//
// 六件事，各自的出处：
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
//      **`chmod` 是这条纪律的另一半**（V7 补的）：就地 `chmodSync` 改的也是 inode，于是"视图里
//      改个模式"会穿透到真源。判据是"落地根里那一条与底里那一条是不是同一条 inode"（`sharesInode`）
//      ——是的话，内容一样也要重写一遍（临时名 + rename 顺带断链）。
// 四 · **"写回原内容"落成"落地根里不留这一条"。** 视图写回与底一模一样的内容（模型整份重写 ·
//      formatter 跑一遍没改动）时，底本来就给得出这一份——写进去只会让那条的 mtime 变，而按
//      修改时间判定新旧的工具链于是重新编译它（§ 8.5）。
// 五 · **目录不是条目**（V7 补的）。§ 8.5 的六种情形是按路径说的，一条 `delete` 对应一条
//      whiteout，所以清单里没有 `{kind:'dir'}` 这种东西（它没有内容哈希），落地根的枚举也只看
//      叶子。一条路径因此只有三种可能：一个叶子（文件 · 软链）· 一条 whiteout（这儿没有了）·
//      什么都不在清单里。**一条路径"不是目录"就意味着它下面的一切在视图里都不存在**——那些
//      后代条目跟着划掉（`dropDescendants`），不然清单会留着已经跟着祖先一起消失的路径。
// 六 · **两个"底"问的是两个不同的问题**（V7 分开的）：
//      `lower`（真实工作树）——"合并树里已经有了吗"。overlayfs 档的下层就是它，所以"要删除时
//        造一条 whiteout 还是什么都不用做"由它答；`pruneUp` 的停手线也用它。
//      `base`（`mat/fork.base` 那个提交）——"相对 base 变了吗"。清单的口径是 § 8.5 的"base 与
//        视图之间内容不同的路径"，问的是**提交**，不是工作树。两者混用会出一个假红：工作树被
//        人手改过（§ 8.4：这一步不做检测），视图写回 base 的原内容 → 按工作树算"变了"、按 base
//        算"没变"，于是清单里多一条、`verify-mat` 永久报不等。
//
// **落地是"让落地根与视图一致"，不是"照着 delta 敲一遍"。** delta 是序列（同一条路径可能先写
// 后删），磁盘只认终态；所以先把 delta 折成"这一批碰了哪些路径"，每条路径只问一句"视图要它是
// 什么、现在是什么"，不一样才动盘。**没动盘的报在 `untouched` 里**——"恰好 3 条"那把尺子量的
// 是盘，这一份是给人看的账。
//
// **目录这一维的四条**（V7；V3 的六种情形只走了文件级，这四条是拿探针问出来的）：
//
//   · **让开的是整棵子树。** 原来"目录只让得开空的，非空就报错"那条判断删掉了：落地根是我们
//     自己的东西（`upper` 是我们造的，`merged` 是 `fork` 铺的），一棵非空目录只说明这一批
//     delta 没有逐条点到它的孩子——而一条 `delete <dir>` 本来就是"这个路径没有了"，孩子由它
//     带着走。§ 8.5 的 `delete（含空目录清理）`里那半句"空目录清理"是 `pruneUp`（清掉我们
//     造出来的空目录），不是"只让得开空的"。
//   · **要一个目录就是 `mkdir`。** `want.kind === 'dir'`：overlayfs 档上层的一个真目录正好把
//     下层的同名文件整个遮住——不需要 whiteout，也不需要先把下层那个文件删掉（内核上实测过）。
//   · **祖先不是目录 = 这条路径不存在。** `lstat` 给 `ENOTDIR`，与 `ENOENT` 同义；只认 `ENOENT`
//     会让"文件换成目录"这种形状变化炸在预检上。
//   · **一条 whiteout 打不开**（`refuseReopen`）：视图在一条被 whiteout 遮住的路径下面又有东西
//     了（先删掉一个目录、之后又在同名路径下建东西）。一条 whiteout 遮住的是下层的一整棵目录，
//     而它不能既是文件又是目录；逐叶遮回去是另一种口径（清单与差异集都要跟着变成逐叶），人批的
//     是"拒绝并指路"（交付说明 V7）。**这一支在动手之前就拒绝**：半落一地的状态比拒绝难查得多。
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitModeOf } from '../delta.ts'
import type { Delta } from '../delta.ts'
import type { EntryMeta } from '../entries.ts'
import type { AbsPath, RelPath } from '../terms.ts'
import { hashBytes, hashFile } from './diffstat.ts'
import { removeTree } from './mount.ts'

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
  /**
   * 视图的上层里哪些路径是**墓碑**（删过，且没有活着的后代把它遮住）。只为一件事存在：
   * `refuseReopen` 要判"这条路径下面曾经删掉过一个目录"。没有这个口就不做那道检查——落地
   * 仍然对，只在"一条 whiteout 打不开"那一支上少一次明确的拒绝。生产路径（`ensure` 的接线）
   * 一律给得出它。
   */
  tombstones?(): readonly RelPath[]
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
  /** 底：真实工作树。见文件头第六条——它答的是"合并树里已经有了吗"。 */
  readonly lower: AbsPath
  /** base 提交那一份（`mat/fork.base`）。见文件头第六条——它答的是"相对 base 变了吗"。 */
  readonly base: ViewReads
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
  /** 落地之后的清单：相对 base 变了的路径 → 内容哈希（`''` = 这儿没有了）。 */
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

/**
 * 盘上一条路径的现状。**只对 delta 碰过的路径问**——落地因此是 O(改动数)，不是 O(树)。
 *
 * `ENOTDIR` 与 `ENOENT` 同义：路径的某一节不是目录，这条路径就不存在（文件换成目录、以及一条
 * whiteout 挡在中间时都会撞上它）。
 */
export function diskEntry(abs: AbsPath, rel: RelPath): EntryState | null {
  let st
  try {
    st = lstatSync(abs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new LandError(rel, `看不动这一条：${(err as Error).message}`)
  }
  if (st.isSymbolicLink()) return { kind: 'symlink', target: readlinkSync(abs) }
  // 模式按树上那一档记（`gitModeOf`）：与 `portEntry` 那一侧同一个口径，盘上的 umask 不算改动。
  if (st.isFile()) return { kind: 'file', hash: hashFile(abs), mode: gitModeOf(st.mode) & 0o7777 }
  if (st.isDirectory()) return { kind: 'dir' }
  // 字符设备 0:0 是 overlay 的 whiteout，它说的是"这儿没有"。
  if (st.isCharacterDevice() && st.rdev === 0) return WHITEOUT
  return { kind: 'other' }
}

/**
 * 一个读口（视图 · base 提交 · 或者底那一侧）里那一条。读不出内容就说出来，不猜。
 *
 * **同一个函数读每一侧**：`verify-mat` 要拿视图与 base 比，落地要拿视图与 base 比、还要拿底
 * 比，各侧是一个 `ViewReads`，比的口径只有一处——不然"相等"这个词会在几个地方各定义一遍。
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

/** `rel` 的各级祖先，从最上面那一级开始；不含 `rel` 自己，也不含根的空串。 */
function ancestorsOf(rel: RelPath): RelPath[] {
  const out: RelPath[] = []
  let i = rel.indexOf('/')
  while (i !== -1) {
    out.push(rel.slice(0, i))
    i = rel.indexOf('/', i + 1)
  }
  return out
}

/** 一条计划：这一批里每条被碰到的路径上，三个读数的合影。**这一段只读盘。** */
interface Planned {
  readonly rel: RelPath
  readonly want: EntryState | null
  readonly under: EntryState | null
  readonly base: EntryState | null
  readonly desired: EntryState | null
}

/**
 * 落地根里"要有什么"。
 *   overlayfs 档：底给得出的就不在 `upper` 里留第二条（留了要付 mtime 的代价）；视图里没有
 *   而底里有的，要一条 whiteout；其余照写。
 *   另两档：落地根本来就没有下层，视图要什么就是什么。
 */
function desiredOf(o: LandOptions, want: EntryState | null, under: EntryState | null): EntryState | null {
  if (!o.overlay) return want
  if (want === null) return under === null ? null : WHITEOUT
  return sameEntry(want, under) ? null : want
}

export async function landDeltas(
  o: LandOptions,
  before: ReadonlyMap<RelPath, string>,
  deltas: readonly Delta[],
): Promise<LandResult> {
  const manifest = new Map(before)
  const landed: RelPath[] = []
  const touchedDisk = new Set<RelPath>()
  /** 记一笔"这条路径动过盘"。**每条路径只记一次**：对账与主循环可能各碰它一回。 */
  const mark = (rel: RelPath): void => {
    if (touchedDisk.has(rel)) return
    touchedDisk.add(rel)
    landed.push(rel)
  }
  const untouched: RelPath[] = []
  let whiteouts = 0
  let pruned = 0

  // ── 一 · 先只读：每条路径上"视图要什么 · base 是什么 · 底是什么"。**一条都不动盘。**
  const plan: Planned[] = []
  for (const rel of touchedBy(deltas)) {
    const want = await portEntry(o.view, rel)
    const base = await portEntry(o.base, rel)
    const under = diskEntry(join(o.lower, rel), rel)
    plan.push({ rel, want, under, base, desired: desiredOf(o, want, under) })
  }
  // ── 二 · "重开"那一支：overlayfs 档动手之前拒绝；另两档把视图不要的条目直接删掉。
  const reopened = reopenedAncestors(o, plan)
  if (o.overlay) refuseReopen(o, plan, reopened)
  else for (const a of reopened) await reconcileToView(o, a, mark)

  // ── 三 · 落。
  for (const p of plan) {
    const { rel, want, desired } = p
    // 清单：相对 base 变了就记，变回来了就划掉；**目录不是条目**，而一条路径"不是目录"就
    // 意味着它下面的一切在视图里都不存在——那些后代条目跟着划掉。
    if (want !== null && want.kind === 'dir') manifest.delete(rel)
    else if (sameEntry(want, p.base)) manifest.delete(rel)
    else manifest.set(rel, hashOfState(want))
    if (want === null || (want !== null && want.kind !== 'dir')) dropDescendants(manifest, rel)
    // **祖先又变成目录了**：清单里那一条（"这儿没有了"）跟着划掉——目录不是条目，而这一批的
    // delta 未必点到它自己（上一批删掉的是个**文件**，这一批在同一路径下建了目录）。
    for (const anc of ancestorsOf(rel)) {
      if (!manifest.has(anc)) continue
      const at = await portEntry(o.view, anc)
      if (at !== null && at.kind === 'dir') manifest.delete(anc)
    }

    const now = diskEntry(join(o.target, rel), rel)
    if (sameEntry(now, desired)) {
      untouched.push(rel)
      continue
    }
    const did = applyEntry(o, rel, desired, now)
    mark(rel)
    whiteouts += did.whiteout ? 1 : 0
    if (desired === null || desired.kind === 'whiteout') {
      pruned += o.pruneEmptyDirs ? pruneUp(o, rel) : 0
    }
  }
  return { manifest, landed, untouched, whiteouts, pruned }
}

/**
 * "重开"：视图在一条**墓碑**祖先下面又有东西了（先删掉一个目录、之后又在同名路径下建东西）。
 * 返回那些祖先。判据只有一条：**视图上层在那条路径上有一条墓碑**——它是"这一支下面曾经整个
 * 被删掉过"的凭据，而这个状态重放得出来（视图的上层一直在）。
 */
function reopenedAncestors(o: LandOptions, plan: readonly Planned[]): RelPath[] {
  if (!plan.some((p) => p.want !== null)) return []
  const dead = o.view.tombstones?.() ?? []
  if (dead.length === 0) return []
  const tombstones = new Set<RelPath>(dead)
  const out: RelPath[] = []
  const seen = new Set<RelPath>()
  for (const p of plan) {
    if (p.want === null) continue
    for (const a of ancestorsOf(p.rel)) {
      if (!tombstones.has(a) || seen.has(a)) continue
      seen.add(a)
      out.push(a)
    }
  }
  return out
}

/**
 * `overlayfs` 档上"重开"落不了地：一条 whiteout 遮住的是下层的一整棵目录，而它打不开——要在
 * 它下面建东西就得有一个真目录，真目录一建，下层那些没被删掉的孩子就漏回来了。逐叶遮回去是
 * 另一种口径（清单与差异集都要跟着变成逐叶），人批的是"拒绝并指路"（交付说明 V7）。
 *
 * 拒绝发生在**任何一条路径动盘之前**。出路是换一档重铺：`copy` / `hardlink-ro` 的落地根就是我
 * 们自己那棵树，没有下层会漏回来（`pruneToView` 那一支）。
 */
function refuseReopen(o: LandOptions, plan: readonly Planned[], reopened: readonly RelPath[]): void {
  for (const p of plan) {
    if (p.want === null) continue
    for (const a of ancestorsOf(p.rel)) {
      if (!reopened.includes(a)) continue
      const low = lstatSync(join(o.lower, a), { throwIfNoEntry: false })
      if (low === undefined || low === null || !low.isDirectory()) continue
      throw new LandError(
        p.rel,
        `它的祖先 ${a} 在视图里被删过（一条墓碑），而底里 ${a} 还是一个有内容的目录\n` +
          `一条 whiteout 遮住的是下层的一整棵目录，而它打不开：要在 ${a} 下面建东西就得有一个真目录，` +
          `真目录一建，下层那些没被删掉的孩子就漏回来了（逐叶遮回去是另一种口径，还没批）。\n` +
          `出路是换一档重铺一棵：fugue fork <base> --strategy copy —— 那一档的落地根就是我们自己\n` +
          `那棵树，没有下层会漏回来（物化是派生的，§ 8.5 的失败处理就是删除重建）。`,
      )
    }
  }
}

/**
 * 另两档上"重开"是落得了地的：落地根本来就是我们自己那棵树（`fork` 铺的一份拷贝），视图不要的
 * 条目直接删掉就是——没有下层，也就没有"漏回来"这件事。
 *
 * 三条规矩，与主循环同一口径（视图要什么、盘上现在就有什么）：
 *   · 视图说这条路径现在是一个**目录**（否则这一支不管它，主循环按形状落）；
 *   · 盘上那儿不是目录 → 整条让开（是我们自己铺的那一份，不是真源）；
 *   · 是目录 → 一条条对：视图里没有的删掉，视图里是目录的往下走，其余留着。
 *
 * 代价是 O(被重开的那棵子树)，只在"删过一个目录、之后又在同名路径下建东西"时才走。删掉的路径
 * 报进 `landed`（那是账：真正动过盘的有哪些）。
 */
async function reconcileToView(o: LandOptions, at: RelPath, mark: (rel: RelPath) => void): Promise<void> {
  const want = await portEntry(o.view, at)
  if (want === null || want.kind !== 'dir') return
  const abs = join(o.target, at)
  const st = lstatSync(abs, { throwIfNoEntry: false })
  if (st === undefined || st === null) return
  if (!st.isDirectory()) {
    removeTree(abs)
    mark(at)
    return
  }
  for (const name of readdirSync(abs)) {
    const child: RelPath = `${at}/${name}`
    const w = await portEntry(o.view, child)
    if (w === null) {
      removeTree(join(o.target, child))
      mark(child)
      continue
    }
    if (w.kind === 'dir') await reconcileToView(o, child, mark)
  }
}

/** 把清单里 `rel` 下面的条目全部划掉（那条路径在视图里已经不是目录了）。 */
function dropDescendants(manifest: Map<RelPath, string>, rel: RelPath): void {
  const prefix = rel + '/'
  for (const p of [...manifest.keys()]) {
    if (p.startsWith(prefix)) manifest.delete(p)
  }
}

/**
 * 让落地根里那一条变成 `want`（`null` = 这儿不该有条目）。`now` 是它此刻的样子。
 *
 * **内容一样、只有模式不同时就地 `chmod`。** 重写一遍会把 mtime 与 inode 一起换掉，而
 * § 8.5 的承重性质量的是未变文件的这四样——`chmod +x` 不该让按修改时间判定新旧的工具链
 * 把那个文件重编一遍。落地的六种情形里，只有 `chmod` 会走到这一支。
 *
 * **唯一走不得这一支的情形是那条 inode 与底共享**（硬链接那一档）：就地 `chmod` 改的是真源。
 * 那时内容一样也重写一遍——临时名 + rename 顺带断链。
 */
function applyEntry(o: LandOptions, rel: RelPath, want: EntryState | null, now: EntryState | null): {
  whiteout: boolean
} {
  const abs = join(o.target, rel)
  const sameContent = want !== null && want.kind === 'file' && now !== null && now.kind === 'file' && now.hash === want.hash
  // **就地改模式要抢在"让开那一条"前面**：让开就是把文件删掉，删了就没得 chmod 了。
  if (sameContent && !sharesInode(o, rel, abs)) {
    try {
      chmodSync(abs, want.mode)
    } catch (err) {
      throw new LandError(rel, `模式改不动：${(err as Error).message}`)
    }
    return { whiteout: false }
  }
  // 断链重写要用的字节：先读出来，让开那一条就没得读了。
  let keep: Uint8Array | null = null
  if (sameContent) {
    try {
      keep = want.bytes ?? readFileSync(abs)
    } catch (err) {
      throw new LandError(rel, `读不动这一条：${(err as Error).message}`)
    }
  }
  clearEntry(rel, abs)
  if (want === null) return { whiteout: false }
  // **"这里要有一个目录"就是 mkdir**（文件头第五条）。上层的真目录把下层的同名文件遮住。
  if (want.kind === 'dir') {
    ensureParents(o, rel)
    try {
      mkdirSync(abs)
    } catch (err) {
      throw new LandError(rel, `落地根里这个目录建不出来：${(err as Error).message}`)
    }
    return { whiteout: false }
  }
  // **whiteout 也要先有目录**：那条字符设备与普通文件住在同一套目录里。
  ensureParents(o, rel)
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
      writeFileSync(tmp, keep ?? want.bytes ?? new Uint8Array(0))
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

/**
 * 把 `rel` 的各级父目录在落地根里备好。**遇到一条 whiteout 就先让开它。**
 *
 * 那条 whiteout 是"这一条路径以前被删过"留下的（视图上层同一条路径上有一条墓碑）。它挡在中间
 * 时，底下那件事做不成：`mkdirSync` 会在它上面吃 `EEXIST`。让开它是安全的——**下层的同名条目是
 * 文件时**，上层的一个真目录把那个文件整个遮住，什么都没有漏回来；**是目录时**，下层的孩子会
 * 从新目录里漏回来，而那一支在 `refuseReopen` 里已经拒掉了（它看的就是"墓碑 + 底里是目录"）。
 */
function ensureParents(o: LandOptions, rel: RelPath): void {
  for (const anc of ancestorsOf(rel)) {
    const a = join(o.target, anc)
    let st
    try {
      st = lstatSync(a, { throwIfNoEntry: false })
    } catch (err) {
      throw new LandError(rel, `落地根里的 ${anc} 看不动：${(err as Error).message}`)
    }
    if (st === undefined || st === null) {
      mkdirSync(a)
      continue
    }
    if (st.isDirectory()) continue
    if (st.isCharacterDevice() && st.rdev === 0) {
      unlinkSync(a)
      mkdirSync(a)
      continue
    }
    throw new LandError(rel, `落地根里的 ${anc} 不是目录（那儿有一条别的条目）`)
  }
}

/**
 * 落地根里那一条与底里那一条是不是同一条 inode。**硬链接那一档里会是**（`hardlink-ro`，以及
 * `--ro` 声明过的子树，§ 8.5 的硬链接纪律），而就地 `chmod` 改的正是 inode。
 */
function sharesInode(o: LandOptions, rel: RelPath, abs: AbsPath): boolean {
  const low = lstatSync(join(o.lower, rel), { throwIfNoEntry: false })
  if (low === undefined || low === null) return false
  const now = lstatSync(abs, { throwIfNoEntry: false })
  if (now === undefined || now === null) return false
  return now.ino === low.ino && now.dev === low.dev
}

/**
 * 让开那一条。**目录让开的是整棵子树**（文件头第五条）：落地根是我们的东西，一棵非空目录只
 * 说明这一批 delta 没有逐条点到它的孩子——而一条 `delete <dir>` 就是"这个路径没有了"。
 */
function clearEntry(rel: RelPath, abs: AbsPath): void {
  try {
    lstatSync(abs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw new LandError(rel, `看不动这一条：${(err as Error).message}`)
  }
  try {
    // 住在 `mount.ts`（那里先有了它）：先 `rmdir` 再 `readdir` 的删除器，`dispose` 与 `fork`
    // 用的是同一个——递归删除器只该有一份。它不认识挂载。
    removeTree(abs)
  } catch (err) {
    throw new LandError(rel, `让不开这一条：${(err as Error).message}`)
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
    let inLower = true
    try {
      inLower = lstatSync(join(o.lower, dir), { throwIfNoEntry: false }) !== undefined
    } catch {
      // 看不动（ENOTDIR 之类）就当底里有——停手是把安全的那一侧。
    }
    if (inLower) break
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
