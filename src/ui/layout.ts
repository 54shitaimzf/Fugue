// 面板与操作区的尺寸在这里分配。FRAME_ROWS / REGION_ROWS 是未知宿主尺寸时的地板，
// 不限制正常终端的内容容量；实际高度随终端行数展开。边、提示与最小高度仍共用一份常量。
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

/** 再矮不矮过它（框与收尾 4 行 ＋ 内容 4 行）。 */
export const PANEL_MIN = 8

/** 已知行数时使用实际屏幕；预留输入、提示与原生历史。未知尺寸保留既有退化档。
 * 确认与输入占同一区域，开合不改变基准高度；多行输入由 stage 让出等量空间。
 */
export function panelWantOf(rows: number | undefined, overlay: boolean): number {
  if (rows === undefined) return overlay ? OVERLAY_WANT : FRAME_ROWS
  return Math.max(PANEL_MIN, Math.floor(rows) - 5)
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
