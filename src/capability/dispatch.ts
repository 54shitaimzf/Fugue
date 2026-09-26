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
import { shellArgv } from '../tools/argv.ts'
import { HOLDER_PROTOCOL } from '../assemble/protocol.ts'
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

const says = (r: FaceResult): ToolResult => ({ ok: r.ok, output: r.output, ...(r.halt === true ? { halt: true } : {}) })

/**
 * 派发一次工具调用。**它是第 4 步唯一的实现。**
 *
 * 顺序是刻意的：**先查表**（未声明即拒）→ **再判有没有实现**（公布了却跑不起来是另一件事）
 * → **再解参数**（解不开就是一次失败的结果，不进围栏）→ **再过围栏**（拒了落 `bound/deny`，
 * 一次进程都不起）→ **再跑**。
 */
/**
 * 过一道路径围栏，并把**归一后的值写回参数**（W8 冻结点第 2 句）。
 *
 * 它单独抽出来是因为两个调用点要读同一份：`createToolExecutor` 先调它（`run/start` 那条事件
 * 就在那一层写，而它读的就是这里写回去的那份），`dispatch` 自己调它是为了直接调 `dispatch`
 * 的那些地方（命令面与单测）。两处各写一遍就是两处各错一次。
 */
async function fenceArgs(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  deps: DispatchDeps,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const fence = deps.fenceOf
  if (fence === undefined) {
    return {
      ok: false,
      message: `${name} 要过路径围栏（架构 § 8.9 第二条推论），而这一档没有接上围栏——没有围栏就不发这一步。`,
    }
  }
  for (const key of PATH_ARGS[name] ?? []) {
    const raw = args[key]
    if (typeof raw !== 'string') continue
    const got = fence(raw, cwd)
    if (!got.ok) {
      await deps.host.deny(fenceDenied(got.error))
      return { ok: false, message: got.error.message }
    }
    if (key === 'path' || key === 'to' || key === 'cwd') args[key] = got.value
  }
  return { ok: true }
}

