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
