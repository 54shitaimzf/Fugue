// U18 甲案的机制层：**轮内收下的子 agent 问题，由持轮者做一次不积累上下文的裁断**。
//
// 出处：架构 § 23 的 U18 那一格（"子 agent 不问人……问题得先在轮内被接住，再由持轮者拿到人面前"）
// · 路线图 0.2.7 行 ②（甲案 + 审批档：复用 A 区 · 契约 + 问题 + 固定尺走近因；判决落事件 ·
// 推敲不进任何人 C 区；固定尺为版本化常量（两类进人 · 三档）；退化路全转发）· 架构 § 8.4 纪律 2
// （子 agent 手里是一份契约，不是一张嘴）。
//
// **这一份只有四样：尺 · 一次裁断 · 判决 · 事件的两个形状。**
//
//   · **尺**：`ASK_RULER`（三档 · 两类进人）与它的版本号。尺是**版本化常量**——判词的形状从这里
//     长出来，改尺就是换版本，所以"这一条判决是按哪把尺量出来的"在事件里答得出来。
//   · **一次裁断**（`adjudicateAsk`）：一个调用，上下文**一次性**（A 区字节原样 · 契约 · 问题原文 ·
//     固定尺），用完即弃。**它读不到那一格走过的步**——那正是"不积累上下文"这句话的形状：
//     那一格的 turns · 上一步结果 · 它自己说过的话，一样都不在输入里。
//   · **判决**（`AskVerdict`）：三档之一 + 判词；**判不出来时那条退化路**（`forwardAll`）：
//     问题原样转给该进的人，不是丢。
//   · **事件的两个形状**：问题被接住那一条由驱动那一层落（`ask/raised`）· 判决那一条落
//     `ask/ruling`（**只带结论**：档 · 判词 · 尺的版本 —— 推敲哪儿都不落）。
//
// **为什么它住在 `round/`**：接住问题的是轮次（"轮内收下"），做裁断的是持轮者那一格——两者都是
// 轮次的角色。工具面那一层只把问题**带出来**（`ask_user_question` 的回执里那一栏），不认识尺。
import type { AssembleState } from '../assemble/sources.ts'
import type { Contract } from '../contract/types.ts'
import type { ModelEvent } from '../model/contract.ts'
import type { Target } from '../model/http.ts'
import type { WireAdapter } from '../model/wire/stream.ts'
import type { CallModel, RuntimeRequest } from '../runtime/step.ts'
import { digestOf } from '../runtime/restart.ts'
import type { AskItem } from '../tools/execute.ts'
import type { AgentId, AskTier, ContractId } from '../terms.ts'
import type { Log, LogEvent } from '../log/events.ts'
import type { WriterId } from '../terms.ts'

// 三档的名字住 `terms.ts`（那份事件联合只依赖它）；这一份转发，消费者引这里或引那里是同一个词。
export type { AskTier }

export interface AskTierRule {
  readonly tier: AskTier
  /** 这一档由谁定：`self` = 持轮者按"最干净、最可扩展"自决 · `human` = 进人。 */
  readonly who: 'self' | 'human'
  readonly text: string
}

/**
 * **尺的版本**。它随判词的形状一起走：改尺改版本，于是"这一条判决是按哪把尺量出来的"读得出来。
 * 事件里落的就是它（`AskVerdict.ruler`）。
 */
export const ASK_RULER_VERSION = 'ask-ruler-1'

/**
 * **固定尺（版本化常量）**：三档，两类进人。判据在这里，判决不在这里——这一份只把尺说清楚，
 * 谁在哪一档上由裁断那一次读出来。
 *
 * 头一档是**契约自己的地界**（哪条路径归它 · 已经谈定的形状怎么用 · 它自己面上怎么命名）；
 * 后两档是工作区那条纪律里点名的两类：**设计预期**（要推翻架构里的哪一句，或者把某一节的形状
 * 定下来——接口 · 口径 · 命名 · 站与站的边界）与**用户面影响**（人看得见的行为变了，或者
 * "变好还是变坏"要人定）。
 */
export const ASK_RULER: readonly AskTierRule[] = [
  {
    tier: 'contract',
    who: 'self',
    text:
      'the question lives inside the ground this contract already has: which of the paths that are yours to write, ' +
      'how to use a shape that is already agreed, what to call something inside your own surface. Settle it yourself by ' +
      '"cleanest and most extensible" and say the ruling in one sentence.',
  },
  {
    tier: 'design',
    who: 'human',
    text:
      'answering it would overrule a sentence of the architecture, or fix the shape of a section (an interface, a convention, ' +
      'a name, the boundary between two stations). A person decides this.',
  },
  {
    tier: 'user',
    who: 'human',
    text:
      'answering it changes what a person sees or does (the high-level behaviour of the TUI / GUI / WebUI), or "better or worse" ' +
      'is a person\'s call. A person decides this.',
  },
]

