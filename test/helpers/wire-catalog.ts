// 回放夹具里那份**工具目录** → 当前 `catalog()` 的那一份，**离线**改齐（不碰网、不读凭据）。
//
// 为什么要有这一层。`--wire-in` 按**请求字节逐字**核对（`src/model/http.ts` 的 `wireInTransport`），
// 而工具目录的描述是请求字节的一部分。于是每改一句描述，录下来的那份请求就过期，`src/cli/chain.test.ts`
// 序 1（验收照过 · 产物逐字节 · 每条调用逐条对上 · 围栏 full · 停因收敛）**一条都不再执行**——
// 合并闸门长期红，而这一轮唯一的端到端验收就这么没了。
//
// **这不是"重录"**：重录要真跑一趟（出网 · 凭据 · 花钱）。这一份只做一件可逐字节复算的事：
// 把 `tools` 那一栏换成当前目录的投影，再按产品那把序列化器（`stableJson`）重写请求字节。
// 响应（`response.sse`）· usage · timings · `messages` · 三区内容**一个字节都不碰**，
// `provenance.json` 里把这件事写明白：请求是离线适配的，响应是历史的。
//
// **它必须跟着整份目录走，不是跟着某两条工具走。** 任何一条描述或 schema 改了都要在这里被照见，
// 否则下一次漂移又得靠 `full` 档的 real 测试去发现（那已经是最贵的那一道）。
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashOf } from '../../src/assemble/assemble.ts'
import { CATALOG_STATES, catalog, catalogHash } from '../../src/tools/catalog.ts'
import { stableJson } from '../../src/model/wire/stream.ts'

/** `sha256sum -c` 认得的那一把（与 `meta.json` 里 16 个字符的短指纹不是同一把）。 */
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** 一个 `--dump-wire` 目录里的调用子目录（`call-0001` …），按发生次序。 */
export function callsIn(wire: string): string[] {
  return readdirSync(wire)
    .filter((name) => /^call-\d{4}$/.test(name) && statSync(join(wire, name)).isDirectory())
    .sort()
}

/**
 * 录下来的一条工具条目是哪条线的形状 → 当前目录在同一形状下的投影。
 *
 * **判形状，不判名字**：两条线各有一种（`src/model/wire/anthropic.ts` 的 `{name, description,
 * input_schema}` · `src/model/wire/openai.ts` 的 `{type:'function', function:{…}}`），而夹具里
 * 记的是哪条线要看 `meta.json`——形状自己就说得清，不必再读一份元数据。
 */
function toolsLike(recorded: readonly unknown[]): unknown[] {
  const entries = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
  const first = (recorded[0] ?? {}) as Record<string, unknown>
  if ('input_schema' in first) {
    return entries.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
  if ('function' in first) {
    return entries.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
  throw new Error(`录下来的 tools 不是这两条线里的任何一种形状：${JSON.stringify(first).slice(0, 120)}`)
}

/**
 * A 区的字节：`meta.json` 的 `zoneAHash` 是 `hashOf(request.prefix.zoneA)`，而发出去的请求里
 * 它落成顶层的 `system`。隐式缓存那一档是一串纯文本，**从它能逐字节复算回 A 区**；显式断点
 * 那一档是内容块数组，拼法不止一种——那一档不猜，`zoneAHash` 原样留着。
 */
function zoneAOf(system: unknown): Uint8Array | null {
  return typeof system === 'string' ? Buffer.from(system, 'utf8') : null
}

/** 一条调用适配前后的账。`changed === false` 就是"盘上那一份已经与当前目录一致"。 */
export interface AdaptedCall {
  readonly call: string
  readonly sourceRequestSha256: string
  readonly requestSha256: string
  readonly requestHash: string
  readonly requestBytes: number
  readonly responseSha256: string
  readonly changed: boolean
}

export interface Adaptation {
  readonly kind: 'offline-catalog-adaptation'
  readonly catalogHash: string
  readonly liveRequestSent: false
  readonly historicalResponseAndUsage: true
  readonly calls: readonly AdaptedCall[]
}

/** 一条录下来的请求 → 同一份请求、但 `tools` 换成当前目录。**只有这一栏会变。** */
export function adaptedRequestOf(recorded: Uint8Array): Uint8Array {
  const request = JSON.parse(Buffer.from(recorded).toString('utf8')) as Record<string, unknown>
  const tools = request['tools']
  if (!Array.isArray(tools)) throw new Error('录下来的请求里没有 tools 那一栏：这一份不是带目录的那种调用')
  request['tools'] = toolsLike(tools)
  return Buffer.from(stableJson(request), 'utf8')
}

/** 一条调用适配后那几栏派生值（不写盘，给"有没有漂"那条断言用）。 */
export function adaptedCallOf(at: string, name: string): AdaptedCall {
  const old = readFileSync(join(at, 'request.json'))
  const body = adaptedRequestOf(old)
  const response = readFileSync(join(at, 'response.sse'))
  return {
    call: name,
    sourceRequestSha256: sha256(old),
    requestSha256: sha256(body),
    requestHash: hashOf(body),
    requestBytes: body.length,
    responseSha256: sha256(response),
    changed: !Buffer.from(body).equals(old),
  }
}

/**
 * 把一个 `wire-in/` 目录就地改齐当前目录，并落一份 `provenance.json`。
 *
 * **派生栏一个不漏**：`request.json` · `request.sha256`（给 `sha256sum -c`）· `meta.json` 的
 * `requestBytes` / `requestHash`（回放与 `chain.test.ts` 逐条核的就是这两栏）· `zoneAHash`
 * （A 区从 `system` 复算；目录的描述今天不在 A 区里，所以它照理不会变——但这里**算一遍而不是
 * 假定它不变**）。`response.*` / `stop` / usage / timings 一栏都不动。
 */
export function adaptWireIn(root: string, write: boolean = true): Adaptation {
  const wire = join(root, 'wire')
  const calls: AdaptedCall[] = []
  for (const name of callsIn(wire)) {
    const at = join(wire, name)
    const got = adaptedCallOf(at, name)
    calls.push(got)
    if (!write) continue
    const body = adaptedRequestOf(readFileSync(join(at, 'request.json')))
    const meta = JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8')) as Record<string, unknown>
    const request = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>
    const zoneA = zoneAOf(request['system'])
    writeFileSync(join(at, 'request.json'), body)
    writeFileSync(join(at, 'request.sha256'), `${got.requestSha256}  request.json\n`)
    writeFileSync(
      join(at, 'meta.json'),
      JSON.stringify(
        {
          ...meta,
          requestBytes: got.requestBytes,
          requestHash: got.requestHash,
          ...(zoneA === null ? {} : { zoneAHash: hashOf(zoneA) }),
        },
        null,
        2,
      ) + '\n',
    )
  }
  const adaptation: Adaptation = {
    kind: 'offline-catalog-adaptation',
    catalogHash: catalogHash(catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])),
    liveRequestSent: false,
    historicalResponseAndUsage: true,
    calls,
  }
  if (write) writeFileSync(join(root, 'provenance.json'), JSON.stringify(adaptation, null, 2) + '\n')
  return adaptation
}
