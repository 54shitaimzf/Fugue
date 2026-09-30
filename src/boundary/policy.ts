// 策略值：一处解析，两处读（架构 § 8.8 · PLAN § 5.5 的 Y2 与 Y6 两行）。
//
// 一份 `Policy`，两个强制点（虚拟围栏 · OS 沙箱）。它同时是**命令行那一面**与**日志那一面**
// 读的同一份东西：`fugue policy` 把它印出来，`fugue run` 把它写进 `run/confined` 事件。
// 两处各读一次，报出来的必须是同一份值——**"如实报告"的机制就是这一句**：不是两处各自算
// 一遍再对答案，而是只有一处算。
//
// **要求与供给分开**（架构 § 15.7 的对接点）：
//   · `net` 是**要求**：缺省 `none`（`--unshare-net` 把网切掉），动作在配置里点 `"net": "host"`
//     才开——有网的动作等于把工作区接到外面，那必须是一次有人签过字的选择；
//   · `layers` 是**供给**：这一趟在场的是哪几层，**现探**（§ 15.7 的 E4 · E5）。
// 供给跟不上要求时如实降，一个字都不夸大。
//
// **两层**（Y6 起）：挂载层（`bwrap`）管"看得见什么"——清单里没点名的一律不在；第二层
// （Landlock）管"写得动什么"——没声明的一律写不动，内核当场拒。两层的在场与否都现探，
// `layers` 里如实列出来。**`enforcement` 的判据是"这一档承诺的那几道围栏关上了没有"**：
// 两层都在场才是 `full`（§ 15.7 的 E5：少一层纵深，如实降一档）。
//
// **`mode` 报的是事实，不是要求**：挂载层在场时它给得出两档里要的那一档；挂载层不在时由第二层
// 说了算——它管着写那一维，所以缺省档（`read-only`）在那里的意思是"树不可写"，而
// `--mode workspace-write` 是**有人点名**要树可写（那一档它把整棵树开出来）。两层都不在时才
// 落回 § 15.7 的 E4：树可写是那一档的事实。
import { join } from 'node:path'
import { getConfig } from '../config.ts'
import type { ConfigDoc } from '../config.ts'
import { declaredDirs, readEnvSpec, type ActionBinding, type EnvSpec } from './binding.ts'
import { probeBwrap } from './confine.ts'
import { cacheLayoutOf } from '../roots/coords.ts'
import { probeLandlock } from './landlock.ts'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath, AgentId, Enforcement, NetMode, PolicyLayer, PolicyMode } from '../terms.ts'
import { PolicyError, readReach, SANDBOX_COORDS, type Coords, type ReachSpec } from './reach.ts'

export { PolicyError } from './reach.ts'

export interface Policy {
  readonly mode: PolicyMode
  readonly writableRoots: readonly AbsPath[]
  readonly enforcement: Enforcement
  readonly reach: ReachSpec
  /**
   * **子进程那一侧的坐标**（树 · 家与缓存 · temp）：`confine()` 的 argv 与 `envFor()` 的那几个
   * 变量读的都是它，一处定下来。它是**这一档的事实**——有挂载层在场就是沙箱里的三条（`/work`
   * `/cache` `/tmp`），挂载层不在时子进程就在宿主上跑，坐标照实写宿主那三条。
   */
  readonly coords: Coords
  readonly net: NetMode
  readonly layers: readonly PolicyLayer[]
  /**
   * 子进程环境的基线与注入（`boundary.env` 四键，计划 § 5.20 的 P1a）：`envFor()` 读的是它。
   * 宿主环境从此不再整份照抄——`inherit: 'all'` 是退化档，与从前的行为逐字节相同。
   */
  readonly env: EnvSpec
}

/** 现探出来的那几层，外加一句"为什么不在"——降级与拒绝的话都从这一句来。 */
export interface LayersProbe {
  readonly layers: readonly PolicyLayer[]
  readonly note: string
}

/**
 * 这一趟在场的是哪几层。**每次现探，不进那份平台事实的缓存**——读一份过期的"在"，代价是
 * 这一趟直接跑不起来（X4 的④读到过：退 1、stderr 一个字不说，而 `run/confined` 照旧报 `full`）。
 *
 * 两层的探法都是"真跑一次"：`bwrap` 起一次 `--version`；Landlock 那边走系统调用探 ABI
 * （包装器 `--probe`，见 `landlock.ts`——`cc` 编不出来时这一层如实缺，原话进 `note`）。
 */
