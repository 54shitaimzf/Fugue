// 录一份夹具 · 回放一份夹具。出处：架构 § 10.5（拟合正确与否用**录制的会话夹具**验证，
// 无需 API 密钥；夹具里 `request/header` 的内容**可令牌化为占位符**，回放时物化）·
// § 9.7（会话内与会话外：请求里的状态类内容必须重建得出）· § 8.11（三区就是稳定性等级）。
// PLAN § 5.8 的 `B3`。
//
// **夹具的形状**（`fixtures/` 里那两份就是这一版录下来的）：
//
//   model        我们这边的键（那一次调用发的是哪条记录）
//   wire         哪条线协议
//   target       提供方那边叫它什么名字（**外号不进日志，进夹具**：回放要发得跟录的时候一样）
//   zones        A · B · C **三段分开放的**（不是拼好的一条）：回放时逐区物化，区与区的分界
//                因此看得见——"Zone A 跨 N 个 agent 逐字节相同"这条验证性质（§ 8.11）于是
//                **是一条可执行的快照断言**，不是一句设计话
//   tools        工具目录（名字 · 描述 · 参数面）
//   call         轮内固定那一条（温度 · 输出上限）
//   bodyHash     那一次发出去的字节的指纹 + 字节数（回放时**逐字节**核对）
//   response     上游回来的**原始 SSE 文本**（一个字节都没改）
//   record       那一次的账：用量四个数 · 结束原因 · 工具调用 · 花多久
//
// **为什么存字段而不是存"发出去的那一串字节"**：字节是结果，字段是内容。存字节的话，夹具里
// 看不出哪一段是 Zone A，"跨 agent 逐字节相同"就无从核起；而回放时要的恰恰是**重新装配一次、
// 再看字节对不对**——存字节只能证明"存下来的那串还是那串"。
//
// **回放核两样**：重新装配出来的**规范文本**（`requestJson`，逐字节）与**这条线协议上真正发出去
// 的字节**（`hashOf`）。前者抓"装配漂了"，后者抓"适配器漂了"。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelCall, ModelRequest, Usage } from './contract.ts'
import { requestJson } from './contract.ts'
import type { Transport, Target } from './http.ts'
import { callModel } from './http.ts'
import type { Prefix } from '../assemble/contract.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import { wireNamed } from './wire/registry.ts'

/** 录下来的**一次调用**。 */
export interface RecordedCall {
  /** 发出去那一串字节的指纹与长度（"逐字节相同"这句话的度量）。 */
  readonly bodyHash: string
  readonly bytes: number
  /** 上游回来的原始 SSE 文本。 */
  readonly response: string
  /** 那一次的账（半截的流是 `null`——**没走完就不算一次调用**）。 */
  readonly record: CallRecord | null
}

/** 那一次的账。**它就是 `llm/call` 那一条事件的载荷来源**（`B3` 的断言 ②）。 */
export interface CallRecord {
  readonly usage: Usage | null
  readonly text: string
  readonly toolCalls: readonly { readonly id: string | null; readonly name: string; readonly arguments: string }[]
  readonly stop: string | null
  readonly rawStop: string | null
  /** 这一趟花了多久（`run/end` 那一族同一个口径：毫秒；夹具档是 0）。 */
  readonly ms: number
}

/** 一份夹具。**盘上的形状**（`JSON.stringify` 之后人读得懂）。 */
export interface Fixture {
  readonly version: number
  readonly id: string
  /** 我们这边的键（`ModelId`）。 */
  readonly model: string
  readonly wire: string
  /** 提供方那边叫它什么（回放要发得跟录的时候一样）。 */
  readonly target: string
  readonly zones: { readonly A: string; readonly B: string; readonly C: string }
  readonly tools: readonly ToolEntry[]
  readonly call: { readonly temperature?: number; readonly maxTokens?: number }
  readonly bodyHash: string
  readonly bytes: number
  readonly response: string
  readonly record: CallRecord | null
}

