// fugue 的观察组（`log` · `status` · `watch` · `tui`）——U4c 自 `cli/fugue.ts` 抽出，
// 内容逐字未动（出处：架构 § 9.6 那张观察表 · PLAN § 5.18 的 W12/W13 · § 5.19 的 UI2–UI4）。
// **全是纯读**：不建视图、不取锁、不追加——所以它们排在建视图那一组之前。
import type { LogEvent } from '../../log/events.ts'
import { openLog } from '../../log/log.ts'
import type { LogPos, RelPath } from '../../terms.ts'
import { phaseOf } from '../../model/price.ts'
import { readings, readingsLines } from '../../probe/status.ts'
import type { StatusRow } from '../../probe/status.ts'
import { follow, readNew } from '../../probe/watch.ts'
import { ctrlCStepOf, escStepOf, quitStepOf, stillArmed } from '../../ui/cancel.ts'
import { openTui, tuiModeOf } from '../../ui/follow.ts'
import { degradeNote, openTerm } from '../../ui/term.ts'
import type { ViewInput } from '../../ui/term.ts'
import { KEYMAP, fallsToText, helpRowsOf, hintLimitOf, hintLineOf, openKeys } from '../../ui/keymap.ts'
import type { KeySource } from '../../ui/keymap.ts'
import { applyIntent, emptyEditor, inputFrameOf, intentOf, modeOf, rememberSubmit, submitOf } from '../../ui/input.ts'
import type { Editor } from '../../ui/input.ts'
import { acceptOf, candidatesOf, clampSel, completeOf, moveSel, pathsOf, queryOf, rowsTextOf, specsOf } from '../../ui/menu.ts'
import type { MenuRow, MenuSource } from '../../ui/menu.ts'
import { GATE_KEEP, GATE_VIEW, gateFaceOf, gateRowsOf, lineOf, pressGate, stepAt } from '../../ui/gate.ts'
import type { GateFace, GateOption, GateView } from '../../ui/gate.ts'
import { EMPTY_QUEUE, dropLastOf, enqueueOf, queueRowOf, shiftOf } from '../../ui/queue.ts'
import type { QueueState } from '../../ui/queue.ts'
import { pendingOf } from '../../round/dispatch.ts'
import { identFor } from '../../identity.ts'
import { getConfig, readConfig } from '../../config.ts'
import { FLAGS_OF } from '../flags.ts'
import { GO_LINE, openRun } from '../../ui/run.ts'
import type { RunLauncher } from '../../ui/run.ts'
import { actionCommandsOf, actionsTableOf } from './round.ts'
import { emitJson, emitLine, usageFail } from '../shared.ts'

export function emit(pos: LogPos, e: LogEvent, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ pos, e }) + '\n')
    return
  }
  const { t, ...payload } = e as { t: string } & Record<string, unknown>
  const keys = Object.keys(payload)
  const brief = keys.map((k) => `${k}=${JSON.stringify(payload[k])}`).join(' ')
  process.stdout.write(`${pos.writer}\t${pos.seq}\t${t}\t${brief}\n`)
}

// 观察组的四张开关表（LOG/WATCH/TUI/STATUS_FLAGS）与 `unknownFlagsOf` 自 U8 起收进
// `fugue.ts` 的 FLAGS_OF（全命令族一张张声明过的表，分发处统一过）——这一组不再各查各的。

/**
 * `status --once`：**把账重放一次，给人看这一刻的处境**（PLAN § 5.18 的第 12 格）。
 *
 * 纯读两头都占了：开日志口**不带 `write`**（不取锁、不追加）、不建视图、不碰真源。`--once` 是
 * 今天唯一的一档——跟随是另一条命令（`watch --follow`），两条各自只说一件事，不在这里合流。
 *
 * **序 32 给它加了两个开关**：`--metrics`（八元指标）与 `--report`（打回三数），与 `round run` /
 * `round work` 上同名同义——同一个来源（`probe/metrics.ts` · `probe/round.ts` 那两处折法）、
 * 同一个渲染（`readingsLines`）。于是 `--json` 那一份对象去掉 `width` / `height` 就是 TUI 的输入
 * 契约（`ui/frame.ts` 的 `FrameInput`）：命令面与第一个渲染器读的是同一份，不许有两份。
 */
export async function statusCmd(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const log = openLog(root)
  try {
    // 钱那一栏要一个档：**读的时候按当时的钟算**（官方价目分峰谷两档）。
    const phase = phaseOf(new Date())
    const r = await readings(log, { metrics: flags.has('metrics'), report: flags.has('report') })
    if (json) {
      // **没要的那一栏不出现**（不是空数组）：`JSON.stringify` 丢掉没定义的键，于是这一份对象
      // 去掉 `width` / `height` 就是 `FrameInput`。
      emitJson(r)
      return 0
    }
    for (const line of readingsLines(r, { phase })) emitLine(line)
    return 0
  } finally {
    await log.close()
  }
}

/**
 * `--interval <毫秒>`（`watch` 与 `tui` 同一个意思：跟随那一趟睡多久）。给一个数，或者给一句
 * 用法错的话——两处各写一遍的话，"多少算合法"这件事就漂了。
 */
