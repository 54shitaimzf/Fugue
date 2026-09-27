// 探针：模型这一维的站前读数。出处：PLAN § 5.8 的站前四处读数表 · 架构 § 9.6 · § 8.10 · § 9.7。
// **取证用，不是产品的一部分**（仓库约定 § 七）。跑法：`cd ~/fugue && node tools/probe-model.ts`
//
// 它按顺序问四件事，**第一件出网、其余三件只在盘上读**：
//   一 · 声明里那两个端点走不走得通：无凭据各回什么（**要的是 401，不是 404**——404 说明那条路
//        不在，那么"同一模型两个协议"这条验证就没有落地处），以及 `authOf()` 今天读不读得到
//        凭据（读不到是常态：`DEEPSEEK_API_KEY` 在 DSH 的凭据库里，不在会话环境里）。
//   二 · 工具目录今天是什么状态：十五条有没有名字 · 描述 · `parameters`，有没有一处 `execute`。
//   三 · 事件流够不够算基线：`prefix/assemble` 发不发射、有没有 `llm/call`、`run/start` 记不记
//       完整 argv。
//   四 · 声明本身在盘上是几条（`MODEL_DECLS` 与 `PREFIX_MODELS` 的键域），以及它是不是这一栏
//        唯一的一份表（别处还有没有第二条写死的模型名）。
//
// **网络那一节可以关掉**（`FUGUE_PROBE_OFFLINE=1`）：关掉时它报"没量"并**照样计入失败**——
// 一条量不到的读数不许看起来像通过。这一节是"路径存在性"的量法：一个不带凭据的**请求**本身
// 不产生用量、不产生费用，回的是一张拒绝的响应。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODEL_DECLS, MODEL_IDS, PREFIX_MODELS, PROVIDERS, TRIGGER_PERCENT, WIRES, authOf, providerOf } from '../src/model/contract.ts'
import { TOOL_ENTRIES, CATALOG_STATES, catalog, catalogHash } from '../src/tools/catalog.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))

let failed = 0
function ok(msg: string): void {
  console.log(`  ok   ${msg}`)
}
function bad(msg: string): void {
  failed++
  console.log(`  FAIL ${msg}`)
}
function say(msg: string): void {
  console.log(`  ·    ${msg}`)
}
function eq<T>(what: string, got: T, want: T): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(`${what}：${g}`)
  else bad(`${what}：拿到 ${g}，要的是 ${w}`)
}

function sourceOf(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}

/** `LogEvent` 联合里的那些 `t`：**只从类型字面量上读**，不从整个文件里搜字符串。 */
function eventNames(src: string): string[] {
  const at = src.indexOf('export type LogEvent')
  const body = at === -1 ? src : src.slice(at, src.indexOf('\nexport interface', at))
  return [...body.matchAll(/\bt: '([^']+)'/g)].map((m) => m[1] as string)
}

console.log('B0 · 模型与提供方：站前四处读数\n')

// ── 一 · 两个端点 ──────────────────────────────────────────────────────────────
console.log('一 · 宿主上到目标模型的路：声明里那两个端点，无凭据各回什么')

const p = providerOf('deepseek')
say(`提供方：${p.id} · host=${p.host} · 凭据引用=${JSON.stringify(p.auth)}`)
for (const w of Object.keys(WIRES) as (keyof typeof WIRES)[]) {
  say(`  ${w} → ${p.host}${WIRES[w].path}`)
}

/** 一次不带凭据的请求：要的是"那条路在不在"，**不解释响应体**（它只可能是一张拒绝）。 */
async function probeEndpoint(url: string): Promise<string> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000) })
    return `HTTP ${res.status}${res.status === 401 || res.status === 403 ? `（${res.status === 401 ? '未认证' : '拒绝'}——路在，凭据不在）` : ''}`
  } catch (err) {
    return `够不到：${(err as Error).message}`
  }
}

if (process.env.FUGUE_PROBE_OFFLINE === '1') {
  bad('两个端点没量：FUGUE_PROBE_OFFLINE=1（一条量不到的读数不许看起来像通过）')
} else {
  for (const w of Object.keys(WIRES) as (keyof typeof WIRES)[]) {
    const url = `${p.host}${WIRES[w].path}`
    const got = await probeEndpoint(url)
    if (/HTTP 401/.test(got)) ok(`${w}：无凭据 → 401（路在，凭据不在）：${url}`)
    else bad(`${w}：无凭据那一请求要的是 401，拿到 ${got}：${url}`)
  }
}

