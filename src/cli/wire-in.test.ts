// wire-in 夹具**请求侧的对齐**（fast 档）。出处：架构 § 8.10 硬纪律 1（公布面 = 兑现面）·
// 目录对真话那一站（U3）。跑法：cd ~/fugue && node --test src/cli/wire-in.test.ts
//
// **为什么要有这一条**：目录描述进请求字节，于是改一句描述就让 `chain.test.ts` 序 1（real 档唯一
// 的那条端到端验收）过期——它发现得晚，而且发现时报的是"这一份不是那一次请求"。这一条把"对齐"
// 挪到 fast 档：描述再漂，这里当场红，离线改齐脚本就在隔壁（`tools/align-wire-in.ts`）。
//
// 量四件事：`tools` 那一栏就是当前目录在该线型上的投影（逐字节）· 派生那几栏算得出来（
// `requestBytes`/`requestHash`/`request.sha256`）· A 区**复算**得出来且与录的相同 · 响应那一边
// 自己自洽且**永不改**（改过就当场拒——产品那条规矩在 `wireInTransport` 里，这一条量盘上的还没被改过）。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { hashOf, toolsValueOf, valueSpanOf, zoneAOf } from '../../test/helpers/wire-in.ts'

const WIRE = fileURLToPath(new URL('./__fixture__/wire-in/wire/', import.meta.url))
const CALLS = readdirSync(WIRE).sort()

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const ALIGN = 'node tools/align-wire-in.ts'

test('wire-in 的请求侧与当前工具目录对齐，且那一份取证物自己自洽（响应永不改）', () => {
  assert.ok(CALLS.length > 0, `夹具里一份调用都没有：${WIRE}`)
  let bytes = 0
  for (const call of CALLS) {
    const at = join(WIRE, call)
    const raw = readFileSync(join(at, 'request.json'), 'utf8')
    const meta = JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8')) as {
      target: { wire: string }
      requestBytes: number
      requestHash: string
      zoneAHash: string
      responseBytes: number
      responseHash: string
      tools: number
    }
    const body = new Uint8Array(Buffer.from(raw, 'utf8'))

    // 一 · `tools` 那一栏就是当前目录在这条线型上的投影（形状由适配器给，两边都逐字节比）。
    const span = valueSpanOf(raw, 'tools')
    assert.ok(span !== null, `${call}：request.json 里没有顶层 tools 那一栏`)
    assert.equal(
      raw.slice(span.start, span.end),
      toolsValueOf(meta.target.wire),
      `${call}：${meta.target.wire} 上的 tools 那一栏与当前工具目录不同——跑 \`${ALIGN}\` 离线改齐`,
    )

    // 二 · 跟着派生的那几栏都算得出来（不是抄下来的）。
    assert.equal(meta.requestBytes, body.byteLength, `${call}：meta.json 的 requestBytes`)
    assert.equal(meta.requestHash, hashOf(body), `${call}：meta.json 的 requestHash`)
    assert.equal(
      readFileSync(join(at, 'request.sha256'), 'utf8'),
      `${sha256Hex(body)}  request.json\n`,
      `${call}：request.sha256 与盘上那一份对不上`,
    )

    // 三 · A 区**复算**（算出来，不假定它不变）。
    const zoneA = zoneAOf(JSON.parse(raw))
    assert.ok(zoneA !== null, `${call}：这份请求里看不出 A 区`)
    assert.equal(meta.zoneAHash, hashOf(zoneA), `${call}：meta.json 的 zoneAHash 与复算的不同`)

    // 四 · 响应那一边：自洽，且这一条量的是"它还没被改过"（**响应永不改**）。
    const sse = readFileSync(join(at, 'response.sse'))
    assert.equal(meta.responseBytes, sse.byteLength, `${call}：meta.json 的 responseBytes`)
    assert.equal(meta.responseHash, hashOf(sse), `${call}：meta.json 的 responseHash 与盘上对不上——这一份取证物被改过`)
    assert.equal(
      readFileSync(join(at, 'response.sha256'), 'utf8'),
      `${sha256Hex(sse)}  response.sse\n`,
      `${call}：response.sha256 与盘上那一份对不上`,
    )
    bytes += body.byteLength
  }
  console.log(
    `wire-in 对齐读数：${CALLS.length} 份调用 · 请求合计 ${bytes} 字节 · tools 那一栏逐字节等于当前目录投影 · ` +
      `requestHash/zoneAHash 复算相符 · 响应自洽且一个字节没动`,
  )
})
