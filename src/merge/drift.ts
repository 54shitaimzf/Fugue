// M13 的漂移检测：**钉住之后只拦会被覆盖的那些**。出处：架构 § 8.14 的 C7（**已按这一站的口径
// 改写**：HEAD 指到别处照旧拒；工作树脏则只在"会被覆盖的那些"上拒）· § 23 U12（这一条把它关掉）·
// § 8.4（检测落在物化之前，`fork` 时不判）· PLAN § 5.7 的 A7 与 A10 两行与口径二。
//
// **判据是三方比出来的：底 · 盘上 · 目标树。**（A10 换过来的那一处。）
//
//   一 · `盘上 == 目标树`  → 放行。推进之后就是它，谁的字节都没丢。**用户手里那份恰好就是合并
//        算出来的结果**时就落在这里（手改是"预演"了一遍这次合并）。
//   二 · `盘上 == 底`      → 放行。用户没碰过这一条，推进是在写新内容（这是合并的正常样子：
//        工作树是干净的，而合并本来就该改它）。**少了这一条，任何一次"改文件"的合并都会被拒**
//        ——那是把"钉住"读成了"冻结"，等于要求用户先把合并结果写出来才准合并。
//   三 · 三个两两都不同    → **拒**。盘上那份既不是底、也不是这次合并的结果：它就是会被覆盖掉
//        的那一份，拒的话里报出是哪几条。
//
// A9 的走查量到三处落空的路（退出码 0、手改被静默退回底那一版），换到这三方比法上各自现出来：
//
//   · 轮次**之前**就存在的手改 → 盘上既不是底（用户改过）也不是目标树（合并算的是另一份）→ 拒。
//     A10 之前判据比的是"盘上 vs 盘上"：那份基线取的是**轮次开始那一刻的工作树**，于是这种改动
//     在基线与现在两处一模一样，差额是空的——看不见。
//   · 一条**只被删**的路径（目标树里没有、而盘上有）→ 推进会把它从盘上拿掉。删除单独成一条
//     判据（见 `colliding` 那一段）：**目标树里没有、盘上有**的，一律拒——不管它是这一趟新写上去
//     的、还是底里本来就有的（`advance` 删的就是这些）。A10 之前"会被覆盖"只算了写，于是这一条
//     一处都不"写"、两个集合没得相交，手改被静默退回底那一版。
//   · "合并要写"是从各条分支的提交反推的（`writeSurfaceOf`）。底已经带着合并结果时它算出空集，
//     于是"要写"那一栏空着，两个集合没得相交。现在判据的另一边是**目标树本身**，不是反推。
//
// **这一份不新造检测机制。** 它读的都是既有的代码路径：
//
//   `scanTree` / `hashBytes`（`materialize/diffstat.ts`）—— 盘上现在是什么（**跳 `WORKSPACE_STATE`**）
//   `WORKSPACE_STATE`                                  —— 工作区自己的本子（`.git` · `.fugue`）不参与
//   `M1` 的 `listAt` / `getBlob` / `resolve`            —— 底与目标树 · HEAD 动没动
//
// **判据是核对，不是检测**（口径二那句话）：比的是"这一条路径上盘上是什么、树上是什么"，与 D6 的
// 写入集相交同一把尺子——一个在虚拟空间、一个在真实工作树。逐条路径比，没有一处前缀相交。
//
// **为什么只在物化之前判、`fork` 时不判**：`fork` 时也判的话，用户手里有半途的活就开不了一轮——
// 那是**跑不起来**，不是变慢（PLAN § 5.7 的口径二与架构 § 3 那把地板尺子）。
import { createHash } from 'node:crypto'
import type { BlobId, CommitId, RefName, RelPath } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import { WORKSPACE_STATE, hashBytes, scanTree } from '../materialize/diffstat.ts'

/** 这一层自己的失败：读不出 HEAD · 读不出工作树 · 读不出底或目标树。 */
export class DriftError extends Error {}

