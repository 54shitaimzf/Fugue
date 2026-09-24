// 上下文的上界那笔账：**三个数 · 一份估账 · 一个判决**。出处：架构 § 8.12（`seed` 的两条准则：
// 上限 = 模型上限 − Zone A − Zone A 之外那一段，且"带着超限的种子派发等于派发一次立刻触发的
// 接续"）· § 23 U6（三个模型相关的量，**这一站只建立口径**）· § 8.15（`prefix-hit-rate` 的
// 输入就是这套字节——那八个指标住在 src/probe/metrics.ts）· § 8.13.a（循环重启）。
//
// **它是纯函数。** 输入是一份前缀与一份声明，出口是三个数与一个判决——不读日志、不碰模型、
// 不认识 agent。于是"触发点到了没有"这件事在真调用之前就答得出来（`B0` 那道闸的同一条理由：
// 账不对的时候，真调用的读数不可解释，而钱已经花了）。
//
// **三个数只有一处定义**：`ModelDecl.contextLimit` 是那一个上界，`trigger` 与 `handoffMargin`
// 由 `contract.ts` 的 `triggerAt()` 与声明一起给。这一份不自己算 0.75，也不自己定余量——
// 它只读。
import type { Prefix } from '../assemble/contract.ts'
import type { ModelDecl } from '../model/contract.ts'

/**
 * 一份估账用哪把尺。**今天是一把按字节的粗尺**，而它凭什么够用写在下面。
 *
 * 真正的 token 数只有提供方的分词器答得准，而那是要出网才知道的东西——`B0` 的闸要求这笔账
 * **离线**算出来。所以这里的尺是保守的：
 *
 *   · **非 ASCII 的字符一个算一个 token**（中文一个字常常就是一个 token，日文/emoji 有时更多，
 *     所以这一档偏保守）；
 *   · ASCII 每 4 个字节算一个 token（英文与代码的常见比值，取整时向上）；
 *   · 再加一个固定的信封（`ENVELOPE`，两侧的角色标记与分隔那几十个字节）。
 *
 * **它是估账，不是读数**：读数在 `llm/call` 的 `usage` 那四个数里（真调用之后才有）。这笔账
 * 的用处只有一个——**在真调用之前判断"这一步发不发得出去"**。口径漂了不会报错，所以这一份
 * 的量法写在这里，而它与真读数的对照归 `B7` 的基线那一档。
 */
export const ENVELOPE_TOKENS = 8

export function estimateTokens(bytes: Uint8Array): number {
  let nonAscii = 0
  let ascii = 0
  for (const b of bytes) {
    if (b < 0x80) ascii += 1
    else nonAscii += 1
  }
  // 非 ASCII 一个字节算半个：一个三字节的汉字因此约 1.5 个 token（比"一个字一个"略保守）。
  return Math.ceil(ascii / 4 + nonAscii / 2) + ENVELOPE_TOKENS
}

/** 三个数与一个判决。 */
export interface BudgetPlan {
  /** 上限（那份声明的 `contextLimit`）。 */
  readonly limit: number
  /** 触发点：到了它就该交接（架构 § 8.13.a）。 */
  readonly trigger: number
  /** 交接余量：留给"交接提示词 + 下一次调用的头"那一块。 */
  readonly handoffMargin: number
  /** 这一步的上下文用了多少（三区 + 工具目录 + seed + 上一句回执，见 `BudgetAsk`）。 */
  readonly used: number
  /** 还剩多少（`limit - used`，可以是负的）。 */
  readonly headroom: number
  /**
   * 三档，而三档都要说得出为什么：
   *   `continue` —— 还没到触发点；
   *   `restart`  —— 到了触发点，**而交接写得下**；
   *   `stop`     —— 已经到了"交接都写不下"的地步（地板那一档：**明确报出为什么停**）。
   */
  readonly kind: 'continue' | 'restart' | 'stop'
  /** 一句人读的原因（进日志与读数，不参与判断）。 */
  readonly why: string
}

