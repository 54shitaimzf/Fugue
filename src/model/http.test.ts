// B3 的断言（PLAN § 5.8 的 B3 行 · 架构 § 9.7 的轨迹 · § 10.5 的录制夹具 ·
// § 8.15 的"不采集，只重算"要求事件里够算）。
// 跑法：cd ~/fugue && node --test src/model/http.test.ts
//
// **这一份里没有一条会出网**，也没有一处需要密钥：第五条断言反过来把这件事钉住——
// 环境里没有 key 的时候，夹具档照样跑完。第一条断言里的"上游"是**本机的一个 HTTP 服务**
// （`node:http`，`127.0.0.1` 上随机端口），它把那份响应**一条事件一次写入**地吐出来。
//
//   ① 上游把一个事件拆成好几个 TCP 分片时，解析出的增量与手工拼起来的相同（**不丢不重**）
//   ② 一次调用落一条 `llm/call`：模型 · 步 · 工具调用条数 · 用量四个数，且**发出去的字节与
//      装配出来的字节是同一份**（三区指纹对得上同一步的 `prefix/assemble`）
//   ③ 同一份夹具回放两次，请求体逐字节相同；连回放两次得到同一串事件
//   ④ 上游**中途掐断** → 报错并记事件，**不静默重试**、不把半个响应当完整
//   ⑤ 夹具档不取凭据（`B0` 的断言 ④ 在这一层上的落点）
//   ⑦ `--dump-wire` 那一层：**带它跑与不带它跑，发出去的字节逐字节相同**（默认档一个字节都不多）
//   ⑧ 上游非 2xx：请求号与限流那几条**留在错误上**（白名单之外的不留）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { ModelEvent } from './contract.ts'
import { PROVIDERS, checkEvents, modelDeclOf } from './contract.ts'
import { assemble, hashOf } from '../assemble/assemble.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { sourcesFor } from '../assemble/sources.ts'
import type { AgentCoord } from '../assemble/sources.ts'
import { fixtureState } from './fixture-state.ts'
import { CATALOG_STATES, catalog, catalogHash } from '../tools/catalog.ts'
import type { Target, Transport } from './http.ts'
import { callModel, fetchTransport, makeDumpCall, targetAt, targetOf, wireFactsOf } from './http.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { Fixture } from './session.ts'
import { canonicalOf, fixtureTarget, fixtureTransport, readFixture, recordOf, replayOf, requestFrom, requestOf } from './session.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const WHO: AgentCoord = { id: 'agent-1', branch: 'refs/heads/agent-1', outputPaths: ['deliver/agent-1/'] }
const DECL = modelDeclOf('deepseek-chat/anthropic')

function prefixOf(step: number) {
  return assemble({
    protocol: SUBAGENT_PROTOCOL,
    model: DECL.id,
    segments: sourcesFor(SUBAGENT_PROTOCOL, fixtureState(step), WHO),
  })
}

function fixture(name: string): Fixture {
  return readFixture(FIXTURES + name + '.json')
}

async function drain(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

/** 本机的一个假提供方：**一条事件一次写入**，于是"一个事件横跨好几个 TCP 分片"真的发生。 */
async function serveSplit(
  text: string,
  path: string,
): Promise<{ target: Target; writes: number[]; close: () => Promise<void> }> {
  const writes: number[] = []
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const rec of text.split('\n\n')) {
      if (rec === '') continue
      res.write(rec + '\n\n')
      writes.push(Buffer.byteLength(rec) + 2)
    }
    res.end()
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  return {
    target: {
      providerId: 'local',
      host: `http://127.0.0.1:${port}`,
      wire: fixtureTarget(fixture('deepseek-chat-anthropic')).wire,
      path,
      model: DECL.model,
      from: 'decl',
      headers: { 'content-type': 'application/json' },
    },
    writes,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  }
}

// ── ① 上游分片：不丢不重（与整包到达同一串事件） ────────────────────────────────

