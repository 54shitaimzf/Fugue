// M12 轮次状态机。出处：架构 § 8.13——那张图逐边落成一张表，加它那三条验证性质与那条结构纪律
// （「状态机**只做转移，不做动作**。动作由各模块注册为转移的副作用」）· 架构 § 8.13.a 的两个上界 ·
// PLAN § 5.7 的 A3 行。
//
// **这一份里没有一次 `await` 一个动作。** 它认识的只有两种东西：状态与事件。取物化 · 起进程 ·
// 写日志，全是调用点在转移之后做的事——所以这一份可以整个同步地跑完，连一次 IO 都没有。
// 那条纪律的形状因此不是"我们尽量不写动作"，而是**签名上就没有地方放一个动作**：`step` 收
// 一个状态与一个事件，给一个状态；它没有 deps，没有句柄，也没有任何异步的形状。
//
// **图上的每一条边都在 `EDGES` 里，一条不落。** 表是这张图的机器可读副本，测试逐边对照；
// 图上没有的边在 `step` 里当场拒（负对照加一条边，那条断言就红）。
//
// **触发与守卫分开。** 图上的箭头带两样东西：触发它的那一条事件（`on`），与它成立的条件
// （`guard`）。`Idle → Planning` 的守卫是"意图快照已建立"（架构 § 8.13 的第一个关键点）——
// 这一条把"讨论"与"拆分"分开，所以它是 `step` 的参数，不是调用点自己记着。
import type { AgentId, RoundState } from '../terms.ts'

/** 这一层自己的失败：图上没有这条边 · 守卫不成立 · 状态或事件不认识。 */
export class RoundStateError extends Error {}

/**
 * 架构 § 8.13 那张图的十一个状态，逐字。`Aborted` 在里面——它是"从任意状态可达"的那一个，
 * 不是图上某一条路的终点。
 */
export const STATES: readonly RoundState[] = [
  'Idle',
  'Planning',
  'Delegated',
  'Working',
  'Collecting',
  'Merging',
  'Verifying',
  'Committed',
  'Rebuilding',
  'Aborted',
]

/**
 * 底下那些分支的处境（架构 § 8.13 的分支子状态：`Forked → Working → (Done | Failed | Preempted)
 * → Merged | Discarded`）。
 *
 * `Preempted` 是**被接续换下去**的那一届（§ 8.13.a 的循环重启）：分支还在 `Working`，换了个 agent，
 * 轮级状态一个字不动。它与 `Failed` 分开，因为"这一届没干完就被换下去"与"这一届干砸了"不是
 * 一回事——前者不该进打回率。
 */
export type BranchState = 'Forked' | 'Working' | 'Done' | 'Failed' | 'Preempted' | 'Merged' | 'Discarded'

/** 这一站停下来的那三档：到了这三档，`Collecting` 的 gc 屏障才开（架构 § 8.13 的第三个关键点）。 */
export const STOPPED: readonly BranchState[] = ['Done', 'Failed', 'Preempted']

/** 分支的处境：一个 agent 一条。**它只由 `branch/state` 那一类事件推动**，不在这里推断。 */
export type Branches = Readonly<Record<AgentId, BranchState>>

/**
 * 状态机认识的转移理由。**它是"触发它的那一条事件"的名字**，不是事件本身——
 * 日志事件（§ 8.1）住 `log/events.ts`，这里只留"哪一条把它推过来的"。
 */
export type Cause =
  /** 用户显式落地指示（架构 § 8.13 的第一个关键点）。守卫：意图快照已建立。 */
  | 'land'
  /** N 份契约发完。 */
  | 'contracts-issued'
  /** N 个分支起好了。 */
  | 'branches-started'
  /** 全部 Done / Failed / 超时。**`Collecting` 的 gc 屏障由它开。** */
  | 'all-stopped'
  /** `Collecting` 里那一次 gc / repack 屏障走完。 */
  | 'gc-done'
  /** 写入集预检报出冲突。 */
  | 'conflict'
  /** 冲突解决（物化冲突树 + `resolve` 契约 + 回收）走完。 */
  | 'resolved'
  /** 冲突解决了、重新折一次。 */
  | 're-fold'
  /** 验收通过。 */
  | 'verdict-pass'
  /** 验收没通过，且还有重试余量。 */
  | 'verdict-fail'
  /** 验收没通过，且重试超界。 */
  | 'retry-exceeded'
  /** 真实工作树推进完（`merge/accept` 之后的那一步）。 */
  | 'advanced'
  /** 中止：`Aborted` 从任意状态可达。 */
  | 'abort'

/** 转移的守卫：**它是"这一步现在成立吗"的判据，不是动作。** */
export type Guard =
  /** 意图快照已建立（`Idle → Planning`）。 */
  | 'intent'
  /** 全部 agent 都停了（`Collecting` 的 gc 屏障）。 */
  | 'all-stopped'
  /** 还有重试余量。 */
  | 'retry-left'

