// TUI 的第二版第六格：**门口那一批**（PLAN § 5.19 第二版「五 · 门口那一批怎么批」· 第九节 `T6`
// 那一行 · 架构 § 9.8 · 架构 § 15.1.a）。跑法：cd ~/fugue && node --test src/ui/gate.test.ts
//
// 这一份量的五样：
//
//   ① **队列行与卡片逐字来自那一批**：`第 i/N 份` 说的就是第 i 份那一个 id（把三份各扫一遍）·
//      下标越界夹回来 · 空批次那一句；**负对照**：行里绝不出现在那一批里没有的 id。
//   ② **二段确认**：按一下只举手 · 再按同一个键才生效 · **没举手时 `Enter` 什么都不做**（这一条
//      就是防止误放行的那颗牙）· 举手之后按别的一档是"换一档"（不执行）· `Esc` 把举手清掉。
//   ③ **预览按类型分派**：`implement` 给命令原文与写入面 · `investigate` 给问题与要交的证据 ·
//      `resolve` 给冲突路径；**负对照**：配置里没绑那个动作时说得出名字，绝不许静默印一条不存在
//      的命令。
//   ④ **三档，不是五档**：选项行只有 `放行一次(y)` · `拒(n)` · `中止(Esc)`，`a` / `p` / 升权档
//      一个字都不出现（人拍的：那三档要 S5 的能力闸，见 `gate.ts` 头注）。
//   ⑤ **放行那一档跑的就是 `round go`**：`lineOf('approve')` 与 `g` 那一键是同一条命令；`reject`
//      不跑命令（一个字节都不落）。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Contract } from '../contract/types.ts'
import { GATE_KEEP, GATE_VIEW, clampAt, gateFaceOf, gateRowsOf, lineOf, optionRowOf, pressGate, previewLinesOf, gateQueueRowOf, stepAt } from './gate.ts'
import type { GateBatch, GateCard } from './gate.ts'
import { widthOf } from './glyph.ts'
import { GO_LINE } from './run.ts'

/** 品牌类型那一栏（`RelPath` 一类）：这一份里那些值是拿来喂接口的，不是账上真发生过的。 */
const brand = (v: string): never => v as never

const IMPL: Contract = {
  id: 'r1.implement.1',
  agent: 'agent/r1/1',
  branch: 'refs/heads/fugue/r1/1',
  goal: '把解析器拆出来',
  kind: 'implement',
  ownedPaths: [brand('src/parse.ts')],
  deliverables: [{ path: brand('src/parse.ts'), form: '模块' }],
  assertions: [{ name: '单元测试全过', action: brand('test') }],
  seed: [brand('src/parse.ts')],
  actionOutputs: {},
} as unknown as Contract

const INVESTIGATE: Contract = {
  id: 'r1.investigate.2',
  agent: 'agent/r1/2',
  branch: 'refs/heads/fugue/r1/2',
  goal: '看清现状',
  kind: 'investigate',
  question: '现状是怎么写的',
  evidenceRequired: [{ artifact: brand('evidence/agent/r1/2/现状'), note: '一句结论加出处' }],
  seed: [brand('src/parse.ts')],
} as unknown as Contract

const RESOLVE: Contract = {
  id: 'r1.resolve.3',
  agent: 'agent/r1/3',
  branch: 'refs/heads/fugue/r1/3',
  goal: '解冲突',
  kind: 'resolve',
  base: brand('a'.repeat(40)),
  conflictPaths: [brand('src/parse.ts')],
  assertions: [{ name: '合并后测试全过', action: brand('test') }],
} as unknown as Contract

const BATCH: GateBatch = {
  round: 'r1',
  fingerprint: 'b14b25442c590aa3',
  same: [],
  contracts: [IMPL, INVESTIGATE, RESOLVE],
}

const CMDS: Readonly<Record<string, string>> = { test: '/bin/sh -c true' }