test('① 上游把一个事件拆成好几个 TCP 分片时，解析出的增量与手工拼起来的相同（不丢不重）', async () => {
  const f = fixture('deepseek-chat-anthropic')
  const served = await serveSplit(f.response, '/anthropic/v1/messages')
  try {
    const r = requestFrom(f)
    const s = callModel(served.target, r, fetchTransport)
    const overHttp = await drain(s.events)
    const ledger = s.ledger()
    const call = checkEvents(overHttp)

    // 不丢不重：与夹具里记着的那一次调用逐字段相同。
    assert.equal(call.stop, 'tool-calls')
    assert.deepEqual(
      call.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      f.record?.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
    )
    assert.equal(call.text, f.record?.text)
    assert.deepEqual(call.usage, f.record?.usage)
    assert.equal(ledger.failure, null)

    // 分片是真发生了的：上游写了 N 次（不是整包）。
    assert.ok(served.writes.length >= 8, `上游只写了 ${served.writes.length} 次——那就不叫分片了`)
    assert.ok(ledger.seen >= 8)

    // 手工那两路：同一条响应**整包**喂一次、**一次一个字节**喂一次，解出来都必须与 HTTP 那一路
    // 一模一样。**一次一字节那一路是"多字节字符横跨块边界"的实测**：那条 `data:` 行里的汉字
    // （"先看一眼工作树。"）必然被切成两半，而按块解 UTF-8 会在那里吐出替换字符、JSON 也就不成立了。
    const packed = await drain(replayOf(f, f.response.length).events)
    assert.deepEqual(packed, overHttp, '整包到达与分片到达解出来的事件不一样——分片那一层有 bug')
    const byteWise = await drain(replayOf(f, 1).events)
    assert.deepEqual(byteWise, overHttp, '一次一字节喂进去解出来的事件不一样——块边界那一层有 bug')
    assert.equal(byteWise.length, overHttp.length)
    assert.notEqual(served.writes.length, 1)
    console.log(
      `① HTTP 分片读数：${served.writes.length} 次写入（最大一片 ${Math.max(...served.writes)} 字节）· ` +
        `收到 ${overHttp.length} 条事件 · 积出 ${call.toolCalls.length} 条调用 · ` +
        `整包到达 ${packed.length} 条事件（逐条相同）`,
    )
  } finally {
    await served.close()
  }
})

// ── ② 一次调用落一条 llm/call；发出去的字节与装配出来的字节是同一份 ──────────────

test('② 一次调用落一条 llm/call：模型 · 步 · 工具调用条数 · 用量四个数，且与 prefix/assemble 对得上', async () => {
  const f = fixture('deepseek-chat-anthropic')
  const tools = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
  const prefix = prefixOf(0)
  const r = requestOf(prefix, f.target, tools, f.call)

  // **同一份**：这次装配出来的请求，与夹具里那份（录的时候装配出来的）逐字节相同。
  assert.equal(
    hashOf(new TextEncoder().encode(canonicalOf(r))),
    hashOf(new TextEncoder().encode(canonicalOf(requestFrom(f)))),
  )
  // 而条线协议上真正发出去的那一串字节，就是夹具记下来的那一串。
  const t = fixtureTarget(f)
  assert.equal(hashOf(t.wire.bytes(r)), f.bodyHash)
  assert.equal(t.wire.bytes(r).length, f.bytes)

  // 三区指纹（`B4` 会把这三个数写进 `prefix/assemble`）：同一步装配两次逐字节相同；
  // 换一步时 A 区不变、C 区变（架构 § 8.11 的验证性质在这一层的读法）。
  const again = prefixOf(0)
  assert.equal(hashOf(prefix.zoneA), hashOf(again.zoneA))
  assert.equal(hashOf(prefix.zoneB), hashOf(again.zoneB))
  assert.equal(hashOf(prefix.zoneC), hashOf(again.zoneC))
  const next = prefixOf(1)
  assert.equal(hashOf(prefix.zoneA), hashOf(next.zoneA))
  assert.notEqual(hashOf(prefix.zoneC), hashOf(next.zoneC))

  // 工具 catalog 的指纹跨状态不变（架构 § 8.10 硬纪律 2；`B0` 的读数 `cec9f01feb16de56`）。
  assert.equal(
    catalogHash(tools),
    catalogHash(catalog(CATALOG_STATES[1] as (typeof CATALOG_STATES)[number])),
    '工具目录跨状态变了——那 12 条 schema 就不是 A 区级的稳定物',
  )

  // 那一次的账 → `llm/call` 的载荷（形状在 `src/log/events.ts` 里）。
  const s = replayOf(f, 3)
  const events = await drain(s.events)
  const ledger = s.ledger()
  const record = recordOf(checkEvents(events), 0)
  const event = {
    t: 'llm/call' as const,
    agent: WHO,
    step: '0',
    model: DECL.id,
    wire: f.wire,
    toolCount: tools.length,
    invocations: record.toolCalls.length,
    usage: {
      inputTokens: record.usage?.inputTokens ?? null,
      cacheReadTokens: record.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: record.usage?.cacheWriteTokens ?? null,
      outputTokens: record.usage?.outputTokens ?? null,
    },
    rawStop: record.rawStop,
    stop: record.stop,
  }
  assert.equal(event.usage.cacheReadTokens, 24000)
  assert.equal(event.usage.outputTokens, 64)
  assert.equal(event.toolCount, 12)
  assert.equal(event.invocations, 2, '这一趟响应里拼出来两条工具调用')
  assert.equal(event.stop, 'tool-calls')
  assert.equal(event.rawStop, 'tool_use')
  // 那两条调用的名字，在**这一次公布**的目录里找得到（`B5` 接得上）。
  const published = new Set(tools.map((one) => one.name))
  for (const c of record.toolCalls) assert.ok(published.has(c.name), `${c.name} 不在公布的目录里`)

  console.log(
    `② llm/call 读数：model=${event.model} · step=${event.step} · toolCount=${event.toolCount} · ` +
      `用量 ${event.usage.inputTokens}/${event.usage.cacheReadTokens}/${event.usage.cacheWriteTokens}/${event.usage.outputTokens} · ` +
      `停因 ${event.stop}（${event.rawStop}）· 工具调用 ${record.toolCalls.length} 条 · ` +
      `请求 ${ledger.bytes} 字节（${ledger.bodyHash}）· 三区 ${hashOf(prefix.zoneA)}/${hashOf(prefix.zoneB)}/${hashOf(prefix.zoneC)}`,
  )
})

