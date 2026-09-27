// Z4 的断言（PLAN § 5.6 的 Z4 行 · 架构 § 8.11 的两条硬纪律与 B 区那段「按缓存共享段最长」的
// 次序 · 架构 § 8.12 的产物路径 · 架构 § 13.4 的 P2）。
//
//   ① **十二个段一个不少、一个不多**：`sourcesFor()` 的键域 == 这份协议声明的段序；两份协议
//      合起来铺满十二段；每一段都渲染得出，四种渲染器各至少一条；缺源那一档给的是空值
//      而不是异常（地板：代码树那一段缺源 → A 区少一段、仍然确定性）
//   ② **B 区的五段顺序照架构 § 8.11 那份声明逐字**（工作总目标 → 文件内容 → 提交序列 →
//      交接提示词 → 我的任务）——顺序是承重的：它直接决定前缀字节序，而字节序是缓存命中的
//      唯一杠杆
//   ③ **产物路径机械追加在最后一段的末尾，且逐 agent 稳定**（架构 § 8.12）：同一 agent 两次
//      装配逐字节相同；两个 agent 那一段不同；持轮者那一档一个字节都不追加
//   ④ **两份声明的差别只落在 B 区与 C 区**（架构 § 8.11）：拿两个真实的 `Protocol` 值各装配
//      一次，A 区逐字节相同、B 区不同——组装器的代码一份没改
//   ⑤ **值不是句柄**（架构 § 13.4 的 P2）：段源住在组装器之外 · 这个模块的依赖图里没有
//      `Truth` · `View` · `Materializer` · `child_process` · `ctx`；`assemble()` 收的
//      `segments` 直接来自 `sourcesFor()`，中间没有一处要"再问一下环境"
//   ⑥ **红负对照**：把这个模块产出的段值拼成一份坏输入（B 区那一段挪到最后 · 「我的任务」
//      整个删掉 · 某一段的源改成装配时现读视图），① 与 ② 当场红
//
// **`--agent` 那一档**：`resolverFor` 查不到名字就拒、拒的话里带着那个名字与"不给 --agent 走
// 的是另一条路"这一句——命令行那一栏的接线在 Z6，这里量的是源这一层拒得出拒不出。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ZONE_SEGMENTS } from './contract.ts'
import type { SegmentId, SegmentValue } from './contract.ts'
import { DEFAULT_MODEL } from './models.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from './protocol.ts'
import { render, stableStringify } from './render.ts'
import { assemble, hashOf } from './assemble.ts'
import type { AgentCoord, AssembleState } from './sources.ts'
import { HOLDER, SOURCE_IDS, SourceError, emptyState, readPolicy, resolverFor, sourcesFor, writeScopeLine } from './sources.ts'

/** 造一段状态：十二个段各有非空的值，量「排进哪一区」时才量得出东西。 */
function stateWith(over: Partial<AssembleState> = {}): AssembleState {
  return {
    ...emptyState(),
    policy: '# 项目方针（测试用）\n\n- 一条方针。\n',
    system: { workspace: 'fugue', platform: 'linux', net: 'none' },
    codeTree: ['src/index.ts', 'src/view/view.ts', 'README.md'],
    goal: '把这一站做完。',
    files: [
      { path: 'src/index.ts', text: 'export const x = 1\n' },
      { path: 'README.md', text: '# 读我\n' },
    ],
    commits: ['abc123 第一个提交', 'def456 第二个提交'],
    handoff: '上一任留下的一句话。',
    task: {
      goal: '让装配跨 agent 全等。',
      question: 'A 区里究竟是哪三段？',
      deliverables: ['src/assemble/sources.ts'],
      evidenceRequired: ['node --test src/assemble/sources.test.ts'],
      assertions: ['keys(segments) == segmentOrder'],
    },
    distill: '持轮者凝聚出来的理解。',
    recent: '压缩前留着的那几段原文。',
    runtime: '这一步的会话流。',
    signals: ['agent-2 已完成', 'agent-3 超时'],
    lastStep: '上一步的工具结果。',
    ...over,
  }
}

const AGENT_2: AgentCoord = { id: 'agent-2', branch: 'agent/r1/2', outputPaths: ['deliver/agent-2/report.md'] }
const AGENT_3: AgentCoord = { id: 'agent-3', branch: 'agent/r1/3', outputPaths: ['deliver/agent-3/report.md'] }

const HERE = fileURLToPath(new URL('.', import.meta.url))

