#!/usr/bin/env node
// 把 `src/cli/__fixture__/wire-in/` 的**请求侧**按当前工具目录离线改齐。跑法：
//
//   cd ~/fugue && node tools/align-wire-in.ts
//
// **政策（这一份的头注就是那条政策的落点）**：目录字节漂了就**离线改齐**——可逐字节复算 ·
// 不出网 · 不读凭据；**录下来的响应被改过就当场拒**（产品规则不松：`wireInTransport` 那条
// "这一份取证物被改过"照旧拦）。这取代 `tools/record-wire-in.sh` 头注里"要新的就真跑一趟重录"
// 作为**描述类漂移**的缺省处置；真跑重录仍留给两种天——**响应侧**要新证据（要新的模型行为对照），
// 或者动的是**参数面/语义**而不只是描述（那时旧响应不再是有意义的对照，离线改齐就成了伪造对照）。
//
// **改齐的范围**（多一个字节都不动）：`request.json` 里只有 `tools` 那一栏换成当前目录投影
// （形状由该线型的适配器自己给——判形状不判名）；跟着派生重算 `request.sha256` 与 `meta.json` 的
// `requestBytes` · `requestHash` · `tools`，并**从 `system` 复算 `zoneAHash`**（算出来，不假定它
// 不变）。`response.sse` · `response.sha256` · `messages` · `system` · usage · timings 一律不碰。
//
// **两条当场停**：A 区复算出来与录下来的不等（那说明 A 区也绑着目录字节，"只有 tools 一栏变"
// 这个前提不成立——报告，不硬改）；响应与它自己的 `meta.json` 对不上（那是一份被改过的取证物，
// 政策说这种情形当场拒）。盘上已经一致时一个字节都不写回（可反复跑）。
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashOf, toolsValueOf, valueSpanOf, zoneAOf } from '../test/helpers/wire-in.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WIRE = join(ROOT, 'src', 'cli', '__fixture__', 'wire-in', 'wire')

/** `sha256sum -c` 认得的那一把（与 `meta.json` 里那两栏的短指纹**不是同一把**）。 */
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

let changed = 0
let aligned = 0

for (const call of readdirSync(WIRE).sort()) {
  const at = join(WIRE, call)
  const requestAt = join(at, 'request.json')
  const metaAt = join(at, 'meta.json')
  const raw = readFileSync(requestAt, 'utf8')
  const metaText = readFileSync(metaAt, 'utf8')
  const meta = JSON.parse(metaText) as {
    target: { wire: string }
    requestBytes: number
    requestHash: string
    zoneAHash: string
    responseHash: string
    tools: number
    [k: string]: unknown
  }

  // 一 · **响应一个字节都不许被改过**：这是一份取证物，不是我们的输入。改过就当场拒、不写。
  const sse = readFileSync(join(at, 'response.sse'))
  if (meta.responseHash !== hashOf(sse)) {
    process.stderr.write(
      `${call}：response.sse 与它自己的 meta.json 对不上（记的是 ${meta.responseHash}，盘上是 ${hashOf(sse)}）` +
        `——这一份取证物被改过。**离线改齐只动请求侧，响应永不改**；这一份先查清楚再说。\n`,
    )
    process.exit(1)
  }

  // 二 · `tools` 那一栏换成当前目录投影（判形状不判名）。
  const span = valueSpanOf(raw, 'tools')
  if (span === null) {
    process.stderr.write(`${call}：request.json 里没有顶层 tools 那一栏。\n`)
    process.exit(1)
  }
  const want = toolsValueOf(meta.target.wire)
  const nextRaw = raw.slice(span.start, span.end) === want ? raw : raw.slice(0, span.start) + want + raw.slice(span.end)
  const body = new Uint8Array(Buffer.from(nextRaw, 'utf8'))

  // 三 · A 区**复算**（不假定它不变）。算出来不等就停——前提不成立，别硬改。
  const parsed = JSON.parse(nextRaw) as Record<string, unknown>
  const zoneA = zoneAOf(parsed)
  if (zoneA === null) {
    process.stderr.write(`${call}：这份请求里看不出 A 区（既没有顶层 system，也没有 role: system 的消息）。\n`)
    process.exit(1)
  }
  const zoneAHash = hashOf(zoneA)
  if (zoneAHash !== meta.zoneAHash) {
    process.stderr.write(
      `${call}：A 区复算出来是 ${zoneAHash}，录下来的是 ${meta.zoneAHash}——A 区也绑着目录字节。` +
        `"只有 tools 那一栏变"这个前提不成立，这一份不该离线改齐（报告给人，别硬改）。\n`,
    )
    process.exit(1)
  }

  const nextMeta = {
    ...meta,
    requestBytes: body.byteLength,
    requestHash: hashOf(body),
    zoneAHash,
    tools: Array.isArray(parsed['tools']) ? (parsed['tools'] as unknown[]).length : meta.tools,
  }
  const nextMetaText = JSON.stringify(nextMeta, null, 2) + '\n'
  const nextSha = `${sha256Hex(body)}  request.json\n`

  const did: string[] = []
  if (nextRaw !== raw) {
    writeFileSync(requestAt, nextRaw)
    did.push(`request.json（tools 那一栏 ${span.end - span.start} → ${want.length} 字节）`)
  }
  if (nextSha !== readFileSync(join(at, 'request.sha256'), 'utf8')) {
    writeFileSync(join(at, 'request.sha256'), nextSha)
    did.push('request.sha256')
  }
  if (nextMetaText !== metaText) {
    writeFileSync(metaAt, nextMetaText)
    did.push('meta.json（requestBytes · requestHash · zoneAHash · tools）')
  }
  if (did.length === 0) {
    aligned += 1
    process.stdout.write(`${call}：盘上已经一致（一个字节都没写回）\n`)
  } else {
    changed += 1
    process.stdout.write(`${call}：改齐了 ${did.join(' · ')}\n`)
  }
  process.stdout.write(
    `        request ${body.byteLength} 字节 · ${meta.target.wire} · tools ${String(nextMeta.tools)} 条 · ` +
      `requestHash ${hashOf(body)} · zoneAHash ${zoneAHash}（复算 = 录的）· response 一个字节没动\n`,
  )
}

process.stdout.write(`\n离线改齐完成：改了 ${changed} 份 · 已经一致 ${aligned} 份 · 不出网 · 不读凭据。\n`)