// ── ③ 回放两次：请求体逐字节相同，事件串相同 ────────────────────────────────────

test('③ 同一份夹具回放两次，请求体逐字节相同；连回放两次得到同一串事件', async () => {
  for (const name of ['deepseek-chat-anthropic', 'deepseek-chat-openai']) {
    const f = fixture(name)
    const e1 = await drain(replayOf(f, 5).events)
    const e2 = await drain(replayOf(f, 5).events)
    assert.deepEqual(e1, e2, `${name}：两次回放解出的事件不一样`)

    const b1 = fixtureTarget(f).wire.bytes(requestFrom(f))
    const b2 = fixtureTarget(f).wire.bytes(requestFrom(f))
    assert.equal(hashOf(b1), hashOf(b2))
    assert.equal(hashOf(b1), f.bodyHash, `${name}：装配出来的字节与录下来的那一串不同`)
    assert.equal(b1.length, f.bytes)
    console.log(`③ ${name}：回放两次各 ${e1.length} 条事件 · 请求体 ${b1.length} 字节（${hashOf(b1)}）`)
  }
})

// ── ④ 上游中途掐断：报错并记事件，不静默重试 ────────────────────────────────────

test('④ 上游中途掐断 → 报错并记事件，不静默重试、不把半个响应当完整', async () => {
  const f = fixture('deepseek-chat-anthropic')
  // 从中间砍掉：那条 `stop_reason`（`message_delta`）与 `message_stop` 都没了。
  const cut = f.response.slice(0, Math.floor(f.response.length * 0.6))
  let posts = 0
  const transport: Transport = {
    async *post(): AsyncGenerator<Uint8Array> {
      posts += 1
      yield new TextEncoder().encode(cut)
    },
  }
  const s = callModel(fixtureTarget(f), requestFrom(f), transport)
  let err: unknown = null
  let seen = 0
  try {
    for await (const _e of s.events) seen += 1
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof Error, '掐断的那一条流没有报错——那就会把半截的响应当完整的用')
  assert.match((err as Error).message, /stop_reason|半截/)
  const ledger = s.ledger()
  assert.equal(ledger.call, null, '半截的流不该积出一次"完整的调用"')
  assert.ok(ledger.failure !== null)
  assert.equal(ledger.seen, seen)
  assert.ok(seen > 0, '掐断之前一条事件都没收到——那这个负对照什么都没证明')
  assert.equal(posts, 1, `上游被调了 ${posts} 次——"不静默重试"这条被破坏了`)
  console.log(
    `④ 掐断读数：砍到 ${cut.length}/${f.response.length} 字节 · 收到 ${seen} 条事件后报错（${ledger.failure}）· 上游被调 ${posts} 次`,
  )
})

