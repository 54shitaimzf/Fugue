// M6 reclaim：`scratch → 视图` 的受控反向通道（架构 § 8.7）。**两个读口，一个声明口。**
//
// 它是"视图是唯一写入者"与"子进程会写盘"共存的那一半（架构 § 2 的 C3 · D1）。两件事，
// 判据都是**枚举**而不是 diff（§ 8.7 的机制那一段）：
//
//   一 · **声明集内的产出。** 落点看档：默认档里声明目录整个绑到 per-agent 缓存上
//        （§ 8.6 第 2 步），字节落在**绑定那一侧**——`collect()` 走 `cacheRoot(a)/<rel>`；
//        **退化档里没有绑定**（没有沙箱就没有挂载），字节落在树自己那一侧，于是落点是树
//        （overlayfs 档读 `upper`，另两档就是 `merged`）——同一份 `collect()`，两处落点。
//        一条绑定盖住它下面的一切，所以落点与"这条声明是自己被绑的、还是被祖先那条绑的"
//        无关（`cacheLayoutOf().bound` 一处定义那个坐标）。产出与 `M2.diff()` 同构，
//        `M2.applyDelta()` 直接消费。
//   二 · **声明集外的改动。** `upper` 里那些"本该为空"的条目（§ 8.7 原话）。**读数每次都取**，
//        与"这一趟的树可不可写"无关：默认档里子进程写不进未声明的位置（内核给 errno 30），
//        于是那里照例读到空集；而读一次是"树一个字节没变"这条断言的**读数**，不是一句
//        "应该不会"。真读到东西时它照样报出来——多一道真报出来的闸门，比少一道强。
//
// **删除那一支（W8 补）。** 上面两条说的都是"盘上有、要收回来"，而**盘上没有、视图里有**是
// 第三件事：`collect` 原先只认 `add` / `symlink` 两种（`leafOf`），撞 whiteout 当场拒、
// "声明了却不在"当"没产出"跳过——于是 `bash rm` 这类删除**回不来**：视图里那一份还在，
// 收尾就把它提交上去（模型删了，提交里还在，静默错）。判据是**两个源**的：base 树里在、
// **或**本格 `ensure` 清单里有 → 现在不在就是 `delete`；两源都不在才是"这一次没有东西要回"。
// 为此 `ReclaimDeps` 多了两个**窄读口**（`statAt` · `listAt`）——
//
//   **这一处越过了架构 § 8.3 那条界（M6 与 M2/M4 只共享 `Delta`），而它是被批准的例外。**
//   越界的理由是判据本身要它：上面那条二源判据的另一半问的是**底那棵树**，而"底里有没有这条
//   路径"只有真源答得出来。给的是两条读，不是整份 `Truth`，也不是日志——回收仍然不读日志
//   （清单由调用点递进来）。界在别处照旧。
//
// **清单那一条要减掉。** `upper` 里本来就有东西：`ensure` 把视图的 delta 落在那儿（那是合法
// 的落地，不是子进程写的）。所以"这一趟子进程在树里改了什么"= `upper` 的叶子 − 清单里那些
// 路径。少这一减，任何一次"先写视图再跑动作"都会凭空报出一条 `mat/reclaim`。
//
// **枚举 `upper` 要在 overlay 卸载之后**（§ 8.7 与 § 8.5 的第一条机制约束）：挂载期间从外面
// 读 `upper` 看到的是写者视角的原始目录。卸载由命令面管（`mount.ts` 的 `unmountOverlay`），
// 这一份只读——**它不挂不卸、不写日志**（§ 8.1 的写者只有那几处）。
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normMode } from '../delta.ts'
import type { Delta } from '../delta.ts'
import type { Roots } from '../roots/contract.ts'
import type { DirEntry, EntryMeta } from '../entries.ts'
import type { AbsPath, AgentId, CommitId, ForkStrategy, RelPath } from '../terms.ts'
import { cacheLayoutOf } from '../boundary/confine.ts'

