// TUI 的**舞台**（U21）：`observe.ts` 的 `tuiCmd` 里那一份「纯视图状态 + ⓪–⑩ 键表分派」整个
// 搬到这里——那一边缩回「读配置 · 组 deps · 起进程 · 接信号」。出处：PLAN § 5.19 U21（stage
// 抽取）· 架构 § 9.8（「界面只持纯视图状态」那一句）。
//
// **舞台不碰终端、不碰进程。** 它收的 deps 全是**晚绑定的函数**（note · redraw · columns ·
// rows · pendingFace · run · now · abort）：`openTui` 的 `view` / `onAdvance` 要在构造时就递
// 进去，而 `tui` / `run` 那些句柄那时还没建——所以 deps 递的是「问一句」的函数，不是句柄本身。
// 于是「按键怎么分派 · 弹层怎么开合 · 门口那批怎么举手」这一整份逻辑，在测试里不起一个进程、
// 不开一个真终端就能驱动（`stage.test.ts` 五条接线断言）。`FLAGS_OF` 从 cli 那一层读
// （`../cli/flags.ts`）：菜单候选与分发处读**同一个对象**——「哪些命令存在」仍只有一处真源（那张
// 表自己不 import 任何东西，不成环）。
import { PAGE_STEP, fallsToText, helpRowsOf } from './keymap.ts'
import type { Decoded } from './keymap.ts'
import { ctrlCStepOf, escStepOf, quitStepOf, stillArmed } from './cancel.ts'
import { applyIntent, emptyEditor, inputFrameOf, intentOf, modeOf, rememberSubmit, submitOf } from './input.ts'
import type { Editor } from './input.ts'
import { acceptOf, candidatesOf, clampSel, completeOf, moveSel, pathsOf, queryOf, rowsTextOf, specsOf } from './menu.ts'
import type { MenuRow, MenuSource } from './menu.ts'
import { GATE_KEEP, GATE_VIEW, gateRowsOf, lineOf, pressGate, stepAt } from './gate.ts'
import type { GateFace, GateOption, GateView } from './gate.ts'
import { EMPTY_QUEUE, dropLastOf, enqueueOf, queueRowOf, shiftOf } from './queue.ts'
import { altAt, clampNav, navNodesOf, navRowsOf, writerAt } from './nav.ts'
import type { NavNode } from './nav.ts'
import { stepView, viewAt } from './views.ts'
import { EMPTY_READ, faceRowsOf, facesOf, firstFace, readStateOf, stepFace, stepTop } from './read.ts'
import type { ReadFaceName, ReadState } from './read.ts'
import type { QueueState } from './queue.ts'
import { GO_LINE } from './run.ts'
import type { LineMode, RunLauncher, RunOutcome } from './run.ts'
import { innerOf } from './frame.ts'
import { panelWantOf } from './layout.ts'
import type { ViewInput } from './term.ts'
import { FLAGS_OF } from '../cli/flags.ts'
import type { StatusRow } from '../probe/status.ts'

// 分账那几个数（`panelWantOf` · 份额 · 上下限）住 `ui/layout.ts` 那一份布局常量表（第二幕 ④ 收成
// 一处）：这一份只管把它们接上 `deps.termRows`（`heightWant`），算式一个字都不留在这里。

