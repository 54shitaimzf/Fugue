// 启动时的一致性检查（架构 § 8.8 那句 fail-closed · § 20 S5 第二条验证的另一半 ·
// PLAN § 5.5 的 Y4 行）。
//
// **为什么要有它**：几条"落不到策略里"的情形，如果留到 bwrap 或物化那一层去撞，报出来的是别人的
// 话，而那句话指向的是错的地方——实测两条：
//   · 声明目录带 `..`：`cache: ["../x"]` 照跑，写下去的东西落在**树外**（实测宿主机上是
//     `<mat>/<round>/x/f.txt`，而"树"是 `merged`）；
//   · 清单里一条不存在的路径：`bwrap: Can't find source path /opt/没有这个: No such file or
//     directory`——它说的是"源找不到"，而真正要改的是工作区配置里 `boundary.reach` 那一栏。
// 判据是 **fail-closed**：查不过就**不启动**，不"先跑跑看"。
//
// **两处，一前一后，各管一段**（与架构 § 8.10 那条"权威判定在前、兜底在后"同一个口径）：
//   · `checkReach()` —— 启动前：声明的目录落不落在视图里 · 清单在宿主上成不成立 · 软链指不指得
//     进清单。它不碰工作区状态，所以排在物化之前——拒得越早，代价越小。
//   · `checkMountPoints()` —— 落地之后：树里那些挂载点是不是目录（bwrap 的一条目录绑定挂不到
//     一个文件上）。它要的是落地之后那棵树，所以只能排在后面。
//
// **挂载层不在场时不查清单**（声明那一条照查）：清单只被 `confine()` 读——它是那些 `--ro-bind`
// 条目的来源。没有挂载层时它不参与任何事，那时拒绝启动就是把地板调低（AGENTS § 五 的第一条：
// 任何单元都不许让地板变低）。所以 `--mode workspace-write` 那一档上，一份过期的清单**拦不住
// 这一趟**；Y6 起"只有第二层"那一档也一样——第二层一个字节的清单都不读。
//
// **声明那一条过的是 M3 那道围栏**（`Roots.resolveVirtual`）——与 `M6` 的 `declare()` 同一个
// 内核、同一个说法：绝对路径 · `..` 越界 · 穿过软链。这里只补一句"它写在哪一栏"，不另立一套判据。
import { existsSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Result, Roots } from '../roots/contract.ts'
import type { AbsPath, RelPath } from '../terms.ts'
import type { Policy } from './policy.ts'

/** 这一层自己的拒绝：**哪一条**落不到策略里 · 什么毛病 · 怎么改（架构 § 8.4 纪律 2 要求指路）。 */
export interface ReachDenied {
  readonly denied: true
  /** 被拒的那一条原文（哪一条声明 · 清单里的哪一项）。 */
  readonly at: string
  /** 机器可读的那半句：哪一类毛病。 */
  readonly kind: 'declared-outside' | 'missing-in-host' | 'symlink-target' | 'not-a-mount-point'
  /** 给人看的整句，含指路。 */
  readonly message: string
}

function refuse(kind: ReachDenied['kind'], at: string, message: string): ReachDenied {
  return { denied: true, kind, at, message }
}

