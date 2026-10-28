// 上下文的上界那笔账：**三个数 · 一份估账 · 一个判决**。出处：架构 § 8.12（`seed` 的两条准则：
// 上限 = 模型上限 − Zone A − Zone A 之外那一段，且"带着超限的种子派发等于派发一次立刻触发的
// 接续"）· § 23 U6（三个模型相关的量，**这一站只建立口径**）· § 8.15（`prefix-hit-rate` 的
// 输入就是这套字节——那八个指标住在 src/probe/metrics.ts）· § 8.13.a（循环重启）。
//
// **它是纯函数。** 输入是一份**已编码的请求**（这一步真要发出去的那一份字节）与一份声明，
// 出口是三个数与一个判决——不读日志、不碰模型、不认识 agent。于是"触发点到了没有"这件事在
// 真调用之前就答得出来（`B0` 那道闸的同一条理由：账不对的时候，真调用的读数不可解释，而钱
// 已经花了）。
//
// **三个数只有一处定义**：`ModelDecl.contextLimit` 是那一个上界，`trigger` 与 `handoffMargin`
// 由 `contract.ts` 的 `triggerAt()` 与声明一起给。这一份不自己算那个比例，也不自己定余量——
// 它只读。
import { UNCALIBRATED } from './calib.ts'
import type { Calibration } from './calib.ts'
import type { ModelDecl } from '../model/contract.ts'

/**
 * 一份估账用哪把尺。**尺只有这一把，账上每一个数都从它过。**
 *
 * 真正的 token 数只有提供方的分词器答得准，而那是要出网才知道的东西——`B0` 的闸要求这笔账
 * **离线**算出来，于是这里是一把保守的粗尺：**非 ASCII 每两个字节算一个 token**（一个三字节的
 * 汉字因此约 1.5 个，而真实分词通常更少）· **ASCII 每四个字节算一个**（英文与代码的常见比值，
 * 取整时向上）· 再加一个固定的信封（`ENVELOPE_TOKENS`，8 个）。请求体自己已经带着 JSON 的
 * 信封了，这 8 个是**保守余量**：估账宁可早触发一步，不要贴着地板走。
 *
 * **它是估账，不是读数**：读数在 `llm/call` 的 `usage` 那四个数里（真调用之后才有）。这笔账
 * 的用处只有一个——**在真调用之前判断"这一步发不发得出去"**。
 *
 * 按字节数记账是比它更粗的一侧：1 token ≥ 1 字节在两种脚本下都成立（中文一字三字节而约一个
 * token，英文一个 token 约四个字节），所以字节数一定不小于 token 数，那个上界不会被真实分词
 * 顶穿——代价是中文那一段被算贵一倍。这一把尺离真读数更近，代价换成了"准头要校准"，那件事
 * 归 `B7` 的基线那一档；**在核准之前它给的仍然是估账。**
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
  /**
   * 这一步的上下文用了多少——**已编码请求**（`BudgetAsk.body`）按那把尺估出来的 token，过了修正。
   */
  readonly used: number
  /**
   * 那把尺的**原始读数**：修正只改 `used`，不改它。
   *
   * 它是"下一次算那个比值"的底（真读数 ÷ 它），所以它必须留在账上——不然修正会自己乘自己。
   */
  readonly raw: number
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
  /**
   * **这一步要发出去的那份请求字节**（目标 wire 的 `bytes` 编出来的那一份）。
   *
   * 不是三区文本的拼法：JSON 的字段名 · 角色包装 · 工具 schema · 原生轮次 · 判词那几条 user
   * 消息全在里面。预算量的必须与发出去的是同一份——否则比值校准的两端永远不是同一把尺。
   */
  readonly body: Uint8Array
  /**
   * **现在交接的话，请求体会变成的那一份**（交接提示词已经写进 B 区；同一目标 wire 编出来）。
   *
   * 不给 = 这一步不估交接（判决只答"到了触发点没有"）；给了才答"交接写不写得下"。
   */
  readonly bodyWithHandoff?: Uint8Array
  /**
   * 一份修正：这一趟之前量到的"真 ÷ 估"。不给就是那把尺的原始读数（`UNCALIBRATED`）。
   *
   * **它改的是账，不是尺**：真读数来自 `llm/call` 的 `usage`，比值由 `src/runtime/calib.ts`
   * 一处算（最近八份的中位数）。没有读数时账一个字都不动。
   */
  readonly calib?: Calibration
}

/** 一段文本的字节：**进尺的那一份**（UTF-8，与装配器写出来的字节同一个量法）。 */
const bytesOfText = (text: string): Uint8Array => new TextEncoder().encode(text)

/** 一段文本的估账。与 `planBudget` 同一把尺——**要单独印某一小段的时候也走这里**。 */
export function estimateTokensOfText(text: string): number {
  return estimateTokens(bytesOfText(text))
}