function intervalOf(flags: Map<string, string | true>): number | string {
  const raw = flags.get('interval')
  if (raw === undefined) return 200
  if (typeof raw !== 'string') return '--interval 要一个数：--interval 200'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return `--interval 要一个正整数（毫秒），拿到 ${JSON.stringify(raw)}`
  return n
}

/**
 * `watch`：**顺着 NDJSON 账读**（PLAN § 5.18 的第 13 格）。
 *
 * 两档只有一件事不同：不给 `--follow` 就把账上有的念一遍就停；给了就一直跟着，直到人按 Ctrl-C
 * （`SIGINT` → 拨信号 → 生成器收尾 → **退出码 0**：人喊停不是失败）。
 */
export async function watchCmd(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const interval = intervalOf(flags)
  if (typeof interval === 'string') return usageFail(interval, json)
  const intervalMs = interval
  const only = flags.get('agent')
  const log = openLog(root)
  const ac = new AbortController()
  const onSig = (): void => ac.abort()
  process.on('SIGINT', onSig)
  const print = (row: StatusRow): void => {
    if (typeof only === 'string' && row.pos.writer !== only) return
    emit(row.pos, row.e, json)
  }
  try {
    if (!flags.has('follow')) {
      const p = await readNew(log, {})
      for (const row of p.rows) print(row)
      return 0
    }
    for await (const row of follow(log, { intervalMs, signal: ac.signal })) print(row)
    return 0
  } finally {
    process.removeListener('SIGINT', onSig)
    await log.close()
  }
}

/**
 * `fugue tui`：**同一读面的第二档渲染**（PLAN § 5.19 第五段 · `UI2`/`UI3` 那两格 · 架构 § 9.8 的可附着
 * TUI）。它一个新读源都不开：这一份只做三件事——把开关翻成那一档（`tuiModeOf`）、开那一块地方
 * （`openTerm`）、把信号接上。读账（`probe/watch.ts` 的 `follow()`）· 折帧（`readingsOf` 与
 * `ui/stream.ts` 的分法）· 擦与摆（`ui/term.ts`）都在 `ui/follow.ts` 那一格里接起来。
 * **它不写日志、不取锁、不新增事件**——一轮正在跑时照样读。
 *
 * 四档地板，各自的地板各自说得出（PLAN § 5.19）：
 *
 *   · **真终端**：底部一块恒定 K 行的面板，跟着账重画（`follow()` 那一趟驱动，不另设定时器），
 *     `SIGWINCH` 到了按新宽度另起一块，`Ctrl-C` 收走面板退出（**退出码 0**：人喊停不是失败）；
 *   · **`--once`**：印一遍永久行就退（面板不画）——它自己是"瞬态区那一档"的地板；
 *   · **不是 TTY**（管道 · CI · `node --test`）：与 `--once` 同一档，**一个字节的 ANSI 都不写**；
 *     要一直跟着（`| tee` 那种用法）得明说 `--follow`——一条在 CI 里永不返回的命令是坑；
 *   · **`$TERM` 是 `dumb` 或认不出来**：退到"只印永久行"那一档（`ui/term.ts` 那张表说了算）。
 *
 * TTY 那一档不给 `--follow` 也是跟着的（面板就是为这个）；管道那一档不给就是把账上有的印一遍就停
 * ——两档的缺省不一样，各自都写在上面这一句里。
 *
 * **`UI4` · 门那儿按一下**（PLAN § 5.19 第五段那一行 · 架构 § 9.8「人的每个状态动作都是一条命令」）：
 * 只在面板那一档收按键（`ui/keymap.ts` 那张表），按 `g` 起一次 `fugue round go`（`ui/run.ts`）——
 * **界面不写日志、不持写句柄**，账由那个子进程写；它吐出来的行与收尾那一下走 `tui.note()`（写在
 * 面板上方）。`?` 把按键那一行重印一遍。
 *
 * **退出与取消是两条写死次序的链**（`T5` · 判据在 `ui/cancel.ts`，这一份只照着做）：`Esc` 五级
 * ——关一层弹层 → 打断在途的那一趟 → 丢排队草稿 → 清空输入 → 什么都不做；`Ctrl-C` 三层——有在途
 * 就打断 · 空闲时按一下只举手、3 秒内再按一次才退。`Ctrl-D`/`q`/`Q` 才是"退出"，且**只在输入行
 * 空着的时候**（raw mode 下 `SIGINT` 不再由终端发出来，所以这些字节都在键表里）；那一趟还跑着时
 * 第一次按是等它收尾、第二次是硬退。
 *
 * **`T4` · 输入行与弹层**：底部那块地方在面板**下面**多一行（块）输入行——模型是 `ui/input.ts`，
 * 接线在这一份。三个入口开同一套候选（`ui/menu.ts`）：`/` 是命令（**从 `cli/flags.ts` 的
 * `FLAGS_OF` 推**，与分发处读同一份）、`Ctrl-P` 是键表（提示行 · 帮助面板 · 这一屏，第三处渲染）、
 * `@` 是工作区里的路径。
 *
 * **界面不留第二份真相**：输入模式是从行首那个 `/` 推的（`modeOf`）· 面板在筛什么也是从行里推的
 * （`queryOf`）——把那个记号删掉，面板自己就关了。选中一条**不是执行**：它只换掉这一行字，发不发
 * 仍然归 `Enter` → `ui/run.ts` 那一格（`T3`：一行字 → argv → 子进程）。**打字是缺省路**（表里没
 * 吃掉的可打印字符走 `insert`），表里那几条可打印字符的绑定只在行里没字时是动作。
 *
 * **`T6` · 门口那一批**：账停在门口时，面板最下面多出那一块——预览（按类型分派）· 队列行（还有
 * 几份 · 第几份）· 三档（`y` 放行 · `n` 拒 · `Esc` 中止）。那一批**从账上重算**（`pendingOf`：与
 * `round go` 是同一个函数），折成界面那一份（`gateFaceOf`）。**"界面不留第二份真相"在这一格也是
 * 同一条**：没有一个"允许"这样的状态，也没有"允许过"这样的记忆——记忆只在账上（`round/approve`），
 * 界面这一头只有"这一刻账上停在门口的是哪一批"，账一往前动就重算。`y`/`n` 那两档**不是全局键**：
 * 只在门口那一块开着、且输入行空着的时候是动作，别处它们就是人打的字。
 *
 * **`T7` · 排队**：忙的时候打的那几条**入队**（可见：排队那一行说得出条数与下一条；可撤：`Esc`
 * 第三级一条一条地丢），跑完一趟取一条起。**排队是界面自己的草稿队列，不是账**——账上只有"这一趟
 * 起过什么"，没有"还等着跑什么"（§ 5.19 六：这一版不做"改当前那一趟"，那要子进程收得下 stdin）。
 */
