// TUI 的**布局常量表**（第二幕 ④）：屏幕上每一段各占几行 · 框内那几段怎么分 · 面板高度怎么
// 按终端行数分账——全在这一份里。出处：PLAN § 5.19（K 那一段）· 交接单 § 二「今天的框」那本
// 行账与 § 五 ④ · 决策材料问二 · 问三。
//
// **为什么收成一份**（一处真相那条）：这一站之前这几个数散在三处——`ui/term.ts` 的 `K` ·
// `ui/frame.ts` 的 `MIN_HEIGHT` · `ui/stage.ts` 里分账那三个。改一处要顺着三处读一遍才知道那本行账
// 还合不合；收进来之后，行账本身成了一条断言（`ui/layout.test.ts` ①：把它加一遍，看等不等于 K）。
//
// **一本行账，自上而下**（K=12）：
//
//   终端历史（永久行，不在 K 里）
//   ┌─ 框 10 ───────────────────────────┐
//   │ 上边 1                            │
//   │ 框内 8：内容 6 · 细线 1 · 收尾 1   │
//   │ 下边 1                            │
//   └───────────────────────────────────┘
//     （空一行）                         ← 框下留白
//     提示行                             ← 弱化一档 · 装不下第一个让位
//   输入行（不在 K 里：它在框下面另起一行块——`ui/term.ts` 头注那一段）
//
// **与这一版之前差在哪**：从前 K=12 **就是框**（边 2 + 内容 8 + 细线 1 + 收尾 1），提示行是启动时
// 写进终端历史的一行**永久行**（`ui/console.ts` 原先那一句 `tui.note(hintLineOf(...))`）。现在这 12
// 行里框缩到 10（内容 8→6），让出来的两行是"框下空一行"与"提示行"——提示行于是**每帧重画 · 位置
// 固定**（`ui/term.ts` 的 `Panel.hint`），不再是一行进了历史就追不回来的注记。K 一个数没动。
//
// **框内那 8 行的五分账**（交接单 § 二 · 决策材料问三，和 8）：轮次头 1 · 在飞 4 · 细线 1 ·
// 最近动作 1 · 收尾 1。其中「内容 6」＝轮次头 ＋ 在飞 ＋ 最近动作；细线承分隔那一行、收尾承账尾
// 那一行。**今天落的是这本账的行数与角色**（`ui/frame.ts` 折的那一帧：内容 6 + 细线 1 + 收尾 1）：
// 「哪一行算轮次头 · 哪一行算在飞 · 哪一行算最近动作」是信息收拢那一格（⑦）按格清点之后才定得下来
// 的事——清点之前先把行数定死，不然那一格每增删一格都要重算这本账。**什么条件下改主意**：⑦ 清点完
// 发现轮次头＋在飞＋最近动作装不进 6 行，就在那一格把这条账重开一次（K 不动，动的是框内怎么分）。

/** 框的上下两条边。 */
export const FRAME_EDGE_ROWS = 2

/** 内容那一栏的行数（轮次头 1 · 在飞 4 · 最近动作 1——名字见头注，今天先只有行数）。 */
export const CONTENT_ROWS = 6

/** 细线那一行（在飞与最近动作之间那条分隔线）。 */
export const RULE_ROWS = 1

/** 收尾那一行（账尾：全账的读数）。 */
export const TAIL_ROWS = 1

/** 框内那几行（内容 ＋ 细线 ＋ 收尾）——五分账的和，8。 */
export const INNER_ROWS = CONTENT_ROWS + RULE_ROWS + TAIL_ROWS

/** 框一共几行（上边 ＋ 框内 ＋ 下边）＝ 10。它就是喂给 `frameOf` 的那个高度。 */
export const FRAME_ROWS = FRAME_EDGE_ROWS + INNER_ROWS

/** 框与提示行之间那一个空行。 */
export const GAP_ROWS = 1

/** 提示行那一行。 */
export const HINT_ROWS = 1

/** 重画区一共几行（框 ＋ 空一行 ＋ 提示行）＝ **12**——`ui/term.ts` 的 `K` 就是它。 */
export const REGION_ROWS = FRAME_ROWS + GAP_ROWS + HINT_ROWS