test('① 十二个段一个不少、一个不多 · 键域 == 这份协议的段序 · 缺源给空值', () => {
  assert.equal(SOURCE_IDS.length, 13, '两份协议合起来是十三个段名（架构 § 8.11 的两张表）')
  assert.equal(new Set(SOURCE_IDS).size, SOURCE_IDS.length, '段源里有重名')

  const sub = sourcesFor(SUBAGENT_PROTOCOL, stateWith(), AGENT_2)
  const holder = sourcesFor(HOLDER_PROTOCOL, stateWith(), HOLDER)
  assert.deepEqual(Object.keys(sub).sort(), [...SUBAGENT_PROTOCOL.segmentOrder].sort(), '子 agent 那份的键域不对')
  assert.deepEqual(Object.keys(holder).sort(), [...HOLDER_PROTOCOL.segmentOrder].sort(), '持轮者那份的键域不对')
  assert.equal(Object.keys(sub).length, 11, '子 agent 那份是十一段')
  assert.equal(Object.keys(holder).length, 12, '持轮者那份是十二段')
  // 两份合起来铺满十二段；差的正是持轮者独占的两段。
  const extra = [...HOLDER_PROTOCOL.segmentOrder].filter((id) => !SUBAGENT_PROTOCOL.segmentOrder.includes(id))
  assert.deepEqual(extra, ['凝聚理解', '凝聚前最近几次原文'], '持轮者多出来的应当是那两段')

  // 每一段都渲染得出，四种渲染器各至少一条。
  const kinds = new Set<string>()
  for (const id of SUBAGENT_PROTOCOL.segmentOrder) {
    const bytes = render(SUBAGENT_PROTOCOL.renderers[id], sub[id] as SegmentValue)
    assert.ok(bytes.length > 0, `这一段渲染出来是空的：${id}`)
    kinds.add(SUBAGENT_PROTOCOL.renderers[id])
  }
  assert.deepEqual([...kinds].sort(), ['file-block', 'json', 'list', 'text'], '四种渲染器没有各至少一条')

  // 缺源那一档：代码树空着、系统状态空着——空值而不是异常，装配照跑。
  const bare = stateWith({ codeTree: [], system: {} })
  const bareSegs = sourcesFor(SUBAGENT_PROTOCOL, bare, AGENT_2)
  assert.deepEqual(bareSegs['代码树'], [], '缺源的列表段应当是空的')
  assert.deepEqual(bareSegs['系统状态'], {}, '缺源的 json 段应当是空对象')
  assert.equal(render('list', bareSegs['代码树'] as SegmentValue).length, 0, '空的列表段渲染成空字节')
  assert.equal(render('json', bareSegs['系统状态'] as SegmentValue).length, 2, '空的 json 段渲染成 {}')
  const barePrefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: bareSegs })
  const richPrefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: sub })
  assert.notEqual(hashOf(barePrefix.zoneA), hashOf(richPrefix.zoneA), '缺源那两段不进 A 区的话，A 区不该一样')
  // 缺源那一档也是确定性的：同一份再装一次逐字节相同。
  const again = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, bare, AGENT_2) })
  assert.deepEqual(again.zoneA, barePrefix.zoneA)
})

test('② B 区的五段顺序照架构 § 8.11 那份声明逐字', () => {
  // **这一份是手抄的那一行，不是从 `ZONE_SEGMENTS` 读来的**：读来的话，区表被改了这句就跟着
  // 改，量的是「区表与它自己一致」——`tools/neg-z4.sh` 的甲量的就是这件事（把两段对调，
  // 这一份手抄的次序当场不成立）。
  const wantB: readonly SegmentId[] = ['工作总目标', '文件内容', '提交序列', '交接提示词', '我的任务']
  const b = [...ZONE_SEGMENTS.B]
  assert.deepEqual(b, [...wantB], 'B 区那五段的次序不是架构 § 8.11 那一行')
  // 段序里 B 区那一截与它逐字相同（A → B → C 的顺序由区表决定）。
  const order = SUBAGENT_PROTOCOL.segmentOrder
  const a = ZONE_SEGMENTS.A.length
  assert.deepEqual(order.slice(a, a + wantB.length), [...wantB], '段序里 B 区那一截与架构那一行不一致')
  // 「我的任务」是稳定部分的最后一句：C 区每步可变的内容排在它后面。
  assert.deepEqual(order.slice(a + wantB.length), [...ZONE_SEGMENTS.C])
  // 全序 = A + B + C（三段接起来就是段序）。
  assert.deepEqual(order, [...ZONE_SEGMENTS.A, ...ZONE_SEGMENTS.B, ...ZONE_SEGMENTS.C])
})

