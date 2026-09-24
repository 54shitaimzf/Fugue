// 工具调用 → 能力表那一格。出处：架构 § 8.9（那张「落在哪层状态 → 工具」的表 ·「全部行为分叉
// 的集中处」·「消费方读推论、不读层」）· § 14.2 第 4 步（`calls.map(dispatch)`）· § 8.4 纪律 2
// （拒的话里带着那个名字，并且指得出名字从哪来）。
//
// **这一份不认识工具，只认识那一格。** 它读 `lookup(tool)` 给的四个开关，按开关决定这一趟
// 要不要过围栏、要不要先物化——**没有一处按工具名分岔**。加一个工具时这一份一个字不动：
// 能力表里多一格，这里多跑一次同一段判断。
//
// **四条推论今天只有这一处消费方，而这一处是真的在跑它们**，不是把它们抄一遍。判据是断言 ③：
// 一次越界的 `bash` **在起进程之前就被围栏挡住**，而围栏是从能力表那一栏推出来的——把 `bash`
// 那一格从执行层挪到真源层，那一条当场变红。
import type { Capability, Denied } from './table.ts'
import { lookup } from './table.ts'
import type { Log } from '../log/events.ts'
import type { AgentId, StepId, WriterId } from '../terms.ts'
import type { Denied as FenceDenied } from '../roots/contract.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type { DenyAsk, FaceResult, ToolContext, ToolHost } from '../tools/execute.ts'
import { faceOf, noFace, parseArgs, publishedTools } from '../tools/execute.ts'
import type { AgentHandle, ToolCallRequest, ToolExecutor, ToolResult } from '../runtime/step.ts'

/**
 * 一次派发要的东西。
 *
 * `fenceOf` 与 `ensureOf` 是那两条推论各自的实现，**由调用方注入**：围栏是 `M3`、物化是 `M4`
 * ——它们住在别的几站里，而这一份只决定"这一步该不该叫它们"。该叫而没接上时**当场拒**，
 * 不静默跳过：跳过等于少一条推论，而少一条推论不报错。
 */
export interface DispatchDeps {
  /** 落事件的那个口（`run/start` · `run/end` · `bound/deny`）。 */
  readonly logOf: (a: AgentId) => Log
  readonly host: ToolHost
  /**
   * 查能力表的那个函数。**缺省就是真表**（`lookup`）。
   *
   * 它是一道注入，不是装饰：断言"围栏那一栏是从表推出来的"需要**指着一份改过一格的表**跑一次
   * ——把 `bash` 那一格的 `fence` 改成 `false`，一次越界的调用就不再被拦住。不给这一道口，
   * 那句话就只能靠读代码来判断。
   */
  readonly lookupOf?: (tool: string) => Capability | Denied
  /** 过一道路径围栏（`M3` 的 `Roots.resolveVirtual`）。 */
  readonly fenceOf?: (
    raw: string,
    cwd: string,
  ) => { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: FenceDenied }
  /**
   * 「先物化」那一条（`M4` 的 `ensure(rev)`）。**今天给不给都跑得对**：S8 的视图上层就是它的
   * 物化面（没有 lazy 的那一半），而 `B6` 把 `ensure` 接上时这一处不动——它只是多等一次兑现。
   */
  readonly ensureOf?: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<void>
}

/** 派发一次的结果：`ToolResult` 之外还给出**这一趟读了哪一格 · 跑了哪几条推论**。 */
export interface Dispatched {
  readonly result: ToolResult
  readonly capability: Capability | Denied
  /** 这一趟真的跑过的推论（`materialize` · `fence` · `confine` · `writeBack`），空数组 = 四条都不适用。 */
  readonly applied: readonly string[]
  /** 这一趟是不是**被拒**（不是"命令自己退非零"）。`run/end` 的 `denied` 读它。 */
  readonly denied: boolean
}

/** 那几个工具的参数里有路径（`fence` 过的是它们，不是整串参数）。 */
const PATH_ARGS: Readonly<Record<string, readonly string[]>> = {
  read: ['path'],
  write: ['path'],
  edit: ['path', 'to'],
  read_image: ['path'],
  glob: ['path'],
  grep: ['path'],
  bash: ['cwd'],
  run_action: ['cwd'],
}