export interface Edge {
  readonly from: RoundState
  readonly to: RoundState
  readonly on: Cause
  /** 图上那一句触发的话，逐字（给报错与走查印）。 */
  readonly say: string
  /** 成立才走得动。没有守卫 = 收下事件就走。 */
  readonly guard?: Guard
}

/**
 * 架构 § 8.13 那张图逐边落成的表。**图上没有的边 `step` 一律拒。**
 *
 * 逐条对着图读：
 *   `Idle ──用户指示落地──> Planning`（守卫：意图快照已建立）
 *   `Planning ──issue N contracts──> Delegated`
 *   `Delegated ──启动 N 个分支──> Working`
 *   `Working ──全部 Done/Failed/超时──> Collecting`
 *   `Collecting ──gc/repack 屏障──> Merging`
 *   `Merging ──冲突?──> Merging`（冲突解决那一圈：物化 + 回收 + 重折）
 *   `Merging ──> Verifying`
 *   `Verifying ──没通过 ∧ 超界──> Aborted`
 *   `Verifying ──没通过 ∧ 未超界──> Working`
 *   `Verifying ──> Committed`
 *   `Committed ──> Rebuilding ──> （回到 Working：下一轮或重新委派）`
 *   `Aborted <──abort── Working`（图上那一条），且**任意状态都能 abort**
 */
export const EDGES: readonly Edge[] = [
  { from: 'Idle', to: 'Planning', on: 'land', say: '用户指示落地', guard: 'intent' },
  { from: 'Planning', to: 'Delegated', on: 'contracts-issued', say: 'issue N contracts' },
  { from: 'Delegated', to: 'Working', on: 'branches-started', say: '启动 N 个分支' },
  { from: 'Working', to: 'Collecting', on: 'all-stopped', say: '全部 Done/Failed/超时', guard: 'all-stopped' },
  { from: 'Collecting', to: 'Merging', on: 'gc-done', say: 'gc/repack 屏障' },
  // 冲突那一圈：`Merging ──冲突?──> 冲突解决（物化+回收）──> Merging`。落在表上是"报出冲突"
  // 与"解决完重折"两条，两条都自环——中间那一段（物化冲突树 · `resolve` 契约 · 回收）是
  // A5 的动作，不是状态。
  { from: 'Merging', to: 'Merging', on: 'conflict', say: '冲突?（物化冲突树 + M6 回收）' },
  { from: 'Merging', to: 'Merging', on: 're-fold', say: '重新折一次' },
  { from: 'Merging', to: 'Verifying', on: 'resolved', say: '冲突解决完 / 没有冲突' },
  { from: 'Verifying', to: 'Aborted', on: 'retry-exceeded', say: '没通过 ∧ 超界' },
  { from: 'Verifying', to: 'Working', on: 'verdict-fail', say: '没通过 ∧ 未超界', guard: 'retry-left' },
  { from: 'Verifying', to: 'Committed', on: 'verdict-pass', say: '验收通过' },
  { from: 'Committed', to: 'Rebuilding', on: 'advanced', say: '真实工作树已推进' },
  // `Rebuilding` 回到 `Working`：图上 `Committed ──> Rebuilding ──┐` 那一条回到主环的线。
  // 下一轮从 `Working` 起（接续与重新委派都在那儿），轮级状态不新建。
  { from: 'Rebuilding', to: 'Working', on: 'branches-started', say: '下一届分支起好了' },
  // 图上那一条 `Aborted <──abort── Working`。
  { from: 'Working', to: 'Aborted', on: 'abort', say: 'abort' },
]

/** `Aborted` 从任意状态可达（架构 § 8.13 的第五个关键点）。**它不是图外的例外，是图上那句话。** */
export function abortEdges(): Edge[] {
  return STATES.filter((s) => s !== 'Aborted').map((s) => ({
    from: s,
    to: 'Aborted' as RoundState,
    on: 'abort' as Cause,
    say: 'abort（Aborted 从任意状态可达）',
  }))
}

/** 一次转移要的那点上下文。**全是值，没有句柄**——这一份不认识物化、进程、日志。 */
export interface StepContext {
  /** 意图快照已建立（`Idle → Planning` 的守卫）。 */
  readonly intent?: boolean
  /** 全部 agent 都停了（`Collecting` 的 gc 屏障）。不给 `branches` 时按它判。 */
  readonly allStopped?: boolean
  /** 底下那些分支的处境：给了就由它算"全停"，不给就看 `allStopped`。 */
  readonly branches?: Branches
  /** 还有重试余量（`Verifying → Working` 的守卫）。 */
  readonly retryLeft?: boolean
}

/** 一条边上的守卫现在成立吗。**不成立的报法要指得出是哪一条守卫。** */
export function guardOk(edge: Edge, ctx: StepContext): boolean {
  if (edge.guard === undefined) return true
  if (edge.guard === 'intent') return ctx.intent === true
  if (edge.guard === 'all-stopped') {
    if (ctx.branches !== undefined) return allStopped(ctx.branches)
    return ctx.allStopped === true
  }
  return ctx.retryLeft === true
}

