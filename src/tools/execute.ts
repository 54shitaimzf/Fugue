// 工具面：**工具名 → 会跑的那一段**。出处：架构 § 8.10（那份工具目录）· § 8.9（能力表
// 以工具名为键）· § 14.2 第 4 步（`calls.map(dispatch)`）。
//
// **它是目录与实现之间的那一半。** `catalog.ts` 说"公布给模型的是哪几条"，这一份说"哪几条
// 真的跑得起来"。两者今天是两个集合，而**公布的那一份必须是跑得起来的那一份的子集**——否则
// 模型点了一条我们再回一句"这条没接上"，那是把我们的缺口当成它的一次错误（架构 § 8.4 纪律 2
// 的同一件事：拒的话里要指得出名字从哪来）。
//
// **这一层不认识沙箱、不认识视图。** 手里只有 `ToolHost`（B5 定的一道缝：读 · 写 · 改 ·
// 列 · 跑 · 提交 · 动作）。谁实现它，"路径怎么围栏 · 子进程怎么关起来"就在谁那儿；这一层只管
// "哪个工具收哪几个参数、把结果说成什么话"。**也因此它没有一处 `if (action === …)`**——那类
// 分岔归 `capability/dispatch.ts` 那张表。
//
// **为什么"有实现"这件事要能被指着问出来**（`faceOf` · `IMPLEMENTED`）：`B5` 的断言 ① 是
// "公布的工具每一条都有实现"，而这句话只有在"实现表"是一份**读得出来的名单**时才量得到。
// 写成"调用时才 `throw`"就量不到了——那时缺口只在真被调到时才现形。
import type { Capability, Denied } from '../capability/table.ts'
// **路径形状那一个错来自叶子**（`src/path-shape.ts`）：视图那一层抛它，这一层按它接成一条结果。
// 不 import 视图那边——这一层的头注写着"不认识视图"，而这条规矩两层共用，所以它有一条自己的家。
import { PathShapeError } from '../path-shape.ts'
import { lineCount } from './receipt.ts'
import { textWindowOf, numberedWindowOf, windowNoteOf } from './read-window.ts'
import type { ReadWindow, ReadText } from './read-window.ts'
import type { WalkResult } from './walk.ts'
import { SearchRows, searchLines, SEARCH_PREFETCH_ROWS, SEARCH_PREFETCH_MAX_ROWS } from './search-receipt.ts'
import type { SearchCoverage } from './search-receipt.ts'
import { requiredLiteralTrigrams } from '../search/regex-literal.ts'
import type { ForkStrategy } from '../terms.ts'
import type { ToolEntry } from './catalog.ts'
// 这一份里没有一处 `Denied` 的字段被读：它只被原样交给 `noFace` 那一段话。留成 import type 是
// 因为下面那条签名指着它——**形状住能力表，这一层不复制第二份**。
/** 一次工具调用要跑，得先知道是哪个 agent 的哪一步（日志与坐标都要它）。 */
export interface ToolContext {
  readonly agent: string
  readonly step: number
  /**
   * 这一格是不是**持轮者**（`HOLDER_PROTOCOL` 那一格）。
   *
   * 派发那一层按协议判定（身份比较，不比字符串），工具面只读这个布尔：有几条工具只有持轮者
   * 调才有意义（`exit_plan_mode` · `ask_user_question`），而子 agent 调它们要得到一句指得出
   * 出路的回绝，不是静默成功。
   */
  readonly holder: boolean
  /** 视图内的相对路径，工具收的那种路径都相对它（`bash` 的 `cwd` 也是）。 */
  readonly cwd: string
  /**
   * **这一趟那一份草案的路径**（持轮者那一趟才有：`DispatchDeps.planPath`）。
   *
   * 它是这一趟**唯一**产物的位置。今天两处读它：写入面那一栏（`write` · `edit` 只许落在它那
   * 一棵里）与 `exit_plan_mode` 自报的那一栏（必须就是它——那条路径只有一个来源，不许有第二个）。
   */
  readonly planPath?: string
}

/**
 * 工具能碰的那几样东西。**十二条，就是工具这一侧全部要碰的那几样。**
 *
 * `deny` 是"你自己拒了"那道口：路径围栏（`M3` 的 `resolveVirtual`）与能力表都不在这一层，
 * 所以拒的话由实现那一侧给整句，这一层只把它原样变成一次失败的结果。**拒的话里指得出名字
 * 从哪来**（§ 8.4 纪律 2），所以那道口收的是 `Denied`（能力表那份形状）而不是一段字符串。
 */
