#!/usr/bin/env node
// 生成 `src/model/fixtures/*.json`：把**真装配出来的请求**与**录下来的响应**配成一份夹具。
//
// 为什么要有这一步（而不是在测试里现造）：夹具是**录下来的那一份**，它进仓库、被测试读；
// 现造的话"回放两次请求体逐字节相同"这句话就只是在比较两次现造的结果。判定顺序是
// "装配一次 → 录下来 → 之后每次对着它跑"（架构 § 10.5）。
//
// 跑法：cd ~/fugue && node tools/make-fixtures.ts
//
// **它不碰网、不碰凭据**：响应来自 `src/model/fixtures/*.sse`（`B2` 手写的那两份，
// 形状照两条线协议的公开文档）。`B3` 的 `--live` 那一档录到真会话之后，这两份会被替换——
// 换的是这一份脚本的输入，不是夹具的形状。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { catalog, CATALOG_STATES } from '../src/tools/catalog.ts'
import { assemble, hashOf } from '../src/assemble/assemble.ts'
import { SUBAGENT_PROTOCOL } from '../src/assemble/protocol.ts'
import { sourcesFor } from '../src/assemble/sources.ts'
import { modelDeclOf } from '../src/model/contract.ts'
import { checkEvents, requestJson } from '../src/model/contract.ts'
import { parseStream } from '../src/model/wire/stream.ts'
import { wireNamed } from '../src/model/wire/registry.ts'
import { requestOf, fixtureOf, writeFixture } from '../src/model/session.ts'
import type { Fixture } from '../src/model/session.ts'
import type { AgentCoord } from '../src/assemble/sources.ts'
import { fixtureState } from '../src/model/fixture-state.ts'
import type { ModelEvent } from '../src/model/contract.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WHO: AgentCoord = { id: 'agent-1', branch: 'refs/heads/agent-1', outputPaths: ['deliver/agent-1/'] }

const PAIRS = [
  { decl: 'deepseek-flash/anthropic', sse: 'anthropic-messages.sse', out: 'deepseek-flash-anthropic.json' },
  { decl: 'deepseek-flash/openai', sse: 'openai-chat.sse', out: 'deepseek-flash-openai.json' },
  // **思考那一档录的是真会话**（`tools/probe-thinking.ts --live` 的第 1 次调用）：上游给的
  // `reasoning_content` 是这一份夹具存在的唯一理由——另两份里一个字都没有。
  { decl: 'deepseek-flash/openai', sse: 'openai-chat-thinking.sse', out: 'deepseek-flash-openai-thinking.json' },
] as const

const FIXTURES = join(ROOT, 'src', 'model', 'fixtures')
mkdirSync(FIXTURES, { recursive: true })

const tools = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])

for (const pair of PAIRS) {
  const decl = modelDeclOf(pair.decl)
  const prefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: decl.id, segments: sourcesFor(SUBAGENT_PROTOCOL, fixtureState(0), WHO) })
  const r = requestOf(prefix, decl.model, tools, decl.call)
  const wire = wireNamed(decl.wire)
  const body = wire.bytes(r)
  const response = readFileSync(join(FIXTURES, pair.sse), 'utf8')

  // 那份响应的账：用**同一条产品路径**（`parseStream` + `checkEvents`）积出来。
  const events: ModelEvent[] = []
  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(response)
  })()
  for await (const e of parseStream(wire, chunks)) events.push(e)
  const call = checkEvents(events)

  const f: Fixture = fixtureOf(`recorded-${pair.decl.replace('/', '-')}`, pair.decl, {
    providerId: 'deepseek',
    host: 'https://api.deepseek.com',
    wire,
    path: '',
    model: decl.model,
    headers: {},
  }, r, {
    bodyHash: hashOf(body),
    bytes: body.length,
    response,
    record: { usage: call.usage, text: call.text, toolCalls: call.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })), stop: call.stop, rawStop: call.rawStop, ms: 0 },
  })
  writeFixture(join(FIXTURES, pair.out), f)
  process.stdout.write(
    `${pair.out}：zones A/B/C = ${prefix.zoneA.length}/${prefix.zoneB.length}/${prefix.zoneC.length} 字节 · ` +
      `请求 ${body.length} 字节（${hashOf(body)}）· 响应 ${response.length} 字节 · ` +
      `积出 ${call.toolCalls.length} 条调用（${call.toolCalls.map((c) => c.name).join(' · ')}）· ` +
      `思考 ${call.thinking?.text.length ?? 0} 个字 · ` +
      `用量 ${call.usage?.inputTokens}/${call.usage?.cacheReadTokens}/${call.usage?.cacheWriteTokens}/${call.usage?.outputTokens}` +
      `（思考 ${call.usage?.reasoningTokens ?? '没有读数'}） · ` +
      `停因 ${call.stop}\n`,
  )
  // 规范文本也印一份指纹：回放时核的是它。
  process.stdout.write(`  规范文本 ${requestJson(r).length} 字节（${hashOf(new TextEncoder().encode(requestJson(r)))}）\n`)
}
