// 唯一碰网的那一处。出处：架构 § 10.1 的四层里**传输**那一层 · § 10.3 的两条线 ·
// § 10.4 的"模型可见 ⟺ 已记录"。PLAN § 5.8 的 `B3`。
//
// **不加路由依赖**（架构"落地期间不引入"那一条）：宿主 Node 自带 `fetch` 与内建字节流，
// 所以这一层就是一个 `fetch` 加一段 `for await (const chunk of res.body)`。
//
// **这一份只做四件事**：拼 URL（`host` + `WIRES[wire].path`）· 带上这条线要的头 ·
// 把请求体发出去 · 把回来的**字节块**交给 `B2` 的适配器。它不认识任何一个协议的字段
// （那是适配器的事），也不留凭据的副本（`authOf()` 取来的值从 `targetOf` 直接进头里）。
//
// **凭据只在 `targetOf` 里被取一次**，也就是说"取凭据"这件事只发生在**真要发一次请求**的
// 时候——装配 · 重放 · 夹具档一条断言都不经过这里（PLAN § 5.8 的口径一）。
import type { ModelCall, ModelEvent, ModelRequest } from './contract.ts'
import { WIRES, authOf, modelDeclOf, providerOf } from './contract.ts'
import { checkEvents } from './contract.ts'
import { hashOf } from '../assemble/assemble.ts'
import type { WireAdapter } from './wire/stream.ts'
import { concatBytes, parseStream } from './wire/stream.ts'
import { wireNamed } from './wire/registry.ts'
import { wireHeader } from './wire/headers.ts'

/** 一个已经定下来的目标：谁（提供方）· 走哪条线 · 那边叫它什么 · 这一条路的头。 */
export interface Target {
  readonly providerId: string
  /** 不带路径的那一段（`https://api.deepseek.com`）。 */
  readonly host: string
  readonly wire: WireAdapter
  /** 端点 = `host` + 路那一段。 */
  readonly path: string
  readonly model: string
  /**
   * 这一份是从哪儿来的：`'decl'` = 由声明拼出来的（真发请求那一档）· `'fixture'` = 从夹具读出来的
   * （**不发真请求**那一档）。它是一栏**说明**，不是开关——`fetchTransport` 认的是 host 本身，
   * 而 host 空着的时候它当场拒（而不是拼出一个相对的 URL 去 fetch）。
   */
  readonly from: 'decl' | 'fixture'
  /** 鉴权的头。**值在构造它的时候取一次**——这一份自己不存凭据。 */
  readonly headers: Readonly<Record<string, string>>
}

/** 声明 → 目标。**`authOf()` 的唯一调用点。** */
export function targetOf(declId: string): Target {
  const decl = modelDeclOf(declId)
  const provider = providerOf(decl.provider)
  return {
    providerId: provider.id,
    host: provider.host,
    wire: wireNamed(decl.wire),
    path: WIRES[decl.wire].path,
    model: decl.model,
    from: 'decl',
    headers: wireHeader(decl.wire, authOf(provider)),
  }
}

