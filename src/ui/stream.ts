// TUI 的第二格：**哪一族事件配得上一行历史**。出处：PLAN § 5.19 第五段（`UI1` 那一行 ·
// 「永久行那一栏的分法（第一版）」那一段）· 架构 § 9.8（可附着 TUI 那一行与它那几条定死）·
// PLAN § 5.18 的三面表（**事件面是唯一读源**）。
//
// 一帧的两层在这里第一次分开：**永久行**追加进终端历史（翻得回去 · 搜索 · `| tee` 出去就是一份
// 流水），**其余的只进底部那块瞬态区**（擦掉重画）。这一份就是那道分界线，而且它是**一张表**——
// 一族一格；渲染里不许再出现"这一族要不要印"的判断，那样子分法就有两处，也就是两处会漂的。
//
// 进来的是 `probe/watch.ts` 的 `follow()` 吐的那种行（`probe/status.ts` 的 `StatusRow`）：跟随与
// 一次性读**同一个形状**，所以这一份在两条路上是同一段代码（`UI3` 证的就是这条性质）。
//
// 四条不许破的性质：
//
//   · **纯**：同一份行调两次逐字节相同——不读终端、不看时刻、一个字节都不写；
//   · **一条事件 = 一行**：正文里有换行的（`round/intent` 的意图 · `agent/handoff` 的交接信）
//     折成一行再截，绝不吐第二行——历史里多一行就是"这一条事件是两条"，而底部那块 K 行的
//     行数账也跟着错位；
//   · **少印要说出来**：正文过长时截断留 `…`，全文的读法是 `fugue log`（抄本，不渲染不筛选）；
//   · **次序就是拿到的次序**：不排序、不归并——跟随给的是到达序（`watch.ts` 头上那一条）。
//
// **「门的判定」在账上没有单独一族。** `contract/gate.ts` 判完就返回，一个字节都不落：门停住这件
// 事在账上的样子是 `round/state` 停在 `Planning`（默认停），人点头那一下是 `round/approve`。所以
// 那张散文表里并列写着的三样（`round/state` · `round/approve` · 门的判定）在这一份里是**两族**。
// **什么条件下改主意**：门自己落一条事件的那一天（例如 `round/gate`），这张表要加一行——那时
// `unclassified()` 那条读数会当场叫住（联合长了一族而分法没跟上，是红的，不是静默的）。
//
// **"只进瞬态区计数"那一半不在这里。** 那些数各自的取值处一处都没另立：调用次数是
// `probe/status.ts` 的 `usage.calls`，其余各族的条数是 `probe/metrics.ts` 那八元。在这里再数
// 一遍就是第二份真源。
//
// **表是入参，不是模块私有的。** 生产那一侧不传，用的就是 `FAMILY_KIND`；测试要能把一族挪一格，
// 从而证明这一栏真的在读那张表（`stream.test.ts` ②/③ 那两条负对照），所以它是一等入参。
import type { LogEvent } from '../log/events.ts'
import type { StatusRow } from '../probe/status.ts'
import { WORDS, stateFaceOf } from '../words.ts'
import { glyphs } from './glyph.ts'
import type { ConversationRow } from './frame.ts'

/** 联合里那一族（就是事件的 `t`）。**它是这一份的键**：一族一格，一个都不许漏。 */
export type EventFamily = LogEvent['t']

/** 一族分到哪一类：配得上一行历史（`permanent`），还是只进瞬态区（`transient`）。 */
export type FamilyKind = 'permanent' | 'transient'

/**
 * 分法。**键是族名，值是哪一类**——要换一族只看这一张表。
 *
 * 值可以是缺的（`undefined`）：那就是"这一族没被分到一类"。它是**要报出来的状态**，不是不可能
 * 的状态——测试要能把一族从表里拆掉，从而证明 `unclassified()` 真的会叫住（`stream.test.ts` ②）。
 */
export type FamilyTable = Readonly<Record<string, FamilyKind | undefined>>

