// ROADMAP § 3 / 0.3.0 · 从既有 llm/call 派生逐调用账，不扩展冻结事件面。
import type { LogEvent } from '../log/events.ts'
import type { MergedRow } from './metrics.ts'

type ModelCall = Extract<LogEvent, { t: 'llm/call' }>

export interface CallLedgerEntry {
  readonly source: { readonly writer: string; readonly seq: number }
  readonly agent: ModelCall['agent']
  readonly step: ModelCall['step']
  readonly model: ModelCall['model']
  readonly wire: string
  readonly publishedTools: number | null
  readonly requestedTools: number | null
  readonly usage: ModelCall['usage']
  readonly stop: ModelCall['stop']
  /** 缺省单次尝试没有状态码明细，不能凭成功的 stop 猜成 [200]。 */
  readonly attempts: readonly number[] | null
  /** 既有日志没有这些逐工具事实；未知不能拿 0 或 run/end.ms 顶。 */
  readonly toolMs: null
  readonly toolArgumentBytes: null
  readonly toolReceiptBytes: null
}

export interface CallLedger {
  readonly schema: 1
  readonly tokenScope: 'model-call'
  readonly calls: readonly CallLedgerEntry[]
  readonly totalCalls: number
  readonly truncated: boolean
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function entryOf(row: MergedRow, event: ModelCall): CallLedgerEntry {
  return {
    source: { writer: row.pos.writer, seq: row.pos.seq },
    agent: event.agent,
    step: event.step,
    model: event.model,
    wire: event.wire,
    publishedTools: count(event.toolCount),
    requestedTools: count(event.invocations),
    usage: {
      inputTokens: count(event.usage?.inputTokens),
      cacheReadTokens: count(event.usage?.cacheReadTokens),
      cacheWriteTokens: count(event.usage?.cacheWriteTokens),
      outputTokens: count(event.usage?.outputTokens),
      reasoningTokens: count(event.usage?.reasoningTokens),
    },
    stop: event.stop ?? null,
    attempts: event.attempts === undefined ? null : [...event.attempts],
    toolMs: null,
    toolArgumentBytes: null,
    toolReceiptBytes: null,
  }
}

function accumulator(maxRows: number) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 0 || maxRows > 1_000_000) {
    throw new Error('call ledger maxRows must be an integer from 0 to 1000000')
  }
  const calls: CallLedgerEntry[] = []
  let totalCalls = 0
  return {
    add(row: MergedRow) {
      if (row.e.t !== 'llm/call') return
      totalCalls++
      if (calls.length < maxRows) calls.push(entryOf(row, row.e))
    },
    result(): CallLedger {
      return { schema: 1, tokenScope: 'model-call', calls, totalCalls, truncated: totalCalls > calls.length }
    },
  }
}

/** 只保留有界的模型调用行；同一个 step 的重试/重放按日志位置各留一条。 */
export function callLedgerOf(rows: readonly MergedRow[], maxRows = 5000): CallLedger {
  const ledger = accumulator(maxRows)
  for (const row of rows) ledger.add(row)
  return ledger.result()
}

/** 流读口与纯函数共用同一折法；不会为大日志另攒一份全部事件数组。 */
export async function readCallLedger(rows: AsyncIterable<MergedRow>, maxRows = 5000): Promise<CallLedger> {
  const ledger = accumulator(maxRows)
  for await (const row of rows) ledger.add(row)
  return ledger.result()
}