export interface ToolHost {
  /**
   * 读一个路径。**给的是字节，不是字符串**：`read_image` 那一格要能原样取出图，
   * 而"字节 → 字符串"这一步会替掉非法序列（同一个字节串读两次会变成两样）。
   * 文本工具自己在这一层解（`utf8Of`），二进制工具原样拿走。
   */
  readBytes(rel: string): Promise<{ readonly bytes: Uint8Array; readonly mode: number } | null>
  /** 行窗口的可选读口：只解选中那段文本。缺席时由 readBytes 原样退回；图像/整文件仍走字节口。 */
  readonly readTextWindow?: (rel: string, window: ReadWindow) => Promise<(ReadText & { readonly mode: number }) | null>
  writeBytes(rel: string, bytes: Uint8Array): Promise<{ readonly rev: number }>
  /**
   * 列一层。**只列直接的孩子，不递归**——递归是另一条（`walk`），因为"走多深"这件事
   * 在视图那边要一层一层问，而在工具这边要一次拿全。
   */
  list(dir: string): Promise<readonly ToolListing[]>
  /**
   * 这棵树里的全部文件（相对根的路径）。
   *
   * **它不走软链、有层级与条数上限**：软链穿过去就绕开了路径围栏（§ 8.4 的 `through-symlink`
   * 那一条），而不封顶的深树能把一步走成挂死。两条都由实现那一侧封——这一层只消费结果。
   */
  walk(): Promise<readonly string[]>
  /** 可选详细读口；缺席时枚举完整性未知，不把截掉的候选说成没有匹配。 */
  readonly walkDetailed?: () => Promise<WalkResult>
  /** 可选辅助候选过滤。仅接收必需的三元组，缺席/失败/坏结果都按原批扫描。 */
  readonly filterCandidates?: (paths: readonly string[], required: readonly string[]) => Promise<readonly string[]>
  /**
   * **把这几条路径的内容先取回一层来**（这一站加的，可选）。它是一道**缝**：实现了就在这一层
   * 批量取（一条 `objectMany('contents', …)`），没实现就照旧"用一条读一条"——**预取缺席 =
   * 退回逐文件读**，不是坏掉（AGENTS 第五节的地板判据）。
   *
   * 它是**提示，不是承诺**：谁也不许依赖"调过之后一定命中"（上层可能是空的 · 容量可能不够），
   * 读那一侧照旧按"读不到就问"的顺序走。`grep` 在逐文件读之前调它一次。
   *
   * 返回值是**覆盖到的前缀长度**（缺省 = 全部）：实现按字节封顶时只取得回前面那几条，`grep`
   * 就只读这一段、下一轮从没覆盖的地方起重新成批——而不是把整批读完、让没取的那些各走一趟。
   */
  readonly prefetch?: (paths: readonly string[]) => Promise<void | number>
  readonly edit: (rel: string, raw: EditRaw) => Promise<{ readonly rev: number; readonly changed: boolean }>
  /**
   * **执行面在哪儿**：这一格的物化根（绝对路径，一格一个）。`bash` / `run_action` 跑在那儿。
   *
   * W8 起格内的环境归一成两样：**视图是读面，物化根是执行面**，`ensure` 让两者同步。为什么
   * 这个口在这一层：执行侧的相对路径映射收在 `host.run` 一处（`workdirOf`），而"物化根在哪"
   * 只有宿主知道——工具那一层不需要知道，也不该知道。
   *
   * **它是唯一一处"要花钱的兑现"**：第一次被问到时这一格才 fork（纯 `write`/`read` 的格不付
   * 这份钱），之后每次把视图的 delta 落过去（rev 没变就是 `noop`）。它与 `checkpoint` 同一条
   * 道理住在这个接口上：工具面那一层不认识物化，只认识"这一格在哪跑"。
   */
  execCwd(): Promise<{ readonly root: string; readonly strategy: ForkStrategy | null }>
  run(req: RunAsk): Promise<RunReply>
  checkpoint(msg: string): Promise<{ readonly commit: string }>
  runAction(req: ActionAsk): Promise<RunReply>
  /**
   * 记一份待办，**整体覆盖**上一次那一份（`todo_write` 那一条的落点）。
   *
   * 它落一条 `holder/todos`。待办是**跨步**的上下文：落视图会污染工作树（验收要逐字节一致），
   * 落内存则重启即失（架构 § 9.7 的 `turns`）——住日志是唯一既跨步又重建得出的落点。而进 C 区
   * 靠的是这一步的回执文本，两件事分开：模型看得见的是回执，重放得出的是事件。
   */
  setTodos(todos: readonly TodoItem[]): Promise<{ readonly count: number }>
  /**
   * 持轮者说"预备态做完了"（`exit_plan_mode` 那一条的落点）。**落事件，不发契约**——门由人开。
   *
   * 它只是"把这一刻定下来"：落一条 `holder/plan`（`digest` + 正文），重放得出持轮者交了什么。
   * 派不派契约是 `round go` 那一档的事，不在这里。
   */
  declarePlan(ask: PlanAsk): Promise<void>
  /**
   * 问人（`ask_user_question` 那一条的落点）。**落事件 + 停在同一道门口**，与 `declarePlan`
   * 共用那一个"停"——答案归人，人答了才接着跑。
   */
  askUser(asks: readonly AskItem[]): Promise<void>
  /**
   * 自己拒了一次（路径在视图外 · 视图层只读 …）。**整句由拒的那一方给**，这一条口子只负责
   * "把这次拒记下来"：落一条 `bound/deny`（`path` · `space` · `rule` 就是那条事件的三个字段），
   * 再把同一句话交回去当这一步的结果。
   */
  deny(d: DenyAsk): Promise<void>
}

/** 一次"我自己拒了"：`bound/deny` 那三个字段加一句给人看的话。 */
export interface DenyAsk {
  /** 被拒的那一串原文（模型给的那个路径）。 */
  readonly path: string
  /** 拒在哪个空间里：视图内的相对路径是 `virtual`，物化出来的那棵树是 `physical`。 */
  readonly space: 'virtual' | 'physical'
  /** 哪一条规则拒的（机器可读的那半句，进日志）。 */
  readonly rule: string
  /** 给人看的整句，含指路（架构 § 8.4 纪律 2）。**它就是这一步的结果文本。** */
  readonly message: string
}

/**
 * 一条拒的话。**`rule` 是机器读的那半句，`message` 是给人看的那一整句。**
 *
 * 两个字段都要：`bound/deny` 记的是 `rule`（重算指标与走查按它分组），模型看到的是 `message`
 * （带指路）。合成一段字符串就再也分不开了。
 */
export function refuse(rule: string, message: string, path: string, space: 'virtual' | 'physical' = 'virtual'): DenyAsk {
  return { rule, message, path, space }
}

