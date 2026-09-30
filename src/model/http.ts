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
import type { AuthRef, ModelCall, ModelEvent, ModelRequest, ThinkingLevel, Turn } from './contract.ts'
import { ModelDeclError, WIRES, authOf, modelDeclOf, promptCacheFor, providerOf } from './contract.ts'
import { checkEvents } from './contract.ts'
import { hashOf } from '../assemble/assemble.ts'
import type { WireAdapter } from './wire/stream.ts'
import { concatBytes, parseStream } from './wire/stream.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** 声明 → 目标。**`authOf()` 的唯一调用点。** 引用表从配置的 `credentials.<id>` 键来（调用方递）。 */
export function targetOf(declId: string, creds: readonly AuthRef[] | undefined): Target {
  const decl = modelDeclOf(declId)
  return targetAt(declId, authOf(decl.provider, creds))
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
      // **这一截也交出去**（`yield`，随后照旧抛）：它不进任何一次解析（上面已经非 2xx 了），
      // 但 `teeBytes` 会把它攒进原始字节里——`--dump-wire` 的 `response.sse` 于是连"上游说凭据
      // 不对"这句原话都在。原先抛之前一个字节都不 yield，那一趟的 dump 里响应是空的：
      // 排障的人最想看的那一句恰好是唯一没落下来的那一句。
      if (said !== '') yield new TextEncoder().encode(said)
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

/**
 * **回放档**：按 `requestHash` 核一遍，然后把录下来的响应喂回去（架构 § 10.5 的录制夹具 ·
 * PLAN § 5.8 的口径一"验收不押在网络上"）。
 *
 * 目录的形状就是 `--dump-wire` 落的那个形状（`call-0001/` … 按发生次序编号），所以"录一份、
 * 回放一份"是同一种物件的两种用法。每一次 `post` 做三件事：
 *
 *   一 · 取第 n 个子目录的 `meta.json`（缺了就是"夹具里没有这一份"——**报出来，不静默停下**）；
 *   二 · **核**：这一趟真正发出去的字节的短指纹（`hashOf`，与日志、与 `prefix/assemble` 同一把尺）
 *        与录下来的 `requestHash` 不等 → 当场拒。**过期不重修**：前缀或契约的字节一变，旧夹具
 *        就该红着，而不是被修得像新的（要新的就真跑一趟重录）。
 *   三 · 喂回去：`response.sse` 的原始字节，**按 SSE 的事件边界切块**。切法与当时上游不必逐块
 *        相同（`Transport` 收的就是字节块），但按事件切更接近一条真实的流。
 *
 * **它不碰网、也不读凭据**：这一层上面已经没有别的东西了——`callModel` 拿到的是"一段回来的
 * 字节"，而它不认识这段字节从哪儿来。
 */
export class WireInError extends Error {}

/** `response.sse` → 按事件边界切块（一个空行是一件事的收尾）；末尾没空行的那一段也交出去。 */
function sseChunks(raw: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let at = 0
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === 0x0a && raw[i + 1] === 0x0a) {
      out.push(raw.subarray(at, i + 2))
      at = i + 2
      i += 1
    }
  }
  if (at < raw.length) out.push(raw.subarray(at))
  return out.length === 0 ? [raw] : out
}