/** 画得出一个框的下限（上边 ＋ 一行内容 ＋ 细线 ＋ 收尾 ＋ 下边）＝ 5。 */
export const MIN_FRAME_ROWS = FRAME_EDGE_ROWS + RULE_ROWS + TAIL_ROWS + 1

/**
 * 弹层（菜单 · 阅读面）开着时的期望高度上限：候选与正文要装得下几行。它仍要夹进终端行数
 * （`ui/term.ts` 那一层量得到行数就夹）——想要多大是这一头的事，画得下多大是那一头的事。
 */
export const OVERLAY_WANT = 24

/** 框那一块缺省至多占终端（行数 − 1）的几分之几（2026-09-29 用户拍的口径）。 */
export const PANEL_SHARE = 2 / 5

/** 弹层开着那一档至多占几分之几。 */
export const OVERLAY_SHARE = 3 / 5

/** 再矮不矮过它（框与收尾 4 行 ＋ 内容 4 行）。 */
export const PANEL_MIN = 8

/**
 * 框那一块的高度怎么按终端行数**分账**（2026-09-29 用户拍的口径：输入那块不得与显示区等高——固定
 * 12 行在常见的 24 行终端上占了半屏，底下那块与上面留给输出的地方一边高，不符合直觉）：
 *
 *   · 缺省那档至多占终端（行数 − 1）的 **2/5**：24 行终端 → 框 9 行（框 9 ＋ 空一行 ＋ 提示行 ＋
 *     输入行 1 = 12，上面显示区 12）；40 行及以上回到 `FRAME_ROWS`（10）；
 *   · 弹层开着那档至多占 **3/5**（上限 `OVERLAY_WANT`），下限是缺省那档 ＋ 4——弹层要的是更大，
 *     不是更小；
 *   · 再矮不矮过 `PANEL_MIN`（框与收尾 4 行 ＋ 内容 4 行）——终端真的很小时输入那块占大头是免不了
 *     的事，如实如此；
 *   · 量不到行数（`undefined`）就不分账，回 `FRAME_ROWS` / `OVERLAY_WANT`——与 `ui/term.ts`「量不到
 *     就不夹」同一条。
 *
 * 收的是**框**的期望行数：空一行与提示行不在这本账里，它们由 `ui/term.ts` 加在框下面（装不下时
 * 先丢的是提示行那一行，不是框里那几行——交接单 § 五 ④「矮屏先让提示行，不让在飞的格」）。
 * 出来的数仍是**期望**：夹进终端行数（`clamp(期望, 1, 行数 − 1)`）归 `ui/term.ts` 那一层。
 *
 * **一处如实记下的代价**（2026-09-29 那条口径与今天这两档的关系）：24 行终端上"底下那一块"从 10 行
 * 变成 12 行（多了空一行与提示行），显示区 14 → 12——与底下那一块**等高**了。口径的实质是"显示占
 * 大头"，这一档上它不再成立。**什么条件下改主意**：人判显示区被压得不够，就去掉那一个空行（区域
 * 11 · 显示 13），或者把提示行并进账尾那一栏（区域 11）——两处都只动这一份里的一个数，K 仍不动。
 */
export function panelWantOf(rows: number | undefined, overlay: boolean): number {
  if (rows === undefined) return overlay ? OVERLAY_WANT : FRAME_ROWS
  const base = Math.min(FRAME_ROWS, Math.max(PANEL_MIN, Math.floor((rows - 1) * PANEL_SHARE)))
  if (!overlay) return base
  return Math.max(base + 4, Math.min(OVERLAY_WANT, Math.floor((rows - 1) * OVERLAY_SHARE)))
}

/** 一整块（框 ＋ 空一行 ＋ 提示行）几行：喂进去框画几行，还回那一块一共占几行。 */
export function regionRowsOf(frameRows: number): number {
  return frameRows + GAP_ROWS + HINT_ROWS
}

/** 正文与竖框之间的留白；极窄终端保留至少一列内容。 */
export const AIR_COLUMNS = 1
export function airOf(width: number): number {
  return width >= 2 + 2 * AIR_COLUMNS + 1 ? AIR_COLUMNS : 0
}