/**
 * 凝聚理解那一栏的上限（架构 § 15.1.a）：**50 000 token**。
 *
 * **超了报出来，不裁剪。** 它是持轮者写的一份理解，不是配额——越过这条线是异常（模型把"这段
 * 理解"写成了另一篇文档），而不是"该裁一段"。这里不给"拒"这个动作：产物已经进日志了，拒没有
 * 对象；报出来由读的人判。
 */
export const DISTILL_LIMIT_TOKENS = 50_000

/**
 * 量一次凝聚理解：在限度之内给 `null`，超了给一句带两个数的话（超了多少 · 上限多少）。
 *
 * 它与 `seed` 超限那一句同一个形状（`contract/build.ts` 的 `seed` 那一条）：**都要把两个数说
 * 出来**——只报"超了"没有可核对的东西（架构 § 8.12 那条"不裁剪后照发"的同一族纪律）。
 */
export function overDistillLimit(text: string): string | null {
  const tokens = estimateTokensOfText(text)
  if (tokens <= DISTILL_LIMIT_TOKENS) return null
  return (
    `凝聚理解 ${tokens} token 超过上限 ${DISTILL_LIMIT_TOKENS} token——超 ${tokens - DISTILL_LIMIT_TOKENS}；` +
    '它是模型的产物，不裁剪，报出来由人判（架构 § 15.1.a）。'
  )
}

/**
 * 算这一步的账。
 *
 * **顺序是刻意的**：先算"这一步用了多少"，再看它有没有过触发点，最后看**交接写不写不下**
 * ——三档因此是三个数之间的比较，没有一处拍脑袋。
 *
 * `used` 里那一块交接的算法：判决要回答"到了触发点这一步，交接提示词还塞不塞得进
 * 下一次调用"。所以它是 `这一步 + 交接 + 余量`：**那三样一起不超过上限**才算 `restart`。
 * 交接那一段取的是**两份已编码请求的差**——同一把尺、同一个信封，差里不会多算一次信封。
 */
export function planBudget(ask: BudgetAsk): BudgetPlan {
  // 上限那一栏在一等字段上（`contextLimit`），触发点与余量在 `budget` 那一格里——**三处名字**
  // 各有各的出处，这一份只读，不自己算比例。
  const limit = ask.decl.contextLimit
  const budget = ask.decl.budget
  // **这一笔账只量一份字节**：调用方递进来的就是目标 wire 编出来的那一份请求，与 `callModel`
  // 发出去的逐字节相同。三个数（上限 · 触发点 · 余量）与 `used` 因此落在同一个口径上。
  const raw = estimateTokens(ask.body)
  const calib = ask.calib ?? UNCALIBRATED
  // **修正的是一个比值**（真 ÷ 估）：账上的每一个加数都过它，尺的原始读数留在 `raw` 里。
  const used = Math.ceil(raw * calib.ratio)
  const headroom = limit - used
  const handoff =
    ask.bodyWithHandoff === undefined
      ? 0
      : Math.max(0, Math.round((estimateTokens(ask.bodyWithHandoff) - raw) * calib.ratio))
  const withHandoff = used + handoff + budget.handoffMargin
  const note = calib.samples === 0 ? '' : `（按 ${calib.samples} 份真读数修 ×${calib.ratio.toFixed(2)}）`

  if (used < budget.trigger) {
    return {
      limit,
      trigger: budget.trigger,
      handoffMargin: budget.handoffMargin,
      used,
      raw,
      headroom,
      kind: 'continue',
      why: `用了 ${used}${note}，还没到触发点 ${budget.trigger}（差 ${budget.trigger - used}）。`,
    }
  }
  if (withHandoff > limit) {
    return {
      limit,
      trigger: budget.trigger,
      handoffMargin: budget.handoffMargin,
      used,
      raw,
      headroom,
      kind: 'stop',
      // **地板那一档**：不静默、不裁剪后照发（架构 § 8.12 那一条）。四项分开印，读的人当场核得动
      // 「是哪一项凑出了那个超过量」——只报「超了」没有可核对的东西。`--no-handoff` 那一档交接
      // 提示词是空串，那一项照印 `0`：于是「这一步自己越过了多少」一眼看得出，不用去猜差额是谁凑的。
      why:
        `用了 ${used}${note}（触发点 ${budget.trigger}）：扣掉交接提示词 ${handoff} 与余量 ${budget.handoffMargin}，` +
        `留给这一步的是 ${limit - handoff - budget.handoffMargin}，而这一步要的比它多 ${withHandoff - limit}` +
        `——到这里就停，不裁剪后照发。`,
    }
  }
  return {
    limit,
    trigger: budget.trigger,
    handoffMargin: budget.handoffMargin,
    used,
    raw,
    headroom,
    kind: 'restart',
    why: `用了 ${used}${note}，过了触发点 ${budget.trigger}；交接提示词 ${handoff} 加余量 ${budget.handoffMargin} 塞得下（还剩 ${limit - withHandoff}）。`,
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
