// TUI 的默认主题（U22）：**只用黑白两个属性、不用颜色**——框线与脚注暗一档（`\x1b[2m`），
// 弹层（候选 · 门口）加粗轻强调（`\x1b[1m`）。16 色 · vt100 · `xterm` 全认得，这是「简约
// 可用」的地板。出处：PLAN § 5.19 U22（样式 = U20 地基 + 一档简约默认主题，本轮新批的
// 「基础样式美化」）。
//
// **`body` 与 `read` 不给**：正文与阅读面就是缺省的那一副——主题只动"边与弹出"，不动内容。
// **永久行与输入行不上样式**（U20 的形状）：永久行进终端历史（`| tee` 出去仍是干净流水），
// 输入行是光标算术那一行（`widthOf − caret.col`），SGR 掺进去那条算术就得多知道一件事。
//
// **退回有两道门**：`--no-style`（tui 的开关表）与 `NO_COLOR` 非空（no-color.org 惯例）——
// 任何一道开了就不给主题，字节流与没有主题那一档逐字节相同。非 TTY / `$TERM` 认不出来
// 那一档本就不写一个字节的 ANSI，主题谈不上。
import type { LineRole } from './frame.ts'

/** 缺省那一档：恰三个角色有值（`body` · `read` 不在表里——缺省不动）。 */
export const DEFAULT_THEME: Readonly<Partial<Record<LineRole, string>>> = {
  border: '\x1b[2m',
  footer: '\x1b[2m',
  overlay: '\x1b[1m',
}

/**
 * 给不给主题。`noColor` 是环境变量的**原值**：空串与未设一样算「没设」——no-color.org 的
 * 口径是"非空才算喊了"。两道门任何一道开了就 `undefined`（= 没有主题，`openTerm` 不包一行）。
 */
export function themeOf(
  o: { noStyle?: boolean; noColor?: string | undefined } = {},
): Readonly<Partial<Record<LineRole, string>>> | undefined {
  if (o.noStyle === true) return undefined
  if ((o.noColor ?? '') !== '') return undefined
  return DEFAULT_THEME
}
