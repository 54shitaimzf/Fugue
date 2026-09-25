#!/usr/bin/env node
// 核对一份 `--dump-wire` 目录：**它落的每一份原始字节，用自己的那条产品路重放一遍**。
//
// 跑法：cd ~/fugue && node tools/verify-wire-dump.ts <dump 目录> [<agent 日志>.jsonl ...]
//
// 由头（这一份是**线上那一次缺陷的固化**）：`--dump-wire` 落的是"发出去的那串字节 + 收回来
// 的那串字节 + 那一次的三区指纹"，而它的 `README` 里写着三步取值顺序。这一份把那三步变成一条
// 命令——否则那三步是"照着 README 手敲"，而手敲的东西不会在改动之后自己变红。
//
// 每一份 `call-NNNN/` 核这几样：
//   一 · `request.sha256` / `response.sha256` 与盘上的字节对得上（**落下来的没被改过**）
//   二 · 请求体是 JSON、`stream` 是 `true`（**"流式是一个请求侧的声明"**——2026-XX 那次线上
//        取证就是这一栏不在：上游回一条整的 JSON，`dataRecords` 解出 0 条事件）
//   三 · 请求体再过一遍 `stableJson` 与盘上那份**逐字节相同**（键序没漂、不是手写的）
//   四 · `meta.outcome` 那一栏决定这一份该怎么读：
//        · `done` —— 回来的字节交给 `t.wire` 的 `parseStream` 走一遍：事件数 · 结束原因 · 用量
//          三样与 `meta.json` 对得上（**用产品自己的解析路，不用探针另写的那套**）
//        · `failed` —— 半截那一档：**那些 checks 一条都不做**（没有事件可言），只核"它为什么断"
//          与 `meta.failure` 说的是同一件事、以及 `response.sse` 里留着上游那句话
//   五 · `meta.json` 的三条 `zone*Hash` 与 `prefix/assemble` 那一条日志逐字段相同（给了日志才核）
//
// 退出码：0 全过 · 1 有任何一条不过（**报出来再退**，不修）。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { hashOf } from '../src/assemble/assemble.ts'
import { checkEvents } from '../src/model/contract.ts'
import type { ModelEvent } from '../src/model/contract.ts'
import { stableJson, parseStream } from '../src/model/wire/stream.ts'
import { wireNamed } from '../src/model/wire/registry.ts'

const dir = process.argv[2]
const logs = process.argv.slice(3)
if (dir === undefined || dir === '') {
  console.error('跑法：node tools/verify-wire-dump.ts <dump 目录> [<agent 日志>.jsonl ...]')
  process.exit(2)
}
const bad: string[] = []
const ok = (s: string): void => console.log('  ok   ' + s)
const no = (s: string): void => {
  bad.push(s)
  console.log('  FAIL ' + s)
}

/** `sha256sum` 那种格式的文件里那一串。`dump` 落的**是标准 sha256**（不是 `hashOf` 那种短指纹）。 */
const sumIn = (file: string): string => readFileSync(file, 'utf8').trim().split(/\s+/)[0] ?? ''
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

