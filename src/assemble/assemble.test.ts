// Z1 的断言（PLAN § 5.6 的 Z1 行 · 架构 § 20 S6 的第一条与第二条验证 · § 8.11 的验证性质 ·
// § 13.4 的 P1 · P2 · P3）。
//
//   ① **纯函数那一条**：装配不读不写状态——那份目录清单与文件内容在装配前后逐字节相同；
//      模块的依赖图里没有 `node:fs` 一类；`AssembleInput` 的签名里只有值，没有 `ctx` ·
//      `Truth` · `View` · `Materializer`
//   ② **跨 agent**：四个 agent 同一份状态各装配一次，A 区四份指纹全等（四个 agent 的差别
//      全在 B 区的段值里），而 `A+B` 四份互不相等——**并且 A 区里确实是那三段**。
//      这一条不这么钉住就量不出分区错：把 `文件内容` 也排进 A 区，四个 agent 的 A 区
//      照样全等（它们那一段本来就相同），② 于是照旧绿（`tools/neg-z1.sh` 的甲）
//   ③ **同一 agent 相邻两步**：`A+B` 相等、C 区变；`firstDivergence` 报出的偏移是**前
//      `|A|+|B|` 个字节逐字节相同之后的第一处**——所以它落在 C 区里，而不是恰好等于 `|A|+|B|`：
//      C 区自己也有几十个字节是两步共有的。这一条把「只动了 C 区」量化到底
//   ④ **红负对照**：把 `文件内容` 从 B 区挪进 A 区，A 区那一段字节就变了——**同一份段值、
//      同一份协议值，唯一的差别是分区**，所以 ② 里「A 区全等」这句话不是恒等式。
//      两半都要钉住：缺省分区那一边（A 区里是区表那三段 · `文件内容` 在 B 区）与负对照那
//      一边（`moved` 真的把 `文件内容` 排进了 A 区）。只钉一边时，一个恒等的负对照
//      （`moved` 与缺省分区是同一个函数）也能让这条变红，而缺省分区整体反掉时它反而绿
//
// **为什么 ④ 走 `assembleWith()` 而不是改协议值**：`assemble()` 的签名由接口冻结点定，测试
// 不改它；而「排进 A 区」这件事在实现里就是「分区把这一段归到 A」。两档出口共用同一条实现
// （`assemble()` 就是 `assembleWith()` 套缺省分区那一句），所以 ④ 量的是真机制，不是替身。
//
// **段值是打桩的**：真实段源在 Z4（`sources.ts`）。打桩值不空——空值会让「排进哪一区」这条
// 断言量不出东西。里面那几串 `MUST-NOT-LEAK` 是给 Z6 的检查器留的靶子（工作区根那条绝对
// 路径 · 宿主名 · Signal 原文的形状）。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { AssembleInput, Partition, Protocol, SegmentId, SegmentValue } from './contract.ts'
import { DEFAULT_PARTITION, HOLDER_B, ZONE_SEGMENTS, zoneSplit } from './contract.ts'
import { DEFAULT_MODEL } from './models.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from './protocol.ts'
import { render } from './render.ts'
import { assemble, assembleWith, firstDivergence, hashOf, readPrefix } from './assemble.ts'

/** 工作区根：只出现在靶子串里，不指向这台机器上任何一处真东西（S6 的探针也不在沙箱里）。 */
const WORKSPACE = '/home/fugue/work'
const HOST = 'MUST-NOT-LEAK-host'
const SRC = fileURLToPath(new URL('.', import.meta.url))

/** 四个 agent：它们的差别只落在 B 区的段值里（`我的任务` 那一段）。 */
const AGENTS = ['agent-1', 'agent-2', 'agent-3', 'agent-4'] as const

function base(alive: string): Record<SegmentId, SegmentValue> {
  return {
    项目方针: '# 项目方针（打桩）\n\n- 一条方针。\n',
    系统状态: { config: { materialize: 'overlayfs', net: 'none' }, platform: 'linux', workspace: 'fugue' },
    代码树: ['src/assemble/contract.ts', 'src/assemble/render.ts'],
    工作总目标: '把 S6 装配这一站走完：十二个段三个区，前缀字节可核算。\n',
    文件内容: [
      { path: 'src/assemble/contract.ts', text: '// M10 的契约。\n' },
      { path: 'src/assemble/render.ts', text: '// 渲染。\n' },
    ],
    提交序列: ['2ff3423 Z0 · 站前的第一版真实协议', '5fc73a7 校订 · 注释去修补感'],
    交接提示词: '（首任为空——打桩）',
    我的任务: `实现 Z1（${alive}）`,
    凝聚理解: '（持轮者独占那一段：打桩）',
    压缩前最近几次原文: '（持轮者独占那一段：打桩）',
    运行时上下文: '（积累段：只追加，打桩）',
    信号摘要: [`sig-1 · ${alive}`],
    上一步结果: `（上一步的工具结果：打桩 · ${WORKSPACE} · ${HOST}）`,
  }
}

