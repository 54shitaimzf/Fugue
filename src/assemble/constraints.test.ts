// Z6 的断言（PLAN § 5.6 的 Z6 行 · 架构 § 8.11 的四条约束 · 架构 § 9.6 的装配行与「两个面共用
// 返回形状」· 架构 § 20 S6 的第三条验证 · § 3 的地板）。
//
//   ① **一份故意坏掉的输入 → 四条约束各报一处**：A 区的段值里带 `<realRoot>` 那条绝对路径 ·
//      带宿主名 · 带一段 Signal 原文 · C 区中部被改写。报出来的话要带得动「是哪一条」
//   ② **命令行那次装配与 `Assembler` 的返回形状同一个**（架构 § 9.6：「CLI 的输出就是 `M9`
//      工具的返回形状」）：`fugue assemble subagent --json` 那几栏与 `assemble()` 的
//      `zoneA` · `zoneB` · `zoneC` 逐字节对得上
//   ③ **结账口**：三区哈希与 `firstDivergence` 两栏都印得出来（架构 § 20 S6 的交付物）
//   ④ **负对照**：把 `hostname` 那一条检查短路 → ① 少一处、当场红
//   ⑤ **正对照**：一份干净的输入四条一处都不报（否则 ① 那四处可能只是"什么都报"）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Prefix, SegmentId, SegmentValue } from './contract.ts'
import { assemble, hashOf, firstDivergence } from './assemble.ts'
import { BUILTIN_CATALOG, defaultModelOf } from '../model/catalog.ts'

/** 装配只要一个模型键：内置档第一条当那一格的输入（P2d 起目录是数据）。 */
const DEFAULT_MODEL = { id: defaultModelOf(BUILTIN_CATALOG).id }
import { render } from './render.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from './protocol.ts'
import { emptyState, sourcesFor } from './sources.ts'
import type { AgentCoord } from './sources.ts'
import { CONSTRAINT_KINDS, checkConstraints, envFacts, formatViolation } from './constraints.ts'
import { stateWithState } from './sources-state.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const HERE = fileURLToPath(new URL('.', import.meta.url))

const WHO: AgentCoord = { id: 'agent-2', branch: 'agent-2', outputPaths: ['deliver/agent-2/report.md'] }

/** 一份干净的段值：拿真源造，四个渲染器都用得上。 */
function cleanSegments(): Record<SegmentId, SegmentValue> {
  const base = emptyState()
  const st = {
    ...base,
    policy: '# 项目方针\n\n- 一条方针。\n',
    system: { workspace: 'fugue', platform: 'linux' },
    codeTree: ['src/index.ts', 'src/view/view.ts'],
    goal: '把这一站做完。',
    files: [{ path: 'src/index.ts', text: 'export const x = 1\n' }],
    commits: ['abc123 第一个提交'],
    handoff: '上一任留下的一句话。',
    task: { goal: '让装配跨 agent 全等。', question: 'A 区里究竟是哪三段？', deliverables: ['sources.ts'], evidenceRequired: [], assertions: [] },
    runtime: '这一步的会话流。',
    signals: ['agent-2 已完成'],
    lastStep: '上一步的工具结果。',
  }
  return sourcesFor(SUBAGENT_PROTOCOL, st, WHO)
}

/** 那份故意坏掉的输入：A 区里带绝对路径、带宿主名，C 区那一段带 Signal 原文。 */
function brokenSegments(): Record<SegmentId, SegmentValue> {
  const segs = cleanSegments()
  const facts = envFacts()
  return {
    ...segs,
    系统状态: { workspace: 'fugue', root: '/home/fugue/work', host: facts.hostname },
    上一步结果: `${String(segs['上一步结果'])}\n{"t":1,"kind":"done","digest":"raw-signal-原文"}\n`,
  }
}