export const FIXTURE_VERSION = 1

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** 三区 → 一个请求。**夹具与产品路径共用这一处**（`prefix` 是装配的出口，`ModelRequest` 是它的下游）。 */
export function requestOf(
  prefix: Prefix,
  model: string,
  tools: readonly ToolEntry[] | null,
  call: Fixture['call'],
): ModelRequest {
  return {
    model,
    zones: { A: prefix.zoneA, B: prefix.zoneB, C: prefix.zoneC },
    ...(tools === null ? {} : { tools }),
    call,
  }
}

/** 夹具 → 一个请求（字段重新物化；**逐区解，不拼成一条**）。 */
export function requestFrom(f: Fixture): ModelRequest {
  return {
    model: f.target,
    zones: { A: encoder.encode(f.zones.A), B: encoder.encode(f.zones.B), C: encoder.encode(f.zones.C) },
    ...(f.tools.length === 0 ? {} : { tools: f.tools }),
    call: f.call,
  }
}

/** 请求与目标 → 一份夹具（录下来那一刻的形状）。 */
export function fixtureOf(id: string, declId: string, t: Target, r: ModelRequest, recorded: RecordedCall): Fixture {
  return {
    version: FIXTURE_VERSION,
    id,
    model: declId,
    wire: t.wire.name,
    target: t.model,
    zones: {
      A: decoder.decode(r.zones.A),
      B: decoder.decode(r.zones.B),
      C: decoder.decode(r.zones.C),
    },
    tools: r.tools ?? [],
    call: r.call ?? {},
    bodyHash: recorded.bodyHash,
    bytes: recorded.bytes,
    response: recorded.response,
    record: recorded.record,
  }
}

/**
 * 夹具档的目标：只有"走哪条线"与"那边叫什么"两样真的被读到（`bytes()` 与核对都用它们）。
 *
 * **凭据一个字节都不取**——`headers` 是空的、`host` 也是空的，因为夹具档不发真请求。
 * `targetOf()` 会去取凭据，而夹具档一条断言都不该需要它（PLAN § 5.8 的口径一）。
 */
export function fixtureTarget(f: Fixture): Target {
  return {
    providerId: 'fixture',
    host: '',
    wire: wireNamed(f.wire),
    path: '',
    model: f.target,
    headers: {},
  }
}

/** 夹具 → 一段假提供方：那份响应**按给定块大小**吐出来（1 = 一次一个字节）。 */
export function fixtureTransport(f: Fixture, chunkSize = 1): Transport {
  const all = encoder.encode(f.response)
  const size = Math.max(1, chunkSize)
  return {
    async *post(_t: Target, _body: Uint8Array, _signal?: AbortSignal): AsyncGenerator<Uint8Array> {
      for (let at = 0; at < all.length; at += size) yield all.subarray(at, Math.min(at + size, all.length))
    },
  }
}

/** 回放一份夹具：走**同一条产品路径**（`callModel` + 那个假提供方），响应一个字节都不改。 */
export function replayOf(f: Fixture, chunkSize = 1): ReturnType<typeof callModel> {
  return callModel(fixtureTarget(f), requestFrom(f), fixtureTransport(f, chunkSize))
}

/** 落盘 / 读回来。 */
export function writeFixture(path: string, f: Fixture): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(f, null, 2) + '\n')
}

export function readFixture(path: string): Fixture {
  const f = JSON.parse(readFileSync(path, 'utf8')) as Fixture
  if (f.version !== FIXTURE_VERSION) {
    throw new Error(`夹具的版本是 ${f.version}，这一版认的是 ${FIXTURE_VERSION}：${path}`)
  }
  return f
}

/** 那一次调用积出来的账 → `CallRecord`（日志那一栏要的几个数都在这儿）。 */
export function recordOf(call: ModelCall, ms: number): CallRecord {
  return {
    usage: call.usage,
    text: call.text,
    toolCalls: call.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
    stop: call.stop,
    rawStop: call.rawStop,
    ms,
  }
}

/** 规范文本：回放时逐字节核的那一份。 */
export function canonicalOf(r: ModelRequest): string {
  return requestJson(r)
}
