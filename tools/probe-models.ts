// 探针：**上游说这个模型有什么能力**（`GET /models`）——拿它核我们声明里那几个数。
// 仓库约定 § 七：取证用，不是产品的一部分（这一份**留着**，理由在最下面）。
//
// 跑法：
//   `cd ~/fugue && node tools/probe-models.ts`                     —— 这一条路**不计费**（要凭据 · 要网）
//   `cd ~/fugue && node tools/probe-models.ts --json`              —— 同一份读数，机器读的那一档
//   `cd ~/fugue && node tools/probe-models.ts --credential <路径>` —— 临时换一份凭据（顺序照声明）
//
// **它核五样，每一样都是一条会失败的断言**（对不上就非零退出）：
//
//   ① 声明发出去的那个名字（`ModelDecl.model`）就在上游名单里
//   ② `ModelDecl.contextLimit` == 上游的 `context_window`
//   ③ `ModelDecl.call.maxTokens` <= 上游的 `max_output_tokens`
//   ④ 声明的思考档在上游的 `effort.supported_levels` 里（`off` 除外：那一档是**开关**，不是档）
//   ⑤ `systemPromptUpdate` 与 `api_capabilities.anthropic_messages.system_prompt_update` 对得上
//      （两边各叫各的：我们那第二个值叫 `rewrite-head`，上游叫 `leading-only`）
//
// **为什么它留着不删**（`AGENTS.md` § 七「一次性探针随它的读数归档一起删」那条纪律的一个例外）：
// 它问的是"**我们今天声明的数还对得上吗**"——上游加一个模型、换一档窗口、给 `effort` 加一档，
// 这个问题就重新有话说了。一次性探针问的是"当时那件事是什么"，问完没有第二个消费者。
// 判据就是这一条：这一份**还问得出新问题**。
//
// **它不是产品路径**：产品那条路一个字节都不出网（装配 · 回放 · 夹具一条断言都不碰凭据），
// 这个数从上游搬进目录里那一次是人做的（改内置档或 `~/.fugue/models.json`），探针只负责让
// "没搬"这件事看得见。
import { authWith } from '../src/model/contract.ts'
import { providerOf, readCatalog } from '../src/model/catalog.ts'
import { readConfig, getConfig } from '../src/config.ts'
import { priceOf } from '../src/model/price.ts'
import { wireHeader } from '../src/model/wire/headers.ts'

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const at = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const credPath = at('--credential')

/** 上游那一栏的一条。**只声明我们真的读的那几个字段**（其余原样放着，不解释）。 */
interface UpstreamModel {
  readonly id: string
  readonly name?: string
  readonly context_window?: number
  readonly max_output_tokens?: number
  readonly input_modalities?: readonly string[]
  readonly output_modalities?: readonly string[]
  readonly effort?: { readonly supported_levels?: readonly string[]; readonly default_level?: string }
  readonly api_capabilities?: { readonly anthropic_messages?: { readonly system_prompt_update?: string } }
}

/**
 * 两边对"系统提示词怎么增长"的叫法。**我们的名字 ↔ 上游的名字**——一处，且只有这一处翻译。
 *
 * 我们那一份（架构 § 8.11 的表）写的是 `in-history` / `rewrite-head`；上游 `api_capabilities`
 * 里写的是 `in-history` / `leading-only`。今天只有前者有真读数（`deepseek-flash` 报的就是
 * `in-history`，与我们声明的一致），**后一条是照官方那一页的意思对上的，没有实测**。
 * 改主意的条件：真接到一个报 `leading-only` 的模型那一趟，两边一起读一次再定。
 */
const OUR_UPDATE_TO_UPSTREAM: Readonly<Record<string, string>> = {
  'in-history': 'in-history',
  'rewrite-head': 'leading-only',
}

const say = (s: string): void => console.log(`  ·  ${s}`)