// ── ⑤ 夹具档不取凭据 ──────────────────────────────────────────────────────────
//
// **这一条要的是"取凭据那一步就在这条路上"**（`targetOf` 会去取，夹具档那一份不会）。它原先靠
// "跑测试的机器上恰好没有那份凭据文件"来成立——第 5 批 · 疑点 4 之后声明里有**两条**路，那份
// 文件在本机是有的（放好了的），于是"没设环境变量就抛"当场不成立。
//
// 所以这一条把**那两条路都堵掉**（环境变量删掉 · 声明里那个文件换成一个不存在的路径），
// 跑完原样放回去：判据于是变成"这条路真的会去取，而取不到就拒"，与机器上放着什么无关。
function withoutCredential<T>(run: () => T): T {
  const p = PROVIDERS['deepseek'] as { auth: readonly { from: string; name?: string; path?: string }[] }
  const keep = p.auth
  const before = process.env['DEEPSEEK_API_KEY']
  delete process.env['DEEPSEEK_API_KEY']
  p.auth = [
    { from: 'env', name: 'DEEPSEEK_API_KEY' },
    { from: 'file', path: '/nonexistent/fugue-b3-credentials' },
  ]
  try {
    return run()
  } finally {
    p.auth = keep
    if (before !== undefined) process.env['DEEPSEEK_API_KEY'] = before
  }
}

test('⑤ 夹具档不取凭据：`targetOf` 会去取（两条路都没有就拒），夹具档那一份不会', () => {
  withoutCredential(() => {
    assert.throws(
      () => targetOf('deepseek-chat/anthropic'),
      (err: unknown) => {
        // **两条路都要出现在那句话里**（只报一条会让人以为另一条不存在）。
        assert.match((err as Error).message, /DEEPSEEK_API_KEY/, (err as Error).message)
        assert.match((err as Error).message, /fugue-b3-credentials/, (err as Error).message)
        return true
      },
      '取不到凭据时 `targetOf` 却没拒',
    )
  })
  const f = fixture('deepseek-chat-anthropic')
  const t = fixtureTarget(f)
  assert.deepEqual(t.headers, {})
  assert.equal(hashOf(t.wire.bytes(requestFrom(f))), f.bodyHash)
})

// ── ⑤b 凭据"从哪取"与"目标长什么样"是两件事（给值那一档不许再取一次） ─────────────
//
// 由头（线上实测）：壳那一档 `--live --credential <工作区之外的路径>` 走 `credentialAt()`，
// 它自己读文件、读到了；可拼目标时走的是 `targetOf()`，而那一处**按提供方的声明再取一次**
// （声明的是环境变量）。于是"用文件里那份 key 跑一个轮次"根本走不通——**读到的那份没被用上**，
// 报的话却是"环境变量没有设"。这一条把"给值那一档不读环境变量"钉住。
test('⑤b targetAt：值从参数进来，不看环境变量；而没有值的那一档照旧当场拒', () => {
  const before = process.env['DEEPSEEK_API_KEY']
  delete process.env['DEEPSEEK_API_KEY']
  try {
    // 一 · 给值那一档：环境变量没设也拼得出来，头里带的就是给的那个值（**两条线各一套头**）。
    const a = targetAt('deepseek-chat/anthropic', 'k-给的值')
    assert.equal(a.headers['x-api-key'], 'k-给的值')
    assert.equal(a.headers['accept'], 'text/event-stream')
    assert.equal(a.headers['anthropic-version'], '2023-06-01')
    const o = targetAt('deepseek-chat/openai', 'k-给的值')
    assert.equal(o.headers['authorization'], 'Bearer k-给的值')
    // 目标那几栏与声明一致（"给值"不改目标，只改凭据从哪来）。
    assert.equal(a.host, 'https://api.deepseek.com')
    assert.equal(a.path, '/anthropic/v1/messages')
    assert.equal(o.path, '/v1/chat/completions')
    assert.equal(a.model, 'deepseek-chat')
    assert.equal(a.from, 'decl')
    assert.equal(a.wire.name, 'anthropic-messages')

    // 二 · 负对照：不给值的那一档照旧当场拒（说明上面那一条不是"谁都放行"）。
    withoutCredential(() => {
      let threw = false
      try {
        targetOf('deepseek-chat/anthropic')
      } catch (err) {
        threw = true
        assert.match((err as Error).message, /DEEPSEEK_API_KEY/)
      }
      assert.equal(threw, true, '两条路都没有时 targetOf 却没拒——那这一条负对照什么都没证明')
    })

    // 三 · 给的值要是空串就没有意义：空凭据发出去换来一个 401，那看起来像"模型不行"。
    assert.throws(() => targetAt('deepseek-chat/anthropic', ''), /不能是空/)
    console.log(
      `⑤b 读数：targetAt（给值）anthropic 头 [${Object.keys(a.headers).join(' · ')}] · openai 鉴权栏 authorization · ` +
        '环境变量没设也拼得出来；targetOf（自己取，两条路都堵掉）照旧拒',
    )
  } finally {
    if (before !== undefined) process.env['DEEPSEEK_API_KEY'] = before
  }
})
// ── ⑦ `--dump-wire`：默认不落，而落的时候发出去的字节一模一样 ────────────────────

