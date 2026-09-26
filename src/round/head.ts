// 提交成链：**这一格的 ref 此刻指在哪个提交上**（PLAN § 5.16）。出处：架构 § 9.6 那句
// "视图铺在哪个提交上，这次提交就推在哪个提交之上"——"哪个提交"这一半以前是调用点写死的 `base`，
// 于是模型一格之内调两次 `checkpoint` 就会第二次撞 CAS；收尾 `commitView` 撞的话直接穿出
// `runRound`，整格作废（§ 5.9.1 闸一那种红法）。
//
// **它不是第二个账本，是一份重放缓存。** 头从 `M0` 重放出来：这一格自己的日志里**最后一条**
// `ckpt/commit` 就是 ref 的当前头（一条都没有就是 `null`——新仓库还没有提交，那是正常状态）。
// 这与 § 5.15 冻结点第 1 句是同一份缓存的两半里"提交那一半"（物化那一半是 `matState`）。
//
// **为什么可以从日志读、而不必去问 ref**：`checkpoint()` 的顺序是"对象 → CAS 推进 → 日志"
// （§ 9.3 那三步之外的那一步），**输掉 CAS 的写者不在日志里留行**。所以日志里最后一条
// `ckpt/commit` 与 ref 的当前值是同一个事实——**日志更权威**（它也是重放的权威来源）。
// 反过来去 `resolve(ref)` 读一次会多一次 IO，而且那个读数与"这份日志到哪一步"之间的窗口
// 本来就是 CAS 要守的东西。
//
// **缓存只是缓存**：`refresh()` 从日志重建一次，重建之后行为必须逐字节相同（PLAN § 5.16 判据 4）。
// 格内之所以能缓存，是因为"这一格是唯一的写者"——每次自己提交成功之后同步它，判据明确。
import type { LogReader } from '../log/events.ts'
import type { CommitId, LogSeq, WriterId } from '../terms.ts'

/** 重放出来的头：哪个提交、以及它落在日志的第几条（第二条给报告与断言用）。 */
export interface RefHeadState {
  /** ref 此刻指着的提交。**新仓库还没提交过就是 `null`**——那时 CAS 的期望是"它必须还不存在"。 */
  readonly value: CommitId | null
  /** 那一条 `ckpt/commit` 的序号；`value === null` 时是 `0`（日志从 1 起，0 表示"没有"）。 */
  readonly seq: LogSeq
}

export const NO_COMMIT: RefHeadState = { value: null, seq: 0 as LogSeq }

/**
 * 重放一个 writer 的 ref 头。**只读**（`LogReader`）：提交头读日志，不写日志——写的那一处
 * 是 `checkpoint()` 自己（对象 → CAS → 日志）。
 *
 * **它从一个已有的头起头**（`from`），不是从「什么都没有」起。这一栏是承重的：这一格的底
 * （`DriverAsk.base` / `View.base`）本来就可能已经在日志之外被定下来了——台子的底由 git 落、
 * `fugue branch <base>` 也能把 ref 挪到别处，那两种情况日志里都没有对应的 `ckpt/commit`。
 * 于是日志重放能回答的只是「**在这个底之上，这一格自己又推了几次**」。
 *
 * 起错头的后果不是报错，是**每一次提交都撞 CAS**（施工当场撞到过：`期望 （不存在），实际 c0abbe…`）
 * ——因为视图铺在 `base` 上、而 CAS 以为那条 ref 还不存在。
 *
 * 与 `matState` 同一个形状：扫一遍这个 writer 的事件，最后一条 `ckpt/commit` 留下。
 */
export async function readRefHead(
  log: LogReader,
  writer: WriterId,
  from: CommitId | null = null,
): Promise<RefHeadState> {
  let out: RefHeadState = from === null ? NO_COMMIT : { value: from, seq: 0 as LogSeq }
  let at = 0
  for await (const e of log.readByWriter(writer)) {
    at += 1
    if (e.t === 'ckpt/commit') out = { value: e.commit, seq: at as LogSeq }
  }
  return out
}

/**
 * 格内那份缓存。**一个格一份**：`driveOnce` 起跑时建一份，工具面的 `checkpoint` 与收尾的
 * `commitView` 读的是同一份——"不与第二个账本并存"这句话在类型上就是这个形状（没有第二处可写）。
 *
 * 三个口恰好是判据 4（缓存只是缓存）要的三样：**读**（`value` · `seq`）· **从日志重建**
 * （`refresh`）· **提交成功后同步**（`commit`）。重建之后行为必须逐字节相同。
 */
export interface RefHead {
  /** 此刻的头（`checkpoint` 拿它当 CAS 期望 · 收尾提交拿它当 parent）。 */
  readonly value: CommitId | null
  /** 它落在日志的第几条（一条 `ckpt/commit` 都没有时是 0）。 */
  readonly seq: LogSeq
  /** **作废缓存、从日志重建一次。** 重放是权威，缓存只是它的影子。 */
  refresh(): Promise<RefHeadState>
  /** 提交成功之后同步一次（**只有 `checkpoint()` 成功返回之后才调**）。 */
  commit(next: CommitId, at: LogSeq): void
}

/**
 * 建一份格内缓存（起跑那一下重放一次）。
 *
 * `from` 是这一格的底（`ask.base` / `View.base`）——**不许省**：省掉就是上面那段说的「起错头」。
 * 传 `null` 只在「新仓库、一个提交都还没有」那一档成立。
 */
export async function refHeadOf(
  log: LogReader,
  writer: WriterId,
  from: CommitId | null = null,
): Promise<RefHead> {
  let out = await readRefHead(log, writer, from)
  return {
    get value() {
      return out.value
    },
    get seq() {
      return out.seq
    },
    async refresh() {
      // **重建用同一个底**（缓存三样里最容易写错的一处）：拿 `null` 重建会把这一格的底丢掉。
      out = await readRefHead(log, writer, from)
      return out
    },
    commit(next, at) {
      out = { value: next, seq: at }
    },
  }
}
