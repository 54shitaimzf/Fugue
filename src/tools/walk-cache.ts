// walk 的清单缓存：**键是视图代**（`view.rev`）。出处：TARGETS `T16` ①（"walk 清单按视图代
// 缓存"）· 架构 § 8.10（`glob` 与 `grep` 走的是同一份清单）。
//
// **它住宿主层，不进视图**：走多深 · 走几条 · 软链跟不跟是工具面的产品，而 `View.list` 是共享缝
// （`stat` · `read` · 快照 · `ensure` 都在用它）——缓存进视图会改所有调用方的语义面。这一份是最小
// 的派生体：清空随时安全，它死了系统只是**变慢**（AGENTS 第五节那条地板）。
//
// 三条硬性（测试里会红的那几条）：
//
//   一 · **键只读 `view.rev` 这一个活读数**：`write` · `rename` · `chmod` · `remove`（墓碑）·
//        执行回写的 `applyEdit` 都推进它，而它不是物化树的快照——"快路径以视图为基准"由此兑现。
//        代没变就复用，代变了就重走。
//   二 · **枚举失败不写缓存**：一次 `view.list` 抛出去，这一代照旧是未命中，下一次调用重试。
//        半份清单比没有清单更坏：它看着像"这棵树就这么大"。
//   三 · **交出去的那一份是冻结的**：一位调用者改它不影响下一位，于是同代复用不必逐次拷贝。
//        截没截（`WalkCut` · `walkCutOf`）**跟着那一份清单走**：它是枚举的读数，不是清单的一栏。
import type { ViewRev } from '../terms.ts'

/**
 * 走一遍树要的那两样：这一格现在是哪个号，以及怎么列一层。
 *
 * 它比 `View` 窄（只有 `rev` 与 `list`）——这一份不读视图的其余任何一栏，窄口把这件事写在
 * 签名上，也让纯机制的测试不必起一份真视图。
 */
export interface WalkView {
  /** 活读数：每问一次都在问"此刻是哪个号"。**不许在这里缓存成一个数**。 */
  readonly rev: ViewRev
  list(dir: string): Promise<readonly DirRow[]>
}

/** 列目录的一行里这一层读得懂的两栏（`DirEntry` 的其余几栏这里不看）。 */
export interface DirRow {
  readonly name: string
  readonly kind: string
}

/** 走多远就停。**两条都是必须的**（出处见 `host.ts` 那两条常数）：软链穿过去就绕开了路径围栏，
 * 而不封顶的深树能把一步走成挂死。 */
export interface WalkLimits {
  readonly depth: number
  readonly rows: number
}

/**
 * 一次枚举的收尾事实：**这一趟走有没有被上限截住**（本站 ②）。
 *
 * 它与那份清单一起交出去——**"截没截"是一个读数，不是每张回执各自猜的东西**：回执那边看不见
 * 走树内部发生了什么，`paths.length === limits.rows` 也判不出来（树里恰好这么多文件与截在
 * 上限上，两件事长得一样；深度那一档更是从清单上根本看不出来）。
 */
export interface WalkCut {
  /** 条数顶到上限：**还有没列出来的**。 */
  readonly rows: boolean
  /** 深度顶到上限：**可能有更深的目录没走进去**。 */
  readonly depth: boolean
  /** 这一趟用的两条上限（回执那句人读的话要用它们，**不另抄一份常数**）。 */
  readonly limits: WalkLimits
}

/**
 * 交出去的那份清单 → 它是怎么走出来的。**键就是那份清单自己**（同一个代复用同一个引用）。
 *
 * 为什么是 `WeakMap` 而不是往数组上挂一个字段：交出去的那一份是**冻结**的（硬性三），而"这次
 * 枚举截没截"是枚举那一侧的读数——挂到数组上就把它变成了数组的一部分，谁遍历 · 谁 `JSON.stringify`
 * 都会带上它，而它不是一个路径。
 *
 * **没记过就是 `null`**（夹具与单测里那种手搓的 `walk()`）：机制缺席 = 少一份读数——不猜、
 * 不报错、也不改变既有回执的一个字节。
 */
const CUTS = new WeakMap<readonly string[], WalkCut>()

/** 读一次枚举的收尾事实。**只读，不改**（见上面那一张表的理由）。 */
export function walkCutOf(paths: readonly string[]): WalkCut | null {
  return CUTS.get(paths) ?? null
}

/**
 * 一份按视图代缓存的 `walk()`。
 *
 * 出口的形状与 `ToolHost.walk()` 逐字相同（`() => Promise<readonly string[]>`）——缓存是这一条
 * 路上的加速项，不是另一个接口。
 */
export function createWalk(view: WalkView, limits: WalkLimits): () => Promise<readonly string[]> {
  /** 上一次枚举的那一份，连同它属于哪一代。一次都没成功过时是 `null`。 */
  let cached: { readonly rev: ViewRev; readonly paths: readonly string[] } | null = null

  return async function walk(): Promise<readonly string[]> {
    const rev = view.rev
    if (cached !== null && cached.rev === rev) return cached.paths
    const out: string[] = []
    // **两条上限各自记一笔**（本站 ②）：记的是"真的因为这一条停下来了"，不是"凑巧顶到了"——
    // 树里恰好 `limits.rows` 个文件的那一档，循环自然走完，两条都是假。
    let rowsCut = false
    let depthCut = false
    const step = async (dir: string, depth: number): Promise<void> => {
      // 这一条目录没被列过：它下面可能有东西，而这一趟走不到那么深。
      if (depth > limits.depth) {
        depthCut = true
        return
      }
      if (out.length >= limits.rows) {
        rowsCut = true
        return
      }
      const rows = await view.list(dir)
      for (const row of rows) {
        if (out.length >= limits.rows) {
          rowsCut = true
          return
        }
        const path = dir === '' ? row.name : `${dir}/${row.name}`
        // **软链不跟**：它指向的东西不在视图的可达集里（§ 8.4 的 `through-symlink`）。
        if (row.kind === 'dir') await step(path, depth + 1)
        else if (row.kind === 'file') out.push(path)
      }
    }
    // **抛出去就不写缓存**（硬性二）：`await` 在这里把异常原样交给调用者，而 `cached` 一行不动。
    await step('', 0)
    const paths: readonly string[] = Object.freeze(out)
    CUTS.set(paths, { rows: rowsCut, depth: depthCut, limits })
    cached = { rev, paths }
    return paths
  }
}