/** 进人那几档。**从尺上推**，不另抄一份名单（抄一份就会漂）。 */
export function humanTiers(): readonly AskTier[] {
  return ASK_RULER.filter((r) => r.who === 'human').map((r) => r.tier)
}

/** 自决那一档（尺上 `who === 'self'` 的那一条）。 */
export function selfTiers(): readonly AskTier[] {
  return ASK_RULER.filter((r) => r.who === 'self').map((r) => r.tier)
}

/**
 * 尺的正文：**给模型看的那一份**，从 `ASK_RULER` 长出来（表与正文不许各写一份）。
 *
 * 回复的形状是**两行、键是英文**（模型面英文 · 人面中文）：`tier:` 与 `ruling:`。解析那一侧
 * （`verdictOf`）认的就是这两行——多一行少一行都算判不出来，走退化路。
 */
export function askRulerText(): string {
  const self = selfTiers()
  const lines = [
    `Ask ruler (${ASK_RULER_VERSION}). You are the round holder judging a question that a contract cell carried back. ` +
      'You have no history of that cell and you will not get any: judge from the policy above, the contract below and the ' +
      'question itself — nothing else.',
    'Pick exactly one tier:',
  ]
  for (const rule of ASK_RULER) lines.push(`  tier: ${rule.tier} — ${rule.text}`)
  lines.push(
    `Anything you cannot place in ${self.length === 1 ? `the "${self[0]}" tier` : `a "self" tier (${self.join(' · ')})`} goes to a person. ` +
      'Never settle a design or user question yourself, and **never drop a question**: a question you cannot answer is forwarded, not discarded.',
  )
  lines.push('Reply with exactly two lines and nothing else:')
  lines.push(`  tier: ${ASK_RULER.map((r) => r.tier).join(' | ')}`)
  lines.push('  ruling: <one sentence — for the self tier the ruling itself; for the other two, what the person has to decide>')
  return lines.join('\n')
}

/** 尺的正文（常量：同一条尺在两次裁断里逐字节相同）。 */
export const ASK_RULER_TEXT = askRulerText()

/**
 * 一次裁断的判决。
 *
 * `tier === null` 是**判不出来**那一档（回复读不出档与判词 · 调用抛了 · 截了）——它恒进人：
 * 「退化路全转发」那句话在这里是一条不变量（`tier === null` ⇒ `forwarded === true`）。
 */
export interface AskVerdict {
  readonly tier: AskTier | null
  readonly forwarded: boolean
  readonly ruling: string
  readonly ruler: string
  /** 为什么走退化路（只有那一档有）。 */
  readonly why?: string
}

const TIER_LINE = /^[ \t]*tier[ \t]*[:：][ \t]*(contract|design|user)[ \t]*$/im
const RULING_LINE = /^[ \t]*ruling[ \t]*[:：][ \t]*(\S.*)$/im

/**
 * **退化路全转发**：判不了就把这一批问题**原样**交给该进的人，不是丢。
 *
 * 三种情形走同一条：回复读不出那两行 · 调用没走完（截了 · 提供了失败）· 调用抛了。三种都在这一处
 * 收口，不在调用点各写一遍——"判不出来"只有一个去处。
 */
export function forwardAll(why: string): AskVerdict {
  return {
    tier: null,
    forwarded: true,
    ruling: `裁断没做成（${why}）——问题原样转给该进的人。`,
    ruler: ASK_RULER_VERSION,
    why,
  }
}

/** 一份回复 → 判决。**认不出那两行就走退化路**（不是猜一档，也不是当成功）。 */
export function verdictOf(reply: string): AskVerdict {
  const tier = TIER_LINE.exec(reply)?.[1] as AskTier | undefined
  const ruling = RULING_LINE.exec(reply)?.[1]?.trim()
  if (tier === undefined || ruling === undefined || ruling === '') {
    const seen = reply.trim()
    return forwardAll(
      seen === ''
        ? '那一次调用没说出话（回复是空的）'
        : `回复里读不出 \`tier:\` 与 \`ruling:\` 那两行（开头是 ${JSON.stringify(seen.slice(0, 60))}）`,
    )
  }
  return { tier, forwarded: humanTiers().includes(tier), ruling, ruler: ASK_RULER_VERSION }
}