export async function tuiCmd(root: string, flags: Map<string, string | true>): Promise<number> {
  // `--json` 不在 tui 的开关表里（机器读的那一份是 `status --json`），但**错误那一面照样认它**：
  // 脚本敲 `fugue --json tui` 撞上开关表时（分发处拒），该拿到的是一行 JSON（§ 9.8 的错误行）。
  const json = flags.has('json')
  if (flags.has('once') && flags.has('follow')) {
    return usageFail('--once 与 --follow 说不到一起：一个是印一遍就退，一个是一直跟着', json)
  }
  const interval = intervalOf(flags)
  if (typeof interval === 'string') return usageFail(interval, json)
  // 钱那一栏要一个档（与 `status --once` 同一个口径：读的时候按当时的钟算）。
  const phase = phaseOf(new Date())
  const log = openLog(root)
  const term = openTerm({ out: process.stdout })
  // 四条地板收成**一张表**（`ui/follow.ts` 的 `tuiModeOf`）：真终端 → 面板；`--once` / 不是 TTY /
  // `$TERM` 认不出来 → 只印永久行那一档（面板一次都不画，一个字节的 ANSI 都不写）。
  const mode = tuiModeOf({ ansi: term.ansi, once: flags.has('once'), follow: flags.has('follow') })
  // **降级说一声**（U10a）：真终端而 `$TERM` 认不出来——面板那一档整个没了，人得知道
  // 为什么。`--once` 不说：那一档本来就不画面板，没有"退"这回事（判据在 `degradeNote`，
  // 与 `ansiOf` 同一张表）。
  const degrade = degradeNote(process.env.TERM, process.stdout.isTTY)
  if (degrade !== null && !flags.has('once')) process.stderr.write(`${degrade}\n`)
  const ac = new AbortController()
  const onSig = (): void => ac.abort()
  process.on('SIGINT', onSig)
  // 接上那一档：读账 → 折帧 → 摆到那一块地方，一路跟着（`ui/follow.ts`）。
  // ── `T4` · 界面自己那几样（**纯视图状态**：进程一退就没了）──────────────────────────────
  // 次序上它们得先立起来：`openTui` 每折一帧都要问它们（`view` 那个闭包）。**这一份里没有第二份
  // 真相**：输入模式从行首那个 `/` 推（`modeOf`）、弹层在筛什么也从行里推（`queryOf`）——于是
  // "面板在筛什么"与"行里有什么"永远不打架。
  let ed: Editor = emptyEditor()
  /** 弹层（这一格只有一层：菜单/面板/路径）。`null` = 没有弹层。 */
  let panel: { readonly source: MenuSource; readonly sel: number; readonly paths: readonly string[] } | null = null
  /** 输入行画不画：`stdin` 不是终端就不画（画一个收不到按键的提示符，比不画坏得多）。 */
  let showInput = false
  /** 命令面那一张表（**分发处读的是同一份**：`cli/flags.ts` 的 `FLAGS_OF`）。 */
  const specs = specsOf(FLAGS_OF)
  /** 键表那一档的候选：提示行 · 帮助面板 · 这一屏，三处同一张表（`ui/keymap.ts`）。 */
  const keyRows = (): readonly MenuRow[] => helpRowsOf().map((name) => ({ name, note: '', kind: 'key' as const }))
  const rowsOf = (source: MenuSource): readonly MenuRow[] =>
    candidatesOf({ specs, keys: keyRows(), paths: panel?.paths ?? [], line: ed.draft.text, source })
  /** 提示符：`»` 是命令、`>` 是话（模式是从行推出来的，不是另存的一个开关）。 */
  const promptOf = (): string => (modeOf(ed.draft) === 'Command' ? '» ' : '> ')
  // ── `T6` · 门口那一批：**从账上重算**（与 `round go` 同一个函数），折成界面那一份 ──────────────
  // 三样输入与 `round go` 那一趟逐样对上：轮次号与绑好的动作表来自工作区配置，身份分配器是同一个
  // （`identFor`——门只认契约集合，而集合里带着身份，两边换一个就发错一批而且不报错）。
  let round = 'r1'
  let actionsTable: Readonly<Record<string, readonly RelPath[]>> = {}
  let commands: Readonly<Record<string, string>> = {}
  let configWhy: string | null = null
  try {
    const doc = await readConfig(root)
    const raw = getConfig(doc, 'round.id')
    if (typeof raw === 'string' && raw !== '') round = raw
    actionsTable = actionsTableOf(doc)
    commands = actionCommandsOf(doc)
  } catch (err) {
    // 配置读不出来**不是退出的理由**（这一档是观察窗）：门口那一块不画，说一句为什么。
    configWhy = err instanceof Error ? err.message : String(err)
  }
  /** 上一次算出来的那一批（`编号:份数`）：一样就不重画（账每动一行都算，值当的只有那几次）。 */
  let lastGate: string | null = null
  /**
   * 重算门口那一批。**只在账真的往前动了那两族事件时走**（`round/*` 与 `holder/*`：处境 · 意图 ·
   * 草案 · 放行都在这两族里）；`llm/call` 那些一行一行的高频事件不重算——一趟读全量日志是 O(行数)，
   * 拿它去乘每一行就等于把跟随这一档拖垮。
   */
  const refreshGate = async (): Promise<void> => {
    if (configWhy !== null) return
    let next: GateFace | null = null
    try {
      const v = await pendingOf({ log, round, identityFor: (n: number) => identFor(round, n), actions: actionsTable })
      if (v.kind === 'held') {
        next = gateFaceOf(
          {
            round: v.pending.round,
            fingerprint: v.pending.fingerprint,
            same: [...v.pending.same],
            contracts: [...v.pending.built.contracts],
          },
          commands,
        )
      }
    } catch {
      // 账读到一半炸了（日志被换掉 · 权限变了）：门口那一块收掉——读账那一头自己会报。
      next = null
    }
    const key = next === null ? null : `${next.fingerprint}:${next.cards.length}`
    if (key === lastGate) return
    lastGate = key
    gate = next
    gateHidden = false
    // **批次换了就把选中那一份与举手那一栏都归零**：上一批举过的手不许带到这一批上。
    gateView = GATE_VIEW
    tui.redraw()
  }
  const view = (): ViewInput => {
    if (!showInput) return {}
    // 宽度减一：终端上写满一整行会**自动换行**，那一下就把"上移几行"的算术打乱了（`ui/term.ts` 头注）。
    const frame = inputFrameOf({ e: ed, prompt: promptOf(), width: term.columns - 1 })
    // 最下面那一栏：**门口那一块**（`T6`）与**排队那一行**（`T7`），都在面板那一栏的最下面（输入行
    // 还在它们下面）。两样都没有时一个字节都不占。
    const gateOn = gate !== null && !gateHidden
    const queueOn = queue.items.length > 0
    const bottomRows = [
      ...(gateOn ? gateRowsOf({ face: gate as GateFace, view: gateView, columns: term.columns - 1 }) : []),
      ...(queueOn ? [queueRowOf(queue, term.columns - 1)] : []),
    ]
    const bottomPart =
      bottomRows.length === 0
        ? {}
        : { bottom: { rows: bottomRows, keep: (gateOn ? GATE_KEEP : 0) + (queueOn ? 1 : 0) } }
    return {
      ...(panel === null ? {} : { menu: { rows: rowsTextOf(rowsOf(panel.source)), sel: panel.sel } }),
      ...bottomPart,
      input: { rows: frame.rows, caret: frame.caret },
    }
  }
  const tui = openTui({
    log,
    term,
    emit: emitLine,
    mode,
    view,
    // 账往前动一条就问一次（`T6`）：门口那一批要不要重算——重算只在 `round/*` 与 `holder/*` 那两族
    // 上走（见 `refreshGate`），所以这里只排一件事，不在这一趟里读账。
    onAdvance: (rows) => {
      if (rows.some((r) => r.e.t.startsWith('round/') || r.e.t.startsWith('holder/'))) void refreshGate()
    },
    readings: { metrics: flags.has('metrics'), report: flags.has('report') },
    phase,
    intervalMs: interval,
    signal: ac.signal,
  })
  // resize：**只重画**，不重读（宽度变了账没变）；新的那一块落在哪由 `ui/term.ts` 那一档决定。
  const onWin = (): void => tui.redraw()
  if (mode === 'panel') process.on('SIGWINCH', onWin)

  // ── `UI4` · 门那儿按一下（只在"面板"那一档）──────────────────────────────────────────
  // 按 `g` 起的是**一条命令**（`ui/run.ts` 的 `openRun` → 一个子进程），账由那个子进程写。界面手里
  // 没有写句柄这件事在**类型上**就成立：`openTui` 收的 `log` 只有 `readMerged` 那一半。
  let keys: KeySource | null = null
  let go: RunLauncher | null = null
  /** 按过退出、而那一趟还跑着：等它收尾再退（不打断一轮正在跑的——账要完整）。 */
  let leaving = false
  /**
   * `Ctrl-C` 上一次"举手"的时刻（`T5`：空闲时按它只举手，3 秒内再按一次才退）。**钟只在调用方
   * 读**：`ui/cancel.ts` 那一份不碰钟，于是"3 秒"那一档在测试里不用真等（`stillArmed` 收的是
   * "现在几点"）。
   */
  let armedAt: number | null = null
  /**
   * 门口那一批（`T6`）那一块。**它不是授权**：界面手里没有一个"允许"这样的状态，也没有"允许过"
   * 这样的记忆——记忆只在账上（`round/approve`），这里存的是"这一刻账上停在门口的是哪一批"。
   * 账一往前动（`round/*` 或 `holder/*`）就重算一遍（`refreshGate`）。
   */
  let gate: GateFace | null = null
  /** 界面自己那两样（选中第几份 · 举过手没有）。**纯视图状态**，一个字节都不进账。 */
  let gateView: GateView = GATE_VIEW
  /** 按过 `Esc` 把那一块收起来了没有（账再动一次它自己回来）。 */
  let gateHidden = false
  /**
   * 排队那几条（`T7`）。**界面自己的草稿队列，不是账**：账上只有"这一趟起过什么"，没有"还等着跑
   * 什么"——所以它进程一退就没了，也不该有第二个读者。忙的时候打的那几条进这里，跑完一趟取一条。
   */
  let queue: QueueState = EMPTY_QUEUE
  /**
   * 跑完一趟要不要**自动**接着起下一条（`T7`）。缺省要；**被 `Esc` / `Ctrl-C` 打断之后不要**——
   * 人刚说了停，排队那几条停在那儿等他（`Enter` 起下一条 · `Esc` 丢掉）。起新的一条时又回到"要"。
   */
  let advanceQueue = true
  if (mode === 'panel') {
    /** 起一次弹层：选中项从头一条起（候选变了以后 `settle` 会把它夹回来）。 */
    const openPanel = (source: MenuSource): void => {
      // 路径那一档的候选**开的时候走一遍**（`@` 不该在每一次重画时把树重读一遍）；命令与键表是
      // 静态的，每次都现推——它们本来就只有一处真源。
      panel = { source, sel: 0, paths: source === 'path' ? pathsOf(process.cwd()) : [] }
    }
    /**
     * 每一下按完都走这里：**弹层跟着输入行走**——查询词没了（`@` 被删掉）就自己关掉，候选少了就把
     * 选中那个下标夹回来，然后重画一帧（输入行与弹层都在那一帧里）。
     */
    const settle = (): void => {
      if (panel !== null) {
        panel =
          queryOf(ed.draft.text, panel.source) === null
            ? null
            : { ...panel, sel: clampSel(rowsOf(panel.source).length, panel.sel) }
      }
      tui.redraw()
    }
    /**
     * 退出那一下（`Ctrl-D`/`q`/`Q`，且输入行空着——判据在 `ui/cancel.ts` 的 `quitStepOf`）。
     * **跑着的时候第一次按是"等它收尾"、第二次才是硬退**（"退出必须两次"）：账要完整，一轮正在跑的
     * 不替人打断——要打断有它自己的两下（`Esc` 与 `Ctrl-C`）。
     */
    const leave = (): void => {
      if (go?.running === true) {
        if (!leaving) {
          leaving = true
          tui.note('那一趟还在跑：等它收尾就退出（账要完整）。再按一次是硬退，或者 Esc / Ctrl-C 打断它')
          return
        }
        tui.note('硬退：那一趟的输出接不上了（它自己的账照写，写到哪算哪）')
      }
      ac.abort()
    }
    /** `Esc` 第二级与 `Ctrl-C` 第一级都走这一下：把信号递给在途的那一趟（同一句话只说一遍）。 */
    const breakRun = (): void => {
      go?.stop('SIGINT')
      // **打断之后不自动接着起下一条**（`T7`）：人刚说了停，排队那几条就停在那儿等人（`Enter`
      // 起下一条 · `Esc` 丢掉）。不这么定的话，`Esc` 链第三级（丢排队草稿）**永远够不着**——
      // 一趟被打断、`onDone` 立刻起下一条，队列那一栏就又回到"跑着"了。
      advanceQueue = false
      tui.note('打断了那一趟（SIGINT）：它自己那份账照写，写到哪算哪。排队那几条停着等你（Enter 起下一条）')
      settle()
    }
    /**
     * 起排队里队头那一条（有货 · 没在跑才起得动）。返回"起了没"。
     *
     * 起不动（这一档还没开 · 正在跑）就**什么都不做**——排队那几条照旧在队里，不许悄悄吞掉。
     */
    const startNext = (): boolean => {
      if (go === null || go.running) return false
      const taken = shiftOf(queue)
      if (taken.next === null) return false
      queue = taken.q
      const next = taken.next
      const cut = go.argvOf(next.line, next.mode)
      if (cut.why !== null) {
        tui.note(`排队里那条起不了：${cut.why}（跳过它，接着看下一条）`)
        return false
      }
      tui.note(`起了排队里的下一条：\`${next.line}\`（${cut.argv.join(' ')}）`)
      go.press(next.line, next.mode)
      return true
    }
    /**
     * 门口那一批那一档**真生效**（二段确认的第二下）。放行 = 起一次 `fugue round go`（`ui/gate.ts`
     * 的 `lineOf`：**与 `g` 那一键同一条命令**——界面里没有第二条放行路径）；拒 = **什么都不跑**
     * （一个字节都不落，门照旧停着等人）。
     */
    const takeGate = (option: GateOption): void => {
      const line = lineOf(option)
      if (line === '') {
        tui.note(
          `拒了门口那一批（${gate?.cards.length ?? 0} 份）：一个字节都没落——门照旧停着，要改就 /say 一句再判一次`,
        )
        settle()
        return
      }
      if (go === null || go.running) {
        tui.note('那一趟还在跑：这一下先没发出去（排队是 T7 那一格的事）')
        settle()
        return
      }
      tui.note(`按了 ${option === 'approve' ? 'y' : 'n'}：起一次 \`${line}\`（${go.argvOf(line).argv.join(' ')}）`)
      go.press(line)
      settle()
    }
    go = openRun({
      root,
      // 子进程吐出来的行、与它收尾那一下，都**走注记**（写在面板上方）：直接写 `stdout` 会在
      // 终端历史里插进半块面板。
      onLine: (line) => tui.note(line),
      onDone: (r) => {
        if (r.why !== null) tui.note(`这一趟起不来：${r.why}（手敲一遍看看：${go?.last.join(' ') ?? ''}）`)
        else if (r.code !== 0) tui.note(`那一趟退了 ${r.code ?? '（信号）'}（账照写：写到哪算哪）`)
        if (leaving) {
          ac.abort()
          return
        }
        // **跑完一趟就起排队里的下一条**（`T7`）：一条一条地起（`ui/run.ts`"一次只起一个进程"
        // 那条不变量一个字没动，动的是"人打的第二条去哪儿"）。被 `Esc` 打断过的那一趟不起
        // （`advanceQueue`：人刚说了停）。
        if (advanceQueue) startNext()
        tui.redraw()
      },
    })
    keys = openKeys({
      input: process.stdin,
      out: process.stdout,
      onAction: (d) => {
        // ⓪ **门口那一批那两档**（`T6`）：开关是"门口那一块开着没有 **且** 输入行空着没有"——不是
        // `actsOnEmpty` 判的"行里有没有字"（那一条判的是键入的处境，而 `y` / `n` 是可打印的，门口
        // 那一块关着的时候它们就是人打的字）。二段确认的判据只有一处（`ui/gate.ts` 的 `pressGate`）：
        // 按一下只举手，再按同一个键或 `Enter` 才生效。
        if (d.action === 'approve' || d.action === 'reject') {
          const option: GateOption = d.action === 'approve' ? 'approve' : 'reject'
          if (gate !== null && !gateHidden && ed.draft.text === '') {
            const press = pressGate(gateView, option)
            gateView = press.view
            if (press.t === 'arm') {
              const label = option === 'approve' ? '放行' : '拒'
              tui.note(
                `举了手：再按一次 \`${option === 'approve' ? 'y' : 'n'}\`（或 Enter）就${label}这一批` +
                  `（${gate.cards.length} 份 · 批号 ${gate.fingerprint}）`,
              )
              settle()
              return
            }
            takeGate(option)
            return
          }
          // 门口那一块关着（或者行里有字）：**它就是个字**。
          if (d.key !== undefined) {
            ed = applyIntent(ed, { t: 'insert', text: d.key })
            settle()
          }
          return
        }
        // ① **行里已经有字的时候，表里那几条绑定要分两种去处**：按的是可打印字符就让位成那个字
        // （`q` 就是 `q`，不然 `/round go` 里那个 `g` 会把这一行当场发出去），按的是控制字符就丢掉
        // ——`Ctrl-D` 要是也当字打进去，输入行里会多一个看不见的字节，而"行里没字"这个前提恰好被它
        // 自己毁掉（判据在 `ui/keymap.ts` 的 `fallsToText`，喂它的只有这一处）。
        if (fallsToText(d.action, d.key, ed.draft.text, ed.draft.caret)) {
          ed = applyIntent(ed, { t: 'insert', text: d.key as string })
          settle()
          return
        }
        // ② `?`：把按键那一行重印一遍（写在面板上方，只写一次）。
        if (d.action === 'help') {
          tui.note(hintLineOf())
          return
        }
        // ③ **取消与退出那一组**（`ui/cancel.ts` 那两条链 + 退出那一条——判据全在那一份里，这一份
        // 只把"那一刻的处境"喂进去、照着出来的那一个动作做）。
        //
        // `Esc` 五级（`escStepOf`）：关一层弹层 → 打断在途的那一趟 → 丢排队草稿 → 清空输入 → 什么都
        // 不做。级与级之间没有商量：上头那一级够得着，下头那几级这一下就不动（"这一次 `Esc` 到底关
        // 了什么"是这类界面最常被骂的一处，所以每一级各有一条反向的钉，见 `cancel.test.ts` ①）。
        if (d.action === 'cancel' || d.action === 'interrupt' || d.action === 'quit') {
          if (d.action === 'cancel') {
            const step = escStepOf({
              // **门口那一块是 `Esc` 链最外那一级**（`T6`）：它开着（且行是空的）就只收它。
              atGate: gate !== null && !gateHidden,
              overlays: panel === null ? 0 : 1,
              running: go?.running === true,
              // 排队那几条（`T7`）：一条都没有时这一级够不着（次序不变——在途那一趟压着它）。
              queued: queue.items.length,
              line: ed.draft.text,
              searching: ed.search !== null,
            })
            if (step === 'gate') {
              gateView = { ...gateView, armed: null }
              gateHidden = true
              tui.note('收起了门口那一块（账再动一次它自己回来；要放行还得按 y）')
              settle()
              return
            }
            if (step === 'overlay') {
              panel = null
              settle()
              return
            }
            if (step === 'break') {
              breakRun()
              return
            }
            if (step === 'dropQueue') {
              // **丢掉最后那一条**（一路上按就一条一条地撤）：那几条是草稿，不是账——丢了就没了。
              const before = queue.items.length
              queue = dropLastOf(queue)
              const done = queue.items.length === 0
              tui.note(
                `丢掉了排队里最后那一条（${before} → ${queue.items.length} 条）` +
                  (done ? '；队列空了' : `；下一条：${queue.items[0]?.line ?? ''}`),
              )
              settle()
              return
            }
            if (step === 'clearLine') {
              // 输入行那一层自己有两小级（先退反查、再清空这一行），都在 `ui/input.ts` 的 `cancelAt`。
              ed = applyIntent(ed, { t: 'cancel' })
              settle()
              return
            }
            return
          }
          // `Ctrl-C`（`ctrlCStepOf`）：有在途就打断它；空闲时按一下只举手、3 秒内再按一次才是退出。
          // **打断那一下不举手**：在途的时候按它说的是"把这一趟停下来"，不是"我要走了"。
          if (d.action === 'interrupt') {
            const step = ctrlCStepOf({ running: go?.running === true, armed: stillArmed(Date.now(), armedAt) })
            if (step === 'break') {
              breakRun()
              return
            }
            if (step === 'quit') {
              leave()
              return
            }
            armedAt = Date.now()
            tui.note('再按一次 Ctrl-C 就退出（3 秒内）')
            return
          }
          // `Ctrl-D`/`q`/`Q`：**只在输入行空着的时候退**（`quitStepOf`）；行里有字时什么都不做——说
          // 一句为什么，不然按下去看着像没反应（这一句只有 `Ctrl-D` 打得出：`q` 行里有字时让位成人
          // 打的字，上面 ① 那一档就把它收走了）。
          if (quitStepOf({ line: ed.draft.text }) === 'none') {
            tui.note('输入行里还有字：先清掉它（Esc）或者把它发出去，再按 Ctrl-D 退出')
            settle()
            return
          }
          leave()
          return
        }
        // ④ `g`：放行门口那一批（起一次 `fugue round go`）。跑着的时候按不起了第二次（同一条命令
        // 不叠第二个进程）——排队与打断是 `T7` 的事。
        if (d.action === 'go') {
          if (go === null || go.running) return
          tui.note(`按了 g：起一次 \`${GO_LINE}\`（${go.argvOf(GO_LINE).argv.join(' ')}）`)
          go.press(GO_LINE)
          return
        }
        // ⑤ 三个入口（`/` · `Ctrl-P` · `@`）开同一套候选表，**看的是这一行现在是什么**（来源从行里
        // 推，不另存一个开关）：命令行 → 命令那一张（`FLAGS_OF`，与分发处读同一份）· 别处 → 键表 ·
        // `@` → 工作区里的路径。`/` 与 `@` 先把那个记号打进这一行——记号在，那个来源才在。
        if (d.action === 'menu' || d.action === 'panel' || d.action === 'mention') {
          if (d.action === 'menu') ed = applyIntent(ed, { t: 'insert', text: '/' })
          if (d.action === 'mention') ed = applyIntent(ed, { t: 'insert', text: '@' })
          const src: MenuSource =
            d.action === 'mention' ? 'path' : d.action === 'menu' || ed.draft.text.startsWith('/') ? 'cmd' : 'keys'
          openPanel(src)
          settle()
          return
        }
        // ⑥ `Enter`：弹层开着就是"认下选中那一条"（**只换掉这一行字，不执行**）；关着就把这一行
        // 发出去（`T3` 那一格：一行字 → argv → 子进程，账由那个子进程写）。
        if (d.action === 'submit') {
          // 门口那一块举着手的时候，`Enter` 是**那一档的确认键**（§ 5.19 五："同一个键或 `Enter`
          // 再按一次才生效"）；没举手时它照旧是提交（`pressGate` 给 'none'，一个副作用都没有）。
          if (gate !== null && !gateHidden && gateView.armed !== null) {
            const press = pressGate(gateView, 'confirm')
            gateView = press.view
            if (press.t === 'do') takeGate(press.option)
            return
          }
          if (panel !== null) {
            const rows = rowsOf(panel.source)
            const picked = rows[clampSel(rows.length, panel.sel)]
            if (picked !== undefined) {
              const next = acceptOf(ed.draft.text, panel.source, picked)
              if (next !== null) ed = applyIntent(ed, { t: 'setLine', text: next })
            }
            panel = null
            settle()
            return
          }
          const line = submitOf(ed)
          if (line === '') {
            // **空行按下去而排队里还有货**：那是"起下一条"（`T7`）——被 `Esc` 打断之后队列停在
            // 那儿等人，这一下就是等人那一下。
            startNext()
            settle()
            return
          }
          // 模式**在这一行还是原样的时候**取：交出去之后手里就换成新的一行了。
          const lineMode = modeOf(ed.draft)
          ed = rememberSubmit(ed, line)
          if (go === null || go.running || queue.items.length > 0) {
            // **忙就入队**（§ 5.19 六："空闲 → 直接跑；忙 → 入队（可见 · 可撤）"）。那一行在上面
            // 已经记进历史（`rememberSubmit`），于是人按 `↑` 翻得回来——队列只是"等着跑的那几条"，
            // 而它不是账（进程一退就没了）。
            //
            // **排队里已经有货时，新打的那一条也进队尾**（FIFO：不许插到前面去），而"起"的是队头
            // 那一条——不是刚打的这一条。
            queue = enqueueOf(queue, { line, mode: lineMode })
            if (!go.running && startNext()) {
              settle()
              return
            }
            tui.note(
              `入队（排队 ${queue.items.length} 条，跑完一趟起一条；Enter 起下一条 · Esc 丢掉最后一条）`,
            )
            settle()
            return
          }
          const cut = go.argvOf(line, lineMode)
          if (cut.why !== null) {
            tui.note(`这一行起不了：${cut.why}`)
            settle()
            return
          }
          tui.note(`发了这一行：\`${line}\`（${cut.argv.join(' ')}）`)
          advanceQueue = true
          go.press(line, lineMode)
          settle()
          return
        }
        // ⑦ `Tab`：补全（候选从行推：命令那一档补命令名，别处补手里那个词）。补不动就什么都不做
        // ——在各面板之间轮换是 `T8` 的事。
        if (d.action === 'complete') {
          const source: MenuSource = panel?.source ?? (ed.draft.text.startsWith('/') ? 'cmd' : 'keys')
          const next = completeOf({ rows: rowsOf(source), line: ed.draft.text, source })
          if (next !== null) ed = applyIntent(ed, { t: 'setLine', text: next })
          settle()
          return
        }
        // ⑧ `↑`/`↓`：**门口那一块开着且行是空的时候**在那一批里走（`index/total` 就是它）；弹层开着
        // 时是选项（表里那两行的说明写的就是这个）；都没有时是输入历史。
        if (
          (d.action === 'historyOlder' || d.action === 'historyNewer') &&
          gate !== null &&
          !gateHidden &&
          ed.draft.text === ''
        ) {
          gateView = {
            ...gateView,
            at: stepAt(gate.cards.length, gateView.at, d.action === 'historyOlder' ? -1 : 1),
          }
          settle()
          return
        }
        if ((d.action === 'historyOlder' || d.action === 'historyNewer') && panel !== null) {
          const n = rowsOf(panel.source).length
          panel = { ...panel, sel: moveSel(n, panel.sel, d.action === 'historyOlder' ? -1 : 1) }
          settle()
          return
        }
        // ⑨ 剩下的编辑动作（`ui/input.ts` 认的那些）一律进输入行；别的（`focus` 那一档导航）还没
        // 接线，安静丢掉——与"认不出来的字节丢掉"同一条。
        const it = intentOf(d.action, d.text ?? '')
        if (it === null) return
        ed = applyIntent(ed, it)
        settle()
      },
    })
    // 第一件事：把按键那一行印出来（写在面板上方；翻上去了按 `?` 再印一次）。
    // **stdin 不是终端就不印它**（`stdout` 是终端而 `stdin` 不是：面板照画，可按键收不到）——
    // 印一行"按 g 放行"而按下去没反应，是这一档最坏的一种体验。
    showInput = keys.raw
    // 按键那一行**按屏幕宽度取前几条**（28 条接线的动作整行印出来 438 列，终端会折成五行）；
    // 剩下的那一句说清还有几条、去哪儿看全部（`Ctrl-P` 那一屏）。
    tui.note(
      keys.raw
        ? hintLineOf(KEYMAP, hintLimitOf(term.columns))
        : 'stdin 不是终端：这一档不收按键（输入行与弹层都在等按键，画出来是骗人）',
    )
  }
  // **每一条退出路径都要把终端还原回去**（计划 § 5.19 里 DECSTBM 那笔账在 raw mode 上是同一笔：
  // 漏一条，那台终端就得人 `reset`）。四路：正常退 · `Ctrl-C`（raw mode 下走按键那一头）·
  // `SIGTERM`/`SIGHUP` · 崩了（`exit` 那一钩，最后一次同步地把 raw mode 关掉）。
  const onTerm = (): void => ac.abort()
  if (mode === 'panel') {
    process.on('SIGTERM', onTerm)
    process.on('SIGHUP', onTerm)
    process.once('exit', () => {
      keys?.close()
      term.close()
    })
  }
  // 读账在 `try` 里：读炸了也要走到 `finally` 去把日志口与面板收干净。
  try {
    await tui.counts
    return 0
  } finally {
    process.removeListener('SIGINT', onSig)
    if (mode === 'panel') {
      process.removeListener('SIGWINCH', onWin)
      process.removeListener('SIGTERM', onTerm)
      process.removeListener('SIGHUP', onTerm)
    }
    // **raw mode 先还原、面板再收走**：两条都幂等，正常退那一路与 `exit` 那一钩都走到这里。
    keys?.close()
    term.close()
    await log.close()
  }
}
