// 动作绑定：工作区配置里的 `actions.<名字>`（架构 § 15.3.a 那一句话的落地）。
//
// **它是这一站唯一一处新接口，也是人唯一要手写的东西。** 形状按设计预期批过（PLAN § 5.4 尾）：
//
//   actions.<名字> = { argv: [...] · cwd?: <视图内路径> · outputs?: [...] · cache?: [...] · env?: {} }
//
// `outputs`（回写视图的产出，X2 的回收读它）与 `cache`（绑到本 agent 的缓存、不回写，构建产物
// 落这里）分开，是这一处唯一要紧的取舍：架构 § 8.7 明说构建产物**不回收**，而 `run_action`
// 的产出要回收，两者靠"声明在哪个键里"分开，比在运行模式里加开关干净。
//
// **本 agent 的坐标也在这里给**（架构 § 8.6 那张表的头三行）：`HOME` / `XDG_CACHE_HOME` 落在
// `cacheRoot(a)` 里、`TMPDIR` 落在 `tempRoot(a)` 里、端口从池里切一片给自己的 agent。**另一样
// 是照旧递进去的**：宿主环境不清洗（凭据那一类在 S5 的 `Policy` 与 S6 的 `envRealize` 手里），
// 这一站只保证表里这几项在子进程里是本 agent 的坐标。
import type { ConfigDoc } from '../config.ts'
import { getConfig } from '../config.ts'
import type { Roots } from '../roots/contract.ts'
import type { ActionName, AgentId } from '../terms.ts'
import { cacheLayoutOf } from './confine.ts'

/** 这一层自己的失败：配置里的动作绑定不成立。**拒绝并指路**，与围栏同一个口径。 */
export class BindingError extends Error {}

export interface ActionBinding {
  readonly name: ActionName
  readonly argv: readonly string[]
  /** 视图内的相对路径，缺省是视图的根（`''`）。 */
  readonly cwd: string
  /** 要回写视图的产出（X2 的回收读它；X1 只校验形状）。 */
  readonly outputs: readonly string[]
  /** 绑到本 agent 缓存的目录：构建产物落这里，**不回写**。 */
  readonly cache: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** 端口池那一个键。不给就用这个默认值——一个工作区开箱就有一片号。 */
export const PORTS_KEY = 'ports.range'
export const DEFAULT_PORTS = '31000-31099'
/** 每个 agent 在自己那一片里拿几个号：`PORT` 是第一个，`PORTS` 是整片（含两端）。 */
export const PORT_SLICE = 4

/**
 * 这几样是"本 agent 的坐标"，动作自己的 `env` 与 `-- k=v` 都不许盖。
 *
 * **撞上就拒绝**，不是静默忽略：把它们盖掉，隔离就成了一句空话，而"跑起来了"看起来一模一样。
 */
export const RESERVED: readonly string[] = ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'PATH', 'PORT', 'PORTS']

function asObject(v: unknown, what: string): ConfigDoc {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new BindingError(`${what} 要是一个对象`)
  }
  return v as ConfigDoc
}

function asStringArray(v: unknown, what: string, opts: { nonEmpty?: boolean } = {}): string[] {
  if (!Array.isArray(v)) throw new BindingError(`${what} 要是一个数组`)
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string' || x === '') throw new BindingError(`${what} 里每一项都要是一个非空字符串`)
    out.push(x)
  }
  if (opts.nonEmpty === true && out.length === 0) throw new BindingError(`${what} 不能是空的`)
  return out
}

/** 配置里现有的动作名（排过序）。拒绝的时候用它把路指出来。 */
export function actionNames(doc: ConfigDoc): string[] {
  const actions = getConfig(doc, 'actions')
  if (typeof actions !== 'object' || actions === null || Array.isArray(actions)) return []
  return Object.keys(actions).sort()
}

/** 读一个动作的绑定。**不在就拒绝并列出现有的名字**——不猜、不用缺省值顶上。 */
export function readBinding(doc: ConfigDoc, name: string): ActionBinding {
  const all = getConfig(doc, 'actions')
  const names = actionNames(doc)
  if (name === '') throw new BindingError('动作名不能是空的')
  if (all !== undefined && (typeof all !== 'object' || all === null || Array.isArray(all))) {
    throw new BindingError('配置里的 actions 要是一个对象：键是动作名，值是那个动作的绑定')
  }
  const raw = names.includes(name) ? asObject((all as ConfigDoc)[name], `动作 ${name}`) : undefined
  if (raw === undefined) {
    const have = names.length === 0 ? '现在一个都没有' : `现有的：${names.join(' · ')}`
    throw new BindingError(
      `配置里没有这个动作：${name}（${have}）\n` +
        `加一个：fugue config set actions.${name} '{"argv":["make"],"cache":["dist"]}'`,
    )
  }
  const argv = asStringArray(raw.argv, `动作 ${name} 的 argv`, { nonEmpty: true })
  const cwd = raw.cwd === undefined ? '' : raw.cwd
  if (typeof cwd !== 'string') throw new BindingError(`动作 ${name} 的 cwd 要是一个字符串`)
  const outputs = raw.outputs === undefined ? [] : asStringArray(raw.outputs, `动作 ${name} 的 outputs`)
  const cache = raw.cache === undefined ? [] : asStringArray(raw.cache, `动作 ${name} 的 cache`)
  const env: Record<string, string> = {}
  if (raw.env !== undefined) {
    for (const [k, v] of Object.entries(asObject(raw.env, `动作 ${name} 的 env`))) {
      if (typeof v !== 'string') throw new BindingError(`动作 ${name} 的 env.${k} 要是一个字符串`)
      env[k] = v
    }
  }
  assertNotReserved(Object.keys(env), `动作 ${name} 的 env`)
  return { name, argv, cwd, outputs, cache, env }
}