export function probeLayers(roots: Roots): LayersProbe {
  const bw = probeBwrap()
  const ll = probeLandlock(roots)
  const layers: readonly PolicyLayer[] = [
    ...(bw.ok ? (['bwrap'] as const) : []),
    ...(ll.ok ? (['landlock'] as const) : []),
  ]
  const notes = [bw.ok ? '' : bw.note, ll.ok ? '' : ll.note].filter((s) => s !== '')
  return { layers, note: notes.join(' · ') }
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

/** 工作区配置里期望档那一个键（P1c，计划 § 5.20）。 */
export const ENFORCEMENT_KEY = 'boundary.enforcement'

/**
 * **期望档**（`boundary.enforcement`）：人声明"这一趟要 `full`"——实测层不齐就起跑前拒，
 * 指两条出路（补层 · 把声明改 `partial`）。不声明 = 今天的行为（照跑，如实报实测那一档）；
 * 声明 `partial` 也收：那是把"我知道在降档"写下来，读数与不声明相同。
 */
function wantedEnforcement(doc: ConfigDoc): Enforcement | undefined {
  const v = getConfig(doc, ENFORCEMENT_KEY)
  if (v === undefined) return undefined
  if (v !== 'full' && v !== 'partial') {
    throw new PolicyError(`${ENFORCEMENT_KEY} 取 "full" 或 "partial"：${JSON.stringify(v)}`)
  }
  return v
}

/**
 * 一处解析：`fugue policy` 与 `fugue run` 读的都是它，两处不各自算一遍。
 *
 * 三栏的算法各自一句话：
 *   · `layers`：**两层各管一维，与档正交**——挂载层管"子进程看得见什么"（`workspace-write` 那一档
 *     把树整个绑成可写，树以外照旧一条都不在），第二层管"写得动什么"。两档都上（由头见
 *     `resolvePolicy` 里那一处）。
 *   · `mode`：见文件头——挂着的是事实。
 *   · `enforcement`：两层都在场才是 `full`。
 */
export function resolvePolicy(i: PolicyInput): Policy {
  const wanted: PolicyMode = i.mode ?? 'read-only'
  const probed = i.probed ?? probeLayers(i.roots)
  // **挂载层与档无关**：它管的是"子进程看得见什么"，而"树可不可写"只是 `--bind` 与 `--ro-bind`
  // 那一字的差别——`confine()` 两档都包得出来（树那一条按档选）。旧口径（"`workspace-write` 用
  // 不上挂载层"）在 `confine()` 长出可写树之后就只剩一个后果：真档那一趟的 `bash` 在宿主上裸跑。
  // 第十五趟样本盘量到过它——`case-1-1` 那一格读到了 `/tmp/scenario-b14/...` 下这一趟的验收
  // 结果与请求实录，于是"它自己解出来的"这句话就不再是一条证据。
  const mount = probed.layers.includes('bwrap')
  const land = probed.layers.includes('landlock')
  const layers: readonly PolicyLayer[] = [
    ...(mount ? (['bwrap'] as const) : []),
    ...(land ? (['landlock'] as const) : []),
  ]
  const fenced = mount
  const cache = cacheLayoutOf(i.roots, i.agent)
  // **坐标跟着档走**：有挂载层在场就是沙箱里那三条；没有时子进程就在宿主上跑，坐标照实写
  // 宿主那三条——两档各是各的事实，而 `envFor()` 与 `confine()` 读的是同一份。
  const coords: Coords = fenced
    ? SANDBOX_COORDS
    : { tree: i.roots.mergedRoot(i.agent), home: cache.home, tmp: i.roots.tempRoot(i.agent) }
  // **档是事实**：挂载层在场时它给的是命令行要的那一档（`read-only` 档把树绑成只读、
  // `workspace-write` 档把它绑成可写）；挂载层不在时，第二层在就由它说了算——它管着写那一维，
  // 所以"缺省档"意味着树不可写；两层都不在才是 E4 那一档（树可写）。
  const mode: PolicyMode = fenced ? wanted : land ? wanted : 'workspace-write'
  // 可写落点 = **挂进树里的那几处**：`declaredDirs` 把嵌套的收成最外层（挂的永远是目录那一级，
  // 架构 § 8.6 第 1 步那句"挂载点必须是一个目录"）。Y6 起这一份与第二层的规则集是**同一份**——
  // 包装器按它开可写口子，多一条少一条都是静默的错位。`dist/app` 那一类产出声明是"落在声明目录
  // 里的路径"，跑之前它根本不存在：给它单开一条规则只会落一句"这一条不在，没给它开口子"。
  const declared = i.binding === undefined ? [] : declaredDirs(i.binding)
  // **两层都在场才是 full**（§ 15.7 的 E5）。少一层就少一维：只有挂载层时"写"那一维靠的是
  // 挂载（第二层缺席），只有第二层时"看得见什么"那一维没有围栏。
  const enforcement: Enforcement = fenced && land ? 'full' : 'partial'
  // **期望档对照**（P1c，计划 § 5.20）：声明了 `full` 而实测层不齐，是策略被架空——不是给人
  // 选的档，起跑前拒，指两条出路。不声明 = 照跑照实报（今天的行为）。
  const enforcementWanted = wantedEnforcement(i.doc)
  if (enforcementWanted === 'full' && enforcement !== 'full') {
    throw new PolicyError(
      `声明了 ${ENFORCEMENT_KEY}: "full"，而这一趟实测在场的层是` +
        `${layers.length === 0 ? '一层都不在' : layers.join(' + ')}（enforcement 实测 ${enforcement}）。\n` +
        `两条出路：把层补齐（${probed.note}）；或把声明改 partial，如实跑降档（fugue config set ${ENFORCEMENT_KEY} '"partial"'）。`,
    )
  }
  return {
    mode,
    // 可写落点按**子进程那一侧的坐标**写：沙箱档是 `/cache` `/tmp` `/work/<声明目录>`，
    // 退化档就是宿主那三条（声明目录在那一档里落在树自己那一侧）。
    writableRoots: [
      ...new Set<AbsPath>([coords.home, coords.tmp, ...declared.map((rel) => join(coords.tree, rel))]),
    ],
    enforcement,
    reach: readReach(i.doc),
    env: readEnvSpec(i.doc),
    coords,
    // 网只有挂载层拿得走（第二层没有网络那几条规则）：它不在场时如实报 `host`。
    net: fenced ? (i.binding?.net ?? 'none') : 'host',
    layers,
  }
}