/** 这笔账要什么。**全部是值**：没有任何一处要现读日志或现读视图。 */
export interface BudgetAsk {
  readonly decl: ModelDecl
  /** 这一步要发出去的那份前缀。 */
  readonly prefix: Prefix
  /** 工具目录那一段的字节（架构 § 8.11 表外那一项：它有位置、位置不由我们排）。 */
  readonly tools: number
  /** `seed`：那一轮派下来的活（架构 § 8.12）。 */
  readonly seed: number
  /**
   * 交接提示词（这一步还没交接时给 `''`）。
   *
   * **它进这一笔账**：到了触发点的那一步要写的正是它，而"写不写得下"就是 `stop` 与 `restart`
   * 的分界。给 0 的话判决只答得出"到了触发点"，答不出"还写不写得下"。
   */
  readonly handoff: number
}

const bytesOf = (p: Prefix): number => p.zoneA.length + p.zoneB.length + p.zoneC.length

/**
 * 算这一步的账。
 *
 * **顺序是刻意的**：先算"这一步用了多少"，再看它有没有过触发点，最后看**交接写不写不下**
 * ——三档因此是三个数之间的比较，没有一处拍脑袋。
 *
 * `used` 里那一块 `handoff` 的算法：判决要回答"到了触发点这一步，交接提示词还塞不塞得进
 * 下一次调用"。所以它是 `这一步 + 交接 + 余量`：**那三样一起不超过上限**才算 `restart`。
 */
export function planBudget(ask: BudgetAsk): BudgetPlan {
  // 上限那一栏在一等字段上（`contextLimit`），触发点与余量在 `budget` 那一格里——**三处名字**
  // 各有各的出处，这一份只读，不自己算比例。
  const limit = ask.decl.contextLimit
  const budget = ask.decl.budget
  const used = bytesOf(ask.prefix) + ask.tools + ask.seed
  const headroom = limit - used
  const withHandoff = used + ask.handoff + budget.handoffMargin

  if (used < budget.trigger) {
    return {
      limit,
      trigger: budget.trigger,
      handoffMargin: budget.handoffMargin,
      used,
      headroom,
      kind: 'continue',
      why: `用了 ${used}，还没到触发点 ${budget.trigger}（差 ${budget.trigger - used}）。`,
    }
  }
  if (withHandoff > limit) {
    return {
      limit,
      trigger: budget.trigger,
      handoffMargin: budget.handoffMargin,
      used,
      headroom,
      kind: 'stop',
      // **地板那一档**：不静默、不裁剪后照发（架构 § 8.12 那一条）。超了多少也要说出来。
      why:
        `用了 ${used}（触发点 ${budget.trigger}），而交接还差 ${withHandoff - limit} 写不下` +
        `——交接余量 ${budget.handoffMargin} 也不够。到这里就停，不裁剪后照发。`,
    }
  }
  return {
    limit,
    trigger: budget.trigger,
    handoffMargin: budget.handoffMargin,
    used,
    headroom,
    kind: 'restart',
    why: `用了 ${used}，过了触发点 ${budget.trigger}；交接提示词 ${ask.handoff} 加余量 ${budget.handoffMargin} 塞得下（还剩 ${limit - withHandoff}）。`,
  }
}

/**
 * 三个数的关系。**它不是判断，是一条能被指出来核对的恒等式**：触发点在 (0, limit) 之间、
 * 余量小于触发点。两者都不成立时那一档预算自己就是坏的——而坏的预算不会报错，只会让
 * "该交接的时候"变成"没到触发点"。
 */
export function checkBudget(decl: ModelDecl): string[] {
  const bad: string[] = []
  const limit = decl.contextLimit
  const budget = decl.budget
  if (!(budget.trigger > 0 && budget.trigger < limit)) {
    bad.push(`${decl.id}：触发点 ${budget.trigger} 不在 (0, ${limit}) 之间`)
  }
  if (!(budget.handoffMargin > 0 && budget.handoffMargin < budget.trigger)) {
    bad.push(`${decl.id}：交接余量 ${budget.handoffMargin} 不小于触发点 ${budget.trigger}`)
  }
  return bad
}