/**
 * 一次替换的原文。**形状就是公布面**——`catalog.ts` 里 `edit` 的 `path` · `old_string` ·
 * `new_string` · `replace_all`，一个不多、一个不少。
 *
 * 为什么把这一条写在类型上：它原先是"改名 / 改权限 / 替换一段"三选一（`to` · `mode` ·
 * `find`+`replace`），而目录公布的是另一套名字。**绑定面比公布面宽**的那一次漂移在 W11 重跑
 * 那一趟上烧掉了整整一格：模型按公布面给 `old_string`/`new_string`，这一层只认 `find`/`replace`，
 * 当场被拒，它随后乱了四步直到上界。**公布面是进前缀的那一份，所以它是契约。**
 */
export type EditRaw = {
  readonly kind: 'replace'
  readonly find: string
  readonly replace: string
  /** 公布的 `replace_all`（可选键）：为真 → 每一处都换；缺省 → 出现不止一处时先拒（猜是哪一处是静默的错误）。 */
  readonly all: boolean
}

/** 列目录给回的一行。`kind` 是"这一行是文件还是目录"——`glob` 按它决定走不走下去。 */
export interface ToolListing {
  readonly name: string
  readonly kind: 'file' | 'dir' | 'symlink' | 'other'
  readonly size: number
}

/** 起一个进程要什么。**`command` 是一行原样的命令**：怎么切词、怎么关起来是实现那一侧的事。 */
export interface RunAsk {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number | null
}

/** 一次执行的回执（`execute/contract.ts` 的 `RunResult` 去掉这一层不读的那两栏）。 */
export interface RunReply {
  readonly exit: number
  readonly ms: number
  readonly denied: boolean
  readonly stdout: string
  readonly stderr: string
}

/** 问人的一问（形状与目录里 `ask_user_question` 那一条的参数面逐字相同）。 */
export interface AskItem {
  readonly question: string
  readonly header?: string
  readonly multiSelect?: boolean
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
}

/**
 * 一次最多问几个。**它是常数，不是"模型看着办"**：答案归人，而人一次能答的是有限的；
 * 问多了不是"更周全"，是让人没法答——所以超过就当场拒，并指得出去处（架构 § 8.4 纪律 2）。
 */
export const MAX_ASKS = 4

/** 一份计划（`exit_plan_mode` 给的那两栏）。`plan` 是正文，`path` 是它写在哪个文件里（可缺）。 */
export interface PlanAsk {
  readonly plan: string
  readonly path?: string
}

/** 待办的一行。形状与目录里 `todo_write` 那一条的参数面逐字相同（不另抄一份）。 */
export interface TodoItem {
  /** 这件事要做什么。 */
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  /** 正在做它时的说法。 */
  readonly activeForm?: string
}

/**
 * 一个具名动作（架构 § 8.9 里唯一有声明集的那一格：执行类经声明集回写）。
 *
 * **名字不是命令行**（P3b1 归真）：`extra` 是追加到绑定 argv 尾上的那几个参数（公布面 `args`
 * 那一栏的字符串数组，face 侧提净）；命令行 · cwd · env 由宿主那一层按工作区配置里的绑定解析
 * （`HostOptions.actionFor`），这一层与 `RunAsk` 一样只递"模型说了什么"。
 */
export interface ActionAsk {
  readonly action: string
  readonly extra: readonly string[]
  readonly cwd: string
}

/**
 * 一条工具的实现。**收的是解过的参数**（`parseArgs` 之后的那一份），不是模型给的那串 JSON 文本。
 *
 * 出口是一段文本 + 它是不是失败。**失败也是一种结果**（`runtime/step.ts` 的 `ToolResult`）：
 * 它要进 C 区被模型看见，而不是把这一层抛出去变成一个 `failed` 的步。
 */
export type ToolFn = (args: Readonly<Record<string, unknown>>, host: ToolHost, ctx: ToolContext) => Promise<FaceResult>

export interface FaceResult {
  readonly ok: boolean
  readonly output: string
  /**
   * **这一格到这儿为止**（架构 § 15.1.a 的"停在门口"）。
   *
   * 它不是错误，也不是"没话说"：模型交了卷，而门由人开——所以这一步之后不再接着跑。运行时
   * 把它读成一次 `done`（与模型自己说完同一档），**不与工具名绑在一起**：哪一条工具能叫停，
   * 由它自己说，不由运行时按名字分岔。
   */
  readonly halt?: boolean
}

const ok = (output: string): FaceResult => ({ ok: true, output })
const no = (output: string): FaceResult => ({ ok: false, output })

/** 参数不是个对象（模型给了一串数组或一个标量）——每一处都要问这一句，所以只有一处。 */
function arg(args: Readonly<Record<string, unknown>>, name: string): unknown {
  return args[name]
}

function text(args: Readonly<Record<string, unknown>>, name: string): string | null {
  const v = arg(args, name)
  return typeof v === 'string' ? v : null
}

