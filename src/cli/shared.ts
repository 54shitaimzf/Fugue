// cli 的共用那一半（U4a，2026-09 评审计划）：用法说明 · 参数解析 · 两列发射 · 围栏 · 命令上下文。
// 自 `fugue.ts` 抽出——那一文件自此只剩分发与各命令组（`cmd/`），这一份是它们共用的地基；
// 语义出处仍是架构 § 9.6：单次进程 + 每次重建。USAGE 的措辞 2026-09-29 重写成面向一般用户的
// 话（命令 · 开关 · 退出码一个没变；审阅口径与出处仍在架构 § 9.6 / § 9.8）。
import { resolve } from 'node:path'
import { openLog } from '../log/log.ts'
import type { LogHandle, SyncLevel } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import type { Roots } from '../roots/contract.ts'
import { createRoots } from '../roots/roots.ts'
import type { View } from '../view/contract.ts'
import { lowerFor } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import { readSnapshot } from '../view/snapshot.ts'
import type { PolicyMode, RelPath, ViewRev, WriterId } from '../terms.ts'
import { KEYMAP, hintLimitOf, hintLineOf } from '../ui/keymap.ts'
import { getConfig } from '../config.ts'
import type { ConfigDoc } from '../config.ts'

/** 用法错（旗子少一个值 · 互斥的两档一起给）：`run()` 那一层把它收成退出码 2。 */
// **一份错误词表**：这一类由值层定义（`value/types.ts`），这里只是把它摆回老位置。
// 从前这一文件另立过一个同名类，`instanceof` 于是分两种情况——值层那条特别的出口（`watch`）
// 抛出来的用法错逃到最外层就是裸异常：`--json` 那一面不再是一行 JSON，退出码也不是那四档。
import { UsageError } from '../value/types.ts'
export { UsageError }

