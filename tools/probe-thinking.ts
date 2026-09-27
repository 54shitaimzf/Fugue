// 探针：**思考那一格的真读数**（收 · 存 · 回传）。仓库约定 § 七：取证用，不是产品的一部分。
//
// 跑法：
//   `cd ~/fugue && node tools/probe-thinking.ts`                      —— 默认档，一个字节都不出网
//   `cd ~/fugue && node tools/probe-thinking.ts --live`               —— 真发（凭据按声明里那张表取）
//   `cd ~/fugue && node tools/probe-thinking.ts --live --effort low --dump /tmp/thinking-dump`
//
// **它答四个问题**（每一条都只花它必须花的那点钱）：
//   一 · 这条线认不认"思考开着"——回的流里到底有没有 `reasoning_content`（收那一半）
//   二 · 思考原样回传之后，上游认不认（**带 `tools` 时不回传就是 400**：这一条是产品要遵守的契约）
//   三 · 负对照：把思考从第二趟请求里拿掉，上游是不是真的 400（拿不到 400 就说明我们对规矩的理解是错的）
//   四 · 落盘：`--dump` 那个目录里的 `call-0001/response.sse` 就是 `src/model/fixtures/` 的输入
//
// **为什么走 `openai` 那条线**：它是产品的主用格式（`--live` 那一趟默认跑的就是它里那个缺省声明
// 之外的这一条；见 `MODEL_DECLS`）。`anthropic` 那条线同一格另有一条断言（签名那一路）。
import { mkdirSync } from 'node:fs'
import { catalog, CATALOG_STATES } from '../src/tools/catalog.ts'
import { MODEL_DECLS, authWith, providerOf, modelDeclOf } from '../src/model/contract.ts'
import type { ModelEvent, Thinking, Turn, Usage } from '../src/model/contract.ts'
import { makeDumpCall, targetAt } from '../src/model/http.ts'
import { wireNamed } from '../src/model/wire/registry.ts'
import { WIRES } from '../src/model/contract.ts'

const argv = process.argv.slice(2)
const live = argv.includes('--live')
const at = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const effort = (at('--effort') ?? 'low') as 'off' | 'low' | 'high' | 'max'
const dumpDir = at('--dump')
const credPath = at('--credential')
const DECL_ID = 'deepseek-flash/openai'

const say = (s: string): void => console.log(`  ·  ${s}`)
console.log('思考那一格：收 · 存 · 回传（探针）\n')

const decl = modelDeclOf(DECL_ID)
const provider = providerOf(decl.provider)
let credential: string | null = null
try {
  credential = authWith(provider, credPath ?? null)
  say(`凭据：读到了 ${credential.length} 个字符（值不印）`)
} catch (err) {
  say(`凭据：读不到——${(err as Error).message.split('\n')[0]}`)
}
if (!live) {
  console.log('')
  say('没给 --live：**一个字节都没出网**。要真发：node tools/probe-thinking.ts --live')
  say(`这一份会打 ${DECL_ID}（${provider.host}${WIRES[decl.wire].path} · 那边叫它 ${decl.model}）`)
  process.exit(0)
}
if (credential === null) {
  say('给了 --live 但凭据读不到——当场停。')
  process.exit(2)
}

// 三区：A 用 AGENTS.md 前 40 行（够长、够稳），B 一句最小的话，C 空。**工具目录必须带**
// ——带 `tools` 才是那条 400 规矩生效的那一档，不带工具时这整件事都不成立。
const { readFileSync } = await import('node:fs')
const policy = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')
const zoneA = new TextEncoder().encode(policy.split('\n').slice(0, 40).join('\n'))
const zoneB = new TextEncoder().encode('任务：把工作树里的 .ts 文件数一遍，然后停下。')
const tools = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
const target = targetAt(DECL_ID, credential)