/**
 * 一次运行的声明集：**要回写视图的那一份产出**——工作区配置里 `actions.<名字>.outputs`
 * （架构 § 15.3.a）。`cache` 那一条键不在里面：构建产物**不回收**（§ 8.7 的三个使用场景）。
 *
 * 那一份绑定（`cache` ∪ `outputs`，嵌套收成最外层）是 § 8.6 第 1 步的事，住 `binding.ts` 的
 * `declaredDirs`——**两件事两处，不合成一个**：绑是为了让子进程写得动，回收是为了让字节
 * 回到视图里。
 */
export interface DeclaredSet {
  readonly agent: AgentId
  /** 声明的那几条，去重 · 排序：重放两次要给同一串字节。 */
  readonly paths: readonly RelPath[]
  /**
   * 某一条声明路径下**视图动过的那些路径**（删除那一支的源一）。**声明是路径上界，不是路径表**：
   * `ownedPaths: ['src']` 说的是"`src` 这一棵归你"，而具体动过哪几个文件只有视图答得出来。
   * 所以这一栏是一个函数而不是一个数组——它要用的那份数据由调用点递进来（视图的变更序列），
   * M6 仍然只认识 `Delta`。
   *
   * 不给它时删除那一支退到只认 base 树那一个源（源二）。
   */
  readonly isDeclared?: (rel: RelPath) => readonly RelPath[]
  /**
   * 与 `isDeclared` 配对的那一个分类：这条路径此刻在视图里是不是**一条墓碑**（删过一次，而且
   * 没有活着的后代把它遮住）。墓碑那一条已经在视图里了——再报一次 `delete` 是重复的。
   *
   * 两栏一起给才有源一。
   */
  readonly isTombstone?: (p: RelPath) => boolean
}

/** 这一层自己的失败。**有由头的拒绝**，与 `EnsureRefused` 同一个形状。 */
export class ReclaimRefused extends Error {
  readonly why: string

  constructor(why: string) {
    super(why)
    this.name = 'ReclaimRefused'
    this.why = why
  }
}

