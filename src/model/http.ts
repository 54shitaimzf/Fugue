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
import { ModelDeclError, WIRES, authOf, modelDeclOf, providerOf } from './contract.ts'
import { checkEvents } from './contract.ts'
import { hashOf } from '../assemble/assemble.ts'
import type { WireAdapter } from './wire/stream.ts'
import { concatBytes, parseStream } from './wire/stream.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { wireNamed } from './wire/registry.ts'
import { wireHeader } from './wire/headers.ts'

/**
 * 上游那几句"能拿去报单"的原话（状态码 · 请求号 · 限流那几条）。
 *
 * **它是一个可选的一栏，不是新的一族事件**：`HttpError` 与 `HarnessError` 各带一栏，而
 * `llm/call` 那一条照它填 `status` 与 `headers`。成功那一路这两栏是 `null`——**默认档一个
 * 字节都不多**。
 *
 * 它住这一份（`B3` 的传输）而不是 `runtime`：产生它的是这一层，消费它的是 `runtime` 的日志，
 * 方向只有一条。反过来放会让 `http` 去 import `step`，而 `step` 已经 import 了 `http`。
 */
export interface WireFacts {
  readonly [name: string]: string | number | undefined
}

/** 一个错误对象上挂着的那些事实（**按形状读**，不按类读：转挂一次之后类名会变，那一栏不会）。 */
export function wireFactsOf(err: unknown): Readonly<Record<string, string | number>> | null {
  const f = (err as { facts?: Record<string, string | number> } | null)?.facts
  return f === undefined ? null : f
}

/**
 * 响应头上那几条**能拿去报单**的（其余一概不留）。
 *
 * 为什么是白名单而不是整份头：头里有 `set-cookie` 一类不该进日志的东西，而"排障要哪几个"是
 * 一个**短名单**——短名单写下来，才不会因为某天多了一个头就把日志长胖。要加就加在这张表里。
 */
export const KEPT_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]

/** 一张响应头 → 那一栏（没命中白名单的丢掉；一条都没有时给 `null`）。 */
export function keptHeaders(h: Headers | Readonly<Record<string, string>>): Record<string, string> | null {
  const get = (name: string): string | null =>
    typeof (h as Headers).get === 'function' ? (h as Headers).get(name) : ((h as Record<string, string>)[name] ?? null)
  const out: Record<string, string> = {}
  for (const name of KEPT_HEADERS) {
    const v = get(name)
    if (v !== null && v !== '') out[name] = v
  }
  return Object.keys(out).length === 0 ? null : out
}

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
  return targetAt(declId, authOf(providerOf(decl.provider)))
}

/**
 * 声明 + **一个已经取来的凭据值** → 目标。同一个目标，只是凭据不由这一份去取。
 *
 * **为什么要有它**（实测撞出来的）：壳那一档的 `--live --credential <工作区之外的路径>` 走的是
 * `credentialAt()`——它自己读文件、读到了，可拼目标时又调了一次 `targetOf()`，而那一处按
 * **提供方的声明**去取（今天声明的是环境变量 `DEEPSEEK_API_KEY`）。于是"用一个文件里的 key
 * 跑一个轮次"这条路**根本走不通**：文件里那份读到了也没用，`authOf()` 没设环境变量就抛。
 * 探针没露出这一条，是因为它自己 catch 住那次取用、又自己拼了一份头（两处各取一次就会这样
 * 漂）。给值的那一档让**取凭据**与**拼目标**这两件事分开：谁取、从哪取归壳，目标长什么样归
 * 这一份。**它不读环境变量、不读文件**——值必须从参数进来。
 */
