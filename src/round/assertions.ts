// 验收断言 → 真起的命令行：**与 agent 执行同一条执行路**（架构 § 14.6 的两个消费者 ·
// § 8.12 的「断言只带动作名，命令行与沙箱归 `M7`/`M5`」）。
//
// 这一份修的是 B01/B09 那一处：原先 `specsOfContract` 只从配置里取 `argv`，环境只给
// `PATH`/`HOME`，最后用 `spawnSync` 直接起进程——执行边界、动作声明、网络档、声明目录与
// 环境基线全都被绕开；同一轮里 agent 跑在沙箱里，验收却跑在宿主上，而且跑两遍。
//
// 现在是同一条路：
//
//   `readBinding`（动作声明）→ `resolvePolicy`（档 · 网 · 可达集，树换成验收那棵）
//     → `checkReach` / `checkMountPoints`（启动前一致性）→ `envFor`（环境基线 + 坐标 + 端口片）
//     → `confine` / `degradedArgv`（怎么包）→ `Executor`（起进程 · 收输出）
//
// **检查在所有宿主写之前**（A）：声明落到视图外 · 树里同名的不是目录，这两条一拒，缓存目录与
// 声明目录一个都不建、验收进程一次都不起。声明目录的 `mkdir` 排在那两条检查**之后**。
//
// **一处解析，两处读**：`assertionSpecsOf` 只把「这一趟怎么起」算出来；起进程在
// `merge/accept.ts` 的 `runAssertion`（同一个 `createExecutor`）。`round run` 那条打桩/走查
// 路径仍可给直连 argv——它不是产品轮次，见 `runIssued` 的 `specsOf` 栏。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { declaredDirs, envFor, portRangeOf, readBinding } from '../boundary/binding.ts'
import type { ActionBinding } from '../boundary/binding.ts'
import { checkMountPoints, checkReach } from '../boundary/check.ts'
import { confine, degradedArgv } from '../boundary/confine.ts'
import { resolvePolicy } from '../boundary/policy.ts'
import type { LayersProbe, Policy } from '../boundary/policy.ts'
import { cacheLayoutOf } from '../roots/coords.ts'
import type { Roots } from '../roots/contract.ts'
import type { ConfigDoc } from '../config.ts'
import type { AssertionRunSpec } from '../merge/accept.ts'
import type { Assertion, Contract } from '../contract/types.ts'
import type { AbsPath, AgentId, RelPath } from '../terms.ts'

/** 这一批断言跑在哪：工作区 · 配置 · 探到的层 · 那棵树（验收自己铺的那一棵）。 */
export interface AssertionPlanDeps {
  readonly roots: Roots
  readonly doc: ConfigDoc
  readonly probed: LayersProbe
  /** 这一棵树是验收跑的那一棵（物化出来的），不是 agent 的常住视图。 */
  readonly tree: AbsPath
  /** 本 agent 的端口片序号（与 `fugue run`/驱动同一算法：日志里 writer 的次序）。 */
  readonly portIndexOf: (agent: AgentId) => number
  /**
   * **一批一份**（B）：键是 `(action, agent)`，值是一次准备的结果（绑定 · 声明 · 策略 · 环境）。
   * 给了就在这一批里复用——同一批的每条断言不再各自读配置、探策略、检查、建目录。
   * 它按**一棵树**算（调用方在一轮里只给一棵验收树）。
   */
  readonly memo?: AssertionPlanMemo
}

/** 一次准备的两种结果：能起（连同那一趟的输入）或不能起（为什么）。 */
interface ReadyPlan {
  readonly ok: true
  readonly binding: ActionBinding
  readonly declared: readonly RelPath[]
  readonly policy: Policy
  readonly env: Record<string, string>
}

interface RefusedPlan {
  readonly ok: false
  readonly why: string
}

type AssertionPlan = ReadyPlan | RefusedPlan

/** `(action, agent)` 的准备结果缓存。一批一份，见 `AssertionPlanDeps.memo`。 */
export interface AssertionPlanMemo {
  readonly plans: Map<string, AssertionPlan>
}

export function newAssertionPlanMemo(): AssertionPlanMemo {
  return { plans: new Map() }
}

/**
 * 一批契约里所有可执行断言。调查型契约没有断言（它的产物是证据）——跳过，不是少跑一条。
 *
 * 绑不上、策略不成立、声明目录落不到树里：**这一条进 `unrunnable`，不把整轮打成崩溃**。
 * § 8.12 末段说得很清楚：仪器故障（跑不起来）与活干得不对（没通过）是两档，前者要指出
 * 是哪一条断言的哪一步；整轮抛出去会把「哪一条」丢掉。
 */
