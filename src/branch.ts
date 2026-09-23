// `branch`：分出去——把本 agent 的分支头定格在一个提交上（架构 § 4 的那个动作）。
//
// **它只做一件事：把 `refs/heads/<writer>` 从"不存在"变成 <base>。** 已经指着 <base> 就什么都
// 不做（幂等）；指着别处就拒绝，并给出两条路。**它不搬已有的分支头**：§ 9.6 那张命令表里没有
// 回退，而"把一条线挪到另一个提交上"是另一件事——S7 起 N 个分支走的是 `M12` 的转移，那一条用
// git 直接指（§ 4：`fugue branch` 是一条方便的路，不是一个前提）。
//
// **它不落日志。** § 8.1 那张事件表里没有一个分支事件，而分支头是真源这一侧的东西：视图的底
// 每次加载现读它（`view/lower.ts` 的 `baseFor`），重放不需要知道它是什么时候定的。往日志里加
// 一种事件是一次改规格，不是这里该做的事。
//
// **它不取栅栏。** 栅栏（§ 9.2 的 `log/<writer>.lock`）挡的是日志那条没有 CAS 的路：序号从
// 文件尾读一次，串行化只在进程内。而 ref 的每一次改都是 CAS（`Truth.advance` 的 `expectedOld`），
// 两个进程同时分出去恰一个成功——输掉的那个再看一眼 ref，看到的就是"已经指着它"。所以这条命令
// 不进那八条写命令的名单（PLAN § 5.3 的口径）：栅栏要挡的那件事，在这里本来就不存在。
//
// **第三样东西也在这里：`fork` 落地之前那处检查的文案。** § 4 说视图的底与物化的底必须是同一个
// 提交，不一致的症状是静默的；而 `M4` 不 import `M1`（它的入参里连 `Truth` 都没有），所以这一步
// 只能在面这一层查。检查与动作住在同一个文件里，因为它们是同一条不变式的两半。
import { agentFor, refFor } from './identity.ts'
import type { CommitId, RefName, WriterId } from './terms.ts'
import type { Truth } from './truth/contract.ts'
import { RefConflictError } from './truth/truth.ts'
import { baseFor } from './view/lower.ts'

/** 指着别处。**不是异常，是一次有由头的拒绝**——由头（含两条路）原样带给调用点。 */
export class BranchRefused extends Error {
  readonly why: string

  constructor(why: string) {
    super(why)
    this.name = 'BranchRefused'
    this.why = why
  }
}

export interface BranchResult {
  readonly ref: RefName
  readonly base: CommitId
  /** false = 本来就指着它：一个字节都没动（幂等的那一半）。 */
  readonly moved: boolean
}

/**
 * 把 `writer` 的分支头定在 `base` 上。
 *
 * **幂等有两种来路，都要算成功**：一种是敲之前它就指着 <base>（读一眼就知道）；另一种是两个
 * 进程同时分出去、自己输掉了那次 CAS，而赢家定的正是同一个提交。判据因此不是"没人同时敲"，
 * 是"不管谁先到，结果都是它指着 <base>"。
 */
export async function branchAt(truth: Truth, writer: WriterId, base: CommitId): Promise<BranchResult> {
  const ref = refFor(writer)
  const now = await baseFor(truth, writer)
  if (now === base) return { ref, base, moved: false }
  if (now !== null) throw new BranchRefused(refuse(writer, ref, now, base))
  try {
    // 这一句 CAS 说的是"它必须还不存在"（`expectedOld === null`）。**并发下的恰一个成功由它
    // 保证**，不是由上面那次读保证——读一次再写一次中间那段窗口，正是 CAS 要守的东西。
    await truth.advance(ref, base, null)
  } catch (err) {
    if (!(err instanceof RefConflictError)) throw err
    const after = await baseFor(truth, writer)
    if (after === base) return { ref, base, moved: false }
    throw new BranchRefused(refuse(writer, ref, after, base))
  }
  return { ref, base, moved: true }
}

/** 指着别处时的那段话。**两条路都要给全**（§ 4），不然人就只剩"猜"这一条路。 */
function refuse(writer: WriterId, ref: RefName, head: CommitId | null, base: CommitId): string {
  if (head === null) {
    // 只有一处到得了这里：上面那次读说它不存在、CAS 却输了，而输完再看它又不见了。留一句
    // 能照做的话，不替这个现场编解释。
    return (
      `branch：${ref} 在这一次的两读之间被改过，而它现在不存在\n` +
      `再敲一次：fugue --agent ${writer} branch ${base}`
    )
  }
  return (
    `branch：${ref} 不是空的——这个动作只把还没分出去的那条线定在 ${base} 上，不搬已有的分支头\n` +
    `  它现在指着 ${head}\n` +
    `两条路：\n` +
    `  一 · 先把它定过来：git update-ref ${ref} ${base}\n` +
    `      （§ 4：fugue branch 是一条方便的路，不是一个前提——用 git 直接指过去同样成立）\n` +
    `  二 · 拿它现在指着的那个提交当 base：fugue --agent ${writer} fork ${head}`
  )
}

/**
 * `fork` 落地之前的那一处检查（§ 4 末段 · § 8.5）。**一致返回 `null`**，否则是拒绝的全文。
 *
 * 物化的底是**真实工作树**，视图的底是**本 agent 的分支头**，两者必须是同一个提交。不一致时
 * 症状是静默的：物化树里本 agent 没碰过的那些路径给的是工作树的内容，而视图给的是另一个提交
 * 的，构建跑的是另一份代码而不报错。**分支头还没定也算不一致**（`head === null`）——那时视图
 * 的底是空的，而物化树里躺着整棵工作树。
 *
 * 它拦得住的和拦不住的要分开说：**它查的是 ref 那一半**（视图的底是哪个提交）；**真实工作树
 * 是不是那个提交的树，这一层不查**（§ 8.4 把话写死："那一步不做检测，检测在合并之前"）。
 */
export function forkBaseRefusal(writer: WriterId, base: CommitId, head: CommitId | null): string | null {
  if (head === base) return null
  const agent = agentFor(writer)
  const now = head === null ? '还没有定（视图的底因此是空的）' : head
  // 两条路都留着：一条是把这个 agent 分出去，一条是承认它现在那条线、改用它指着的提交。
  const second =
    head === null
      ? `git update-ref ${refFor(writer)} ${base}\n      （§ 4：fugue branch 是一条方便的路，不是一个前提）`
      : `拿它现在指着的那个提交当 base：fugue --agent ${agent} fork ${head}`
  return (
    `fork：${base} 不是这个 agent 的分支头\n` +
    `  ${agent} 的分支头：${now}\n` +
    `  物化的底是真实工作树，视图的底是分支头——两者必须是同一个提交（§ 4）。不一致时物化树里\n` +
    `  本 agent 没碰过的路径给的是工作树的内容，而视图给的是另一个提交的，这一层不检测那件事。\n` +
    `两条路：\n` +
    `  一 · 先把这条线分出去：fugue --agent ${agent} branch ${base}\n` +
    `  二 · ${second}`
  )
}
