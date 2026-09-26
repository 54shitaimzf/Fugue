// 准头那一件事：**以 api 返回的用量为最高标准**，用真读数修正估计。出处：架构 § 8.15（`llm/call`
// 的用量四个数就是真读数）· PLAN § 5.8 那条疑点（"把尺对准真计量"）· 用户那条决策：**不能全量
// 采取估计，通过 api 修正**。
//
// **真读数在哪**：`llm/call` 的 `usage`（`StepOutcome.usage` 也带着它，驱动不用回读日志）。
// 它有两个用途，这一份只做第二个：
//   一 · 对账：估与真并排印出来（`B7` 的基线那一档）；
//   二 · **修正下一次的估**（这一份的出口）。
//
// **它修正不了什么，说在明处**：真读数在调用之后才有，所以它改的是**下一次判**，不是当步——
// 当步发不发得出去只能靠估。一次会话里越量越准：第一步是纯估，第二步起按已量到的比修。
//
// **真数是这一趟输入的总量**：未命中那一部分 + 命中缓存那一部分 + 写进缓存那一部分。两条线协议
// 在解析时已经把"命中/未命中"归到同一个口径上（`inputTokens` 一律是**未命中**那一部分，见
// `wire/openai.ts` 的 `usageOf`），所以这里相加对两条线都成立。三个数都可缺：**全缺就是"没读数"**，
// 不拿 0 顶。
import type { Usage } from '../model/contract.ts'

/** 一次调用的真读数：这一趟输入的总量。三个数全缺就是"没读数"。 */
export function truthOf(usage: Usage | null): number | null {
  if (usage === null) return null
  const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].filter(
    (n): n is number => n !== null,
  )
  if (parts.length === 0) return null
  return parts.reduce((a, b) => a + b, 0)
}

/** 一份修正：那个比值（真 ÷ 估）与它取了几份读数。`samples === 0` 就是"还没量到"。 */
export interface Calibration {
  readonly ratio: number
  readonly samples: number
}

/** 没量到的时候不修：账回到那把尺的原始读数（于是缺省行为一个字不变）。 */
export const UNCALIBRATED: Calibration = { ratio: 1, samples: 0 }

/** 这一步的估账与实际用量比一次。估给 0、或者这一趟没有读数，就是"量不出来"（`null`）。 */
export function ratioOf(truth: number | null, estimated: number): number | null {
  if (truth === null || estimated <= 0) return null
  return truth / estimated
}

/**
 * 从量到的比值里取一份修正：**最近八份的中位数**。
 *
 * 为什么是中位数：一条离谱的读数（上游把缓存那一档算重了、或者某一步真的特别长）不该把后面
 * 每一步都带歪，而中位数只认"多数落在哪儿"。为什么只留最近八份：口径真漂了要跟得上。
 *
 * **它是估账的乘法因子，不是真读数本身**——所以账仍然是账，`B7` 那边要看的正是它与真读数的差。
 */
export function calibrate(ratios: readonly number[]): Calibration {
  const seen = ratios.filter((r) => Number.isFinite(r) && r > 0).slice(-8)
  if (seen.length === 0) return UNCALIBRATED
  const sorted = [...seen].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)] as number
  return { ratio: mid, samples: seen.length }
}
