// S5 的"怎么包"：把一次执行包成一个 `ConfinedArgv`（架构 § 8.8 的 `M7.confine()`；Y3 从
// `src/execute/` 搬进来——S4 那句"暂居"到这里收）。
//
// 骨架**逐条照实测**（`tools/probe-exec.ts` · 架构 § 8.6 · S5 站前那次探针 `f9ff1b7`）：
//
//   bwrap --die-with-parent
//         --ro-bind <每一条只读根> …  --symlink <四条> …  --dev /dev  --proc /proc
//         --unshare-net（缺省；动作点名要网才不加）  --unshare-pid
//         --bind <temp> /tmp  --bind <cache> /cache
//         --ro-bind <merged> /work                            ← 树只读；树可写那一档换 `--bind`
//         --tmpfs /work/.fugue --remount-ro /work/.fugue       ← 树里那块挖掉（空且只读）
//         --bind <cache>/<声明目录> /work/<声明目录>            ← 每个声明目录一条
//         --ro-bind <包装器> /.fugue/landlock-exec             ← 第二层（Y6；只在它到场时）
//         --remount-ro /
//         --setenv <k> <v> …  --chdir /work/<cwd>
//         -- <包装器> --rw <可写落点>… -- <argv…>               ← 两层叠在一起时中间多这一截
//
// **第二层叠在里面**（Y6）：挂载层把包装器只读挂进沙箱的 `/.fugue/landlock-exec`，argv 里那一截
// 就是它。**点名字挂是有意的**：`ls /` 那份读数（Y3 量过的十二条）一个字节不变，`ls -a /` 才
// 多出它（实测两条都取过）。包装器自己不认策略——可写集由 `landlock.ts` 的 `writableFor(policy)`
// 推出来，坐标跟着档走，两档各给各的。
//
// **五样缺一不可，都是实测撞出来的**：`--dev /dev`（只 `--ro-bind / /` 时 `/dev/null` 写不动）·
// 按 agent 的 temp 的 `--bind`（只重写 `TMPDIR` 不够——`Cannot create temporary file in ./`）·
// 挂载点必须**先存在**（`bwrap: Can't chdir to --bind: No such file or directory`；由 `M4.ensure`
// 在卸载态预建，§ 8.6 第 1 步）· 声明目录的**绑定源**也必须先存在（`Can't find source path …`：
// 缓存那一侧由命令面建）· 以及树那一条必须排在声明目录之前（反过来整棵树会把声明目录盖掉，
// 写下去是 `Read-only file system`）。
//
// **可达集那一维在这里落地**（Y3）：子进程够得着的宿主路径 = `policy.reach` 列的那几条 + 树自己。
// 没点名的一律不在——所以漏一条的形态是**当场起不来**，不是静默漏。两条实测文案就是 Y3 的负对照：
// 缺 `/lib64` → `bwrap: execvp /usr/bin/echo: No such file or directory`；缺 `/etc/alternatives`
// → `bwrap: execvp cc: No such file or directory`。
//
// **进程表也算宿主的一部分**：不隔离时 `/proc` 里看得到宿主的进程（实测 11 个数字条目），
// `--unshare-pid` 之后只剩它自己那几个（4 个），而子进程是 PID 2（bwrap 当 PID 1 收尸），信号
// 语义照旧。`hostname` 那一档**没开**：要关它是 `--unshare-uts --hostname <名字>`（单独给
// `--hostname` 会被 bwrap 拒：`Specifying --hostname requires --unshare-uts`）；`--unshare-all`
// 也没开——它顺手带走 IPC 与 UTS，比这一站要的多。这两条读数记在提交信息的疑点清单里。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Roots } from '../roots/contract.ts'
import type { AgentId, RelPath } from '../terms.ts'
import type { ConfinedArgv } from '../execute/contract.ts'
import { deviceFiles, helperPath, LANDLOCK_SANDBOX_PATH, landlockArgv, writableFor } from './landlock.ts'
import type { Policy } from './policy.ts'
import { cacheLayoutOf } from '../roots/coords.ts'

/**
 * `XDG_DIR` / `cacheLayoutOf`（本 agent 缓存的三块布局）已下沉 `roots/coords.ts`（U2）——
 * 它们是纯布局计算，内核的回收那一侧也要读；住在 boundary 会让内核上仰边界。
 */

/**
 * **`bwrap` 在不在（§ 15.7 的 E4）：每次现探，不进那份平台事实的缓存。**
 *
 * 缓存（`materialize/capability.ts` 的 `ensureFacts`）是为"挂一次试试"那类**贵**探针定的：
 * `overlayfs` 探一次要真挂一次再卸掉，而它的答案在一台机器上基本不变（§ 8.5 的"探针 + 缓存"）。
 * E4 这条正相反：探一次只是一次 `spawn`，而它的答案会随机器变——`bwrap` 被删、PATH 被换、
 * 换了一门命名空间。**读一份过期的"在"，代价是这一趟直接跑不起来**（X4 的④读到过：退出码 1、
 * stderr 一个字不说，而 `run/confined` 照旧报 `enforcement: 'full'`——§ 15.7 要求"如实报告，
 * 绝不夸大"，那份过期的缓存正好把它变成一句夸大）。
 *
 * 判据是**在 PATH 里找得到、跑得起来**，不是文件存在：与 `overlayfs` 真挂一次同一条道理——
 * 光看它在，说明不了它在这门命名空间里起不起得来。
 */