/** ① 那一份故意坏掉的输入：A 区里带绝对路径与宿主名，C 区那一段带 Signal 原文。 */
test('① 一份故意坏掉的输入 → 四条约束各报一处，报出的是哪一条', () => {
  const segs = brokenSegments()

  // 约束 2 与 3：A 区那一段里既有绝对路径又有宿主名。
  const alone = checkConstraints(SUBAGENT_PROTOCOL, segs)
  const kinds = alone.map((v) => v.kind)
  assert.ok(kinds.includes('materialized'), `绝对路径没报出来：${alone.map(formatViolation).join(' | ')}`)
  assert.ok(kinds.includes('env'), '宿主名没报出来')
  assert.ok(kinds.includes('signal'), 'Signal 原文没报出来')
  const absV = alone.find((v) => v.kind === 'materialized')
  assert.equal(absV?.where, '系统状态', '绝对路径应当报在系统状态那一段上')
  assert.match(absV?.detail ?? '', /\/home\/fugue\/work/, '报出来的话里要带那一条路径')
  const envV = alone.find((v) => v.kind === 'env')
  assert.equal(envV?.where, '系统状态')
  assert.match(envV?.detail ?? '', new RegExp(envFacts().hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const sigV = alone.find((v) => v.kind === 'signal')
  assert.equal(sigV?.where, '上一步结果')
  // 一次装配里看不出的那一条（C 区只追加）不给 `previous` 就不报——它不该报假绿。
  assert.ok(!kinds.includes('append-only'), '没给上一次的 C 区，就不该判"只追加"')

  // 约束 1：C 区只追加。
  //
  // **两边的差只能是一处：`运行时上下文` 那一段往后加。** C 区里另外那两段的渲染是空值
  // 补出来的换行，改 `runtime` 的时候它们跟着从头重算——所以判据落在**那一段的字节**上
  // （`render()` 给每段补一个换行，比的是渲染后的字节，不是原文）。这一条与下面"中部被
  // 改写"那一对是同一个形状：**先证伪，再证不伪**。
  const cSegs = (runtime: string): Record<SegmentId, SegmentValue> =>
    sourcesFor(SUBAGENT_PROTOCOL, { ...emptyState(), runtime }, WHO)
  const first = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: cSegs('第一步。') })
  const CLEAN_RUNTIME = '第一步。' + '第二步。'
  // **只追加那一档的读数**：C 区是唯一积累的部分（架构 § 8.11），这一次的字节等于上一次的
  // 字节接上一段新的——判不报。两次都走 `assemble()`（同一个渲染路径），不是手搓的字节。
  const appendC = (prev: Prefix, more: string): Prefix => ({
    zoneA: prev.zoneA,
    zoneB: prev.zoneB,
    zoneC: new TextEncoder().encode(new TextDecoder().decode(prev.zoneC) + more),
  })
  const appended = appendC(first, '后来又一步。')
  assert.notEqual(appended.zoneC.length, first.zoneC.length, '这一档没有真的往后加——量不到"只追加"')
  assert.deepEqual(
    checkConstraints(SUBAGENT_PROTOCOL, cSegs(CLEAN_RUNTIME), first, '上一步', envFacts(), appended)
      .filter((v) => v.kind === 'append-only'),
    [],
    '尾巴上追加之后不该报中部被改写',
  )
  // 中部被改写：新的内容插在最前面（不是尾巴）→ 报，位置就是第一处不同。
  const inserted: Prefix = {
    zoneA: first.zoneA,
    zoneB: first.zoneB,
    zoneC: new TextEncoder().encode('改写过的' + new TextDecoder().decode(first.zoneC)),
  }
  const rewritten = checkConstraints(SUBAGENT_PROTOCOL, cSegs('改写过的第一步。'), first, '上一步', envFacts(), inserted)
  const appendV = rewritten.find((v) => v.kind === 'append-only')
  assert.ok(appendV !== undefined, `C 区中部被改写没报出来：${rewritten.map(formatViolation).join(' | ')}`)
  assert.match(appendV.detail, /第 1 个字节起不同/, '报出来的话里要有第一处不同的位置')
  // 同一个 C 区（这一步没动）也不报。
  const same = checkConstraints(SUBAGENT_PROTOCOL, cSegs('第一步。'), first, '上一步', envFacts(), first)
  assert.deepEqual(same.filter((v) => v.kind === 'append-only'), [], '同一个 C 区居然报了"中部被改写"')
})

