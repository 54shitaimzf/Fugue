// Z5 的断言（PLAN § 5.6 的 Z5 行 · 架构 § 8.11 的 A 区表那两行 · 架构 § 15.3.a · § 9.9）。
//
//   ① **改一处配置 → `hash(zoneA)` 变；改回 → 变回原值**：系统状态那一段是 A 区的第二个段源，
//      它跟着配置走
//   ② **四个不同 agent 在同一份配置下，系统状态那一段逐字节相同**——A 区的全等取决于源的输出，
//      不取决于读它的那个 agent。这是 PLAN 记在疑点清单里的那一处：Z1 那对相等读数在 Z1 是
//      恒等式，真正的跨 agent 语义在这里
//   ③ **`AGENTS.md` 改一个字节 → `hash(zoneA)` 变**（架构 § 9.9：人编辑的那一份在真实工作树
//      里，不在视图里）
//   ④ **红负对照**：把系统状态的段值改成「从宿主路径生成」（把 `<realRoot>` 拼进去）→ ② 那一
//      条量的是「不取决于 agent」，而这一档量的是另一头：**宿主的坐标也不许进去**——同一份配置
//      在两个宿主根下装配出来的 A 区必须相同，否则拿这一份前缀去比两个工作区就是在比路径
//   ⑤ **投影不是原文**：能力各占一栏（P3b2 拍平：`entries` 信封与 `net` 双投删掉）· 两串清单
//      按 name 排序且与声明次序无关 · 绑定的 env 值不进前缀（负对照）· 配置里加一栏与这一步
//      无关的东西，不进这一份
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BUILTIN_CATALOG, defaultModelOf } from '../model/catalog.ts'

/** 装配只要一个模型键：内置档第一条当那一格的输入（P2d 起目录是数据）。 */
const DEFAULT_MODEL = { id: defaultModelOf(BUILTIN_CATALOG).id }
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from './protocol.ts'
import { assemble, hashOf } from './assemble.ts'
import { stableStringify } from './render.ts'
import type { AgentCoord } from './sources.ts'
import { emptyState, readPolicy, sourcesFor } from './sources.ts'
import { projectConfig, stateWithState, systemForEachAgent, systemSegment } from './sources-state.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 一份像样的配置：五栏能力 + 动作与工具链两串清单 + 一栏与这一步无关的东西（⑤ 用它量「投影不是原文」）。 */
const CONFIG = {
  platform: 'linux',
  workspace: 'fugue',
  config: { net: 'none' },
  // `fugue config set ports.range …` 写出来的是嵌套那一份（`setConfig` 按 `.` 分层），照它写。
  ports: { range: '31000-31099' },
  docs: [{ path: 'ARCHITECTURE.md', prompt: '这一版是什么' }],
  actions: {
    build: { argv: ['make', 'build'], outputs: ['dist/'], env: { TOKEN: '不该出现的值' } },
    check: { argv: ['node', '--check', 'src/app.js'] },
  },
  toolchain: {
    node: { probe: ['node', '--version'], doc: '跑 JS 那一个', reading: { probe: ['node', '--version'], value: 'v24.21.0' } },
  },
  与这一步无关: { 随便: '什么' },
}

const AGENTS: readonly AgentCoord[] = ['agent-1', 'agent-2', 'agent-3', 'holder'].map((id) => ({
  id,
  branch: `agent/r1/${id}`,
  outputPaths: [`deliver/${id}/out.md`],
}))

/** 装配一次：把这两段接上，走真协议真组装器。 */
function assembleA(config: Record<string, unknown>, realRoot: string, who: AgentCoord | null) {
  const st = stateWithState({ ...emptyState(), goal: '把这一站做完。' }, config, realRoot)
  const segs = sourcesFor(SUBAGENT_PROTOCOL, st, who)
  const p = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: segs })
  return { st, segs, p, a: hashOf(p.zoneA) }
}

