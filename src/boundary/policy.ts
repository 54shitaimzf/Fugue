// 策略值：一处解析，两处读（架构 § 8.8 · PLAN § 5.5 的 Y2 行）。
//
// 一份 `Policy`，两个强制点（虚拟围栏 · OS 沙箱）。它同时是**命令行那一面**与**日志那一面**
// 读的同一份东西：`fugue policy` 把它印出来，`fugue run` 把它写进 `run/confined` 事件。
// 两处各读一次，报出来的必须是同一份值——**"如实报告"的机制就是这一句**：不是两处各自算
// 一遍再对答案，而是只有一处算。
//
// **要求与供给分开**（架构 § 15.7 的对接点）：
//   · `net` 是**要求**：缺省 `none`（`--unshare-net` 把网切掉），动作在配置里点 `"net": "host"`
//     才开——有网的动作等于把工作区接到外面，那必须是一次有人签过字的选择；
//   · `layers` 是**供给**：这一趟在场的是哪几层，**现探**（§ 15.7 的 E4）。
// 供给跟不上要求时三栏一起如实降：`mode` 记 `workspace-write`（树可写是那一档的事实）·
// `enforcement` 记 `partial` · `net` 记 `host`（没有哪一层能把它拿走）。**一个字都不夸大。**
//
// 今天只有一层（`bwrap`）。第二层（Landlock，Y6）进来时往 `layers` 里加一项就够——`full` 与
// `partial` 的判据（"这一档承诺的那几道围栏关上了没有"）不用改。
import type { ConfigDoc } from '../config.ts'
import type { ActionBinding } from '../execute/binding.ts'
import { cacheLayoutOf, probeBwrap } from '../execute/confine.ts'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath, AgentId, Enforcement, NetMode, PolicyLayer, PolicyMode } from '../terms.ts'
import { readReach, type ReachSpec } from './reach.ts'

export { PolicyError } from './reach.ts'

export interface Policy {
  readonly mode: PolicyMode
  readonly writableRoots: readonly AbsPath[]
  readonly enforcement: Enforcement
  readonly reach: ReachSpec
  readonly net: NetMode
  readonly layers: readonly PolicyLayer[]
}

/** 现探出来的那几层，外加一句"为什么不在"——降级与拒绝的话都从这一句来。 */
export interface LayersProbe {
  readonly layers: readonly PolicyLayer[]
  readonly note: string
}

/**
 * 这一趟在场的是哪几层。**每次现探，不进那份平台事实的缓存**——读一份过期的"在"，代价是
 * 这一趟直接跑不起来（X4 的④读到过：退 1、stderr 一个字不说，而 `run/confined` 照旧报 `full`）。
 */
export function probeLayers(): LayersProbe {
  const bw = probeBwrap()
  return bw.ok ? { layers: ['bwrap'], note: bw.note } : { layers: [], note: bw.note }
}

export interface PolicyInput {
  readonly roots: Roots
  readonly agent: AgentId
  /** 工作区配置（架构 § 15.3.a）：可达集清单从它来，动作那一栏也从它来。 */
  readonly doc: ConfigDoc
  /** 命令行上那一档；不给就是架构 § 8.8 的缺省档 `read-only`。 */
  readonly mode?: PolicyMode
  /** 这一趟要跑的动作。给了才能读它的 `net` 那一栏——**没有动作就没有要求**。 */
  readonly binding?: ActionBinding
  /** 这一趟探到的层。不给就现探一次；两处读同一份的调用方传自己那一份，省一次 spawn。 */
  readonly probed?: LayersProbe
}

/** 一处解析：`fugue policy` 与 `fugue run` 读的都是它，两处不各自算一遍。 */
export function resolvePolicy(i: PolicyInput): Policy {
  const wanted: PolicyMode = i.mode ?? 'read-only'
  const probed = i.probed ?? probeLayers()
  // `workspace-write` 档（X4 的退化档）今天不用挂载围栏那一层——树可写正是那一档的事实。
  const layers: readonly PolicyLayer[] = wanted === 'read-only' ? probed.layers : []
  const fenced = layers.length > 0
  const cache = cacheLayoutOf(i.roots, i.agent)
  const declared = [...(i.binding?.cache ?? []), ...(i.binding?.outputs ?? [])]
  return {
    mode: fenced ? wanted : 'workspace-write',
    writableRoots: [
      ...new Set<AbsPath>([cache.home, i.roots.tempRoot(i.agent), ...declared.map((rel) => cache.bound(rel))]),
    ],
    enforcement: fenced ? 'full' : 'partial',
    reach: readReach(i.doc),
    net: fenced ? (i.binding?.net ?? 'none') : 'host',
    layers,
  }
}