export const USAGE = `用法: fugue [--root <dir>] [--agent <id>] [--json] <command> [args]

fugue 是住在终端里的编码 agent：给它一句目标，它自己拆活、自己干、自己验，全部
通过才动你的文件。这张表只列命令；完整的上手走法在仓库的 README。

命令
  先看它在干什么（四条 · 全是只读）
  status --once              看这一刻的整体情况：轮次走到哪一步、每个任务干到哪儿、花了
                             多少 token。--metrics 多一组质量指标 · --report 多一组打回统计
  watch [--follow]           跟着看新事件。不给 --follow 就把现有的读完退出；给了就一直
                             等新的（Ctrl-C 停）。--interval <毫秒> 调轮询间隔（缺省 200）
  tui [--once] [--follow] [--full] [--tail <n>] [--no-style]
                             交互界面：底部一块面板显示情况，输出照常往上滚，翻历史 ·
                             搜索 · 复制都还是终端自己的。它只看不写，随时开随时关：
                             g 放行门口那批 · ? 重印按键提示 · q 退出
                             ${hintLineOf(KEYMAP, hintLimitOf(60))}
                             （上面是缺省键位 · fugue config set ui.keys.<动作> '<键串>' 可改）
                             --metrics / --report 与 status 同义；真终端上默认就跟着新事件走
                             --once 印一遍旧事件就退（管道 · CI 里自动是这一档，不写 ANSI）
                             --tail <n> 开始时只看最后 n 条旧事件（旧账很长时的入口）
                             --full 用整块屏幕（默认不用：那一档退出后滚动历史就没了）
                             默认带一点样式（框线与脚注暗一档 · 弹层加粗，不用颜色）；
                             --no-style 或环境变量 NO_COLOR 非空时全关
  log [--agent <id>]         把账原样列出来：一行一条事件，不做任何加工
  serve                      换一种进程角色：stdio 上一行一调用（JSON-RPC 2.0），给客户端连着问
                             用（仓库 tools/sample-client.mjs 是最小样例）。命绑客户端：stdin 一断它
                             就走收尾；没人问它 30 秒自己走——不引守护进程。参数只有 --root <dir>

  动文件与提交（动的是 fugue 眼里的那份视图，不直接是你的工作树）
  read <path>                读一个文件
  list [dir]                 列一个目录
  stat <path>                看一个路径的信息
  write <path> [--from <f>|--stdin]   写一个文件
  remove <path>              删（目录连同里面的）
  rename <from> <to>         改名
  chmod <path> <mode>        改权限：<mode> 是八进制（如 755）；只认「带不带执行位」两档，
                             没有变化就说一声，不进账
  diff [--since <rev>]       看改了哪些文件（相对某个修订点）
  commit -m <msg>            把当前内容定格成一个提交
  revs                       列出全部修订点（从早到晚）
  replay [--to <rev>]        从账重建内容；--verify 顺带校验两条重建路径算得一致
  branch <base>              把分支头定到 <base>（fork 之前的那一步；已经在这儿就不动）

  铺工作区（agent 干活的地方，随时能收走）
  fork <base> [--strategy <s>] [--ro <p1,p2>] [--no-preserve-mtime]
                             把 <base> 那棵树铺成一个独立工作区。--strategy 选
                             overlayfs / hardlink-ro / copy，不给就自动挑能用的
  ensure [--to <rev>]        把该落的改动落到铺出来的工作区
  diff-stat [<dir>] [--baseline <f>] [--save <f>]
                             全树快照对比（大小与哈希），看有没有意外改动
  run <action> [-- k=v…]     在隔离环境里跑一条配置里声明过的动作，比如
                             fugue config set actions.build '{"argv":["make"],"cache":["dist"]}'
                             「-- k=v」给它加环境变量。--mode read-only（默认）或
                             workspace-write 选隔离档。声明过的产物（cache · outputs）跑完
                             自动收回来；没声明的写入会被拦。退出码：0 成功 · 1 没成功
  verify-mat                 核对铺出来的工作区与账对不对得上（只报不修）
  dispose                    把铺出来的工作区收走（本来没有也成功）
  policy [<action>]          看隔离策略：能写哪里 · 能不能联网

  轮次（一句话 → 拆活 → 干 → 验 → 落地）
  round plan <目标> [--live] [--judge] [--max-steps <n>]
                             让它自己读项目、出计划：拆成几份活，停下来等你点头——这一步
                             不碰你的任何文件。--live 接真模型（要凭据 · 花钱）；--judge
                             不跑模型，直接拿手里那份计划给你判
  round go [--materialize]   点头放行：按计划每份活开一条分支开干。放行过再按会直接
                             拒绝、一个字节不落（不会重复发）
  round run <目标> [--live] [--max-steps <n>] [--retry <n>] [--report] [--metrics] [--materialize]
                             一趟跑完整个轮次：拆 → 干 → 验 → 合并。默认不联网不花钱
                             （打桩）；--live 才接真模型。验收断言从配置读：
                             fugue config set round.assertions '[…]'
                             全过才写提交；没过，你的文件一个都不会动。
                             合并之前它会把各份活要动的文件先对一遍：撞上了缺省只报
                             出来、不拦（要拦就给 --strict-merge-gate）
                             --max-steps <n> 每个任务最多几步（不给就是不设上界；第一次
                             联网建议给个位数）
                             另有几个走查开关（--fail · --deny · --poke · --dump-wire ·
                             --no-handoff），日常用不到
  round work [--live] [--max-steps <n>] [--retry <n>] [--report] [--metrics]
                             接着跑：把放行出去的那批任务跑完（round go 之后用）
  round new <目标> [--materialize]
                             按你配置里的草案（round.split）直接开一个轮次
  say <一句话> [--live] [--max-steps <n>]
                             跟它聊一句：说你的要求或限制，它记下来并照着调计划。
                             默认接真模型（花钱）

  装配
  assemble <protocol> [--agent <id>] [--against <protocol>]
                             把要发给模型的前缀拼出来核对（协议名 subagent 或 holder）：
                             三区哈希 · 每区字节数 · 四条约束
  环境与配置
  doctor                     环境自检：node · git · bwrap … 一项项报给你（只读；「缺」算
                             读数不算失败）
  config show                看全部配置
  config ls                  只列顶层键域（合法键有哪些），不读配置
  config get <key>           看一条（点分路径，如 round.id）
  config set <key> <value>   改一条（值能按 JSON 解析就当 JSON，否则当字符串）

选项
  --root <dir>    工作区根，默认当前目录；账在 <root>/.fugue/，配置在 <root>/.fugue/config。
                  要放在原生本地文件系统上（ext4 一类）；Windows 挂进来的盘（NTFS / 9p）
                  上拒绝启动
  --agent <id>    看哪个任务分支；默认 round（主线）
  --json          输出 JSON（给脚本用）
  --version       显示安装版本后退出（不用进工作区；可配 --json）
  --help          这张表

退出码：0 成了 · 1 没做成 · 2 命令敲错了。
写命令（write · remove · rename · chmod · commit · fork · ensure · run · dispose）同一个
agent 同时只许一条在跑，撞上了会报出是谁拿着；读命令从不加锁。
`