export interface ReclaimDeps {
  readonly roots: Roots
  /**
   * 物化到哪一档。**只有 `overlayfs` 档有 `upper` 可枚举**：另两档的落地集是从清单推的，
   * "落地根里多出来一条"在那两档上看不见（§ 8.5 末段那句话）。所以 `undeclared` 在那两档
   * 上报空集——**这一条是记在案的边界，不是"查过了没发现"**。还没 fork 过时它是 `null`。
   */
  readonly strategy: ForkStrategy | null
  /**
   * 清单：相对 base 变了的路径。它们是 `upper` 里**合法**的那些条目（视图的 delta 已经落下去
   * 的部分），要从"改动"里减掉。**由调用点递进来**：这一份不读日志（§ 8.3：M6 与 M2/M4 只
   * 共享 `Delta`）。
   *
   * **给的是"落地之后"的那一份**（`EnsureResult.manifest`），不是运行前从日志里读的那一份：
   * `fugue run` 起进程之前先兑现一次物化，那一下就把视图里还没落地的 delta 落进了 `upper`。
   * 拿旧的清单去减，第二趟运行会把上一趟的产出报成"越了声明"——实测撞到过。
   */
  readonly manifest: readonly RelPath[]
  /**
   * **声明的产出落在哪一侧**：`cache` = 绑定那一侧（有挂载层时，字节从绑定过去），
   * `tree` = 树自己那一侧（没有挂载层：没有挂载就没有绑定）。
   *
   * 它由**机制**决定，不由档决定：Y6 起"没有 bwrap 但有 Landlock"那一档的树是只读的
   * （未声明的写入当场拒），而声明的产出照样落在树那一侧——两件事分开。
   */
  readonly landing: 'cache' | 'tree'
  /**
   * **树是不是敞开的**：敞开 = 未声明的写入可能落进树里，于是"声明集外的改动"这道闸门要查
   * （`undeclared()` 靠枚举 `upper` 兑现）；不敞开 = 那些写入由内核当场拒（挂载层的只读绑定，
   * 或第二层的规则集），树里没有可查的东西。
   */
  readonly treeOpen: boolean
  /**
   * 删除那一支的二源判据要问的一半：**底那棵树里有没有这条路径**。
   *
   * **哪一棵底不由这一份说**：视图此刻铺在 `mat/fork.base` 那一棵上，那个坐标是视图与物化的
   * 事，不是 M6 的事——所以它是调用点绑好的两条读（`(path) => truth.statAt(base, path)`），
   * 这一份只问"有没有"。不给这两个读口时删除那一支不成立：`collect` 那时只回"盘上有什么"，
   * 而"盘上没有、视图里有"与"这一次本来就没东西要回"分不开。两处**都是窄读**：给的是路径上的
   * 两条读，不是整份 `Truth`；`ReclaimDeps` 仍然不读日志（清单由调用点递进来）。
   */
  readonly statAt?: (path: RelPath) => Promise<EntryMeta | null>
  /** 声明的那条路径是目录时，用它枚举底里那一棵的叶子（逐叶给 `delete`，不发明目录级删除）。 */
  readonly listAt?: (dir: RelPath) => Promise<DirEntry[]>
  /**
   * 源一那一半：**视图在这一条声明路径下动过哪些路径**（`DeclaredSet.isDeclared` 那一份）。
   *
   * 它是"删除那一支"的另一半判据，与 `statAt`/`listAt` 平行而不是它的退化档：两源各自盖住
   * 一种情形（视图动过 · base 里本来就有），少一个就少一种删除回得来。
   */
  readonly isDeclared?: (rel: RelPath) => readonly RelPath[]
  /**
   * **子进程跑完之后，那棵树上还有没有这一条路径**（`merged` 里的一次 `existsSync`）。
   *
   * **删除那一支的最后一句判据。** `collect` 在上面枚举的是 `upper`，而它只说"这一格自己写下来
   * 的那些"；底里继承来的文件不在 `upper` 里，**而它们照样在那棵树上**。所以"这一条还在不在"
   * 必须问**命令跑完之后那棵树**，不能只看 `upper`——两者混起来会出假删除（本地实测撞到过）：
   * 只读的一整格（`cat`）把声明树整棵报成 `delete`，而判据 ⑥ 那条读数（"视图没动就不落
   * `mat/sync`"）当场被那条假删除推出一条真的 `mat/sync`。
   *
   * 有了它，删除那一支的话就齐了：**盘上没有 · 树上也没有 · 而两源里说它本来在**（源一：视图
   * 动过它；源二：底里有它）。少第三条是"这一条路径本来就不存在"，少前两条是"底里继承来的"。
   *
   * **不给它时按"在"算**（宁可不报删除，也不报一条假的）。
   */
  readonly treeNow?: (rel: RelPath) => Promise<boolean>
  /** 源一配的那一个分类：已经是墓碑的那几条不重复报（`DeclaredSet.isTombstone`）。 */
  readonly isTombstone?: (p: RelPath) => boolean
}

/** 架构 § 8.7 的接口。两个方法逐字，加上那条闸门的读口。 */
export interface Reclaim {
  declare(a: AgentId, paths: readonly RelPath[]): DeclaredSet
  collect(a: AgentId, declared: DeclaredSet): Promise<Delta[]>
  /**
   * 声明集**外**被改动的路径——`mat/reclaim` 的 `changed` 那一栏（`declared` 那一栏是
   * `declared.paths`）。
   *
   * **它不在 § 8.7 那两个方法里**，是这一站加出来的一个读口：那句话（"未声明却被改动的路径
   * → 拒绝并记 `mat/reclaim` 事件"）要有人把"哪些路径越了声明"读出来，而 `collect()` 的
   * 返回值是 `Delta[]`（逐字），装不下这一栏。事件本身的形状没动（§ 8.1）。
   */
  undeclared(a: AgentId, declared: DeclaredSet): Promise<RelPath[]>
}