export function wireInTransport(dir: string): Transport {
  let n = 0
  return {
    post(_t: Target, body: Uint8Array): AsyncGenerator<Uint8Array> {
      n += 1
      const mine = n
      return (async function* (): AsyncGenerator<Uint8Array> {
        const at = join(dir, `call-${String(mine).padStart(4, '0')}`)
        let meta: { requestHash?: unknown; responseHash?: unknown }
        try {
          meta = JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8')) as { requestHash?: unknown }
        } catch {
          throw new WireInError(
            `回放档：${at}/meta.json 读不到——这一趟是第 ${mine} 次调用，而夹具里没有这一份。` +
              `夹具的形状就是 --dump-wire 落的那个形状（call-0001/ …）。`,
          )
        }
        const got = hashOf(body)
        // **这一份取证物自己得先自洽**：`request.json` 的字节与 `meta.json` 那一栏是同一把尺。
        // 改过其中一个字节的夹具走的是这一支——它连自己都对不上，不该拿去回放。
        const were = hashOf(readFileSync(join(at, 'request.json')))
        if (meta.requestHash !== were) {
          throw new WireInError(
            `回放档：${at} 这一份取证物被改过——request.json 的指纹是 ${were}，` +
              `meta.json 记的是 ${String(meta.requestHash)}。`,
          )
        }
        // **核的就是它**：这一趟真正发出去的字节，与录下来的那一份请求逐字节相同。
        if (were !== got) {
          throw new WireInError(
            `回放档：这一份不是那一次请求——${at}/request.json 记的是 ${were}，` +
              `这一趟真正发出去的是 ${got}（${body.length} 字节）。` +
              `夹具绑的是录制那一版的请求字节：前缀或契约一变它就过期，**过期不重修**（重录要真跑一趟）。`,
          )
        }
        const raw = readFileSync(join(at, 'response.sse'))
        // 录下来的响应字节与 `meta.json` 那一栏对不上：**这是一份被改过的取证物**，不是一次回放。
        if (meta.responseHash !== undefined && meta.responseHash !== hashOf(raw)) {
          throw new WireInError(
            `回放档：${at}/response.sse 与它自己的 meta.json 对不上` +
              `（记的是 ${String(meta.responseHash)}，盘上是 ${hashOf(raw)}）——这一份取证物被改过。`,
          )
        }
        for (const chunk of sseChunks(raw)) yield chunk
      })()
    },
  }
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

/**
 * 包一层：`--dump-wire` 那一档的 `CallModel`。
 *
 * **它原先收一个 `inner: CallModel` 再包在外面，那个参数已经拿掉了**：这一层要落的盘需要完整的
 * 那笔账（`raw` · `opened` · `closed`），而 `wireCall` 那一道出口只交 `{ call, failure }` 两栏
 * ——包在它外面时 `raw` 读出来是 `undefined`，落盘当场报 "data argument must be ... Received
 * undefined"。所以它自己起 `callModel`，**与产品那条路走同一个请求体、同一个适配器**，差别只在
 * 传输那一层被包了一下（`spying`）。收一个用不上的参数比不收更坏：那会让"包在谁外面"看起来
 * 还是可选的。
 */
export function makeDumpCall(dir: string, transport: Transport = fetchTransport): CallModel {
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
    // **这一层的流是它自己起的那一条**（不是包在 `inner` 外面）：落盘要的是完整的那笔账
    // ——`raw` · `opened` · `closed` 都在 `callModel` 的 `ModelStream` 上，而 `wireCall` 那一道
    // 出口只交 `{ call, failure }` 两栏（它按 `CallModel` 的形状交账）。包在它外面就落不了盘。
    const stream = callModel(request.target, wireRequestOf(request), spying, signal)
    const events: ModelEvent[] = []
    let flushed = false
    n += 1
    const mine = n

    /**
     * **把这一趟发出去与收回来的字节落盘。**幂等（落过一次就不再落），而且**成功与失败都走它**。
     *
     * 为什么不是"`ledger()` 被读的时候才落"：那样这一份取证物的存亡就挂在**调用方记不记得读账**
     * 上，而失败那一档恰恰不读——`step()` 的 `catch` 只记 `failure` 与上游那几个事实，`ledger()`
     * 一个字都不碰。于是"凭据不对"那一趟 `--dump-wire` 里**一个文件都没有**：最需要取证的那一次
     * 恰好什么都不留（实测：401 那一趟的 dump 目录是空的）。
     */
    const flush = (): void => {
      if (flushed) return
      flushed = true
      const l = stream.ledger()
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
            // **这一份是走完了还是断在半路**：`failure` 那一栏原先只说"为什么断"，读的人分不清
            // "这一趟根本没跑起来"（请求就没发出去）与"跑到第 7 条断了"。这一栏把三档分开。
            outcome: l.call !== null ? 'done' : l.failure !== null ? 'failed' : 'partial',
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
          '3. `meta.json` 的 `outcome` 与 `failure`：`done` 是走完的那一趟，`failed` 是断在半路',
          '   （`response.sse` 里是断之前收到的字节），`partial` 是既没走完也没留下原因（少见）。',
          '4. `response.sse` 是上游的原始字节：录一份夹具就是照它写的（`src/model/session.ts`）。',
          '',
          '**失败那一路也落**：这条命令的用处一半在"为什么没成"，所以 401/400 那一趟同样有',
          '`request.json` 与 `response.sse`（后者就是上游那句原话）。',
          '',
          '**它不在工作区里**（落进 `<realRoot>` 会被下一轮的 fork 当成漂移）。看完就删。',
          '',
        ].join('\n'),
      )
    }

    const iter = (async function* (): AsyncGenerator<ModelEvent> {
      try {
        for await (const e of stream.events) {
          events.push(e)
          yield e
        }
      } finally {
        // **迭代停下来就把这一趟落下来**（正常走完、抛出、或消费方提前走开都到这）：这一份
        // 取证物不该依赖"调用方记得读账"——失败那一档的调用方恰好不读。
        flush()
      }
    })()

    return {
      events: iter,
      ledger: () => {
        flush()
        return stream.ledger()
      },
    }
  }
}

/**
 * 一次调用 → 那一条线协议认的那份请求。**两个入口共用这一处**：`runtime/step.ts` 的
 * `wireCallOver`（产品那一趟）与这一份的 `makeDumpCall`（取证那一趟）。
 *
 * 两处各拼一遍的症状是"发出去的"与"落盘的"不是同一份，而回放档正是拿落盘那一份去核发出去
 * 那一份（`requestHash`）——差一个字段就是一次静默的"这一份不是那一次请求"。
 *
 * `promptCache` 从**线协议那一栏**取（`promptCacheFor`），不给调用方一个自己填的机会：那一栏
 * 的取值处只有 `WIRES`。
 */
export function wireRequestOf(request: {
  readonly adapter: { readonly name: string }
  readonly prefix: { readonly zoneA: Uint8Array; readonly zoneB: Uint8Array; readonly zoneC: Uint8Array }
  readonly model: string
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[]
  readonly turns?: readonly Turn[]
  /** C 区那一段的**头**（人说的那一句）：有轮次时它照旧要发。见 `wireHeadOf`。 */
  readonly cHead?: Uint8Array
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number; readonly thinking?: ThinkingLevel }
}): ModelRequest {
  return {
    model: request.model,
    zones: { A: request.prefix.zoneA, B: request.prefix.zoneB, C: request.prefix.zoneC },
    promptCache: promptCacheFor(request.adapter.name),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.turns === undefined || request.turns.length === 0 ? {} : { turns: request.turns }),
    ...(request.cHead === undefined ? {} : { cHead: request.cHead }),
    ...(request.call === undefined ? {} : { call: request.call }),
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
