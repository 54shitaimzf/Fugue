// 前缀装配的四条约束（架构 § 8.11「四条约束」· PLAN § 5.6 的 Z6）。
//
//   1. **C 区只追加，绝不修改中部**——改中部会让 B 与 C 全部失效
//   2. **物化路径不进入任何区**——模型看到的是相对路径
//   3. **环境标识不进入 A 区**——轮次编号 · scratch 路径 · 主机名 · 逐 agent 各不相同的产物目录
//   4. **Signal 不进入前缀**，只进日志；仅合并后的结果进入 C 区
//
// **这一份是"把坏值放进去会怎样"的那一半。** 前三条在别处各有各的守门人（区表 · 视图 · `M7`），
// 但守门人管的是"别造出坏值"；这一份管的是**坏值真的进了前缀时，报得出来**——所以它收的是
// （协议 · 段值 · 上一次的 C 区），四条各查各的（架构 § 20 S6 的第三条验证：「前缀中不存在绝对
// 路径 · 环境标识 · Signal 原文」）。
//
// **不查"应然"的那两条**：段有没有排过序（`checkProtocolInvariant` 管）· 段值渲染得出不出
// （`render.ts` 管）。四类各一条读数，混在一起报的话，看的人分不出是哪一条破了。
//
// **环境标识查的是"这一刻这台机器上真的会漏出去的那几样"**：宿主名 · 本进程 pid。写死一串靶子
// （Z0 探针那三张表）只能抓住写死的那一串；查当下的取值，抓的是真会漏的。Z0 那三处读数的用处
// 就在这里：靶子表的取值处是这一份。
//
// **绝对路径那一条查的是渲染出来的字节**：段值是值（`{path, text}` 那种），渲染之后才看得出
// 模型会看到什么。查值的话，`text` 里藏一条绝对路径就漏了。
import { hostname } from 'node:os'
import type { Prefix, Protocol, SegmentId, SegmentValue } from './contract.ts'
import { ZONE_OF } from './contract.ts'
import { render } from './render.ts'

/** 四条约束的身份。**报出来的话里要带得动它**（架构 § 8.11 那四条）。 */
export type ConstraintKind = 'append-only' | 'materialized' | 'env' | 'signal'

/** 一条违反：哪一条 · 落在哪一段 · 一句话说清是什么。 */
export interface Violation {
  readonly kind: ConstraintKind
  readonly where: string
  readonly detail: string
}

/** 四条约束各自的名字，给人读的输出用。 */
export const CONSTRAINT_NAMES: Readonly<Record<ConstraintKind, string>> = {
  'append-only': 'C 区只追加，绝不修改中部',
  materialized: '物化路径不进入任何区',
  env: '环境标识不进入 A 区',
  signal: 'Signal 不进入前缀',
}

/** 四条约束，按架构 § 8.11 那四条的顺序。 */
export const CONSTRAINT_KINDS: readonly ConstraintKind[] = ['append-only', 'materialized', 'env', 'signal']

/**
 * 一条绝对路径：`/` 开头、**深度 ≥ 2**（`/tmp` 这种一个字的太容易误报），前面是一个边界。
 *
 * **两份都不写 `\s`**：这个仓库的文件经 Windows 那一侧中转（AGENTS.md § 一），而 `\s` 那一类
 * 转义在这一路上会被吃成字面量（实测：`/digest\s*[:=]/` 在文件里原样、`re.source` 也原样，
 * 可 `test('digest:')` 判否；同一个模式用 `[ ]` 写就判是）。白空格写成 `[ \t]` 那种显式的
 * 字符类，一个字节的歧义都不留。
 */
