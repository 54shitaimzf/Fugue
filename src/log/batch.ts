// 只读批次的**代**（上一版拆件，批 2026-10-06）。出处：架构 § 9.11「**服务端可以记住派生物**」
// 那一段——「一次只读批次固定在一个代上（期间有写入就整批作废，**两代不拼接**）」。
//
// 这一份给的是一条**判据**，不是一个缓存：一趟只读批次在开头记下账的「代」（每个 writer 日志
// 文件的那一对读数），末尾再记一次；两次不同就说明**期间有写入**，这一批**整批作废**——
// 调用方拿到的是一个明确的失败，而不是一份把两代拼在一起的读数。
//
// **代是什么**：每个 writer 那一份日志的 `(size, mtimeMs)` 按 writer 排完序拼起来的那一串。
// 它不是账上的内容（不带时间戳 · 不进游标 · 不参与任何排序），只是「这份文件长这样」的一个
// 记号。判据的两条性质：
//
//   · **append-only 的文件只增**：`size` 变了一定是有人写过；同一毫秒里两次写入由 `size` 分开。
//   · **可弃可重算**：它不落盘、不进视图、不进事件、不写账——换一个进程重算，读出来的东西
//     逐字节不变（§ 9.11 派生物那一段的共同性质）。
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logDir } from './log.ts'

/** 一批只读批次的失败：**期间有写入**——整批作废，重开一批。 */
export class BatchStaleError extends Error {
  readonly from: string
  readonly to: string
  constructor(from: string, to: string) {
    super(
      `这一批只读批次期间有写入（代从 ${from === '' ? '（空）' : from} 变成 ${to === '' ? '（空）' : to}）——` +
        '整批作废，不把两代拼在一起。重开一批再读。',
    )
    this.name = 'BatchStaleError'
    this.from = from
    this.to = to
  }
}

/**
 * 此刻的代。
 *
 * 空账（一条日志都没有）给空串——**空串是一个代**，不是「没有代」。
 */
export function generationOf(root: string): string {
  let names: string[]
  try {
    names = readdirSync(logDir(root))
  } catch {
    return ''
  }
  const rows: string[] = []
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    try {
      const st = statSync(join(logDir(root), name))
      rows.push(`${name}:${st.size}:${st.mtimeMs}`)
    } catch {
      // 中途被删（`dispose` 那种）：**这一份的代就算「刚变过」**，整批照旧作废。
      rows.push(`${name}:gone`)
    }
  }
  return rows.join(',')
}

/** 一趟只读批次：开头记一个代，`read()` 交回来的东西必须整批同代。 */
export interface ReadBatch {
  /** 这一批固定住的代。 */
  readonly generation: string
  /**
   * 跑这一批的读法。**返回值与读出来的东西必须同代**：期间有写入就抛 `BatchStaleError`。
   * `fn` 只调一次——重试是调用方的事（重开一批）。
   */
  read<T>(fn: () => Promise<T> | T): Promise<T>
}

export function batchOf(root: string): ReadBatch {
  const generation = generationOf(root)
  return {
    generation,
    async read<T>(fn: () => Promise<T> | T): Promise<T> {
      const value = await fn()
      const after = generationOf(root)
      if (after !== generation) throw new BatchStaleError(generation, after)
      return value
    },
  }
}

/** 只读批次的形状：**它只读**——这一份里没有任何写路径。 */
export const READ_BATCH_IS_READ_ONLY = true