/**
 * 永久行那一栏的分法（第一版）。**次序不表示优先级**，它是按"这一族在账上长什么样"分组的。
 *
 * 上面那十族进历史：处境的骨架——轮次走到哪儿 · 谁被派了活 · 人批没批 · 每一格干完没有 ·
 * 边界拦下了什么。下面那十八族只进瞬态区：一步一条的那几族（一次调用 · 一次前缀装配）与
 * 路径级的流水（`view/*` · `mat/*` · `ckpt/*` · `run/*` · `holder/*`）。
 *
 * 类型那一侧写成 `Record<EventFamily, …>`：联合长了一族而这里没跟上，`tsc` 会说话。这一版没有
 * 构建步骤（约定 § 六），所以真正的判据在 `stream.test.ts` ①——它拿 `src/log/events.ts` 的源码
 * 当输入，与 `tools/check-events.js` 同一把尺。
 */
export const FAMILY_KIND: Readonly<Record<EventFamily, FamilyKind>> = {
  // 一 · 处境的骨架。
  'round/state': 'permanent',
  'round/intent': 'permanent',
  'contract/issue': 'permanent',
  'round/approve': 'permanent',
  'agent/stop': 'permanent',
  'agent/handoff': 'permanent',
  'merge/attempt': 'permanent',
  'merge/accept': 'permanent',
  'bound/deny': 'permanent',
  signal: 'permanent',
  // 二 · 一步一条：调用与前缀装配。
  'llm/call': 'transient',
  'prefix/assemble': 'transient',
  // 三 · 路径级的流水：视图上每一次改动一条。
  'view/write': 'transient',
  'view/symlink': 'transient',
  'view/remove': 'transient',
  'view/rename': 'transient',
  'view/chmod': 'transient',
  // 四 · 物化与定格。
  'mat/fork': 'transient',
  'mat/sync': 'transient',
  'mat/reclaim': 'transient',
  'ckpt/commit': 'transient',
  // 五 · 起进程那一族（含被内核拒的那一条：它按**格**在瞬态区里数，不按条进历史）。
  'run/start': 'transient',
  'run/end': 'transient',
  'run/confined': 'transient',
  // 六 · 持轮者手上那几件：草案 · 待办 · 预备态宣告 · 问人。
  'holder/distill': 'transient',
  'holder/todos': 'transient',
  'holder/plan': 'transient',
  'holder/ask': 'transient',
  // 七 · 子 agent 的问题与它的判决（U18 甲案）：与"问人"同一档——一行瞬态计数，正文在账上。
  'ask/raised': 'transient',
  'ask/ruling': 'transient',
}

/**
 * 这一批族名里，表上**没有**的那些（次序照传进来的次序）。正常是空的。
 *
 * "联合长了一族而分法没跟上"这件事的可检形式。**生产上今天没有消费者**：消费者是
 * `stream.test.ts` ①（拿 `src/log/events.ts` 的源码当输入）与 ②（拿一张拆掉一族的表当输入）。
 */
export function unclassified(known: readonly string[], table: FamilyTable = FAMILY_KIND): readonly string[] {
  return known.filter((f) => table[f] === undefined)
}

/**
 * 正文截断的**按族表**（U10b）：自由正文的两族放宽到 80——意图与交接信是"这一轮要干什么
 * / 接的人该知道什么"的第一手话，40 个字符常常截在半句上；表上没有的族兜 `BODY_CHARS`（40）
 * ——它们今天没有自由正文栏（坐标 · 散列 · 计数），40 早已够。与 `FAMILY_KIND` 同一条道理：
 * **表是唯一分法**，渲染里不许再出现"这一族给多少"的判断。
 */
export const BODY_LIMIT: Readonly<Record<EventFamily, number | undefined>> = {
  'round/intent': 80,
  'agent/handoff': 80,
}

/** 表上没分到的那一族兜的长度（**字符**，不是列——历史那边折行归终端管）。 */
export const BODY_CHARS = 40

/** 前 `n` 个字符，截了就留一个 `…`（散列那几栏：`base` · `commit` · `fingerprint`）。 */
function head(s: string, n: number): string {
  const chars = [...s]
  return chars.length <= n ? s : `${chars.slice(0, n).join('')}${glyphs().mark}`
}

