// 答完接着走：`fugue say <一句话>`。出处：架构 § 15.1.a（"问与答：人的话是这一趟的输入，答完
// 接着走" · 那张"两态各自常驻什么"的表 · "预备态里人的话不留第二份"）· 架构 § 9.10（保留前缀
// `.fugue/session/`：讨论原文归档，按轮分文件）· 架构 § 8.11 的两张表（持轮者的 B 区多两段：
// 凝聚理解 · 压缩前最近几次原文）· 架构 § 23 U10（最近几次 = 3 条 · 凝聚上限 50 000 token）·
// PLAN § 5.10 的 `C5`。
//
// **两个状态，一个命令，一个判据都不用新加。** 人的话是这一趟的输入（进的是尾端第一条，定义处
// 是 `assemble/sources.ts` 的 `cZoneHeadOf`），而产物分两档：
//
//   讨论态（`Idle`）      这场对话就是这一态的状态：那句话落进 `.fugue/session/<轮次>.jsonl`，
//                         这一趟的产物是**修正后的理解**（它最后说的那一段话 → `holder/distill`）。
//                         这一态的处境**不动**——讨论不落地，落地是 `round plan`（架构 § 8.13：
//                         `Idle` 是讨论态）。
//   预备态（`Planning`）  这一态的常驻物是那份草案：那句话**不另存**（工作区里找不到第二份），
//                         这一趟改的是草案 → 重判 → 仍然停在门口。
//
// **停下来的那一处没有"等"这种状态**（架构 § 15.1.a）：这一份不是一个后台任务——`sayRound`
// 返回的时候那一趟已经跑完了。
//
// **它不做判断。** 门那一趟的判据在 `contract/gate.ts`（这一份只是把它再跑一遍），凝聚超限那条
// 尺在 `runtime/budget.ts`（超了也只是报出来，不裁剪、不拒）。
import type { AgentId, CommitId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { Log, LogSeq } from '../log/events.ts'
import type { Truth } from '../truth/contract.ts'
import type { View } from '../view/contract.ts'
import type { AgentHandle, CallModel, ToolExecutor } from '../runtime/step.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import { applyEdit } from '../view/edit.ts'
import { overDistillLimit } from '../runtime/budget.ts'
import { digestOf } from '../runtime/restart.ts'
import { roundStateOf } from './dispatch.ts'
import { holderPass } from './plan.ts'
import type { HolderExit, PlanResult } from './plan.ts'
import type { RoundState } from './machine.ts'

/** 这一层自己的失败：这一轮不在能说话的那两个处境里 · 没给一句话 · 预备态那一趟没给跑法。 */
export class SayError extends Error {}

/** 讨论原文归档那一个保留前缀（架构 § 9.10）。**按轮分文件**。 */
export const SESSION_DIR = '.fugue/session'

/**
 * 这一轮的会话记录住哪儿。
 *
 * **`.jsonl`：一行一条。** 条数是数出来的，正文里的换行由 JSON 那一层带着——换成"一段一条"的
 * 文本格式，一句话里带一个换行就会把一条拆成两条，而"最近 3 条"那个数会静静地变成 4 条。
 */
export function sessionPathOf(round: RoundId): RelPath {
  return `${SESSION_DIR}/${round}.jsonl` as RelPath
}

/** 「压缩前最近几次原文」放几条。**3**（架构 § 23 U10 定的那个数，不是这里拍一个）。 */
export const RECENT_COUNT = 3

/** 一条记录：谁说的 · 原文。 */
export interface SessionLine {
  readonly who: string
  readonly text: string
}

/** 把一条追加进会话记录。**原文照抄**——除 JSON 那一层的转义，一个字符都不加工。 */
export function recordOf(session: string, who: string, text: string): string {
  const line = JSON.stringify({ who, text })
  if (session === '') return `${line}\n`
  return session.endsWith('\n') ? `${session}${line}\n` : `${session}\n${line}\n`
}

/**
 * 读回全部记录。**读不出来的那几行如实报出来**（`bad`），不猜、不补、也不当空行丢掉：
 * 会话记录是这一态的状态，而"少了一条"与"这一条坏了"在投影里长得一模一样。
 */
export function recordsOf(session: string): { readonly records: readonly SessionLine[]; readonly bad: readonly string[] } {
  const records: SessionLine[] = []
  const bad: string[] = []
  for (const line of session.split('\n')) {
    if (line.trim() === '') continue
    try {
      const one = JSON.parse(line) as { who?: unknown; text?: unknown }
      if (typeof one.who !== 'string' || typeof one.text !== 'string') {
        bad.push(line)
        continue
      }
      records.push({ who: one.who, text: one.text })
    } catch {
      bad.push(line)
    }
  }
  return { records, bad }
}

/**
 * 那一段投影：**最近 `n` 条原文**（架构 § 8.11 的「压缩前最近几次原文」）。
 *
 * 它是**投影，不是留档**：原文留在 `.fugue/session/` 里按坐标取回（`fugue read`），进前缀的只有
 * 最近这几条。说话人那一栏带着——不然"这一句是谁说的"要靠上下文猜。
 */
export function recentOf(session: string, n: number = RECENT_COUNT): string {
  const { records } = recordsOf(session)
  return records
    .slice(Math.max(0, records.length - n))
    .map((r) => `${r.who}：${r.text}`)
    .join('\n')
}

/** 说一句话要的东西。**全是值或注入的接缝**（与 `PlanDeps` 同一条纪律：不读配置、不读命令行）。 */
export interface SayDeps {
  readonly round: RoundId
  /** 人说的那一句（**原文**）。它进的是这一趟的尾端第一条。 */
  readonly text: string
  /** 持轮者那一份视图。写会话记录 · 读会话记录用的是**同一个对象**（一处开两份的症状是"记录不在视图里"）。 */
  readonly view: View
  readonly log: Log
  readonly truth: Truth
  readonly writer: WriterId
  readonly head: CommitId
  /** 这一轮的意图那一句。**预备态从日志里的 `round/intent` 读**，不吃命令行那一句。 */
  readonly goal: string
  /** B 区那一段：上一版凝聚理解（`holder/distill` 的最后一条）。 */
  readonly distill: string
  /**
   * 这一趟那个句柄（`AgentHandle`）：**B 区那两段与 C 区第一条由这一趟定**——这一份知道这句话
   * 该落在哪儿，而"怎么调模型 · 用哪份工具面 · 哪个模型声明"归调用方（`PlanDeps` 同一条缝）。
   */
  readonly makeHandle: (over: { readonly runtime: string; readonly recent: string }) => AgentHandle
  readonly call: CallModel
  readonly execute: ToolExecutor
  readonly tools?: readonly ToolEntry[]
  readonly maxSteps?: number
  /** 预备态那一趟的跑法（`planRound`）：这一份不认识契约门，也不认识占用估账。 */
  readonly plan?: (over: {
    readonly goal: string
    readonly runtime: string
    readonly recent: string
  }) => Promise<PlanResult>
}

export interface SayResult {
  readonly round: RoundId
  readonly where: '讨论态' | '预备态'
  /** 这一趟之后这一轮的处境。**讨论态与进来时一样**（讨论不落地）。 */
  readonly state: RoundState
  /** 那句话（原文）。讨论态里它同时落在会话记录里；预备态里它一个字节都不落盘。 */
  readonly text: string
  readonly sessionPath: RelPath
  /** 这一场对话有几条 · 读不出来的有几行。 */
  readonly records: number
  readonly badLines: number
  /** 这一趟进 B 区的那一段投影（最近 `RECENT_COUNT` 条原文）。 */
  readonly recent: string
  /** 这一趟落下的那一条 `holder/distill` 的正文（讨论态：修正后的理解；预备态：草案那一版）。 */
  readonly distill: string | null
  /** 报出来的异常读数（凝聚越线那一类）。**不裁剪 · 不拒**——产物照旧进日志。 */
  readonly notes: readonly string[]
  readonly steps: number
  readonly exit: HolderExit
  readonly stopped: string
  /** 预备态那一趟的结果（讨论态是 `null`）。 */
  readonly plan: PlanResult | null
  readonly seqs: readonly LogSeq[]
}

/**
 * 说一句话：按**这一轮的处境**分岔（架构 § 15.1.a 那张表的两行）。
 *
 * 处境不是"这一趟想干什么"，是**这一轮此刻在哪儿**（`round/state` 那条链重放出来的）：`Idle`
 * 是讨论态、`Planning` 是预备态，其余一律拒——已经在派发/合并/验收上的那一轮不吃这一句话。
 */
export async function sayRound(deps: SayDeps): Promise<SayResult> {
  const text = deps.text.trim()
  if (text === '') {
    throw new SayError('说什么？给一句非空的话——那句话是这一趟的输入（架构 § 15.1.a 的"问与答"）。')
  }
  const state = await roundStateOf(deps.log, deps.round)
  if (state === 'Idle') return await discuss({ ...deps, text })
  if (state === 'Planning') return await prepare({ ...deps, text })
  throw new SayError(
    `这一轮的处境是 ${state}：说话只在 Idle（讨论态）与 Planning（预备态）两处。` +
      '这一句不是给"已经派发出去的那一趟"的输入——要在轮内改一件事，是那一格的契约与它的验收说了算。',
  )
}

/** 讨论态：那句话落进这场对话（累积），这一趟的产物是**修正后的理解**。 */
async function discuss(deps: SayDeps): Promise<SayResult> {
  const sessionPath = sessionPathOf(deps.round)
  const before = await textAt(deps.view, sessionPath)
  // 一 · **人说的那一句由接口写进去**（架构 § 15.1.a）。落进环境的东西在这一刻就在了——这一趟
  //     读它读的是同一份字节（B 区那一段投影里也带着它），而"这一趟的输入"是尾端第一条。
  const opened = recordOf(before, '人', deps.text)
  await writeAt(deps, sessionPath, opened)
  const recent = recentOf(opened)

  // 二 · 这一趟。**C 区第一条就是那句话**（`makeHandle` 把 `runtime` 放进去）——每一步都在。
  const pass = await holderPass({
    handle: deps.makeHandle({ runtime: deps.text, recent }),
    log: deps.log,
    call: deps.call,
    execute: deps.execute,
    ...(deps.tools === undefined ? {} : { tools: deps.tools }),
    ...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
  })

  // 三 · 产物：**它最后说的那一段话**就是修正后的理解（架构 § 15.1.a：人在讨论里说了一句话，
  //     那一趟的产物就是修正后的理解）。同一段话也进对话——两处讲的是同一件事、角色不同。
  const notes: string[] = []
  const readOver = overDistillLimit(deps.distill)
  if (readOver !== null) notes.push(`这一趟读到的凝聚理解越了线（照发，不裁剪）：${readOver}`)
  const said = pass.said.trim()
  const seqs: LogSeq[] = []
  let records = recordsOf(opened).records.length
  if (said === '') {
    notes.push('这一趟没有落下新的凝聚理解：它一句话都没说出来（半截流 · 一步就失败那一类），所以 holder/distill 这一趟没落。')
  } else {
    seqs.push(
      await deps.log.append('round', {
        t: 'holder/distill',
        round: deps.round,
        agent: 'round' as AgentId,
        digest: digestOf(said),
        body: said,
      }),
    )
    await writeAt(deps, sessionPath, recordOf(opened, '持轮者', said))
    records += 1
    const writeOver = overDistillLimit(said)
    if (writeOver !== null) notes.push(writeOver)
  }
  return {
    round: deps.round,
    where: '讨论态',
    // **处境没动**：讨论不落地（落地是 `round plan`）——所以这一条里没有 `round/state`。
    state: 'Idle',
    text: deps.text,
    sessionPath,
    records,
    badLines: recordsOf(opened).bad.length,
    recent,
    distill: said === '' ? null : said,
    notes,
    steps: pass.steps,
    exit: pass.exit,
    stopped: pass.stopped,
    plan: null,
    seqs,
  }
}

/** 预备态：那句话**不另存**——这一趟改的是那份草案，原话只在尾端第一条里出现这一次。 */
async function prepare(deps: SayDeps): Promise<SayResult> {
  if (deps.plan === undefined) {
    throw new SayError('预备态那一趟要一个跑法（`plan`）：这一份不认识契约门，也不认识占用估账。')
  }
  const sessionPath = sessionPathOf(deps.round)
  const session = await textAt(deps.view, sessionPath)
  // **不把这句话追加进会话记录**：预备态里人的话不留第二份（架构 § 15.1.a）。它的效果落在那份
  // 草案文件上——"按这句话改成了什么"写在草案里，再留一份原话就是第二份要与文件对齐的东西。
  const read = recordsOf(session)
  const recent = recentOf(session)
  const plan = await deps.plan({ goal: deps.goal, runtime: deps.text, recent })
  const notes: string[] = []
  const over = plan.draftText === null ? null : overDistillLimit(plan.draftText)
  if (over !== null) notes.push(over)
  return {
    round: deps.round,
    where: '预备态',
    state: 'Planning',
    text: deps.text,
    sessionPath,
    records: read.records.length,
    badLines: read.bad.length,
    recent,
    distill: plan.draftText,
    notes,
    steps: plan.steps,
    exit: plan.exit,
    stopped: plan.stopped,
    plan,
    seqs: plan.seqs,
  }
}

/** 一个路径的正文；没有这一份就是空串（第一次说话时那个文件还不存在）。 */
async function textAt(view: View, path: RelPath): Promise<string> {
  const bytes = await view.read(path)
  return bytes === null ? '' : new TextDecoder().decode(bytes)
}

/**
 * 落进环境走**同一套视图与日志**（架构 § 9.10：`view/write` 事件 + 提交协议，**不新增持久化
 * 模块**）。所以"那句话在环境里"这件事与草案、与别的视图写入是同一条路。
 */
async function writeAt(deps: SayDeps, path: RelPath, text: string): Promise<void> {
  await applyEdit(
    { log: deps.log, truth: deps.truth, view: deps.view, writer: deps.writer },
    { kind: 'add', path, bytes: new TextEncoder().encode(text), mode: 0o100644 },
  )
}