/**
 * 一棵树摊平之后逐条路径的 `(mode, sha256)`。**底与目标树两处用同一个形状**——两边要比"这一条
 * 路径上是什么内容"，口径只能有一个。
 *
 * 内容哈希用 `hashBytes`（物化那一组那把尺子，§ 8.5）：与 `scanTree` 记的 `Leaf.hash` 同一个
 * 口径，所以"盘上这一条"与"树上这一条"直接可比。**不用 git 的对象标识**：那是 blob 的 id
 * （带 header 的 sha1），与盘上任何东西都比不了。
 */
export interface TreeLeaves {
  readonly leaves: ReadonlyMap<RelPath, { readonly mode: number; readonly hash: string }>
}

/** 每个 `Truth` 一份 blob 哈希缓存。**按对象标识缓存**：同一份内容在树里出现几次就只读一次。 */
const hashCacheOf = new WeakMap<Truth, Map<BlobId, string>>()

async function hashOfBlob(truth: Truth, id: BlobId): Promise<string> {
  let cache = hashCacheOf.get(truth)
  if (cache === undefined) {
    cache = new Map()
    hashCacheOf.set(truth, cache)
  }
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const bytes = (await truth.getBlob(id)) as Uint8Array
  const h = hashBytes(bytes)
  cache.set(id, h)
  return h
}

/**
 * 一棵树摊平成"路径 → (mode, sha256)"。软链那一条比的是**它指向的那串字符**——`getBlob` 给的就是
 * 那串字符的字节（`readlink` 的语义），与 `scanTree` 对软链记的哈希同一件事。
 *
 * **惰性**：只有需要比的那几条路径才去读 blob（`want`）。一条都不给就是全树——
 * 判据那一处按需取，大树上不必整棵读一遍。
 */
export async function leavesOf(truth: Truth, commit: CommitId, want?: ReadonlySet<RelPath>): Promise<TreeLeaves> {
  const leaves = new Map<RelPath, { mode: number; hash: string }>()
  const walk = async (dir: RelPath): Promise<void> => {
    for (const e of await truth.listAt(commit, dir)) {
      const p = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.kind === 'dir') {
        await walk(p)
        continue
      }
      if (want !== undefined && !want.has(p)) continue
      leaves.set(p, { mode: e.mode, hash: await hashOfBlob(truth, e.id as BlobId) })
    }
  }
  await walk('')
  return { leaves }
}

/** 三条读数。**三者各自独立**：哪一条不成立，拒绝的话里都要指得出来。 */
export interface Drift {
  /** HEAD 现在指着谁。 */
  readonly head: CommitId
  /** HEAD 与钉住的 base 相不相同。**不一样就拒**（"不静默继续"那一条不放开）。 */
  readonly headMoved: boolean
  /**
   * 这次合并**动到**的那些路径（目标树相对底不同：写 · 改 · 删）。**它不是判据**，
   * 是给人和走查看的读数——判据是下面那两个集合。
   */
  readonly touched: readonly RelPath[]
  /** 盘上与**目标树**不同的那些路径（推进之后会变的就是它们）。**判据的两边之一。** */
  readonly divergent: readonly RelPath[]
  /** 盘上与**底**不同的那些路径。**判据的另一边**（"用户碰过这一条没有"）。 */
  readonly handTouched: readonly RelPath[]
  /**
   * **该拒的那些**：盘上那一份既不是底、也不是目标树（两两都不同），外加"目标树里没有、而盘上
   * 有"的那些（推进会把它删掉）。**空 = 放行。**
   */
  readonly colliding: readonly RelPath[]
}