/**
 * 一次裁断的**全部输入**。**没有第五样**——这就是"不积累上下文"那句话的形状：
 *
 *   · `aZone`：**复用 A 区**（真方针 + 系统状态 + 代码树，装配出来的那一段字节，原样搬进请求）。
 *   · `contract` + `task`：这一格手里那份契约与它拿到的那句问题（§ 8.12）。
 *   · `asks`：问题原文，一个字段都不改（`ask_user_question` 那一批的形状）。
 *
 * 那一格走过的步 · 上一步结果 · 它自己说过的话**一样都不在里面**：它们住 C 区，而这一份的 C 区
 * 是空的（见 `adjudicateAsk`）。
 */
export interface AskAdjudicationInput {
  readonly aZone: Uint8Array
  readonly contract: Contract
  readonly task: AssembleState['task']
  readonly asks: readonly AskItem[]
}

/**
 * 裁断那一次要说的话：契约的地界 + **尺** + 问题原文（**排在最后**）。
 *
 * 问题排最后是"近因"那一条（§ 8.11 的「近因最好」）：它读到的最后一处是什么，判的就是什么。
 * 尺排在问题之前——尺是判据，问题是被判的那一件事。
 */
export function askPromptOf(input: AskAdjudicationInput): string {
  const t = input.task
  const lines: string[] = [
    `Contract: ${input.contract.id} (${input.contract.kind})`,
    `Goal: ${input.contract.goal}`,
    `Question this cell was given: ${t.question}`,
  ]
  const owned = t.ownedPaths ?? []
  if (owned.length > 0) lines.push(`Write surface: ${owned.join(' · ')}`)
  if (t.deliverables.length > 0) lines.push(`Deliverables: ${t.deliverables.join(' · ')}`)
  if (t.assertions.length > 0) lines.push(`Assertions: ${t.assertions.join(' · ')}`)
  lines.push('', askRulerText(), '')
  lines.push(`Question carried back from that cell (${input.asks.length}):`)
  input.asks.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.question}`)
    if (a.header !== undefined && a.header !== '') lines.push(`   header: ${a.header}`)
    for (const o of a.options ?? []) {
      lines.push(`   - ${o.label}${o.description === undefined ? '' : `：${o.description}`}`)
    }
  })
  return lines.join('\n')
}

/** 走一次裁断要的那几样（都是值：这一层不认识日志、不认识视图）。 */
export interface AskCallDeps {
  readonly call: CallModel
  readonly target: Target
  readonly adapter: WireAdapter
  readonly model: string
  readonly signal?: AbortSignal
}

/**
 * 走一次裁断：**一个调用**，上下文一次性，用完即弃。
 *
 * 请求的三区直接照规格摆：**A 区 = 复用那一段字节**（原样），**B 区 = 尺 + 契约 + 问题原文**，
 * **C 区是空的**——那一格的历史一个字都不进这次调用，而这次调用的推敲（请求正文 · 原始回复）
 * 也不落任何地方：出去的只有判决（`verdictOf` 那两行）。
 *
 * 调用抛了 · 没走完 · 回复读不出那两行，三条都归 `forwardAll`——不在调用点各写一遍。
 */
export async function adjudicateAsk(input: AskAdjudicationInput, deps: AskCallDeps): Promise<AskVerdict> {
  const encoder = new TextEncoder()
  const request: RuntimeRequest = {
    target: deps.target,
    adapter: deps.adapter,
    prefix: { zoneA: input.aZone, zoneB: encoder.encode(askPromptOf(input)), zoneC: new Uint8Array() },
    // **一个工具都不公布**：这一次裁断只说话，不伸手（伸手的是那一格，不是判它的这一格）。
    tools: [],
    model: deps.model,
  }
  let said = ''
  try {
    const reply = deps.call(request, deps.signal ?? new AbortController().signal)
    for await (const e of reply.events as AsyncIterable<ModelEvent>) {
      if (e.t === 'delta') said += e.text
    }
    const led = reply.ledger()
    if (led.failure !== null) return forwardAll(`那一次调用没走完：${led.failure}`)
  } catch (err) {
    return forwardAll(`那一次调用抛了：${(err as Error).message}`)
  }
  return verdictOf(said)
}

/** 问题被接住那一条：`ask/raised`（形状见 `log/events.ts`）。**正文就是那一批问题本身**。 */
export function raisedEventOf(agent: AgentId, contract: ContractId, asks: readonly AskItem[]): LogEvent {
  const body = JSON.stringify({ questions: asks })
  return { t: 'ask/raised', agent, contract, digest: digestOf(body), body }
}

/**
 * 判决那一条：`ask/ruling`。**只带结论**——档 · 判词 · 尺的版本（`body` 里那一份是留档的全文），
 * 推敲不进这里，也不进任何人 C 区（红线 ②）。
 *
 * `asked` 指回被接住那一条的 `digest`：同一格可以问好几回，"这一条判决判的是哪一问"要选得出来
 * （读日志的人按它对账）。
 */
export function rulingEventOf(agent: AgentId, asked: string, verdict: AskVerdict): LogEvent {
  const body = JSON.stringify({
    tier: verdict.tier,
    forwarded: verdict.forwarded,
    ruling: verdict.ruling,
    ruler: verdict.ruler,
    ...(verdict.why === undefined ? {} : { why: verdict.why }),
  })
  return {
    t: 'ask/ruling',
    agent,
    asked,
    forwarded: verdict.forwarded,
    ...(verdict.tier === null ? {} : { tier: verdict.tier }),
    ruler: verdict.ruler,
    digest: digestOf(body),
    body,
  }
}

/**
 * **轮内收下那一趟**：接住 → 一次裁断 → 判决落事件 → 进人那一档**问题原样**转到人那道门口。
 *
 * 三件事的顺序就是规格的顺序（路线图 0.2.7 行 ②）：问题先落 `ask/raised`（重放读得到"谁问了
 * 什么"），再裁（读的是 A 区 · 契约 · 问题 · 尺那四样），判决落 `ask/ruling`；进人那一档再补一条
 * `holder/ask`——**正文与 `ask/raised` 那一份逐字节相同**（"问题原样转给该进的人，不是丢"）。
 *
 * 判不了的那一档走同一条：`forwarded` 恒真，于是它一样转出去。**这里没有第二条分支**——"判不出来"
 * 只有一个去处。
 *
 * 返回值里那一句 `note` 是**给那一格的下一步看的**：结论（判词）进它 C 区那一栏，推敲不进。
 */
export interface TakeAsksInput {
  readonly log: Log
  readonly writer: WriterId
  readonly agent: AgentId
  readonly contract: Contract
  readonly task: AssembleState['task']
  readonly asks: readonly AskItem[]
  /** 复用的 A 区字节（`prefixOf(handle).zoneA`：真方针 + 系统状态 + 代码树）。 */
  readonly aZone: Uint8Array
  readonly call: CallModel
  readonly target: Target
  readonly adapter: WireAdapter
  readonly model: string
  readonly signal?: AbortSignal
}

export interface TakeAsksResult {
  readonly verdict: AskVerdict
  readonly asked: string
  /** 进那一格下一步 C 区的那一句：**只带结论**（判词），不带推敲。 */
  readonly note: string
}

export async function takeAsks(input: TakeAsksInput): Promise<TakeAsksResult> {
  const raised = raisedEventOf(input.agent, input.contract.id as ContractId, input.asks)
  await input.log.append(input.writer, raised)
  const verdict = await adjudicateAsk(
    { aZone: input.aZone, contract: input.contract, task: input.task, asks: input.asks },
    {
      call: input.call,
      target: input.target,
      adapter: input.adapter,
      model: input.model,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  )
  await input.log.append(input.writer, rulingEventOf(input.agent, raised.digest, verdict))
  if (verdict.forwarded) {
    // **问题原样转出去**：同一条正文（连 `digest` 都相同）——转出去的是那一问，不是它的摘要。
    await input.log.append(input.writer, { t: 'holder/ask', agent: input.agent, digest: raised.digest, body: raised.body })
  }
  const note = verdict.forwarded
    ? `Ask carried back from this cell was forwarded to a person (${verdict.tier ?? 'unjudged'} · ruler ${verdict.ruler}): ${verdict.ruling}`
    : `Ask carried back from this cell was settled inside the contract (ruler ${verdict.ruler}): ${verdict.ruling}`
  return { verdict, asked: raised.digest, note }
}

/**
 * 一份日志里的问题对：**被接住 · 还没判**的（按 `(agent, digest)` 配对——判决那一条的 `asked`
 * 指回它）。已被判过的不再判第二回：同一问只裁一次。
 */
export function unansweredAsks(
  events: readonly LogEvent[],
): { readonly agent: AgentId; readonly contract: ContractId; readonly digest: string; readonly asks: readonly AskItem[] }[] {
  const ruled = new Set<string>()
  for (const e of events) if (e.t === 'ask/ruling') ruled.add(`${String(e.agent)}\u0000${e.asked}`)
  const out: { agent: AgentId; contract: ContractId; digest: string; asks: readonly AskItem[] }[] = []
  for (const e of events) {
    if (e.t !== 'ask/raised') continue
    if (ruled.has(`${String(e.agent)}\u0000${e.digest}`)) continue
    let asks: readonly AskItem[] = []
    try {
      const parsed = JSON.parse(e.body) as { questions?: readonly AskItem[] }
      asks = parsed.questions ?? []
    } catch {
      asks = []
    }
    out.push({ agent: e.agent, contract: e.contract, digest: e.digest, asks })
  }
  return out
}
