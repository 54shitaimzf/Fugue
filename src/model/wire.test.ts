// B2 的断言（PLAN § 5.8 的 B2 行 · 架构 § 10.3 的 Messages 优先与 Chat Completions 兜底 ·
// § 10.5 的"用录制的会话夹具验证，无需 API 密钥"）。
// 跑法：cd ~/fugue && node --test src/model/wire.test.ts
//
// **这一份里没有一条会出网**，也没有一处需要密钥：两份夹具是盘上的文件（`src/model/fixtures/`），
// 读进来就是字节流。
//
//   ① 每个适配器在**录制夹具**上解出来的工具调用与夹具逐字段相同：字节按**一次一个**喂进去，
//      拼出来的那两条与夹具里逐字写下的那两条相同——分片横跨块边界时不丢不重（`B3` 的断言 ①
//      是同一件事在真网络分片上的落点）
//   ② 同一个 `ModelRequest` 交给两个适配器：**`tool-call` 的语义相同、字节不同**。这是"同一模型
//      两个协议可比"的地基——比的是积出来的东西（`toolCallsIn`），不是上游那两串字节
//   ③ 一个没有的 `wire` 名 → 当场拒并列出有的，**不替它挑一个**
//   ④ 负对照：把 ② 的判据换成"字节相同" → 变红（那说明适配器没真的翻译，只是在转发）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ModelEvent, ModelRequest } from './contract.ts'
import { DEFAULT_CALL, ModelDeclError, checkEvents, modelDeclOf, toolCallsIn } from './contract.ts'
import type { WireAdapter } from './wire/stream.ts'
import { chunksOf, parseStream } from './wire/stream.ts'
import { wireOf as anthropicWireOf } from './wire/anthropic.ts'
import { wireOf as openaiWireOf } from './wire/openai.ts'
import { WIRES, WIRE_NAMES, wireNamed } from './wire/registry.ts'
import { wireHeader } from './wire/headers.ts'
import { hashOf } from '../assemble/assemble.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const fixture = (name: string): string => readFileSync(FIXTURES + name, 'utf8')

/** 夹具里逐字写下的那两条——**这就是"与夹具逐字段相同"的那个基准**。 */
const FIXTURE_CALLS = [
  { id: 'toolu_fixture_01', name: 'bash', arguments: '{"command":"ls -la","timeout_ms":10000}' },
  { id: 'toolu_fixture_02', name: 'glob', arguments: '{"pattern":"**/*.ts"}' },
] as const

/** Chat Completions 那条线发的号与 Messages 那条线不同：那是提供方给的，不跨线（所以分开列）。 */
const OPENAI_FIXTURE_IDS = ['call_fixture_01', 'call_fixture_02'] as const

/** 一份夹具（一个字符串）→ 一串事件。**块大小是参数**：断言 ① 用 1 字节。 */
async function eventsOf(text: string, wire: WireAdapter, size: number): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const e of parseStream(wire, chunksOf(text, size))) out.push(e)
  return out
}

/** 一个请求：三区是这一份自己造的（`B2` 不碰装配），工具目录是真的那十五条。 */
function request(tools = true): ModelRequest {
  const enc = new TextEncoder()
  return {
    model: modelDeclOf('deepseek-chat/anthropic').model,
    zones: {
      A: enc.encode('你是子 agent。你的契约是：把工作树里的 .ts 数一遍。'),
      B: enc.encode('第 0 步。工作区：/w/fixture。'),
      C: enc.encode('现在开始。'),
    },
    ...(tools ? { tools: catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number]) } : {}),
    call: DEFAULT_CALL,
    promptCache: 'implicit',
  }
}

// ── ① 录制夹具 → 工具调用逐字段相同 ─────────────────────────────────────────────

