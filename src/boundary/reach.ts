// 物理可达集的形状（架构 § 8.8 的 `ReachSpec` · PLAN § 5.5 的 Y2 与 Y3）。
//
// **它是"工作区即宇宙"那句话的落地**：子进程够得着的宿主路径 = 这里列的那几条 + 树自己（挂
// `/work`，只读）。没点名的一律不在——所以漏一条的形态是**当场起不来**，不是静默漏。实测两条：
// 缺 `/lib64` → `bwrap: execvp /usr/bin/echo: No such file or directory`；缺 `/etc/alternatives`
// → `bwrap: execvp cc: No such file or directory`。这两条就是 Y3 负对照的原样。
//
// **清单是量出来的**（PLAN § 5.5 的读数第 2 条）：一份真构建在树外碰 147 条路径，一级目录只有
// `etc lib opt proc sys tmp usr`；node 落在 `/opt/node-v24.21.0-linux-x64`，所以清单不能只写
// `/usr`。缺省值就是那次探针量出来的那几项，**可声明**——工作区配置的 `boundary.reach` 覆盖
// `roRoots` 那一栏（架构 § 15.3.a），其余三栏是形状，由这一层定。
//
// **`.fugue/` 要在沙箱那一侧挖掉。** `config` · `log/` · `mat/` 就住在树里（架构 § 8.4：物化的
// 根跟着工作区走），树整棵挂进去它们就跟着进去了；Y1 的用例表里那两条泄漏（「工作区配置」与
// 「工作区日志」）走的正是 `@work/.fugue/…`——不挖，那两条不会翻面。
import type { ConfigDoc } from '../config.ts'
import { getConfig } from '../config.ts'

/** 边界这一层的失败：策略值读不出来 · 清单不成立。**拒绝并指路**，与围栏同一个口径。 */
export class PolicyError extends Error {}

/** 一条软链：宿主根上 `/bin` 指向 `usr/bin` 那一类（只读根之外还必须存在的）。 */
export interface ReachSymlink {
  readonly at: string
  readonly to: string
}

export interface ReachSpec {
  /** 只读挂进来的宿主路径（文件或目录）。 */
  readonly roRoots: readonly string[]
  /** 只读根之外还必须存在的软链。 */
  readonly symlinks: readonly ReachSymlink[]
  /** 设备与进程那一份（`/dev` · `/proc`）。 */
  readonly devices: readonly string[]
  /** 树里要挖掉的（相对树根）：本 agent 物化的根与日志都住在 `.fugue/` 底下。 */
  readonly mask: readonly string[]
}

/** 改 `roRoots` 的那一个键（点分键，架构 § 15.3.a）。 */
export const REACH_KEY = 'boundary.reach'

/**
 * 缺省清单 = S5 站前那次探针量出来的那几项（`f9ff1b7`）：`/usr` 与 `/opt`（node 在那儿）·
 * `/etc` 的三条（动态链接器缓存 · 证书 · `cc` 那条 alternatives）· 宿主根上那四条软链 ·
 * `/proc` 与 `/dev`。
 *
 * **第六项 `/etc/resolv.conf` 是 S5 步骤审批下来的**（Y5 那条"点名要网只给出网，不给名字"的收口）：
 * 前五项是"起得来"要的，它是"点名要网之后够得着名字"要的。分档量过（同一个工作区里改这一栏，再跑
 * 一个按域名连一次的动作）：缺省清单 `err:EAI_AGAIN` · **只并这一条** `dns=ok:104.20.23.154` 且
 * `https=ok:200`（连跑五遍五通）· `/etc/hosts` 与 `/etc/nsswitch.conf` **不必要**（名字解析走
 * glibc 的 `dns` 那一支，`files` 那一支缺 `/etc/hosts` 也不影响）· 缺省档（不点名要网）一个字节
 * 没变（`err:EAI_AGAIN`）。
 */
export const DEFAULT_REACH: ReachSpec = {
  roRoots: ['/usr', '/opt', '/etc/ld.so.cache', '/etc/ssl', '/etc/alternatives', '/etc/resolv.conf'],
  symlinks: [
    { at: '/bin', to: 'usr/bin' },
    { at: '/sbin', to: 'usr/sbin' },
    { at: '/lib', to: 'usr/lib' },
    { at: '/lib64', to: 'usr/lib64' },
  ],
  devices: ['/dev', '/proc'],
  mask: ['.fugue'],
}

/**
 * 沙箱里那三条坐标（PLAN § 5.5「站前要批的三处」的第 3 条）：树挂 `/work` · 家与缓存挂 `/cache` ·
 * temp 挂 `/tmp`。**它是"子进程看到的路径"**，与宿主那一侧一一对应（`mergedRoot(a)` ·
 * `cacheRoot(a)` · `tempRoot(a)`）。
 *
 * 为什么要固定：宿主布局一旦漏进沙箱，**产物里就带着它**（`cc -g` 的 `DW_AT_comp_dir`），
 * 跨 agent 比字节从"可断言"退成"归因读数"。实测：两个不同宿主路径各编一次产物不同，都挂到
 * `/work` 则逐字节相同。
 *
 * 两条读同一份：`confine()` 的 argv 与 `envFor()` 的那几个变量（架构 § 8.6 的头三行）。
 */
export interface Coords {
  /** 物化树在子进程眼里的挂载点。 */
  readonly tree: string
  /** 家与缓存：`HOME` 与 `XDG_CACHE_HOME` 的父目录。 */
  readonly home: string
  /** `TMPDIR`。 */
  readonly tmp: string
}

/** 有层在场时那三条（`policy.coords` 在有沙箱的档上就是它）。 */
export const SANDBOX_COORDS: Coords = { tree: '/work', home: '/cache', tmp: '/tmp' }

/**
 * 读清单。**没配过就是缺省值**（与 `ports.range` 同一个口径），配了就要成立：非空数组 ·
 * 每一条都是绝对路径 · 里面不许有 `..`——那是"换一条坐标再说"，正是清单要关掉的东西。
 */
export function readReach(doc: ConfigDoc): ReachSpec {
  const raw = getConfig(doc, REACH_KEY)
  if (raw === undefined) return DEFAULT_REACH
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PolicyError(
      `${REACH_KEY} 要是一个非空的数组（绝对路径）：fugue config set ${REACH_KEY} '["/usr","/opt"]'`,
    )
  }
  const roots: string[] = []
  for (const x of raw) {
    if (typeof x !== 'string' || x === '') {
      throw new PolicyError(`${REACH_KEY} 里每一项都要是一个非空字符串：${JSON.stringify(x)}`)
    }
    if (!x.startsWith('/')) {
      throw new PolicyError(
        `${REACH_KEY} 里每一条都要是绝对路径（子进程看到的宿主机与宿主同一个根）：${JSON.stringify(x)}`,
      )
    }
    if (x.split('/').includes('..')) {
      throw new PolicyError(
        `${REACH_KEY} 里不许有 ..：${JSON.stringify(x)}——那是"换一条坐标再说"，清单要关掉的正是它`,
      )
    }
    roots.push(x)
  }
  return { ...DEFAULT_REACH, roRoots: roots }
}