// **`makeDumpCall` 只起一份**：它自带一个计数器（call-0001 · call-0002 …）。每一趟各起一份的话
// 每趟都写 call-0001，后一趟会把前一趟盖掉（第一次真跑就是这么把自己的好读数盖成了 400 那一份）。
const dumpRoot = dumpDir ?? '/tmp/thinking-probe-dump'
if (dumpDir !== undefined) mkdirSync(dumpDir, { recursive: true })
const made = makeDumpCall(dumpRoot)

const call = async (
  turns: readonly Turn[] | undefined,
  tag: string,
): Promise<{ thinking: Thinking | null; text: string; calls: number; usage: Usage | null; stop: string | null; failed: string | null }> => {
  const request = {
    target,
    adapter: wireNamed(decl.wire),
    model: decl.model,
    prefix: { zoneA, zoneB, zoneC: new Uint8Array() },
    tools,
    call: { thinking: effort, maxTokens: 4096 },
    ...(turns === undefined ? {} : { turns }),
  }
  const stream = made(request as never, AbortSignal.timeout(180_000))
  const events: ModelEvent[] = []
  let failed: string | null = null
  try {
    for await (const e of stream.events) events.push(e)
  } catch (err) {
    failed = `${(err as Error).name}: ${(err as Error).message.slice(0, 200)}`
  }
  const l = stream.ledger()
  const c = l.call
  const thinking = c?.thinking ?? null
  say(
    `${tag}：${failed === null ? '通' : '**失败**'} · 出去 ${l.bytes} 字节 · 回来 ${l.seen} 条事件 · ` +
      `思考 ${thinking?.text.length ?? 0} 个字（签名 ${thinking?.signature === null || thinking === null ? '没有' : '有'}）· ` +
      `说话 ${(c?.text ?? '').length} 个字 · 工具 ${c?.toolCalls.length ?? 0} 条 · 停因 ${c?.stop ?? 'null'}`,
  )
  if (failed !== null) say(`       原话：${failed}`)
  say(`       用量：${JSON.stringify(c?.usage ?? null)}`)
  return { thinking, text: c?.text ?? '', calls: c?.toolCalls.length ?? 0, usage: c?.usage ?? null, stop: c?.stop ?? null, failed }
}

say(`档位 ${effort} · dump ${dumpDir ?? '（/tmp/thinking-probe-dump）'} · 工具 ${tools.length} 条`)
console.log('')

// ── 第 1 步：收 ────────────────────────────────────────────────────────────────
const one = await call(undefined, '第 1 步（不收历史）')

// ── 第 2 步：存 + 回传 ────────────────────────────────────────────────────────
const calls = (one.stop === 'tool-calls' ? one.calls : 0)
const turn: Turn = {
  ...(one.thinking === null ? {} : { thinking: one.thinking }),
  ...(one.text === '' ? {} : { text: one.text }),
  calls: Array.from({ length: calls }, (_, i) => ({ id: `probe-${i}`, name: 'bash', arguments: '{"command":"ls"}' })),
  results: Array.from({ length: calls }, (_, i) => ({ id: `probe-${i}`, output: '（探针：这里是工具结果）', isError: false })),
}
const two = await call([turn], '第 2 步（把思考原样回传）')

// ── 负对照：把思考拿掉 ────────────────────────────────────────────────────────
const { thinking: _dropped, ...without } = turn
const three = await call([without as Turn], '负对照（第 2 步不带思考）')

console.log('')
say(`收：${one.thinking === null ? '**这一步没有思考**' : `拿到了 ${one.thinking.text.length} 个字符`}`)
say(`回传：${two.failed === null ? '上游认了（没 400）' : '上游拒了'}`)
say(`负对照：${three.failed === null ? '**也认了**——那么"不回传就 400"这条规矩在带工具的这一档上不成立（我们对规矩的理解要改）' : '上游拒了（与规矩一致）'}`)
if (dumpDir !== undefined) say(`落盘：${dumpDir}/call-0001/response.sse 就是夹具要的那一份响应`)
