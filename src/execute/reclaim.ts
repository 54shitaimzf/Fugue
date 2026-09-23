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
import type { AbsPath, AgentId, ForkStrategy, RelPath } from '../terms.ts'
import { cacheLayoutOf } from './confine.ts'

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
   * 这一趟的树可不可写——**退化档**（§ 15.7 的 E4：沙箱不在）里它是 `true`。
   *
   * 它决定两件事：产出的落点（可写 = 落点在树那一侧，见 `landingOf`），以及"声明集外的改动"
   * 这道闸门可不可读。**默认档里树是只读的**（`--ro-bind`），所以那里没有什么可查——但读数
   * 照取（那一条写在下面 `undeclared` 里）。
   */
  readonly treeWritable: boolean
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
 * 声明产出的落点：**看档**。
 *
 *   · 默认档（有沙箱）：`cacheRoot(a)`——声明目录整个绑到那儿，字节从绑定那一侧过去。
 *   · 退化档（没有沙箱）：**树自己那一侧**——没有挂载就没有绑定，子进程写的是 `merged/<rel>`，
 *     而它落在 `upper`（overlayfs）或干脆就是 `merged`（另两档）。**枚举与回收都在卸载之后**
 *     （§ 8.7），所以 overlayfs 档读的是 `upper`：卸载之后 `merged` 只是一个空挂载点。
 */
function landingOf(deps: ReclaimDeps, a: AgentId): AbsPath {
  if (!deps.treeWritable) return cacheLayoutOf(deps.roots, a).home
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
      for (const rel of topLevel(declared.paths)) {
        const at = join(landing, rel)
        const st = lstatSync(at, { throwIfNoEntry: false })
        // 声明了却没产出不是错：那一条这次没有东西要回。它由命令面报成 `missing`。
        if (st === undefined || st === null) continue
        if (st.isDirectory()) walk(at, rel, out)
        else out.push(leafOf(at, rel, st))
      }
      // 按路径排序：同一批产出重放两次要给同一串字节，视图的 rev 序列才可比（X3 那条断言）。
      return out.sort((x, y) => (pathOf(x) < pathOf(y) ? -1 : pathOf(x) > pathOf(y) ? 1 : 0))
    },

    async undeclared(a: AgentId, declared: DeclaredSet): Promise<RelPath[]> {
      // **树可写而没有 `upper` 可枚举**：这一档查不出"声明集外被改动了什么"（§ 8.5 末段：
      // 另两档的落地集是从清单推的，落地根里多出来一条在那两档上看不见）。**当场拒绝，不静默
      // 收下**——要跑退化档就得让 `fork` 走 overlayfs（E2 的地板是另一条，两条地板叠在一起
      // 的现场不在这一站的范围里）。
      if (deps.treeWritable && deps.strategy !== 'overlayfs') {
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
function walk(dir: string, prefix: RelPath, out: Delta[]): void {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const rel = prefix === '' ? name : `${prefix}/${name}`
    const st = lstatSync(abs)
    if (st.isDirectory()) walk(abs, rel, out)
    else out.push(leafOf(abs, rel, st))
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