interface Parsed {
  flags: Map<string, string | true>
  positional: string[]
  /** `--` 之后那几段的原文。**只有 `run` 收它**（`-- k=v…` 的注入，§ 9.6 的执行行）。 */
  rest: string[]
}
export type { Parsed }

/**
 * 取值的选项。其余 `--x` 一律是开关——因为 § 9.6 的规范形是
 * `fugue [--root <dir>] [--agent <id>] [--json] <command>`，开关排在命令**前面**，
 * 一个贪心的解析器会把命令当成开关的值吃掉。
 */
const VALUED: ReadonlySet<string> = new Set([
  'root', 'agent', 'm', 'from', 'since', 'to', 'baseline', 'save', 'strategy', 'ro', 'step', 'mode', 'against',
  'split', 'fail', 'retry', 'poke', 'poke-exact',
  // `--dump-wire <目录>`：**它取一个值**。不列在这里的话 `--dump-wire /tmp/x` 里的 `/tmp/x`
  // 会被当成位置参数，而开关本身成了 `true`——于是要么误报用法错，要么把目录名当成轮次目标。
  'dump-wire', 'credential',
  // `--max-steps <n>`：同一条纪律——它取一个值，不列在这里那个数会被当成位置参数。
  'max-steps',
  // `--interval <毫秒>`（`watch --follow` 的轮询间隔）：同一条纪律。
  'interval',
  // `--tail <n>`（tui 首趟只写尾部 n 条，U15）：同一条纪律——不列在这里那个数会被当成位置参数。
  'tail',
  // `--wire-in <目录>`：**回放档**（PLAN § 5.12 序 1）。它也取一个值，同一条纪律；而它是**内部档**
  // ——不进用法说明：它要的是"录下来的那一趟"，只有取证与走查用得上。
  'wire-in',
  // `--model <id>`：模型选择（`round.model` 的旗标那一档，P2b）。同一条纪律——它取一个值。
  'model',
  // `--resume <游标串>`（watch 接着读，架构 § 9.11 的事件通道）：同一条纪律——它取一个值。
  // 不列在这里的话游标串会被当成位置参数，而 `--resume` 成了 `true`：接着读变成从零读。
  'resume',
  // `--wait <状态>` 与 `--timeout <秒>`（`status` 的等待糖）：同一条纪律——两个都取值。
  'wait', 'timeout',
  // `--idle-ms <毫秒>`（`serve` 的闲时阈值，走查与测试要一个短的）：同一条纪律。
  'idle-ms',
])
export { VALUED }