/** 一步的段值。`alive` 是那个 agent 的轮内记号，真实现里它来自日志与视图（Z4）。 */
function stepOf(alive: string, turn = 1): Record<SegmentId, SegmentValue> {
  const s = base(alive)
  s.运行时上下文 = `（第 ${turn} 次调用之前的运行上下文：打桩）`
  s.信号摘要 = [`sig-${turn} · ${alive}`]
  s.上一步结果 = `（第 ${turn} 步的结果：打桩）`
  return s
}

/** 只改动几个键的那一份值。 */
function withValues(
  segments: Record<SegmentId, SegmentValue>,
  over: Partial<Record<SegmentId, SegmentValue>>,
): Record<SegmentId, SegmentValue> {
  return { ...segments, ...over }
}

function inputOf(protocol: Protocol, segments: Record<SegmentId, SegmentValue>): AssembleInput {
  return { protocol, model: DEFAULT_MODEL.id, segments }
}

/** 一段渲染出来多少字节（断 ④ 拿它算 B 区该少多少）。 */
function renderLen(id: SegmentId, segments: Record<SegmentId, SegmentValue>): number {
  return render(SUBAGENT_PROTOCOL.renderers[id], segments[id] as SegmentValue).length
}

/** 独立算一遍指纹：与 `hashOf` 对账，从而把「指纹的算法」这一点钉住（不是恒等式）。 */
const sha16 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

/** 一份目录清单：路径 → 「字节数 · 纳秒级 mtime」。装配碰过哪一处，这里的值就会变。 */
function inventory(root: string): string {
  const rows: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs, `${rel}${name}/`)
      else rows.push(`${rel}${name} ${String(st.size)} ${String(st.mtimeMs)}`)
    }
  }
  walk(root, '')
  return rows.join('\n')
}

/** 三区首尾相接的那一串（`A + B + C`，区与区之间不掺分隔符——分隔符属于渲染器）。 */
function wholeOf(p: { zoneA: Uint8Array; zoneB: Uint8Array; zoneC: Uint8Array }): Uint8Array {
  const out = new Uint8Array(p.zoneA.length + p.zoneB.length + p.zoneC.length)
  out.set(p.zoneA, 0)
  out.set(p.zoneB, p.zoneA.length)
  out.set(p.zoneC, p.zoneA.length + p.zoneB.length)
  return out
}