const says = (r: FaceResult): ToolResult => ({ ok: r.ok, output: r.output })

/**
 * 派发一次工具调用。**它是第 4 步唯一的实现。**
 *
 * 顺序是刻意的：**先查表**（未声明即拒）→ **再判有没有实现**（公布了却跑不起来是另一件事）
 * → **再解参数**（解不开就是一次失败的结果，不进围栏）→ **再过围栏**（拒了落 `bound/deny`，
 * 一次进程都不起）→ **再跑**。
 */
export async function dispatch(req: ToolCallRequest, h: AgentHandle, deps: DispatchDeps): Promise<Dispatched> {
  const look = deps.lookupOf ?? lookup
  const c = look(req.name)
  if ('denied' in c) {
    return { result: says(noFace(req.name, c)), capability: c, applied: [], denied: true }
  }

  const fn = faceOf(req.name)
  if (fn === null) {
    return { result: says(noFace(req.name, c)), capability: c, applied: [], denied: true }
  }

  const parsed = parseArgs(req.arguments)
  if (!parsed.ok) {
    return {
      result: { ok: false, output: `${req.name} 的参数读不了：${parsed.why}` },
      capability: c,
      applied: [],
      denied: false,
    }
  }

  const cwd = h.cwd ?? ''
  const ctx: ToolContext = { agent: h.agent, step: h.state.step, cwd }
  const args: Record<string, unknown> = { ...parsed.value }
  const applied: string[] = []

  // **后两条先记上**：它们由这一格定，与这一趟顺不顺无关（`confine` 在 `host.run` 里面——
  // `M7` 包命令行、`M5` 起进程；`writeBack` 在 `host.runAction` 里面——声明集那条反向通道）。
  // `applied` 记的是"这一趟读了哪几条推论"，不是"哪几条顺利走完"：一次被围栏拦住的 `bash`
  // 仍然是"落在执行层、要关进沙箱"的那一格。
  if (c.confine) applied.push('confine')
  if (c.writeBack) applied.push('writeBack')

  // 第一条推论：落在执行层的工具要先物化（架构 § 8.9）。
  if (c.materialize) {
    const ensure = deps.ensureOf
    if (ensure === undefined) {
      return {
        result: {
          ok: false,
          output: `${req.name} 落在执行层，要先物化（架构 § 8.9 第一条推论），而这一档没有接上物化。`,
        },
        capability: c,
        applied,
        denied: true,
      }
    }
    await ensure(req.name, args)
    applied.push('materialize')
  }

  // 第二条推论：视图层与执行层都要过路径围栏——**围栏是从能力表那一栏推出来的**。
  if (c.fence) {
    const fence = deps.fenceOf
    if (fence === undefined) {
      return {
        result: {
          ok: false,
          output: `${req.name} 要过路径围栏（架构 § 8.9 第二条推论），而这一档没有接上围栏——没有围栏就不发这一步。`,
        },
        capability: c,
        applied,
        denied: true,
      }
    }
    for (const name of PATH_ARGS[req.name] ?? []) {
      const raw = args[name]
      if (typeof raw !== 'string') continue
      const got = fence(raw, cwd)
      if (!got.ok) {
        await deps.host.deny(fenceDenied(got.error))
        // **这一条也算"跑过"**：围栏真的拦了一次，那正是它跑过的凭据（`applied` 记的是这一趟
        // 读过哪几条推论，不是"哪几条顺利走完"）。
        applied.push('fence')
        return { result: { ok: false, output: got.error.message }, capability: c, applied, denied: true }
      }
      if (name === 'path' || name === 'to') args[name] = got.value
    }
    applied.push('fence')
  }

  const result = await fn(args, deps.host, ctx)
  return { result: says(result), capability: c, applied, denied: false }
}

/**
 * 把围栏的拒转成 `bound/deny` 要的那一份。
 *
 * **两份 `Denied` 不是一回事**：围栏那份说"这一条路径为什么不行"（四种由头各自成句），能力表
 * 那份说"这一格为什么不存在"。`bound/deny` 记的是前者的由头与那句指路话，所以只搬这两样。
 */
