// 人读面那一层**排版**：数字。
//
// **为什么单独一份**：同一个数在人读面上有两处印（命令行的 `status` 那一族 · TUI 那块面板），
// 而"多大的数才换单位 · 千分位怎么打"只该有一处判据——两处各写一遍的话，同一份账在两处就会
// 长得不一样，而长得不一样不报错。出处：施工单 § 五 第二幕 ②「数字排版收一处（人面千分位 ·
// 大数换单位；`--json` 面裸值不动——排版只发生在渲染上）」。
//
// **`--json` 那一面一个字节都不走这里**：值层给的是裸数（`probe/status.ts` 的 `statusOf` 与
// `readings`），排版只发生在渲染那一步（`linesOf` · `bodyOf` 那一层）。
//
// **什么数进这里**：**账上的量**（用量 · 条数 · 次数）。**什么数不进**——位置与身份（`seq` ·
// `step` · 轮次号）与屏幕几何（"还有 N 条" · "第 N 条" · 框宽）：前两样是坐标，改了就读不回去；
// 后一样说的是这一屏，与账无关。

/** 「万」那一档（四位起千分位，五位起换到这一档）。 */
export const WAN = 10_000
/** 「亿」那一档。 */
export const YI = 100_000_000

/**
 * 千分位：`1234` → `1,234`。
 *
 * **不用 `toLocaleString`**：那一位读数取决于这台机器上装了哪一份 ICU 数据（同一份账在两台
 * 机器上印出两种样子，而这是人读面，不是本地面）。这一条规则自己写死，只有一处。
 */
export function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 一位小数，整数不留 `.0`（`1.0万` → `1万`）。 */
function oneDecimal(x: number): string {
  const s = x.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/**
 * 人面那一个整数：**小的原样 · 四位起千分位 · 一万起换单位**。
 *
 * 换单位那一档是给读的人留一行：`用量` 那一栏五个数并排，百万级的裸数一行装不下，挤掉的是
 * 它后面那几栏。**精确值一个不丢**——`--json` 那一面给的是裸数（与"不拿 0 顶"同一条口径：
 * 人读面能省，机器面不能）。
 */
export function humanNumber(n: number): string {
  const sign = n < 0 ? '-' : ''
  const v = Math.abs(Math.trunc(n))
  if (v >= YI) return `${sign}${oneDecimal(v / YI)}亿`
  if (v >= WAN) return `${sign}${oneDecimal(v / WAN)}万`
  return sign + grouped(v)
}
