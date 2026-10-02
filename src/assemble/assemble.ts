// 组装器：排序 · 渲染 · 拼接（架构 § 13.4 的 P1 · § 8.11 的 Assembler）。PLAN § 5.6 的 Z1。
//
// **它只做那三件事。** 段的源在 Z4（`sources.ts`）——它读状态、产出值，然后把值交给这里。
// 所以这一份里没有 `readFile` · 没有 `Truth` · 没有 `View`：给它一份（协议 · 段值）快照，
// 它离线装得出来（P3）。这条纪律不是风格问题，而是这一站每一条相等读数的前提——装配碰一下
// 状态，「同一份状态装两次逐字节相同」就不再是它管的事。
//
// **区是怎么切出来的：`zoneSplit`（`contract.ts`）。** 段序是协议值里的一串，分区是这一份
// 代码里的常量；两者相乘得到三个区的段，再按段序渲染、首尾相接。**区与区之间不掺分隔符**
// （分隔符属于渲染器，见 `render.ts` 的头注），于是三区就是同一串字节的三段。
//
// **缺源不是异常。** 段值是一个 `Partial` 记录：少一段时按那一段的渲染规则取空值（空串 ·
// 空列表 · 空对象），装配照跑、前缀变短——这是 PLAN § 5.6 那条地板（段值缺源那一档：
// 「用空值而不是异常」，判据是那个机制死掉时系统**变慢**还是**跑不起来**）。
import { createHash } from 'node:crypto'
import type {
  AssembleInput,
  Hash16,
  Partition,
  Prefix,
  PrefixReading,
  Reading,
  RendererId,
  SegmentId,
  SegmentValue,
  Zone,
} from './contract.ts'
import { DEFAULT_PARTITION, zoneSplit } from './contract.ts'
import { render } from './render.ts'

const UTF8 = new TextEncoder()

/**
 * 这一段的键压根没给时的空值：**按渲染规则**取，不是按段名取（段名在这里不该被认出来）。
 *
 * **它是地板，不是造值**（0.2.9 ④）：调用方给的 `segments` 少一个键时，这里按渲染规则给空值，
 * 让"少一段"变成前缀短一段，而不是把 `undefined` 渲染成字面量 `undefined` 继续算下去。
 * 「这一段压根没有源」是另一件事——那一档在 `sourcesFor` 里当场红（源表盖不住段序由
 * `tools/check-invariants.ts` 第三节守着）。**改主意的条件**：装配的输入里出现本该有值却是
 * `undefined` 的段——那时这里挡住的是一次上层的漏写，该在 `sourcesFor` 那一层报出来。
 */
function emptyFor(id: RendererId): SegmentValue {
  switch (id) {
    case 'list':
    case 'file-block':
      return []
    case 'json':
      return {}
    default:
      return ''
  }
}

/** 一段 → 字节。这一段的键没给就走空值（上面那道地板）；给了而渲染不动就抛 `RenderError`（那是段值的形状错了）。 */
function renderSegment(id: SegmentId, renderers: Readonly<Record<SegmentId, RendererId>>, v: SegmentValue | undefined): Uint8Array {
  return render(renderers[id], v ?? emptyFor(renderers[id]))
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * 装配一次：协议值 + 段值 → 三个区的字节。
 *
 * `model` 这一栏**不参与拼接**——模型的调用配置没有位置（`models.ts` 的头注）。它留在
 * `AssembleInput` 里是因为调用方要拿同一份声明做别的事，而「它不进前缀」这件事由签名与
 * 这一段注释一起说清：这一份里没有任何一处读 `model`。
 */
export function assemble(i: AssembleInput): Prefix {
  return assembleWith(i, DEFAULT_PARTITION)
}

/**
 * 换一份分区装配。**与 `assemble()` 是同一条实现**，分开只为让「分区是一份输入」这件事
 * 在签名上看得见（Z1 的断言 ④ 用它，走查里那一档也用它）。
 */
export function assembleWith(i: AssembleInput, partition: Partition): Prefix {
  const p = i.protocol
  const zones = zoneSplit(p.segmentOrder, partition)
  const bytes = (ids: readonly SegmentId[]): Uint8Array =>
    concat(ids.map((id) => renderSegment(id, p.renderers, i.segments[id])))
  return { zoneA: bytes(zones.A), zoneB: bytes(zones.B), zoneC: bytes(zones.C) }
}

/** 一段字节的指纹：`sha256` 的前 16 位十六进制。 */
export function hashOf(bytes: Uint8Array): Hash16 {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/** 一区的读数。 */
export function readingOf(bytes: Uint8Array): Reading {
  return { bytes: bytes.length, hash: hashOf(bytes) }
}

/** 一份前缀的读数：三区各一栏，加上 `A+B` 与整体（架构 § 9.6 装配那一行的两栏）。 */
export function readPrefix(p: Prefix): PrefixReading {
  const ab = concat([p.zoneA, p.zoneB])
  return {
    zoneA: readingOf(p.zoneA),
    zoneB: readingOf(p.zoneB),
    zoneC: readingOf(p.zoneC),
    ab: readingOf(ab),
    whole: readingOf(concat([ab, p.zoneC])),
  }
}

/** 三个区里那一段字节，按区名取（走查与检查器要按区报读数）。 */
export function zoneBytes(p: Prefix, zone: Zone): Uint8Array {
  return zone === 'A' ? p.zoneA : zone === 'B' ? p.zoneB : p.zoneC
}

/**
 * 两份字节第一个不同的位置（从 0 起）；完全相同给 `-1`。
 *
 * 它是「相邻两步只动了 C 区」这条读数的量化那一半：前缀的字节是 `A + B + C`，所以偏移落在
 * 哪里就说明变化发生在哪个区——`< |A|` 是 A 区变了，`< |A|+|B|` 是 B 区，再往后是 C 区。
 * 一个字节都没变时给 `-1`（不是 `0`：0 是一个合法的偏移，两者必须分得开）。
 */
export function firstDivergence(left: Uint8Array, right: Uint8Array): number {
  const n = Math.min(left.length, right.length)
  for (let i = 0; i < n; i++) {
    if (left[i] !== right[i]) return i
  }
  return left.length === right.length ? -1 : n
}