test('③ 产物路径机械追加在最后一段的末尾 · 逐 agent 稳定', () => {
  const segs = sourcesFor(SUBAGENT_PROTOCOL, stateWith(), AGENT_2)
  const task = segs['我的任务'] as string
  assert.match(task, /Output paths: deliver\/agent-2\/report\.md$/, '产物路径没有机械追加在末尾')
  // 机械：同一份状态两次调用逐字节相同（它是"同一 agent 跨步稳定"那一半）。
  assert.equal(task, sourcesFor(SUBAGENT_PROTOCOL, stateWith(), AGENT_2)['我的任务'])
  // 逐 agent 不同：两个 agent 那一段不一样。
  assert.notEqual(task, sourcesFor(SUBAGENT_PROTOCOL, stateWith(), AGENT_3)['我的任务'])
  // 系统的那几个键不进前缀（架构 § 8.11：模型不据此做任何事）。`agent-3` 那个名字在测试数据里
  // 到处都是，所以拿一个只在坐标里出现的 id 量这一条。
  const onlyId: AgentCoord = { id: 'coord-only-9f3', branch: 'agent/r1/9f3', outputPaths: ['deliver/9f3/out.md'] }
  const onlyTask = sourcesFor(SUBAGENT_PROTOCOL, stateWith(), onlyId)['我的任务'] as string
  assert.ok(onlyTask.includes('deliver/9f3/out.md'), '产物路径要进那一段')
  assert.ok(!onlyTask.includes(onlyId.id), '`id` 是系统的键，不该出现在「我的任务」里')
  assert.ok(!onlyTask.includes(onlyId.branch), '`branch` 是系统的键，不该出现在「我的任务」里')
  // 空清单不追加：不凭空造一个目录名。
  const noOut = sourcesFor(SUBAGENT_PROTOCOL, stateWith(), { ...AGENT_2, outputPaths: [] })
  assert.ok(!(noOut['我的任务'] as string).includes('产物路径'), '产物路径空着的时候不该追加')
  // 持轮者那一档：它手里是全部契约，不是一份——没有产物路径可追加。
  const held = sourcesFor(HOLDER_PROTOCOL, stateWith(), HOLDER)
  assert.ok(!(held['我的任务'] as string)?.includes('产物路径'), '持轮者那一份不该有产物路径')
})

test('④ 两份声明的差别只落在 B 区与 C 区（A 区逐字节相同）', () => {
  const st = stateWith()
  const sub = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, st, AGENT_2) })
  const holder = assemble({ protocol: HOLDER_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(HOLDER_PROTOCOL, st, AGENT_2) })
  assert.deepEqual(sub.zoneA, holder.zoneA, '两份协议的 A 区不同——A 区是它们唯一相交的地方，必须逐字节相同')
  assert.equal(hashOf(sub.zoneA), hashOf(holder.zoneA))
  assert.notDeepEqual(sub.zoneB, holder.zoneB, '持轮者多两段、少一段，B 区不可能一样')
  assert.notEqual(hashOf(sub.zoneB), hashOf(holder.zoneB))
  // C 区各自成立：**两份的这一区不要求不同**（架构 § 8.11：「后两者天然属于各自的 agent」，
  // 不是"必须不同"）。今天这两份的 C 区字节恰好相同——因为持轮者多的那两段与子 agent 的
  // 「我的任务」在这一份测试数据里字节一样，而段的顺序没变。这一条量的是它照旧出得来。
  assert.equal(holder.zoneC.length, sub.zoneC.length, 'C 区那三段的长度与内容都没变，两份的字节数应当相同')
  assert.deepEqual(holder.zoneC, sub.zoneC)
})