export function probeBwrap(): { ok: boolean; note: string } {
  const r = spawnSync('bwrap', ['--version'], { encoding: 'utf8' })
  if (r.error !== undefined && r.error !== null) {
    return { ok: false, note: `PATH 里起不来 bwrap：${String((r.error as Error).message)}` }
  }
  if (r.status !== 0) {
    return { ok: false, note: `bwrap --version 退 ${r.status ?? '?'}：${(r.stderr ?? '').trim()}` }
  }
  return { ok: true, note: `${(r.stdout ?? '').trim()}（user namespace 与 mount 围栏都在）` }
}

/** 退化档要的那两样：包的是哪一份可写集（策略值），包装器落在哪个工作区（`roots`）。 */
export interface Unmounted {
  readonly roots: Roots
  readonly policy: Policy
}

/**
 * 退化档的"怎么包"：**没有挂载层可包**（§ 15.7 的 E4）——命令行前面那一层不是 `bwrap` 了。
 *
 * **第二层在场时它接过来**（Y6）：`<realRoot>/.fugue/bin/landlock-exec --rw … -- <原命令行>`，
 * `mechanism` 记 `landlock`，两栏照抄策略值。两层都不在时**命令行就是它自己**，三样如实报：
 * `mechanism: 'none'` · `mode: 'workspace-write'`（树可写）· `enforcement: 'partial'`。
 *
 * **不给 `land` 就是两层都不套**——X4 那条负对照（"把沙箱那一层拆掉"）走的正是这条路：它问的
 * 是"没有这一层会怎样"，所以这里不能替它把第二层套上。
 *
 * **子进程的 cwd 不在这里**：挂载档由 `--chdir` 落，这一档由 `M5` 的 `spawn({ cwd })` 落
 * （`RunSpec.cwd` 翻成物理路径那一步，架构 § 8.6 那一栏的注）。
 *
 * **声明目录在这一档里没有绑定**：产物落在树自己那一侧，回收读的是树（见 `reclaim.ts` 的落点
 * 那一段）。预建的挂载点照样要——`cc -o dist/app` 要那个目录先在（架构 § 8.6 第 1 步）。
 */
export function degradedArgv(argv: readonly string[], land?: Unmounted): ConfinedArgv {
  if (land === undefined || !land.policy.layers.includes('landlock')) {
    return { argv: [...argv], mechanism: 'none', mode: 'workspace-write', enforcement: 'partial' }
  }
  return {
    argv: landlockArgv(helperPath(land.roots), writableFor(land.policy), argv),
    mechanism: 'landlock',
    mode: land.policy.mode,
    enforcement: land.policy.enforcement,
  }
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
  /** 子进程的环境，`binding.ts` 一处给（坐标也从这一份策略值来）。 */
  readonly env: Readonly<Record<string, string>>
  /**
   * 这一趟的策略值（架构 § 8.8）：`M7` 只读它——树可写与否看 `mode` · 网络看 `net` ·
   * **够得着的宿主路径看 `reach`** · 沙箱里的坐标看 `coords` · **第二层在不在场看 `layers`**。
   * 一处解析（`resolvePolicy`），命令行与日志两处读的是同一份；这里不另算一遍。
   */
  readonly policy: Policy
}