/**
 * 声明产出的落点：**看机制**（有没有挂载层），不看档。
 *
 *   · 默认档（有沙箱）：`cacheRoot(a)`——声明目录整个绑到那儿，字节从绑定那一侧过去。
 *   · 退化档（没有沙箱）：**树自己那一侧**——没有挂载就没有绑定，子进程写的是 `merged/<rel>`，
 *     而它落在 `upper`（overlayfs）或干脆就是 `merged`（另两档）。**枚举与回收都在卸载之后**
 *     （§ 8.7），所以 overlayfs 档读的是 `upper`：卸载之后 `merged` 只是一个空挂载点。
 */
function landingOf(deps: ReclaimDeps, a: AgentId): AbsPath {
  if (deps.landing === 'cache') return cacheLayoutOf(deps.roots, a).home
  return deps.strategy === 'overlayfs' ? deps.roots.scratchRoot(a) : deps.roots.mergedRoot(a)
}

export function createReclaim(deps: ReclaimDeps): Reclaim {
  const { roots } = deps
  return {
    declare(a: AgentId, paths: readonly RelPath[]): DeclaredSet {
      const seen = new Set<RelPath>()
      for (const raw of paths) {
        // **声明是虚拟空间里的路径，所以过 M3 那道围栏**：绝对路径 · `..` 越界 · 穿过软链
        // 都在这里拒并指路（§ 8.4 硬纪律 1）。声明直接写在工作区配置里，是人手写的那一份。
        const r = roots.resolveVirtual(raw, '')
        if (!r.ok) {
          throw new ReclaimRefused(
            `动作声明的路径不成立：${r.error.message}\n` +
              `声明写在配置的 actions.<名字>.outputs 里，是**视图内的相对路径**（如 dist/app）；` +
              `已经在树里、要一起收集的那些，写成它所在的那条声明目录下的路径。`,
          )
        }
        seen.add(r.value)
      }
      return { agent: a, paths: [...seen].sort() }
    },

    async collect(a: AgentId, declared: DeclaredSet): Promise<Delta[]> {
      const landing = landingOf(deps, a)
      const out: Delta[] = []
      // **"盘上走到的那些"单攒一份，不从 `out` 里回捞**：`out` 里现在也会混进删除那一支自己推
      // 的条目（前面几条声明路径报出来的），而 `skip` 问的是"这条路径这一趟盘上还在不在"。
      // 混起来会串味——先报出来的 `delete` 会替后面的声明路径挡掉它本该报的删除。
      //
      // 它含两样：**这一趟盘上枚举到的每一个叶子**（含 `walk` 报出来的白障——白障本来就在盘上），
      // 以及**声明的 `rel` 自己**（盘上是一条文件时它就是那一叶；盘上是一条目录时它不是一条
      // `Delta` 能表示的路径）。
      const onDisk = new Set<RelPath>()
      for (const rel of topLevel(declared.paths)) {
        const at = join(landing, rel)
        const st = lstatSync(at, { throwIfNoEntry: false })
        // **盘上有的先收**（`add` / `modify` / `symlink`），再问"盘上没有而两源里有的那些"
        // ——顺序不能反：删除那一支要拿"已经收过的"当跳过集，否则它会把刚收过的那一条再报一次。
        if (st !== undefined && st !== null) {
          onDisk.add(rel)
          if (st.isDirectory()) {
            const before = out.length
            walk(at, rel, out)
            for (const d of out.slice(before)) onDisk.add(pathOf(d))
          }
          // **单条那一支也要过白障**：删一条声明过的**文件**时，`upper` 里留下的就是
          // 它自己那条字符设备（没有一层目录可以让 `walk` 去走）——不过这一关就是
          // “声明目录里有一条不是文件也不是链接的东西”，而真正发生的事是“删了它”。
          else if (whiteoutAt(at, st)) out.push({ kind: 'delete', path: rel })
          else out.push(leafOf(at, rel, st))
        }
        // `onDisk` 只有一样：**这一趟盘上枚举到的那些**（`upper` 上的叶子与白障，加上 `rel`
        // 自己）。删除那一支要拿它当"已经收过了"的跳过集——**"还在不在"不归它管**，那件事由
        // `treeNow` 答（见 `collectDeleted`；两者混成一个集合会互相抵消，实测撞到过）。
        await collectDeleted(deps, a, rel, out, declared.paths, onDisk)
      }
      // 按路径排序：同一批产出重放两次要给同一串字节，视图的 rev 序列才可比（X3 那条断言）。
      return out.sort((x, y) => (pathOf(x) < pathOf(y) ? -1 : pathOf(x) > pathOf(y) ? 1 : 0))
    },

    async undeclared(a: AgentId, declared: DeclaredSet): Promise<RelPath[]> {
      // **树可写而没有 `upper` 可枚举**：这一档查不出"声明集外被改动了什么"（§ 8.5 末段：
      // 另两档的落地集是从清单推的，落地根里多出来一条在那两档上看不见）。**当场拒绝，不静默
      // 收下**——要跑退化档就得让 `fork` 走 overlayfs（E2 的地板是另一条，两条地板叠在一起
      // 的现场不在这一站的范围里）。
      if (deps.treeOpen && deps.strategy !== 'overlayfs') {
        throw new ReclaimRefused(
          `这一档树可写，却查不出声明集外的改动：${deps.strategy} 没有 \`upper\` 可枚举（§ 8.5）\n` +
            `退化档靠枚举 \`upper\` 兑现"未声明却被改动 → 拒绝并记事件"；这两档叠在一起时那道闸门\n` +
            `就是一句空话。要么让 fork 走 overlayfs（fugue fork <base> --strategy overlayfs），` +
            `要么先装回 bwrap。`,
        )
      }
      if (deps.strategy !== 'overlayfs') return []
      const legit = new Set<RelPath>(deps.manifest)
      const out: RelPath[] = []
      for (const rel of leavesUnder(roots.scratchRoot(a))) {
        if (legit.has(rel)) continue
        if (declared.paths.some((p) => rel === p || rel.startsWith(`${p}/`))) continue
        out.push(rel)
      }
      return out.sort()
    },
  }
}

