// TUI 的第二版第七格：**排队**——忙的时候打的那几条先入队，看得见 · 撤得掉 · 一趟跑一条。
//
// 出处：PLAN § 5.19 第二版「六 · 提交的四种去向，第二版只做两种」（"空闲 → 直接跑；忙 → 入队
// （可见 · 可撤）"）·「四 · 取消链」第三级（"丢弃排队的草稿"）· 第九节 `T7` 那一行 · 架构 § 9.8。
//
// **排队是界面自己的草稿队列，不是账。** 账上只有"这一趟起过什么"，没有"还等着跑什么"——所以这一份
// 进程一退就没了，也不该有第二个读者（§ 5.19 一 · 3"界面不留第二份真相"）。**它也不是一个队列化的
// 执行器**：`ui/run.ts` 那一档一次只起一个进程，跑完才轮到下一条——"一次只起一个"这条不变量在这一
// 格里没被动过，动的是"人打的第二条去哪儿"。
//
// 为什么不做"改当前那一趟"（steer）：那要子进程收得下 stdin，而今天 `spawn` 的 stdin 是 `/dev/null`
// （§ 5.19 六，人拍的）。**改主意的条件**：`round run` 收得下"中途插一句"的那一天。
import type { LineMode } from './run.ts'
import { clip } from './frame.ts'

/** 排队的一条：**那一行原文**与它交出去时的模式（`Command` / `Say`）。 */
export interface Queued {
  readonly line: string
  readonly mode: LineMode
}

/** 排队那一串。**空的与不空的分得开**（`EMPTY_QUEUE` 就是空的，不与"有一条空行"混起来）。 */
export interface QueueState {
  readonly items: readonly Queued[]
}

export const EMPTY_QUEUE: QueueState = { items: [] }

/**
 * 入队。**同一条打两遍就是两条**：人打两遍就是要跑两遍——去掉重复等于替他改主意（历史那一栏不存
 * 跟上一条相同的，那是另一个意思：那里是"翻上来"的候选，不是待跑的单子）。
 */
export function enqueueOf(q: QueueState, item: Queued): QueueState {
  return { items: [...q.items, item] }
}

/** 取走最前那一条（跑完一趟就来取一条）。空的就是 `{ q, next: null }`（原样还回去）。 */
export function shiftOf(q: QueueState): { readonly q: QueueState; readonly next: Queued | null } {
  const head = q.items[0]
  if (head === undefined) return { q, next: null }
  return { q: { items: q.items.slice(1) }, next: head }
}

/**
 * 丢掉**最后**一条（`Esc` 第三级：一路上按就一条一条地撤）。空的就原样还回去。
 *
 * 为什么是最后一条而不是一把清空：人按 `Esc` 的时候多半是"刚打的那一条不算"——而"一把清空"把前面
 * 几条也带走了，那几条人可能真想跑。要全丢就是多按几下，没有第二种键。
 */
export function dropLastOf(q: QueueState): QueueState {
  if (q.items.length === 0) return q
  return { items: q.items.slice(0, q.items.length - 1) }
}

/**
 * 排队那一行（`T7` 的"可见"）：**条数 · 下一条是谁 · 两条路**（`Enter` 起下一条 · `Esc` 丢掉
 * 最后一条）。**空的时候是空串**：一个字节都不占（面板那一栏留给别人）。
 */
export function queueRowOf(q: QueueState, columns = 0): string {
  if (q.items.length === 0) return ''
  const next = q.items[0] as Queued
  const more = q.items.length > 1 ? `（还有 ${q.items.length - 1} 条在后头）` : ''
  const text = `排队 ${q.items.length} 条 · 下一条：${next.line}${more} · Enter 起下一条 · Esc 丢掉最后一条`
  return columns > 0 ? clip(text, columns) : text
}