test('⑦ dump-wire：不带它时一个文件都不写；带它时那一串请求体与夹具记的逐字节相同', async () => {
  const f = fixture('deepseek-chat-anthropic')
  const tools = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
  const prefix = prefixOf(0)
  const t = fixtureTarget(f)
  const req = { model: t.model, zones: { A: prefix.zoneA, B: prefix.zoneB, C: prefix.zoneC }, tools, call: f.call }

  // 一 · 不带 dump 的那一趟（基准）
  const bareEvents = await drain(callModel(t, req, fixtureTransport(f, 1)).events)

  // 二 · 带 dump 的那一趟：**事件与基准逐条相同**
  const dir = tmpDir('fugue-wire-')
  const dumping = makeDumpCall(dir, fixtureTransport(f, 1))
  const reply = dumping(
    { target: t, adapter: { name: 'anthropic-messages' }, prefix, tools, model: t.model, call: f.call } as never,
    new AbortController().signal,
  )
  const dumped = await drain(reply.events)
  reply.ledger()
  assert.deepEqual(dumped, bareEvents, '带 dump 那一趟的事件与不带那一趟不同')

  // 三 · 落下来的东西：六件，而 `request.json` 就是夹具记的那一串字节
  const at = join(dir, 'call-0001')
  for (const name of ['request.json', 'response.sse', 'meta.json', 'request.sha256', 'response.sha256', 'README']) {
    assert.ok(existsSync(join(at, name)), `${name} 没落下来`)
  }
  const sent = readFileSync(join(at, 'request.json'))
  assert.equal(hashOf(sent), f.bodyHash, `dump 下来的请求体不是夹具记的那一串：${hashOf(sent)} vs ${f.bodyHash}`)
  assert.equal(sent.length, f.bytes)
  const meta = JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8')) as {
    requestHash: string
    zoneAHash: string
    zoneBHash: string
    zoneCHash: string
    events: number
    stop: string | null
  }
  assert.equal(meta.requestHash, f.bodyHash)
  assert.equal(meta.zoneAHash, hashOf(prefix.zoneA), 'meta 里的 A 区指纹与装配的不是同一个')
  assert.equal(meta.zoneBHash, hashOf(prefix.zoneB))
  assert.equal(meta.zoneCHash, hashOf(prefix.zoneC))
  assert.equal(meta.events, dumped.length)
  assert.equal(meta.stop, 'tool-calls')
  // **标准 sha256**（原先这里对的是 `hashOf()` 那把 16 个字符的短指纹——而那两份 `*.sha256`
  // 是给 `sha256sum -c` 用的，口径本来就不该是短指纹。⑦b 那一条把它单独钉住了）。
  assert.equal(
    readFileSync(join(at, 'response.sha256'), 'utf8').trim().split(/\s+/)[0],
    createHash('sha256').update(readFileSync(join(at, 'response.sse'))).digest('hex'),
  )

  // 四 · **目录没给这一层就不存在**：再跑一趟不带 dump 的，那个目录里一个新文件都没有。
  const before = readdirSync(at).sort().join(' ')
  const again = await drain(callModel(t, req, fixtureTransport(f, 1)).events)
  assert.deepEqual(again, bareEvents)
  assert.equal(readdirSync(at).sort().join(' '), before, '不带 dump 的那一趟往 dump 目录里写了东西')
  console.log(
    `⑦ 读数：请求体 ${sent.length} 字节（${hashOf(sent)}）· 事件 ${dumped.length} 条 · 落盘 6 个文件 · ` +
      `不带 dump 那一趟 0 个新文件`,
  )
})