export function confine(i: ConfineInput): ConfinedArgv {
  const c = i.policy.coords
  const reach = i.policy.reach
  const merged = i.roots.mergedRoot(i.agent)
  const temp = i.roots.tempRoot(i.agent)
  const cache = cacheLayoutOf(i.roots, i.agent)
  const writable = i.policy.mode === 'workspace-write'
  // 第二层在不在场：在的话把包装器挂进来、argv 末尾那一截就是它（见文件头）。
  const land = i.policy.layers.includes('landlock')

  const argv: string[] = ['bwrap', '--die-with-parent']
  // **只读清单逐条挂进来**：一份真构建在树外碰过的那些路径（`/usr` · `/opt` · `/etc` 的三条）。
  for (const p of reach.roRoots) argv.push('--ro-bind', p, p)
  // 只读根之外还必须存在的软链：`/bin` → `usr/bin` 那一类。
  for (const s of reach.symlinks) argv.push('--symlink', s.to, s.at)
  // 设备与进程那两条各有一条专门的挂载：`--ro-bind` 挂不出一个新的 devtmpfs / procfs。
  for (const d of reach.devices) argv.push(d === '/proc' ? '--proc' : '--dev', d)
  // 网络那一档：缺省把它切掉（架构 § 8.8 的 `net`）——要网的动作在配置里点名，不是在这里加开关。
  if (i.policy.net === 'none') argv.push('--unshare-net')
  // 进程表也是宿主：`/proc` 里的那些数字条目不进子进程的可达集。
  argv.push('--unshare-pid')
  // 两处可写落点按坐标挂：temp 挂 `/tmp`、整个缓存（家 · XDG · 声明目录的源）挂 `/cache`。
  argv.push('--bind', temp, c.tmp)
  argv.push('--bind', cache.home, c.home)
  // **树那一条必须排在声明目录之前。** 挂载是按顺序落上去的：反过来的话，整棵树那一条会把
  // 声明目录那几条盖掉，产物写下去就是 `Read-only file system`（这一条是实测撞出来的）。
  argv.push(writable ? '--bind' : '--ro-bind', merged, c.tree)
  // 树里挖掉那几块：**空且只读**。只 `--tmpfs` 的话那里写得进去，而"树只读"这句话就多出一个
  // 例外（实测：加上 `--remount-ro` 之后写它是 `Read-only file system`，宿主上一丝痕迹没有）。
  //
  // **树里没有那一条就不挖。** `--tmpfs` 要在那棵只读的树上自己建挂载点，建不出来就是
  // `bwrap: Can't mkdir /work/.fugue: Read-only file system`（2026-09-26 实测）。这一条从此
  // 是常态：`fork` 把 `WORKSPACE_STATE` 从**三档的合并视图**里遮掉了（`fork.ts` 的
  // `maskWorkspaceState`），`.fugue` 在 `merged` 里本来就不在——挖的是"底下真有那一支"的情况。
  // 挖与不挖两种情形下，`@work/.fugue/...` 那几条一律读不到东西（不在了 · 或者空且只读）。
  for (const m of reach.mask) {
    if (!existsSync(join(merged, m))) continue
    const at = join(c.tree, m)
    argv.push('--tmpfs', at, '--remount-ro', at)
  }
  for (const rel of i.declared) argv.push('--bind', cache.bound(rel), join(c.tree, rel))
  // 第二层那个包装器：**只读挂进来**（它是这一层自己的实现，不是孩子够得着的东西）。它必须排在
  // 根 remount 之前——反了的话 bwrap 在只读的根上建不出挂载点。
  // **第二层的可写集 = 上面真挂成可写的那几处**（一处一处数出来的，不是另算一遍）：坐标那两条
  // （temp 与家/缓存）· 树自己（只在树可写那一档）· 每个声明目录 · 以及那几条设备（不含它们
  // 任何一次重定向都翻车）。两层的可写面因此逐条对齐——错位的那一半是静默的。
  const rw = [
    ...new Set<string>([
      c.tmp,
      c.home,
      ...(writable ? [c.tree] : []),
      ...i.declared.map((rel) => join(c.tree, rel)),
      ...deviceFiles(),
    ]),
  ]
  // 包装器自己：**只读挂进来**（它是这一层自己的实现，不是孩子够得着的东西）。它必须排在
  // 根 remount 之前——反了的话 bwrap 在只读的根上建不出挂载点。
  if (land) argv.push('--ro-bind', helperPath(i.roots), LANDLOCK_SANDBOX_PATH)
  // **根自己也要只读，这一条排在所有挂载之后。** bwrap 的新根是一份 tmpfs：没挂进来的那些顶层
  // 路径（`/` 自己，以及为 `/etc/ld.so.cache` 那样一条被建出来的 `/etc`）就住在它上面，不
  // remount 成 ro 的话它们是**写得进去的**——"没点名的一律不在"会多出一个静默的例外（实测：
  // 不 remount 时 `/etc/x` 写成功，落在沙箱自己那份 tmpfs 上，宿主上看不见；remount 之后是
  // `Read-only file system`，与写树里那几处同一个 errno）。排在这一步：反了的话 bwrap 在只读的
  // 根上建不出挂载点。
  argv.push('--remount-ro', '/')
  for (const [k, v] of Object.entries(i.env)) argv.push('--setenv', k, v)
  argv.push('--chdir', join(c.tree, i.cwd))
  // **两层叠在一起**：第二层在里面——它先把自己关进规则集，再 `exec` 原命令行。
  argv.push('--', ...(land ? landlockArgv(LANDLOCK_SANDBOX_PATH, rw, i.argv) : i.argv))

  // **两栏照抄策略值**：`confine()` 不自己判断这是哪一档，它只负责把那一档包出来——`fugue policy`
  // 与 `run/confined` 报的因此是同一个来源。调用方给一份不带 `bwrap` 的策略值就是调用方的错
  // （命令行那一面从不那样做：没有挂载层时它走 `degradedArgv()`）。
  return {
    argv,
    mechanism: 'bwrap',
    mode: i.policy.mode,
    enforcement: i.policy.enforcement,
  }
}
