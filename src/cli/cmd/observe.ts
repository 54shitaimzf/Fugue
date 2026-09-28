// fugue 的观察组（`log` · `status` · `watch` · `tui`）——U4c 自 `cli/fugue.ts` 抽出，
// 内容逐字未动（出处：架构 § 9.6 那张观察表 · PLAN § 5.18 的 W12/W13 · § 5.19 的 UI2–UI4）。
// **全是纯读**：不建视图、不取锁、不追加——所以它们排在建视图那一组之前。
import type { LogEvent } from '../../log/events.ts'
import { openLog } from '../../log/log.ts'
import type { LogPos } from '../../terms.ts'
import { phaseOf } from '../../model/price.ts'
import { readings, readingsLines } from '../../probe/status.ts'
import type { StatusRow } from '../../probe/status.ts'
import { follow, readNew } from '../../probe/watch.ts'
import { openTui, tuiModeOf } from '../../ui/follow.ts'
import { openTerm } from '../../ui/term.ts'
import { degradeNote } from '../../ui/term.ts'
import { keysHintOf, openKeys } from '../../ui/keys.ts'
import type { KeySource } from '../../ui/keys.ts'
import { openGo } from '../../ui/go.ts'
import type { GoLauncher } from '../../ui/go.ts'
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
 * 只在面板那一档收按键（`ui/keys.ts`），按 `g` 起一次 `fugue round go`（`ui/go.ts`）——**界面不写
 * 日志、不持写句柄**，账由那个子进程写；它吐出来的行与收尾那一下走 `tui.note()`（写在面板上方）。
 * `q`/`Ctrl-C`/`Ctrl-D` 退出（**raw mode 下 `SIGINT` 不再由终端发出来**，所以那三个字节就在键表里）；
 * 那一趟还跑着时第一次按是等它收尾、第二次是硬退。`?` 把按键那一行重印一遍。
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
  const tui = openTui({
    log,
    term,
    emit: emitLine,
    mode,
    readings: { metrics: flags.has('metrics'), report: flags.has('report') },
    phase,
    intervalMs: interval,
    signal: ac.signal,
  })
  // resize：**只重画**，不重读（宽度变了账没变）；新的那一块落在哪由 `ui/term.ts` 那一档决定。
  const onWin = (): void => tui.redraw()
  if (mode === 'panel') process.on('SIGWINCH', onWin)

  // ── `UI4` · 门那儿按一下（只在"面板"那一档）──────────────────────────────────────────
  // 按 `g` 起的是**一条命令**（`ui/go.ts` 的 `openGo` → 一个子进程），账由那个子进程写。界面手里
  // 没有写句柄这件事在**类型上**就成立：`openTui` 收的 `log` 只有 `readMerged` 那一半。
  let keys: KeySource | null = null
  let go: GoLauncher | null = null
  /** 按过退出、而那一趟还跑着：等它收尾再退（不打断一轮正在跑的——账要完整）。 */
  let leaving = false
  if (mode === 'panel') {
    go = openGo({
      root,
      // 子进程吐出来的行、与它收尾那一下，都**走注记**（写在面板上方）：直接写 `stdout` 会在
      // 终端历史里插进半块面板。
      onLine: (line) => tui.note(line),
      onDone: (r) => {
        if (r.why !== null) tui.note(`这一趟起不来：${r.why}（手敲一遍看看：${go?.argv.join(' ') ?? ''}）`)
        else if (r.code !== 0) tui.note(`那一趟 \`round go\` 退了 ${r.code ?? '（信号）'}`)
        if (leaving) ac.abort()
      },
    })
    keys = openKeys({
      input: process.stdin,
      onAction: (a) => {
        if (a === 'help') {
          tui.note(keysHintOf())
          return
        }
        if (a === 'quit') {
          if (go?.running === true) {
            // 第一次：等它收尾。第二次：硬退——**说清代价**（那一趟的输出接不上了，它自己那份账
            // 照写：写到哪算哪，重放得回来）。
            if (!leaving) {
              leaving = true
              tui.note('那一趟 `round go` 还在跑：等它收尾就退出（账要完整）。再按一次是硬退')
              return
            }
            tui.note('硬退：那一趟的输出接不上了（它自己的账照写，写到哪算哪）')
          }
          ac.abort()
          return
        }
        // `go`：跑着的时候按不起了第二次（同一条命令不叠第二次）。
        if (go === null || go.running) return
        tui.note(`按了 g：起一次 \`round go\`（${go.argv.join(' ')}）`)
        go.press()
      },
    })
    // 第一件事：把按键那一行印出来（写在面板上方；翻上去了按 `?` 再印一次）。
    // **stdin 不是终端就不印它**（`stdout` 是终端而 `stdin` 不是：面板照画，可按键收不到）——
    // 印一行"按 g 放行"而按下去没反应，是这一档最坏的一种体验。
    tui.note(keys.raw ? keysHintOf() : 'stdin 不是终端：这一档不收按键（放行还是手敲 fugue round go）')
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