// ── ⑧ 上游非 2xx：原话留在错误上（白名单之外的不留）─────────────────────────────

// ── ⑦b dump 里那两份 `sha256` 是**标准 sha256**（`sha256sum -c` 认得的那一把） ──────────
//
// 由头（线上实测）：那两份文件原先落的是产品内部那把**16 个字符的短指纹**，而同一份目录里的
// `README` 写着"取值顺序：1. `sha256sum -c request.sha256`"。于是照着 README 敲一律报
// "对不上"——**一份取证物自己说自己被改过**，而排障的人正在查别的问题。
test('⑦b dump 的 *.sha256 是标准 sha256：sha256sum -c 对得上（短指纹那把不算）', async () => {
  const f = fixture('deepseek-chat-anthropic')
  const dir = tmpDir('fugue-dump-sha-')
  const t = fixtureTarget(f)
  const tools = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
  const prefix = prefixOf(0)
  const dumping = makeDumpCall(dir, fixtureTransport(f, 1))
  const stream = dumping({ target: t, model: t.model, prefix, tools, call: f.call } as never, new AbortController().signal)
  for await (const e of stream.events) void e
  stream.ledger()

  const at = join(dir, 'call-0001')
  const shaIn = (name: string): string => readFileSync(join(at, name), 'utf8').trim().split(/\s+/)[0] ?? ''
  const real = (name: string): string => createHash('sha256').update(readFileSync(join(at, name))).digest('hex')
  // 一 · 64 个十六进制字符（短指纹是 16 个）。
  assert.equal(shaIn('request.sha256').length, 64, `request.sha256 里那一串是 ${shaIn('request.sha256').length} 个字符`)
  assert.equal(shaIn('response.sha256').length, 64, 'response.sha256 里那一串不是标准 sha256')
  // 二 · 与盘上那份字节的真 sha256 相同（这一条就是 `sha256sum -c` 的那条判据）。
  assert.equal(shaIn('request.sha256'), real('request.json'), 'request.sha256 与盘上的请求体对不上')
  assert.equal(shaIn('response.sha256'), real('response.sse'), 'response.sha256 与盘上的响应对不上')
  // 三 · `meta.json` 里那两栏**照旧是短指纹**（它要与日志的指纹对，不是给 sha256sum 的）。
  const meta = JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8')) as Record<string, unknown>
  assert.equal(String(meta['requestHash']).length, 16, 'meta.requestHash 变了口径——它与日志那几栏是同一把尺')
  assert.equal(String(meta['requestHash']), hashOf(readFileSync(join(at, 'request.json'))))
  console.log(`⑦b 读数：request.sha256 ${shaIn('request.sha256').slice(0, 12)}…（64 字符）· meta.requestHash ${String(meta['requestHash'])}（16 字符）`)
})