/**
 * 声明目录：**要挂进树里的那些**——`cache` 与 `outputs` 的并集，嵌套的收成最外层
 * （架构 § 8.6 第 1 步要的就是这一份）。
 *
 * **收成最外层不是省事，是必须。** `--bind <缓存>/dist <树>/dist` 那一条已经把 `dist` 下面
 * 的一切换成了缓存那一侧；再为 `dist/app` 挂一条的话，它的挂载点得先在树里是一个**空文件**
 * ——而空文件是叶子：它进清单、进差异集，`verify-mat` 当场就不等了。所以挂的永远是目录这一级，
 * `dist/app` 这样的声明是"落在缓存里的那条路径"（回收读它，见 `reclaim.ts`）。
 */
export function declaredDirs(binding: ActionBinding): string[] {
  const all = [...new Set([...binding.cache, ...binding.outputs])].sort()
  return all.filter((p) => !all.some((q) => q !== p && p.startsWith(`${q}/`)))
}

/** 本 agent 的坐标不许被盖。两处入口（动作的 `env` 与 `-- k=v`）都过它。 */
export function assertNotReserved(keys: readonly string[], where: string): void {
  const hit = keys.filter((k) => RESERVED.includes(k))
  if (hit.length > 0) {
    throw new BindingError(
      `${where} 里不能盖这几样：${hit.join(' · ')}\n` +
        `它们是本 agent 的坐标（${RESERVED.join(' · ')}），由 fugue 一处给——要改就改配置里的那一段，不是在命令行上盖`,
    )
  }
}

/** `-- k=v…`：注入子进程的环境变量。**没有 `=` 的那一段是用法错**，不当成空值收下。 */
export function parseInjections(rest: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of rest) {
    const eq = item.indexOf('=')
    if (eq <= 0) throw new BindingError(`-- 之后要的是 k=v：${JSON.stringify(item)}`)
    const k = item.slice(0, eq)
    out[k] = item.slice(eq + 1)
  }
  assertNotReserved(Object.keys(out), '-- 之后的注入')
  return out
}

/** 端口池：`ports.range` 那一个键，缺省 `DEFAULT_PORTS`。 */
export function portRangeOf(doc: ConfigDoc): string {
  const v = getConfig(doc, PORTS_KEY)
  if (v === undefined) return DEFAULT_PORTS
  if (typeof v !== 'string') throw new BindingError(`${PORTS_KEY} 要是一个字符串，如 ${DEFAULT_PORTS}`)
  return v
}

/**
 * 从池里切一片给第 `index` 个 agent。**每个 agent 一片、片与片不相交**，所以同一个工作区里
 * N 个 agent 的端口两两不同——这就是"端口"那一项隔离的全部机制（不靠命名空间）。
 */
export function portSlice(range: string, index: number): { port: number; ports: string } {
  const m = /^(\d+)-(\d+)$/.exec(range.trim())
  if (m === null) throw new BindingError(`端口池要写成 a-b，如 ${DEFAULT_PORTS}：${JSON.stringify(range)}`)
  const lo = Number(m[1])
  const hi = Number(m[2])
  if (!(lo >= 1 && hi <= 65535 && lo <= hi)) {
    throw new BindingError(`端口池要在 1-65535 里且 a ≤ b：${JSON.stringify(range)}`)
  }
  const slots = Math.floor((hi - lo + 1) / PORT_SLICE)
  if (index >= slots) {
    throw new BindingError(
      `端口池不够：${range} 容 ${slots} 个 agent（每个 agent ${PORT_SLICE} 个号），这是第 ${index + 1} 个\n` +
        `把池开大：fugue config set ${PORTS_KEY} 31000-31999`,
    )
  }
  const port = lo + index * PORT_SLICE
  return { port, ports: `${port}-${port + PORT_SLICE - 1}` }
}

export interface EnvInput {
  readonly roots: Roots
  readonly agent: AgentId
  readonly binding: ActionBinding
  readonly injections: Readonly<Record<string, string>>
  readonly portIndex: number
  readonly range: string
}

/**
 * 子进程的那一份环境：宿主这一份照旧 + 本 agent 的坐标 + 动作自己的 + `-- k=v` 的（后两者
 * 已经在各自的入口上过了保留清单，盖不到坐标）。
 */
export function envFor(i: EnvInput): Record<string, string> {
  const cache = cacheLayoutOf(i.roots, i.agent)
  const slice = portSlice(i.range, i.portIndex)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return {
    ...env,
    HOME: cache.home,
    XDG_CACHE_HOME: cache.xdgCache,
    TMPDIR: i.roots.tempRoot(i.agent),
    PORT: String(slice.port),
    PORTS: slice.ports,
    ...i.binding.env,
    ...i.injections,
  }
}
