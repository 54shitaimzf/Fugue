// `fugue tui` 的接线（0.4.3 第一幕 ①：从 `cli/cmd/observe.ts` 搬出来）。
// 出处：PLAN § 5.19 第五段 · 架构 § 9.8（可附着 TUI）· § 9.11（事件通道）。
//
// **为什么它单独一份**：界面读账只经事件通道（`serve/source.ts`），那条静态断言
// （`tools/check-ui-direct.ts`）按 import 闭包走——它需要一个**干净的根**，而 `cli/cmd/observe.ts`
// 里另外三条命令（`log` · `status` · `watch`）开账本口是对的。两件事住在一个文件里，断言就
// 说不清"哪一侧直连了"。搬出来之后：这一份的闭包 = 界面那一套 + 协议客户端 + 折法，
// 里面一份账本直连都没有。
import type { RelPath } from '../terms.ts'
import { phaseOf } from '../model/price.ts'
import { readCatalog } from '../model/catalog.ts'
import { getConfig, readConfig } from '../config.ts'
import { intervalOf, tailOf } from '../cli/flags.ts'
import { DEFAULT_GLYPH_TIER, GLYPH_TIERS, setGlyphTier } from './glyph.ts'
import type { GlyphTier } from './glyph.ts'
import { DEFAULT_ICON_TIER, ICON_TIERS, setIconTier } from './icons.ts'
import type { IconTier } from './icons.ts'
import { graphicsOf, setGraphics } from './image.ts'
import type { GraphicsTier } from './image.ts'
import { actionCommandsOf, actionsTableOf } from '../round/actions.ts'
import { pendingOf } from '../round/dispatch.ts'
import { identFor } from '../identity.ts'
import { openServeSource, rowsReaderOf } from '../serve/source.ts'
import { emitLine, usageFail } from '../cli/out.ts'
import { KEYMAP, hintLimitOf, hintLineOf, keymapOf, openKeys } from './keymap.ts'
import type { KeySource, Keymap } from './keymap.ts'
import { openTui, tuiModeOf } from './follow.ts'
import type { Tui } from './follow.ts'
import { openExitHooks } from './exit-hooks.ts'
import { degradeNote, openTerm } from './term.ts'
import { themeOf } from './theme.ts'
import { openStage } from './stage.ts'
import { gateFaceOf } from './gate.ts'
import type { GateFace } from './gate.ts'
import { openRun } from './run.ts'
import type { RunLauncher } from './run.ts'

export interface GateSetup {
  readonly round: string
  readonly actions: Readonly<Record<string, readonly RelPath[]>>
  readonly commands: Readonly<Record<string, string>>
  readonly why: string | null
}

