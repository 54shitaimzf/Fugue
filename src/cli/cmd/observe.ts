// fugue 的观察组（`log` · `status` · `watch` · `tui`）——U4c 自 `cli/fugue.ts` 抽出，
// 内容逐字未动（出处：架构 § 9.6 那张观察表 · PLAN § 5.18 的 W12/W13 · § 5.19 的 UI2–UI4）。
// **全是纯读**：不建视图、不取锁、不追加——所以它们排在建视图那一组之前。
import type { LogEvent } from '../../log/events.ts'
import { openLog } from '../../log/log.ts'
import type { LogPos, RelPath } from '../../terms.ts'
import { phaseOf } from '../../model/price.ts'
import { readCatalog } from '../../model/catalog.ts'
import { readings, readingsLines } from '../../probe/status.ts'
import type { StatusRow } from '../../probe/status.ts'
import { follow, readNew } from '../../probe/watch.ts'
import { KEYMAP, hintLimitOf, hintLineOf, openKeys } from '../../ui/keymap.ts'
import type { KeySource } from '../../ui/keymap.ts'
import { openTui, tuiModeOf } from '../../ui/follow.ts'
import type { Tui } from '../../ui/follow.ts'
import { degradeNote, openTerm } from '../../ui/term.ts'
import { themeOf } from '../../ui/theme.ts'
import { openStage } from '../../ui/stage.ts'
import { gateFaceOf } from '../../ui/gate.ts'
import type { GateFace } from '../../ui/gate.ts'
import { openRun } from '../../ui/run.ts'
import type { RunLauncher } from '../../ui/run.ts'
import { pendingOf } from '../../round/dispatch.ts'
import { identFor } from '../../identity.ts'
import { getConfig, readConfig } from '../../config.ts'
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
    // 价目与模型目录按这一台算（P2d：`~/.fugue/models.json` 在就是它）。
    const cat = readCatalog()
    const only = flags.get('agent')
    const r = await readings(log, {
      metrics: flags.has('metrics'),
      report: flags.has('report'),
      ...(typeof only === 'string' ? { agent: only } : {}),
    })
    if (json) {
      // **没要的那一栏不出现**（不是空数组）：`JSON.stringify` 丢掉没定义的键，于是这一份对象
      // 去掉 `width` / `height` 就是 `FrameInput`。
      emitJson(r)
      return 0
    }
    for (const line of readingsLines(r, { phase, cat })) emitLine(line)
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
 * `--tail N`（U15）：**首趟**永久行只写尾部 N 条——旧账几百行时不用翻半天才到活的那些；之后的
 * 新行照常增量。不给 = 全印（与从前逐字节相同）。要一个正整数，别的都是用法错（退出码 2，
 * 与 `--interval` 同一道门）。跳过的前几条**不折了也不印**：旧账想全看有 `fugue log` /
 * `fugue watch`，这一档是"接着看"的入口。
 */
