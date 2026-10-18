// 当前任务的人读投影。只读事件，不改机器快照、不写账，不拿调用次数猜进度。
// round 持轮者由同一 writer 的轮次事件定位；子任务由契约与身份中的轮次定位。
import type { StatusRow } from '../probe/status.ts'
import type { ConversationRow } from './frame.ts'
import { roundLabelOf, roundNoticeOf } from './lifecycle.ts'
import { WORDS } from '../words.ts'
import { draftOf } from '../contract/draft.ts'
import { hasControl } from './glyph.ts'
import type { CommitRequest, CommitChanges } from '../serve/commit-source.ts'

export interface PlanItem {
  readonly text: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}
export interface TaskFace {
  readonly round: string | null
  readonly state: string | null
  readonly rows: readonly ConversationRow[]
  readonly plan: readonly PlanItem[]
  readonly completion?: CommitRequest | undefined
}
export interface RunIssue {
  /** True only for the feedback produced by this same observed command. */
  readonly feedback?: boolean | undefined
  readonly round: string
  readonly state: string
  readonly text: string
}
const MERGING = '正在合并结果，尚待验收与写回。'

// The observed process outcome changes the view, not the recorded phase or writeback facts.
export function issueRowsOf(task: TaskFace, issue: RunIssue | undefined): readonly ConversationRow[] {
  const first = task.rows[0]
  if (issue == null || typeof issue.round !== 'string' || issue.round.trim() === ''
    || typeof issue.state !== 'string' || typeof issue.text !== 'string' || issue.text.trim() === ''
    || hasControl(issue.round + issue.state + issue.text)
    || issue.round !== task.round || issue.state !== task.state
    || !['Planning', 'Working', 'Collecting', 'Merging', 'Verifying'].includes(issue.state)
    || first === undefined || !['system', 'instruction'].includes(first.role ?? '')
    || (first.text !== WORDS.planPreparing && first.text !== MERGING && first.text !== roundLabelOf(issue.state)
      && !(first.role === 'instruction' && first.text.startsWith('正在执行：')))) return task.rows
  return [{ text: issue.text, role: 'refuse' }, { text: WORDS.runWritebackGuide, role: 'system' }, ...task.rows.slice(1)]
}
// 这一支**故意**少躲 `\t`（`\x09`）与 `\n`（`\x0a`）两个：下面那一句把它们各自换成能用字符，
// 所以它与 `hasControl` **不是同一批**，别拿那一句顶替它。
const clean = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).replace(/\t/g, '  ').trim()
const pathText = (path: string): string => /\s/.test(path) || hasControl(path) ? clean(JSON.stringify(path)) : path
function objectOf(body: string): Record<string, unknown> | null {
  try { const value = JSON.parse(body); return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null }
  catch { return null }
}
function goalOf(body: string): string {
  const value = objectOf(body)?.goal
  return clean(typeof value === 'string' ? value : body)
}
// JSON tasks use the canonical draft validator; prose and non-JSON fences stay intact.
// The section scaffolding (`## 第 N 项`) is a machine skeleton: on the human face it becomes a
// numbered purpose line, so a first-time reader sees what the batch will do instead of raw markdown.
function draftPreview(body: string): string | undefined {
  if (!body.includes('\x60\x60\x60')) return undefined
  try {
    const draft = draftOf(body)
    let at = 0
    const shown = body
      .replace(/^[ \t]*#{1,6}[^\n]*\r?\n+(?=\x60{3}json\b)/gm, '')
      .replace(/\x60{3}([A-Za-z0-9_-]*)[ \t]*\r?\n[\s\S]*?\x60{3}/g, (block, language: string) => {
        if (language.toLowerCase() !== 'json') return block
        const section = draft.sections[at]
        if (section === undefined) return block
        at += 1
        const purpose = section.kind === 'investigate' ? '调查：' + section.question : '实现：' + section.goal
        return `${at}. ${purpose}`
      })
    return at === draft.sections.length
      ? '模型 · 任务草案\n' + clean(shown.replace(/\n{2,}(?=\d+\. )/g, '\n').replace(/(\d+\. [^\n]*)\n{2,}/g, '$1\n'))
      : undefined
  } catch { return undefined }
}
export function taskOf(rows: readonly StatusRow[], focus: string | null = null, full = false, changes?: CommitChanges): TaskFace {
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
  let action = '', problem = '', verification = '', commit = '', base = '', accepted = false, issued = false
  for (const { e } of current) {
    switch (e.t) {
      // A phase edge expires the previous action; a same-phase record does not.
      case 'round/state': if (e.from !== e.to) action = ''; state = e.to; from = e.from; break
      case 'round/intent': base = e.base; messages.push({ text: `你\n${goalOf(e.body)}`, role: 'user' }); break
      case 'holder/distill': {
        const preview = full ? undefined : draftPreview(e.body)
        messages.push({ text: `模型 · 当前理解\n${clean(e.body)}`, role: 'model', ...(preview === undefined ? {} : { preview }) }); break
      }
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
      case 'merge/attempt': action = e.conflicts > 0 ? `合并遇到 ${e.conflicts} 处冲突。` : MERGING; problem = e.conflicts > 0 ? action : ''; break
      case 'merge/accept': {
        const passed = e.assertions.filter(a => a.verdict === 'pass').length
        const failed = e.assertions.length - passed
        verification = `验收：${passed} 项通过${failed > 0 ? `，${failed} 项未通过或无法运行` : ''}。`
        if (failed > 0) problem = verification
        commit = e.commit; accepted = failed === 0; break
      }
      case 'view/write': case 'view/remove': case 'view/symlink': case 'view/chmod': changed.add(clean(e.path)); break
      case 'view/rename': changed.add(clean(e.from)); changed.add(clean(e.to)); break
      // Dispatch proves approval, not a running process.
      case 'contract/issue': issued = true; break
    }
  }
  // 判据是"这一轮真的记下了两个提交"，**不是**它们的字长：对象 id 的算法是仓库的性质
  // （sha1 四十位、sha256 六十四位，见 view/contract.ts 那次事故），按四十位筛会在 sha256
  // 库里把正常输入判死——提交改动摘要整个功能静默消失。是不是真提交由 `commit-source.ts`
  // 那道边界对着 git 说了算，这一层只管有没有。
  const recorded = (id: string): boolean => typeof id === 'string' && id !== ''
  const completion: CommitRequest | undefined = focus === null && state === 'Rebuilding' && accepted
    && recorded(base) && recorded(commit) ? { round, base, commit } : undefined
  const exactChanges = completion !== undefined && changes != null && changes.round === round
    && changes.base === base && changes.commit === commit && Array.isArray(changes.files)
    && changes.files.every(f => f !== null && typeof f === 'object' && ['A', 'M', 'D', 'T'].includes(f.kind) && typeof f.path === 'string' && f.path !== '')
    ? changes.files : undefined
  const changeRows: ConversationRow[] = exactChanges === undefined ? [] : [{
    text: full
      ? `本次提交改动（${exactChanges.length}）\n` + exactChanges.map(f => `${({ A: '新增', M: '修改', D: '删除', T: '类型变更' })[f.kind]}：${pathText(f.path)}`).join('\n')
      : exactChanges.length === 0 ? '本次提交没有文件改动。'
      : `提交改动（${exactChanges.length}）：${exactChanges.slice(0, 3).map(f => pathText(f.path)).join(' · ')}${exactChanges.length > 3 ? ' · …' : ''}`,
    role: 'system',
  }]
  const notice = state === null ? null : roundNoticeOf(from, state)
  const result: ConversationRow[] = []
  if (state === 'Rebuilding' && !full) {
    result.push({ text: notice!.text, role: 'ok' })
    result.push(...changeRows)
    if (exactChanges === undefined && changed.size > 0) result.push({ text: `改动：${[...changed].join(' · ')}`, role: 'system' })
    if (verification !== '') result.push({ text: verification, role: 'system' })
    else result.push({ text: '验收结果详见记录。', role: 'system' })
    result.push({ text: WORDS.nextTaskGuide, role: 'system' })
    return { round, state, rows: result, plan: [], ...(completion === undefined ? {} : { completion }) }
  }
  // 实际动作已经说明当前进展；失败、验收与写回结论仍优先。
  const actionStatus = notice === null && state === 'Working' && action !== '' && action !== problem
  const status = notice?.text ?? (actionStatus ? action : state === null ? '当前任务记录' : state === 'Planning' ? WORDS.planPreparing : state === 'Working' && issued ? '这批任务已确认，结果尚未写回。' : roundLabelOf(state, from))
  result.push({ text: status, role: notice?.role ?? (actionStatus ? 'instruction' : state === 'Aborted' ? 'refuse' : 'system') })
  result.push(...changeRows)
  if (notice?.text === WORDS.verifyNotWritten) result.push({ text: WORDS.verifyFailedGuide, role: 'instruction' })
  if (state === 'Committed') result.push({ text: '验收已通过 · 待写回', role: 'instruction' })
  else if (!actionStatus && state === 'Working' && action !== '' && action !== problem) result.push({ text: action, role: 'instruction' })
  if (problem !== '') result.push({ text: problem, role: 'refuse' })
  for (const message of messages) result.push({ text: '', role: 'body' }, message)
  if (verification !== '' && state !== 'Committed') result.push({ text: verification, role: 'system' })
  if (commit !== '') result.push({ text: '已合并结果；文件与验收记录可在阅读面查看。', role: 'system' })
  if (planInvalid) result.push({ text: '计划记录无法展开；原文可用 /log 查看。', role: 'system' })
  return { round, state, rows: result, plan: full || (plan.some(p => p.status !== 'completed') && state !== 'Aborted') ? plan : [], ...(completion === undefined ? {} : { completion }) }
}