/**
 * 收哪些声明：**被另一条声明盖住的那些摘掉**（"gen" 与 "gen/sub" 同时声明时，走一遍 gen 就
 * 把 sub 里的都收了）。声明表是排过序的，所以祖先一定在它自己的后代前面。
 */
function topLevel(paths: readonly RelPath[]): RelPath[] {
  const out: RelPath[] = []
  for (const p of paths) {
    if (out.some((q) => p.startsWith(`${q}/`))) continue
    out.push(p)
  }
  return out
}

/**
 * 收集"盘上没有、而两源里在"的那些——**删除那一支**。判据是两个源，缺一不可地分开记：
 *
 *   源一 · **视图动过它**（`DeclaredSet.isDeclared` 给那一条声明路径下、视图动过的那些路径，
 *          `DeclaredSet.isTombstone` 给其中已经删过的那几条）：盘上没有了就是这一次删掉的。
 *          **同格内先 `write` 后 `bash rm` 走的是这一支**——只查 base 会把这种删除当成没发生，
 *          而视图里那一份还在，收尾就把它提交上去（模型删了，提交里还在，静默错）。
 *   源二 · **base 树里有它**（`deps.statAt` + `deps.listAt`）：这一格把它删了。两个窄读口缺
 *          一个，这一源就不成立。
 *
 * 两源都不在 = 这一次本来就没有东西要回（命令面报成 `missing`），**不是**一条 `delete`。
 * 两源里在、而**这一趟跑完之后树上还在**的那些同样不是删除（`deps.treeNow`）——源一/源二说
 * 的是"它本来在"，`treeNow` 说的是"它现在还在不在"；两句都要问。
 *
 * **目录逐叶给。** 清单里没有"目录条目"这种东西（一条路径要么是叶子、要么不在清单里），
 * 所以声明的路径是目录时，用 `listAt` 枚举底里那一棵的**叶子**，一条一条给 `{kind:'delete'}`，
 * 不发明目录级的删除。`skip` 是同一趟里盘上已经收过的那些（`walk` 收过的），跳过。
 */