function tailOf(flags: Map<string, string | true>): number | undefined | string {
  const raw = flags.get('tail')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return '--tail 要一个数：--tail 40'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return `--tail 要一个正整数（条数），拿到 ${JSON.stringify(raw)}`
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
    // 一趟一批（U4）：印出去的字节与逐条那一档逐字相同——变的是跟随器吐的形状，不是印的内容。
    for await (const batch of follow(log, { intervalMs, signal: ac.signal })) {
      for (const row of batch) print(row)
    }
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
 * **`--full`（`T10`）不改这四档**：它只给"画得出来"的那一档多两个 escape（`ui/term.ts` 的 `ALT_ON` /
 * `ALT_OFF`：进 alt screen 与出来），**排版一行不动**。缺省关，因为进了 alt screen 就没有本终端的
 * 历史可翻（永久行跟着那一块屏一起消失）。四条退出路径都走到同一处 `term.close()`（`SIGTERM` ·
 * `SIGHUP` 那一头 `abort` 之后走 `finally`；崩了走 `exit` 那一钩），出来那一条写在里面。
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
  // `--tail N`（U15）：首趟只写尾部 N 条（判据在 `tailOf` 那一道门里）。
  const tail = tailOf(flags)
  if (typeof tail === 'string') return usageFail(tail, json)
  // 钱那一栏要一个档（与 `status --once` 同一个口径：读的时候按当时的钟算）。
  const phase = phaseOf(new Date())
  // 价目与模型目录按这一台算（P2d，与 `status --once` 同一份）。
  const cat = readCatalog()
  const log = openLog(root)
  // ── `T6` 的三样输入（与 `round go` 那一趟逐样对上）─────────────────────────────────────
  // 轮次号与绑好的动作表来自工作区配置，身份分配器是同一个（`identFor`——门只认契约集合，而集合
  // 里带着身份，两边换一个就发错一批而且不报错）。配置读不出**不是退出的理由**（这一档是观察窗）：
  // 门口那一块不画，说一句为什么。
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
    configWhy = err instanceof Error ? err.message : String(err)
  }
  /** 算门口那一批折成那一面（U21 起 `refreshGate` 住在舞台里，它只收这一只函数）。 */
  const pendingFace = async (): Promise<GateFace | null> => {
    if (configWhy !== null) return null
    const v = await pendingOf({ log, round, identityFor: (n: number) => identFor(round, n), actions: actionsTable })
    if (v.kind !== 'held') return null
    return gateFaceOf(
      {
        round: v.pending.round,
        fingerprint: v.pending.fingerprint,
        same: [...v.pending.same],
        contracts: [...v.pending.built.contracts],
      },
      commands,
    )
  }
  const ac = new AbortController()
  const onSig = (): void => ac.abort()
  process.on('SIGINT', onSig)
  // ── 舞台（U21）：纯视图状态 + ⓪–⑩ 键表分派整个在 `ui/stage.ts` ──────────────────────────
  // deps 全是**晚绑定的函数**：`tui` / `run` 那些句柄在下面才建起来，而 `openTui` 构造时就要
  // `view` / `onAdvance`——所以舞台先立着，句柄经 `ui` 那个盒子递（`?.` 一路，没建起来就是
  // 「还没有那回事」）。
  const ui: { tui: Tui | null; go: RunLauncher | null } = { tui: null, go: null }
  const stage = openStage({
    note: (line) => ui.tui?.note(line),
    redraw: () => ui.tui?.redraw(),
    columns: () => term.columns,
    // 终端行数（分账面板高度那一档的输入；`rows` 那一只 dep 是「账上的行」，名字各归各）。
    termRows: () => term.rows,
    rows: () => ui.tui?.session.rows ?? [],
    pendingFace,
    run: () => ui.go,
    now: () => Date.now(),
    abort: () => ac.abort(),
  })
  // `--full`（`T10`）：整屏那一档交给终端层（多两个 escape · 排版一行不动）。它不是第五档地板——
  // 画不出来的那几档它自动哑掉（`ui/term.ts` 里 `ansi && full` 那一处判据）。默认主题（U22）与
  // **每帧现问的期望高度**（U6：弹层开着舞台要 `OVERLAY_WANT`，关了回到缺省 `K`）都从舞台递进来。
  const term = openTerm({
    out: process.stdout,
    full: flags.has('full'),
    theme: themeOf({ noStyle: flags.has('no-style'), noColor: process.env.NO_COLOR }),
    heightOf: stage.heightWant,
  })
  // 四条地板收成**一张表**（`ui/follow.ts` 的 `tuiModeOf`）：真终端 → 面板；`--once` / 不是 TTY /
  // `$TERM` 认不出来 → 只印永久行那一档（面板一次都不画，一个字节的 ANSI 都不写）。
  const mode = tuiModeOf({ ansi: term.ansi, once: flags.has('once'), follow: flags.has('follow') })
  // **降级说一声**（U10a）：真终端而 `$TERM` 认不出来——面板那一档整个没了，人得知道
  // 为什么。`--once` 不说：那一档本来就不画面板，没有"退"这回事（判据在 `degradeNote`，
  // 与 `ansiOf` 同一张表）。
  const degrade = degradeNote(process.env.TERM, process.stdout.isTTY)
  if (degrade !== null && !flags.has('once')) process.stderr.write(`${degrade}\n`)
  // 先装收尾钩，再允许任何note/首帧进入alt screen或输入进入raw。
  // 可见首帧之前的SIGTERM不能落回缺省杀进程路径，把终端留在另一块屏。
  let keys: KeySource | null = null
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
  // 接上那一档：读账 → 折帧 → 摆到那块地方，一路跟着（`ui/follow.ts`）。
  const tui = openTui({
    log,
    term,
    emit: emitLine,
    mode,
    view: stage.view,
    // `--tail N`（U15）：首趟只写尾部 N 条——跳过的前几条按「已写出去」记，前缀检查照走。
    reveal: tail,
    // 账往前动一条就问一次（`T6`）：树跟上 · 阅读面折尾 · 门口那批按族重算——整套在舞台里。
    onAdvance: stage.onAdvance,
    readings: { metrics: flags.has('metrics'), report: flags.has('report') },
    phase,
    cat,
    intervalMs: interval,
    signal: ac.signal,
  })
  ui.tui = tui
  // resize：**只重画**，不重读（宽度变了账没变）；新的那一块落在哪由 `ui/term.ts` 那一档决定。
  // `SIGWINCH` 走**尾沿**（U7）：拖拽窗口时终端连发一串，逐发重画就是"块叠块"——`resize()` 里
  // 安静 `RESIZE_WAIT_MS` 之后只补一次。
  const onWin = (): void => tui.resize()
  if (mode === 'panel') process.on('SIGWINCH', onWin)

  // ── `UI4` · 门那儿按一下（只在"面板"那一档）──────────────────────────────────────────
  // 按 `g` 起的是**一条命令**（`ui/run.ts` 的 `openRun` → 一个子进程），账由那个子进程写。界面手里
  // 没有写句柄这件事在**类型上**就成立：`openTui` 收的 `log` 只有 `readMerged` 那一半。
  if (mode === 'panel') {
    // 子进程吐出来的行**走注记**（写在面板上方）：直接写 `stdout` 会在终端历史里插进半块面板。
    // 收尾那一下整套在舞台里（`stage.onRunDone`：说了什么 · 要退就退 · 跑完一趟起排队里下一条）。
    ui.go = openRun({ root, onLine: (line) => tui.note(line), onDone: stage.onRunDone })
    // 按键那一头：⓪–⑩ 分派整套在舞台里（`ui/stage.ts` 的 `onAction`），这一头只递。
    keys = openKeys({ input: process.stdin, out: process.stdout, onAction: stage.onAction })
    // 第一件事：把按键那一行印出来（写在面板上方；翻上去了按 `?` 再印一次）。
    // **stdin 不是终端就不印它**（`stdout` 是终端而 `stdin` 不是：面板照画，可按键收不到）——
    // 印一行"按 g 放行"而按下去没反应，是这一档最坏的一种体验。
    stage.setRaw(keys.raw)
    // 按键那一行**按屏幕宽度取前几条**（28 条接线的动作整行印出来 438 列，终端会折成五行）；
    // 剩下的那一句说清还有几条、去哪儿看全部（`Ctrl-P` 那一屏）。
    tui.note(
      keys.raw
        ? hintLineOf(KEYMAP, hintLimitOf(term.columns))
        : 'stdin 不是终端：这一档不收按键（输入行与弹层都在等按键，画出来是骗人）',
    )
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