test('① 两份夹具各解出同样的两条调用，参数与夹具逐字段相同（逐字节切块喂进去也不丢不重）', async () => {
  // 一次一个字节：任何一个多字节字符（"先" · "看"）与任何一条 JSON 分片都必然横跨块边界。
  const anthropic = await eventsOf(fixture('anthropic-messages.sse'), anthropicWireOf(), 1)
  const openai = await eventsOf(fixture('openai-chat.sse'), openaiWireOf(), 1)

  const a = toolCallsIn(anthropic)
  const o = toolCallsIn(openai)
  assert.deepEqual(
    a.map((c) => ({ name: c.name, arguments: c.arguments })),
    FIXTURE_CALLS.map((c) => ({ name: c.name, arguments: c.arguments })),
  )
  assert.deepEqual(
    o.map((c) => ({ name: c.name, arguments: c.arguments })),
    FIXTURE_CALLS.map((c) => ({ name: c.name, arguments: c.arguments })),
  )
  assert.equal(a[0]?.id, FIXTURE_CALLS[0].id)
  assert.equal(a[1]?.id, FIXTURE_CALLS[1].id)
  assert.deepEqual(
    o.map((c) => c.id),
    [...OPENAI_FIXTURE_IDS],
  )

  // 文本也在：两条线各自拼出来的是同一句话。
  assert.equal(checkEvents(anthropic).text, '先看一眼工作树。')
  assert.equal(checkEvents(openai).text, '先看一眼工作树。')

  // 用量：两条线报的是同一笔账（夹具照着同一笔账写），而**隐式缓存那条线上没有"写缓存"这一项**。
  const au = checkEvents(anthropic).usage
  const ou = checkEvents(openai).usage
  assert.equal(au?.inputTokens, 88)
  assert.equal(au?.cacheReadTokens, 24000)
  assert.equal(au?.cacheWriteTokens, 0) // 这条线上报了 0：那就是 0
  assert.equal(au?.outputTokens, 64)
  assert.equal(ou?.inputTokens, 88)
  assert.equal(ou?.cacheReadTokens, 24000)
  assert.equal(ou?.cacheWriteTokens, null) // 这条线上没有这一项：**null 不是 0**
  assert.equal(ou?.outputTokens, 64)
  assert.equal(checkEvents(anthropic).stop, 'tool-calls')
  assert.equal(checkEvents(openai).stop, 'tool-calls')
  assert.equal(checkEvents(anthropic).rawStop, 'tool_use')
  assert.equal(checkEvents(openai).rawStop, 'tool_calls')

  // 事件条数（读数）：两条线的形状不同，所以条数也不同——**语义一样，事件不一样多**。
  console.log(
    `① 夹具读数：anthropic ${anthropic.length} 条事件 · openai ${openai.length} 条事件；` +
      `各自积出 ${a.length} / ${o.length} 条调用，参数逐字段相同`,
  )
})

// ── ② 同一个请求：语义相同、字节不同 ────────────────────────────────────────────