export function assertionSpecsOf(contracts: readonly Contract[], deps: AssertionPlanDeps): AssertionRunSpec[] {
  const memo = deps.memo ?? newAssertionPlanMemo()
  const out: AssertionRunSpec[] = []
  for (const c of contracts) {
    if (c.kind === 'investigate') continue
    const agent = c.agent as AgentId
    for (const a of c.assertions) {
      const key = JSON.stringify([agent, a.action])
      let plan = memo.plans.get(key)
      if (plan === undefined) {
        plan = planOf(a.action, agent, deps)
        memo.plans.set(key, plan)
      }
      out.push(plan.ok ? specOf(a, agent, plan, deps) : notRun(a, agent, plan.why))
    }
  }
  return out
}

/**
 * 一条断言那一趟的输入：绑定 · 声明目录 · 策略 · 环境。**检查在前、宿主写在後**（A）：
 *
 *   1. `checkReach`：声明落不落在视图里 · 清单在宿主上成不成立。它不碰工作区。
 *   2. `checkMountPoints`：树里那个位置已经是**文件或软链**的那一条，在创建之前就拒
 *      （原先 `mkdirSync` 排在前面，报的是 `EEXIST`，指错了地方）。
 *   3. 这之后才建缓存落点与缺失的声明目录（`mkdir` 只补不存在的；存在又不是目录的，第 2 步已拒）。
 */
function planOf(action: Assertion['action'], agent: AgentId, deps: AssertionPlanDeps): AssertionPlan {
  try {
    const b = readBinding(deps.doc, action)
    const declared = declaredDirs(b) as readonly RelPath[]
    // **档与 agent 执行那条路一致**（`round/driver.ts` 的 `policyNow` 也是 workspace-write）：
    // 验收跑在另铺的一棵树上，树可写不会碰到真实工作树；写不动的话，那些要落产物的断言会
    // 在验收门里换一个失败原因——那不是同一条判据。
    const policy = resolvePolicy({
      roots: deps.roots,
      agent,
      doc: deps.doc,
      mode: 'workspace-write',
      binding: b,
      probed: deps.probed,
      tree: deps.tree,
    })
    const reach = checkReach({ roots: deps.roots, policy, declared })
    if (!reach.ok) return { ok: false, why: reach.error.message }
    const mounts = checkMountPoints(deps.tree, declared)
    if (!mounts.ok) return { ok: false, why: mounts.error.message }
    // 声明目录的挂载点：树里那一侧要有目录（`--bind` 的落点），缓存那一侧要有源。
    const cache = cacheLayoutOf(deps.roots, agent)
    mkdirSync(cache.home, { recursive: true })
    mkdirSync(cache.xdgCache, { recursive: true })
    // `--bind <tempRoot> /tmp` 的源也必须在：验收这一趟没有替 agent 铺过物化树。
    mkdirSync(deps.roots.tempRoot(agent), { recursive: true })
    for (const rel of declared) {
      mkdirSync(join(deps.tree, rel), { recursive: true })
      mkdirSync(cache.bound(rel), { recursive: true })
    }
    const env = envFor({
      agent,
      binding: b,
      injections: {},
      portIndex: deps.portIndexOf(agent),
      range: portRangeOf(deps.doc),
      policy,
    })
    return { ok: true, binding: b, declared, policy, env }
  } catch (err) {
    return { ok: false, why: (err as Error).message }
  }
}

function specOf(a: Assertion, agent: AgentId, plan: ReadyPlan, deps: AssertionPlanDeps): AssertionRunSpec {
  // `where` 比动作自己的 `cwd` 更具体：断言说「在哪跑」时以它为准（架构 § 8.12 那条
  // 字段表的 `where` 一栏）；没给才退回动作绑定的 cwd。
  const cwd = a.where ?? plan.binding.cwd
  const sandboxed = plan.policy.layers.includes('bwrap')
  const confined = sandboxed
    ? confine({ roots: deps.roots, agent, argv: plan.binding.argv, cwd, declared: plan.declared, env: plan.env, policy: plan.policy, tree: deps.tree })
    : degradedArgv(plan.binding.argv, { roots: deps.roots, policy: plan.policy })
  return {
    assertion: a,
    agent,
    argv: confined.argv,
    env: plan.env,
    ...(cwd === '' ? {} : { cwd: cwd as AssertionRunSpec['cwd'] }),
    enforcement: plan.policy.enforcement,
    mechanism: confined.mechanism,
  }
}

function notRun(a: Assertion, agent: AgentId, why: string): AssertionRunSpec {
  return { assertion: a, agent, argv: [], env: {}, notRun: why }
}
