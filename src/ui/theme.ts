// TUI 的默认主题（U22）：**只用黑白两个属性、不用颜色**——框线暗一档（`\x1b[2m`），账尾 ·
// 弹层（候选 · 门口）与阅读面那个框名加粗轻强调（`\x1b[1m`）。16 色 · vt100 · `xterm` 全认得，
// 这是「简约可用」的地板。出处：PLAN § 5.19 U22（样式 = U20 地基 + 一档简约默认主题）与
// ROADMAP § 3 的 0.2.8 行（U3：账尾改粗 · 阅读面框名 `readHeading`）。
//
// **`body` 与 `read` 不给**：正文与阅读面正文就是缺省的那一副——主题只动"边与弹出"与阅读面
// 那个框名，不动内容。
// **永久行与输入行不上样式**（U20 的形状）：永久行进终端历史（`| tee` 出去仍是干净流水），
// 输入行是光标算术那一行（`widthOf − caret.col`），SGR 掺进去那条算术就得多知道一件事。
//
// **退回有两道门**：`--no-style`（tui 的开关表）与 `NO_COLOR` 非空（no-color.org 惯例）——
// 任何一道开了就不给主题，字节流与没有主题那一档逐字节相同。非 TTY / `$TERM` 认不出来
// 那一档本就不写一个字节的 ANSI，主题谈不上。
import type { LineRole } from './frame.ts'

/**
 * 缺省那一档：四个角色有值（`body` · `read` 不在表里——缺省不动）。
 *
 * **加粗那一族从这张表推**：`term.test.ts` ⑬ 与 `theme.test.ts` ①② 都拿 `v === '\x1b[1m'`
 * 筛名单，不手抄一遍角色名——表动测试跟动，抄下来的那一份漂移时不报错。
 */
export const DEFAULT_THEME: Readonly<Partial<Record<LineRole, string>>> = {
  border: '\x1b[2m',
  footer: '\x1b[1m',
  overlay: '\x1b[1m',
  readHeading: '\x1b[1m',
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