async function collectDeleted(
  deps: ReclaimDeps,
  a: AgentId,
  rel: RelPath,
  out: Delta[],
  declared: readonly RelPath[],
  skip: ReadonlySet<RelPath>,
): Promise<void> {
  const statAt = deps.statAt
  const listAt = deps.listAt
  const seen = new Set<RelPath>()
  /**
   * 报一条删除：**没报过 · 盘上那一趟没收到它 · 而它这一趟真的不在了**。
   *
   * 第三句是 `deps.treeNow`（"命令跑完之后那棵树上还有没有它"），**不能拿 `skip` 兼这一句**：
   * `skip` 里是"盘上枚举到的那些"，而"视图里刚写出来、还没落地"与"底里继承来"的那两类也
   * 不该报删除——把它们塞进 `skip` 会顺手把源一/源二本该报的那几条也挡掉（本地实测：先
   * `write` 后 `bash rm` 那一档就是这么被抵消掉的）。
   *
   * **`p === rel` 不再是"重复"**：盘上还有它的那些已经在 `skip` 里（调用点把 `rel` 自己也放进
   * 去了），所以走到这里而它不在 `skip` 里，说明**这一趟它没了**——那正是要报的删除。上一版
   * 这里写的是 `p === rel` 一律跳，后果是"声明一条文件、同格内先 `write` 后 `bash rm`"永远报不
   * 出来：视图里那一份还在，收尾就把它提交上去（模型删了、提交里还在的静默错，判据 ④ 说的那条）。
   */
  const push = async (p: RelPath): Promise<void> => {
    if (seen.has(p)) return
    if (skip !== undefined && skip.has(p)) return
    if (deps.treeNow === undefined || (await deps.treeNow(p))) return
    seen.add(p)
    out.push({ kind: 'delete', path: p })
  }

  // 源一 · **视图动过它**、而盘上没有了。`deps.isDeclared` 与 `deps.isTombstone` 是这一支要的
  // 那两样；不给就整个源一缺席（那时只认 base 那一个源）。它盖住的正是"同格内先 `write` 后
  // `bash rm`"——只查 base 会把这种删除当成没发生，视图里那一份还在，收尾就把它提交上去。
  //
  // **收窄到声明的面**：视图动过的东西可能落在声明之外（模型随手 `write` 的一个文件），而
  // "删没删"只对声明集内的路径有话说（集外那一份不进视图，也不该被报成删除）。
  if (deps.isTombstone !== undefined) {
    // **下面那一段的前提是“视图里这一条还在”**（它还在、道上没了 ⇒ 这一趟删的）。
    // 而视图里已经是墓碑的那些，**删除已经落在视图里了**（本格的 `bash rm` 走的就是这一条）——
    // 再报一次是重复的，而 `applyEdit` 对一条不存在的路径会当场报“这个路径不存在”（本地实测撞到就是它）。
    for (const p of deps.isDeclared(rel)) {
      if (!declared.some((q) => p === q || p.startsWith(q + '/'))) continue
      if (deps.isTombstone(p)) continue
      await push(p)
    }
  }

  // 源二 · **base 树里在它**、而盘上没有了。**哪一棵底不用问**：视图此刻铺在 `mat/fork.base`
  // 那一棵上（物化就是从它铺出来的），所以记那一份的坐标是视图自己的事——这一份只拿两个窄读口
  // 去问"底里有没有这条路径"。两个读口缺一个，这一源就不成立。
  if (statAt !== undefined && listAt !== undefined) {
    const top = await statAt(rel)
    if (top !== null) {
      const leaves: RelPath[] = []
      if (top.kind === 'dir') {
        const stack: RelPath[] = [rel]
        while (stack.length > 0) {
          const at = stack.pop() as RelPath
          for (const row of await listAt(at)) {
            const p = (at === '' ? row.name : `${at}/${row.name}`) as RelPath
            if (row.kind === 'dir') stack.push(p)
            else leaves.push(p)
          }
        }
      } else leaves.push(rel)
      for (const p of leaves) await push(p)
    }
  }
}

