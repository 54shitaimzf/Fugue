// cli 的共用那一半（U4a，2026-09 评审计划）：用法说明 · 参数解析 · 两列发射 · 围栏 · 命令上下文。
// 自 `fugue.ts` 抽出——那一文件自此只剩分发与各命令组（`cmd/`），这一份是它们共用的地基；
// 语义出处仍是架构 § 9.6：单次进程 + 每次重建。USAGE 的措辞 2026-09-29 重写成面向一般用户的
// 话（命令 · 开关 · 退出码一个没变；审阅口径与出处仍在架构 § 9.6 / § 9.8）。
import { resolve } from 'node:path'
import { openLog } from '../log/log.ts'
import type { LogHandle, SyncLevel } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import type { ReadBatch } from '../log/batch.ts'
import { BatchStaleError, batchOf } from '../log/batch.ts'
import type { TruthHandle } from '../truth/truth.ts'
import type { Roots } from '../roots/contract.ts'
import { createRoots } from '../roots/roots.ts'
import type { View } from '../view/contract.ts'
import { lowerFor } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import { readSnapshot } from '../view/snapshot.ts'
import type { PolicyMode, RelPath, ViewRev, WriterId } from '../terms.ts'
import { getConfig } from '../config.ts'
import type { ConfigDoc } from '../config.ts'

/** 用法错（旗子少一个值 · 互斥的两档一起给）：`run()` 那一层把它收成退出码 2。 */
// **一份错误词表**：这一类由值层定义（`value/types.ts`），这里只是把它摆回老位置。
// 从前这一文件另立过一个同名类，`instanceof` 于是分两种情况——值层那条特别的出口（`watch`）
// 抛出来的用法错逃到最外层就是裸异常：`--json` 那一面不再是一行 JSON，退出码也不是那四档。
import { UsageError } from '../value/types.ts'
export { UsageError }

// 出口那一层（USAGE · 两列发射 · 失败与用法错）本幕搬到 `cli/out.ts`：界面那一侧要它，
// 但不必把这一份（它 import 了账本与视图那一串）拖进界面的 import 闭包。名字原样再导出。
export { USAGE, emitJson, emitLine, fail, usageFail, emitFail } from './out.ts'

// 解析那一层（参数怎么切 · 哪几个开关取值 · 表外开关怎么拒）本批搬到 `cli/argv.ts`：入口那两条
// 不碰工作区的命令（`--version` · `--help`）只要它，而这一份还带着开视图那一串。名字原样再导出。
export { VALUED, parseArgv, unknownFlagsOf } from './argv.ts'
export type { Parsed } from './argv.ts'


/**
 * 命令行上那一档（架构 § 8.8 的 `Policy.mode`）：不给就是缺省档 `read-only`。
 * **`null` 是"敲错了"**（退出码 2），与"这一趟跑不成"（1）分开。
 */
export function modeOf(flags: Map<string, string | true>): PolicyMode | null {
  const raw = flags.get('mode')
  if (raw === undefined) return 'read-only'
  return raw === 'read-only' || raw === 'workspace-write' ? raw : null
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
  /** 这一趟只读批次绑定的那一份代（没绑就是 `null`：这条命令不是一批的一趟）。 */
  readonly batch: ReadBatch | null
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
  /**
   * **这一趟是"一批只读批次"的一趟**（架构 § 9.11 的第一句）：给了它，`openCtx` 在开视图的
   * 那一刻把这一批的**代**绑住（`log/batch.ts` 的 `batchOf`）。代有两种变，都算"整批作废"：
   * 开视图**期间**就有写入（当场抛），或者命令跑完之后代变了（`verifyBatch` 抛）。
   *
   * 不给就是"这条命令自己就是一趟"——CLI 那一侧永远不给。
   */
  batch?: string
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
    // **这一批的代：开视图之前绑**（架构 § 9.11）。开视图这一趟自己也要同代——它读的是日志，
    // 而期间落了一条就是"这一批读的是两代"。所以 `read()` 把 `loadView` 包在里面：期间有写入
    // 当场抛 `BatchStaleError`，而不是把一份拼了两代的视图交下去。
    const batch = opts.batch === undefined ? null : batchOf(opts.batch)
    const snap =
      opts.history === true
        ? null
        : await readSnapshot(root, writer, ceiling === undefined ? {} : { upToRev: ceiling })
    const view = await (batch === null
      ? loadView(
          log,
          writer,
          snap === null ? { lower, upToRev: opts.upToRev } : { lower, upToRev: opts.upToRev, snap },
        )
      : batch.read(() =>
          loadView(
            log,
            writer,
            snap === null ? { lower, upToRev: opts.upToRev } : { lower, upToRev: opts.upToRev, snap },
          ),
        ))
    const t = truth
    return {
      root,
      roots,
      log,
      truth: t,
      view,
      writer,
      batch,
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


/**
 * **把这一趟绑成"一批只读批次"**（架构 § 9.11 的第一句）。`a.batchRoot` 没给就是 `null`
 * ——CLI 那一侧因此走的是与从前逐字节相同的那条路（一次都不调 `generationOf`）。
 *
 * 判据本身住 `log/batch.ts`（代是每个 writer 日志文件的 `(size, mtimeMs)`），这一份只把它接到
 * 命令那一趟的首尾；值层那一格（`value/invoke.ts`）在两个地方各调一次。
 */
export function bindReadBatch(a: { readonly batchRoot?: string }): ReadBatch | null {
  return a.batchRoot === undefined ? null : batchOf(a.batchRoot)
}

/**
 * **这一趟读完再验一次代**（架构 § 9.11：期间有写入就整批作废，两代不拼接）。
 *
 * 代变了就抛——那句错话是 `log/batch.ts` 给的（它把两个代都印在里面）。**不静默重读**：重读
 * 是调用方的事（重开一批），而"悄悄再来一遍"会把一次作废变成一次更长的等待，人却看不出发生过。
 */
export async function verifyBatch(batch: ReadBatch | null): Promise<void> {
  if (batch === null) return
  await batch.read(() => undefined)
}

/** 那一批作废了（`verifyBatch` 抛的就是它）——壳按"做不成"（退出码 1）那一档认它。 */
export { BatchStaleError }