test('⑧ 非 2xx：状态码与白名单响应头读得出来，响应体照旧带上前一截', async () => {
  const t = { ...fixtureTarget(fixture('deepseek-chat-anthropic')), host: 'https://example.invalid', path: '/v1/messages' }
  const r = { model: 'deepseek-chat', zones: { A: new Uint8Array(), B: new Uint8Array(), C: new Uint8Array() }, call: {} }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"error":{"message":"rate limited"}}', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'x-request-id': 'req-abc-123', 'retry-after': '7', 'set-cookie': 'nope=1' },
    })) as typeof fetch
  try {
    // 没有那几样时读出来是 `null`——**不编一个**。
    assert.equal(wireFactsOf({ facts: undefined }), null)
    let caught: unknown = null
    try {
      for await (const _ of callModel(t, r as never).events) void _
    } catch (err) {
      caught = err
    }
    const said = wireFactsOf(caught)
    assert.ok(said !== null, '上游的原话没留在错误上')
    assert.equal(said['status'], 429)
    assert.equal(said['x-request-id'], 'req-abc-123')
    assert.equal(said['retry-after'], '7')
    assert.equal('set-cookie' in said, false, '白名单之外的响应头也留下了')
    assert.match(String((caught as Error).message), /rate limited/, '响应体的前一截没带出来')
    console.log(`⑧ 读数：${JSON.stringify(said)}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── ⑦c **失败那一路也要落盘**（这一份取证物不该挂在"调用方记不记得读账"上）────────────
//
// 由头（线上实测）：`--live --credential <文件>` 那一趟打的是 401，而 `--dump-wire` 目录**是空的**
// ——落盘原先只在 `ledger()` 被读的时候发生，而 `step()` 的失败那一档不读账（它的 `catch` 只记
// `failure` 与上游那几个事实）。于是"为什么没成"这个最需要取证的问题，恰好是唯一没有取证物的。
test('⑦c 上游回 401：事件那边抛，而 dump 里 request.json / response.sse / failure 三样都在', async () => {
  const f = fixture('deepseek-chat-anthropic')
  const t = { ...fixtureTarget(f), host: 'https://example.invalid', path: '/anthropic/v1/messages' }
  const tools = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
  const prefix = prefixOf(0)
  const dir = tmpDir('fugue-dump-fail-')
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"error":{"message":"Authentication Fails, Your api key is invalid"}}', {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'x-request-id': 'req-401-xyz' },
    })) as typeof fetch
  try {
    const dumping = makeDumpCall(dir)
    const reply = dumping(
      { target: t, adapter: { name: 'anthropic-messages' }, prefix, tools, model: t.model, call: f.call } as never,
      new AbortController().signal,
    )
    // **一次 `ledger()` 都不读**——失败那一档的调用方就是这么做的（`step()` 的 `catch`）。
    let caught: unknown = null
    try {
      for await (const _ of reply.events) void _
    } catch (err) {
      caught = err
    }
    assert.ok(caught !== null, '401 那一趟居然没抛')

    const at = join(dir, 'call-0001')
    // 一 · 三件取证物都在（原先一件都没有：目录都不存在）。
    for (const name of ['request.json', 'response.sse', 'meta.json', 'request.sha256', 'response.sha256', 'README']) {
      assert.ok(existsSync(join(at, name)), `401 那一趟的 ${name} 没落下来`)
    }
    // 二 · 请求体是**真发出去的那一串**（夹具记的那一份），不是空文件。
    const sent = readFileSync(join(at, 'request.json'))
    assert.equal(hashOf(sent), f.bodyHash, `dump 下来的请求体不是发出去的那一串：${hashOf(sent)}`)
    // 三 · `response.sse` 里就是**上游那句原话**（这一截原先在抛之前被丢掉）。
    const back = readFileSync(join(at, 'response.sse'), 'utf8')
    assert.match(back, /api key is invalid/, `response.sse 里没有上游那句话：${JSON.stringify(back)}`)
    // 四 · `meta.json` 说得清"这一趟断了、为什么断"，而三区指纹照旧与装配的对得上。
    const meta = JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8')) as Record<string, unknown>
    assert.equal(meta['outcome'], 'failed', `outcome 那一栏是 ${String(meta['outcome'])}`)
    assert.match(String(meta['failure']), /401/, 'failure 那一栏没写清为什么断')
    assert.equal(meta['stop'], null, '断在半路的那一趟不该有收尾原因')
    assert.equal(meta['zoneAHash'], hashOf(prefix.zoneA))
    assert.equal(meta['zoneBHash'], hashOf(prefix.zoneB))
    assert.equal(meta['zoneCHash'], hashOf(prefix.zoneC))
    assert.equal(meta['requestBytes'], sent.length)
    assert.equal(meta['responseBytes'], Buffer.byteLength(back, 'utf8'))
    // 五 · 那一份目录照旧 `sha256sum -c` 对得上（失败那一路的标准不能比成功那一路低）。
    const shaOf = (name: string): string => readFileSync(join(at, name), 'utf8').trim().split(/\s+/)[0] ?? ''
    const real = (name: string): string => createHash('sha256').update(readFileSync(join(at, name))).digest('hex')
    assert.equal(shaOf('request.sha256'), real('request.json'))
    assert.equal(shaOf('response.sha256'), real('response.sse'))
    console.log(
      `⑦c 读数：401 那一趟落盘 6 个文件 · request.json ${sent.length} 字节 · response.sse ${Buffer.byteLength(back, 'utf8')} 字节` +
        `（上游原话在里面）· outcome=${String(meta['outcome'])}`,
    )
  } finally {
    globalThis.fetch = realFetch
  }
})