export function parseArgv(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // `--` 之后一律是原文：`k=v` 的值里可能有 `-`、有 `=`，再解析下去就是替人猜。
    if (a === '--') {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (!a.startsWith('-') || a === '-') {
      positional.push(a)
      continue
    }
    const long = a.startsWith('--')
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags.set(a.slice(long ? 2 : 1, eq), a.slice(eq + 1))
      continue
    }
    const key = a.slice(long ? 2 : 1)
    const next = argv[i + 1]
    if (VALUED.has(key) && next !== undefined && !next.startsWith('-')) {
      flags.set(key, next)
      i++
    } else {
      flags.set(key, true)
    }
  }
  return { flags, positional, rest }
}

/**
 * 命令行上那一档（架构 § 8.8 的 `Policy.mode`）：不给就是缺省档 `read-only`。
 * **`null` 是"敲错了"**（退出码 2），与"这一趟跑不成"（1）分开。
 */
export function modeOf(flags: Map<string, string | true>): PolicyMode | null {
  const raw = flags.get('mode')
  if (raw === undefined) return 'read-only'
  return raw === 'read-only' || raw === 'workspace-write' ? raw : null
}

export function emitJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v) + '\n')
}

export function emitLine(s: string): void {
  process.stdout.write(s + '\n')
}

/** 「做不成」（1）：§ 9.8 退出码行。`json` 面一行 `{code:1, message}`（U7 全量接线）。 */
export function fail(msg: string, json = false): number {
  return emitFail({ code: 1, message: msg }, json)
}

/** 「敲错了」（2）：整张 USAGE 只进人面。`json` 面一行 `{code:2, message, hint}`（U7 全量接线）。 */
export function usageFail(msg: string, json = false): number {
  return emitFail({ code: 2, message: msg, hint: '跑 fugue --help 看整张表' }, json)
}

/**
 * § 9.8 契约表「错误」行（U6）：`{ code, message, hint, subject }`——`--json` 那一面
 * stderr 写**一行 JSON**，`hint` 指向正确的替代能力（§ 24 纪律 5）。
 *
 * **人读那一面逐字照旧**：message 走 stderr；用法错（code 2）把整张 USAGE 跟在后面——
 * 与 `usageFail` 印的字节相同。**USAGE 全文不进 JSON**——机器要的是 `code` 与 `hint`，
 * 不是一张表，所以用法错的 `hint` 给「跑 fugue --help」；`subject` 是这句错说到的那个
 * 东西（一条开关 · 一条路径），没说到就不出现。stdout 一个字节不写（stdout 纪律那一行），
 * 退出码就是 `code`（0/1/2/3 四档不动）。
 */
export function emitFail(
  o: { code: number; message: string; hint?: string; subject?: string },
  json: boolean,
): number {
  if (json) {
    process.stderr.write(
      JSON.stringify({
        code: o.code,
        message: o.message,
        ...(o.hint === undefined ? {} : { hint: o.hint }),
        ...(o.subject === undefined ? {} : { subject: o.subject }),
      }) + '\n',
    )
    return o.code
  }
  process.stderr.write(o.code === 2 ? `${o.message}\n\n${USAGE}` : `${o.message}\n`)
  return o.code
}

/**
 * 原始输入 → 视图内的路径，或者**围栏那句给人看的话**（`Denied.message` 里带着指路）。
 *
 * **命令行的文件工具都走这里**（架构 § 8.4 硬纪律 1 的"唯一入口"）。视图那一步的路径检查（`throw
 * new Error`）拒得出这一类输入，可它的文案里没有去处；围栏里那份 `Denied` 本来就是给人看的整
 * 句，所以这里
 * 不另造一句话，只把两种结果分清楚：出来的要么是一条视图内的路径，要么是一句话。
 *
 * **它只拿 `Roots`，不拿开好的视图**：这条路要在开视图之前走完——一条用法错、或者路径走出
 * 工作区的命令，不该在磁盘上留下一个日志目录（`cli/fugue.test.ts` 里那条断言在管这个）。
 *
 * 基准目录是**工作区的根**：命令行没有"当前目录"这一维（壳让人在任何目录里敲 `fugue`），
 * 凡是相对的输入都相对根读。空串与 `.` 因此都读成根。
 */