/** 舞台要的外面那几样：全是「问一句」的函数（晚绑定——句柄建起来之前舞台先立着）。 */
export interface StageDeps {
  /** 写一行界面自己的话（面板上方，只写一次）——`tui.note`。 */
  readonly note: (line: string) => void
  /**
   * 框下面那一行提示行（第二幕 ④）的原文——`ui/console.ts` 那一头给的（键表与 stdin 是不是终端都
   * 只有那一头知道）。**每帧现问**：列宽变了它就跟着换（`hintLimitOf` 按列数取前几条）。
   */
  readonly hint: () => string
  /** 重画一帧（不重读）——`tui.redraw`。 */
  readonly redraw: () => void
  /** 这一刻的终端列数——`term.columns`。 */
  readonly columns: () => number
  /**
   * 这一刻的终端行数——`term.rows`（量不到是 `undefined`）。面板高度按它分账（`panelWantOf`：
   * 输入那块不得与显示区等高，2026-09-29 的口径）；量不到就回框的 10 行 / `OVERLAY_WANT`。
   */
  readonly termRows: () => number | undefined
  /** 这一刻账上的行——`tui.session.rows`（导航树与阅读面都从它推，不另开读法）。 */
  readonly rows: () => readonly StatusRow[]
  /** 算门口那一批折成的那一面（`pendingOf` → `gateFaceOf`；配置读不出 · 没停在门口 → null）。 */
  readonly pendingFace: () => Promise<GateFace | null>
  /** 起命令那一只手（`ui/run.ts` 的 RunLauncher）——还没建起来时 null。 */
  readonly run: () => RunLauncher | null
  /** 现在几点（`Ctrl-C` 举手那一档的钟——**钟只在调用方读**，cancel.ts 那条纪律）。 */
  readonly now: () => number
  /** 停下整个界面（`ac.abort()`——`leave` 与跑完即退那两处用）。 */
  readonly abort: () => void
}

/** 舞台的公面：`observe.ts` 那一头递进 openKeys / openTui / openTerm / openRun 的那几个口。 */
export interface Stage {
  /** 按键分派（⓪–⑩，原 `openKeys` 的 `onAction` 那一段整搬）。 */
  onAction(d: Decoded): void
  /** 折一帧的「界面自己那几样」（原 `view` 闭包——`openTui` 每折一帧现问）。 */
  view(): ViewInput
  /** 账往前动了一条时问一次（原 `onAdvance`——树跟上 · 阅读面折尾 · 门口那批按族重算）。 */
  onAdvance(rows: readonly StatusRow[]): void
  /** 重算门口那一批（配置读不出就什么都不做）。 */
  refreshGate(): Promise<void>
  /** 起排队里队头那一条（有货 · 没在跑才起得动）。返回「起了没」。 */
  startNext(): boolean
  /** 一趟收尾那一下（原 `openRun` 的 `onDone`：说了什么 · 要退就退 · 要接就接下一条）。 */
  onRunDone(r: RunOutcome): void
  /**
   * 这一刻期望的面板高度（`openTerm` 的 `heightOf`）：按终端行数分账（`panelWantOf`——缺省至多
   * 2/5 · 弹层开着至多 3/5；量不到行数回框的 10 行 / `OVERLAY_WANT`）。画得下多少仍归终端层夹。
   */
  heightWant(): number
  /** stdin 是不是终端（`openKeys` 之后才知道——`view` 里输入行画不画看它）。 */
  setRaw(raw: boolean): void
}

/**
 * 舞台：一份**纯视图状态**（焦点 · 输入行 · 弹层 · 排队草稿 · 门口那块的视图位），加上围绕它的
 * 那一整套纯分派。**它不注册信号、不碰 `process`、不持写句柄**——那三样都是调用方的
 * （`cli/cmd/observe.ts` 的 `tuiCmd`）。
 */
