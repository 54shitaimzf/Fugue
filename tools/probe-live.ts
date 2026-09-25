// 探针：**最小的一次真调用**——先量后花。出处：PLAN § 5.8 的口径一（真实模型只在"取读数"与
// "端到端真任务"两处出场）· B8 那一行（`probe-model.ts` 扩成两档）· 架构 § 8.15 的
// `prefix-hit-rate` 与 § 23 U6（token 那个量要实测）。仓库约定 § 七：**取证用，不是产品的一部分**。
//
// 跑法：
//   `cd ~/fugue && node tools/probe-live.ts`                 —— 不发一个字节（默认档）
//   `cd ~/fugue && node tools/probe-live.ts --live`          —— 才真发（凭据从环境变量取）
//   `cd ~/fugue && node tools/probe-live.ts --live --credential /工作区之外的路径`
//
// **默认档零成本**：没有 `--live` 时这一份只印"怎么开"，一个字节都不出网、不读凭据。
//
// 它答四个问题，而**每一个都只用最小的请求**（不带工具 · `max_tokens: 1`）——比拿一整轮去试
// 便宜得多：
//   一 · 凭据在不在（读得到就报一个长度，值不印）
//   二 · 端点通不通、那一趟回什么（`usage` 四个数 · 结束原因 · 耗时）
//   三 · **Zone A 会不会命中缓存**：同一段 A 区发两次，第二趟 `cacheReadTokens > 0` 才算命中
//        （这是 `B7` 断言 ③ 那个 `prefix-hit-rate > 0` 的最小前置）
//   四 · 真计量与我们的估账差多少（`estimateTokens` 那把粗尺的校准输入）
//
// **为什么是两次而不是一次**：隐式缓存（openai 那条线）要"同样的前缀再来一次"才谈得上命中；
// 而显式断点那条线（anthropic）今天**我们一个断点都没声明**——两次调用量的是"上游自己认不认"。
import { readFileSync } from 'node:fs'
import type { Prefix } from '../src/assemble/contract.ts'
import { MODEL_DECLS, MODEL_IDS, WIRES, authOf, providerOf } from '../src/model/contract.ts'
import type { ModelEvent, Usage } from '../src/model/contract.ts'
import { callModel } from '../src/model/http.ts'
import type { Target } from '../src/model/http.ts'
import { wireNamed } from '../src/model/wire/registry.ts'
import { estimateTokens } from '../src/runtime/budget.ts'

const argv = process.argv.slice(2)
const live = argv.includes('--live')
const credAt = argv.indexOf('--credential')
const credPath = credAt >= 0 ? argv[credAt + 1] : undefined

const line = (s: string): void => console.log(s)
const say = (s: string): void => console.log(`  ·    ${s}`)

line('B7 · 最小的一次真调用（先量后花）\n')

// ── 一 · 凭据 ──────────────────────────────────────────────────────────────────
line('一 · 凭据：读得到吗（值不印）')

const provider = providerOf('deepseek')
let credential: string | null = null
try {
  credential = credAt >= 0 && credPath !== undefined ? readFileSync(credPath, 'utf8').trim() : authOf(provider)
  say(`读到了：${credential.length} 个字符（来源：${credAt >= 0 ? credPath : JSON.stringify(provider.auth)}）`)
} catch (err) {
  say(`读不到：${(err as Error).message.split('\n')[0]}`)
}

if (!live) {
  line('')
  say('没给 --live：**一个字节都没出网**。要真发：node tools/probe-live.ts --live')
  say('凭据从工作区外来：环境变量 DEEPSEEK_API_KEY，或 --credential <工作区之外的路径>')
  process.exit(0)
}
if (credential === null) {
  line('')
  say('给了 --live 但凭据读不到——当场停，不发半个请求。')
  process.exit(2)
}