test('① 装配不读不写状态：目录清单、AGENTS.md、依赖图各看一次', () => {
  const fixture = join(SRC, '__fixture__')
  const before = inventory(fixture)
  const policy = readFileSync(join(fixture, 'AGENTS.md'))

  // 装配几次（顺带把 ② ③ 要的那几份也装出来——它们同样不该碰盘）
  const segs = stepOf(AGENTS[0])
  for (let n = 0; n < 3; n++) assemble(inputOf(SUBAGENT_PROTOCOL, segs))

  assert.equal(inventory(fixture), before, '装配之后那份目录清单变了')
  assert.deepEqual(readFileSync(join(fixture, 'AGENTS.md')), policy, '`AGENTS.md` 的字节变了')

  // 读源码的静态检查：装配这一层里出现 `node:fs` 一类，它就静默变成有副作用的东西
  const source = readFileSync(join(SRC, 'assemble.ts'), 'utf8')
  assert.doesNotMatch(source, /from 'node:(fs|child_process|net|http)/, '装配器 import 了会碰状态的模块')
  assert.doesNotMatch(source, /i\.model/, '装配器读了 model——模型的调用配置没有位置，不该进前缀')

  // 段值那一半：签名里只有值
  assert.equal(typeof segs.项目方针, 'string')
  assert.ok(Array.isArray(segs.文件内容))
  assert.equal((segs.文件内容 as readonly { path: string }[])[0]?.path, 'src/assemble/contract.ts')
})

test('② 跨 agent：A 区四份全等，A+B 四份互不相等', () => {
  const as = AGENTS.map((a) => {
    const p = assemble(inputOf(SUBAGENT_PROTOCOL, stepOf(a)))
    return { a, r: readPrefix(p) }
  })
  assert.equal(new Set(as.map(({ r }) => r.zoneA.hash)).size, 1, 'A 区的指纹不唯一')
  assert.equal(new Set(as.map(({ r }) => r.ab.hash)).size, AGENTS.length, 'A+B 那四份里有相等的')

  // A 区里是**哪三段**——「四份全等」这句话单独拿出来不是一条分区断言：把 `文件内容`
  // 也排进 A 区，四个 agent 的 A 区照样全等（它们那一段本来就相同）。这一条钉住分区本身。
  const split = zoneSplit(SUBAGENT_PROTOCOL.segmentOrder)
  assert.deepEqual(split.A, [...ZONE_SEGMENTS.A], 'A 区里的段不是区表那三段')
  assert.ok(!split.A.includes('文件内容'), '`文件内容` 排进了 A 区——A 区就不再是跨 agent 不变的那份前缀')
  assert.ok(split.B.includes('文件内容'), '`文件内容` 没排在 B 区里')
  assert.equal(
    split.A.length + split.B.length + split.C.length,
    SUBAGENT_PROTOCOL.segmentOrder.length,
    '分区把段弄丢或弄重了',
  )
  console.log(`  · A 区 ${as[0].r.zoneA.hash}（四份同一个）· A+B ${as.map(({ r }) => r.ab.hash).join(' ')}`)
  console.log(
    `  · 逐区字节：A ${String(as[0].r.zoneA.bytes)} · B ${String(as[0].r.zoneB.bytes)} · C ${String(as[0].r.zoneC.bytes)} · 整体 ${String(as[0].r.whole.bytes)}`,
  )
})

test('③ 同一 agent 相邻两步：A+B 不动、C 区变，偏移落在 C 区里', () => {
  const p1 = assemble(inputOf(SUBAGENT_PROTOCOL, stepOf(AGENTS[0], 1)))
  const p2 = assemble(inputOf(SUBAGENT_PROTOCOL, stepOf(AGENTS[0], 2)))
  const r1 = readPrefix(p1)
  const r2 = readPrefix(p2)

  assert.equal(r1.ab.hash, r2.ab.hash, 'A+B 变了')
  assert.notEqual(r1.zoneC.hash, r2.zoneC.hash, 'C 区没变')

  const a = wholeOf(p1)
  const b = wholeOf(p2)
  const abBytes = p1.zoneA.length + p1.zoneB.length
  const at = firstDivergence(a, b)
  assert.ok(abBytes > 0, 'A+B 是空的，这条断言量不出东西')
  assert.equal(firstDivergence(a, a), -1, '自己跟自己比竟然有不同')
  // 前 A+B 个字节逐字节相同——② 那条 A 区读数的量化版
  assert.equal(
    Buffer.compare(Buffer.from(a.subarray(0, abBytes)), Buffer.from(b.subarray(0, abBytes))),
    0,
    '前 A+B 个字节不相等',
  )
  // 变化落在 C 区里：偏移不少于 A+B，且落在这一串之内
  assert.ok(at >= abBytes, `偏移 ${String(at)} 落在 A+B 里（${String(abBytes)}）——那不是「只动 C 区」`)
  assert.ok(at < a.length, '两串一样长却报出了一处不同')
  // C 区内部：偏移之前逐字节相同、之后逐字节不同——这就是「第一个不同」的定义
  assert.deepEqual(a.subarray(0, at), b.subarray(0, at), '偏移之前就有字节不同')
  assert.notDeepEqual(a.subarray(at), b.subarray(at), '偏移之后竟然逐字节相同')
  console.log(
    `  · A+B ${r1.ab.hash} · C ${r1.zoneC.hash} → ${r2.zoneC.hash} · 第一个不同的字节在第 ${String(at)} 个（A+B 共 ${String(abBytes)} · C 区 ${String(p1.zoneC.length)} 字节）`,
  )
})

test('④ 红负对照：把「文件内容」挪进 A 区，A 区那一段字节当场变', () => {
  const segs = stepOf(AGENTS[0])
  const asIs: Partition = DEFAULT_PARTITION
  const moved: Partition = (id) => (id === '文件内容' ? 'A' : DEFAULT_PARTITION(id))
  const good = assembleWith(inputOf(SUBAGENT_PROTOCOL, segs), asIs)
  const bad = assembleWith(inputOf(SUBAGENT_PROTOCOL, segs), moved)

  // 缺省分区这一路要能被自己量到：不写下这三句，缺省分区整体反掉以后，
  // 「两档共用同一条实现」那句就退化成两边一起错、比出来仍然相等
  assert.deepEqual(zoneSplit(SUBAGENT_PROTOCOL.segmentOrder).A, [...ZONE_SEGMENTS.A], '缺省分区没把 A 区那三段排进 A 区')
  assert.equal(DEFAULT_PARTITION('文件内容'), 'B', '缺省分区把 `文件内容` 排出 B 区了')
  assert.equal(DEFAULT_PARTITION('上一步结果'), 'C', '缺省分区把 `上一步结果` 排出 C 区了')

  // 反过来的那一半：负对照那一档要**真的**不一样。只断言「换了分区之后字节变了」而不断言
  // 换法本身，一个恒等的负对照（`moved` 与缺省分区是同一个函数）也能让它变红。
  const asMoved = zoneSplit(SUBAGENT_PROTOCOL.segmentOrder, moved)
  assert.equal(asMoved.A.length, ZONE_SEGMENTS.A.length + 1, '负对照的分区没把多出来的那一段排进 A 区')
  assert.ok(asMoved.A.includes('文件内容'), '负对照的分区没把 `文件内容` 排进 A 区')
  assert.ok(!asMoved.B.includes('文件内容'), '负对照的分区把 `文件内容` 留在了 B 区')
  assert.ok(!DEFAULT_PARTITION('文件内容').startsWith('A'), '缺省分区与负对照那一档是同一个函数，这条断言量不出东西')

  assert.equal(bad.zoneB.length, good.zoneB.length - renderLen('文件内容', segs), 'B 区没有少掉那一段')
  assert.equal(bad.zoneA.length, good.zoneA.length + good.zoneB.length - bad.zoneB.length, 'A 区没有多出那一段')
  assert.equal(bad.zoneB.length, good.zoneB.length - renderLen('文件内容', segs), 'B 区没有少掉那一段')
  console.log(`  · A 区 ${hashOf(good.zoneA)} → ${hashOf(bad.zoneA)} · B 区 ${hashOf(good.zoneB)} → ${hashOf(bad.zoneB)}`)
  console.log(
    `  · 字节：A ${String(good.zoneA.length)} → ${String(bad.zoneA.length)} · B ${String(good.zoneB.length)} → ${String(bad.zoneB.length)}`,
  )
})

test('⑤ 两份声明共用一条代码：持轮者的 B 区那两段只出现在它那一份里', () => {
  const sub = zoneSplit(SUBAGENT_PROTOCOL.segmentOrder)
  const holder = zoneSplit(HOLDER_PROTOCOL.segmentOrder)

  assert.deepEqual(sub.A, [...ZONE_SEGMENTS.A], '子 agent 的 A 区与区表不一致')
  assert.deepEqual(sub.B, [...ZONE_SEGMENTS.B], '子 agent 的 B 区与区表不一致')
  assert.deepEqual(sub.C, [...ZONE_SEGMENTS.C], '子 agent 的 C 区与区表不一致')
  assert.deepEqual(holder.B, [...HOLDER_B], '持轮者的 B 区与 `HOLDER_B` 不一致')
  assert.deepEqual(holder.A, sub.A, '两个角色的 A 区不是同一份')
  assert.equal(holder.C.length, sub.C.length, '两个角色的 C 区段数不同')

  // 同一份段值：A 区逐字节相同（② 那条读法在持轮者那一份上也成立）

  // 同一份段值：A 区逐字节相同（② 那条读法在持轮者那一份上也成立）
  const segs = withValues(stepOf(AGENTS[0]), {
    凝聚理解: '（持轮者的凝聚理解）',
    压缩前最近几次原文: '（持轮者的压缩前原文）',
    我的任务: '（持轮者不排这一段）',
  })
  const a = assemble(inputOf(SUBAGENT_PROTOCOL, segs))
  const b = assemble(inputOf(HOLDER_PROTOCOL, segs))
  assert.equal(hashOf(a.zoneA), hashOf(b.zoneA), '两份声明装出的 A 区不同')
  assert.notEqual(hashOf(a.zoneB), hashOf(b.zoneB), '两份声明装出的 B 区一样——那两段没排进去')
  console.log(`  · A 区同一份 ${hashOf(a.zoneA)} · B 区 ${hashOf(a.zoneB)}（子 agent）→ ${hashOf(b.zoneB)}（持轮者）`)
})

test('指纹与第一处不同：两处口径各自独立算一遍', () => {
  const p = assemble(inputOf(SUBAGENT_PROTOCOL, stepOf(AGENTS[0])))
  assert.equal(hashOf(p.zoneA), sha16(p.zoneA), '`hashOf` 与 `sha256` 前 16 位不是一回事')
  assert.equal(hashOf(p.zoneA).length, 16, '指纹不是 16 位')
  const whole = wholeOf(p)
  const one = Uint8Array.from(whole)
  one[whole.length - 1] = (one[whole.length - 1] + 1) % 256
  assert.equal(firstDivergence(whole, one), whole.length - 1, '最后一个字节不同，偏移却报在别处')
  assert.equal(firstDivergence(whole, whole.subarray(0, whole.length - 1)), whole.length - 1, '一个短一个是前缀')
  assert.equal(whole.length, readPrefix(p).whole.bytes, '整体的字节数与读数不一致')
})