function num(args: Readonly<Record<string, unknown>>, name: string): number | null {
  const v = arg(args, name)
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 一个布尔开关：**只有 `true` 算给了**（其余一律当没给——缺省那一档是有意选的）。 */
function flag(args: Readonly<Record<string, unknown>>, name: string): boolean {
  return arg(args, name) === true
}

/**
 * 一次调用给的参数原样文本 → 一个对象。**解不开就是一次失败的结果，不是抛。**
 *
 * 它为什么在这一层而不是在适配器那一侧：两条线协议给的 `arguments` 都是一串**文本**
 * （`B1` 的 `ToolCall.arguments` 逐字如此），而"这串文本对不对"是工具面的事——适配器只管
 * 把字节拼起来（`B2` 的 `input_json_delta`）。
 */
export function parseArgs(raw: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly why: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: {} }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, why: `arguments are not JSON: ${(err as Error).message}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, why: 'arguments must be a JSON object (key/value pairs); this is something else.' }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** 少一个必填参数时那句统一的话（目录里凡是必填的都走它，文案不各写一份）。 */
function missing(tool: string, name: string): FaceResult {
  return no(`${tool} is missing required argument ${name} — the object you passed does not carry it.`)
}

const utf8Of = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8')
const bytesOf = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

/**
 * **模型给的路径形状不合法，是一条失败的结果，不是把这一趟打死。**
 *
 * 出处：架构 § 8.4 纪律 2（工具面只有那一个入口，错路要指出来）· § 8.9（工具结果）。抛出去在
 * `runtime/step.ts` 那里是一条 `tool-threw`，**那一趟当场结束**——真档照出过一次：持轮者第 2 步
 * `read {"path":"."}`，那一趟两句话就没了，草案一个字节都没写（`--dump-wire` 实录）。
 *
 * **只接路径形状那一类**（`PathShapeError`）：实现自己坏了（视图 · 宿主 · 物化树里那些没料到的
 * 错）照旧抛——那是 `tool-threw` 该管的事，接掉它等于把真 bug 变成一句给模型看的话。
 */
async function guardPath(f: () => Promise<FaceResult>): Promise<FaceResult> {
  try {
    return await f()
  } catch (err) {
    if (!(err instanceof PathShapeError)) throw err
    return no(
      `${err.message} — those fields must point at one concrete file (a relative path inside the view).` +
        ' To see which paths the workspace has, use glob: pattern `**/*` asks for all of them.',
    )
  }
}

/** 走路径那四条：它们的 `path` 是模型的输入，所以过 `guardPath`（其余各条不碰路径算术）。 */
const PATH_TOOLS: readonly string[] = ['read', 'write', 'edit', 'read_image']

// ── 视图类那五个 ───────────────────────────────────────────────────────────────
//
// 路径参数原样交给实现那一侧（`ToolHost`）：围栏在 `dispatch` 那一道（由能力表的 `fence` 推
// 出来的），物理落点在 `Roots`。这一层不碰路径算术——§ 8.4 的"唯一入口"那句话说的就是它。

/**
 * 一个「整行号」参数（`read` 的 `offset` · `limit`）：**没给这一栏就是没给**，给了就必须是安全
 * 整数（`offset` 正 · `limit` 非负）。
 *
 * **坏参数在伸手之前拒**（§ 8.10 硬纪律 1 的另一半：公布了就要有人接，接了就要接得干净）：
 * 为了回一句"参数不对"先去读一整份文件，是把我们的粗心算在它头上。缺省只有一种形状——这个键
 * 不在；给了别的形状（含 `null`）就是坏参数，拒的话里点出是哪一个。
 */
function wholeArg(
  args: Readonly<Record<string, unknown>>,
  name: 'offset' | 'limit',
): { readonly value: number | null } | { readonly why: string } {
  const v = args[name]
  if (v === undefined) return { value: null }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= (name === 'offset' ? 1 : 0)) return { value: v }
  const said = typeof v === 'string' ? JSON.stringify(v) : String(v)
  const wants =
    name === 'offset'
      ? 'a positive whole number of lines (1 is the first line)'
      : 'a whole number of lines (0 is allowed, and shows none)'
  return { why: `${name} has to be ${wants} — this call gave ${said}.` }
}

const readFace: ToolFn = async (args, host) => {
  const path = text(args, 'path')
  if (path === null) return missing('read', 'path')
  const offsetArg = wholeArg(args, 'offset')
  if ('why' in offsetArg) return no(offsetArg.why)
  const limitArg = wholeArg(args, 'limit')
  if ('why' in limitArg) return no(limitArg.why)
  const hasWindow = offsetArg.value !== null || limitArg.value !== null
  if (hasWindow) {
    const offset = offsetArg.value ?? 1
    const limit = limitArg.value ?? undefined
    const window: ReadWindow = { offset, ...(limit === undefined ? {} : { limit }) }
    let got: (ReadText & { readonly mode: number }) | null
    if (host.readTextWindow !== undefined) {
      got = await host.readTextWindow(path, window)
    } else {
      const raw = await host.readBytes(path)
      got = raw === null ? null : { ...textWindowOf(raw.bytes, window), mode: raw.mode }
    }
    if (got === null) return no(`no ${path} in the view (unreadable reads as absent — this layer does not tell the two apart).`)
    // **头里点出窗口**（`windowNoteOf`）：头里那两个数是整文件的，而截断标记里那两个是这一条
    // 回执的——不点明的话一条回执里就有两套各差一倍的数，谁都不知道哪个说的是哪件事。
    return ok(
      `${path} (${got.byteLength} bytes · ${got.lines} lines · mode ${got.mode.toString(8)}${windowNoteOf(got, offset)})\n` +
        numberedWindowOf(got, offset),
    )
  }
  const got = await host.readBytes(path)
  if (got === null) return no(`no ${path} in the view (unreadable reads as absent — this layer does not tell the two apart).`)
  const body = utf8Of(got.bytes)
  // 整文件读保持原样：统计和回执截断仍用 receipt.ts 的共同口径。
  // **这一档不带行号**，所以目录里那句描述只许把行号挂在切片那一档上（架构 § 8.10 只公布能
  // 兑现的选项）——两种格式混在一个 `read` 里的时候，模型拿到的 `old_string` 就带着 `N\t`。
  const lines = lineCount(body)
  return ok(
    `${path} (${got.bytes.byteLength} bytes · ${lines} lines · mode ${got.mode.toString(8)})\n${body}`,
  )
}