const ABS_PATH = /(?:^|[ \t"'`(=:,[\]-])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/

/** Signal 原文的靶子形状：`digest` 那一个键（`signal` 事件独有，合并后的摘要不带它）。 */
export const SIGNAL_SHAPE = /digest"?[ \t]*[:=]/

/** 这一刻这台机器上的环境标识。 */
export interface EnvFacts {
  readonly hostname: string
  readonly pid: number
}

/** 当下的那几样：宿主名与 pid 只有一处取值（`M14` 探针与这一份共用）。 */
export function envFacts(): EnvFacts {
  return { hostname: hostname(), pid: process.pid }
}

/** 在字节里找第一处命中：位置 + 捕获到的那一段。 */
function findIn(bytes: Uint8Array, re: RegExp): { at: number; text: string } | null {
  const text = new TextDecoder().decode(bytes)
  const m = re.exec(text)
  if (m === null) return null
  return { at: m.index, text: m[1] ?? m[0] }
}

/** 一段里所有命中的片段（去重，保持出现次序）。 */
function allIn(bytes: Uint8Array, re: RegExp): string[] {
  const text = new TextDecoder().decode(bytes)
  const out: string[] = []
  for (const m of text.matchAll(re)) {
    const s = m[1] ?? m[0]
    if (!out.includes(s)) out.push(s)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 环境标识在 A 区里的两类命中：宿主名那一串 · 本进程 pid（带边界，免得撞上别的数字）。 */
function envHits(bytes: Uint8Array, facts: EnvFacts): string[] {
  const hits = facts.hostname === '' ? [] : allIn(bytes, new RegExp(escapeRe(facts.hostname), 'g'))
  if (facts.pid > 0) hits.push(...allIn(bytes, new RegExp(`(?:^|[^0-9])${facts.pid}(?![0-9])`, 'g')))
  return hits
}

/**
 * 查一遍：四条约束各自报（有几处报几处）。
 *
 * `previous` 是上一次的 `Prefix`（同一条线上的上一步）：给了它才判得了第一条——「只追加」是一句
 * 关于两次的断言，一次装配里看不出来。**不给就不查第一条**：一条查不了的约束不该报假绿。
 */
export function checkConstraints(
  protocol: Protocol,
  segments: Readonly<Record<SegmentId, SegmentValue>>,
  previous: Prefix | null = null,
  who: string = '这一步',
  facts: EnvFacts = envFacts(),
  current: Prefix | null = null,
): Violation[] {
  const out: Violation[] = []

  for (const id of protocol.segmentOrder) {
    const value = segments[id]
    if (value === undefined) continue
    const bytes = render(protocol.renderers[id], value)
    const zone = ZONE_OF[id]

    // 约束 2：物化路径不进入任何区（三个区都查）。
    const abs = findIn(bytes, ABS_PATH)
    if (abs !== null) {
      out.push({ kind: 'materialized', where: id, detail: `这一段（${zone} 区）里有绝对路径：${abs.text}` })
    }

    // 约束 4：Signal 原文不进入前缀（三个区都查；合并后的摘要进 C 区是允许的）。
    if (SIGNAL_SHAPE.test(new TextDecoder().decode(bytes))) {
      out.push({ kind: 'signal', where: id, detail: `这一段（${zone} 区）里有 Signal 原文的字段（digest）` })
    }

    // 约束 3：环境标识不进入 A 区（只查 A 区——B 区与 C 区是"已经天然分叉的地方"）。
    if (zone === 'A') {
      for (const hit of envHits(bytes, facts)) {
        out.push({ kind: 'env', where: id, detail: `A 区那一段里有环境标识：${hit}` })
      }
    }
  }

  // 约束 1：C 区只追加，绝不修改中部。判据是**上一次的 C 区是不是这一次的前缀**：中部被改写
  // （或删掉）都会在某一个字节上开始不同，那个位置就是报出来的东西。
  if (previous !== null) {
    const prev = previous.zoneC
    const next = current === null ? currentZoneC(protocol, segments) : current.zoneC
    const shared = sharedPrefixLen(prev, next)
    if (!startsWith(prev, next)) {
      out.push({
        kind: 'append-only',
        where: 'C 区',
        detail: `${who}：C 区中部被改写了——前 ${shared} 个字节相同，第 ${shared + 1} 个字节起不同`,
      })
    }
  }

  return out
}

/** 这一次的 C 区字节：按段序把 C 区那几段渲染出来接上。 */
function currentZoneC(protocol: Protocol, segments: Readonly<Record<SegmentId, SegmentValue>>): Uint8Array {
  const parts: Uint8Array[] = []
  for (const id of protocol.segmentOrder) {
    if (ZONE_OF[id] !== 'C') continue
    const v = segments[id]
    if (v === undefined) continue
    parts.push(render(protocol.renderers[id], v))
  }
  return concat(parts)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** `a` 是不是 `b` 的前缀。 */
export function startsWith(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length > b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** 两个字节串从头起相同的长度（第一处不同的位置 = 这个数）。 */
export function sharedPrefixLen(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

/** 四条约束各自的号：给人读的输出里那一个前缀。 */
export function kindIndex(kind: ConstraintKind): number {
  return CONSTRAINT_KINDS.indexOf(kind) + 1
}

/** 一条违反排成人读的一行。 */
export function formatViolation(v: Violation): string {
  return `约束 ${kindIndex(v.kind)}（${CONSTRAINT_NAMES[v.kind]}）· ${v.where} —— ${v.detail}`
}
