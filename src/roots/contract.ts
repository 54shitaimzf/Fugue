// M3 的契约。出处：架构 § 8.4——`Roots` 与 `Outside` 逐字照抄；`Result` 与 `Denied` 是那条
// 签名（`Result<RelPath, Denied>`）与那条纪律（"拒绝文案指路，不筑墙"）所要求的形状。
//
// **这一份只有类型。** 路径语法与算术在 `paths.ts`，围栏在 `fence.ts`，落点探测在 `host.ts`
// ——三份实现各自只做一件事，装配在 `roots.ts`。任何一个消费者 import 的是 `Roots`，
// 不是那三份：换实现不动调用点。
//
// **拒绝与落空是两种东西，所以是两个类型。** `Denied` 是"这次访问不允许"（有由头 · 有指路
// 文案）；`Outside` 是"这个物理坐标不在这棵树里"（一个事实，不是一次拒绝）。混成一个类型，
// 调用点就分不出"该报给人"和"该换个坐标再试"。
//
// 符号索引（`SymbolIndex`）不在这一份里：架构 § 8.4 把它与 `Roots` 列在同一个模块下，但
// S2 的范围不含它（架构 § 20 · PLAN § 5.2 的 V0 行）。
import type { AbsPath, AgentId, RelPath } from '../terms.ts'

/** 一个物理坐标落在某个根之外：不是拒绝，是"这儿没有它"。 */
export interface Outside {
  readonly outside: true
  readonly abs: AbsPath
  readonly root: AbsPath
}

/**
 * 拒绝的四种由头。**四种要四句不同的话**：绝对路径与 `..` 越界要分别说清"视图里的路径长
 * 什么样"与"怎么申请出去"，软链要说清视图里不跟着它走，语法错要指出错在哪一段。
 */
export type DenyKind = 'absolute' | 'escape' | 'through-symlink' | 'not-a-path'

export interface Denied {
  readonly denied: true
  readonly kind: DenyKind
  /** 被拒的那一串原文。 */
  readonly raw: string
  /** 挡在哪儿：软链那一条给的是那一段前缀，越界那一条给的是那串原文。 */
  readonly at: string
  /** 机器可读的那半句（给日志与测试）。 */
  readonly detail: string
  /** 给人看的整句，含指路（架构 § 8.4 纪律 2）。 */
  readonly message: string
}

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export interface Roots {
  readonly realRoot: AbsPath
  readonly scratchRoot: (a: AgentId) => AbsPath
  readonly tempRoot: (a: AgentId) => AbsPath
  readonly cacheRoot: (a: AgentId) => AbsPath
  readonly mergedRoot: (a: AgentId) => AbsPath

  toScratch(a: AgentId, rel: RelPath): AbsPath
  toMerged(a: AgentId, rel: RelPath): AbsPath
  fromScratch(a: AgentId, abs: AbsPath): RelPath | Outside
  toReal(rel: RelPath): AbsPath

  resolveVirtual(path: string, cwd: RelPath): Result<RelPath, Denied>
}