const writeFace: ToolFn = async (args, host) => {
  const path = text(args, 'path')
  const content = text(args, 'content')
  if (path === null) return missing('write', 'path')
  if (content === null) return missing('write', 'content')
  const { rev } = await host.writeBytes(path, bytesOf(content))
  // **不带修订号**：rev 是架构内部的坐标，模型不需要看（C 区那一侧同样不许出现环境标识）。
  return ok(`wrote ${path} (${Buffer.byteLength(content, 'utf8')} bytes).`)
}

const editFace: ToolFn = async (args, host) => {
  // **按目录公布的那几个名字读**（`old_string` · `new_string` · `replace_all`）——多一个都不读。
  // 名字对不上就是公布面与绑定面不一致，而模型只会按公布的那份给（实测烧掉过一格）。
  const path = text(args, 'path')
  if (path === null) return missing('edit', 'path')
  const find = text(args, 'old_string')
  if (find === null) return missing('edit', 'old_string')
  const replace = text(args, 'new_string')
  if (replace === null) return missing('edit', 'new_string')
  const raw: EditRaw = { kind: 'replace', find, replace, all: flag(args, 'replace_all') }
  const got = await host.edit(path, raw)
  if (!got.changed) return ok(`${path} unchanged (normalises to the current value); the view is still rev ${got.rev}.`)
  return ok(`${path}: replaced ${raw.all ? 'every occurrence' : 'one occurrence'}.`)
}

const readImageFace: ToolFn = async (args, host) => {
  const path = text(args, 'path')
  if (path === null) return missing('read_image', 'path')
  const got = await host.readBytes(path)
  if (got === null) return no(`no ${path} in the view.`)
  // **这一版不判像素，只报它是什么。** 真解码要一个图像库，而"运行时依赖不引入"是硬约束
  // （PLAN § 6）——所以这一格今天兑现的是"能把它原样取出来并说清多大"，不是"能看懂它"。
  return ok(`${path}: an image of ${got.bytes.byteLength} bytes (this version takes bytes only — it does not read pixels).`)
}

/**
 * 发现类那两条工具的**范围**：一条相对路径，可以指目录（含其后代），也可以直接指一条文件。
 *
 * **尾斜杠在这里归一掉**：`path: 'src/'` 不归一的话 `dir + '/'` 成了 `'src//'`、`path === dir`
 * 也不成立，候选集于是是空集。而空集在发现类工具上**看起来只是"真没有"**——一个字的错都不报。
 */
function scopeOf(raw: string | null, fallback: string): string {
  return (raw ?? fallback).replace(/\/+$/, '')
}

/** 这条路径在范围里吗。空范围 = 整个视图；范围指到一条文件时它自己也算在内。 */
function inScope(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(dir + '/')
}

/**
 * 路径模式**在范围内也配一次**（视图根相对的那一份之外）。
 *
 * `path: 'src'` 或 `cwd: 'src'` 之下，模型给的最自然的那个模式是 `*.ts`——它说的是"范围里的
 * 文件名"，而视图根相对的路径是 `src/a.ts`，`^[^/]*\.ts$` 配不上。这一条坑在 `glob` 工具上
 * 真烧过一格（见 `globToRe` 的注释：模型先 `find` 看见 `./count.ts`，再用惯常模式问 `glob`
 * 拿到空列表，四步全在 `find`/`ls`，写 0 条），而且**这一条不报错**。
 *
 * 两边取并：既认"从视图根看是这样"，也认"从范围里看是这样"。
 */
function matchesInScope(re: RegExp, path: string, dir: string): boolean {
  if (re.test(path)) return true
  return dir !== '' && path.length > dir.length && re.test(path.slice(dir.length + 1))
}

/**
 * 走一遍树**并带回这一趟枚举全不全**。
 *
 * 详细读口（`walkDetailed`）在场时它说得出"碰了哪个上限"；不在场时**完整性是"不知道"**
 * （`known: false`），不是"完整"——回执那一层据此说 `Enumeration completeness unavailable`，
 * 而不是替一次没做过的枚举打包票。生产宿主（`createToolHost`）一定带这个读口，`known: false`
 * 那一支只有旧宿主与夹具走得到。
 */
async function searchWalk(host: ToolHost): Promise<{ readonly paths: readonly string[]; readonly coverage: SearchCoverage }> {
  if (host.walkDetailed !== undefined) {
    const got = await host.walkDetailed()
    return { paths: got.paths, coverage: { known: true, truncated: got.truncated, limits: got.limits } }
  }
  return { paths: await host.walk(), coverage: { known: false, truncated: false, limits: [] } }
}

/**
 * 走一遍树。**走法归宿主**（`walk`）：它知道哪些行是目录、哪些是软链、能走多深。这一层只
 * 拿结果去配 `glob` 的语法（`**` 要不要跨 `/` 是模式那边的事）。
 */
const globFace: ToolFn = async (args, host) => {
  const pattern = text(args, 'pattern')
  if (pattern === null) return missing('glob', 'pattern')
  const dir = scopeOf(text(args, 'path'), '')
  const all = await searchWalk(host)
  const re = globToRe(pattern)
  // **路径匹配一个文件都不读**：枚举完整时命中总数是白捡的，所以先数出来、再截前缀。
  // 丢掉它就等于把可知的数说成 unknown，而模型最需要的恰好是"一共匹配 5000 条、我该收紧"。
  const hit = all.paths.filter((path) => inScope(path, dir) && matchesInScope(re, path, dir))
  const rows = new SearchRows()
  for (const path of hit) if (!rows.add(path)) break
  // 枚举自己不全（或完整性未知）的时候 `hit.length` 不是总数，那一档仍然不报。
  const total = all.coverage.known && !all.coverage.truncated ? hit.length : null
  return ok(rows.render('paths',`no path matches ${pattern}.`,all.coverage,total))
}

