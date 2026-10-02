// 额外的合成目录兼容回放；从不可变历史种子派生，不代替真实 live 录制验收。
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, lstatSync, writeFileSync } from 'node:fs'
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

/** 一条调用相对历史种子的派生账。changed 不表示本次是否写盘。 */
export interface AdaptedCall {
  readonly call: string
  readonly sourceRequestSha256: string
  readonly sourceMetaSha256: string
  readonly requestSha256: string
  readonly requestHash: string
  readonly requestBytes: number
  readonly responseSha256: string
  readonly changed: boolean
}

export interface Adaptation {
  readonly kind: 'offline-catalog-adaptation'
  readonly sourceCommit: string
  readonly sourceManifestSha256: string
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
    sourceMetaSha256: sha256(readFileSync(join(at, 'meta.json'))),
    requestSha256: sha256(body),
    requestHash: hashOf(body),
    requestBytes: body.length,
    responseSha256: sha256(response),
    changed: !Buffer.from(body).equals(old),
  }
}

export interface AdaptationResult extends Adaptation {
  /** 本次实际改写的文件数；不进入确定性的 provenance。 */
  readonly writtenFiles: number
}
const ORIGINAL_COMMIT = 'e02fa524579bbd6332278e21a27b15c7b12c4b05'
const ORIGINAL_MANIFEST_SHA256 = '62aa94ffd198b92a359e3fff5a42c40f1bbbae6119949fdf4b3e33d97da21a10'
const ORIGINAL_FILE = /^(?:scenario\.json|wire\/call-\d{4}\/(?:README|meta\.json|request\.json|request\.sha256|response\.sse|response\.sha256))$/

/** 本地静态别名拒绝：不跟随夹具内的目录/叶软链，不写共享inode。 */
function plainFile(root: string, relative: string): void {
  let path = root
  if (!lstatSync(path).isDirectory()) throw new Error('fixture root is not a plain directory')
  const parts = relative.split('/')
  for (let at = 0; at < parts.length; at++) {
    path = join(path, parts[at])
    const meta = lstatSync(path)
    if (at === parts.length - 1 ? !meta.isFile() || meta.nlink !== 1 : !meta.isDirectory()) {
      throw new Error('aliased or unsupported fixture path: ' + relative)
    }
  }
}

/** 先验证全部种子与不可改写的响应/场景，失败时不写任何目标。 */
export function adaptWireIn(root: string, write: boolean = true): AdaptationResult {
  const original = join(root, 'original'), wire = join(root, 'wire')
  plainFile(root, 'original/manifest.json')
  const manifestBytes = readFileSync(join(original, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { sourceCommit: string; files: Record<string, string> }
  if (sha256(manifestBytes) !== ORIGINAL_MANIFEST_SHA256 || manifest.sourceCommit !== ORIGINAL_COMMIT || typeof manifest.files !== 'object' || manifest.files === null) {
    throw new Error('missing or unsupported immutable wire source manifest')
  }
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!ORIGINAL_FILE.test(path) || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid original evidence path')
    plainFile(root, 'original/' + path); plainFile(root, path)
    if (sha256(readFileSync(join(original, path))) !== hash) {
      throw new Error('original wire evidence changed: ' + path)
    }
    if (!/\/(?:request\.json|request\.sha256|meta\.json)$/.test(path) &&
        !readFileSync(join(root, path)).equals(readFileSync(join(original, path)))) {
      throw new Error('historical response/scenario evidence changed: ' + path)
    }
  }
  const names = callsIn(join(original, 'wire'))
  if (names.length === 0 || JSON.stringify(names) !== JSON.stringify(callsIn(wire))) throw new Error('wire call set differs from original')
  const calls: AdaptedCall[] = [], outputs = new Map<string, Uint8Array>()
  for (const name of names) {
    const seed = join(original, 'wire', name), target = join(wire, name)
    for (const file of ['README', 'meta.json', 'request.json', 'request.sha256', 'response.sse', 'response.sha256']) {
      if (!Object.hasOwn(manifest.files, `wire/${name}/${file}`)) throw new Error('incomplete original wire manifest')
    }
    const seedRequest = JSON.parse(readFileSync(join(seed, 'request.json'), 'utf8')) as Record<string, unknown>
    const targetRequest = JSON.parse(readFileSync(join(target, 'request.json'), 'utf8')) as Record<string, unknown>
    if (stableJson({ ...targetRequest, tools: seedRequest.tools }) !== stableJson(seedRequest)) {
      throw new Error('historical noncatalog request evidence changed: ' + name)
    }
    const targetMeta = JSON.parse(readFileSync(join(target, 'meta.json'), 'utf8')) as Record<string, unknown>
    const originalMeta = JSON.parse(readFileSync(join(seed, 'meta.json'), 'utf8')) as Record<string, unknown>
    for (const field of ['requestBytes', 'requestHash', 'zoneAHash']) { delete targetMeta[field]; delete originalMeta[field] }
    if (stableJson(targetMeta) !== stableJson(originalMeta)) throw new Error('historical metadata evidence changed: ' + name)
    const got = adaptedCallOf(seed, name), body = adaptedRequestOf(readFileSync(join(seed, 'request.json')))
    const meta = JSON.parse(readFileSync(join(seed, 'meta.json'), 'utf8')) as Record<string, unknown>
    const request = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>
    const zoneA = zoneAOf(request['system'])
    calls.push(got)
    outputs.set(join(target, 'request.json'), body)
    outputs.set(join(target, 'request.sha256'), Buffer.from(`${got.requestSha256}  request.json\n`))
    outputs.set(join(target, 'meta.json'), Buffer.from(JSON.stringify({
      ...meta, requestBytes: got.requestBytes, requestHash: got.requestHash,
      ...(zoneA === null ? {} : { zoneAHash: hashOf(zoneA) }),
    }, null, 2) + '\n'))
  }
  const adaptation: Adaptation = {
    kind: 'offline-catalog-adaptation', sourceCommit: ORIGINAL_COMMIT,
    sourceManifestSha256: sha256(manifestBytes),
    catalogHash: catalogHash(catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])),
    liveRequestSent: false, historicalResponseAndUsage: true, calls,
  }
  plainFile(root, 'provenance.json')
  outputs.set(join(root, 'provenance.json'), Buffer.from(JSON.stringify(adaptation, null, 2) + '\n'))
  // 所有目标存在与差异也先快照；最后一条坏了不能造成前面半套改写。
  const updates = [...outputs].filter(([path, bytes]) => !readFileSync(path).equals(Buffer.from(bytes)))
  if (write) for (const [path, bytes] of updates) writeFileSync(path, bytes)
  const writtenFiles = write ? updates.length : 0
  return { ...adaptation, writtenFiles }
}