/** 一条 delta 的路径。`collect` 只产 `add` 与 `symlink` 两种；`rename` 那一支是给排序器的
 *  类型收窄用的，走不到（那一支是 `M2.diff()` 的产物）。 */
function pathOf(d: Delta): RelPath {
  if (d.kind === 'rename') return d.from
  return d.path
}

/** 盘上的一个条目 → 一条 delta。**符号链接按它指的东西记**（与 `M2` 那一栏同构）。 */
function leafOf(abs: string, rel: RelPath, st: ReturnType<typeof lstatSync>): Delta {
  if (st.isSymbolicLink()) return { kind: 'symlink', path: rel, target: readlinkSync(abs) }
  if (st.isFile()) {
    return { kind: 'add', path: rel, bytes: readFileSync(abs), mode: normMode(st.mode) }
  }
  // 白障（字符设备 0:0）落到这里：子进程在缓存里造不出它，真造出来了也不是一条能回写的
  // 产出——**报出来，不装作没看见**。
  throw new ReclaimRefused(
    `声明目录里有一条不是文件也不是链接的东西：${rel}\n` +
      `回收只回文件与符号链接（架构 § 8.3 的 Delta 那一栏）；这一条要么是子进程写歪了，要么是这一档不支持。`,
  )
}

/**
 * 走一棵树，收成 delta。**目录本身不是条目**（§ 8.5：清单与差异集里没有 `dir` 这种东西），
 * 所以只有叶子进结果。按名字排序走：同一棵树两次给同一串字节。
 */
/**
 * 盖层里的白障（子进程删了一条声明过的东西之后内核留下的那一条）：**字符设备 0:0**。
 *
 * 判据是两个数字（**本地实测读到的就是 0:0**），不是“不是文件也不是链接”那句话：
 * 那句话把白障与真写歪的东西（比如一个目录）混成一类，而两者的处置相反。
 */
function whiteoutAt(abs: string, st: ReturnType<typeof lstatSync>): boolean {
  return st.isCharacterDevice() && st.rdev === 0
}

function walk(dir: string, prefix: RelPath, out: Delta[]): void {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const rel = prefix === '' ? name : `${prefix}/${name}`
    const st = lstatSync(abs)
    if (st.isDirectory()) {
      walk(abs, rel, out)
      continue
    }
    // **白障 = 删除**（W8 补的那一支）：盘上它是一条字符设备，而子进程真正做的事是“把这一条拿走”。
    if (whiteoutAt(abs, st)) {
      out.push({ kind: 'delete', path: rel })
      continue
    }
    out.push(leafOf(abs, rel, st))
  }
}

/** `upper` 里的叶子（文件 · 链接 · 白障），相对 `upper` 的路径，排序。 */
function leavesUnder(root: string): RelPath[] {
  const out: RelPath[] = []
  const walkUpper = (dir: string, prefix: RelPath): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      const st = lstatSync(abs)
      if (st.isDirectory()) walkUpper(abs, rel)
      else out.push(rel)
    }
  }
  const st = lstatSync(root, { throwIfNoEntry: false })
  if (st !== undefined && st !== null && st.isDirectory()) walkUpper(root, '')
  return out
}