export function openStage(deps: StageDeps): Stage {
  // ── `T4` · 界面自己那几样（**纯视图状态**：进程一退就没了）──────────────────────────────
  // **这一份里没有第二份真相**：输入模式从行首那个 `/` 推（`modeOf`）、弹层在筛什么也从行里推
  // （`queryOf`）——于是"面板在筛什么"与"行里有什么"永远不打架。
  let ed: Editor = emptyEditor()
  /** 弹层（这一格只有一层：菜单/面板/路径）。`null` = 没有弹层。 */
  let panel: { readonly source: MenuSource; readonly sel: number; readonly paths: readonly string[] } | null = null
  /** 输入行画不画：`stdin` 不是终端就不画（画一个收不到按键的提示符，比不画坏得多）。 */
  let showInput = false
  /** 命令面那一张表（**分发处读的是同一份**：`cli/flags.ts` 的 `FLAGS_OF`）。 */
  const specs = specsOf(FLAGS_OF)
  /** 键表那一档的候选：提示行 · 帮助面板 · 这一屏，三处同一张表（`ui/keymap.ts`）。 */
  const keyRows = (): readonly MenuRow[] =>
    helpRowsOf().map((name) => ({ name, note: '', kind: 'key' as const }))
  const rowsOf = (source: MenuSource): readonly MenuRow[] =>
    candidatesOf({ specs, keys: keyRows(), paths: panel?.paths ?? [], line: ed.draft.text, source })
  /** 提示符：`»` 是命令、`>` 是话（模式是从行推出来的，不是另存的一个开关）。 */
  const promptOf = (): string => (modeOf(ed.draft) === 'Command' ? '» ' : '> ')
  // ── `T6` · 门口那一批：**从账上重算**（与 `round go` 同一个函数），折成界面那一份 ─────────────
  /** 上一次算出来的那一批（`编号:份数`）：一样就不重画（账每动一行都算，值当的只有那几次）。 */
  let lastGate: string | null = null
  // ── `UI4` · 门那儿按一下 ────────────────────────────────────────────────────────────────
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
   * 树上那几个节点与选中哪一个（`T8`）。**节点是从账推出来的**（`navNodesOf`：主线在前、agent 缩进
   * 一级），账一动它就跟着动——界面这一头没有第二份"有哪几格"的清单。
   */
  let navNodes: readonly NavNode[] = []
  let navAt = 0
  /**
   * 看第几档视图（第二幕 ⑦）：对话（缺省）· 处境 · 读数，`Tab` 轮换。**纯视图状态**——
   * 不落账、不进日志、进程一退就没了（与 `navAt` 同一档；PLAN § 5.19 一 · 3）。
   */
  let viewIndex = 0
  /**
   * 阅读面（`T9`）：**折到哪儿了** + 现在看第几面 + 看到第几行起。
   *
   * 那份状态是**从账折出来的**（`ui/read.ts` 的 `readStateOf`）——界面这一头没有第二份"这一格动过
   * 哪些路径"的清单。**只折尾部**：账往前动一条就接着折一条（`prev` 就是上一次那一份），于是跟随
   * 那一趟不必每来一条行都把整份账重折一遍（`readStateOf` 那一头的前缀判据管着"接得上"）。
   */
  let readState: ReadState = EMPTY_READ
  let reading: { face: ReadFaceName; top: number } | null = null
  /**
   * 跑完一趟要不要**自动**接着起下一条（`T7`）。缺省要；**被 `Esc` / `Ctrl-C` 打断之后不要**——
   * 人刚说了停，排队那几条停在那儿等他（`Enter` 起下一条 · `Esc` 丢掉）。起新的一条时又回到"要"。
   */
  let advanceQueue = true

  /**
   * 重算门口那一批。**只在账真的往前动了那两族事件时走**（`round/*` 与 `holder/*`：处境 · 意图 ·
   * 草案 · 放行都在这两族里）；`llm/call` 那些一行一行的高频事件不重算——一趟读全量日志是 O(行数)，
   * 拿它去乘每一行就等于把跟随这一档拖垮。
   */
  const refreshGate = async (): Promise<void> => {
    let next: GateFace | null = null
    try {
      next = await deps.pendingFace()
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
    deps.redraw()
  }
  /** 这一刻树上选的是哪一格（`null` = 整份账）。阅读面读的就是它。 */
  const focusNow = (): string | null => writerAt(navNodes, navAt)
  /**
   * 折一次阅读面（`T9`）。**接着上一次那一份只折尾部**；切了格（`agent` 变了）或前缀被顶掉时
   * `readStateOf` 自己从头折——两种情形它都答得对，所以调用点不必先判是哪一种。
   */
  function refreshRead(): void {
    readState = readStateOf(deps.rows(), { agent: focusNow(), prev: readState })
  }

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
    deps.redraw()
  }
  /**
   * 退出那一下（`Ctrl-D`/`q`/`Q`，且输入行空着——判据在 `ui/cancel.ts` 的 `quitStepOf`）。
   * **跑着的时候第一次按是"等它收尾"、第二次才是硬退**（"退出必须两次"）：账要完整，一轮正在跑的
   * 不替人打断——要打断有它自己的两下（`Esc` 与 `Ctrl-C`）。
   */
  const leave = (): void => {
    if (deps.run()?.running === true) {
      if (!leaving) {
        leaving = true
        deps.note('那一趟还在跑：等它收尾就退出（账要完整）。再按一次是硬退，或者 Esc / Ctrl-C 打断它')
        return
      }
      deps.note('硬退：那一趟的输出接不上了（它自己的账照写，写到哪算哪）')
    }
    deps.abort()
  }
  /** `Esc` 第二级与 `Ctrl-C` 第一级都走这一下：把信号递给在途的那一趟（同一句话只说一遍）。 */
  const breakRun = (): void => {
    deps.run()?.stop('SIGINT')
    // **打断之后不自动接着起下一条**（`T7`）：人刚说了停，排队那几条就停在那儿等人（`Enter`
    // 起下一条 · `Esc` 丢掉）。不这么定的话，`Esc` 链第三级（丢排队草稿）**永远够不着**——
    // 一趟被打断、`onDone` 立刻起下一条，队列那一栏就又回到"跑着"了。
    advanceQueue = false
    deps.note('打断了那一趟（SIGINT）：它自己那份账照写，写到哪算哪。排队那几条停着等你（Enter 起下一条）')
    settle()
  }
  /**
   * 起排队里队头那一条（有货 · 没在跑才起得动）。返回"起了没"。
   *
   * 起不动（这一档还没开 · 正在跑）就**什么都不做**——排队那几条照旧在队里，不许悄悄吞掉。
   */
  const startNext = (): boolean => {
    const go = deps.run()
    if (go === null || go.running) return false
    const taken = shiftOf(queue)
    if (taken.next === null) return false
    queue = taken.q
    const next = taken.next
    const cut = go.argvOf(next.line, next.mode)
    if (cut.why !== null) {
      deps.note(`排队里那条起不了：${cut.why}（跳过它，接着看下一条）`)
      return false
    }
    deps.note(`起了排队里的下一条：\`${next.line}\`（${cut.argv.join(' ')}）`)
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
      deps.note(
        `拒了门口那一批（${gate?.cards.length ?? 0} 份）：一个字节都没落——门照旧停着，要改就 /say 一句再判一次`,
      )
      settle()
      return
    }
    const go = deps.run()
    if (go === null || go.running) {
      deps.note('那一趟还在跑：这一下先没发出去（排队是 T7 那一格的事）')
      settle()
      return
    }
    deps.note(`按了 ${option === 'approve' ? 'y' : 'n'}：起一次 \`${line}\`（${go.argvOf(line).argv.join(' ')}）`)
    go.press(line)
    settle()
  }
  /** 一趟收尾那一下（原 `openRun` 的 `onDone`——搬进来之后 observe 那头只剩一行接线）。 */
  const onRunDone = (r: RunOutcome): void => {
    const go = deps.run()
    if (r.why !== null) deps.note(`这一趟起不来：${r.why}（手敲一遍看看：${go?.last.join(' ') ?? ''}）`)
    else if (r.code !== 0) deps.note(`那一趟退了 ${r.code ?? '（信号）'}（账照写：写到哪算哪）`)
    if (leaving) {
      deps.abort()
      return
    }
    // **跑完一趟就起排队里的下一条**（`T7`）：一条一条地起（`ui/run.ts`"一次只起一个进程"
    // 那条不变量一个字没动，动的是"人打的第二条去哪儿"）。被 `Esc` 打断过的那一趟不起
    // （`advanceQueue`：人刚说了停）。
    if (advanceQueue) startNext()
    deps.redraw()
  }
  /**
   * 本帧**框内那一栏**的宽度（U2 的「一把尺」）：从 `frame.ts` 的 `innerOf` 推，与 `frameOf` 内部
   * 算的是同一个数——`follow.ts` 递进去的 `width` 就是 `term.columns`，两边同源。
   *
   * 从前这里是三处各写一遍的 `deps.columns() - 1`（输入行 · 门口那一块 · 树），而框内宽是
   * `columns - 2`：宽出去的那一列画不进框，`cell` 把它截掉——不报错，只少一个字符。收成一处之后
   * 输入行比它自己的上界（`columns` − 1，`ui/term.ts` 头注写着）还严一列；那个上界仍然满足，
   * 换来的是全站只有一个数。
   */
  const cols = (): number => innerOf(deps.columns())
  const view = (): ViewInput => {
    // 提示行（第二幕 ④）**与输入行在不在无关**：stdin 不是终端时它就是那一句"这一档不收按键"
    // ——画一个收不到按键的提示符比不画坏得多，而"按键收不到"这件事更得说出来。
    const hintPart = { hint: deps.hint() }
    if (!showInput) return hintPart
    const frame = inputFrameOf({ e: ed, prompt: promptOf(), width: cols() })
    // 最下面那一栏：**门口那一块**（`T6`）与**排队那一行**（`T7`），都在面板那一栏的最下面（输入行
    // 还在它们下面）。两样都没有时一个字节都不占。
    const gateOn = gate !== null && !gateHidden
    const queueOn = queue.items.length > 0
    const bottomRows = [
      ...(gateOn ? gateRowsOf({ face: gate as GateFace, view: gateView, columns: cols() }) : []),
      ...(queueOn ? [queueRowOf(queue)] : []),
    ]
    const bottomPart =
      bottomRows.length === 0
        ? {}
        : { bottom: { rows: bottomRows, keep: (gateOn ? GATE_KEEP : 0) + (queueOn ? 1 : 0) } }
    // 树那一栏（`T8`，排在最上面）与"切到哪一格"（`focus`：`null` = 整份账）。
    const navRows = navRowsOf(navNodes, navAt, cols())
    const navPart = navRows.length === 0 ? {} : { nav: { rows: navRows, sel: navAt } }
    // 阅读面那一栏（`T9`，排在内容那一栏最下面）：**开着才占地方**。三面是从 `readState` 排的版
    // （`facesOf` 不再折一次），看到第几行由 `reading.top` 说了算。
    const readPart =
      reading === null
        ? {}
        : ((): { read: { rows: readonly string[]; top: number } } => {
            const faces = facesOf(readState)
            const rows = faceRowsOf(faces, reading.face ?? firstFace(faces), cols())
            const top = Math.max(0, Math.min(reading.top, Math.max(0, rows.length - 1)))
            return rows.length === 0 ? {} : { read: { rows, top } }
          })()
    return {
      ...hintPart,
      ...navPart,
      ...(panel === null ? {} : { menu: { rows: rowsTextOf(rowsOf(panel.source)), sel: panel.sel } }),
      ...bottomPart,
      ...readPart,
      focus: writerAt(navNodes, navAt),
      view: viewAt(viewIndex),
      input: { rows: frame.rows, caret: frame.caret },
    }
  }
  const onAdvance = (rows: readonly StatusRow[]): void => {
    // 树（`T8`）：节点从账推出来，账一动就跟上——**只在集合真的变了的时候重画**（跟随那一趟每条
    // 行都要走这里，白画一次就是白烧一帧）。
    const nodes = navNodesOf(deps.rows())
    const changed = nodes.length !== navNodes.length || nodes.some((x, i) => x.id !== navNodes[i]?.id)
    if (changed) {
      navNodes = nodes
      navAt = clampNav(nodes.length, navAt)
      deps.redraw()
    }
    // 阅读面（`T9`）：**接着上一次那一份只折尾部**（新来的那几条）——这一趟是每条行都要走的，
    // 从头折整份账就等于把跟随这一档拖垮（`readStateOf` 那一头的前缀判据管着"接得上"）。
    refreshRead()
    // 门口那一批（`T6`）：只在 `round/*` 与 `holder/*` 那两族上重算（一趟读全量日志是 O(行数)，
    // 拿它去乘 `llm/call` 那些高频行就等于把跟随这一档拖垮）。
    if (rows.some((r) => r.e.t.startsWith('round/') || r.e.t.startsWith('holder/'))) void refreshGate()
  }
  const onAction = (d: Decoded): void => {
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
          deps.note(
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
    // ② `?`：开按键那一张面板（与 `Ctrl-P` 同一个入口）。**"把提示行重印一遍"那一条撤了**——
    // 第二幕 ④ 把提示行搬进了重画区（常驻在框下面那一行），它已经在屏幕上；`?` 要看的是**全部**
    // 那一张表，不是屏幕上那几条。
    if (d.action === 'help') {
      openPanel('keys')
      settle()
      return
    }
    // ③ **取消与退出那一组**（`ui/cancel.ts` 那两条链 + 退出那一条——判据全在那一份里，这一份
    // 只把"那一刻的处境"喂进去、照着出来的那一个动作做）。
    //
    // `Esc` 七级（`escStepOf`，U19）：收门口那一块 → 关一层弹层 → 打断在途的那一趟 → 丢排队
    // 草稿 → 清反查 → 清空输入 → 什么都不做。级与级之间没有商量：上头那一级够得着，下头那几级
    // 这一下就不动（"这一次 `Esc` 到底关了什么"是这类界面最常被骂的一处，所以每一级各有一条
    // 反向的钉，见 `cancel.test.ts` ①）。
    if (d.action === 'cancel' || d.action === 'interrupt' || d.action === 'quit') {
      if (d.action === 'cancel') {
        const step = escStepOf({
          // **门口那一块是 `Esc` 链最外那一级**（`T6`）：它开着（且行是空的）就只收它。
          atGate: gate !== null && !gateHidden,
          // 弹层栈有几层：候选那一层与阅读面（`T9`）各算一层——`Esc` 只关最上面那一层。
          overlays: (panel === null ? 0 : 1) + (reading === null ? 0 : 1),
          running: deps.run()?.running === true,
          // 排队那几条（`T7`）：一条都没有时这一级够不着（次序不变——在途那一趟压着它）。
          queued: queue.items.length,
          line: ed.draft.text,
          searching: ed.search !== null,
        })
        if (step === 'gate') {
          gateView = { ...gateView, armed: null }
          gateHidden = true
          deps.note('收起了门口那一块（账再动一次它自己回来；要放行还得按 y）')
          settle()
          return
        }
        if (step === 'overlay') {
          // 弹层是一条栈：**最上面那一层先关**（阅读面是"我要看这一份东西"，
          // 它开着的时候压着候选那一层）。
          if (reading !== null) reading = null
          else panel = null
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
          deps.note(
            `丢掉了排队里最后那一条（${before} → ${queue.items.length} 条）` +
              (done ? '；队列空了' : `；下一条：${queue.items[0]?.line ?? ''}`),
          )
          settle()
          return
        }
        if (step === 'clearSearch' || step === 'clearLine') {
          // 输入行那一层的两小级（先退反查、再清空这一行）——**次序已在 `escStepOf` 七档那一处
          // 声明**（U19），这一份照做：`cancelAt` 在 `ui/input.ts` 只管 Editor 那一侧的变换。
          ed = applyIntent(ed, { t: 'cancel' })
          settle()
          return
        }
        return
      }
      // `Ctrl-C`（`ctrlCStepOf`）：有在途就打断它；空闲时按一下只举手、3 秒内再按一次才是退出。
      // **打断那一下不举手**：在途的时候按它说的是"把这一趟停下来"，不是"我要走了"。
      if (d.action === 'interrupt') {
        const step = ctrlCStepOf({ running: deps.run()?.running === true, armed: stillArmed(deps.now(), armedAt) })
        if (step === 'break') {
          breakRun()
          return
        }
        if (step === 'quit') {
          leave()
          return
        }
        armedAt = deps.now()
        deps.note('再按一次 Ctrl-C 就退出（3 秒内）')
        return
      }
      // `Ctrl-D`/`q`/`Q`：**只在输入行空着的时候退**（`quitStepOf`）；行里有字时什么都不做——说
      // 一句为什么，不然按下去看着像没反应（这一句只有 `Ctrl-D` 打得出：`q` 行里有字时让位成人
      // 打的字，上面 ① 那一档就把它收走了）。
      if (quitStepOf({ line: ed.draft.text }) === 'none') {
        deps.note('输入行里还有字：先清掉它（Esc）或者把它发出去，再按 Ctrl-D 退出')
        settle()
        return
      }
      leave()
      return
    }
    // ④ `g`：放行门口那一批（起一次 `fugue round go`）。跑着的时候按不起了第二次（同一条命令
    // 不叠第二个进程）——排队与打断是 `T7` 的事。
    if (d.action === 'go') {
      const go = deps.run()
      if (go === null || go.running) return
      deps.note(`按了 g：起一次 \`${GO_LINE}\`（${go.argvOf(GO_LINE).argv.join(' ')}）`)
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
    // ⑥ `Ctrl-R`（`T9`）：**阅读面**——开与关都在这一下上（看一眼就走）。开着的时候 `Tab` 换一面 ·
    // `↑`/`↓` 翻 · `Esc` 收起（走上面取消链那一级）。读的是**账**（`readState` 从行折出来），
    // 界面这一头没有第二份"这一格动过哪些路径"的清单。
    if (d.action === 'read') {
      if (reading === null) {
        refreshRead()
        const faces = facesOf(readState)
        reading = { face: firstFace(faces), top: 0 }
        deps.note(`阅读面 · ${faces[reading.face]?.title ?? ''}（Tab 换一面 · ↑↓ 翻 · Esc 收起）`)
      } else {
        reading = null
      }
      settle()
      return
    }
    // ⑥之二 阅读面开着时那三下：`Tab` 换一面 · `↑`/`↓` 翻（一屏一行地翻——这是"读"，
    // 不是"选"）。别的键照旧走它们自己的路（打字还是打字）。
    if (reading !== null) {
      if (d.action === 'complete') {
        const faces = facesOf(readState)
        reading = { face: stepFace(faces, reading.face, 1), top: 0 }
        deps.note(`阅读面换一面 · ${faces[reading.face]?.title ?? ''}`)
        settle()
        return
      }
      if (d.action === 'historyOlder' || d.action === 'historyNewer') {
        const n = faceRowsOf(facesOf(readState), reading.face, cols()).length
        reading = { ...reading, top: stepTop(n, reading.top, d.action === 'historyOlder' ? -1 : 1) }
        settle()
        return
      }
    }
    // ⑥之三 翻页（U14）：`PgUp`/`PgDn` 翻半屏（`PAGE_STEP`），`Ctrl-Home`/`Ctrl-End` 跳首尾。
    // **谁开着翻谁**：阅读面 → `top`；门口那一批 → `at`（半批）；候选 → `sel`（半页）。都没开
    // 就安静丢掉——翻页键不是全局滚动（没有"正在翻的东西"时按它，什么都不要动）。
    if (d.action === 'pageUp' || d.action === 'pageDown' || d.action === 'jumpFirst' || d.action === 'jumpLast') {
      const back = d.action === 'pageUp' || d.action === 'jumpFirst'
      if (reading !== null) {
        const n = faceRowsOf(facesOf(readState), reading.face, cols()).length
        // 跳首尾用一个够大的数一步到头（`stepTop` 夹得住）。
        const delta = d.action === 'jumpFirst' || d.action === 'jumpLast' ? (back ? -n : n) : back ? -PAGE_STEP : PAGE_STEP
        reading = { ...reading, top: stepTop(n, reading.top, delta) }
      } else if (gate !== null && !gateHidden && ed.draft.text === '') {
        // 半批：那一批的一半（一批至少翻一格）。
        const n = gate.cards.length
        const delta = d.action === 'jumpFirst' || d.action === 'jumpLast' ? (back ? -n : n) : back ? -Math.max(1, Math.floor(n / 2)) : Math.max(1, Math.floor(n / 2))
        gateView = { ...gateView, at: stepAt(n, gateView.at, delta) }
      } else if (panel !== null) {
        // 候选翻半页（`PAGE_STEP`），跳首尾直接落端点；夹住不环形（翻页不是轮换）。
        const n = rowsOf(panel.source).length
        const sel = d.action === 'jumpFirst' ? 0 : d.action === 'jumpLast' ? Math.max(0, n - 1) : clampSel(n, panel.sel + (back ? -PAGE_STEP : PAGE_STEP))
        panel = { ...panel, sel }
      }
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
      const go = deps.run()
      if (go === null || go.running || queue.items.length > 0) {
        // **忙就入队**（§ 5.19 六："空闲 → 直接跑；忙 → 入队（可见 · 可撤）"）。那一行在上面
        // 已经记进历史（`rememberSubmit`），于是人按 `↑` 翻得回来——队列只是"等着跑的那几条"，
        // 而它不是账（进程一退就没了）。
        //
        // **排队里已经有货时，新打的那一条也进队尾**（FIFO：不许插到前面去），而"起"的是队头
        // 那一条——不是刚打的这一条。
        queue = enqueueOf(queue, { line, mode: lineMode })
        if (go !== null && !go.running && startNext()) {
          settle()
          return
        }
        deps.note(
          `入队（排队 ${queue.items.length} 条，跑完一趟起一条；Enter 起下一条 · Esc 丢掉最后一条）`,
        )
        settle()
        return
      }
      const cut = go.argvOf(line, lineMode)
      if (cut.why !== null) {
        deps.note(`这一行起不了：${cut.why}`)
        settle()
        return
      }
      deps.note(`发了这一行：\`${line}\`（${cut.argv.join(' ')}）`)
      advanceQueue = true
      go.press(line, lineMode)
      settle()
      return
    }
    // ⑦ `Tab`：补全（候选从行推：命令那一档补命令名，别处补手里那个词）。**补不动就换视图**
    // （第二幕 ⑦：对话 → 处境 → 读数，环形；切格走 `Alt-1…9`）。
    if (d.action === 'complete') {
      const source: MenuSource = panel?.source ?? (ed.draft.text.startsWith('/') ? 'cmd' : 'keys')
      const next = completeOf({ rows: rowsOf(source), line: ed.draft.text, source })
      if (next !== null) {
        ed = applyIntent(ed, { t: 'setLine', text: next })
        settle()
        return
      }
      // **补不动就换视图**（第二幕 ⑦；形状从 `nav.ts` 取——`stepView` 就是 `stepNav` 那一手）。
      // 不写注记：换视图在屏上看得见（框名从「对话」变成「进展」/「结果与花费」），而终端历史是
      // 给人翻的流水——为一次纯视觉的切换往里头写一行，是把历史当日志用（交互律一「安静即稳态」）。
      // 一处不让：弹层开着时 `↑`/`↓` 是选项那一档，这一下不抢它（`panel === null` 那个条件）。
      if (panel === null) viewIndex = stepView(viewIndex, 1)
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
    // ⑨ `Alt-1…9`：**直选第 n 格 agent**（`T8`）。没有那么多个就安静丢掉（与"认不出来的字节丢掉"
    // 同一条：不猜）。
    if (d.action === 'focus' && d.n !== undefined) {
      const at = altAt(navNodes, d.n)
      if (at !== null) {
        navAt = at
        refreshRead()
        deps.note(`切到 ${navNodes[at]?.label ?? ''}（${at + 1}/${navNodes.length}）`)
        settle()
        return
      }
      return
    }
    // ⑩ 剩下的编辑动作（`ui/input.ts` 认的那些）一律进输入行；别的（认不出来的动作）安静丢掉。
    const it = intentOf(d.action, d.text ?? '')
    if (it === null) return
    ed = applyIntent(ed, it)
    settle()
  }
  return {
    onAction,
    view,
    onAdvance,
    refreshGate,
    startNext,
    onRunDone,
    heightWant: (): number => panelWantOf(deps.termRows(), panel !== null || reading !== null),
    setRaw(raw: boolean): void {
      showInput = raw
    },
  }
}