export interface DriftDeps {
  readonly truth: Truth
  readonly realRoot: string
  /**
   * 轮次开始时钉住的底（`round/start.ts` 钉底那一步的那个值）。
   * **`null` 表示"这个轮次没有底"**——那时三方比法缺一边，按 fail-closed 拒。
   */
  readonly base: CommitId | null
  /**
   * **目标树**：这一轮折完之后要推进到工作树上的那个提交（`fold` 的产出）。
   * **不给就判不了**——判据的一边不在（fail-closed，见 `mergeDrift`）。
   */
  readonly target?: CommitId
  /** 钉住的 base 在哪条 ref 上（缺省主线 `refs/heads/main`）。 */
  readonly ref?: RefName
}

/**
 * 三条读数一起取。**它只读**：不写盘、不改 ref、不落日志。
 *
 * 三方各取一次盘上/树上的样子，逐条路径比。**先取盘上那一份**：判据只需要盘上真有的那几条
 * ——底与目标树里其余路径不必读出来（大树上这是"只读会撞车的那些"，不是整棵树）。
 */
export async function driftOf(deps: DriftDeps): Promise<Drift> {
  const ref = deps.ref ?? 'refs/heads/main'
  let head: CommitId
  try {
    head = await deps.truth.resolve(ref)
  } catch (err) {
    throw new DriftError(`读不出 ${ref}：${(err as Error).message}——物化前那一步读不出 HEAD 就拒（fail-closed）`)
  }
  const headMoved = deps.base === null || head !== deps.base

  let touched: RelPath[] = []
  const divergent: RelPath[] = []
  const handTouched: RelPath[] = []
  const colliding: RelPath[] = []
  if (deps.target !== undefined && deps.base !== null) {
    // 盘上那一份（**跳 `WORKSPACE_STATE`**：工作区自己的本子不是"用户改了什么"）。
    const disk = scanTree(deps.realRoot, { skip: WORKSPACE_STATE })
    const onDisk = new Map(disk.leaves.map((l) => [l.path, l]))

    // 再看树上那两份：**三方比法逐条路径比的就是盘上真有的那些**（目标树里多出来的盘上没有，
    // 推进时只是新写上去，没有谁的字节可丢），所以只把那几条的内容取出来。`touched` 是另一条
    // 读数（这次合并动到哪些路径），它要整棵树比，单独走一遍、不取内容。
    const want = new Set<RelPath>(onDisk.keys())
    const target = await leavesOf(deps.truth, deps.target, want)
    const base = await leavesOf(deps.truth, deps.base, want)
    touched = await touchedPaths(deps.truth, deps.base, deps.target)

    for (const [p, l] of onDisk) {
      const t = target.leaves.get(p)
      const b = base.leaves.get(p)
      const same = (x: { readonly mode: number; readonly hash: string } | undefined): boolean =>
        x !== undefined && x.hash === l.hash && x.mode === Number(l.mode)
      if (t === undefined) {
        // 盘上有、目标树里没有 → 推进会把它从盘上拿掉，而盘上这一份是手写上去的（底里有没有它
        // 都一样：`advance` 删的是"目标树里没有的那些"）。**判据不管它是不是这一趟新写的**。
        divergent.push(p)
        colliding.push(p)
        continue
      }
      if (same(t)) continue // 与目标树一样：推进之后就是它（用户那份是这次合并的"预演"）
      divergent.push(p)
      if (same(b)) continue // 与底一样：用户没碰过，推进是在写新内容——合并的正常样子
      handTouched.push(p)
      colliding.push(p) // 三个两两都不同：盘上这一份会被覆盖掉
    }
  }

  touched = [...touched].sort()
  divergent.sort()
  handTouched.sort()
  colliding.sort()
  return { head, headMoved, touched, divergent, handTouched, colliding }
}

/**
 * 这次合并**动到**哪些路径：目标树相对底不同的那些（写 · 改 · 删）。**只比条目，不取内容**
 * ——两边的 `id` 不同就是内容不同，够用了；它是读数，不是判据。
 */