/**
 * 正文折成一行：空白（含换行）收成一个空格，再按**这一族**的 `BODY_LIMIT` 截。
 *
 * **为什么截**：一份任务的 JSON 与一封交接信都可以很长，而这一栏要的是"这一条事件是什么"，
 * 不是全文——全文的读法是 `fugue log`（抄本）与轮次那几条命令。
 */
function excerpt(body: string, family: EventFamily): string {
  return head(body.replace(/\s+/g, ' ').trim(), BODY_LIMIT[family] ?? BODY_CHARS)
}


/** 生产者 round/start 与 round/plan 将目标序列化为 {goal}；旧的纯文本记录照读。 */
function intentText(body: string): string {
  return body.startsWith('{"goal":') ? (JSON.parse(body) as { goal: string }).goal : body
}

function lineOf(row: StatusRow): ConversationRow {
  const e = row.e
  switch (e.t) {
    case 'round/state':
      return { text: `进展：${stateFaceOf(e.to)}`, role: e.to === 'Aborted' ? 'refuse' : e.to === 'Committed' ? 'ok' : 'body' }
    case 'round/intent':
      return { text: `${WORDS.task}：「${excerpt(intentText(e.body), 'round/intent')}」`, role: 'body' }
    case 'contract/issue':
      return { text: `已安排一项任务${e.paths.length > 0 ? `，涉及 ${e.paths.length} 个文件` : ''}。`, role: 'body' }
    case 'round/approve':
      return { text: `计划已确认，开始执行 ${e.contracts.length} 项任务。`, role: 'body' }
    case 'agent/stop':
      return { text: `一项任务已停止${e.handoffs > 0 ? '，交接说明可在阅读面查看' : ''}。`, role: 'body' }
    case 'agent/handoff':
      return { text: `交接说明：「${excerpt(e.body, 'agent/handoff')}」`, role: 'body' }
    case 'merge/attempt':
      return { text: `正在合并结果${e.conflicts > 0 ? `，有 ${e.conflicts} 处冲突需要处理` : ''}。`, role: e.conflicts > 0 ? 'waiting' : 'body' }
    case 'merge/accept': {
      const pass = e.assertions.filter((a) => a.verdict === 'pass').length
      const fail = e.assertions.filter((a) => a.verdict === 'fail').length
      const broken = e.assertions.length - pass - fail
      const problems = [fail > 0 ? `${fail} 项未通过` : '', broken > 0 ? `${broken} 项无法运行` : ''].filter(Boolean)
      return problems.length > 0
        ? { text: `${WORDS.accepts}：${pass} 项通过，${problems.join('，')}。`, role: 'refuse' }
        : { text: `${WORDS.accepts}通过${pass > 0 ? `：${pass} 项` : ''}。`, role: 'ok' }
    }
    case 'bound/deny':
      return { text: `已拒绝越界写入：${e.path}`, role: 'refuse' }
    case 'signal':
      return { text: '收到通知，详情可在阅读面查看。', role: 'waiting' }
    default:
      throw new Error(`这一族没有分到永久行：${(e as { readonly t: string }).t}`)
  }
}

/**
 * 那一趟历史：这批行里配得上永久行的那些，**按到达序**。
 *
 * `table` 是入参（缺省就是 `FAMILY_KIND`）：测试把一族挪一格，用它证明这一栏真的在读那张表。
 */
export function permanentLinesOf(rows: readonly StatusRow[], table: FamilyTable = FAMILY_KIND): readonly string[] {
  const out: string[] = []
  for (const row of rows) if (table[row.e.t] === 'permanent') out.push(lineOf(row).text)
  return out
}


/** 对话区保留最近汇报；状态转移和任务拆分留在历史与进展视图。 */
export function conversationOf(rows: readonly StatusRow[], table: FamilyTable = FAMILY_KIND): readonly ConversationRow[] {
  return rows.filter((r) => table[r.e.t] === 'permanent' &&
    r.e.t !== 'round/state' && r.e.t !== 'contract/issue' && r.e.t !== 'round/approve' && r.e.t !== 'merge/attempt')
    .map(lineOf)
}
