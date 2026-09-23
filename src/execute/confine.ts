// S4 的"怎么包"：把一次执行包成一个 `ConfinedArgv`（`M7.confine()` 的暂居处，S5 收进策略）。
//
// 骨架**逐条照 S4 前那次实测**（`tools/probe-exec.ts`，读数在架构 § 8.6 与代码工作区的
// `c7f5eea`）：
//
//   bwrap --ro-bind / / --die-with-parent --dev /dev
//         --bind <tmp> <tmp> --bind <cache> <cache>
//         --ro-bind <merged> <merged>              ← 树只读；退化档（X4）换成 --bind
//         --bind <cache>/<声明目录> <merged>/<声明目录>   ← 每个声明目录一条
//         --setenv <k> <v> …                       ← HOME · TMPDIR · XDG_CACHE_HOME · 端口 · 注入
//         --chdir <merged>/<cwd> -- <argv…>
//
// **三样缺一不可，都是实测撞出来的**：`--dev /dev`（只 `--ro-bind / /` 时 `/dev/null` 写不动）、
// 按 agent 的 temp 的 `--bind`（只重写 `TMPDIR` 不够——`Cannot create temporary file in ./`）、
// 以及挂载点必须**先存在**（`bwrap: Can't chdir to --bind: No such file or directory`）。
// 最后这一条由 `M4.ensure` 在卸载态预建（架构 § 8.6 第 1 步），`confine` 只要求它已经在了。
//
// **`--unshare-net` 不在这里**：网络的边界是 S5 的事（架构 § 8.8 的 `Policy`）。所以这一站
// 的围栏只有"树只读 + 声明目录可写"这一条，`full` 报的是**这一条真的关上了**，不是"整个宿主
// 够不到"——物理可达集那一维是 S5 的 U13，断言不许声称够不到别处。
import { join } from 'node:path'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath, AgentId, RelPath } from '../terms.ts'
import type { ConfinedArgv } from './contract.ts'

/**
 * 本 agent 缓存目录（`cacheRoot(a)`）里的三块。**一处定义**：`confine` 的绑定源、命令面要建
 * 的目录、以及断言里读产物落在哪儿，读的都是它。
 */
export interface CacheLayout {
  /** 子进程的 `HOME`：本 agent 的缓存目录就是它的家。 */
  readonly home: AbsPath
  /** 子进程的 `XDG_CACHE_HOME`。 */
  readonly xdgCache: AbsPath
  /** 一个声明目录的绑定源：`<cacheRoot(a)>/<rel>`（架构 § 8.6 第 2 步那一条逐字）。 */
  readonly bound: (rel: RelPath) => AbsPath
}

export function cacheLayoutOf(roots: Roots, a: AgentId): CacheLayout {
  const cache = roots.cacheRoot(a)
  return { home: cache, xdgCache: join(cache, 'xdg-cache'), bound: (rel: RelPath) => join(cache, rel) }
}

export interface ConfineInput {
  readonly roots: Roots
  readonly agent: AgentId
  /** 子进程要跑的那个命令行。 */
  readonly argv: readonly string[]
  /** 视图内的相对路径：沙箱里子进程的当前目录（`--chdir` 的落点）。 */
  readonly cwd: RelPath
  /** 声明目录。每一个都要先是一个存在的挂载点：源在本 agent 的缓存里，**不回写视图**。 */
  readonly declared: readonly RelPath[]
  /** 子进程的环境，`binding.ts` 一处给。 */
  readonly env: Readonly<Record<string, string>>
  /** 树可写那一档（X4 的退化档）。默认 false = 只读绑定，那是 S4 的默认档。 */
  readonly treeWritable?: boolean
}

export function confine(i: ConfineInput): ConfinedArgv {
  const merged = i.roots.mergedRoot(i.agent)
  const temp = i.roots.tempRoot(i.agent)
  const cache = cacheLayoutOf(i.roots, i.agent)
  const writable = i.treeWritable === true

  const argv: string[] = ['bwrap', '--ro-bind', '/', '/', '--die-with-parent', '--dev', '/dev']
  // 两处按 agent 的可写落点：temp 与整个缓存（家 · XDG · 声明目录的源都在缓存底下）。
  argv.push('--bind', temp, temp)
  argv.push('--bind', cache.home, cache.home)
  // **树那一条必须排在声明目录之前。** 挂载是按顺序落上去的：反过来的话，整棵树那一条会把
  // 声明目录那几条盖掉，产物写下去就是 `Read-only file system`（这一条是实测撞出来的）。
  argv.push(writable ? '--bind' : '--ro-bind', merged, merged)
  for (const rel of i.declared) argv.push('--bind', cache.bound(rel), join(merged, rel))
  for (const [k, v] of Object.entries(i.env)) argv.push('--setenv', k, v)
  argv.push('--chdir', join(merged, i.cwd))
  argv.push('--', ...i.argv)

  return {
    argv,
    mechanism: 'bwrap',
    mode: writable ? 'workspace-write' : 'read-only',
    enforcement: 'full',
  }
}