test('① 改一处配置 → hash(zoneA) 变，改回 → 变回原值', () => {
  const root = fixtureRoot('cfg')
  try {
    const before = assembleA(CONFIG, root, AGENTS[0] as AgentCoord).a
    const changed = assembleA({ ...CONFIG, config: { net: 'host' } }, root, AGENTS[0] as AgentCoord).a
    const back = assembleA(CONFIG, root, AGENTS[0] as AgentCoord).a
    assert.notEqual(changed, before, '改了 config.net，A 区的哈希没变——系统状态没有跟着配置走')
    assert.equal(back, before, '改回原值之后 A 区的哈希没回到原值')

    // 加一栏**只在这一份投影里**出现的东西（`workspace`）也要变——它就在那三栏里。
    const ws = assembleA({ ...CONFIG, workspace: '别的' }, root, AGENTS[0] as AgentCoord).a
    assert.notEqual(ws, before)
    // 而加一栏与这一步无关的配置**不变**：投影不是原文（⑤ 那一句的正对照）。
    const unrelated = assembleA({ ...CONFIG, 又一样无关的: 42 }, root, AGENTS[0] as AgentCoord).a
    assert.equal(unrelated, before, '配置里加了一栏没人读的东西，A 区不该变')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② 四个不同 agent 在同一份配置下：系统状态那一段逐字节相同', () => {
  const root = fixtureRoot('agents')
  try {
    const rendered = AGENTS.map((who) => JSON.stringify(assembleA(CONFIG, root, who).segs['系统状态']))
    assert.equal(new Set(rendered).size, 1, '四个 agent 拿到的系统状态不一样')
    assert.equal(rendered.length, 4)
    assert.equal(new Set(systemForEachAgent(CONFIG, AGENTS)).size, 1, '按坐标逐个取，系统状态也不该变')

    // A 区整段：四个 agent 的四份全等——**而这一条今天不是恒等式**，因为 B 区那几段逐 agent 不同。
    const aHashes = AGENTS.map((who) => assembleA(CONFIG, root, who).a)
    assert.equal(new Set(aHashes).size, 1, `四个 agent 的 A 区不都相等：${aHashes.join(' · ')}`)
    const bHashes = AGENTS.map((who) => {
      const { p } = assembleA(CONFIG, root, who)
      return hashOf(p.zoneB)
    })
    assert.equal(new Set(bHashes).size, 4, 'B 区逐 agent 不同——这一条不成立的话，上面那句全等是空的')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('③ AGENTS.md 改一个字节 → hash(zoneA) 变（Z0 那一对读数就是这条断言的基线）', () => {
  const root = fixtureRoot('policy')
  try {
    const before = assembleA(CONFIG, root, AGENTS[0] as AgentCoord).a
    const file = join(root, 'AGENTS.md')
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, `${text}- 多一行。\n`)
    const after = assembleA(CONFIG, root, AGENTS[0] as AgentCoord).a
    assert.notEqual(after, before, 'AGENTS.md 改了，A 区的哈希没变')
    // 它读的就是那个文件：字节数对得上（架构 § 9.9 的位置即纪律）。
    assert.equal(readPolicy(root), readFileSync(file, 'utf8'))
    // 文件不在 → 空串，装配照跑（地板那一档：那一段短了，不是跑不起来）。
    rmSync(file)
    const gone = assembleA(CONFIG, root, AGENTS[0] as AgentCoord)
    assert.equal(gone.segs['项目方针'], '', '文件不在时那一段应当是空串')
    assert.ok(gone.a.length === 16, '项目方针缺源时 A 区照样出得来哈希')
    assert.notEqual(gone.a, before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('④ 红负对照：把宿主路径拼进系统状态 → 同一份配置在两个根下 A 区不同', () => {
  const rootA = fixtureRoot('hostA')
  const rootB = fixtureRoot('hostB')
  try {
    // 正对照：真的源与宿主根无关——两个根下装配出来的 A 区逐字节相同。
    const goodA = assembleA(CONFIG, rootA, AGENTS[0] as AgentCoord).a
    const goodB = assembleA(CONFIG, rootB, AGENTS[0] as AgentCoord).a
    assert.equal(goodA, goodB, '两个根下 A 区不同——那说明有宿主坐标漏进了 A 区')

    // 负对照：把 `<realRoot>` 拼进系统状态那一段（架构 § 8.11 的约束 2 与 3 要拦下的写法）。
    const withRoot = (root: string): Record<string, unknown> => ({
      ...(systemSegment(CONFIG) as unknown as Record<string, unknown>),
      realRoot: root,
    })
    const bad = (root: string): string => {
      const st = { ...emptyState(), goal: '把这一站做完。', system: withRoot(root) as never, policy: readPolicy(root) }
      const segs = sourcesFor(SUBAGENT_PROTOCOL, st, AGENTS[0] as AgentCoord)
      return hashOf(assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: segs }).zoneA)
    }
    assert.notEqual(bad(rootA), bad(rootB), '宿主路径进了系统状态，两个根下的哈希居然还相同——负对照是空的')
    assert.notEqual(bad(rootA), goodA, '带宿主路径那一版与原版的哈希相同——那一版没有被拦住')
    // 而它在**同一个根下**仍然是逐 agent 相同的：这一档量的是宿主坐标，不是 agent 坐标。
    assert.equal(new Set(AGENTS.map(() => bad(rootA))).size, 1)
  } finally {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})

test('⑤ 投影不是原文：能力各一栏 · 清单按 name 排序 · 绑定的 env 值不进前缀', () => {
  const sys = projectConfig(CONFIG)
  const keys = Object.keys(sys)
  // **只比集合不比插入序**：对象的键序进不了前缀——渲染那一步（`stableStringify`）会把键排好，
  // 所以这里钉"哪几栏在了"，字节那一半钉在下面渲染相等的两条里。
  assert.deepEqual(
    [...keys].sort(),
    ['actions', 'docs', 'net', 'platform', 'ports', 'toolchain', 'workspace'],
    `该进的栏没全进（投影不是原文，只列有人消费的那几栏）：${keys.join(' · ')}`,
  )
  assert.ok(!keys.includes('与这一步无关'), '与这一步无关的配置进了投影')
  // **负对照：绑定的 env 值不投影**——凭据与配置值走引用不走来，进了这一栏就同时进夹具与日志。
  const rendered = JSON.stringify(sys)
  assert.ok(!rendered.includes('TOKEN') && !rendered.includes('不该出现的值'), `绑定的 env 值进了投影：${rendered}`)
  // 动作清单：name 排序 · argv 原样 · outputs 带上 · doc/outputs 可缺（check 那条就没有）。
  assert.deepEqual(sys.actions, [
    { name: 'build', argv: ['make', 'build'], outputs: ['dist/'] },
    { name: 'check', argv: ['node', '--check', 'src/app.js'] },
  ], '动作清单该是 name 排序、env 不投影、可缺的栏不出现')
  // 工具链：声明照抄，读数只在出自当前这条 probe 时带上。
  assert.deepEqual(sys.toolchain, [
    { name: 'node', probe: ['node', '--version'], doc: '跑 JS 那一个', reading: 'v24.21.0' },
  ], '工具链该带声明与当前 probe 的读数')
  // **与声明次序无关**：整份配置的键倒过来写（连 actions 里的两条也是），进前缀的那份字节不变
  // ——对象的键序由渲染器排（`stableStringify`），数组的次序序列化保不住、排序自己给（上面那
  // 两条 deepEqual 钉的就是那一半）。
  const revEntries = Object.entries(CONFIG).reverse().map(([k, v]) => [
    k,
    k === 'actions'
      ? { check: (CONFIG.actions as Record<string, unknown>).check, build: (CONFIG.actions as Record<string, unknown>).build }
      : v,
  ])
  const reversed = projectConfig(Object.fromEntries(revEntries) as never)
  assert.equal(stableStringify(reversed), stableStringify(sys), '声明次序不该影响投影字节')
  // **旧读数不带出去**：probe 换了的那份缓存是另一条命令的读数，带出去就是谎。
  const stale = projectToolchainOfStale()
  assert.ok(!JSON.stringify(stale).includes('v99.99.99'), `换了 probe 的旧读数进了投影：${JSON.stringify(stale)}`)
  // 值原样：不是字符串化的，也不是求过哈希的（`docs` 是一串对象，原样带过去）。
  assert.deepEqual(sys.docs, CONFIG.docs)
  assert.equal(sys.platform, 'linux')
  assert.equal(sys.workspace, 'fugue')
  assert.equal(sys.net, 'none')
  assert.equal(sys.ports, '31000-31099')
  // 两处入口同一份值：`systemSegment` 就是 `projectConfig`（同一个函数，没有第二条路）。
  assert.deepEqual(systemSegment(CONFIG), sys)
  // 持轮者那一份协议也用同一份系统状态（A 区是两份协议唯一相交的地方）。
  const st = { ...emptyState(), system: systemSegment(CONFIG) }
  const sub = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, st, AGENTS[0] as AgentCoord) })
  const holder = assemble({ protocol: HOLDER_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(HOLDER_PROTOCOL, st, null) })
  assert.deepEqual(sub.zoneA, holder.zoneA)
})

/** ⑤ 的旧读数负对照：声明换了 probe，缓存里那份读数还是旧命令的。 */
function projectToolchainOfStale(): unknown {
  return projectConfig({
    ...CONFIG,
    toolchain: { node: { probe: ['node', '-v'], reading: { probe: ['node', '--version'], value: 'v99.99.99' } } },
  } as never)
}

/** 一个临时工作区根：里面有一份 AGENTS.md，给这两段当输入。 */
function fixtureRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `fugue-z5-${tag}-`))
  writeFileSync(join(root, 'AGENTS.md'), '# 项目方针\n\n- 测试用的一份。\n')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  return root
}