/** 凭据那一路：`authOf()` 只在出网时被调用，所以它读不到也不该影响别的读数。 */
try {
  const key = authOf(p)
  say(`authOf()：读到了凭据（${key.length} 个字符，值不印）——真模型那一档可以开`)
} catch (err) {
  say(`authOf()：读不到凭据（${(err as Error).message.split('\n')[0]}）——夹具档与装配不受影响`)
}

// ── 二 · 工具目录 ──────────────────────────────────────────────────────────────
console.log('\n二 · 工具目录今天有没有落点')

const catalogSrc = sourceOf('src/tools/catalog.ts')
eq('目录里的工具条数', TOOL_ENTRIES.length, 15)
{
  const missing = TOOL_ENTRIES.filter((t) => t.name === '' || t.description === '' || t.parameters === undefined)
  eq('名字 · 描述 · parameters 三样齐的条数', TOOL_ENTRIES.length - missing.length, 15)
  eq('目录里有 execute 的条数', catalogSrc.split('\n').filter((l) => /^\s*(readonly\s+)?execute\s*[?:(]/.test(l)).length, 0)
  say(`第一批名字：${TOOL_ENTRIES.slice(0, 5).map((t) => t.name).join(' · ')} …`)
}
{
  // 目录不随状态变：三种状态同哈希（架构 § 8.10 的硬纪律 2）。
  const hashes = CATALOG_STATES.map((s) => catalogHash(catalog(s)))
  eq('三种状态下目录的指纹（去重）', [...new Set(hashes)].length, 1)
  say(`目录指纹：${hashes[0]}（${TOOL_ENTRIES.length} 条 · 键序稳定序列化）`)
}
{
  const cap = sourceOf('src/capability/table.ts')
  eq('能力表里的 dispatch 处数', cap.split('\n').filter((l) => /\bdispatch\b/.test(l)).length, 0)
  say('能力表只有层与推论（`inferences()`）——"工具调用 → 能力层"那一段是 B5 新写的一层，不是接线头')
}
{
  // 动作那一面的入口：先把配置里那份声明读出来（`readBinding`），再交给执行器（`createExecutor`）。
  // **它是动作的入口，不是工具的入口**——"工具调用 → 执行"那一段今天一处都没有（B5 新写一层）。
  const bindingOk = /export function readBinding\b/.test(sourceOf('src/execute/binding.ts'))
  const execOk = /export function createExecutor\b/.test(sourceOf('src/execute/exec.ts'))
  ok(`src/execute/ 那一族的入口是动作绑定：${bindingOk ? 'readBinding(doc, name)' : '（没找到 readBinding，重看这一格）'} → ${execOk ? 'createExecutor(...)' : '（没找到 createExecutor）'}`)
  eq('动作那一面认得的两样（绑定 · 执行器）', [bindingOk, execOk], [true, true])
  // 而工具那一面的执行器今天一处都没有：`src/tools/` 底下只有目录与它的读法。
  const tools = ['catalog.ts', 'catalog.test.ts']
  eq('src/tools/ 底下有 execute 的文件', tools.filter((f) => /export (async )?function execute\b/.test(sourceOf(`src/tools/${f}`))), [])
}

// ── 三 · 事件流 ────────────────────────────────────────────────────────────────
console.log('\n三 · 事件流里今天够不够算基线（B7 的判据是"从日志重算"）')

const eventsSrc = sourceOf('src/log/events.ts')
const names = eventNames(eventsSrc)
// 类型名的**个数不是判据**，是"探针读得出那份联合"的读数；判据在下面几条里。
say(`事件联合里读得出的类型名个数：${names.length}`)
eq('事件联合里有 prefix/assemble', names.includes('prefix/assemble'), true)
eq('事件联合里有 llm/call', names.includes('llm/call'), true)
eq('事件联合里有 run/start 吗', names.includes('run/start'), true)
{
  const line = eventsSrc.split('\n').find((l) => l.includes("t: 'run/start'")) ?? ''
  const fields = [...line.matchAll(/([a-zA-Z0-9]+)\??:/g)].map((m) => m[1])
  say(`run/start 的字段：${fields.join(' · ')}`)
  // **读数随站走，而形状也跟着走**：`B0` 量的时候这一条只有 `argv0`，`B5` 让**工具面**那一侧
  // 填上了 `argv` 与 `cwd`，而**声明里一栏都没有**——于是产品代码写的两个字段在类型上是隐形的
  // （这一份没有 tsc），探针按类型读也读不到。修法是把它们声明成可选（`B5` 与命令行那一侧填的
  // 完整程度不同，所以是可选），命令行那一侧一并填上。
  say(`声明里有 argv：${fields.includes('argv')} · 有 cwd：${fields.includes('cwd')}`)
  eq('run/start 的声明里有 argv（绕行率的数据源）', fields.includes('argv'), true)
  eq('run/start 的声明里有 cwd', fields.includes('cwd'), true)
  const toolSide = sourceOf('src/capability/dispatch.ts').includes('argv,')
  const cliSide = sourceOf('src/cli/fugue.ts').includes('argv: policy.degraded')
  eq('两处生产者都填 argv（工具面 · 命令行）', [toolSide, cliSide], [true, true])
}
{
  // 发射处：在**产品本体**那几份里搜 `t: 'prefix/assemble'` 与 `t: 'llm/call'`。
  // `src/log/log.test.ts` 不在这里：它拿一条 `prefix/assemble` 试日志的往返，那是**写进日志
  // 再读回来**，不是谁在装配之后发射它（两者在读数上必须分得开）。
  const files = ['src/cli/fugue.ts', 'src/round/execute.ts', 'src/round/start.ts', 'src/merge/accept.ts']
  const emitters: string[] = []
  for (const f of files) {
    const src = sourceOf(f)
    for (const name of ['prefix/assemble', 'llm/call']) {
      if (src.includes(`t: '${name}'`)) emitters.push(`${f} → ${name}`)
    }
  }
  // **`B4` 起这两条事件的发射处是 `src/runtime/step.ts`**（六步里的第 5 步），所以上面那四份
  // 里一处都不该有——真正的判据是"那一条路上真的发射了"，它由 `src/runtime/step.ts` 与
  // `src/round/driver.test.ts` 的一整趟读数守着（这一份探针只核"形状够不够"）。
  eq('那四份里的发射处（都不该有）', emitters, [])
  const inStep = ['prefix/assemble', 'llm/call'].map((n) => [n, sourceOf('src/runtime/step.ts').includes(`t: '${n}'`)] as const)
  for (const [n, hit] of inStep) eq(`\`src/runtime/step.ts\` 里发不发射 ${n}`, hit, true)
  say('两条事件都由 `src/runtime/step.ts` 发射（每一步各一条）——绕行率与零工具调用率今天都有源')
}

// ── 四 · 声明本身 ──────────────────────────────────────────────────────────────
console.log('\n四 · 声明这一份在盘上的样子')

eq('MODEL_DECLS 的名字', MODEL_IDS, ['deepseek-flash/anthropic', 'deepseek-flash/openai'])
eq('PREFIX_MODELS 与 MODEL_DECLS 的键域相同', Object.keys(PREFIX_MODELS).sort(), Object.keys(MODEL_DECLS).sort())
eq('PROVIDERS 的名字', Object.keys(PROVIDERS), ['deepseek'])
{
  // "别处没有第二条写死的模型名"：占位名撤掉之后，全仓不该再有 `fugue-default` 这类替身。
  const files = ['src/assemble/models.ts', 'src/cli/fugue.ts', 'src/assemble/protocol.ts']
  const placeholders = files.filter((f) => sourceOf(f).includes('fugue-default'))
  eq('还写着占位模型名的文件', placeholders, [])
  const modelsSrc = sourceOf('src/assemble/models.ts')
  eq('src/assemble/models.ts 是不是只有投影（没有自己的常量表）', /MODEL_DECLS|PREFIX_MODELS/.test(modelsSrc), true)
  say(`每条声明一份调用配置：${MODEL_IDS.map((n) => `${n}=${JSON.stringify(MODEL_DECLS[n]?.call)}`).join(' · ')}`)
  say(`上下文上限：${MODEL_IDS.map((n) => `${n}=${MODEL_DECLS[n]?.contextLimit}`).join(' · ')}`)
  say(`预算触发点：${MODEL_IDS.map((n) => `${n}=${MODEL_DECLS[n]?.budget.trigger}`).join(' · ')}（上限的 ${TRIGGER_PERCENT}%）`)
}
eq('src/model/contract.ts 在盘上', existsSync(join(REPO, 'src/model/contract.ts')), true)

console.log(`\n${failed === 0 ? '全部通过' : `FAIL ${failed} 处`}`)
process.exit(failed === 0 ? 0 : 1)
