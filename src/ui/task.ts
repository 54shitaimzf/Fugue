// 当前任务的人读投影。只读事件，不改机器快照、不写账，不拿调用次数猜进度。
// round 持轮者由同一 writer 的轮次事件定位；子任务由契约与身份中的轮次定位。
import type { StatusRow } from '../probe/status.ts'
import type { ConversationRow } from './frame.ts'
import { roundLabelOf, roundNoticeOf } from './lifecycle.ts'
import { WORDS } from '../words.ts'

export interface PlanItem {
  readonly text: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}
export interface TaskFace {
  readonly round: string | null
  readonly state: string | null
  readonly rows: readonly ConversationRow[]
  readonly plan: readonly PlanItem[]
}
const clean = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).replace(/\t/g, '  ').trim()
function objectOf(body: string): Record<string, unknown> | null {
  try { const value = JSON.parse(body); return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null }
  catch { return null }
}
function goalOf(body: string): string {
  const value = objectOf(body)?.goal
  return clean(typeof value === 'string' ? value : body)
}
export function taskOf(rows: readonly StatusRow[], focus: string | null = null, full = false): TaskFace {
  let round: string | null = null
  const owners = new Map<string, string>()
  for (const { e } of rows) {
    if (e.t === 'round/state' || e.t === 'round/intent') round = e.round
    if (e.t === 'contract/issue') owners.set(e.owner, e.round)
  }
  if (round === null) return { round, state: null, rows: [], plan: [] }
  let at: string | null = null
  const current = rows.filter(({ e }) => {
    if ('round' in e) { at = e.round; return e.round === round }
    if (!('agent' in e)) return false
    const belongs = owners.get(e.agent) ?? (/^(?:agent|holder)\/([^/]+)(?:\/|$)/.exec(e.agent)?.[1]) ?? (e.agent === 'round' ? at : null)
    return belongs === round && (focus === null || e.agent === focus || e.agent === 'round')
  })
  let state: string | null = null, from: string | undefined
  let plan: PlanItem[] = [], planInvalid = false
  const messages: ConversationRow[] = [], changed = new Set<string>()
  let action = '', problem = '', verification = '', commit = ''
  for (const { e } of current) {
    switch (e.t) {
      case 'round/state': state = e.to; from = e.from; break
      case 'round/intent': messages.push({ text: `你\n${goalOf(e.body)}`, role: 'user' }); break
      case 'holder/distill': messages.push({ text: `模型 · 当前理解\n${clean(e.body)}`, role: 'model' }); break
      case 'agent/handoff': messages.push({ text: `模型 · 交接说明\n${clean(e.body)}`, role: 'model' }); break
      case 'holder/ask': {
        const questions = objectOf(e.body)?.questions
        const texts = Array.isArray(questions) ? questions.flatMap(q => q !== null && typeof q === 'object' && typeof q.question === 'string' ? [q.question, ...(Array.isArray(q.options) ? q.options.flatMap(o => o !== null && typeof o === 'object' && typeof o.label === 'string' ? [`${o.label}${typeof o.description === 'string' ? `：${o.description}` : ''}`] : []) : [])] : []) : [e.body]
        messages.push({ text: `模型 · 需要你决定\n${clean(texts.join('\n'))}`, role: 'model' }); break
      }
      case 'holder/todos': {
        const todos = objectOf(e.body)?.todos
        planInvalid = !Array.isArray(todos) || !todos.every(t => t !== null && typeof t === 'object' && typeof t.content === 'string' && ['pending', 'in_progress', 'completed'].includes(t.status))
        plan = !planInvalid && Array.isArray(todos) ? todos.flatMap(t => t !== null && typeof t === 'object' && typeof t.content === 'string' && ['pending', 'in_progress', 'completed'].includes(t.status) ? [{ text: clean(t.status === 'in_progress' && typeof t.activeForm === 'string' ? t.activeForm : t.content), status: t.status }] : []) : []
        break
      }
      case 'agent/stop': messages.push({ text: `执行记录：${clean(e.stopped)}。`, role: 'system' }); break
      case 'run/start': action = `正在执行：${clean((e.argv ?? [e.argv0]).join(' '))}`; break
      case 'run/end': action = e.exit === 0 ? '当前命令已结束。' : `命令失败（退出码 ${e.exit}）。`; if (e.exit !== 0) problem = action; break
      case 'bound/deny': problem = `已拒绝越界写入：${clean(e.path)}`; break
      case 'merge/attempt': action = e.conflicts > 0 ? `合并遇到 ${e.conflicts} 处冲突。` : '正在合并结果，尚待验收与写回。'; problem = e.conflicts > 0 ? action : ''; break
      case 'merge/accept': {
        const passed = e.assertions.filter(a => a.verdict === 'pass').length
        const failed = e.assertions.length - passed
        verification = `验收：${passed} 项通过${failed > 0 ? `，${failed} 项未通过或无法运行` : ''}。`
        if (failed > 0) problem = verification
        commit = e.commit; break
      }
      case 'view/write': case 'view/remove': case 'view/symlink': case 'view/chmod': changed.add(clean(e.path)); break
      case 'view/rename': changed.add(clean(e.from)); changed.add(clean(e.to)); break
      case 'contract/issue': if (changed.size === 0) action = '正在处理已确认的任务。'; break
    }
  }
  const notice = state === null ? null : roundNoticeOf(from, state)
  const result: ConversationRow[] = []
  if (state === 'Rebuilding' && !full) {
    result.push({ text: notice!.text, role: 'ok' })
    if (changed.size > 0) result.push({ text: `改动：${[...changed].join(' · ')}`, role: 'system' })
    if (verification !== '') result.push({ text: verification, role: 'system' })
    else result.push({ text: '验收结果详见记录。', role: 'system' })
    result.push({ text: WORDS.nextTaskGuide, role: 'system' })
    return { round, state, rows: result, plan: [] }
  }
  const status = notice?.text ?? (state === null ? '当前任务记录' : state === 'Planning' ? WORDS.planPreparing : roundLabelOf(state, from))
  result.push({ text: status, role: notice?.role ?? (state === 'Aborted' ? 'refuse' : 'system') })
  if (notice?.text === WORDS.verifyNotWritten) result.push({ text: WORDS.verifyFailedGuide, role: 'instruction' })
  if (state === 'Committed') result.push({ text: '验收已通过 · 待写回', role: 'instruction' })
  else if (state === 'Working' && action !== '' && action !== problem) result.push({ text: action, role: 'instruction' })
  if (problem !== '') result.push({ text: problem, role: 'refuse' })
  for (const message of messages) result.push({ text: '', role: 'body' }, message)
  if (verification !== '' && state !== 'Committed') result.push({ text: verification, role: 'system' })
  if (commit !== '') result.push({ text: '已合并结果；文件与验收记录可在阅读面查看。', role: 'system' })
  if (planInvalid) result.push({ text: '计划记录无法展开；原文可用 /log 查看。', role: 'system' })
  return { round, state, rows: result, plan: full || (plan.some(p => p.status !== 'completed') && state !== 'Aborted') ? plan : [] }
}