test('⑥ 地板那一档：配置里一栏都没有时，系统状态投影成空对象，A 区照样装得出', () => {
  const root = fixtureRoot('empty')
  try {
    // ① 段值里一个 undefined 都没有：有的话 `json` 渲染器会抛（那是"跑不起来"，不是地板）。
    const sys = projectConfig({}) as Record<string, unknown>
    assert.deepEqual(Object.values(sys).filter((v) => v === undefined), [], '空配置投影出了 undefined')
    assert.deepEqual(Object.keys(sys), [], '空配置下一个栏都不该有')

    // ② 装配照跑，而且没有把字面量 `undefined` 拼进前缀。负对照：真把 undefined 拼进去过。
    const { segs, a } = assembleA({}, root, AGENTS[0] as AgentCoord)
    assert.ok(a.length === 16, '空配置下 A 区照样出得来哈希')
    const rendered = JSON.stringify(segs['系统状态'])
    assert.ok(!rendered.includes('undefined'), `系统状态里出现了字面量 undefined：${rendered}`)
    assert.equal(rendered, '{}', `空配置下那一段就是一个空对象：${rendered}`)

    // ③ 空配置与配全了的 A 区**不同**：这两条读数不是同一个值（否则上面那条是恒等式）。
    assert.notEqual(a, assembleA(CONFIG, root, AGENTS[0] as AgentCoord).a, '空配置与配全了的 A 区居然相同')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