async function indexedCandidates(host: ToolHost, paths: readonly string[], required: readonly string[] | null): Promise<readonly string[]> {
  const original = [...paths]
  if (required === null) return original
  try {
    if (typeof host.filterCandidates !== 'function') return original
    // 可选提供者拿独立冻结副本；失败回原批，不能改原批/后续查询条件。
    const filtered = await host.filterCandidates(Object.freeze([...original]), Object.freeze([...required]))
    if (!Array.isArray(filtered)) return original
    const allowed = new Set(original)
    const kept = new Set<string>()
    for (const path of filtered) {
      if (typeof path !== 'string' || !allowed.has(path) || kept.has(path)) return original
      kept.add(path)
    }
    // 可选实现不许重排/注入路径；数据来源和逐行匹配仍在原路径上。
    return original.filter(path => kept.has(path))
  } catch {
    return original
  }
}

const grepFace: ToolFn = async (args, host, ctx) => {
  const pattern = text(args, 'pattern')
  if (pattern === null) return missing('grep', 'pattern')
  const dir = scopeOf(text(args, 'path'), ctx.cwd)
  const mode = args.output_mode === undefined ? 'content' : args.output_mode
  if (mode !== 'content' && mode !== 'files_with_matches' && mode !== 'count') {
    return no('grep output_mode must be content, files_with_matches, or count.')
  }
  if (args.glob !== undefined && typeof args.glob !== 'string') {
    return no('grep glob must be a path-pattern string.')
  }
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch (err) {
    return no(`that is not a regular expression: ${(err as Error).message}`)
  }
  const required = requiredLiteralTrigrams(pattern, re.flags)
  const pathPattern = typeof args.glob === 'string' ? globToRe(args.glob) : null
  const walked = await searchWalk(host)
  const all = walked.paths.filter(path =>
    inScope(path, dir) && (pathPattern === null || matchesInScope(pathPattern, path, dir)),
  )
  // 只预取筛后的候选。可选口缺席时仍逐文件读；失败仍由真源读口报出。
  let prefetch: ((paths: readonly string[]) => Promise<void | number>) | undefined
  try {
    prefetch = host.prefetch
  } catch {
    prefetch = undefined
  }
  const rows = new SearchRows()
  let batchRows = SEARCH_PREFETCH_ROWS
  scan: for (let at = 0; at < all.length;) {
    let batch = all.slice(at, at + batchRows)
    // 候选过滤也只做当前批；索引 miss 不许提前枚举/读取后面的全树。
    let candidates = await indexedCandidates(host, batch, required)
    // 最多预取当前批；回执够了以后不再预取后面整棵树。预取按字节封顶时只覆盖候选的前缀：读也只读
    // 这一段（至少一个，保证前进），批在第一条没覆盖的候选处截断，其余留给下一轮重新成批。
    if (prefetch !== undefined) {
      const covered = await prefetch(candidates)
      if (typeof covered === 'number') {
        const kept = Math.max(1, Math.min(covered, candidates.length))
        if (kept < candidates.length) {
          batch = batch.slice(0, batch.indexOf(candidates[kept]!))
          candidates = candidates.slice(0, kept)
        }
      }
    }
    at += batch.length
    for (const path of candidates) {
      const got = await host.readBytes(path)
      if (got === null) continue
      let count = 0
      for (const { line, number } of searchLines(utf8Of(got.bytes))) {
        if (!re.test(line)) continue
        count += 1
        if (mode === 'content' && !rows.add(`${path}:${number}:${line}`)) break scan
        if (mode === 'files_with_matches') break
      }
      // count 只提交扫描完这个文件后的精确数，未扫文件不冒充计过了。
      if (count > 0 && mode !== 'content' && !rows.add(mode === 'count' ? `${path}:${count}` : path)) break scan
    }
    // 首批小探针保住密集命中；回执还空时减少后续冷批请求，接近满时继续小批。
    batchRows = rows.fillRatio < 0.25 ? SEARCH_PREFETCH_MAX_ROWS : SEARCH_PREFETCH_ROWS
  }
  return ok(rows.render(mode === 'content' ? 'lines' : 'paths', `no line matches ${pattern}.`, walked.coverage))
}

// ── 执行类那两个 ───────────────────────────────────────────────────────────────

const bashFace: ToolFn = async (args, host, ctx) => {
  const command = text(args, 'command')
  if (command === null) return missing('bash', 'command')
  const timeoutMs = num(args, 'timeout_ms')
  // **`cwd` 读参数，不读上下文**（W8 冻结点第 2 句）：围栏把归一后的值**写回 `args.cwd`**，
  // 而 `ctx` 是进来时就定下的原始值；读上下文的后果是“执行侧收到原始路径、而 `run/start`
  // 收到归一后的”——两处读数不同一把尺。
  const cwd = typeof args['cwd'] === 'string' ? (args['cwd'] as string) : ctx.cwd
  const res = await host.run({ command, cwd, timeoutMs })
  // **回执里不带毫秒**（PLAN § 5.17 处二）：它是环境噪声，与 W6 拿掉的修订号同一类——
  // 模型不需要知道这一步花了多久，而它进 C 区之后就永远留在后面每一步的视野里。
  const head = `exit code ${res.exit}${res.denied ? ' · refused by the sandbox' : ''}`
  const body = [res.stdout === '' ? '' : `stdout:\n${res.stdout}`, res.stderr === '' ? '' : `stderr:\n${res.stderr}`]
    .filter((s) => s !== '')
    .join('\n')
  return { ok: res.exit === 0, output: body === '' ? head : `${head}\n${body}` }
}

/**
 * 具名动作。**它是唯一有声明集的那一格**（架构 § 8.9）：产出的字节经声明集回写视图。
 *
 * 回写的那一步归实现那一侧（`ToolHost.runAction`）——这一层不认识声明集，只知道"这一格与
 * `bash` 的差别是它可以回写"，而那句话在能力表里（`decl: true`），不在这儿。
 */