/** 读工作区配置，折出 `T6` 要的那三样。`why` 非空 ⇒ 门口那一块不画。 */
export async function gateSetupOf(root: string): Promise<GateSetup> {
  try {
    const doc = await readConfig(root)
    const raw = getConfig(doc, 'round.id')
    return {
      round: typeof raw === 'string' && raw !== '' ? raw : 'r1',
      actions: actionsTableOf(doc),
      commands: actionCommandsOf(doc),
      why: null,
    }
  } catch (err) {
    return {
      round: 'r1',
      actions: {},
      commands: {},
      why: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * `fugue tui`：**同一读面的第二档渲染**（PLAN § 5.19 第五段 · `UI2`/`UI3` 那两格 · 架构 § 9.8 的可附着
 * TUI）。它一个新读源都不开：这一份只做三件事——把开关翻成那一档（`tuiModeOf`）、开那一块地方
 * （`openTerm`）、把信号接上。读账（`serve/source.ts` 的事件通道那一趟）· 折帧（`readingsOf` 与
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
/**
 * `T6` 门口的**三样输入**：轮次号 · 绑好的动作表 · 每条动作的命令行（与 `round go` 那一趟逐样对上）。
 *
 * **为什么单独一份**：这三样一起决定"门口停的是哪一批"，两处走岔一格就发错一批而且不报错
 * （门的判据里带着身份，`identFor` 是同一只）。原先这一块内联在 `tuiCmd` 里，被包在一个
 * `try` 里没有自己的断言——`getConfig` 当时**没有 import**，抛出来的 `ReferenceError` 被那一层
 * `catch` 吞掉，`why` 于是恒非空，门口那一块在生产里一次都没画出来。摆成一个函数，它自己那一条
 * 断言（`ui/gate-setup.test.ts` ①）就抓得住这一类"接线断了却不报错"。
 *
 * **读不出不是退出的理由**（这一档是观察窗）：退到"门口那一块不画"，`why` 说一句为什么；
 * 其余三样退到地板（轮次号 `r1` · 两张空表），界面照开。
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
  // **字形档定一次**（第二幕 ⑤）：`ui.glyphs` 点名才换，缺省 `box`（交集那一档）。
  // 读不出配置不是退出的理由——按缺省档起，与门口那一块同一条口径。
  let tier: GlyphTier = DEFAULT_GLYPH_TIER
  try {
    const raw = getConfig(await readConfig(root), 'ui.glyphs')
    if (typeof raw === 'string' && (GLYPH_TIERS as readonly string[]).includes(raw)) tier = raw as GlyphTier
  } catch {
    // 配置坏了：按缺省档起（"配置读不出来"那一句由下面 `gateSetupOf` 那一处说）。
  }
  setGlyphTier(tier)
  // **图标那一档**（第二幕 ⑨ 的前一半）：`ui.icons` 点名才开（`ascii` / `nerd`），缺省**关**——
  // 字体在不在场终端不回这个话，只有人知道自己装的是哪一份字体。读不出配置照缺省起（同上）。
  let iconTier: IconTier = DEFAULT_ICON_TIER
  try {
    const raw = getConfig(await readConfig(root), 'ui.icons')
    if (typeof raw === 'string' && (ICON_TIERS as readonly string[]).includes(raw)) iconTier = raw as IconTier
  } catch {
    // 配置坏了：按缺省档起（"配置读不出来"那一句由 `gateSetupOf` 那一处说）。
  }
  setIconTier(iconTier)
  // **图片那一档**（第二幕 ⑨ 的后一半）：`ui.images: off` 是全关；缺省**按环境变量探一遍**
  // （认不出来的终端探到 `none`——那一档与"根本没有这一档"同形）。
  let gfx: GraphicsTier = graphicsOf(process.env)
  try {
    if (getConfig(await readConfig(root), 'ui.images') === 'off') gfx = 'none'
  } catch {
    // 读不出来：按探测那一档起。
  }
  setGraphics(gfx)
  // 钱那一栏要一个档（与 `status --once` 同一个口径：读的时候按当时的钟算）。
  const phase = phaseOf(new Date())
  // 价目与模型目录按这一台算（P2d，与 `status --once` 同一份）。
  const cat = readCatalog()
  // **读源是事件通道那一份**（`serve/source.ts`）：界面这一侧不开账本口、也不顺着账本口扫
  // ——`log/log.ts` 与 `probe/watch.ts` 那两条直连住在 serve 那一头（架构 § 9.11）。
  const source = await openServeSource({ root })
  // ── `T6` 的三样输入（与 `round go` 那一趟逐样对上）─────────────────────────────────────
  // 整块住在下面的 `gateSetupOf` 里（轮次号 · 绑好的动作表 · 每条动作的命令行），身份分配
  // 器是同一个（`identFor`——门只认契约集合，而集合里带着身份，两边换一个就发错一批而且不
  // 报错）。为什么单独一份、它那一条断言在哪，见那一份的说明。
  const { round, actions: actionsTable, commands, why: configWhy } = await gateSetupOf(root)
  /**
   * 算门口那一批折成那一面（U21 起 `refreshGate` 住在舞台里，它只收这一只函数）。
   *
   * **门口那一批从手上这些行重算**（`rowsReaderOf`）：行是事件通道送来的那一批，所以界面不必
   * 再开一个读源（架构 § 9.7「观察不得影响状态」——观察也不另记一份、不另开一条路）。
   */
  const pendingFace = async (): Promise<GateFace | null> => {
    if (configWhy !== null) return null
    const v = await pendingOf({
      log: rowsReaderOf(ui.tui?.session.rows ?? []),
      round,
      identityFor: (n: number) => identFor(round, n),
      actions: actionsTable,
    })
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
  // 按键那一档的两样**在这一层先立着**（第二幕 ④：提示行每帧从它们现问——它不再是一行写进终端
  // 历史就追不回来的注记）。两个盒子在下面那个 `if (mode === 'panel')` 里填：`keys` 是 raw mode
  // 那一头（不在了就是"stdin 不是终端"），`km` 是配置造出来的键表（缺省就是缺省表）。
  let keys: KeySource | null = null
  let km: Keymap = KEYMAP
  const stage = openStage({
    note: (line) => ui.tui?.note(line),
    redraw: () => ui.tui?.redraw(),
    // 框下面那一行（第二幕 ④）：stdin 不是终端时它就是那一句"收不到按键"——按屏幕宽度取前几条的
    // 那一手在 `hintLimitOf`（整行 438 列会被终端折成五行）。
    hint: () =>
      keys?.raw === true
        ? hintLineOf(km, hintLimitOf(term.columns))
        : 'stdin 不是终端：这一档不收按键（输入行与弹层都在等按键，画出来是骗人）',
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
    // 色档按这一台终端自报的来（四级表住在 `ui/theme.ts`）：`COLORTERM`/`TERM` 认得 256 色才上，
    // 认不得退属性档（不半上色）。真彩那一档不开。
    theme: themeOf({
      noStyle: flags.has('no-style'),
      noColor: process.env.NO_COLOR,
      term: process.env.TERM,
      colorTerm: process.env.COLORTERM,
    }),
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
  // **收尾钩子在首帧之前挂上**（0.2.8 U4）：`term` 一开出来就有一块地方要还回去（`--full` 那一档
  // 第一帧进 alt screen，按键那一档还进了 raw mode），而这两条之前收到的 `SIGTERM` 会走缺省的杀
  // 进程路径——那台终端被留在另一块屏上，得人 `reset`。`ui/exit-hooks.ts` 管这三条（`SIGTERM` ·
  // `SIGHUP` · `exit`）；这个顺序由 `ui/exit-hooks.test.ts` ② 拿这一份的源码位置钉着。
  const hooks =
    mode === 'panel'
      ? openExitHooks(process, {
          onSignal: () => ac.abort(),
          onExit: () => {
            keys?.close()
            term.close()
          },
        })
      : null
  // 接上那一档：读账 → 折帧 → 摆到那块地方，一路跟着（`ui/follow.ts`）。
  const tui = openTui({
    source,
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
  // 没有写句柄这件事在**类型上**就成立：`openTui` 收的 `source` 只会问事件通道那一趟。
  if (mode === 'panel') {
    // 子进程吐出来的行**走注记**（写在面板上方）：直接写 `stdout` 会在终端历史里插进半块面板。
    // 收尾那一下整套在舞台里（`stage.onRunDone`：说了什么 · 要退就退 · 跑完一趟起排队里下一条）。
    ui.go = openRun({ root, onLine: (line) => tui.note(line), onDone: stage.onRunDone })
    // 按键那一头：⓪–⑩ 分派整套在舞台里（`ui/stage.ts` 的 `onAction`），这一头只递。
    // 按键表（清障批 ⑧ 接线）：覆盖从 `ui.keys` 读，配错的那一格照缺省走、当场印出为什么。
    // 配置文件读不动（坏 JSON · 坏形状）也不静默：stderr 说一声，按缺省表起——TUI 是看的东西，
    // 不因为配置坏了就拒绝开。形状在读那一面已经核过，这里拿到的一定是「动作 → 键串」。
    try {
      const doc = await readConfig(root)
      const raw = (doc.ui as { keys?: Record<string, string> } | undefined)?.keys
      km = keymapOf(raw ?? {})
    } catch (err) {
      process.stderr.write(`配置读不出来，按键按缺省表走：${(err as Error).message}
`)
    }
    keys = openKeys({ input: process.stdin, out: process.stdout, onAction: stage.onAction, km })
    // 第一件事：把按键那一行印出来（写在面板上方；翻上去了按 `?` 再印一次）。
    // **stdin 不是终端就不印它**（`stdout` 是终端而 `stdin` 不是：面板照画，可按键收不到）——
    // 印一行"按 g 放行"而按下去没反应，是这一档最坏的一种体验。
    stage.setRaw(keys.raw)
    for (const p of km.problems) tui.note(`键位 ${p.action} 配不了（${JSON.stringify(p.key)}）：${p.why}`)
    // **提示行从前在这里写了第一遍**（`tui.note` 一行永久行）。第二幕 ④ 之后它常驻框下面那一行
    // （`ui/stage.ts` 的 `view()` 每帧现问一次 `deps.hint`），这一处**一个字都不写**——写下去那一行
    // 就留在终端历史里，而它的内容是跟着列宽变的。
  }
  // **每一条退出路径都要把终端还原回去**（计划 § 5.19 里 DECSTBM 那笔账在 raw mode 上是同一笔：
  // 漏一条，那台终端就得人 `reset`）。四路：正常退 · `Ctrl-C`（raw mode 下走按键那一头）·
  // `SIGTERM`/`SIGHUP` · 崩了（`exit` 那一钩，最后一次同步地把 raw mode 关掉）。后两条由上面那组
  // `openExitHooks` 挂着——**已经挂上了**（U4 把它挪到首帧之前），收尾在下面 `finally` 里摘。
  // 读账在 `try` 里：读炸了也要走到 `finally` 去把日志口与面板收干净。
  try {
    await tui.counts
    return 0
  } finally {
    process.removeListener('SIGINT', onSig)
    if (mode === 'panel') {
      process.removeListener('SIGWINCH', onWin)
      hooks?.close()
    }
    // **raw mode 先还原、面板再收走**：两条都幂等，正常退那一路与 `exit` 那一钩都走到这里。
    keys?.close()
    term.close()
    await source.close()
  }
}