// ── ① 队列行与卡片逐字来自那一批 ─────────────────────────────────────────────
test('① 队列行逐字来自那一批：第 i/N 份就是第 i 份 · 下标夹回来 · 不在那一批里的 id 一个字都不出现', () => {
  const face = gateFaceOf(BATCH, CMDS)
  assert.equal(face.cards.length, 3, '三份契约三张卡')
  // **把三份各扫一遍**：行里那个 id 必须就是那一份的 id（负对照：随便挑一份看它对不对得上）。
  for (let at = 0; at < 3; at += 1) {
    const row = gateQueueRowOf(face, at)
    const id = (BATCH.contracts[at] as Contract).id
    assert.ok(row.includes(`第 ${at + 1}/3 份`), `第 ${at} 份那一行该说"第 ${at + 1}/3 份"：${row}`)
    assert.ok(row.includes(id), `那一行该带着这一份的 id（${id}）：${row}`)
    assert.ok(row.includes('还有 3 份等你点头'), `那一行该说还有几份：${row}`)
    for (const other of BATCH.contracts) {
      if (other.id === id) continue
      assert.equal(row.includes(other.id), false, `第 ${at} 份那一行里混进了别的契约：${row}`)
    }
  }
  // 下标那一栏：负数 · 越界 · 不是整数都夹回来（候选变了 · 批次短了都走它）。
  assert.equal(clampAt(3, -1), 0)
  assert.equal(clampAt(3, 3), 2)
  assert.equal(clampAt(3, 1.5), 0, '不是整数就当没选（不四舍五入到一个看起来合法的下标）')
  assert.equal(clampAt(0, 5), 0)
  assert.equal(stepAt(3, 0, -1), 0, '头一份再往上还是头一份（夹住，不环形）')
  assert.equal(stepAt(3, 2, 1), 2, '最后一份再往下还是最后一份')
  assert.equal(stepAt(3, 1, 1), 2)
  assert.equal(gateQueueRowOf(gateFaceOf({ ...BATCH, contracts: [] }), 0), '门口这一批一份契约都没有（门不会停在这样一批上——报出来）')
  console.log(`① 读数：三份各扫一遍都带自己那个 id · 夹回来的五档（-1 → 0 · 3 → 2 · 1.5 → 0 · 空批次那一句）· ` +
    `行里的字：${gateQueueRowOf(face, 1)}`)
})

// ── ② 二段确认 ───────────────────────────────────────────────────────────────
test('② 二段确认：按一下只举手 · 再按同一个键（或 Enter）才生效 · 没举手时 Enter 什么都不做', () => {
  // 一 · 第一下只举手。
  const one = pressGate(GATE_VIEW, 'approve')
  assert.equal(one.t, 'arm')
  if (one.t !== 'arm') return
  assert.equal(one.view.armed, 'approve', '举起来的是这一档')
  assert.ok(optionRowOf(one.view).includes('再按一次 y'), `举手之后那一句要说清再按一次：${optionRowOf(one.view)}`)
  // 二 · 第二下才生效。
  assert.equal(pressGate(one.view, 'approve').t, 'do', '同一个键第二下才生效')
  // 三 · `Enter` 是一条等效的路（§5.19 五："同一个键或 Enter 再按一次"）。
  const viaEnter = pressGate(one.view, 'confirm')
  assert.equal(viaEnter.t, 'do')
  if (viaEnter.t !== 'do') return
  assert.equal(viaEnter.option, 'approve')
  assert.equal(viaEnter.view.armed, null, '生效之后举手那一栏清掉（不许连着吃第二下）')
  // 四 · **负对照**：没举手时 `Enter` 什么都不做——不然"随手一个回车"就把一批发出去了。
  assert.equal(pressGate(GATE_VIEW, 'confirm').t, 'none', '没举手时 Enter 绝不放行')
  // 五 · 举手之后按**别的一档**：换一档，不执行前头那一档。
  const swap = pressGate(one.view, 'reject')
  assert.equal(swap.t, 'arm')
  if (swap.t !== 'arm') return
  assert.equal(swap.view.armed, 'reject', '换成了 n 那一档')
  assert.equal(pressGate(swap.view, 'confirm').t, 'do', '换过之后 Enter 生效的是**新举的那一档**')
  // 六 · `Esc`：收起这一块，举手那一栏一并清掉。
  const gone = pressGate(one.view, 'cancel')
  assert.equal(gone.t, 'cancel')
  if (gone.t !== 'cancel') return
  assert.equal(gone.view.armed, null)
  assert.equal(pressGate(gone.view, 'confirm').t, 'none', '收起之后 Enter 什么都不做')
  console.log('② 读数：y → arm · y → do · Enter（举过手）→ do · Enter（没举手）→ none · y 之后 n → arm(n) · Esc → cancel 且清掉举手')
})