test('② 同一个 ModelRequest 给两个适配器：tool-call 的语义相同、字节不同', async () => {
  const r = request()
  const a = anthropicWireOf()
  const o = openaiWireOf()
  const ab = a.bytes(r)
  const ob = o.bytes(r)

  // 字节那一半：两个请求体不一样（一样就说明适配器没翻译）。
  assert.notEqual(hashOf(ab), hashOf(ob))
  const aj = JSON.parse(new TextDecoder().decode(ab)) as Record<string, unknown>
  const oj = JSON.parse(new TextDecoder().decode(ob)) as Record<string, unknown>
  // 差别落在哪几处，逐处指得出来：
  assert.equal(typeof aj['system'], 'string') // A 区在这一条线上是顶层字段
  assert.equal(oj['system'], undefined) // 那一条线上没有 system 这个顶层字段
  assert.equal((aj['messages'] as unknown[]).length, 2) // 两条 user（B 区 · C 区）
  assert.equal((oj['messages'] as unknown[]).length, 3) // 一条 system + 两条 user
  const aTool = (aj['tools'] as Record<string, unknown>[])[0] as Record<string, unknown>
  const oTool = (oj['tools'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(aTool['name'], 'write')
  assert.equal(oTool['type'], 'function')
  assert.equal((oTool['function'] as Record<string, unknown>)['name'], 'write')
  assert.deepEqual(aTool['input_schema'], (oTool['function'] as Record<string, unknown>)['parameters'])
  // 同一份输入两次序列化逐字节相同（否则上面那条 notEqual 什么都不说明）。
  assert.equal(hashOf(a.bytes(request())), hashOf(ab))
  assert.equal(hashOf(o.bytes(request())), hashOf(ob))

  // 语义那一半：同一份夹具在两条线上各自积出来的两条调用，逐字段相同。
  const aCalls = toolCallsIn(await eventsOf(fixture('anthropic-messages.sse'), a, 7))
  const oCalls = toolCallsIn(await eventsOf(fixture('openai-chat.sse'), o, 7))
  assert.deepEqual(
    aCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
    oCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
  )
  // 那两条调用报的工具名，在**这个请求公布的目录**里找得到（否则 `B5` 接不上）。
  const published = new Set((r.tools ?? []).map((t) => t.name))
  for (const c of aCalls) assert.ok(published.has(c.name), `${c.name} 不在公布的目录里`)
  for (const c of oCalls) assert.ok(published.has(c.name), `${c.name} 不在公布的目录里`)

  console.log(
    `② 请求体读数：anthropic ${ab.length} 字节（hash ${hashOf(ab)}）· openai ${ob.length} 字节（hash ${hashOf(ob)}）；` +
      `同一份三区与同一份工具目录（${r.tools?.length ?? 0} 条工具）`,
  )
})

// ── ②b 装配出来的三区字节，在真发出去的那串字节里 ───────────────────────────────

/**
 * 一段原文进 JSON 之后的那一串（**这一份测试自己的参照实现**，不是产品里的函数——产品里没有
 * "把三区反过来找出来"这种活）。
 *
 * 为什么三区不是**裸**子串：请求体是 JSON，`"` · `\` 与每一个控制字符（换行 · 制表符）都会被
 * 转义。`stableJson` 只重排键（按字典序）与裁掉 `undefined`，**不动字符串内容**，所以把原文
 * 按同一条规则转一遍，得到的序列就是它在请求体里的那一段。
 */
function escapedInJson(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

/** 一份带"必须转义"的那几样字符的三区：裸字节与转义之后的字节**不是**同一串（②c 量的）。 */
function requestWithEscapes(): ModelRequest {
  const enc = new TextEncoder()
  return {
    model: modelDeclOf('deepseek-chat/anthropic').model,
    zones: {
      A: enc.encode('项目方针：换行要转义\n「引号」与\\反斜杠\t制表符也要转义。'),
      B: enc.encode('第 0 步。\n工作区：/w/fixture\n路径：src/a.ts'),
      C: enc.encode('上一步：\n\tok'),
    },
    tools: catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number]),
    call: DEFAULT_CALL,
    promptCache: 'implicit',
  }
}

test('②b 三区在请求体里：A 在系统提示词那一栏、B 与 C 各一条 user 且 B 在 C 前、工具目录另起一栏', () => {
  const r = requestWithEscapes()
  const dec = new TextDecoder()
  const ea = escapedInJson(dec.decode(r.zones.A))
  const eb = escapedInJson(dec.decode(r.zones.B))
  const ec = escapedInJson(dec.decode(r.zones.C))
  for (const [name, wire] of [
    ['anthropic', anthropicWireOf()],
    ['openai', openaiWireOf()],
  ] as const) {
    const body = dec.decode(wire.bytes(r))
    // 三条都找得到——**这是原来一条断言都没有的那一格**（三区一个字节都没进过请求体的断言）。
    const atA = body.indexOf(ea)
    const atB = body.indexOf(eb)
    const atC = body.indexOf(ec)
    assert.ok(atA >= 0, `${name}：A 区的字节不在请求体里`)
    assert.ok(atB >= 0, `${name}：B 区的字节不在请求体里`)
    assert.ok(atC >= 0, `${name}：C 区的字节不在请求体里`)
    // **次序的判据不是三区的偏移递增**：请求体是 JSON 对象，键按字典序排，`system` 排在
    // `messages` 后面（Anthropic 那条线）——偏移递增会把一份正确的请求体判红。真正的次序在
    // **消息之间**：B 是第一条 user、C 是第二条，所以 B 在 C 之前；而 A 落在"系统提示词"那一栏里。
    if (name === 'anthropic') {
      // 这条线上 A 区是顶层 `system` 字段，紧接着它的就是那段正文。
      const atSystem = body.indexOf('"system":"')
      assert.ok(atSystem >= 0 && atSystem < atA, `${name}：A 区不在 system 那一栏里（system@${atSystem} · A@${atA}）`)
    } else {
      // 这条线上 A 区是**一条 role=system 的消息**。判据要落在消息对象里面，而不是"role 那几个
      // 字节在正文之前"——那是错的：`stableJson` 按字典序排键，`content` 排在 `role` 前面，
      // 于是正文的偏移**小于** `"role":"system"` 的偏移（实测 A@25 · role@59）。
      const atObj = body.lastIndexOf('{', atA)
      assert.ok(atObj >= 0, `${name}：找不到 A 区所在的那个消息对象`)
      const atClose = body.indexOf('}', atA)
      const chunk = body.slice(atObj, atClose < 0 ? undefined : atClose + 1)
      assert.ok(chunk.includes('"role":"system"'), `${name}：A 区所在的那个消息不是 system：${chunk.slice(0, 80)}`)
    }
    assert.ok(atB < atC, `${name}：B 区不在 C 区之前（B@${atB} · C@${atC}）——两条 user 的次序错了`)
    const tool = r.tools?.[0]?.name ?? ''
    const atTool = body.indexOf(JSON.stringify(tool))
    assert.ok(atTool >= 0, `${name}：工具目录不在请求体里`)
    console.log(
      `②b ${name}：请求体 ${body.length} 字节（${hashOf(wire.bytes(r))}）· A@${atA} B@${atB} C@${atC} 工具@${atTool}` +
        `（三区裸字节 ${r.zones.A.length}/${r.zones.B.length}/${r.zones.C.length}，` +
        `转义之后 ${ea.length}/${eb.length}/${ec.length}）`,
    )
  }
})

test('②c 带转义字符的段：裸字节不是子串，转义之后才是；而 B 与 C 两条消息的边界没挪', () => {
  const r = requestWithEscapes()
  const dec = new TextDecoder()
  const body = dec.decode(anthropicWireOf().bytes(r))
  const a = dec.decode(r.zones.A)
  const eb = escapedInJson(dec.decode(r.zones.B))
  const ec = escapedInJson(dec.decode(r.zones.C))
  // 这一段里有换行与引号：**裸的那一串一定不在**请求体里（它在 JSON 里是转义过的）。
  assert.equal(body.includes(a), false, '这一段含换行/引号，裸字节却出现在请求体里——那说明请求体不是 JSON')
  assert.ok(body.includes(escapedInJson(a)), '转义之后的那一串也不在请求体里')
  // 而"区与区的分界"这件事不受转义影响：B 与 C 是两条相邻的 user，B 整体在 C 之前、且两段
  // 各自完整（不是被转义劈成两截）。
  const atB = body.indexOf(eb)
  const atC = body.indexOf(ec)
  assert.ok(atB >= 0 && atC >= 0 && atB < atC)
  assert.equal(body.slice(atB + eb.length, atB + eb.length + 12), '","role":"us', 'B 区那一段后面不是紧跟着消息的收尾——它被转义劈开了')
  console.log(
    `②c 裸 ${a.length} 字节 vs 转义后 ${escapedInJson(a).length} 字节（转义多出 ${escapedInJson(a).length - a.length} 字节）· ` +
      `B@${atB} C@${atC}（相距 ${atC - atB - eb.length} 字节的消息壳）`,
  )
})

// ── ③ 没有的 wire 名 ──────────────────────────────────────────────────────────

test('③ 没有的 wire 名 → 当场拒并列出有的，不替它挑一个', () => {
  assert.deepEqual(Object.keys(WIRES).sort(), [...WIRE_NAMES].sort())
  assert.equal(wireNamed('anthropic-messages'), WIRES['anthropic-messages'])
  assert.equal(wireNamed('openai-chat'), WIRES['openai-chat'])
  let err: unknown = null
  try {
    wireNamed('openai-responses')
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof ModelDeclError, `拒的时候要抛 ModelDeclError，抛的是 ${String(err)}`)
  const msg = (err as Error).message
  assert.match(msg, /openai-responses/)
  assert.match(msg, /anthropic-messages/)
  assert.match(msg, /openai-chat/)
})

// ── ⑤ "流式"是一个请求侧的声明：两条线各自的那一栏（B7.6 的线上取证就是这一条红了） ──────────
//
// 由头：`accept: text/event-stream` 只说明我们收得下 SSE，**真正让上游按 SSE 回的是请求体里那一栏
// `stream`**。少了它，上游回一条整的 JSON：`dataRecords` 一个 `data:` 行都找不到，`finish` 报
// "流到头了没有收到 stop_reason/finish_reason"——话是错的（流没被掐断，是我们没要流），
// 账也是空的（`usage` 一个数都拿不到）。
//
// 这一条钉两样：**两条线各自的请求体里那一栏在** · **两条线各自那一份头在**。两样都按"红过才算"
// 给负对照——把请求体里那一栏拿掉，这一份里的判据要变红。
test('⑤ 两条线的请求体都声明了 stream，头也声明收得下 SSE；负对照：拿掉那一栏判据就变红', () => {
  const dec = new TextDecoder()
  const worlds = [
    ['anthropic-messages', anthropicWireOf(), 'x-api-key'],
    ['openai-chat', openaiWireOf(), 'authorization'],
  ] as const

  for (const [name, wire, authKey] of worlds) {
    const body = wire.bytes(request())
    const j = JSON.parse(dec.decode(body)) as Record<string, unknown>
    // 一 · 请求体里那一栏在，而且是真布尔 true（不是 'true'、不是 1）。
    assert.equal(j['stream'], true, `${name}：请求体里没有 stream: true——上游于是回一条整的 JSON`)
    // 二 · 这一栏真的落在发出去的那串字节里（不是只在对象上）。
    assert.ok(dec.decode(body).includes('"stream":true'), `${name}：字节里找不到 "stream":true`)
    // 三 · 头那一半：两条线都要 contend-type 与 accept: text/event-stream，鉴权那一栏按各线自己的名字。
    const h = wireHeader(name, 'k')
    assert.equal(h['content-type'], 'application/json')
    assert.equal(h['accept'], 'text/event-stream', `${name}：头没声明收得下 SSE`)
    assert.ok(typeof h[authKey] === 'string' && h[authKey] !== '', `${name}：鉴权那一栏不在`)
    // 四 · **要的就是流式的形状**：这份请求体 + 真回的 SSE（夹具那份原始字节）= 那份账。
    // 少了这一栏，这个等式左边是空的：`dataRecords` 只认 `data:` 行，一条整的 JSON 里一行都没有。
    console.log(
      `⑤ ${name}：请求体 ${body.length} 字节（${hashOf(body)}）· stream=true · accept=${String(h['accept'])} · 鉴权栏 ${authKey}`,
    )
  }

  // 负对照一 · 把那一栏从字节里拿掉 → 少了它，同一个 `dataRecords` 通路在**上面那两份夹具上**
  // 一条事件都解不出来（夹具是 SSE，所以这里量的是"我们的通路只认 SSE"这件事本身）。
  const stripped = JSON.parse(dec.decode(anthropicWireOf().bytes(request()))) as Record<string, unknown>
  assert.equal(stripped['stream'], true)
  delete stripped['stream']
  const bytesNoStream = new TextEncoder().encode(JSON.stringify(stripped))
  assert.equal(JSON.parse(dec.decode(bytesNoStream))['stream'], undefined, '负对照没把那一栏拿掉')
  console.log(`⑤ 负对照一：拿掉那一栏之后请求体 ${bytesNoStream.length} 字节（原 ${anthropicWireOf().bytes(request()).length}）——少的就是这一栏`)

  // 负对照二 · 判据本身是实测的：把 `stream` 换成别的值，上面那一条 assert.equal(j['stream'], true) 要红。
  let red = false
  try {
    const forged: Record<string, unknown> = { ...(JSON.parse(dec.decode(openaiWireOf().bytes(request()))) as Record<string, unknown>) }
    forged['stream'] = 'true'
    assert.equal(forged['stream'], true)
  } catch {
    red = true
  }
  assert.equal(red, true, '把 stream 换成字符串 "true" 判据却没过——那说明上面那一条 assert 什么都不验')

  // 负对照三 · 头的那一条判据也是实测的：换掉 accept 就红。
  let redHeader = false
  try {
    assert.equal({ ...wireHeader('openai-chat', 'k'), accept: 'application/json' }['accept'], 'text/event-stream')
  } catch {
    redHeader = true
  }
  assert.equal(redHeader, true, 'accept 换成 application/json 判据却没过——那说明头那一条 assert 什么都不验')
})

// ── ④ 负对照：把 ② 的判据换成"字节相同" ────────────────────────────────────────

test('④ 负对照：② 的判据换成"字节相同" → 变红（说明适配器真的在翻译，不是转发）', () => {
  const r = request()
  // ② 用的是 notEqual；换成 equal 就红。这里把"红"这件事跑出来，让它是实测的。
  assert.notEqual(hashOf(anthropicWireOf().bytes(r)), hashOf(openaiWireOf().bytes(r)))
  let same = true
  try {
    assert.equal(hashOf(anthropicWireOf().bytes(r)), hashOf(openaiWireOf().bytes(r)))
  } catch {
    same = false
  }
  assert.equal(same, false, '两个请求体的字节一样——那说明适配器没真的翻译')

  // 再正一次：把 A 区改一个字，两个请求体同时变（说明它真的读了 A 区，不是发一条固定形状）。
  const other: ModelRequest = { ...r, zones: { ...r.zones, A: new TextEncoder().encode('你是子 agent。') } }
  assert.notEqual(hashOf(anthropicWireOf().bytes(other)), hashOf(anthropicWireOf().bytes(r)))
  assert.notEqual(hashOf(openaiWireOf().bytes(other)), hashOf(openaiWireOf().bytes(r)))
})

// ── ②d 断点那一档：声明说 implicit 就一个都不发，说 explicit 就发在 A 区与 B 区的边界 ────────
//
// 由头：cache_control 是 **Anthropic Messages 这条线上的显式数据**（架构 § 10.3），而我们这条线
// 的 system 今天是一串纯文本——纯文本发不出断点。所以断点发不发**是一个声明**（WIRES 那一栏，
// 经 promptCacheFor 带过来），而不是适配器自己判断该不该发。这一条把两档的字节都钉住。
test('②d 断点按声明走：implicit 一个不发 · explicit 发在 A 区与 B 区末尾（C 区不发）', () => {
  const dec = new TextDecoder()
  const base = request()
  const implicit = dec.decode(anthropicWireOf().bytes({ ...base, promptCache: 'implicit' }))
  const explicit = dec.decode(anthropicWireOf().bytes({ ...base, promptCache: 'explicit' }))

  // 一 · 隐式那一档：整份请求体里一个 cache_control 都没有，system 仍是一串纯文本。
  assert.equal((implicit.match(/cache_control/g) ?? []).length, 0, 'implicit 那一档不该出现 cache_control')
  const iBody = JSON.parse(implicit) as Record<string, unknown>
  assert.equal(typeof iBody['system'], 'string', 'implicit 那一档的 system 应当是一串纯文本')

  // 二 · 显式那一档：恰好两处断点，system 换成内容块数组，B 区那条 user 也是。
  assert.equal((explicit.match(/cache_control/g) ?? []).length, 2, 'explicit 那一档应当恰好两处断点')
  const eBody = JSON.parse(explicit) as Record<string, unknown>
  const sys = eBody['system'] as { text: string; cache_control?: unknown }[]
  assert.ok(Array.isArray(sys) && sys.length === 1, 'explicit 那一档的 system 应当是单元素内容块数组')
  assert.deepEqual(sys[0]?.cache_control, { type: 'ephemeral' }, 'system 那一块的末尾要给断点')
  assert.equal(sys[0]?.text, dec.decode(base.zones.A), '断点不该改 system 的正文')
  const msgs = eBody['messages'] as { role: string; content: unknown }[]
  const bMsg = msgs[0]?.content as { text: string; cache_control?: unknown }[]
  assert.ok(Array.isArray(bMsg), 'B 区那条 user 的 content 应当是内容块数组')
  assert.deepEqual(bMsg[0]?.cache_control, { type: 'ephemeral' }, 'B 区末尾要给断点')
  assert.equal(bMsg[0]?.text, dec.decode(base.zones.B), '断点不该改 B 区的正文')
  assert.equal(typeof msgs[1]?.content, 'string', 'C 区那一条不给断点（它每一步都变）')

  // 三 · 两档的差别只有那两处断点：把 content 摊平之后，两条消息的正文逐字相同。
  const flat = (c: unknown): string => (typeof c === 'string' ? c : ((c as { text: string }[])[0]?.text ?? ''))
  const iMsgs = iBody['messages'] as { content: unknown }[]
  assert.equal(flat(msgs[1]?.content), flat(iMsgs[1]?.content), 'C 区那条的正文两档应当相同')
  console.log(
    '②d 读数：implicit ' +
      String(Buffer.byteLength(implicit, 'utf8')) +
      ' 字节（0 处断点）· explicit ' +
      String(Buffer.byteLength(explicit, 'utf8')) +
      ' 字节（2 处断点）',
  )
})

// ── ⑥ W6 · 原生轮次：走过的步发 tool_use/tool_result 那一开一合，不发 C 区那条重述文本 ──

test('⑥ 带走过的步：messages 里是 assistant 的 tool_use 与 user 的 tool_result 一开一合；不带则照旧发 C 区文本', () => {
  const wire = anthropicWireOf()
  const base = request()
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  // 一 · 不带 turns（第 0 步 · 夹具）：照旧 B、C 各一条 user——W6 之前的形状一条不变。
  const plain = JSON.parse(new TextDecoder().decode(wire.bytes(base))) as { messages: { role: string; content: unknown }[] }
  assert.equal(plain.messages.length, 2, '不带 turns：B 与 C 各一条 user')
  assert.equal(plain.messages[0]?.role, 'user')
  assert.equal(plain.messages[1]?.role, 'user')
  assert.equal(plain.messages[1]?.content, '现在开始。', 'C 区那条文本照旧原样发')

  // 二 · 带一步走过的往返（一条工具调用 + 它的回执）。
  const walked = { ...base, turns: [{ text: '先数一下。', calls: [{ id: 'toolu_01', name: 'glob', arguments: '{"pattern":"**/*.ts"}' }], results: [{ id: 'toolu_01', output: '3 个文件', isError: false }] }] } satisfies ModelRequest
  const body = JSON.parse(new TextDecoder().decode(wire.bytes(walked))) as { messages: { role: string; content: unknown }[] }
  // B 区那条 user 还在第一位（两条路都不改 A/B 的字节），后面跟着一开一合。
  assert.equal(body.messages[0]?.role, 'user')
  const said = body.messages[1] as { role: string; content: { type: string; id?: string; name?: string; input?: unknown; text?: string }[] }
  assert.equal(said.role, 'assistant', '第二步是 assistant 那条')
  assert.equal(said.content[0]?.type, 'text')
  assert.equal(said.content[0]?.text, '先数一下。')
  const use = said.content[1]
  assert.equal(use?.type, 'tool_use', '模型伸手的那一下要在场')
  assert.equal(use?.id, 'toolu_01')
  assert.equal(use?.name, 'glob')
  assert.deepEqual(use?.input, { pattern: '**/*.ts' }, 'arguments 那串 JSON 要解析成对象再发')
  const back = body.messages[2] as { role: string; content: { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[] }
  assert.equal(back.role, 'user', '第三步是 user 那条（工具的回执）')
  assert.equal(back.content[0]?.type, 'tool_result')
  assert.equal(back.content[0]?.tool_use_id, 'toolu_01', 'tool_use_id 要与 tool_use 那一条配得上对')
  assert.equal(back.content[0]?.content, '3 个文件')
  assert.equal(back.content[0]?.is_error, undefined, '不是错误就不带 is_error')
  // C 区那条重述文本**不再发**：原生轮次取代它。
  const flat = JSON.stringify(body.messages)
  assert.ok(!flat.includes('现在开始。'), 'C 区那条文本不该再出现在 messages 里')
  assert.equal(body.messages.length, 3, 'B + 一开一合，共三条')

  // 三 · 失败的回执要带 is_error: true。
  const failed = { ...base, turns: [{ calls: [{ id: 'toolu_02', name: 'bash', arguments: '{}' }], results: [{ id: 'toolu_02', output: '炸了', isError: true }] }] } satisfies ModelRequest
  const fBody = JSON.parse(new TextDecoder().decode(wire.bytes(failed))) as { messages: { content: { is_error?: boolean }[] }[] }
  assert.equal(fBody.messages[2]?.content[0]?.is_error, true, '失败的那条要带 is_error')

  // 四 · 负对照：结果的 id 对不上这一步任何一条 tool_use → 当场抛，不静默发一个错的请求体。
  const broken = { ...base, turns: [{ calls: [], results: [{ id: 'toolu_404', output: '孤儿回执', isError: false }] }] } satisfies ModelRequest
  assert.throws(() => wire.bytes(broken), /tool_use_id 对不上/, '孤儿回执要当场抛')
  console.log('⑥ 读数：原生轮次 ' + String(Buffer.byteLength(new TextDecoder().decode(wire.bytes(walked)), 'utf8')) + ' 字节 · 文本旧路 ' + String(Buffer.byteLength(new TextDecoder().decode(wire.bytes(base)), 'utf8')) + ' 字节')
})

// ── ⑦ 思考那一格：收得到 · 回得去（`U1`）─────────────────────────────────────────
//
// 装置是**真录下来的那一份**：`openai-chat-thinking.sse` 来自 `node tools/probe-thinking.ts --live`
// 的第 1 次调用（思考档 `low` · 上游给了 312 个字的思考 · 80 条带 `reasoning_content` 的帧）。
// 它证明的是"这条线真的会给思考"，而不只是我们的解析器认这个字段。
//
// 两条断言各带一个负对照；**"不回传就 400"那条规矩的真档读数在探针里**（同一次真跑的第 3 趟：
// 拿掉思考 → 上游回 400 `The reasoning_content in the thinking mode must be passed back to the API.`），
// 所以这里只量"那一串有没有原样进请求体"这一半——它是那条规矩的装置。

test('⑦ 思考：收得到（与实录里那些分片逐字节相同）· 回得去（两条线各一档）；不带它时那一栏一个字都不出现', async () => {
  const sse = fixture('openai-chat-thinking.sse')
  // 基准：把上游那些 `reasoning_content` 分片按原样拼起来（JSON 转义要还原）。
  const want = [...sse.matchAll(/"reasoning_content":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${String(m[1])}"`) as string)
    .join('')
  assert.ok(want.length > 100, `实录里的思考太短（${want.length} 个字）——夹具换错了？`)

  const call = checkEvents(await eventsOf(sse, openaiWireOf(), 4096))
  assert.equal(call.thinking?.text, want, '解出来的思考与上游那些分片拼起来的对不上')
  assert.equal(call.thinking?.signature, null, 'Chat Completions 那条线上没有签名这一栏')
  // 负对照：一次喂一个字节（分片横跨块边界），拼出来还是那一串。
  const oneByte = checkEvents(await eventsOf(sse, openaiWireOf(), 1))
  assert.deepEqual(oneByte.thinking, call.thinking, '按 1 字节切块喂进去，思考变了')

  // 回传：两条线各发一次带思考的轮次，那一串要**逐字节**出现在请求体里。
  const base = request(false)
  const turn = { thinking: call.thinking as { text: string; signature: string | null }, text: '看过了。', calls: [], results: [] }
  const openaiSent = JSON.parse(new TextDecoder().decode(openaiWireOf().bytes({ ...base, turns: [turn] } satisfies ModelRequest))) as {
    messages: { reasoning_content?: string }[]
  }
  assert.equal(openaiSent.messages.at(-1)?.reasoning_content, want, 'Chat Completions 那条线没把思考发回去')

  // Messages 那条线：思考块排在助理消息第一位，签名一并带上。
  const signed = { ...base, turns: [{ ...turn, thinking: { text: want, signature: 'sig-从实录里来' } }] } satisfies ModelRequest
  const aSent = JSON.parse(new TextDecoder().decode(anthropicWireOf().bytes(signed))) as {
    messages: { content: { type: string; thinking?: string; signature?: string }[] }[]
  }
  const said = aSent.messages.at(-1) as { content: { type: string; thinking?: string; signature?: string }[] }
  assert.equal(said.content[0]?.type, 'thinking', '思考块要排在助理消息的第一位')
  assert.equal(said.content[0]?.thinking, want)
  assert.equal(said.content[0]?.signature, 'sig-从实录里来')
  // 没有签名的那一档：那一栏不出现（不是发一个空串）。
  const unsigned = { ...base, turns: [turn] } satisfies ModelRequest
  const uSent = JSON.parse(new TextDecoder().decode(anthropicWireOf().bytes(unsigned))) as {
    messages: { content: { type: string; signature?: string }[] }[]
  }
  assert.equal((uSent.messages.at(-1) as { content: { signature?: string }[] }).content[0]?.signature, undefined)

  // 负对照一：这一轮的 `Turn` 里没有思考 → 两条线上那一栏都不出现。
  const dropped = { ...base, turns: [{ text: '看过了。', calls: [], results: [] }] } satisfies ModelRequest
  assert.ok(!new TextDecoder().decode(openaiWireOf().bytes(dropped)).includes('reasoning_content'), '没思考时不该出现那一栏')
  assert.ok(!new TextDecoder().decode(anthropicWireOf().bytes(dropped)).includes('"thinking"'), '没思考时不该出现思考块')

  // 负对照二：档位那一栏——`off` 在 Chat Completions 那条线上要**写出来**（那条线不写就是开），
  // 而在 Messages 那条线上一个字段都不发（那条线不写就是不开）。
  const off: ModelRequest = { ...base, call: { thinking: 'off' } }
  const offOpen = JSON.parse(new TextDecoder().decode(openaiWireOf().bytes(off))) as { thinking?: { type?: string }; reasoning_effort?: string }
  assert.deepEqual(offOpen.thinking, { type: 'disabled' }, 'Chat Completions 那条线上 `off` 要写成 disabled')
  assert.equal(offOpen.reasoning_effort, undefined, '关掉思考时不该带那一栏')
  const offAnth = JSON.parse(new TextDecoder().decode(anthropicWireOf().bytes(off))) as { thinking?: unknown; output_config?: unknown }
  assert.equal(offAnth.thinking, undefined, 'Messages 那条线上 `off` 一个字段都不发')
  assert.equal(offAnth.output_config, undefined)
  const on: ModelRequest = { ...base, call: { thinking: 'max' } }
  const onOpen = JSON.parse(new TextDecoder().decode(openaiWireOf().bytes(on))) as { thinking?: { type?: string }; reasoning_effort?: string }
  assert.deepEqual(onOpen.thinking, { type: 'enabled' })
  assert.equal(onOpen.reasoning_effort, 'max')
  const onAnth = JSON.parse(new TextDecoder().decode(anthropicWireOf().bytes(on))) as { thinking?: { type?: string }; output_config?: { effort?: string } }
  assert.deepEqual(onAnth.thinking, { type: 'enabled' })
  assert.deepEqual(onAnth.output_config, { effort: 'max' })

  console.log(
    `⑦ 读数：实录里 ${String(want.length)} 个字的思考（${String(call.toolCalls.length)} 条工具调用）· 回传后请求体 ` +
      `openai ${String(Buffer.byteLength(new TextDecoder().decode(openaiWireOf().bytes({ ...base, turns: [turn] }))))} 字节 · ` +
      `anthropic ${String(Buffer.byteLength(new TextDecoder().decode(anthropicWireOf().bytes(unsigned))))} 字节`,
  )
})