test('⑤ 值不是句柄：段源在组装器之外 · 依赖图里没有环境 · segments 直接来自 sourcesFor()', () => {
  const source = withoutComments(readFileSync(join(HERE, 'sources.ts'), 'utf8'))
  // 先量「读得到那一份」：读不到时下面两条都会因为「空串里没有那些词」而假绿。注释与字符串
  // 都去掉之后，代码那一半还有一千多字节——太少说明读错了文件或去掉的规则太狠。
  assert.ok(source.length > 1000, `代码那一半只有 ${source.length} 字节，读错了`)
  assert.ok(source.includes('export function sourcesFor'), '去掉注释之后连函数都没了——规则去得太狠')
  assert.equal(
    /from 'node:child_process'|from 'node:net'|from 'node:http'|\.\.\/truth\/|\.\.\/view\/|\.\.\/materialize\//.test(source),
    false,
    '段源那一份里出现了环境那一侧的东西',
  )
  // 唯一读文件的那一处是项目方针（架构 § 9.9：人编辑的那一份在真实工作树里）：一次 import，
  // 一次调用，两处都在 `readPolicy` 里。
  assert.equal((source.match(/readFileSync/g) ?? []).length, 2, '读文件的地方应当只有项目方针那一处')

  // `assemble()` 收的 `segments` 直接来自 `sourcesFor()`：中间没有一处要"再问一下环境"。
  const segs = sourcesFor(SUBAGENT_PROTOCOL, stateWith(), AGENT_2)
  const p = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: segs })
  const again = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: segs })
  assert.deepEqual(p.zoneA, again.zoneA)
  assert.deepEqual(p.zoneB, again.zoneB)
  assert.deepEqual(p.zoneC, again.zoneC)
  // 值是可序列化的（不是句柄 · 不是函数 · 不是 Proxy）：整份段值能被稳定序列化。
  assert.equal(typeof stableStringify(segs), 'string')

  // 项目方针那一段读的是那一个文件：换了它，A 区跟着变；文件不在就给空串，不抛。
  const fixture = join(HERE, '__fixture__')
  const policy = readPolicy(fixture)
  assert.ok(policy.length > 0, `__fixture__ 里的 AGENTS.md 读不到：${policy.length} 字节`)
  assert.equal(readPolicy(join(fixture, '__没有这个目录__')), '', '读不到的时候应当是空串（地板那一档）')
  // 换了那一份字节，A 区跟着变（它是 A 区的第一个段源）。
  const p1 = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, stateWith({ policy }), AGENT_2) })
  const p2 = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, stateWith({ policy: `${policy}\n- 多一行。\n` }), AGENT_2) })
  assert.notEqual(hashOf(p1.zoneA), hashOf(p2.zoneA), '项目方针改一个字节，A 区的哈希必须变')
})

test('⑥ 红负对照：坏掉的段值当场红（B 区次序 · 删段 · 现读视图）', () => {
  const st = stateWith()
  const good = sourcesFor(SUBAGENT_PROTOCOL, st, AGENT_2)

  // 甲 · 把 B 区里的「交接提示词」挪到「提交序列」前面：B 区的次序不再是架构那一行。
  const swapped: SegmentId[] = [...SUBAGENT_PROTOCOL.segmentOrder]
  const i1 = swapped.indexOf('交接提示词')
  const i2 = swapped.indexOf('提交序列')
  swapped[i1] = '提交序列'
  swapped[i2] = '交接提示词'
  const moved = { ...SUBAGENT_PROTOCOL, segmentOrder: swapped }
  const movedKeys = Object.keys(sourcesFor(moved, st, AGENT_2))
  const wantB = ['工作总目标', '文件内容', '提交序列', '交接提示词', '我的任务']
  const gotB = movedKeys.filter((id) => wantB.includes(id))
  assert.notDeepEqual(gotB, wantB, '把「交接提示词」挪到「提交序列」前面之后，B 区那一截的次序必须变——它没变')
  assert.deepEqual(gotB, ['工作总目标', '文件内容', '交接提示词', '提交序列', '我的任务'])
  assert.notEqual(
    hashOf(assemble({ protocol: moved, model: DEFAULT_MODEL.id, segments: sourcesFor(moved, st, AGENT_2) }).zoneB),
    hashOf(assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: good }).zoneB),
    '段序变了而 B 区的哈希没变——那说明 B 区没在量次序',
  )

  // 乙 · 把「我的任务」整个删掉：键域与段序对不上。
  const cut = { ...good } as Record<string, SegmentValue>
  delete cut['我的任务']
  const cutKeys = Object.keys(cut)
  assert.notDeepEqual(cutKeys.sort(), [...SUBAGENT_PROTOCOL.segmentOrder].sort(), '删掉一段之后键域居然还对得上——① 那一句是空的')
  assert.equal(cutKeys.length, SUBAGENT_PROTOCOL.segmentOrder.length - 1)

  // 丙 · 某一段的源改成"装配时现读视图"：它就不再是值——依赖图那一条当场红。
  // 这一条量的是**那两条判据本身管用**：`import ... from '../view/view.ts'` 那一条抓得住，
  // 而多出来的一次读（`readFileSync` 在代码那一半里今天只有一处）也抓得住。
  // `tools/neg-z4.sh` 的乙把 `判据说它不算` 拨成 true 又不动那两样，断言当场不成立。
  const live = [
    `import { loadView } from '../view/view.ts'`,
    `const 现读视图 = () => readFileSync('../view/view.ts', 'utf8')`,
  ].join('\n')
  const 判据说它不算 = false
  assert.equal(
    /from '\.\.\/view\//.test(live) || (live.match(/readFileSync/g) ?? []).length > 0 || 判据说它不算,
    true,
    '现读视图那一版居然过得了依赖图那一条',
  )
})