const runActionFace: ToolFn = async (args, host, ctx) => {
  const action = text(args, 'action')
  if (action === null) return missing('run_action', 'action')
  // **`args` 提净成字符串数组**（P3b1）：它是要追加到绑定 argv 尾上的那几个参数——不是自由参数包。
  const raw = arg(args, 'args')
  if (raw !== undefined && !Array.isArray(raw)) {
    return no('run_action args must be an array of strings appended to the action\'s command line — this is not an array.')
  }
  if (Array.isArray(raw) && raw.some((x) => typeof x !== 'string')) {
    return no('run_action args must be an array of strings — one of the entries is not a string.')
  }
  const extra = Array.isArray(raw) ? (raw as readonly string[]) : []
  // 与 `bash` 同一条：读围栏写回的那一份（见上面）。
  const cwd = typeof args['cwd'] === 'string' ? (args['cwd'] as string) : ctx.cwd
  const res = await host.runAction({ action, extra, cwd })
  // 与 `bash` 同一条：回执里不带毫秒。
  const head = `action ${action} exit code ${res.exit}`
  const body = [res.stdout, res.stderr].filter((s) => s !== '').join('\n')
  return { ok: res.exit === 0, output: body === '' ? head : `${head}\n${body}` }
}

// ── `log` 层那一个：只落日志，不碰视图 · 不起进程 ──────────────────────────────

/** 一行待办渲染成什么（回执进 C 区：模型下一步看得见自己写到哪一条了）。 */
function todoLine(t: TodoItem): string {
  return `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`
}

const todoWriteFace: ToolFn = async (args, host) => {
  const raw = arg(args, 'todos')
  if (raw === undefined || raw === null) return missing('todo_write', 'todos')
  if (!Array.isArray(raw)) return no('todo_write todos must be an array — this is not one.')
  const todos: TodoItem[] = []
  for (const one of raw) {
    if (one === null || typeof one !== 'object' || Array.isArray(one)) return no('one todo entry is not an object.')
    const row = one as Record<string, unknown>
    const content = typeof row['content'] === 'string' ? (row['content'] as string) : null
    const status = row['status']
    if (content === null) return no('one todo entry has no content — every entry has to say what the item is.')
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      return no(`one todo entry has a status outside the three (pending · in_progress · completed): ${String(status)}`)
    }
    todos.push({
      content,
      status,
      ...(typeof row['activeForm'] === 'string' ? { activeForm: row['activeForm'] as string } : {}),
    })
  }
  const r = await host.setTodos(todos)
  return ok(`todos recorded: ${r.count} (this whole list replaces the previous one):\n${todos.map(todoLine).join('\n')}`)
}

const askUserQuestionFace: ToolFn = async (args, host, ctx) => {
  const raw = arg(args, 'questions')
  if (raw === undefined || raw === null) return missing('ask_user_question', 'questions')
  if (!Array.isArray(raw)) return no('ask_user_question questions must be an array — this is not one.')
  if (raw.length === 0) return no('no question asked: look up what you can look up, and settle what you can settle yourself by "cleanest and most extensible".')
  if (raw.length > MAX_ASKS) {
    return no(
      `at most ${MAX_ASKS} questions per call (this one gave ${raw.length}) — a person can only answer so many at a time.` +
        ' Keep the most important ones and settle the rest yourself by "cleanest and most extensible", writing what you settled into the plan.',
    )
  }
  const asks: AskItem[] = []
  for (const one of raw) {
    if (one === null || typeof one !== 'object' || Array.isArray(one)) return no('one question is not an object.')
    const row = one as Record<string, unknown>
    const question = typeof row['question'] === 'string' ? (row['question'] as string) : null
    if (question === null || question === '') return no('one question has no question text — an empty question cannot be answered.')
    const options = Array.isArray(row['options'])
      ? (row['options'] as unknown[]).map((o) => {
          const r = o as Record<string, unknown>
          return {
            label: String(r['label'] ?? ''),
            ...(typeof r['description'] === 'string' ? { description: r['description'] as string } : {}),
          }
        })
      : undefined
    asks.push({
      question,
      ...(typeof row['header'] === 'string' ? { header: row['header'] as string } : {}),
      ...(row['multiSelect'] === true ? { multiSelect: true } : {}),
      ...(options === undefined ? {} : { options }),
    })
  }
  if (!ctx.holder) {
    return no('this is not your cell\'s job: you hold a contract, so do that one step — when something needs a human, carry the question back to the holder cell.')
  }
  await host.askUser(asks)
  return {
    ok: true,
    halt: true,
    // **回执只说实话**（PLAN § 5.17 处三）：两条路都真的存在了——门由人开（`fugue round go`），
    // 而"答完接着走"是 `fugue say <一句话>`：那句话进这一趟的尾端（C 区第一条），立刻带着它再跑
    // 一趟持轮者，答完就改这一版草案、重判、仍停在门口（架构 § 15.1.a 的"问与答"）。
    output:
      `asked ${asks.length} questions, and they are in the log. **This round stops at the door** — ` +
      'the human\'s answer goes in with `fugue say <one sentence>` (that pass takes the sentence along, and what it changes is this draft); ' +
      'letting it through is still `fugue round go`.',
  }
}

