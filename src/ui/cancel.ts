// TUI 的第二版第五格：**取消链**——`Esc` 五级 · `Ctrl-C` 四层（3 秒那一次）· `Ctrl-D`/`q`。
//
// 出处：PLAN § 5.19 第二版「四 · 取消链与退出」（"`Esc` 与 `Ctrl-C` 各自是一条**写死优先级的链**，
// 每一级可证伪。同类五家都这么做；而『这一次 `Esc` 是关菜单还是打断』正是这类界面最常被骂的一处"）·
// 第九节 `T5` 那一行（"五级各一条：菜单开着时 `Esc` 只关菜单；跑着时只打断；退出**必须两次**"）·
// 架构 § 9.8。
//
// **这一份是纯的**：进去的是"那一刻的处境"，出来的是"这一下该做哪一件事"——`Esc` 按了之后到底动
// 谁，由调用方（`cli/cmd/observe.ts`）去动。于是"五级各一条"这件事不用起终端就量得出来
// （`cancel.test.ts`），而接线那一头只剩"照着做"。
//
// 处境那几样**全都是从别处推出来的**（这一份不存任何东西）：弹层有几层是弹层栈的长度 · 在途不在途是
// 子进程那句 `running` · 排队几条是排队那一份的长度（`T7` 落地之前恒为 0——那一级于是照旧落空，
// 这正是"次序写死"的意思：级在那儿，够不够得着是另一回事）· 行里有什么是输入行那一份。
//
// **"有选中就复制"那一级这一版没有**：选择归终端（这一版不抓鼠标，人自己的复制一个字节都不碰，
// PLAN § 5.19 八），所以 `Ctrl-C` 那一链从"有在途就打断"起算——少的那一级是**声明过的没有**，
// 不是"忘了接"。

/** 那一刻的处境。**每一样都推得出来**（这一份只读，不存）。 */
export interface Situation {
  /** 弹层栈有几层（`Gate` · `Menu` · `Detail` · `Search` 都算）。 */
  readonly overlays: number
  /** 起的那一趟还在不在途。 */
  readonly running: boolean
  /** 排队等着发的草稿几条（`T7` 之前恒为 0）。 */
  readonly queued: number
  /** 输入行里现在有什么（原文）。 */
  readonly line: string
  /** 输入行自己那一小层（`Alt-R` 反查）开着没有。 */
  readonly searching: boolean
}

/** `Esc` 这一下该做的那一件事（`none` = 五级都够不着：什么都不做）。 */
export type EscStep = 'overlay' | 'break' | 'dropQueue' | 'clearLine' | 'none'

/**
 * `Esc` 那一链，**次序写死**（PLAN § 5.19 四）：关一层弹层 → 打断正在跑的那一趟 → 丢弃排队的草稿 →
 * 清空输入 → 什么都不做。
 *
 * 为什么要写死而不是"看情况挑一件"：这一类界面最常被骂的一处就是"这一次 `Esc` 到底关了什么"。
 * 级与级之间没有商量——上面那一级够得着，下面那几级这一下就不动。
 */
export function escStepOf(s: Situation): EscStep {
  if (s.overlays > 0) return 'overlay'
  if (s.running) return 'break'
  if (s.queued > 0) return 'dropQueue'
  if (s.line !== '' || s.searching) return 'clearLine'
  return 'none'
}

/** `Ctrl-C` 那一次"举一下"的有效窗口（毫秒）。**常数写在一处**：觉得长或短改它，不动结构。 */
export const CTRL_C_WINDOW_MS = 3000

/** `Ctrl-C` 这一下该做的那一件事。 */
export type CtrlCStep = 'break' | 'arm' | 'quit'

/**
 * `Ctrl-C` 那一链（**次序写死**）：有在途就打断 → 已经举过一次（窗口内）就退 → 否则只举一次。
 *
 * `armed` 由调用方算（`stillArmed`）：这一份不碰钟，于是"3 秒"那一档在测试里不用真等 3 秒。
 * **打断那一下不举手**：在途的时候按 `Ctrl-C` 是"把这一趟停下来"，不是"我要走了"。
 */
export function ctrlCStepOf(s: { readonly running: boolean; readonly armed: boolean }): CtrlCStep {
  if (s.running) return 'break'
  if (s.armed) return 'quit'
  return 'arm'
}

/** 这一下举手记在什么时刻（调用方给钟：这一份不读 `Date.now()`）。 */
export function stillArmed(now: number, at: number | null): boolean {
  return at !== null && now - at <= CTRL_C_WINDOW_MS
}

/**
 * `Ctrl-D` · `q` 那一档：**只在输入行空的时候退**（退出码 0：人喊停不是失败）。行里有字时什么都不做
 * ——`Ctrl-D` 是控制字符，不许当成"那个字"打进去（`q` 是可打印的，它让位成那个字，见 `ui/keymap.ts`
 * 的 `fallsToText`）。
 */
export function quitStepOf(s: { readonly line: string }): 'quit' | 'none' {
  return s.line === '' ? 'quit' : 'none'
}
