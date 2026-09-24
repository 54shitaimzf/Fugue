// M13 的漂移检测：**钉住之后只拦会被覆盖的那些**。出处：架构 § 8.14 的 C7（**已按这一站的口径
// 改写**：HEAD 指到别处照旧拒；工作树脏则只在"脏路径 ∩ 这次合并要写的路径"相交时拒）·
// § 23 U12（这一条把它关掉）· § 8.4（检测落在合并之前，`fork` 时不判）· PLAN § 5.7 的 A7 行
// 与口径二。
//
// **这一份不新造检测机制。** 它读的三样都是既有的代码路径：
//
//   `scanTree` / `diffStat`（`materialize/diffstat.ts`）—— 脏路径集
//   `WORKSPACE_STATE`                                 —— 工作区自己的本子（`.git` · `.fugue`）不参与
//   `M1` 的 ref 读（`Truth.resolve`）                   —— HEAD 动没动
//
// **判据是核对，不是检测**（口径二那句话）："脏路径 ∩ 合并要写的路径"与 D6 的写入集相交是
// 同一把尺子——一个在虚拟空间、一个在真实工作树。所以这里的相交判据只有一处实现，
// 就是 `intersect` 用的那个 `covers`（A2 的 `precheck.ts`）——**不抄第二份**。
//
// **为什么只在合并前判、`fork` 时不判**：`fork` 时也判的话，用户手里有半途的活就开不了一轮——
// 那是**跑不起来**，不是变慢（PLAN § 5.7 的口径二与架构 § 3 那把地板尺子）。
import type { CommitId, RefName, RelPath } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import { WORKSPACE_STATE, diffStat, scanTree } from '../materialize/diffstat.ts'
import { covers } from '../contract/precheck.ts'

/** 这一层自己的失败：读不出 HEAD · 读不出工作树。 */
export class DriftError extends Error {}

/**
 * 一把基线：**轮次开始时那棵真实工作树的样子**（`scanTree` 的那一份）。
 *
 * 它由调用方在钉住 base 那一刻取一次（`round/start.ts` 钉底那一步顺手），一路带到这里。
 * **它是一份派生值，不持久化**：丢了就退回"只判 HEAD 动没动"那一档（那是 fail-open 的一侧，
 * 所以调用点要把它当承重的东西带着，而不是"有就读一读"）。
 */
export type DriftBaseline = ReturnType<typeof scanTree>

/** 取一次基线。**跳 `WORKSPACE_STATE`**：工作区自己的本子不是"用户改了什么"。 */
export function baselineOf(realRoot: string): DriftBaseline {
  return scanTree(realRoot, { skip: WORKSPACE_STATE })
}

/** 三条读数。**三者各自独立**：哪一条不成立，拒绝的话里都要指得出来。 */
export interface Drift {
  /** HEAD 现在指着谁。 */
  readonly head: CommitId
  /** HEAD 与钉住的 base 相不相同。**不一样就拒**（"不静默继续"那一条不放开）。 */
  readonly headMoved: boolean
  /** 脏路径集（相对基线；按路径排序）。 */
  readonly dirty: readonly RelPath[]
  /** 脏路径里**会被这次合并覆盖**的那些。空 = 放行。 */
  readonly colliding: readonly RelPath[]
  /** 这次合并要写的路径集（`fold` 折出来的那一份的写入面）。 */
  readonly mergePaths: readonly RelPath[]
}

export interface DriftDeps {
  readonly truth: Truth
  readonly realRoot: string
  /**
   * 轮次开始时钉住的底（`round/start.ts` 钉底那一步的那个值）。
   * **`null` 表示"这个轮次没有底"**——那时 HEAD 动没动判不了，按 fail-closed 拒。
   */
  readonly base: CommitId | null
  /** 轮次开始时取的那份基线。不给就只有 HEAD 那一条读数（见 `baselineOf` 那一句）。 */
  readonly baseline?: DriftBaseline
  /** 钉住的 base 在哪条 ref 上（缺省主线 `refs/heads/main`）。 */
  readonly ref?: RefName
  /** 这次合并要写的路径集——**判据的另一半**。"会被覆盖的"就是与它相交的那些。 */
  readonly mergePaths: readonly RelPath[]
}

/**
 * 三条读数一起取。**它只读**：不写盘、不改 ref、不落日志。
 *
 * 脏路径集用 `diffStat(基线, 现在)` 算——与"恰好 3 条变化"那条验证性质同一把尺子，
 * 所以"用户改了一条文件"这件事在两处读出来的是同一个东西。
 */
export async function driftOf(deps: DriftDeps): Promise<Drift> {
  const ref = deps.ref ?? 'refs/heads/main'
  let head: CommitId
  try {
    head = await deps.truth.resolve(ref)
  } catch (err) {
    throw new DriftError(`读不出 ${ref}：${(err as Error).message}——合并前那一步读不出 HEAD 就拒（fail-closed）`)
  }
  const headMoved = deps.base === null || head !== deps.base

  let dirty: RelPath[] = []
  if (deps.baseline !== undefined) {
    const now = scanTree(deps.realRoot, { skip: WORKSPACE_STATE })
    dirty = diffStat(deps.baseline, now).map((c) => c.path)
  }

  const mergePaths = [...deps.mergePaths]
  const colliding = dirty.filter((p) => mergePaths.some((m) => covers(m, p) || covers(p, m)))

  return { head, headMoved, dirty, colliding, mergePaths }
}

/** 一次漂移检的判决。**拒的话里要指得出是哪几条路径**（口径二：「话里报出是哪几条」）。 */
export interface DriftVerdict {
  readonly ok: boolean
  readonly drift: Drift
  readonly say: string
}

/**
 * 合并前那一档的判决。**相交即拒**；不相交照常。
 *
 * 两条拒法各自说得出话：
 *   · HEAD 动了（或这个轮次没有底）→ 拒，不静默继续。**这一条不放开**。
 *   · 会被这次合并覆盖的路径上有手改 → 拒，并列出那几条。
 *
 * 不在这次合并写入面里的手改**照常放行**——这是与架构 § 8.14 那句字面判法的偏离（口径二）。
 */
export async function mergeDrift(deps: DriftDeps): Promise<DriftVerdict> {
  const drift = await driftOf(deps)
  if (deps.baseline === undefined) {
    return {
      ok: false,
      drift,
      say:
        '漂移判不了：这一跑没有轮次开始时那份基线（真实工作树的全树快照）。\n' +
        '  fail-closed：判不了就拒。开轮次那一步取一次基线，一路带到这里。',
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
      say: `合并前拒：${why}\n  轮次中有人提交了东西——不静默继续（架构 § 8.14 的 C7）。`,
    }
  }
  if (drift.colliding.length > 0) {
    return {
      ok: false,
      drift,
      say:
        `合并前拒：这次合并会覆盖的 ${drift.colliding.length} 条路径上有轮次中的手改：\n  ` +
        drift.colliding.join('\n  ') +
        '\n  这些改动会被覆盖掉。要保住就先提交或挪走它们，再来合并。',
    }
  }
  return {
    ok: true,
    drift,
    say:
      drift.dirty.length === 0
        ? '漂移检通过：工作树与轮次开始时一致，HEAD 没动。'
        : `漂移检通过：工作树上有 ${drift.dirty.length} 条改动，但这次合并一条都不覆盖。`,
  }
}