export async function dispatch(
  req: ToolCallRequest,
  h: AgentHandle,
  deps: DispatchDeps,
  /** **围栏已经过过了**（`createToolExecutor` 那条路：事件要读归一后的值，所以它先过）。 */
  fenced = false,
  /**
   * **已经过过围栏的那一份参数**（归一后的）。给了它就用它——否则下面
   * 从 `req.arguments` 另解一遍，而那一份里的 `cwd` 还是原始的，“执行侧收到归一后的”这句话就落不了地。
   */
  given?: Readonly<Record<string, unknown>>,
): Promise<Dispatched> {
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
  const ctx: ToolContext = { agent: h.agent, step: h.state.step, cwd, holder: h.protocol === HOLDER_PROTOCOL }
  const args: Record<string, unknown> = { ...(given ?? parsed.value) }
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
  // 已经过过的那一条路（`fenced`）只把这一步记上：它真的跑过了，只是跑在上一层。
  if (c.fence) {
    if (!fenced) {
      const got = await fenceArgs(req.name, args, cwd, deps)
      if (!got.ok) {
        applied.push('fence')
        return { result: { ok: false, output: got.message }, capability: c, applied, denied: true }
      }
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
      const cwd = typeof asked['cwd'] === 'string' ? asked['cwd'] : (h.cwd ?? '')

      // **执行面先兑现**（W8）：这一格第一次要跑子进程时 fork 一棵、把视图铺过去——`bash` 与
      // `read` 因此是同一个视野。它抛（物化铺不起来）时**照落那一对事件**：`run/start` 是
      // "这一步要起进程"的凭据，而这一趟确实要起、只是没起起来——与围栏拦住那一趟同一个形状
      // （`denied: true`、`exit: 1`），不静默吞掉。
      let execNote: string | null = null
      if (running) {
        try {
          await deps.host.execCwd()
        } catch (err) {
          execNote = (err as Error).message
        }
      }

      // **先过围栏、再落 `run/start`**：那条事件读的就是归一后的 `cwd`（与执行侧同一把尺）。
      // 这里过一次之后，`dispatch` 那边就不再过了（`fenced = true`）——一次调用一道围栏。
      let fenceNote: string | null = null
      let fencedArgs: Record<string, unknown> = asked
      // **这一趟到底过没过围栏**（过了没拦住也算过）：下面那一对事件的口径读它，不读
      // `fenceNote === null`。两件事不一样——`fenceNote === null` 说的是"没被拒"，而
      // 表里 `fence: false` 那一格是"这一格压根不过围栏"。
      // 它同时是"**那一份归一后的参数能不能用**"那一栏：视图层那些格子（`c.layer !== 'execute'`）
      // 上面这一支整个不走，`fencedArgs` 停在空壳上——把它当"已过围栏的那一份"递给 `dispatch`，
      // 参数就当场丢了（实测：模型写 `a.ts`，摊到工具面变成"少了必填参数 path"）。
      let fenced = false
      if (running && !('denied' in c) && c.fence && parsed !== null && parsed.ok) {
        fenced = true
        fencedArgs = { ...parsed.value }
        // **fence 的 `cwd` 用格子的那个**（`h.cwd`：它已经是一条规整的 `RelPath`）。
        // 不能把上面算出来的 `cwd` 再送进去：那一份已经是参数里的原文，
        // 而它会被当成 `cwd` 又拼一次（`./src/../note` 变成 `note/note`）。
        const got = await fenceArgs(call.name, fencedArgs, h.cwd ?? '', deps)
        if (!got.ok) fenceNote = got.message
      }
      // **事件与执行侧读同一份**（W8 冻结点第 2 句：归一值写回参数，两处都从参数里读）。
      const runCwd = typeof fencedArgs['cwd'] === 'string' ? (fencedArgs['cwd'] as string) : cwd
      const command = typeof fencedArgs['command'] === 'string' ? (fencedArgs['command'] as string) : null
      const action = typeof fencedArgs['action'] === 'string' ? (fencedArgs['action'] as string) : null
      const line = command ?? action ?? call.name
      const argv = running ? shellArgv(line) : []
      const log = deps.logOf(h.agent)
      const t0 = Date.now()
      // **先落 `run/start`**：它是"这一步要起一个进程"的凭据。**只有围栏拦下的那一趟不落**
      // （`fenced && fenceNote !== null`）：它一次进程都没起，而 `run/start` 是"这一步要起一个
      // 进程"的凭据——落了它，日志里就多出一趟没发生过的执行；拒的那一趟在 `bound/deny` 里
      // （与断言 ④ 同一句话）。**表里 `fence: false` 那一格照样落**：它是"这一格不过围栏"，
      // 不是"被围栏拦下"，两者混起来看就再也分不清"没拦"和"拦住了"（⑤ 负对照读的就是这个差）。
      if (running && !(fenced && fenceNote !== null)) {
        await log.append(h.agent as WriterId, {
          t: 'run/start',
          agent: h.agent,
          step: String(h.state.step) as StepId,
          action: call.name,
          argv0: argv[0] ?? call.name,
          argv,
          cwd: runCwd,
        })
      }

      const out =
        fenceNote !== null
          ? {
              result: { ok: false, output: fenceNote },
              capability: c,
              applied: ['materialize', 'fence'],
              denied: true,
            }
          : execNote === null
          ? await dispatch(call, h, deps, true, fenced ? fencedArgs : undefined)
          : {
              result: { ok: false, output: `${call.name} 要先物化（架构 § 8.9 第一条推论），而这一趟没铺起来：${execNote}` },
              capability: c,
              applied: ['materialize'],
              denied: true,
            }

      if (running && !(fenced && fenceNote !== null)) {
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
 * 公布给模型的工具目录：**目录 ∩ 实现表**。
 *
 * 这一处是断言 ① 的落点：`ToolEntry` 里混进一条没实现的，这里会把它筛掉，于是"公布的那一份
 * ⊆ 实现表"这句话有了一处可以指着量的地方——而不是等模型点到它才现形。
 */
export function announce(entries: readonly ToolEntry[], names: readonly string[]): ToolEntry[] {
  return publishedTools(names, entries)
}