/** 围栏那两半。**带 `ok` 分**：路径与消息都是字符串，`typeof` 分不开。 */
export type Fenced = { readonly ok: true; readonly rel: RelPath } | { readonly ok: false; readonly message: string }

export function fence(roots: Roots, raw: string): Fenced {
  const r = roots.resolveVirtual(raw, '')
  return r.ok ? { ok: true, rel: r.value } : { ok: false, message: r.error.message }
}

/**
 * `--agent` 决定操作哪个视图，等价于选择一份日志（§ 9.6）。未指定时取主线：`round` 是
 * 持轮者这个位置的名字，它在 git 侧的落点是 `refs/heads/main`（§ 4）——所以不带参数读到
 * 的视图，与 git 侧的主干是同一段历史。
 */
export function writerOf(flags: Map<string, string | true>): WriterId {
  const a = flags.get('agent')
  return (typeof a === 'string' ? a : 'round') as WriterId
}

/**
 * 这一趟用哪个模型：**旗标 > 配置（`round.model`）> 没说**。**"没说"交回 `undefined`**——
 * 缺省那条由 `modelDeclOf` 按"表的第一条"给（与 `--agent` 不给走主线同一条口径）：
 * "没写 model"与"写了一个没有的 model"是两件事，后者在查表那一步当场拒并列出目录。
 *
 * 配置里那栏给了却不是非空字符串，是写错了一个字——照 `--max-steps` 那条纪律当场拒，
 * 不静默读成"没配"（拼错被咽下去与"今天没配"在读数上分不开）。
 */
export function selectedModelId(flag: string | undefined, doc: ConfigDoc): string | undefined {
  const v = flag ?? getConfig(doc, 'round.model')
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v === '') {
    throw new UsageError(`round.model 要是一个模型名字（目录里有的那几个），拿到的是 ${JSON.stringify(v)}`)
  }
  return v
}

export interface Ctx {
  root: string
  /**
   * 这一份落点。**命令行这一层要用的那一处**是 `resolveVirtual`：原始输入 → 视图内的路径，
   * 或者一条带指路的拒绝（架构 § 8.4 硬纪律 1 的"唯一入口"）。
   */
  roots: Roots
  log: LogHandle
  truth: TruthHandle
  view: View
  writer: WriterId
  close(): Promise<void>
}

export interface OpenOptions {
  /**
   * 要变更序列的命令（`diff`）。**快照换掉的正是历史**，所以这些命令明说不看快照——
   * 加速项不该在任何一处改变语义，答不上来的问题就得从 0 重放。
   */
  history?: boolean
  upToRev?: ViewRev
  /**
   * 快照的上界（默认跟 `upToRev` 一样）。**它是"问哪一份快照"，与"视图载到哪儿"分开**：
   * `ensure` 既要把视图载到目标 rev，又只敢用 rev ≤ 清单那个 rev 的快照——不然
   * `diff(清单的 rev)` 会撞上"比快照早的历史不在它里面"（§ 9.4 那条结构性的限制）。
   */
  snapUpTo?: ViewRev
  /** 日志的耐久档位。提交点用 `each`（§ 9.5 把提交点与检查点列在同一档）。 */
  sync?: SyncLevel
  /**
   * 这条命令**会改状态**：于是它要取该 agent 的锁（`hold.ts`），整条命令一个写者。
   * 写组（`write` · `remove` · `rename` · `chmod` · `commit` · `fork` · `ensure` · `dispose`）
   * 给 `true`；读命令一律不给——架构 § 9.7 把加锁与预取并列，观察不得影响状态。
   */
  write?: boolean
}

/**
 * 一条命令要的三样：日志 · 真源 · 视图。
 *
 * **base 取该 agent 的 ref 现在指向的提交**：视图 = 该提交 + 这个 agent 自己写过的路径。
 * 提交把视图定格成一个新的提交点之后，base 随之前移——上层仍然带着这次 agent 写过的
 * 全部路径，所以读出不变。
 */