async function touchedPaths(truth: Truth, base: CommitId, target: CommitId): Promise<RelPath[]> {
  const at = async (commit: CommitId): Promise<Map<RelPath, { mode: number; id: string }>> => {
    const out = new Map<RelPath, { mode: number; id: string }>()
    const walk = async (dir: RelPath): Promise<void> => {
      for (const e of await truth.listAt(commit, dir)) {
        const p = dir === '' ? e.name : `${dir}/${e.name}`
        if (e.kind === 'dir') await walk(p)
        else out.set(p, { mode: e.mode, id: e.id })
      }
    }
    await walk('')
    return out
  }
  const b = await at(base)
  const t = await at(target)
  const out: RelPath[] = []
  for (const [p, e] of t) {
    const was = b.get(p)
    if (was === undefined || was.id !== e.id || was.mode !== e.mode) out.push(p)
  }
  for (const p of b.keys()) if (!t.has(p)) out.push(p)
  return out.sort()
}

/** 一次漂移检的判决。**拒的话里要指得出是哪几条路径**（口径二：「话里报出是哪几条」）。 */
export interface DriftVerdict {
  readonly ok: boolean
  readonly drift: Drift
  readonly say: string
}

/**
 * 物化之前那一档的判决。**盘上那一份既不是底、也不是目标树 → 拒**；其余照常。
 *
 * 两条拒法各自说得出话：
 *   · HEAD 动了（或这个轮次没有底）→ 拒，不静默继续。**这一条不放开**。
 *   · 会被覆盖掉的那几条（三方两两都不同 · 推进会删掉的那些）→ 拒，并列出那几条。
 *
 * **放行的那两档各是一个真实情形**：盘上等于目标树（用户那份恰好就是合并结果）· 盘上等于底
 * （用户没碰过，合并本来就该写它）。所以这一档不是"脏了就拒"，也不是"钉住 = 冻结"。
 */
export async function mergeDrift(deps: DriftDeps): Promise<DriftVerdict> {
  const drift = await driftOf(deps)
  if (deps.target === undefined || deps.base === null) {
    return {
      ok: false,
      drift,
      say:
        '漂移判不了：这一跑没有目标树（`fold` 折出来的那个提交）或没有钉住的底。\n' +
        '  fail-closed：判不了就拒——判据的一边不在，"盘上会不会被覆盖"就说不出来。',
    }
  }
  if (drift.headMoved) {
    const why =
      deps.base === null
        ? '这个轮次没有钉住底（base 是空的）'
        : `${deps.ref ?? 'refs/heads/main'} 现在指着 ${drift.head}，而这一轮钉住的是 ${deps.base}`
    return {
      ok: false,
      drift,
      say: `物化前拒：${why}\n  轮次中有人提交了东西——不静默继续（架构 § 8.14 的 C7）。`,
    }
  }
  if (drift.colliding.length > 0) {
    const hand = new Set(drift.handTouched)
    const rewritten = drift.colliding.filter((p) => hand.has(p))
    const removed = drift.colliding.filter((p) => !hand.has(p))
    return {
      ok: false,
      drift,
      say:
        `物化前拒：有 ${drift.colliding.length} 条路径上，盘上那一份既不是底、也不是这次合并算出来的：\n  ` +
        drift.colliding.join('\n  ') +
        `\n  其中 ${rewritten.length} 条会被这次合并改写${rewritten.length === 0 ? '' : `（${rewritten.join(' · ')}）`}，` +
        `${removed.length} 条推进时会被删掉（目标树里没有它：${removed.join(' · ') || '（一条都没有）'}）。` +
        '\n  推进之后盘上会与目标树不同——那几条上手里的改会被覆盖掉。要保住就先提交或挪走它们，再来合并。',
    }
  }
  return {
    ok: true,
    drift,
    say:
      drift.divergent.length === 0
        ? `漂移检通过：盘上与目标树没有一处不同（这次合并动到 ${drift.touched.length} 条路径），HEAD 没动。`
        : `漂移检通过：这次合并动到 ${drift.touched.length} 条路径，盘上与目标树不同的 ${drift.divergent.length} 条` +
          `都在底里也是这一份（用户没碰过），推进照写。`,
  }
}