// ── 二 · 一段最小的 A 区 ────────────────────────────────────────────────────────
//
// **只有 A 区**：B 区与 C 区留空（它们随轮次与步变，而这一份要的是"同一段前缀两次"）。
// 这一段是真项目方针的前若干行——真字节才有真的 token 账。
const policy = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')
const zoneA = new TextEncoder().encode(policy.split('\n').slice(0, 40).join('\n'))
const zones: Prefix = { zoneA, zoneB: new Uint8Array(), zoneC: new Uint8Array() }
say(`A 区：${zoneA.length} 字节（AGENTS.md 前 40 行）· 估 ${estimateTokens(zoneA)} token（粗尺）· B/C 区空`)

/** 一次最小调用：不带工具 · `max_tokens` 压到 1（只要用量那笔账，不要内容）。 */
async function once(
  t: Target,
  tag: string,
): Promise<{ usage: Usage | null; stop: string | null; ms: number; text: string }> {
  const started = Date.now()
  const request = { model: t.model, zones: { A: zones.zoneA, B: zones.zoneB, C: zones.zoneC }, call: { maxTokens: 1 } }
  const stream = callModel(t, request as never, undefined, AbortSignal.timeout(60_000))
  const events: ModelEvent[] = []
  let failure: string | null = null
  try {
    for await (const e of stream.events) events.push(e)
  } catch (err) {
    failure = `${(err as Error).name}: ${(err as Error).message.slice(0, 300)}`
  }
  const l = stream.ledger()
  const text = events
    .filter((e) => e.t === 'delta')
    .map((e) => (e as { text?: string }).text ?? '')
    .join('')
  const ms = Date.now() - started
  if (failure !== null) {
    say(`${tag}：失败——${failure}（${l.seen} 条事件之后断的）`)
    return { usage: null, stop: null, ms, text: '' }
  }
  say(`${tag}：${l.bytes} 字节出去 · ${l.seen} 条事件回来 · ${ms} ms · 说了 ${JSON.stringify(text.slice(0, 40))}`)
  return { usage: l.call?.usage ?? null, stop: l.call?.stop ?? null, ms, text }
}

// ── 三 · 每个协议各两次：第二次看缓存 ────────────────────────────────────────────
for (const declId of MODEL_IDS) {
  const decl = MODEL_DECLS[declId]
  if (decl === undefined) continue
  const p = providerOf(decl.provider)
  const t: Target = {
    providerId: p.id,
    host: p.host,
    wire: wireNamed(decl.wire),
    path: WIRES[decl.wire].path,
    model: decl.model,
    from: 'decl',
    // 两条线的头各一套（`wireHeader` 是产品里那一处；这里显式写出来，好在读数里看见发了什么）。
    headers:
      decl.wire === 'anthropic-messages'
        ? { 'content-type': 'application/json', 'x-api-key': credential, 'anthropic-version': '2023-06-01' }
        : { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
  }
  line(`\n二 · ${declId}（${p.host}${t.path} · 那边叫它 ${decl.model}）`)
  try {
    const one = await once(t, '第一趟')
    const two = await once(t, '第二趟')
    say(`用量：第一趟 ${JSON.stringify(one.usage)}`)
    say(`用量：第二趟 ${JSON.stringify(two.usage)}`)
    const u2 = two.usage as { cacheReadTokens?: number | null; inputTokens?: number | null } | null
    say(`Zone A 命中缓存：${(u2?.cacheReadTokens ?? 0) > 0 ? '是' : '否'}（第二趟 cacheRead=${u2?.cacheReadTokens ?? 'null'}）`)
    say(`真计量 vs 估账：输入 ${u2?.inputTokens ?? 'null'} token（估 ${estimateTokens(zoneA)}）· 结束原因 ${two.stop ?? 'null'}`)
  } catch (err) {
    say(`这一条线报错：${(err as Error).name}: ${(err as Error).message.slice(0, 300)}`)
  }
}

line('')
say('这一份是**读数**，不是断言：命中与否由上游的缓存策略定，我们只把它印出来。')