/** 一条宿主路径在不在清单的覆盖范围里。**按段比**：`/usr` 盖 `/usr/bin`，不盖 `/usrx`。 */
function covered(path: string, roRoots: readonly string[]): boolean {
  return roRoots.some((r) => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`))
}

export interface ReachCheckInput {
  readonly roots: Roots
  readonly policy: Policy
  /** 动作声明的目录（`cache` ∪ `outputs`，`declaredDirs()` 收成最外层的那一份）。 */
  readonly declared: readonly RelPath[]
}

/**
 * 启动前那一半。**过了返回声明那一份（原样），没过返回哪一条不成立。**
 *
 * 检查的次序就是修的人要看的次序：先看自己写的声明，再看清单。
 */
export function checkReach(i: ReachCheckInput): Result<readonly RelPath[], ReachDenied> {
  for (const rel of i.declared) {
    const r = i.roots.resolveVirtual(rel, '')
    if (r.ok) continue
    return {
      ok: false,
      error: refuse(
        'declared-outside',
        rel,
        `动作声明的目录落不到视图里：${rel}\n` +
          `  ${r.error.message}\n` +
          `声明写在配置的 actions.<名字>.cache 与 .outputs 里，要的是**视图内的相对路径**（如 dist）。` +
          `要往工作区外写，改的是这个动作的声明，不是视图。`,
      ),
    }
  }

  // **挂载层不在场就不查清单**：上面那一条照查。清单只被 `confine()` 读（它是 `--ro-bind` 那些
  // 条目的来源），所以判据是"有没有挂载层"，不是"有没有层"——Y6 起第二层（Landlock）可以在挂载层
  // 不在时一个人撑着，而它一个字节的清单都不读。那时查清单就是把地板调低（见头注最后一段）。
  if (!i.policy.layers.includes('bwrap')) return { ok: true, value: [...i.declared] }

  const reach = i.policy.reach
  for (const p of reach.roRoots) {
    if (existsSync(p)) continue
    return {
      ok: false,
      error: refuse(
        'missing-in-host',
        p,
        `boundary.reach 里这一条在宿主上不存在：${p}\n` +
          `清单是**量出来的**（S5 站前的探针 f9ff1b7）：换机器、换工具链之后要跟着改，` +
          `比如 fugue config set boundary.reach '["/usr","/opt"]'。\n` +
          `不在这儿拦的话，这一趟报的是 bwrap 那句 "Can't find source path ${p}"——` +
          `它说的是"源找不到"，而真正要改的是这一栏。`,
      ),
    }
  }
  for (const d of reach.devices) {
    if (existsSync(d)) continue
    return {
      ok: false,
      error: refuse(
        'missing-in-host',
        d,
        `清单里的设备与进程在宿主上不存在：${d}\n` +
          `这一栏是形状（人改不了它，改的是 boundary.reach 那份只读根）：换了一门命名空间就把它一起去掉。`,
      ),
    }
  }
  for (const s of reach.symlinks) {
    const target = resolve('/', s.to)
    if (covered(target, reach.roRoots) || reach.devices.includes(target)) continue
    return {
      ok: false,
      error: refuse(
        'symlink-target',
        `${s.at} → ${s.to}`,
        `清单里这条软链指不到清单里去：${s.at} → ${target}\n` +
          `软链的靶子必须落在只读根里（或在设备与进程那两条里）——它不在，沙箱里那个名字就是一条悬空的链子。` +
          `把 ${target} 那一处并进 boundary.reach，或者去掉这条软链。`,
      ),
    }
  }
  for (const m of reach.mask) {
    const r = i.roots.resolveVirtual(m, '')
    if (r.ok) continue
    return {
      ok: false,
      error: refuse(
        'declared-outside',
        m,
        `树里要挖掉的那一条不是视图内的相对路径：${m}\n  ${r.error.message}\n` +
          `这一栏是形状（人改不了它）：挖的是树里的一支，写的就是相对树根的那一段（如 .fugue）。`,
      ),
    }
  }
  return { ok: true, value: [...i.declared] }
}

/**
 * 落地之后那一半：**声明目录在树里的位置上必须是一个目录**——bwrap 的一条目录绑定挂不到一个
 * 文件上。它从命令面搬进来（Y4），判据一个字没改。
 */
export function checkMountPoints(
  merged: AbsPath,
  declared: readonly RelPath[],
): Result<readonly RelPath[], ReachDenied> {
  for (const rel of declared) {
    const st = lstatSync(join(merged, rel), { throwIfNoEntry: false })
    if (st === undefined || st === null || st.isDirectory()) continue
    return {
      ok: false,
      error: refuse(
        'not-a-mount-point',
        rel,
        `声明的目录在树里不是一个目录：${rel}（${join(merged, rel)}）\n` +
          `一条声明要么自己是一条目录（不存在就预建），要么写成已经被另一条声明盖住的那条路径` +
          `（如 cache:["dist"] + outputs:["dist/app"]）。`,
      ),
    }
  }
  return { ok: true, value: [...declared] }
}