test('② 命令行那次装配与 Assembler 的返回形状同一个', () => {
  const root = fixtureRoot('cli')
  try {
    const r = spawnSync(process.execPath, [CLI, '--root', root, '--json', 'assemble', 'subagent', '--agent', 'agent-2'], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, `命令行退非零：${r.stderr}`)
    const got = JSON.parse(r.stdout) as Record<string, unknown>
    // 三区哈希与它们的字节数：形状与 `assemble()` 的返回一致（同一份值，两个面）。
    const zones = got['zones'] as Record<string, { hash: string; bytes: number; firstDivergence: number | null }>
    assert.ok(zones['A'] !== undefined && zones['B'] !== undefined && zones['C'] !== undefined, '三区那三栏不齐')
    for (const z of ['A', 'B', 'C'] as const) {
      assert.match(zones[z].hash, /^[0-9a-f]{16}$/, `${z} 区的哈希不是 sha256 前 16 位`)
      assert.ok((zones[z].bytes ?? 0) > 0, `${z} 区的字节数是 0`)
    }
    // 命令行那一次与程序里那一次：**同一份源**（配置与项目方针两处都读同一份文件），
    // 所以 A 区那一段逐字节相同——「CLI 的输出就是 M9 工具的返回形状」这句话的机器可读那一半
    // （架构 § 9.6）。B 区与 C 区是从日志来的（视图的文件内容 · 提交序列），这一份测试的
    // 输入是空的，所以只判 A 区那一段。
    const st = stateWithState(emptyState(), readConfigOf(root), root)
    const segs = sourcesFor(SUBAGENT_PROTOCOL, st, WHO)
    const p = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: segs })
    assert.equal(zones['A'].hash, hashOf(p.zoneA), 'A 区的哈希与程序里那次不同——两处读的不是同一份源')
    assert.equal(zones['A'].bytes, p.zoneA.length)
    // 两个面同一份值：人读那一面印的就是 `--json` 那一面的三行哈希。
    const human = spawnSync(process.execPath, [CLI, '--root', root, 'assemble', 'subagent', '--agent', 'agent-2'], {
      encoding: 'utf8',
    })
    assert.equal(human.status, 0, human.stderr)
    assert.match(human.stdout, new RegExp(zones['A'].hash))
    assert.match(human.stdout, new RegExp(zones['B'].hash))
    assert.match(human.stdout, new RegExp(zones['C'].hash))
    // 四条约束也一并报：干净的输入一处都不报。
    assert.deepEqual(got['violations'], [], `干净输入报了违反：${JSON.stringify(got['violations'])}`)
    assert.equal(got['protocol'], 'subagent')
    assert.equal(got['agent'], 'agent-2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('③ 结账口：三区哈希与 firstDivergence 两栏都印得出来', () => {
  const root = fixtureRoot('gate')
  try {
    // 人读的那一面：三行哈希 + 一行第一处不同。
    const human = spawnSync(process.execPath, [CLI, '--root', root, 'assemble', 'subagent', '--agent', 'agent-2'], { encoding: 'utf8' })
    assert.equal(human.status, 0, human.stderr)
    assert.match(human.stdout, /A 区/, '人读的输出里没有 A 区那一行')
    assert.match(human.stdout, /[0-9a-f]{16}/, '人读的输出里没有哈希')
    assert.match(human.stdout, /约束/, '人读的输出里没有四条约束那一栏')

    // `--against`：两份协议值各装一次，印第一处不同落在第几个字节（架构 § 20 S6 的"可做协议 A/B"）。
    const ab = spawnSync(process.execPath, [CLI, '--root', root, '--json', 'assemble', 'subagent', '--against', 'holder'], { encoding: 'utf8' })
    assert.equal(ab.status, 0, ab.stderr)
    const got = JSON.parse(ab.stdout) as Record<string, unknown>
    const div = got['firstDivergence'] as { against: string; at: number; note: string }
    assert.equal(div.against, 'holder')
    assert.ok(Number.isInteger(div.at) && div.at > 0, `第一处不同报的不是一个位置：${JSON.stringify(div)}`)

    // 程序里算同一对数：两份协议的 A 区逐字节相同，所以 A 区的哈希两行相等；
    // 第一处不同落在 A 区之后（B 区那一段差别处）。
    const st = stateWithState(emptyState(), readConfigOf(root), root)
    const sub = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, st, WHO) })
    const holder = assemble({ protocol: HOLDER_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(HOLDER_PROTOCOL, st, null) })
    assert.equal(hashOf(sub.zoneA), hashOf(holder.zoneA))
    assert.equal(firstDivergence(sub.zoneA, holder.zoneA), -1, '两份协议的 A 区不逐字节相同')
    assert.equal(div.at, sub.zoneA.length + sharedPrefixLen(sub.zoneB, holder.zoneB), '命令行报的位置与程序里算的不同')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('④ 负对照：把 hostname 那一条检查短路 → ① 少一处、当场红', () => {
  const segs = brokenSegments()
  const full = checkConstraints(SUBAGENT_PROTOCOL, segs)
  // 短路的那一版：`envFacts()` 给一个空宿主名（等于"那一条检查不算数"）。
  const shorted = checkConstraints(SUBAGENT_PROTOCOL, segs, null, '这一步', { hostname: '', pid: -1 })
  const count = (vs: { kind: string }[], k: string): number => vs.filter((v) => v.kind === k).length
  assert.ok(count(full, 'env') > 0, '满配那一版本来就没报出宿主名——负对照是空的')
  assert.equal(count(shorted, 'env'), 0, '短路之后还报得出宿主名')
  assert.ok(full.length > shorted.length, '短路之后条数没少')
  // 另外三条不受影响：短路的只是第三条。
  for (const k of ['materialized', 'signal'] as const) {
    assert.equal(count(full, k), count(shorted, k), `短路第三条时 ${k} 那一条跟着变了`)
  }
  assert.equal(CONSTRAINT_KINDS.length, 4)
})