function guardName(g: Guard): string {
  if (g === 'intent') return '意图快照已建立'
  if (g === 'all-stopped') return '全部 agent 已停止'
  return '还有重试余量'
}

/** 底下全停了吗——`Collecting` 的 gc 屏障判的就是这一条。**一条分支在册为零也算全停**（没有分支）。 */
export function allStopped(branches: Branches): boolean {
  return Object.values(branches).every((s) => STOPPED.includes(s))
}

/** 还在跑的那几条分支，给报错用。 */
export function running(branches: Branches): AgentId[] {
  return Object.entries(branches)
    .filter(([, s]) => !STOPPED.includes(s))
    .map(([a]) => a as AgentId)
    .sort()
}

function edgesFrom(from: RoundState, on: Cause): Edge[] {
  const all = on === 'abort' ? [...EDGES, ...abortEdges()] : EDGES
  return all.filter((e) => e.from === from && e.on === on)
}

/** 从某个状态出发、认得的事件有哪些（报"这条边图上没有"时把它列出来）。 */
export function causesFrom(from: RoundState): Cause[] {
  const all = [...EDGES, ...abortEdges()].filter((e) => e.from === from)
  return [...new Set(all.map((e) => e.on))].sort()
}

/**
 * 走一步。**收一个状态与一个事件，给一个状态。**
 *
 * 三种拒法各自说得出话：没有这条边 · 有这条边但守卫不成立 · 状态或事件不认识。**不当成空操作。**
 */
export function step(from: RoundState, on: Cause, ctx: StepContext = {}): RoundState {
  if (!STATES.includes(from)) throw new RoundStateError(`不认识这个轮次状态：${JSON.stringify(from)}`)
  const hit = edgesFrom(from, on)
  if (hit.length === 0) {
    throw new RoundStateError(
      `图上没有这条边：${from} ──${on}──> ？（从 ${from} 出发认得的是：${causesFrom(from).join(' · ')}）`,
    )
  }
  const taken = hit.find((e) => guardOk(e, ctx))
  if (taken === undefined) {
    const g = hit[0].guard
    const detail =
      g === 'all-stopped'
        ? `还在跑的：${running(ctx.branches ?? {}).join(' · ') || '（没给 branches）'}`
        : `守卫：${g === undefined ? '（没有守卫）' : guardName(g)}`
    throw new RoundStateError(
      `这条边现在走不动：${from} ──${on}──> ${hit[0].to}（${hit[0].say}）——${detail}`,
    )
  }
  return taken.to
}

/** 一条走过的路：每一步都带着触发它的那一条事件——**"每一次转移都指得到触发它的那一条事件"**。 */
export interface Trail {
  readonly state: RoundState
  readonly edges: readonly Edge[]
}

/**
 * 从 `Idle` 走一串事件。**给的是那条路**，不只是终点：架构 § 8.13 的第一条验证性质要的是
 * "每一次转移都能指到触发它的那一条事件"，所以走过的边要留下来。
 *
 * `steps` 的每一项是 `[事件, 上下文]`，上下文不给就按空判（有守卫的边会当场拒）。
 */
export function trail(steps: readonly (readonly [Cause, StepContext?])[]): Trail {
  let state: RoundState = 'Idle'
  const edges: Edge[] = []
  for (const [on, ctx] of steps) {
    const before = state
    state = step(state, on, ctx ?? {})
    const e = edgesFrom(before, on).find((x) => x.to === state)
    if (e === undefined) throw new RoundStateError(`走出来的边找不到：${before} ──${on}──> ${state}`)
    edges.push(e)
  }
  return { state, edges }
}

/**
 * 重试上界的缺省：**1**（架构 § 8.13：「验收没过就自动回 `Working` 再干一遍，第二遍还不过才判
 * 这一轮失败；`--retry 0` 表达"一遍都不重来"」）。
 *
 * **一处定义**：命令面（`--retry`）与驱动那一层（`retriesLeft` 不给时）都读它。两处各写一个 0
 * 的话，"缺省回一次"这句话只在其中一处成立，而两处的读数看不出区别——这正是要防的那种漂。
 */
export const RETRY_DEFAULT = 1

/**
 * 验收那一步的判据（架构 § 8.13 图上那两条分叉）。**"超界"指的是重试上界，不是接续上界**——
 * 两个上界各自独立计数（§ 8.13.a），自重启走另一条路，不经过这里。
 *
 * 返回的是**事件**，不是状态：状态机只做转移，判决那一层在这里只把"该发哪一条事件"算出来。
 */
export function verdictCause(pass: boolean, retriesLeft: number): Cause {
  if (pass) return 'verdict-pass'
  return retriesLeft > 0 ? 'verdict-fail' : 'retry-exceeded'
}

/** 图上写着的那一句话，给报告与走查印。 */
export function sayOf(from: RoundState, to: RoundState): string {
  const hit = [...EDGES, ...abortEdges()].find((e) => e.from === from && e.to === to)
  return hit === undefined ? `${from} ──> ${to}（图上没有这一条）` : `${from} ──${hit.on}──> ${to}：${hit.say}`
}