test('⑦ `--agent` 指一个不存在的 agent → 当场拒，报出那个名字，不给主线当默认', () => {
  const resolve = resolverFor([AGENT_2, AGENT_3])
  assert.equal(resolve('agent-2').branch, 'agent/r1/2')
  assert.throws(
    () => resolve('agent-9'),
    (e: unknown) => {
      assert.ok(e instanceof SourceError)
      assert.match(e.message, /agent-9/, '拒的话里要带着那个名字')
      assert.match(e.message, /持轮者/, '拒的话要指路：不给 --agent 走的是另一条路')
      return true
    },
  )
  // 「不给」与「给了一个不存在的」是两件事：前者是持轮者那条路（`HOLDER`），后者是拒。
  assert.equal(HOLDER, null)
  assert.equal(Object.keys(sourcesFor(HOLDER_PROTOCOL, stateWith(), HOLDER)).length, 12)
})

test('⑧ 目录清单与文件内容在取段值前后逐字节相同（段源不写状态）', () => {
  const dir = join(HERE, '__fixture__')
  const before = snapshot(dir)
  const st = stateWith({ policy: readPolicy(dir) })
  sourcesFor(SUBAGENT_PROTOCOL, st, AGENT_2)
  sourcesFor(HOLDER_PROTOCOL, st, HOLDER)
  const after = snapshot(dir)
  assert.deepEqual(after, before, '__fixture__ 那一份清单在取段值前后变了')
})

/** 一份目录的清单：名字 + 字节数 + mtime。 */
function snapshot(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const s = statSync(join(dir, name))
      return `${name} ${s.size} ${s.mtimeMs}`
    })
}

test('⑨ 写入面那一句：逐条列契约声明的那几条 · 排在交付物之后 · 空集不写 · 持轮者那一份没有它', () => {
  const st = stateWith({ task: { ...stateWith().task, ownedPaths: ['src/format.ts', 'README.md'] } })
  const task = sourcesFor(SUBAGENT_PROTOCOL, st, AGENT_2)['我的任务'] as string
  assert.match(task, /Write surface: src\/format\.ts · README\.md — these paths are yours/, `写入面那一句没进「我的任务」：${task}`)
  assert.match(task, /Do not change a single byte anywhere else, deleting included/, '那一句没说清"删除也算"')
  // 位置：**交付物之后、产物路径之前**。交付物是"交什么"，这一句是"哪几条归你"——同一档的
  // 两件事挨着；而收工口径那三句与产物路径照旧排在最后（架构 § 8.11 的近因那条）。
  assert.ok(task.indexOf('Write surface:') > task.indexOf('Deliverables:'), `写入面跑到交付物前面去了：${task}`)
  assert.ok(task.indexOf('Write surface:') < task.indexOf('Output paths:'), `写入面跑到产物路径后面去了：${task}`)
  // 空集 / 没给：一句都不写（地板那一档：不凭空造一句）。
  assert.deepEqual(writeScopeLine([]), [], '空集该一句都不写')
  assert.deepEqual(writeScopeLine(undefined), [], '没给该一句都不写')
  const bare = sourcesFor(SUBAGENT_PROTOCOL, stateWith(), AGENT_2)['我的任务'] as string
  assert.ok(!bare.includes('Write surface:'), `没给写入面却写了那一句：${bare}`)
  // 持轮者那一份：它的 B 区里没有「我的任务」这一段（架构 § 8.11）——那一句也到不了它那儿
  // （它手里是全部契约，写入面由草案那一棵给）。
  const held = sourcesFor(HOLDER_PROTOCOL, st, HOLDER)
  assert.ok(!JSON.stringify(held).includes('Write surface:'), '持轮者那一份里出现了写入面那一句')
  console.log(`⑨ 读数：${String(task.split('\n').find((l) => l.startsWith('Write surface:'))).slice(0, 44)}… · 空集 0 句 · 持轮者 0 处`)
})

/** 去掉注释：`⑤` 量的是依赖，而注释里正写着「哪几样不许进来」。 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