function fenceDenied(d: FenceDenied): DenyAsk {
  return { path: d.raw, space: 'virtual', rule: `fence:${d.kind}:${d.at}`, message: d.message }
}

/**
 * 把一次派发包成运行时那一道缝（`ToolExecutor`）。**`runtime/step.ts` 那一行不用改**：它只认识
 * `execute(call, h) → ToolResult`。
 *
 * `run/start` 与 `run/end` 落在这里，而不是落在工具的每一种实现里：**"一次工具调用 = 一对起止
 * 事件"这句话只有一处实现才成立**。两条的口径：`action` 是这一刻的工具名，`argv` 是完整命令行
 * （只有执行类那两个有），`cwd` 是这一趟的工作目录。
 */
export function createToolExecutor(deps: DispatchDeps): ToolExecutor {
  return {
    async execute(call: ToolCallRequest, h: AgentHandle): Promise<ToolResult> {
      const look = deps.lookupOf ?? lookup
      const c = look(call.name)
      const running = !('denied' in c) && c.layer === 'execute'
      const parsed = running ? parseArgs(call.arguments) : null
      const asked = parsed !== null && parsed.ok ? parsed.value : {}
      const command = typeof asked['command'] === 'string' ? asked['command'] : null
      const action = typeof asked['action'] === 'string' ? asked['action'] : null
      const line = command ?? action ?? call.name
      const argv = running ? shellArgv(line) : []
      const cwd = typeof asked['cwd'] === 'string' ? asked['cwd'] : (h.cwd ?? '')

      const log = deps.logOf(h.agent)
      const t0 = Date.now()
      // **先落 `run/start`**：它是"这一步要起一个进程"的凭据。围栏拦下的一次调用同样走到这里
      // ——这不是噪声：`run/end` 的 `exit` 与 `denied` 就是"起过没有 · 是被拒还是自己退非零"，
      // 读日志的人按这一对分组（断言 ④ 反过来说的那句话："被拦住的那一趟不许有子进程真的跑起来"
      // 的证据在 `host.run` 那一道口上，不在这一对事件上）。
      if (running) {
        await log.append(h.agent as WriterId, {
          t: 'run/start',
          agent: h.agent,
          step: String(h.state.step) as StepId,
          action: call.name,
          argv0: argv[0] ?? call.name,
          argv,
          cwd,
        })
      }

      const out = await dispatch(call, h, deps)

      if (running) {
        await log.append(h.agent as WriterId, {
          t: 'run/end',
          agent: h.agent,
          step: String(h.state.step) as StepId,
          // `run/end` 的 `exit` 是**子进程的退出码**，而拒在起进程之前：被拒时它不是"跑完失败"，
          // 所以给 1 并在 `denied` 那一栏说清（架构 § 8.1 那两栏的分工）。
          exit: out.result.ok ? 0 : 1,
          ms: Date.now() - t0,
          denied: out.denied,
        })
      }
      return out.result
    },
  }
}

/**
 * 一行命令 → 要 spawn 的那串参数。**这一版是"交给 shell"**：`/bin/sh -c <line>`。
 *
 * 为什么不自己切词：切词的第一步就是一套 shell 语法（引号 · 展开 · 管道 · 重定向），而"我们
 * 自己实现半个 shell"是更坏的选择。**真正的边界在沙箱那一层**（`M7` 包命令行），不在这一层
 * 切词；这与架构 § 8.10 里 `bash` 的收法一致——它收的就是一行命令。
 */
export function shellArgv(line: string): string[] {
  return ['/bin/sh', '-c', line]
}

/**
 * 公布给模型的工具目录：**目录 ∩ 实现表**。
 *
 * 这一处是断言 ① 的落点：`ToolEntry` 里混进一条没实现的，这里会把它筛掉，于是"公布的那一份
 * ⊆ 实现表"这句话有了一处可以指着量的地方——而不是等模型点到它才现形。
 */
export function announce(entries: readonly ToolEntry[], names: readonly string[]): ToolEntry[] {
  return publishedTools(names, entries)
}