test('⑤ 正对照：一份干净的输入四条一处都不报', () => {
  const clean = checkConstraints(SUBAGENT_PROTOCOL, cleanSegments())
  assert.deepEqual(clean, [], `干净的输入报了违反：${clean.map(formatViolation).join(' | ')}`)
  // 而每一类都能被那一份坏输入触发（否则 ① 那四处可能只是"什么都报"）——逐类验一遍。
  const one = (over: Record<string, SegmentValue>): string[] =>
    checkConstraints(SUBAGENT_PROTOCOL, { ...cleanSegments(), ...over }).map((v) => v.kind)
  assert.deepEqual(one({ 系统状态: { root: '/home/fugue/work' } }), ['materialized'])
  assert.deepEqual(one({ 项目方针: `方针 ${envFacts().hostname}` }), ['env'])
  assert.deepEqual(one({ 信号摘要: ['{"kind":"done","digest":"原文"}'] }), ['signal'])
  // 三样同时来，就报三处。
  assert.equal(one({ 系统状态: { root: '/home/fugue/work', host: envFacts().hostname } }).length, 2)
})

/** 一个临时工作区根：项目方针 · 配置 · 一个提交 · 一条 agent 分支（`--agent` 那一栏要它存在）。 */
function fixtureRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `fugue-z6-${tag}-`))
  const seed = join(root, '外头的一份.txt')
  writeFileSync(join(root, 'AGENTS.md'), '# 项目方针\n\n- 一条方针。\n')
  writeFileSync(seed, 'seed\n')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  writeFileSync(join(root, '.fugue', 'config'), JSON.stringify({ platform: 'linux', workspace: 'fugue', config: { net: 'none' } }))
  const cli = (...args: string[]): void => {
    const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, `fixture 那一步没跑成（${args.join(' ')}）：${r.stderr}`)
  }
  run('git', ['init', '-q'], root)
  cli('write', 'seed.txt', '--from', seed)
  cli('commit', '-m', '起点')
  cli('branch', 'main', '--agent', 'agent-2')
  return root
}

/** 跑一条外部命令（fixture 建仓库用）。 */
function run(cmd: string, args: readonly string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')} 没跑成：${r.stderr}`)
}

/** 那份配置（与 `readConfig` 同一个形状）。 */
function readConfigOf(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.fugue', 'config'), 'utf8')) as Record<string, unknown>
}

/** 两个字节串从头起相同的长度。 */
function sharedPrefixLen(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}
