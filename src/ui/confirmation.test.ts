// 确认场景的多帧证据：产品舞台 → 会话 → 终端；不用模型、不写账。
import assert from 'node:assert/strict'
import test from 'node:test'
import { gateFaceOf, gateLayoutOf, gateRowsOf } from './gate.ts'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm, CLEAR_LINE } from './term.ts'
import { frameOf } from './frame.ts'
import { statusOf } from '../probe/status.ts'
import { KEYMAP, hintLineOf, hintLimitOf } from './keymap.ts'
import { setGlyphTier, widthOf } from './glyph.ts'
import type { Contract } from '../contract/types.ts'
import type { RunLauncher } from './run.ts'

const face = gateFaceOf({ round: 'r1', fingerprint: 'pending', same: [], contracts: [{
  id: 'r1.implement.1', agent: 'agent/r1/1', kind: 'implement', goal: '修复登录失败时的提示',
  ownedPaths: ['src/login.ts', 'test/login.test.ts'], seed: ['src/login.ts'],
  deliverables: [{ path: 'src/login.ts', form: 'code' }],
  assertions: [{ name: '登录行为', action: 'test' }],
}] as unknown as Contract[] }, { test: 'node --test test/login.test.ts' })

test('确认选项在窄屏中折行，整批范围与收起含义可见', () => {
  for (const columns of [16, 20, 30, 36, 76]) for (const armed of [null, 'approve', 'reject'] as const) {
    const layout = gateLayoutOf({ face, view: { at: 0, armed }, columns })
    const rows = gateRowsOf({ face, view: { at: 0, armed }, columns })
    const frame = frameOf({ snapshot: statusOf([]), width: columns + 4, height: 40, bottom: layout })
    const optionLines = rows.length - layout.waitingAt!
    assert.equal(layout.waitingCount, optionLines, '声明行数覆盖完整选项，不能只报第一行')
    assert.equal(frame.roles.filter(r => r === 'waiting').length, optionLines, '折出的选项整句都有等待反馈')
    assert.ok(rows.every(r => widthOf(r) <= columns), `${columns} 列 / ${armed} 有超宽行：${JSON.stringify(rows)}`)
    const text = rows.join(' ')
    assert.ok(text.includes('Esc 收起'), text)
    assert.ok(!text.includes('中止'), 'Esc 只收起界面，不能声称中止任务')
  }
  assert.match(hintLineOf(KEYMAP, 2, 'gate'), /↑ 上一项 · ↓ 下一项/)
  assert.ok(gateRowsOf({ face, view: { at: 0, armed: null }, columns: 76 }).join(' ').includes('y 放行整批 · n 拒绝 · Esc 收起'), '行动提示仍在卡片中，提示行露导航')
})

test('确认开合和举手的多帧：9→13→9，首按零执行，未变帧零重写，退出收走全部区域', async () => {
  const old = setGlyphTier('ascii')
  try {
    let pending: typeof face | null = null
    const presses: string[] = []
    const notes: string[] = []
    const run: RunLauncher = {
      running: false, last: [], stop: () => false,
      argvOf: line => ({ words: line.split(' '), argv: ['fugue', ...line.split(' ')], why: null }),
      press: line => { presses.push(line); return true },
    }
    const stage = openStage({
      rows: () => [], columns: () => 40, termRows: () => 24, pendingFace: async () => pending,
      note: s => notes.push(s), redraw: () => {}, run: () => run, now: () => 0, abort: () => {},
      hint: when => hintLineOf(KEYMAP, hintLimitOf(40, KEYMAP, when), when), keysOf: () => '',
    })
    stage.setRaw(true)
    const session = openSession({ view: stage.view })
    const chunks: string[] = []
    const heights: number[] = []
    const term = openTerm({ out: { isTTY: true, columns: 40, rows: 24, write: s => chunks.push(s) },
      term: 'xterm', heightOf: stage.heightWant })
    const draw = () => term.draw([], size => { heights.push(size.height); return session.panel(size) })
    draw()
    pending = face
    await stage.refreshGate()
    draw()
    assert.deepEqual(heights, [9, 13], '确认内容也享有已有弹层高度；关着仍是原档')
    const visible = session.frame({ columns: 40, height: 13 }).join('\n')
    assert.match(visible, /运行命令：node --test/)
    assert.match(visible, /test\/login\.test\.ts/)
    assert.match(visible, /写路径：src\/login\.ts/)
    stage.onAction({ action: 'approve', key: 'y' })
    draw()
    assert.deepEqual(presses, [], '首按只举手，不能起命令')
    assert.equal(notes.length, 1, '只有打开时的一条结论；举手不向历史重复写入')
    assert.ok(chunks.at(-1)?.includes('再按 y / Enter 放行整批'))
    draw()
    const unchanged = chunks.at(-1) as string
    assert.equal(unchanged.split(CLEAR_LINE).length - 1, 0, '完全相同的帧零清行')
    stage.onAction({ action: 'cancel' })
    draw()
    assert.equal(heights.at(-1), 9, '收起回到缺省高度')
    assert.equal(stage.view().bottom, undefined)
    // 没有 raw 输入时不画确认块，也不为它撑高。
    pending = { ...face, fingerprint: 'next' }
    await stage.refreshGate()
    stage.setRaw(false)
    assert.equal(stage.heightWant(), 9)
    assert.equal(stage.view().bottom, undefined)
    term.close()
    assert.match(chunks.at(-1) as string, /\x1b\[12M$/, '9 框 + 2 提示 + 1 输入全部收走')
    console.log(`确认序列：height=${heights.join('→')} · 首按执行=${presses.length} · 未变帧清行=0 · 退出删行=12`)
  } finally { setGlyphTier(old) }
})