const exitPlanModeFace: ToolFn = async (args, host, ctx) => {
  const plan = text(args, 'plan')
  if (plan === null) return missing('exit_plan_mode', 'plan')
  const file = text(args, 'planFilePath')
  // 子 agent 调它：**不是错误，是角色不对**。它手里是一份契约，不是一份计划——所以回一句
  // 指得出出路的话（架构 § 8.4 纪律 2），不落事件、也不停。
  if (!ctx.holder) {
    return no('this is not your cell\'s job: you hold a contract, so do that one step — the plan is the holder\'s business in the first state.')
  }
  // **自报的那一条路径必须就是这一趟那一份**（S9 那条缺口的第二半）：`round plan` 读回来的
  // 是 `draftPathOf(round)` 那一条，模型报一个别处写的路径只会让那一栏与真源分家——而分家
  // 不报错，只表现为"草案不在视图里"。路径只有一个来源，所以这一栏是核对，不是第二个真源。
  if (file !== null && ctx.planPath !== undefined && file !== ctx.planPath) {
    const message =
      `planFilePath has to be this pass\'s own: ${ctx.planPath} — this one gave ${file}.` +
      ' There is only one draft and one written elsewhere does not count: whether that file was written is judged by its own content, not by this field.'
    await host.deny(refuse('plan-path', message, file))
    return no(message)
  }
  await host.declarePlan({ plan, ...(file === null ? {} : { path: file }) })
  return {
    ok: true,
    halt: true,
    // 与 `ask_user_question` 同一条：**门由人开**——`round plan` 停在门口，`fugue round go`
    // 才是发契约的那一下（架构 § 15.1.a）。这一趟只把计划落进日志。
    output:
      'the first state ends here: the plan is in the log. **This round stops at the door** — ' +
      'after a human reads it, `fugue round go` lets it through, and only then do the contracts go out.',
  }
}

// ── 真源层那一个 ───────────────────────────────────────────────────────────────

const checkpointFace: ToolFn = async (args, host) => {
  const msg = text(args, 'message')
  // **不给就报缺，不替它补一句**：目录里这一栏叫 `message`。原先那个 `?? '（未给说明）'`
  // 把"实现读的是另一个名字"这件事盖住了——每一次提交都叫同一个名字，而且不报错。
  if (msg === null) return missing('checkpoint', 'message')
  const { commit } = await host.checkpoint(msg)
  return ok(`committed: ${commit} — ${msg}`)
}

/**
 * 一个极小的 glob：`**` 跨 `/`（**零层目录也算**）、`*` 不跨 `/`、`?` 一个字符，其余按字面。
 *
 * **`**` 后面直接跟一个 `/` 时，它是"零层或多层目录"**（"零层或多层目录"那一档）：惯常那条
 * "两个星号、斜杠、再一个文件名模式"要匹配得上**根下的** `a.ts`——这是 glob 语法的本义，也是
 * 实测撞出来的：模型先 `find` 看见 `./count.ts`，再用那条惯常模式问 `glob` 却得到"没有匹配"，
 * 于是它一直绕、一个字都不写（`--max-steps 4` 那四步全是 `find`/`ls`，`写 0 条`）。**这一条
 * 不报错**：一个返回空列表的发现类工具看起来只是"真没有"。
 *
 * 两种写法分得开：中间带斜杠的那个 `**` 是"零层或多层"；单独一个 `**`（或在结尾那一档）仍然
 * 是"任意多字符"——`a` 那一层里的东西全匹配，但 `a` 自己不匹配。
 */
function globToRe(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i++
        }
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}
/**
 * 实现表。**它是"哪几条接上了"的唯一出处。**
 *
 * 今天十二条全部接上（视图类六条 · 执行类两条 · 真源层一条 · `log` 层三条）——**公布面与绑定面
 * 的差为 0**：目录里的每一条都跑得起来，"公布了却跑不起来"这条错路构造不出来。
 */
export const IMPLEMENTED: Readonly<Record<string, ToolFn>> = {
  todo_write: todoWriteFace,
  ask_user_question: askUserQuestionFace,
  exit_plan_mode: exitPlanModeFace,
  read: readFace,
  write: writeFace,
  edit: editFace,
  read_image: readImageFace,
  glob: globFace,
  grep: grepFace,
  bash: async (args, host, ctx) => {
    return bashFace(args, host, ctx)
  },
  run_action: runActionFace,
  checkpoint: checkpointFace,
}

/** 实现表里的名字，按目录的顺序（给"要一份名单"的地方用）。 */
export function implementedNames(names: readonly string[]): string[] {
  return names.filter((n) => IMPLEMENTED[n] !== undefined)
}

/**
 * 公布给模型的那一份：**目录 ∩ 实现表**。
 *
 * 交集算在这一处，是为了让"公布了却跑不起来"这条错路**构造不出来**——断言 ① 量的就是这句话
 * （把一条没实现的塞进公布名单，那一条当场变红）。
 */
export function publishedTools(names: readonly string[], entries: readonly ToolEntry[]): ToolEntry[] {
  return entries.filter((e) => IMPLEMENTED[e.name] !== undefined && names.includes(e.name))
}

/** 一次调用能不能跑。**没实现就是拒，话里指得出这一条从哪来。** */
export function faceOf(tool: string): ToolFn | null {
  const fn = IMPLEMENTED[tool]
  if (fn === undefined) return null
  return PATH_TOOLS.includes(tool) ? (args, host, ctx) => guardPath(() => fn(args, host, ctx)) : fn
}

/**
 * 一条工具**为什么**跑不起来时那句统一的话。给 `capability/dispatch.ts` 用。
 *
 * 它要说清两件事，因为它们是两件事：能力表里有没有这一格，以及这一格接上了没有。
 */
export function noFace(tool: string, c: Capability | Denied): FaceResult {
  const where = 'denied' in c ? `the capability table has no such row: ${c.message}` : `the capability table has it (${c.layer} layer · identity ${c.capability})`
  return no(`${tool} has no implementation wired today — ${where}. Wired today: ${Object.keys(IMPLEMENTED).join(' · ')}.`)
}