export async function openCtx(
  root: string,
  flags: Map<string, string | true>,
  opts: OpenOptions = {},
  given?: Roots,
): Promise<Ctx> {
  const writer = writerOf(flags)
  // 这一份落点：命令行过围栏要它（`pathOrMessage`），`read` · `list` · `stat` 也顺手用它。
  // **无状态，所以可以传进来**：写命令那一支要在开视图之前先过围栏。
  const roots = given ?? createRoots(resolve(root))
  // **锁在这里取、整条命令握着**（`close()` 里放）：写命令要挡的不止「追加那一下」——
  // `ensure` 的挂载与落地那两段同样不许有第二个进程插进来（PLAN § 5.3 的疑点第一条）。
  const log = openLog(root, {
    ...(opts.sync === undefined ? {} : { sync: opts.sync }),
    ...(opts.write === true ? { write: writer, ...clockOption(flags) } : {}),
  })
  let truth: TruthHandle | null = null
  try {
    truth = openTruth(root)
    const lower = await lowerFor(truth, writer)
    // 有快照就从快照起（§ 9.4 的第一步）：这一步只影响快慢，影响不到读出来的东西——
    // `diff` 那种要历史的命令在上面的 `history` 里被排除掉了。
    const ceiling = opts.snapUpTo ?? opts.upToRev
    const snap =
      opts.history === true
        ? null
        : await readSnapshot(root, writer, ceiling === undefined ? {} : { upToRev: ceiling })
    const view = await loadView(
      log,
      writer,
      snap === null ? { lower, upToRev: opts.upToRev } : { lower, upToRev: opts.upToRev, snap },
    )
    const t = truth
    return {
      root,
      roots,
      log,
      truth: t,
      view,
      writer,
      close: async () => {
        await log.close()
        await t.close()
      },
    }
  } catch (err) {
    await log.close()
    if (truth !== null) await truth.close()
    throw err
  }
}

export async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Uint8Array))
  return Buffer.concat(chunks)
}

/**
 * **认不得的开关当场拒**（退 2），不静默收下（§ 9.8「认得的开关才收」）。
 *
 * 为什么这一族要拒：写错的开关被咽下去之后，人看到的是"命令跑了、什么都没变"——那与"这个开关
 * 今天没用"在读数上分不开（`log --grep x` 找不到东西，与"日志里没有匹配"也是同一张脸）。用法
 * 错是 2，做不成是 1，两者不许混（架构 § 9.8）：收下一个不认识的开关属于**命令行不成立**。
 *
 * 报的话里把**这一条命令认的那几个**印出来：拒一条命令时，人要知道的是"那该怎么办"。
 */
export function unknownFlagsOf(
  cmd: string,
  flags: Map<string, string | true>,
  allowed: readonly string[],
): string | null {
  const bad = [...flags.keys()].filter((k) => !allowed.includes(k))
  if (bad.length === 0) return null
  return (
    `${cmd} 不认这几个开关：${bad.map((k) => '--' + k).join(' · ')}——这一条命令认的是 ` +
    allowed.map((k) => '--' + k).join(' · ')
  )
}

/**
 * `--no-clock`（写面上那道开关）：给了它，这一条命令写进账的行**不带信封钟**——那一档与这三栏
 * 之前编出来的行逐字节相同。只对会写账的命令有意义，所以只有写组那几张开关表收它。
 *
 * 模板一行：调用处 `...clockOption(flags)`，不给就一个键都不加（`openLog` 的缺省是给钟）。
 */
export function clockOption(flags: Map<string, string | true>): { clock?: boolean } {
  return flags.has('no-clock') ? { clock: false } : {}
}

export function parseOctal(raw: string): number {
  const text = raw.trim().replace(/^0o?/, '')
  if (!/^[0-7]{3,4}$/.test(text)) throw new UsageError(`模式要八进制三位或四位：${raw}`)
  return parseInt(text, 8)
}