// ── ③ 预览按类型分派 ─────────────────────────────────────────────────────────
test('③ 预览按类型分派：三种契约三种话；认不出来的动作名说出来，绝不印一条不存在的命令', () => {
  const face = gateFaceOf(BATCH, CMDS)
  const [implCard, invCard, resCard] = face.cards as readonly [GateCard, GateCard, GateCard]
  // `implement`：头一行是目标，随后是**命令原文**（从配置里读来的那一条，逐字）与写入面。
  const impl = previewLinesOf(implCard).join('\n')
  assert.ok(impl.includes('实现：把解析器拆出来'), impl)
  assert.ok(impl.includes('起进程：/bin/sh -c true'), impl)
  assert.ok(impl.includes('写路径：src/parse.ts'), impl)
  assert.ok(impl.includes('交付物：src/parse.ts（模块）'), impl)
  assert.ok(impl.includes('验收：单元测试全过（test）'), impl)
  assert.ok(impl.includes('种子：src/parse.ts'), impl)
  // `investigate`：问什么 · 要交什么证据 · 交上来的说明是什么。**不给命令那一栏**（它不跑动作）。
  const inv = previewLinesOf(invCard).join('\n')
  assert.ok(inv.includes('调查：现状是怎么写的'), inv)
  assert.ok(inv.includes('要交的证据：evidence/agent/r1/2/现状'), inv)
  assert.ok(inv.includes('交上来的说明：一句结论加出处'), inv)
  assert.equal(inv.includes('起进程'), false, `调查型没有动作可跑，不该有一栏"起进程"：${inv}`)
  // `resolve`：要动的冲突路径。
  const res = previewLinesOf(resCard).join('\n')
  assert.ok(res.includes('解冲突：src/parse.ts'), res)
  assert.ok(res.includes('要动的冲突路径：src/parse.ts'), res)
  assert.ok(res.includes('起进程：/bin/sh -c true'), res)
  // **负对照**：配置里没绑那个动作 → 那一行说出**哪个名字**没绑，而不是印一条不存在的命令。
  const bare = gateFaceOf(BATCH, {})
  const bareImpl = previewLinesOf((bare.cards as readonly GateCard[])[0] as GateCard).join('\n')
  assert.ok(bareImpl.includes('（配置里没绑这个动作：test）'), bareImpl)
  assert.equal(bareImpl.includes('/bin/sh'), false, '没绑就不许印出一条命令来')
  // 折行：**预览那几行**在这一份里折（横贯整栏的行 `frame.ts` 只截不折，而预览那一句话被截掉尾巴
  // 就没用了）。**末两行不折**：折了 `GATE_KEEP` 那个约定就破了——它们靠**头几个字**保命（被截之后
  // 还看得出"还有几份 · 第几份"与"放行/拒/中止"）。
  const rows = gateRowsOf({ face, view: GATE_VIEW, columns: 30 })
  assert.ok(rows.length > GATE_KEEP + 1, `折过之后该多出几行来：${rows.length}`)
  const preview = rows.slice(0, -GATE_KEEP)
  const tail = rows.slice(-GATE_KEEP)
  assert.equal(tail.length, GATE_KEEP)
  for (const l of preview) assert.ok(widthOf(l) <= 30, `这一行超宽了（${widthOf(l)}）：${l}`)
  assert.ok((tail[0] as string).startsWith('还有 3 份等你点头 · 第 1/3 份'), `队列行被截也要先留着头几个字：${String(tail[0])}`)
  assert.ok((tail[1] as string).startsWith('放行一次(y)'), `选项行也一样：${String(tail[1])}`)
  console.log(`③ 读数：三张卡各 ${face.cards.map((c) => c.detail.length).join('/')} 行明细 · ` +
    `没绑动作那一档印「（配置里没绑这个动作：test）」· 30 列下预览折成 ${preview.length} 行、每行 ≤ 30 列 · ` +
    `末两行不折（队列行与选项行靠头几个字保命）`)
})

// ── ④ 三档，不是五档 ─────────────────────────────────────────────────────────
test('④ 选项行只有三档：y 放行 · n 拒 · Esc 中止；a / p / 升权档一个字都不出现', () => {
  const row = optionRowOf(GATE_VIEW)
  assert.equal(row, '放行一次(y) · 拒(n) · 中止(Esc)')
  // **负对照**：五档那一版的那三样（人拍的不落，见 `gate.ts` 头注：要 S5 的能力闸）。
  for (const gone of ['(a)', '总是', '(p)', '规则', '给网络', '给写权', '全放']) {
    assert.equal(row.includes(gone), false, `那一行里混进了这一版不落的档：${gone} —— ${row}`)
  }
  console.log(`④ 读数：${row}（五档里那三档一个字都没有）`)
})

// ── ⑤ 放行那一档跑的就是 `round go` ──────────────────────────────────────────
test('⑤ 放行跑的就是 `round go`（与 `g` 那一键同一条）· 拒了不跑命令', () => {
  assert.equal(lineOf('approve'), GO_LINE)
  assert.equal(lineOf('approve'), 'round go', '与 `g` 那一键按下去发的那一条逐字相同（界面里没有第二条放行路径）')
  assert.equal(lineOf('reject'), '', '拒了就是一个字节都不落：没有命令可跑')
  console.log(`⑤ 读数：approve → 「${lineOf('approve')}」（= GO_LINE）· reject → 「」（空串）`)
})
