// 身份模型：一个 writer 落在两侧的名字。出处：架构 § 4。
//
// ```
// refs/heads/main
// refs/heads/agent/<round>/<n>
// refs/agents/<round>/<n>/ckpt/<seq>     分支内提交点，不移动分支头
// refs/tags/round/<round>/merged
// ```
//
// **它单独在这里，因为它不属于任何一个模块。** M0 只认 writer，M1 只认 ref；把 writer
// 翻译成这两者之一，是身份模型的事，两边都不该认识对方那半。而它又不能住在面里：
// `fugue commit` 与模型侧的 `checkpoint` 是同一个操作（§ 9.6），两个面都要这一处翻译。
//
// **两处翻译，两种用途，各有各的归一。** `refFor` 给 git 侧——一次提交推到哪条分支；
// `agentFor` 给日志侧——这一行是谁写的。二者都从同一个 `WriterId` 出发，所以"谁是主线"
// 这个问题只有 § 4 一处答案，没有第二份。
//
// **身份名同时是一条路径**（§ 4 的 `agent/<round>/<n>` 就是三层目录）：这条规矩与上面两处
// 翻译同住一份，因为它同样"不属于任何一个模块"——`M0` 与 `M3` 都要它，而两边都不该认识
// 对方那半。
//
// 只有行为是纯函数、没有任何 import 之外的副作用——所以谁都可以 import 它。
import type { AgentId, BranchId, RefName, RoundId, WriterId } from './terms.ts'

/** writer → 它推进的 ref。round 级的写者走主线。 */
export function refFor(writer: WriterId): RefName {
  return writer === 'round' ? 'refs/heads/main' : `refs/heads/${writer}`
}

/**
 * 身份分配器：第 `n` 个 agent 的那一份身份（**从 1 起** · 构造次序）。出处：架构 § 4 那张 ref 表
 * （`refs/heads/agent/<round>/<n>`）· 架构 § 14.1 第 1 步（身份分配器）。
 *
 * **一处给两样，因为它们是同一个名字的两种用法。** 契约里的 `agent`（名字）与 `branch`（它推进
 * 的那一条 ref）都由构造器问它要；而分支 · 物化根 `mat/<agent>/` · 日志 `log/<writer>.jsonl` 都
 * 从同一个名字出发（§ 9.2 那张布局表）。分开各拼一遍的症状是"两份次序不是同一个序"——先派
 * 调查型契约的时候错开一格，而那种错在日志里看不出来（两份身份都合法，只是换了个位置）。
 *
 * 序号按**构造次序**（调查型在最前）：`agent/<round>/1` 是这一轮第一个拿到契约的那一格，不是
 * "第一个实现型"。
 */
export function identFor(round: RoundId, n: number): { readonly agent: AgentId; readonly branch: BranchId } {
  const agent = `agent/${round}/${n + 1}` as AgentId
  return { agent, branch: refFor(agent) as unknown as BranchId }
}

/**
 * writer → 它落日志、落视图时用的 agent 署名。
 *
 * **`round` 是一个 agent 的名字，不是无名占位**：它标的是持轮者这个位置，而持轮者就是主
 * agent（§ 4）——第 3 轮与第 7 轮的持轮者可以是两个不同的 agent，位置上写的一直是这个名字。
 * 人敲 `fugue write` 写的也是它，人与持轮者因此落在同一条主干上。
 *
 * 之所以需要这一处：`WriterId` 比 `AgentId` 宽（`AgentId | 'round'`）。日志的 `append` 与
 * `readByWriter` 收的是位置——那里要的是"哪一份日志"；而事件的 `agent` 字段与 `View.id`
 * 要的是"哪个 agent"（§ 8.1 · § 8.3）。**这个转换只此一处**，面 · 视图 · 日志三处都不
 * 各自转一次。
 */
export function agentFor(writer: WriterId): AgentId {
  return writer as AgentId
}

/**
 * 身份名（agent · writer）的形状：**同一个名字落在两侧，所以这条规矩只有一处答案。**
 *
 * 它同时是一条路径——`mat/<agent>/`（§ 8.4）· `log/<writer>.jsonl` · `snap/<writer>/`
 * （§ 9.2）都拿它当名字用，而且**按段展开**：`agent/r1/1` 是三层目录，不是一个"名字里带斜杠"
 * 的文件。于是每一段都得是一个能当目录名的段——空 · `.` · `..` · 以点开头 · 反斜杠 · 空字节
 * 一律拒。
 *
 * **拒绝就是抛，不是返回一个 Denied。** 这不是用户输入：围栏（`M4`）收的是没解析过的字符串，
 * 它返回带指路文案的 `Denied`；而到了这里，那个字符串已经是一条身份——里面出现非法段，说明
 * 调用点把一个没检查过的名字当成了身份，那是程序错误，不是一次可以指路的拒绝。
 *
 * **一处实现，两处调用**：`M0` 的 `assertWriterId`（日志那一侧）与 `M3` 的 `matRoot`（物化那一侧）
 * 各调它一次。这条规矩原先在两边各写了一遍——而它已经漂移过一次：日志那一侧收 `agent/r1/1`，
 * 物化那一侧拒它，同一个名字在两处得到两个答案（PLAN § 5.3 站前那次检查的第三条读数）。
 */
export function assertIdent(raw: string, who: string): string {
  const bad = (why: string): never => {
    throw new Error(`${who}非法（${why}）：${JSON.stringify(raw)}`)
  }
  if (typeof raw !== 'string' || raw.length === 0) bad('是空的')
  if (raw.startsWith('/')) bad('以 / 开头')
  if (raw.includes('\\')) bad('含反斜杠')
  if (raw.includes('\0')) bad('含空字节')
  for (const seg of raw.split('/')) {
    if (seg === '') bad('含空段')
    if (seg === '.' || seg === '..') bad('含相对段')
    if (seg.startsWith('.')) bad('含以点开头的段')
  }
  return raw
}

/**
 * 身份名的各段。**`M3` 按段拼**（`mat/` 底下是目录），`M0` 那一侧由 `join` 展开
 * （`log/agent/r1/1.jsonl` 与 `snap/agent/r1/1/`）——两处都从这一处拿答案。
 */
export function identSegments(raw: string, who: string): string[] {
  return assertIdent(raw, who).split('/')
}
