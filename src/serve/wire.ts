// serve 的**线协议**：stdio 上一行一调用的 JSON-RPC 2.0 报文。出处：架构 § 9.11
// 「**方法面**」那一段——传输是 stdio 上的 JSON-RPC 2.0 报文，一次调用一行；JSON-RPC 2.0 与传输
// 无关、不定分帧，「一行一调用」是本站的传输约定（换到网络档时换的是这条约定，报文形状不动）。
//
// 这一份只做两件事：**把一行字解析成一次调用** · **把一次回答编成一行字**。方法名到命令的对应
// 关系不在这里（`registry.ts` 的 `methodOf` 从 § 9.6 派生）。
//
// 错误码分两段（§ 9.11 那张表）：
//
//   · `-32700` 解析错 · `-32600` 非法请求 · `-32601` 方法不存在 · `-32602` 参数或版本非法
//     ——这条调用本身不成立（对 § 9.8 的退出码 2）；
//   · `-32000` 命令失败（退出码 1）· `-32001` 被边界拒绝（退出码 3）。
//
// **报文顶层不放私有栏**：基范让给实现的位置只有两处——方法自己的空间（`params` 的成员名）与
// 错误的扩展位（`error.data`）。协议版本住在每一次调用上（`params._protocol`），不住在会话上。

/** 协议版本的栏名。**下划线是「这不是任何一条命令的参数」那个记号**。 */
export const PROTOCOL_PARAM = '_protocol'

/** JSON-RPC 2.0 的版本栏——报文的版本，与本站的协议版本（`params._protocol`）是两件事。 */
export const JSONRPC = '2.0'

export type RpcId = string | number | null

export interface RpcError {
  readonly code: number
  readonly message: string
  /** 基范留给实现的位置（§ 9.11）：`hint` · `subject` · 版本拒的时候那个 `supported`。 */
  readonly data?: Record<string, unknown>
}

export interface RpcRequest {
  readonly id: RpcId
  readonly method: string
  /** 方法自己的空间 + 那一栏 `_protocol`（解析之后**原样**带着，判定在调用方）。 */
  readonly params: Record<string, unknown>
}

export type Parsed = { readonly ok: true; readonly req: RpcRequest } | { readonly ok: false; readonly err: RpcError; readonly id: RpcId }

/** 版本拒（§ 9.11）：错误码 `-32602` + `data.supported` 报出服务端支持的版本列表。 */
export function versionRefused(got: unknown, supported: readonly string[]): RpcError {
  return {
    code: -32602,
    message: `协议版本不认得：${JSON.stringify(got)}——这一份支持 ${supported.join(' · ')}`,
    data: { hint: `在 params 里带上 ${PROTOCOL_PARAM}：${JSON.stringify(supported[0])}`, supported: [...supported] },
  }
}

/**
 * 一行字 → 一次调用。
 *
 * 判据按基范逐条走：解析不动是 `-32700`（id 给 `null`）· 不是一个对象或者 `method` 不是字符串是
 * `-32600` · 给了 `id` 而它不是字符串/数字/`null` 也是 `-32600`。**通知**（没有 `id`）也算一次
 * 调用，只是服务端不必回答——壳那边按 `id === null` 认它。
 */
export function parseLine(line: string): Parsed {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch (err) {
    return { ok: false, err: { code: -32700, message: `解析不动：${(err as Error).message}` }, id: null }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, err: { code: -32600, message: '报文要是一个对象：{"jsonrpc":"2.0","id":…,"method":…}' }, id: null }
  }
  const o = v as Record<string, unknown>
  const id = o.id === undefined ? null : (o.id as RpcId)
  if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return { ok: false, err: { code: -32600, message: '`id` 要是一个字符串 · 数字，或者不给（通知）' }, id: null }
  }
  if (typeof o.method !== 'string' || o.method === '') {
    return { ok: false, err: { code: -32600, message: '`method` 要是一个非空字符串' }, id }
  }
  const raw = o.params
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, err: { code: -32602, message: '`params` 要是一个对象' }, id }
  }
  return { ok: true, req: { id, method: o.method, params: (raw ?? {}) as Record<string, unknown> } }
}

/** 一次成功的回答（一行）。 */
export function encodeResult(id: RpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSONRPC, id, result }) + '\n'
}

/** 一次失败的回答（一行）。错误形状是 `{ code, message, hint, subject }`（§ 9.8 那张表）装进
 * JSON-RPC 的 `error`：`code` 与 `message` 是基范标准化的两栏，`hint` 与 `subject` 住 `data`。 */
export function encodeError(id: RpcId, err: RpcError): string {
  return (
    JSON.stringify({
      jsonrpc: JSONRPC,
      id,
      error: {
        code: err.code,
        message: err.message,
        ...(err.data === undefined ? {} : { data: err.data }),
      },
    }) + '\n'
  )
}

/** 命令失败那一档的错误（§ 9.11 那张表：`-32000` 命令失败 · `-32001` 被边界拒绝）。 */
export function commandFailure(code: 1 | 2 | 3, message: string, hint?: string, subject?: string): RpcError {
  const rpc = code === 2 ? -32602 : code === 3 ? -32001 : -32000
  const data: Record<string, unknown> = {}
  if (hint !== undefined) data.hint = hint
  if (subject !== undefined) data.subject = subject
  return { code: rpc, message, ...(Object.keys(data).length === 0 ? {} : { data }) }
}
