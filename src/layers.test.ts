// 分层纪律的机械断言：架构 § 6 那两句（「内核不认识模型」「面不认识 git」）与 § 5 那张
// 分层图的方向，从散文落成一张表。出处：架构 § 5 · § 6 · § 8.16；做法沿用 `ui/stream.test.ts` ①
// 拿源码当输入的先例——扫出 `src/` 下每一条相对 import，对照四条规则。
//
// **例外表是双向对账的**：
//   · 出现了不在册的违例 → ①红（纪律不依赖自觉，靠这张表）；
//   · 在册的例外不再发生 → ②红（该划掉了——消掉它的那个单元交还这一行）。
// 于是每一次解耦的提交都由这张表自己记账：例外只减不增，减到零的那条规则就是无条件禁令。
//
// 四条规则各只约束**有把握的模块**，不发明全序——线协议（model）与装配体（runtime）是正交轴
// （架构 § 3 · § 7「装配体跨层接线」），硬排进一条线反而偏离设计意图：
//   R1 底座+内核（log · truth · view · roots · materialize · execute）不认识 model；
//   R2 面（capability · tools · assemble）不认识 git（truth）；
//   R3 底座+内核不上仰 boundary（§ 5：边界在内核之上，方向只向下）；
//   R4 底座+内核+probe 不上仰编排（round · contract · merge）——probe 借 `round/machine`
//      那一张边表是文档背书的单一真源选择（`probe/status.ts` 头注：不在这里另立一张边表）。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** 一条真实发生的依赖：谁 → 谁 · 是不是 `import type`（类型级不产生运行时环）。 */
interface Edge {
  readonly from: string
  readonly to: string
  readonly typeOnly: boolean
}

interface Rule {
  readonly id: string
  readonly from: readonly string[]
  readonly forbid: readonly string[]
  readonly why: string
}

/** 一条在册例外：key 是「源 -> 目标」，note 说清出处与哪个单元会消掉它。 */
interface Exception {
  readonly key: string
  readonly note: string
}

/** 那四条。源与目标都按「src/ 下第一段目录」算（根文件按文件名算）。 */
const RULES: readonly Rule[] = [
  {
    id: 'R1',
    from: ['log', 'truth', 'view', 'roots', 'materialize', 'execute'],
    forbid: ['model'],
    why: '架构 § 6 纪律一：内核（与它脚下的底座）不认识模型',
  },
  {
    id: 'R2',
    from: ['capability', 'tools', 'assemble'],
    forbid: ['truth'],
    why: '架构 § 6 纪律二：面不认识 git',
  },
  {
    id: 'R3',
    from: ['log', 'truth', 'view', 'roots', 'materialize', 'execute'],
    forbid: ['boundary'],
    why: '架构 § 5：边界在内核之上，方向只向下',
  },
  {
    id: 'R4',
    from: ['log', 'truth', 'view', 'roots', 'materialize', 'execute', 'probe'],
    forbid: ['round', 'contract', 'merge'],
    why: '架构 § 5：编排与契约在栈顶，底座与内核不得上仰（probe 借 machine 是背书例外）',
  },
]

/**
 * 在册例外（2026-09 评审起的账）。每消掉一条，随那个单元的提交把这一行划走：
 *   · U1（binding 归位 boundary）已消——execute→boundary 那两条随 b6bf849 后的 U1 提交划走；
 *   · U2（坐标词汇下沉 roots）消 reclaim 那条；
 *   · U3（事件词汇进 terms）消 log/events 那条；
 *   · probe 借 machine 与 tools/host 引 truth 句柄类型是文档背书的长期选择，**保留**。
 */
const EXCEPTIONS: readonly Exception[] = [
  {
    key: 'execute/reclaim.ts -> boundary/confine.ts',
    note: 'U2 消：cacheLayoutOf/XDG_DIR 是纯布局计算，下沉 roots',
  },
  {
    key: 'log/events.ts -> model/contract.ts',
    note: 'U3 消（type 级）：三词进 terms，底座词汇自足',
  },
  {
    key: 'probe/status.ts -> round/machine.ts',
    note: '保留：文档背书的单一真源（status.ts 头注），不是欠账',
  },
  {
    key: 'tools/host.ts -> truth/contract.ts',
    note: '保留（type 级）：host.ts 是工具缝的产品实现（组合点，头注自引 § 8.9）——§ 6 纪律'
      + '约束的是纯适配那一半；组合点接内核句柄是它的职责。首跑即抓到、评审漏数的一条',
  },
]

function listTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) listTs(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** 模块名：目录取第一段，根文件取文件名（去 .ts）。 */
function moduleOf(rel: string): string {
  const parts = rel.split('/')
  if (parts.length === 1) return (parts[0] as string).replace(/\.ts$/, '')
  return parts[0] as string
}

const FROM_SPEC = /from '(\.[^']*)'/

function edgesOf(file: string): Edge[] {
  const from = relative(SRC, file)
  const out: Edge[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = FROM_SPEC.test(line) ? line.match(FROM_SPEC) : null
    if (m === null) continue
    const to = relative(SRC, resolve(dirname(file), m[1] as string))
    out.push({ from, to, typeOnly: line.includes('import type') })
  }
  return out
}

const EDGES: readonly Edge[] = listTs(SRC).flatMap((f) => edgesOf(f))
const ON_BOOK = new Set(EXCEPTIONS.map((x) => x.key))

test('① 例外之外的违例当场红（四条规则，逐条给出处）', () => {
  const bad: string[] = []
  for (const e of EDGES) {
    for (const r of RULES) {
      if (!r.from.includes(moduleOf(e.from))) continue
      if (!r.forbid.includes(moduleOf(e.to))) continue
      const key = `${e.from} -> ${e.to}`
      if (ON_BOOK.has(key)) continue
      bad.push(`${r.id} · ${key}${e.typeOnly ? '（type 级）' : ''} —— ${r.why}`)
    }
  }
  assert.deepEqual(bad, [], '这些依赖越了层。要么改方向，要么进例外表并写清出处——不许静默。')
})

test('② 例外表没有 stale 行（在册的每一条都真的在发生）', () => {
  const live = new Set(EDGES.map((e) => `${e.from} -> ${e.to}`))
  const stale = EXCEPTIONS.filter((x) => !live.has(x.key))
  assert.deepEqual(
    stale.map((x) => x.key),
    [],
    '这几行例外已经不再发生——随消掉它们的单元一起划走，表才不会变成护身符。',
  )
})

test('③ 每条规则的受约束模块都真的存在（写错模块名等于没写规则）', () => {
  const modules = new Set(EDGES.flatMap((e) => [moduleOf(e.from), moduleOf(e.to)]))
  const ghost: string[] = []
  for (const r of RULES) {
    for (const m of [...r.from, ...r.forbid]) if (!modules.has(m)) ghost.push(`${r.id}:${m}`)
  }
  assert.deepEqual(ghost, [], '规则里出现了 src/ 下不存在的模块名——拼写错或者模块已改名。')
})