/** 收字节块（不是"一行"、不是"一条事件"）：TCP 把一个事件拆成几个块是常态。 */
export interface Transport {
  post(t: Target, body: Uint8Array, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/**
 * 一边往下传、一边把原始字节攒起来。**录一份夹具要有原始字节**（回放时喂回去的就是它），
 * 而产品路径不需要多留一份——所以它是一层可选的包装，不是 `Transport` 的第二个方法。
 */
export function teeBytes(inner: Transport, sink: Uint8Array[]): Transport {
  return {
    async *post(t: Target, body: Uint8Array, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
      for await (const chunk of inner.post(t, body, signal)) {
        // `slice()` 是拷贝（`subarray()` 只是视图）：攒字节要的是拷贝，上游的缓冲区会复用。
        sink.push(chunk.slice())
        yield chunk
      }
    },
  }
}

/** 上游不高兴：状态码不在 2xx。**它不是 `WireError`**——那条线协议的字节还没开始解析。 */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 真网络那一档。**整个仓库里唯一一处 `fetch`。** */
export const fetchTransport: Transport = {
  async *post(t: Target, body: Uint8Array, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    if (!t.host.startsWith('http')) {
      throw new HttpError(0, `这一份目标没有 host（来自 ${t.from}），发不了真请求：${JSON.stringify(t.host)}`)
    }
    const res = await fetch(t.host + t.path, {
      method: 'POST',
      headers: t.headers,
      body,
      ...(signal === undefined ? {} : { signal }),
    })
    if (!res.ok) {
      // 上游回的是人读的错：**带上原文的前一截**，否则"400"这三个数字什么都说明不了。
      const said = await res.text().catch(() => '')
      throw new HttpError(res.status, `${t.host}${t.path} 回了 ${res.status} ${res.statusText}：${said.slice(0, 400)}`)
    }
    if (res.body === null) {
      throw new HttpError(res.status, `${t.host}${t.path} 回了空 body：流式请求要的是一条 SSE 流`)
    }
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) yield chunk
  },
}

/** 一次调用的账：给日志用（`llm/call` 那一条的载荷照它填）。 */
export interface CallLedger {
  /** 走完了的那一次调用（`checkEvents` 的出口）。**半截的流没有这一项。** */
  readonly call: ModelCall | null
  /** 发出去的那一串字节的指纹与长度（"发出去的字节与装配出来的字节是同一份"这句的度量）。 */
  readonly bodyHash: string
  readonly bytes: number
  /** 流上看见了几条事件、开了几条调用、收了几条（**半截那一档的证据**）。 */
  readonly seen: number
  readonly opened: number
  readonly closed: number
  /** 半截的流：为什么断的。走完的那一次是 `null`。 */
  readonly failure: string | null
  /** 上游回来的**原始字节**（录夹具用；走完的那一次才有）。 */
  readonly raw: Uint8Array
}

/** 一次调用的两个出口：事件流（给循环）与那一笔账（给日志）。 */
export interface ModelStream {
  events: AsyncIterable<ModelEvent>
  /** 迭代完了（或抛了）之后才有值；**还在跑的时候问它是错的**。 */
  ledger(): CallLedger
}

/**
 * 发一次调用：字节 → 事件。**这一份不做重试**——上游中途掐断就是掐断：
 * "报错并记事件，不静默重试，不把半个响应当完整"（PLAN § 5.8 的 B3 断言 ④）。
 *
 * 半截那一档的读法：`events` 那边抛（`WireError` 或 `HttpError`），这一边的 `ledger()` 仍然
 * 交得出一份账——`call: null` · `failure` 有话说 · `seen` 告诉你走到第几条断的。**调用方
 * 拿着这份账去记 `llm/call` 并记错误事件**，而不是替它重试一次。
 */
export function callModel(
  t: Target,
  r: ModelRequest,
  transport: Transport = fetchTransport,
  signal?: AbortSignal,
): ModelStream {
  const body = t.wire.bytes(r)
  const back: Uint8Array[] = []
  /** 一路看见的事件（走完之后交给 `checkEvents`：**顺序的约束在那里面**）。 */
  const seen: ModelEvent[] = []
  let call: ModelCall | null = null
  let failure: string | null = null
  let done = false
  /** 开了几条调用 · 收了几条（半截那一档的证据：开了没收就是断在半路）。 */
  let opened = 0
  let closed = 0

  async function* run(): AsyncGenerator<ModelEvent> {
    try {
      for await (const e of parseStream(t.wire, teeBytes(transport, back).post(t, body, signal))) {
        seen.push(e)
        if (e.t === 'tool-start') opened += 1
        if (e.t === 'tool-call') closed += 1
        yield e
      }
      // 走完了才谈得上"一次完整的调用"：`checkEvents` 在这里核收尾那一条（架构 § 14.2 第 2 步）。
      call = checkEvents(seen)
    } catch (err) {
      failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      throw err
    } finally {
      done = true
    }
  }

  return {
    events: run(),
    ledger(): CallLedger {
      if (!done) throw new Error('这一条流还在跑：账要等它停下来再读（半截的账不是账）')
      return {
        call,
        bodyHash: hashOf(body),
        bytes: body.length,
        seen: seen.length,
        opened,
        closed,
        failure,
        raw: concatBytes(back),
      }
    },
  }
}
