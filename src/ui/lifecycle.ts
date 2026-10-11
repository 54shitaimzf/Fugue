// 只解释已记录的状态边，不用“尚未停止”推断进程存活，也不采集盘上状态。
// executeRound 在 advance 完成后才落 Rebuilding；Verifying→Working/Aborted
// 来自失败验收，commitThenAdvance 在这条路上提前返回、不推进工作区。
// 条件改变：状态生产者合并了下一轮的启动，或改变了写回与事件的先后，就重核这张解释。
import { WORDS, stateFaceOf } from '../words.ts'
import type { LineRole } from './theme.ts'

export interface RoundTransition {
  readonly round: string
  readonly from: string
  readonly to: string
}

export interface RoundNotice {
  readonly label: string
  readonly text: string
  readonly role: LineRole
}

/** CLI 的旧状态词仍守原字节合同；TUI 在状态旁解释验收与写回事实。 */
export function roundNoticeOf(from: string | undefined, to: string): RoundNotice | null {
  if (to === 'Rebuilding') return { label: WORDS.writebackDone, text: WORDS.resultWritten, role: 'ok' }
  if (to === 'Committed') return { label: WORDS.writebackPendingLabel, text: WORDS.writebackPending, role: 'waiting' }
  if (from === 'Verifying' && (to === 'Working' || to === 'Aborted')) {
    return { label: WORDS.verifyFailedLabel, text: WORDS.verifyNotWritten, role: to === 'Aborted' ? 'refuse' : 'waiting' }
  }
  return null
}

/** 没有写回判据的状态照旧说阶段，不替它补文件事实。 */
export function roundLabelOf(state: string, from?: string): string {
  return roundNoticeOf(from, state)?.label ?? stateFaceOf(state)
}