// 日志里那些 `prefix/assemble`（`meta.json` 里没有 agent 那一栏，所以按"哪个日志的第几条"归拢）。
const zoneOf = new Map<string, { zoneAHash: string; zoneBHash: string; zoneCHash: string }>()
for (const l of logs) {
  if (!existsSync(l)) {
    no('日志不在：' + l)
    continue
  }
  for (const line of readFileSync(l, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    // **事件的字段是平铺在信封上的**（`{seq, writer, crc, t, …}`——`log/events.ts` 那一层），
    // 不是裹在一栏 `event` 里。读错了不报错，只是"一条日志都没匹配上"——三区那一条于是永远
    // 走"没给日志"那一档（实测：给了日志也跳过，而输出看起来很正常）。
    const rec = JSON.parse(line) as { writer?: string; t?: string } & Record<string, unknown>
    if (rec.t !== 'prefix/assemble') continue
    zoneOf.set(l + '|' + String(rec.writer) + '|' + String(zoneOf.size), {
      zoneAHash: String(rec['zoneAHash']),
      zoneBHash: String(rec['zoneBHash']),
      zoneCHash: String(rec['zoneCHash']),
    })
  }
}

const calls = readdirSync(dir).filter((n) => /^call-\d+$/.test(n)).sort()
if (calls.length === 0) no(dir + ' 里一份 call-NNNN 都没有')
console.log('核对 ' + dir + '：' + calls.length + ' 次调用\n')

/** 三区指纹与日志那一条对（成功与失败两档都要核：装配是同一份）。 */
function checkZones(meta: Record<string, unknown>): void {
  if (zoneOf.size === 0) {
    console.log('  ·    （没给日志：三区指纹那一条跳过）')
    return
  }
  const hit = [...zoneOf.values()].some(
    (z) => z.zoneAHash === String(meta['zoneAHash']) && z.zoneBHash === String(meta['zoneBHash']) && z.zoneCHash === String(meta['zoneCHash']),
  )
  if (hit) ok('三区指纹与 prefix/assemble 对得上（' + String(meta['zoneAHash']) + '/' + String(meta['zoneBHash']) + '/' + String(meta['zoneCHash']) + '）')
  else no('三区指纹在日志里找不到：' + String(meta['zoneAHash']) + '/' + String(meta['zoneBHash']) + '/' + String(meta['zoneCHash']))
}

let sumInBytes = 0
let sumOutBytes = 0
let sumInput = 0
let sumCacheRead = 0
let sumCacheWrite = 0
let sumOutput = 0
let cut = 0
for (const name of calls) {
  const at = join(dir, name)
  const meta = JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8')) as Record<string, unknown>
  const reqBytes = readFileSync(join(at, 'request.json'))
  const resBytes = readFileSync(join(at, 'response.sse'))
  const outcome = meta['outcome'] === undefined ? '' : String(meta['outcome'])
  sumInBytes += reqBytes.length
  sumOutBytes += resBytes.length
  console.log(
    name + '：' + String(meta['model']) + '（' + String((meta['target'] as Record<string, unknown>)['wire']) + '）· ' +
      '请求 ' + reqBytes.length + ' 字节 · 响应 ' + resBytes.length + ' 字节 · outcome=' +
      (outcome === '' ? '（没有这一栏）' : outcome) + ' · events=' + String(meta['events']) + ' · stop=' + String(meta['stop']),
  )

  // 一 · 两份 sha256（**失败那一路的标准与成功那一路一样**：这一份取证物不该因为断了就松）
  if (sumIn(join(at, 'request.sha256')) === sha256(reqBytes)) ok('request.sha256 与盘上字节对得上（' + sha256(reqBytes).slice(0, 12) + '…）')
  else no('request.sha256 与盘上字节对不上——这一份落下来之后被改过')
  if (sumIn(join(at, 'response.sha256')) === sha256(resBytes)) ok('response.sha256 与盘上字节对得上')
  else no('response.sha256 与盘上字节对不上')
  if (meta['requestHash'] === hashOf(reqBytes)) ok('meta.requestHash = ' + hashOf(reqBytes))
  else no('meta.requestHash（' + String(meta['requestHash']) + '）与盘上字节（' + hashOf(reqBytes) + '）不同')

  // 二 · 请求体：JSON · stream=true
  let body: Record<string, unknown> | null = null
  try {
    body = JSON.parse(new TextDecoder().decode(reqBytes)) as Record<string, unknown>
  } catch (err) {
    no('请求体不是 JSON：' + (err as Error).message)
  }
  if (body !== null) {
    if (body['stream'] === true) ok('请求体里 stream = true（流式是一个请求侧的声明）')
    else no('请求体里 stream 不是 true：' + JSON.stringify(body['stream']) + '——上游会回一条整的 JSON')

    // 三 · 键序是 `stableJson` 那一套（再序列化一次逐字节相同）。
    const onDiskText = new TextDecoder().decode(reqBytes)
    const againText = stableJson(body)
    if (againText === onDiskText) ok('再序列化一次逐字节相同（键序没漂）')
    else no('再序列化之后与盘上那份不同：' + againText.slice(0, 80) + ' vs ' + onDiskText.slice(0, 80))

    const msgs = body['messages']
    if (Array.isArray(msgs) && msgs.length > 0) ok('messages ' + msgs.length + ' 条（不为空）')
    else no('messages 是空的——Messages 那条线上游会 400（"at least one message is required"）')
    const tools = body['tools']
    if (Array.isArray(tools)) ok('工具目录 ' + tools.length + ' 条')
  }

  // 四之一 · **断在半路那一档**：没有事件可解析，只核"它为什么断"。
  // 判据是 `meta.outcome`（不是"有没有 stop"）：这一档的 `response.sse` 是**上游的原话**
  // （非 2xx 时就是那句"凭据不对"），所以它不许是空的。
  if (outcome === 'failed' || outcome === 'partial') {
    cut += 1
    const failure = meta['failure'] === null || meta['failure'] === undefined ? '' : String(meta['failure'])
    if (failure === '') no('outcome 是 ' + outcome + '，而 meta.failure 是空的——没写清为什么断')
    else ok('它为什么断：' + failure.slice(0, 140))
    if (resBytes.length === 0) no('outcome 是 ' + outcome + '，而 response.sse 是空的——上游那句话一个字都没留下')
    else ok('response.sse ' + resBytes.length + ' 字节（断之前收到的那些，上游原话在里面）')
    if (!(meta['stop'] === null || meta['stop'] === undefined)) no('断在半路的那一趟不该有收尾原因，meta.stop 是 ' + String(meta['stop']))
    checkZones(meta)
    continue
  }

  // 四之二 · 走完那一档：回来的字节走产品自己的解析路
  const wire = wireNamed(String((meta['target'] as Record<string, unknown>)['wire']))
  const events: ModelEvent[] = []
  let threw: string | null = null
  try {
    const chunks = (async function* (): AsyncGenerator<Uint8Array> {
      yield resBytes
    })()
    for await (const e of parseStream(wire, chunks)) events.push(e)
  } catch (err) {
    threw = (err as Error).name + ': ' + (err as Error).message
  }
  if (threw !== null) {
    no('解析这串响应时报错：' + threw)
    continue
  }
  if (events.length === Number(meta['events'])) ok('解析出 ' + events.length + ' 条事件（与 meta.events 相同）')
  else no('解析出 ' + events.length + ' 条事件，meta.events 说 ' + String(meta['events']))
  const call = checkEvents(events)
  if ((call.stop ?? null) === (meta['stop'] ?? null)) ok('结束原因 ' + String(call.stop) + '（与 meta.stop 相同）')
  else no('结束原因 ' + String(call.stop) + ' ≠ meta.stop ' + String(meta['stop']))
  const u = call.usage
  if (u === null || u === undefined) {
    no('这一趟没有用量读数（usage 是 null）——账是空的')
  } else {
    sumInput += u.inputTokens ?? 0
    sumCacheRead += u.cacheReadTokens ?? 0
    sumCacheWrite += u.cacheWriteTokens ?? 0
    sumOutput += u.outputTokens ?? 0
    ok(
      '用量 输入 ' + String(u.inputTokens) + ' · 命中 ' + String(u.cacheReadTokens) + ' · 写缓存 ' +
        String(u.cacheWriteTokens) + ' · 输出 ' + String(u.outputTokens) + ' · 它说它是 ' + String(u.model),
    )
  }
  ok('工具调用 ' + call.toolCalls.length + ' 条 · 文本 ' + call.text.length + ' 字 · 结束原因的原话 ' + String(call.rawStop))

  // 五 · 三区指纹与 `prefix/assemble` 那条日志
  checkZones(meta)
}

console.log(
  '\n合计：请求 ' + sumInBytes + ' 字节 · 响应 ' + sumOutBytes + ' 字节 · ' +
    '输入 ' + sumInput + '（命中 ' + sumCacheRead + ' · 写 ' + sumCacheWrite + '）· 输出 ' + sumOutput + ' token' +
    (cut === 0 ? '' : ' · 其中断在半路 ' + cut + ' 次'),
)
console.log(
  bad.length === 0
    ? '\n全部通过（' + calls.length + ' 份' + (cut === 0 ? '' : '，含断在半路 ' + cut + ' 份') + '）'
    : '\n不通过 ' + bad.length + ' 处：\n' + bad.map((b) => '  - ' + b).join('\n'),
)
console.log('  这一份只读、只报，不修。')
process.exit(bad.length === 0 ? 0 : 1)
