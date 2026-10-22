// 用量求和与印法：**缺的那几项不当 0**（`null` 是"没量到"，与 0 是两件事）。
//
// 为什么单独一份：`docs build` 的 stdout、`last.json`、`docs status` 要印的是同一个和。原先
// `build.ts` 只把出入两项加起来——写作接缝早就把缓存读写带回来了，汇总这一层把它们丢了，
// 于是"这一趟命中多少缓存"在终端和状态里都查不到（计划 § 阶段 2）。
//
// 缓存读**不是第三笔输入**：它与 `inputTokens` 合起来才是这一趟的输入（OpenAI 系报的是
// "没命中缓存的那部分"，Anthropic 系两者分列）。所以印法是把缓存读放在输入后面的括号里。
import type { Usage } from '../model/contract.ts'

/** 一次或多次调用的用量合计。缓存两栏可缺：老记录里没有它们（那时没量）。 */
export interface UsageNumbers {
  readonly calls: number
  readonly inputTokens: number | null
  readonly cacheReadTokens?: number | null
  readonly cacheWriteTokens?: number | null
  readonly outputTokens: number | null
}

export interface UsageSum extends UsageNumbers {
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
}

/** 一串用量求和。某一项全都量不到时它仍是 `null`，不拿 0 顶。`calls` 由调用方给：
 * 自由读的一次"取证"背后可能是好几轮调用，不能拿数组长度当次数。 */
export function sumUsage(usages: readonly (Usage | null)[], calls: number = usages.length): UsageSum {
  let input: number | null = null
  let cacheRead: number | null = null
  let cacheWrite: number | null = null
  let output: number | null = null
  for (const u of usages) {
    if (u === null) continue
    input = add(input, u.inputTokens)
    cacheRead = add(cacheRead, u.cacheReadTokens)
    cacheWrite = add(cacheWrite, u.cacheWriteTokens)
    output = add(output, u.outputTokens)
  }
  return { calls, inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output }
}

function add(sum: number | null, n: number | null): number | null {
  if (n === null) return sum
  return (sum ?? 0) + n
}

/** 千分位（自己拼：不依赖宿主 locale，两条脸逐字节稳定）。 */
function count(n: number | null): string {
  if (n === null) return '（没量到）'
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 一行读数：`4 次调用 · 输入 220（缓存读 120）/ 输出 50`。缓存读量不到时不写那个括号。 */
export function usageText(u: UsageNumbers): string {
  const cacheRead = u.cacheReadTokens ?? null
  const cache = cacheRead === null ? '' : `（缓存读 ${count(cacheRead)}）`
  return `${u.calls} 次调用 · 输入 ${count(u.inputTokens)}${cache}/ 输出 ${count(u.outputTokens)}`
}