export function targetAt(declId: string, credential: string): Target {
  if (credential === '') throw new ModelDeclError('凭据不能是空串：空凭据发出去换来一个 401，那看起来像"模型不行"，其实是没给值')
  const decl = modelDeclOf(declId)
  const provider = providerOf(decl.provider)
  return {
    providerId: provider.id,
    host: provider.host,
    wire: wireNamed(decl.wire),
    path: WIRES[decl.wire].path,
    model: decl.model,
    from: 'decl',
    headers: wireHeader(decl.wire, credential),
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
  /** 上游那几句原话（可选）。**读它的是 `step` 那一层**（填进已有的 `llm/call`）。 */
  readonly facts?: WireFacts
  constructor(status: number, message: string, facts?: WireFacts) {
    super(message)
    this.status = status
    if (facts !== undefined) this.facts = facts
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
      // 而排障要的是**那几个能拿去报单的值**（请求号 · 限流 · 状态码）：它们只在这一层拿得到，
      // 往上走就只剩一句话了。挂在错误上，`step` 那一层读它，填进已有的 `llm/call`。
      throw new HttpError(
        res.status,
        `${t.host}${t.path} 回了 ${res.status} ${res.statusText}：${said.slice(0, 400)}`,
        { status: res.status, ...(keptHeaders(res.headers) ?? {}) },
      )
    }
    if (res.body === null) {
      throw new HttpError(res.status, `${t.host}${t.path} 回了空 body：流式请求要的是一条 SSE 流`, {
        status: res.status,
        ...(keptHeaders(res.headers) ?? {}),
      })
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
 * **把发出去与收回来的字节原样落盘**（`--dump-wire <目录>`）。**默认不落**——不给目录时这一层
 * 根本不存在（它是包在 `wireCall` 外面的一层，不是产品路径上的一段）。
 *
 * 为什么要有它：`prefix-hit-rate` 为 0 的时候，日志只能告诉你"没命中"，**证不了"我们发的字节
 * 与装配出来的字节是同一串"**——那是本地用夹具量过的性质（`wire.test.ts` 的 ②b/②c 与
 * `probe-prefix` 第七节），而真档里没有对应的取证物。这个目录就是那份取证物。
 *
 * **它不改发出去的字节**：请求体照旧由 `callModel` 拼一次，这一层只是把**同一个 `Uint8Array`**
 * 写一份到盘上——所以"带 dump 与不带 dump 的请求逐字节相同"是结构上成立的，而 `http.test.ts`
 * 有一条断言盯着它。
 *
 * 一次调用一个子目录（`call-0001/` … 按发生次序编号）：
 *
 *   `request.json`   发出去的请求体
 *   `response.sse`   收回来的原始字节（上游怎么切块就怎么攒）
 *   `meta.json`      目标 · 三区指纹 · 指纹与字节数 · 事件条数 · 失败那句话
 *   `*.sha256`       两条 `sha256`，**给人用 `sha256sum -c` 对账**
 *   `README`         这一份取来干什么、怎么与日志对
 *
 * **落哪儿由调用方定，而它必须在工作区之外**：这一层只管写；"不许落进 `<realRoot>`"那条由
 * CLI 拦（落进去会被下一轮的 `fork` 当成漂移——PLAN § 5.8.a 那条现场更正）。
 */
/** 标准 sha256（64 个十六进制字符）：`sha256sum -c` 认得的那一把。**与 `hashOf()` 不是同一把**。 */
function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex')
}

export function makeDumpCall(inner: CallModel, dir: string, transport: Transport = fetchTransport): CallModel {
  let n = 0
  return (request, signal) => {
    /** 这一趟发出去的那一份请求体（`callModel` 拼的那一个对象，不是重拼的）。 */
    const sent: Uint8Array[] = []
    // 拦在**传输**那一层：`callModel` 拿到的是一份包过的传输，回来的字节既往下走、也落盘。
    const spying: Transport = {
      async *post(t, body, sig) {
        sent.push(body)
        yield* transport.post(t, body, sig)
      },
    }
    const stream = callModel(
      request.target,
      {
        model: request.model,
        zones: { A: request.prefix.zoneA, B: request.prefix.zoneB, C: request.prefix.zoneC },
        tools: request.tools,
        ...(request.call === undefined ? {} : { call: request.call }),
      },
      spying,
      signal,
    )
    const events: ModelEvent[] = []
    let done = false
    n += 1
    const mine = n
    const iter = (async function* (): AsyncGenerator<ModelEvent> {
      try {
        for await (const e of stream.events) {
          events.push(e)
          yield e
        }
      } finally {
        done = true
      }
    })()
    return {
      events: iter,
      ledger: () => {
        const l = stream.ledger()
        if (done) {
          const at = join(dir, `call-${String(mine).padStart(4, '0')}`)
          mkdirSync(at, { recursive: true })
          const body = sent[0] ?? new Uint8Array()
          writeFileSync(join(at, 'request.json'), body)
          writeFileSync(join(at, 'response.sse'), l.raw)
          // **这一栏是给 `sha256sum -c` 用的**（上面的 README 就是这么写的），所以落的必须是
          // **标准 sha256**——而 `hashOf()` 是产品内部那把 16 个字符的短指纹（`meta.json` 里那两栏
          // 用它，与日志对得上）。实测：原先这里落的是短指纹，于是照着 README 敲
          // `sha256sum -c request.sha256` 一律报"对不上"——**一份取证物自己说自己被改过**。
          writeFileSync(join(at, 'request.sha256'), `${sha256Hex(body)}  request.json\n`)
          writeFileSync(join(at, 'response.sha256'), `${sha256Hex(l.raw)}  response.sse\n`)
          writeFileSync(
            join(at, 'meta.json'),
            JSON.stringify(
              {
                call: mine,
                target: {
                  providerId: request.target.providerId,
                  host: request.target.host,
                  path: request.target.path,
                  model: request.target.model,
                  from: request.target.from,
                  wire: request.target.wire.name,
                },
                model: request.model,
                requestBytes: body.length,
                requestHash: hashOf(body),
                responseBytes: l.raw.length,
                responseHash: hashOf(l.raw),
                zoneAHash: hashOf(request.prefix.zoneA),
                zoneBHash: hashOf(request.prefix.zoneB),
                zoneCHash: hashOf(request.prefix.zoneC),
                tools: request.tools?.length ?? 0,
                events: events.length,
                opened: l.opened,
                closed: l.closed,
                stop: l.call?.stop ?? null,
                failure: l.failure,
              },
              null,
              2,
            ) + '\n',
          )
          writeFileSync(
            join(at, 'README'),
            [
              '这一份是一次调用发出去与收回来的原始字节。取值顺序：',
              '',
              '1. `sha256sum -c request.sha256` —— 发出去的那一串与当时那一串是不是同一份。',
              '2. `meta.json` 的三条 `zone*Hash` 与同一步的 `prefix/assemble` 对：日志说"装配出来',
              '   是什么"，这一份说"发出去的是什么"。**两者不是同一串**时才要往下查。',
              '3. `response.sse` 是上游的原始字节：录一份夹具就是照它写的（`src/model/session.ts`）。',
              '',
              '**它不在工作区里**（落进 `<realRoot>` 会被下一轮的 fork 当成漂移）。看完就删。',
              '',
            ].join('\n'),
          )
        }
        return l
      },
    }
  }
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
      // 事实**转挂到一个普通错误上**（`wireFactsOf` 按形状读，转挂之后照样读得到）：抛出去的那
      // 一个对象 `step` 接得住，于是"为什么失败"不只是 stderr 上的一句话。
      const said = wireFactsOf(err)
      if (said !== null) {
        const wrapped = new Error(failure)
        ;(wrapped as { facts?: Readonly<Record<string, string | number>> }).facts = said
        throw wrapped
      }
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
