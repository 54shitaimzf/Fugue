// 放行之后接着跑：**从日志里把那一批契约读回来**，接上 `runIssued` 那条尾巴。
// 出处：架构 § 15.1.a（"派"之后那一环：N 条分支各自跑一格 · 门仍由人开）· 架构 § 8.13
// （`Delegated ──branches-started──> Working`）· 架构 § 8.12（契约住日志里：事件带正文）·
// PLAN § 5.10 的 C4 行 · § 5.11 的判据一句话（放行后真模型跑 · 真产物 · 真断言 · 逐字节一致）。
//
// **为什么这一份存在**：`round go` 只做三件事——落 `round/approve` · 逐条 `contract/issue` · N 条
// 分支定在同一个底上（`dispatch.ts` 的 `issueAndStart`）。**它不跑格**，而"跑格"那一半原先只挂在
// `round run` 那条入口上，那一条的契约来自配置里的 `round.split`（人拆那一档 · 从 `Idle` 起头）。
// 于是"系统自己拆"那条路走到 `Working` 就断在那里——处境写着在干活，账上属于那批契约的 `llm/call`
// 一条都没有。走查 § 四 把那句缺口原样印了很久（`tools/walkthrough-s9.sh` 那一行），这一份补它。
//
// **真源仍然只有两处**：契约的正文在 `contract/issue` 的 `body` 里（架构 § 8.12：契约住日志里），
// 底在 `round/intent` 的 `base` 里。这一份**只读日志**——不读配置 · 不读视图 · **不重算契约**
// （重算就是第二处判决，而"人批的是哪一批"当场失效；判那一处只有 `contract/gate.ts` 一份）。
import type { Contract } from '../contract/types.ts'
import type { LogReader } from '../log/events.ts'
import type { PrecheckResult } from '../contract/precheck.ts'
import { planningGate } from '../contract/precheck.ts'
import type { RoundId, WriterId } from '../terms.ts'
import type { IssuedBatch } from './execute.ts'
import type { RoundState } from './machine.ts'
import { roundFactsOf } from './versions.ts'

/** 这一层自己的失败：处境不对 · 日志里没有那一批 · 那批契约自己不自洽。**拒，而且指得出路。** */
export class RoundWorkError extends Error {
  constructor(why: string) {
    super(why)
    this.name = 'RoundWorkError'
  }
}

/**
 * 处境不对时那句话。**每一档都指一条路**：这一份拒的时候不许只说"不行"。
 *
 * 出口只有 `Working` 一处：那一处正是 `round go` 走完（契约发了 · 分支起了）而格还没跑的那个
 * 瞬间。别的处境各有各的路，逐档写在这里，而不是让调用点拼一句话。
 */
export function whyNotWorking(state: RoundState): string {
  if (state === 'Idle') {
    return '这一轮还没落地：先 fugue round plan <目标>（草案由人写那一档加 --judge），再放行。'
  }
  if (state === 'Planning') {
    return '这一轮还停在门口等人批：先 fugue round go 放行——契约是放行那一下才发出去的（门由人开）。'
  }
  if (state === 'Delegated') {
    return (
      '这一轮的处境是 Delegated：契约发了而分支没起齐（branches-started 那一步没走完）。' +
      '这一段没有接着跑的入口——先看 round/state 那条链上最后一条为什么没落地。'
    )
  }
  return (
    '这一轮的处境是 ' +
    state +
    '：那批契约已经跑过了（round work 只在 Working 那一处接着跑——同一批不重复派发，架构 § 15.1.a）。' +
    '要重跑就换一个轮次号：fugue config set round.id <新号>。'
  )
}

/**
 * 从日志里读回**这一轮已经发出去的那一批**。
 *
 * 三件事：① 处境必须是 `Working`（放行之后 · 跑之前）；② 底是 `round/intent` 里钉住的那一个；
 * ③ 契约逐条从 `contract/issue` 的正文里取回来（按发生次序——它就是构造次序，契约的 `id` 与
 * 身份那条线都按它读）。预检**重算一次**：与门那一趟是同一个函数（`planningGate`），所以读到
 * 的是同一份读数，不是第二处判决。
 *
 * 一条自洽检查当场报出来（不挑一个信）：事件里那一栏 `owner` 与契约正文里的 `agent`。两者不一致
 * 的时候，这份日志对同一件事有两处说法，而两处都合法。（**底不在契约里**：`ContractBase` 只有
 * `id` · `agent` · `branch` · `goal`——底是轮次那一层的，只有 `resolve` 那一份带它，而那一份不
 * 走 `contract/issue`。）
 */
export async function issuedBatchOf(log: LogReader, round: RoundId): Promise<IssuedBatch> {
  const facts = await roundFactsOf(log, round)
  if (facts.state !== 'Working') throw new RoundWorkError(whyNotWorking(facts.state))
  const base = facts.base
  if (base === null) {
    throw new RoundWorkError(
      '日志里找不到第 ' +
        round +
        ' 轮钉住的底：轮次开始时那一条 round/intent 记着它。（处境是 Working 却没有底——这份日志自己不自洽。）',
    )
  }

  const contracts: Contract[] = []
  for await (const e of log.readByWriter('round' as WriterId)) {
    if (e.t !== 'contract/issue' || e.round !== round) continue
    let c: Contract
    try {
      c = JSON.parse(e.body) as Contract
    } catch (err) {
      throw new RoundWorkError('contract/issue 的正文读不成一份契约（' + e.contract + '）：' + (err as Error).message)
    }
    // **那一栏是给读日志的人看的**（"这份契约要写哪儿"）：它与正文里那个 agent 对不上，就是
    // 两处说法；当场报出来。
    if (e.owner !== (c.agent as string)) {
      throw new RoundWorkError(
        'contract/issue 里的 owner 与正文里的 agent 不是同一个：' + e.owner + ' ≠ ' + String(c.agent) + '（' + e.contract + '）',
      )
    }
    contracts.push(c)
  }
  if (contracts.length === 0) {
    throw new RoundWorkError(
      '第 ' + round + ' 轮的日志里没有 contract/issue：处境是 Working 却没有契约——这一轮不是从 round go 起的那一条路。',
    )
  }

  const precheck: PrecheckResult = planningGate(contracts).result
  return { round, base, contracts, precheck }
}
