// 提交：把一批条目发布成一个提交点。
//
// **它是 M0 与 M1 的接线，不是第三个模块。** 放在这里而不是放在命令行里，有一条架构上
// 的原话：§ 9.6 说 `checkpoint`（模型侧）与 `fugue commit`（人侧）是**同一个操作的两个
// 名字**。同一个操作只能有一份实现，否则两个面迟早漂移；而它又不能住在任一面里——另一个
// 面就只能复制一份，或者反向 import 一个会跑起来的 CLI。住进 M1 也不行：M1 是内核、演进
// 目标是 Rust、接口由 § 8.2 冻结，而且它不写日志。装配体跨层接线、不占独立分层（§ 7），
// 这里就是那个位置。
//
// **它不认识视图语义。** 条目与 rev 从外面给（U3 之后是 `M2` 的全量读出与 `View.rev`），
// 所以 M2 落地时这个文件一行都不用改——换掉的是调用者那一段折叠。
import { refFor } from './refs.ts'
import type { Log } from './log/events.ts'
import type { TreeEntry, Truth } from './truth/contract.ts'
import { RefNotFoundError } from './truth/truth.ts'
import type { AgentId, CommitId, RefName, TreeId, ViewRev, WriterId } from './terms.ts'

export interface CheckpointRequest {
  log: Log
  truth: Truth
  writer: WriterId
  entries: TreeEntry[]
  rev: ViewRev
  msg: string
}

export interface CheckpointResult {
  commit: CommitId
  ref: RefName
  tree: TreeId
  parents: CommitId[]
  entries: number
}

/** 该 ref 现在的头。**只把"不存在"当没有 parent**——存在但不是提交是另一回事，要报出来。 */
async function currentHead(truth: Truth, ref: RefName): Promise<CommitId | null> {
  try {
    return await truth.resolve(ref)
  } catch (err) {
    if (err instanceof RefNotFoundError) return null
    throw err
  }
}

export async function checkpoint(req: CheckpointRequest): Promise<CheckpointResult> {
  const ref = refFor(req.writer)
  const tree = await req.truth.putTree(req.entries)
  const parent = await currentHead(req.truth, ref)
  const parents = parent === null ? [] : [parent]
  const commit = await req.truth.commit(tree, parents, req.msg)

  // **顺序：对象 → CAS 推进 → 日志。** § 9.3 的三步（blob · 日志 · 视图）里没有 ref 这
  // 一步；把它放在日志之前，是因为输掉 CAS 的写者**不该在重放的权威来源里留下一行**——
  // 先写日志的话，一次没赢的推进会变成一个从未成为分支头的提交点，而重放信的是日志。
  await req.truth.advance(ref, commit, parent)
  await req.log.append(req.writer, {
    t: 'ckpt/commit',
    // `WriterId = AgentId | 'round'`，而 `ckpt/commit` 的 agent 字段收 AgentId：
    // 主线那个写者（round）同时是它事件的 agent，U1 的信封测试已经这么用。
    agent: req.writer as AgentId,
    commit,
    rev: req.rev,
    msg: req.msg,
  })

  return { commit, ref, tree, parents, entries: req.entries.length }
}
