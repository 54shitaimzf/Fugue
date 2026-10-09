// 当前任务的离线样张：固定事件 → 产品舞台 → 会话 → 终端，不调用模型、不写账。
// node tools/face-dump.ts --scene run --width 120 --height 40 [--ansi] [--background dark|light] [--glyph ascii]
// --ansi 供真实终端渲染取景，保留可见帧；缺省输出纯文本。所有场景共享产品布局与按键源。
import type { StatusRow } from '../src/probe/status.ts'
import type { LogEvent } from '../src/log/events.ts'
import type { Contract } from '../src/contract/types.ts'
import { openStage } from '../src/ui/stage.ts'
import { openSession } from '../src/ui/follow.ts'
import { openTerm } from '../src/ui/term.ts'
import { gateFaceOf } from '../src/ui/gate.ts'
import { KEYMAP, hintLineOf, hintLimitOf } from '../src/ui/keymap.ts'
import { setGlyphTier } from '../src/ui/glyph.ts'
import { themeOf } from '../src/ui/theme.ts'

const arg = (name: string, fallback: string): string => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] ?? fallback }
const columns = Number(arg('--width', '120')), height = Number(arg('--height', '40')), scene = arg('--scene', 'run')
if (!Number.isInteger(columns) || !Number.isInteger(height) || columns < 1 || height < 1) throw Error('尺寸须为正整数')
if (!['empty', 'input', 'run', 'approve', 'failed', 'done', 'next', 'read'].includes(scene)) throw Error('未知场景')
setGlyphTier(arg('--glyph', 'box') as 'box' | 'ascii')
let seq = 0
const row = (e: object, writer = 'round'): StatusRow => ({ pos: { writer, seq: ++seq }, e: e as LogEvent })
const rows: StatusRow[] = scene === 'empty' ? [] : [
  row({ t: 'round/state', round: 'r1', from: 'Idle', to: 'Planning' }),
  row({ t: 'round/intent', round: 'r1', body: JSON.stringify({ goal: '修复登录失败时的提示，保留已经输入的账号。' }), base: 'base', digest: 'goal' }),
  row({ t: 'holder/distill', agent: 'round', body: '我会先检查失败路径，再修改提示与输入状态，并运行登录测试。' }),
  row({ t: 'holder/todos', agent: 'round', body: JSON.stringify({ todos: [
    { content: '检查失败路径', status: 'completed' },
    { content: '修复提示与输入状态', activeForm: '修复提示与输入状态', status: 'in_progress' },
    { content: '验证登录行为', status: 'pending' },
  ] }) }),
]
if (!['empty', 'input', 'approve'].includes(scene)) rows.push(
  row({ t: 'round/state', round: 'r1', from: 'Delegated', to: 'Working' }),
  row({ t: 'agent/handoff', agent: 'agent/r1/1', body: '失败提示现在就近显示，并保留账号内容。接下来验证重试与成功登录两条路径。' }, 'agent/r1/1'),
  row({ t: 'view/write', agent: 'agent/r1/1', path: 'src/login.ts', rev: 1, blob: 'code', mode: 0o100644 }, 'agent/r1/1'),
  row({ t: 'run/start', agent: 'agent/r1/1', argv0: 'node', argv: ['node', 'tools/test-entry.js', 'fast', 'src/login.test.ts'] }, 'agent/r1/1'),
)
if (scene === 'failed') rows.push(row({ t: 'run/end', agent: 'agent/r1/1', exit: 1 }, 'agent/r1/1'), row({ t: 'round/state', round: 'r1', from: 'Verifying', to: 'Working' }))
if (scene === 'done' || scene === 'next') rows.push(row({ t: 'merge/accept', round: 'r1', commit: 'result', assertions: [{ assertion: '重试登录', verdict: 'pass' }, { assertion: '成功登录', verdict: 'pass' }] }), row({ t: 'round/state', round: 'r1', from: 'Committed', to: 'Rebuilding' }))
if (scene === 'next') rows.push(row({ t: 'round/state', round: 'r2', from: 'Idle', to: 'Planning' }), row({ t: 'round/intent', round: 'r2', body: JSON.stringify({ goal: '接下来检查退出登录后的页面。' }), base: 'result', digest: 'next' }))
const face = gateFaceOf({ round: 'r1', fingerprint: 'review', same: [], contracts: [{ id: 'r1.implement.1', agent: 'agent/r1/1', kind: 'implement', goal: '修复登录提示并保留账号', ownedPaths: ['src/login.ts'], assertions: [{ name: '登录行为', action: 'test' }], deliverables: [], seed: [] }] as unknown as Contract[] }, { test: 'node tools/test-entry.js fast src/login.test.ts' })
const stage = openStage({ rows: () => rows, columns: () => columns, termRows: () => height, pendingFace: async () => scene === 'approve' ? face : null,
  note: () => {}, redraw: () => {}, now: () => 0, abort: () => {},
  hint: when => hintLineOf(KEYMAP, hintLimitOf(columns, KEYMAP, when), when),
  run: () => ({ running: scene === 'run', last: [], press: () => false, stop: () => false, argvOf: () => ({ words: [], argv: [], why: null }) }),
})
stage.setRaw(true); stage.onAdvance(rows); await stage.refreshGate()
if (scene === 'input') stage.onAction({ action: 'insert', text: '失败时也要支持直接重试。' })
if (scene === 'read') stage.onAction({ action: 'read' })
const session = openSession({ view: stage.view }); session.push(rows)
if (process.argv.includes('--ansi')) {
  const background = arg('--background', 'default')
  const term = openTerm({ out: { isTTY: true, columns, rows: height, write: s => process.stdout.write(s) }, term: 'xterm-256color', heightOf: stage.heightWant,
    theme: themeOf({ term: 'xterm-256color', noStyle: process.argv.includes('--no-style'), colorFgBg: background === 'dark' ? '15;0' : background === 'light' ? '0;15' : undefined }),
  })
  term.draw([], size => session.panel(size))
} else {
  const view = stage.view()
  process.stdout.write([...session.frame({ columns, height: stage.heightWant() }), '', view.hint ?? '', ...(view.input?.rows ?? [])].join('\n') + '\n')
}
stage.close()