async function main(): Promise<number> {
  const CAT = readCatalog()
  const provider = providerOf('deepseek', CAT)
  const cfg = await readConfig(process.cwd())
  let credential: string
  try {
    credential = authWith('deepseek', getConfig(cfg, 'credentials.deepseek'), credPath ?? null)
  } catch (err) {
    process.stdout.write(`凭据取不到：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  const url = `${provider.host}/models`
  const res = await fetch(url, { headers: wireHeader('openai-chat', credential) })
  const text = await res.text()
  if (!res.ok) {
    process.stdout.write(`${url} 回了 ${res.status}：${text.slice(0, 400)}\n`)
    return 2
  }
  const body = JSON.parse(text) as { data?: readonly UpstreamModel[] }
  const list = body.data ?? []

  if (wantJson) {
    process.stdout.write(JSON.stringify({ url, upstream: list }, null, 2) + '\n')
  }

  const fails: string[] = []
  const rows: Record<string, unknown>[] = []
  for (const [id, decl] of Object.entries(CAT.models)) {
    const hit = list.find((m) => m.id === decl.model)
    const priced = priceOf(decl.model, CAT)
    const levels = hit?.effort?.supported_levels ?? []
    const upd = hit?.api_capabilities?.anthropic_messages?.system_prompt_update
    const row: Record<string, unknown> = {
      账上的键: id,
      发出去的名字: decl.model,
      上游名单里有: hit !== undefined,
      上游报的正名: hit?.name ?? null,
      声明上限: decl.contextLimit,
      上游上下文窗: hit?.context_window ?? null,
      声明输出预算: decl.call.maxTokens ?? null,
      上游输出上限: hit?.max_output_tokens ?? null,
      声明思考档: decl.call.thinking ?? null,
      上游支持的档: levels,
      上游缺省档: hit?.effort?.default_level ?? null,
      声明的更新方式: decl.systemPromptUpdate,
      上游报的更新方式: upd ?? null,
      输入模态: hit?.input_modalities ?? null,
      价目表认它: priced?.model ?? null,
    }
    rows.push(row)

    if (!wantJson) {
      say(`账上的键 ${id} → 发出去的名字 ${decl.model}`)
      if (hit === undefined) {
        say(`  **上游名单里没有这个名字**（名单：${list.map((m) => m.id).join(' · ')}）`)
        if (priced !== null) say(`  价目表把它算在 ${priced.model} 那一栏（别名），但名单上写的是别的名字`)
      } else {
        say(`  上游叫它 ${hit.name ?? '（没给名字）'} · 上下文窗 ${String(hit.context_window)} · 输出上限 ${String(hit.max_output_tokens)}`)
        say(`  思考档 ${levels.join(' · ')}（缺省 ${String(hit.effort?.default_level)}）· 输入模态 ${(hit.input_modalities ?? []).join(' · ')}`)
        say(`  系统提示词更新方式（上游）：${String(upd)}`)
      }
      say(`  我们声明：上限 ${decl.contextLimit} · 输出预算 ${String(decl.call.maxTokens)} · 思考 ${String(decl.call.thinking)} · 更新方式 ${decl.systemPromptUpdate}`)
    }

    // ① 名字
    if (hit === undefined) fails.push(`${id}：发出去的名字 ${decl.model} 不在上游名单里（${list.map((m) => m.id).join(' · ')}）`)
    // ② 上下文窗
    if (hit?.context_window !== undefined && hit.context_window !== decl.contextLimit) {
      fails.push(`${id}：声明的上限 ${decl.contextLimit} ≠ 上游的上下文窗 ${hit.context_window}`)
    }
    // ③ 输出预算（我们的预算是我们的闸，所以判的是"不超过"）
    const maxOut = hit?.max_output_tokens
    if (maxOut !== undefined && decl.call.maxTokens !== undefined && decl.call.maxTokens > maxOut) {
      fails.push(`${id}：声明的输出预算 ${decl.call.maxTokens} > 上游的输出上限 ${maxOut}`)
    }
    // ④ 思考档：`off` 是开关，不在 `effort` 那三档里——单独说清，不算失败。
    const level = decl.call.thinking
    if (level !== undefined && level !== 'off' && levels.length > 0 && !levels.includes(level)) {
      fails.push(`${id}：声明的思考档 ${level} 不在上游支持的 ${levels.join(' · ')} 里`)
    }
    // ⑤ 系统提示词更新方式
    const ours = OUR_UPDATE_TO_UPSTREAM[decl.systemPromptUpdate]
    if (upd !== undefined && ours !== undefined && ours !== upd) {
      fails.push(`${id}：声明 ${decl.systemPromptUpdate}（上游那边叫 ${ours}）≠ 上游报的 ${upd}`)
    }
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify({ url, rows, fails }, null, 2) + '\n')
  } else {
    process.stdout.write(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} ${fails.length === 0 ? '' : `${fails.length} 条对不上：\n`}`)
    for (const f of fails) process.stdout.write(`  FAIL ${f}\n`)
    if (fails.length === 0) process.stdout.write(`  ${url} 与目录逐条对得上（${Object.keys(CAT.models).length} 条声明）\n`)
  }
  return fails.length === 0 ? 0 : 1
}

process.exit(await main())
