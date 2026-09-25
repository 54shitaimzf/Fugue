// B0 的断言（PLAN § 5.8 的 B0 行 · 架构 § 10.2 · § 10.3 · § 8.11 表外那一项 · § 8.12 的 seed
// 两条准则）。跑法：cd ~/fugue && node --test src/model/contract.test.ts
//
// 六条断言，每条都有一个会红的负对照——**断言的价值在负对照那一半**：一条恒真的检查
// （"两份表都没问题"）与一条真检查在读数上长得一模一样。
//
//   ① 声明是值，不是分支：同一份声明取两次逐字节相同；`PREFIX_MODELS` 与 `MODEL_DECLS` 同域，
//      投影不换名字。负对照：把投影的 id 写成一个常量 → 投影认不出第二条声明
//   ② 目录里只有真实存在的那两条（同一个模型的两条线协议），且每条指得出提供方 · 线协议 · 上限
//      负对照：给一个不存在的名字 → 当场拒并列出有的，不替它挑一个
//   ③ `auth` 只收"环境变量的名字或工作区外的路径"，**凭据的值不进任何声明**
//   ④ `authOf()` 只在真要出网时被调用：`DEEPSEEK_API_KEY` 不在会话环境里时，装配 · 重放 ·
//      夹具档一条断言都不受影响（这一条靠"这些检查里没有一处调用 authOf"来量）
//   ⑤ 估账与余量：`contextLimit` 接进 `seedLimitOf`，超限时报"超了多少"，**不裁剪后照发**
//   ⑥ 前缀那一侧的四个字段与声明逐项相同（投影漏一个字段，装配读到的就是另一个模型）
//
// **这一份里没有一条会出网。** 四条站前读数（端点 · 工具目录 · 事件流 · 前缀那笔账）在
// `tools/probe-model.ts` 与 `tools/probe-prefix.ts` 里取——它们是取证，不是断言。
//
// **B1 起这一份盖两条单元**（PLAN § 5.8 的 B0 行与 B1 行共用它）：上面六条是 B0 的声明与估账，
// 下面四条是 B1 的**调用的边界**（冻结接口点：两个线协议 · 循环 · 夹具 · 录制全押在那几个形状上）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import join from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CALL, DEFAULT_MODEL, MODEL_DECLS, MODEL_IDS, ModelDeclError, PREFIX_MODELS, PREFIX_MODEL_IDS, PROVIDERS, STOP_REASONS, USAGE_COUNTS, USAGE_FIELDS, WIRES, WIRE_NAMES, authOf, checkEvents, isAuthRef, isModelRef, modelDeclOf, prefixDeclOf, providerOf, requestJson, stopped, toolCallsIn, triggerAt, usageCount } from './contract.ts'
import type { ModelCall, ModelDecl, ModelEvent, ModelRequest, StopReason, ToolCall, Usage } from './contract.ts'
import { HANDOFF_MARGIN, ZONE_A_BUDGET, checkContract, seedLimitOf } from '../contract/types.ts'
import type { ImplementContract } from '../contract/types.ts'
import { assemble, hashOf } from '../assemble/assemble.ts'
import { MODELS, modelOf } from '../assemble/models.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState, sourcesFor } from '../assemble/sources.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import { CATALOG_STATES, TOOL_ENTRIES, catalog, catalogHash } from '../tools/catalog.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** 两条声明：目录里的第一个与第二个。**缺一条就当场红**——这一份测的就是"两条都在"。 */
const FIRST = MODEL_DECLS[MODEL_IDS[0] as string] as ModelDecl
const SECOND = MODEL_DECLS[MODEL_IDS[1] as string] as ModelDecl

/** 一次 `checkContract` 的原始输出（`[]` = 没问题）。 */
function issuesOf(c: ImplementContract, bytes: number, modelLimit?: number): string[] {
  const ctx = modelLimit === undefined ? { seedBytes: () => bytes } : { seedBytes: () => bytes, modelLimit }
  return checkContract(c, ctx)
}

/** 一份最小的实现型契约：只为 ⑤ 那两条服务，别的字段取合法值。 */
function contractWithSeed(seed: readonly string[]): ImplementContract {
  return {
    kind: 'implement',
    id: 'r1.implement.1',
    agent: 'agent-1',
    branch: 'refs/heads/agent-1',
    goal: '把 S8 的 B0 走完',
    ownedPaths: ['src/model'],
    deliverables: [{ path: 'src/model/contract.ts', form: '文件' }],
    assertions: [{ action: '门', name: '一条会失败的断言' }],
    seed,
    actionOutputs: {},
  }
}

test('① 声明是值，不是分支：取两次同一份，投影与声明同域且不换名字', () => {
  // 确定性：同一个名字取两次是同一个值（声明里没有一处读环境 · 时间 · 随机）。
  assert.deepEqual(modelDeclOf('deepseek-chat/anthropic'), modelDeclOf('deepseek-chat/anthropic'))
  assert.equal(modelDeclOf('deepseek-chat/anthropic'), FIRST)
  assert.deepEqual(PREFIX_MODEL_IDS, MODEL_IDS)

  // 前缀那一侧的表与声明表逐项相同：**投影不是第二张表**。
  for (const [name, m] of Object.entries(MODEL_DECLS)) {
    const p = PREFIX_MODELS[name]
    assert.notEqual(p, undefined, `${name} 在前缀那一侧看不见`)
    assert.deepEqual(p, { id: m.id, systemPromptUpdate: m.systemPromptUpdate, contextLimit: m.contextLimit, call: m.call })
  }
  assert.deepEqual(Object.keys(PREFIX_MODELS).sort(), Object.keys(MODEL_DECLS).sort())

  // 载入时那一次核对是真的在核：三个变体（投影漏一条 · 投影换名字 · 提供方没声明）各该报出来。
  // 它是模块载入时跑的那一段的副本——那一段恒真的话，这一条也量不出来。
  const checks = (decls: Record<string, ModelDecl>, prefix: Record<string, { id: string }>, providers: Record<string, unknown>): string[] => {
    const out: string[] = []
    for (const [name, m] of Object.entries(decls)) {
      if (prefix[name] === undefined) out.push(`${name} 有声明，前缀那一侧看不见`)
      else if (prefix[name].id !== m.id) out.push(`${name} 的投影换了名字`)
      if (providers[m.provider] === undefined) out.push(`${name} 指的提供方没有声明：${m.provider}`)
    }
    return out
  }
  const ok = (): Record<string, { id: string }> => Object.fromEntries(Object.entries(MODEL_DECLS).map(([n, m]) => [n, prefixDeclOf(m)]))
  assert.deepEqual(checks(MODEL_DECLS, ok(), PROVIDERS), [], '三条真声明不该报任何一处')
  const dropped = ok()
  delete dropped[MODEL_IDS[1] as string]
  assert.equal(checks(MODEL_DECLS, dropped, PROVIDERS).length, 1, '投影漏掉一条要报一处')
  const renamed = ok()
  renamed[MODEL_IDS[1] as string] = { id: 'fugue-default' }
  assert.equal(checks(MODEL_DECLS, renamed, PROVIDERS).length, 1, '投影换掉名字要报一处')
  assert.equal(checks(MODEL_DECLS, ok(), {}).length, MODEL_IDS.length, '提供方一条都没声明时要逐条报')

  // 负对照：把投影的 id 写成一个常量 → 第二条声明的投影认不出它自己。
  const faked: ModelDecl = { ...SECOND, id: 'fugue-default' as ModelDecl['id'] }
  assert.notEqual(prefixDeclOf(faked).id, SECOND.id, '负对照：投影的 id 写成常量之后仍然认得出第二条声明——那说明 id 没被投影')
})

test('② 目录：两条真声明，各指得出提供方 · 线协议 · 上限；查不到的名字当场拒', () => {
  assert.deepEqual(MODEL_IDS, ['deepseek-chat/anthropic', 'deepseek-chat/openai'])
  assert.deepEqual(WIRE_NAMES, ['anthropic-messages', 'openai-chat'])
  assert.deepEqual(Object.keys(WIRES), [...WIRE_NAMES])
  // 两条线协议的路径两样：同一个 host 上两条路，这是"同一模型两个协议"那条验证的落点。
  assert.notEqual(WIRES['anthropic-messages'].path, WIRES['openai-chat'].path)

  for (const [name, m] of Object.entries(MODEL_DECLS)) {
    assert.equal(m.id, name, `${name} 的 id 与它的键不一致`)
    assert.deepEqual([WIRE_NAMES.includes(m.wire), PROVIDERS[m.provider] !== undefined], [true, true], `${name} 的线协议或提供方指不到`)
    assert.equal(m.model, 'deepseek-chat', `${name} 那边叫的名字`)
    assert.deepEqual([m.systemPromptUpdate], ['in-history'], `${name} 的系统提示词更新方式`)
    assert.deepEqual([m.contextLimit], [128_000], `${name} 的上限`)
    assert.deepEqual([m.budget.trigger, m.budget.handoffMargin], [triggerAt(128_000), 16_000], `${name} 的预算两栏`)
    assert.equal(m.budget.trigger, 96_000, '上限的四分之三')
    assert.deepEqual(m.call, DEFAULT_CALL, `${name} 的调用配置`)
  }
  // 缺省 = 表的第一条，不是另一条写死的常量。
  assert.equal(DEFAULT_MODEL, FIRST)
  assert.equal(modelDeclOf(undefined), FIRST)
  assert.equal(modelDeclOf(''), FIRST)
  assert.equal(modelDeclOf(MODEL_IDS[1] as string), SECOND)

  // 负对照：给一个不存在的名字 → 拒，且报出来的话里列出有的那几个。
  assert.throws(() => modelDeclOf('gpt-9'), (err: unknown) => {
    assert.ok(err instanceof ModelDeclError, `要拒成一个 ModelDeclError，拿到 ${String(err)}`)
    for (const name of MODEL_IDS) assert.ok(err.message.includes(name), `那句话里该列出 ${name}：${err.message}`)
    return true
  })
  assert.throws(() => providerOf('openai'), ModelDeclError)
  assert.deepEqual([isModelRef('deepseek-chat/anthropic'), isModelRef('deepseek-chat'), isModelRef('')], [true, false, false])
})

test('③ 凭据是一个引用：只收环境变量的名字或工作区外的路径，值不进声明', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, id)
    assert.ok(p.host.startsWith('https://'), `${id} 的 host 要是 https`)
    assert.ok(isAuthRef(p.auth), `${id} 的凭据引用不合形状：${JSON.stringify(p.auth)}`)
  }
  // 今天那一档：环境变量的**名字**。
  assert.deepEqual(PROVIDERS.deepseek?.auth, { from: 'env', name: 'DEEPSEEK_API_KEY' })

  // 形状那一档有牙齿：一串像凭据的**值**进不来（含小写字母或连字符就不是环境变量名）。
  assert.deepEqual(
    [
      isAuthRef({ from: 'env', name: 'DEEPSEEK_API_KEY' }),
      isAuthRef({ from: 'env', name: 'sk-live-0123456789abcdef' }),
      isAuthRef({ from: 'env', name: 'deepseek_key' }),
      isAuthRef({ from: 'env', name: '1KEY' }),
      isAuthRef({ from: 'env', name: '' }),
      isAuthRef({ from: 'file', path: '/home/ubuntu/.dsh/.credentials.yaml' }),
      isAuthRef({ from: 'file', path: '' }),
      isAuthRef({ from: 'file', path: 'a\nb' }),
      isAuthRef({ from: 'keyring', name: 'x' }),
      isAuthRef('DEEPSEEK_API_KEY'),
      isAuthRef(null),
    ],
    [true, false, false, false, false, true, false, false, false, false, false],
  )

  // 声明是一份常量表：全表逐字节里没有一处能装下一个凭据的值——只装得下引用。
  const decls = JSON.stringify({ MODEL_DECLS, PROVIDERS })
  for (const m of Object.values(MODEL_DECLS)) {
    assert.ok(isAuthRef(PROVIDERS[m.provider]?.auth), `${m.id} 的提供方的凭据引用`)
  }
  assert.ok(!/\bsk-[A-Za-z0-9]/.test(decls), '声明里出现了一串像凭据的值')
})

test('④ 凭据只在出网那一步取：不在会话环境里时，装配与夹具档一条断言都不碰它', () => {
  const p = PROVIDERS.deepseek as (typeof PROVIDERS)[string]
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DEEPSEEK_API_KEY')

  // 这一条量的是两件事：`authOf` 真的读环境（有就取得到），以及**没设时它拒得清楚**。
  const probe = { ...p, auth: { from: 'env' as const, name: 'FUGUE_B0_根本没有这个变量' } }
  assert.throws(() => authOf(probe), (err: unknown) => {
    assert.ok(err instanceof ModelDeclError)
    assert.ok(err.message.includes('FUGUE_B0_根本没有这个变量'), err.message)
    return true
  })
  assert.throws(() => authOf({ ...p, auth: { from: 'file', path: '/nonexistent/b0-credentials' } }), ModelDeclError)

  // 装配这一路：一个字节都不取决于凭据在不在。
  const st = emptyState()
  const who: AgentCoord = { id: 'agent-1', branch: 'refs/heads/agent-1', outputPaths: [] }
  const prefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, st, who) })
  assert.match(hashOf(prefix.zoneA), /^[0-9a-f]{16}$/)
  assert.ok(!had || typeof process.env.DEEPSEEK_API_KEY === 'string')

  // 而"这一份里没有一处调用 authOf"这件事，由源码那一层量：装配路径上的模块不 import 它。
  for (const f of ['../assemble/models.ts', '../assemble/assemble.ts', '../assemble/sources.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.ok(!src.includes('authOf'), `${f} 这一份不该认识 authOf`)
  }
  const self = readFileSync(new URL('contract.ts', import.meta.url), 'utf8')
  assert.equal(self.split('\n').filter((l) => l.includes('process.env')).length, 1, 'process.env 的取值处只有一处（authOf）')
  assert.ok(HERE.endsWith('src/model/') || HERE.endsWith('src\\model\\'), HERE)
  assert.ok(REPO.length > 0)
})

test('⑤ 估账与余量：contextLimit 接进 seedLimitOf，超限报"超了多少"，不裁剪照发', () => {
  // 三个数（上限 · Zone A · 交接余量）在两条路上是同一套算术。
  assert.equal(seedLimitOf({}), 200_000 - ZONE_A_BUDGET - HANDOFF_MARGIN)
  assert.equal(seedLimitOf({ modelLimit: 128_000 }), 128_000 - ZONE_A_BUDGET - HANDOFF_MARGIN)
  assert.equal(seedLimitOf({ modelLimit: 128_000 }), 88_000)
  // `seedLimit` 明写时仍然最优先（它是一条显式的窄化，架构 § 8.12 的"只可收窄"）。
  assert.equal(seedLimitOf({ modelLimit: 128_000, seedLimit: 1_000 }), 1_000)

  const c = contractWithSeed(['README.md'])
  const limit = seedLimitOf({ modelLimit: 128_000 })
  assert.deepEqual(issuesOf(c, limit - 1, 128_000), [], '差一个字节没超，不该报')
  const over = issuesOf(c, limit + 1, 128_000)
  assert.equal(over.length, 1, `超一个字节要报一条，拿到 ${JSON.stringify(over)}`)
  const said = over[0] as string
  assert.ok(said.includes(String(limit + 1)) && said.includes(String(limit)), `那句话要同时带字节数与上限：${said}`)
  assert.ok(said.includes('超限要拒绝派发，不裁剪后照发'), said)

  // 一份真契约走一遍：`checkContract` 收得到那条读数（不是只测了 `seedLimitOf` 一个数）。
  const real = contractWithSeed(['src/model/contract.ts'])
  assert.deepEqual(issuesOf(real, 40_000, 128_000), [], '装得下就不该报')
  assert.equal(issuesOf(real, 200_000, 128_000).length, 1, '装不下要报一条')
  const saidOver = issuesOf(real, 200_000, 128_000)[0] as string
  assert.ok(saidOver.includes('超 112000 字节'), `超出来的那一段要印出来（200000 − 88000）：${saidOver}`)
  assert.ok(saidOver.includes('112000') && saidOver.includes('88000'), saidOver)
  assert.ok(saidOver.includes('不裁剪后照发'), saidOver)
})

test('⑥ 前缀那一侧的四个字段与声明逐项相同（投影漏一个字段，装配读到的就是另一个模型）', () => {
  for (const [name, m] of Object.entries(MODEL_DECLS)) {
    const p = prefixDeclOf(m)
    assert.deepEqual(Object.keys(p).sort(), ['call', 'contextLimit', 'id', 'systemPromptUpdate'], `${name} 的投影字段`)
    assert.equal(p.id, m.id)
    assert.equal(p.systemPromptUpdate, m.systemPromptUpdate)
    assert.equal(p.contextLimit, m.contextLimit)
    assert.equal(p.call, m.call)
    // 提供方那三样**不在**投影里：装配不该认识 host 与线协议（架构 § 13.4 的 P1）。
    assert.deepEqual(Object.keys(p).some((k) => k === 'provider' || k === 'wire' || k === 'model'), false)
  }
  // `src/assemble/models.ts` 这一次真的换过表：它的 `MODELS` 就是 `PREFIX_MODELS`，它的
  // `modelOf` 与 `modelDeclOf` 同一条口径——**两份表不是各写一遍**。
  assert.equal(MODELS, PREFIX_MODELS)
  // 查表那一路：`modelOf` 与 `modelDeclOf` 同一条口径（**值相同**，不是同一个对象的引用——
  // 投影每次新建一份，而"两份表不是各写一遍"这件事由 `MODELS === PREFIX_MODELS` 那一行量）。
  assert.deepEqual(modelOf('deepseek-chat/openai'), prefixDeclOf(modelDeclOf('deepseek-chat/openai')))
  assert.deepEqual(modelOf(''), prefixDeclOf(DEFAULT_MODEL))
  assert.deepEqual(modelOf(undefined), prefixDeclOf(DEFAULT_MODEL))
  assert.throws(() => modelOf('gpt-9'), ModelDeclError)
})

// ── 夹具 ──────────────────────────────────────────────────────────────────────
//
// 三条常量与那三行断言**放在文件末尾**：合成之后 B0 的 `const` 与函数就在它们上面，而 `const`
// 没有提升——夹在中间的话 `interfaceKeys` 与 `requestWith` 会撞上"还没初始化"。


const WHO: AgentCoord = { id: 'agent-1', branch: 'refs/heads/agent-1', outputPaths: ['deliver/agent-1/'] }

/** 一份像样的状态：三个区都不空（空值会让"只追加"那类读数量不出东西）。 */
function stateWith(step: number): AssembleState {
  return {
    ...emptyState(),
    policy: '# 项目方针\n\n- 一条方针。\n',
    system: { platform: 'linux', net: 'none' },
    codeTree: ['src/model/contract.ts', 'src/assemble/contract.ts'],
    goal: '把 B1 的接口冻下来。',
    files: [
      { path: 'src/model/contract.ts', text: '// 模型与提供方的声明。\n' },
      { path: 'src/assemble/contract.ts', text: '// M10 的契约。\n' },
    ],
    commits: ['b5fe945 B0 · 模型与提供方的声明', '0d99efe 计划 · S8 的口径按判决落'],
    handoff: '',
    task: {
      goal: '把 B1 的接口冻下来。',
      question: '',
      deliverables: ['src/model/contract.ts'],
      evidenceRequired: ['node --test src/model/contract.test.ts'],
      assertions: ['请求体逐字节相同', '工具 schema 哈希不变'],
    },
    distill: '',
    recent: '',
    runtime: `第 ${step} 步。`,
    signals: [`sig-${step + 1}`],
    lastStep: step === 0 ? '' : `第 ${step - 1} 步的结果。`,
  }
}

/** 装配出来的一个请求：三区 + 工具 + 调用配置。**区是按区带的，不是拼好的一条。** */
function requestWith(step: number, tools: readonly (typeof TOOL_ENTRIES)[number][] | null = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])): ModelRequest {
  const prefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: DECL.id, segments: sourcesFor(SUBAGENT_PROTOCOL, stateWith(step), WHO) })
  // **第二档用 `null` 说"这次不带工具"**：显式传 `undefined` 会吃到缺省参数（JS 的规矩），
  // 那样"带工具"与"不带工具"两档就分不开了。
  return tools === null
    ? { model: DECL.model, zones: { A: prefix.zoneA, B: prefix.zoneB, C: prefix.zoneC }, call: DECL.call, promptCache: 'implicit' }
    : { model: DECL.model, zones: { A: prefix.zoneA, B: prefix.zoneB, C: prefix.zoneC }, tools, call: DECL.call, promptCache: 'implicit' }
}

/**
 * 字段一个不多一个不少那一条的两半：接口那一栏。**只看顶层**——`zones` 里的 `A`/`B`/`C` 与
 * `call` 里的 `temperature`/`maxTokens` 是嵌套对象里的字段，不是这一栏的那四个（数进去的话
 * "四个字段"这句话就没有判据了）。所以按花括号配平走一遍，进到嵌套里就跳过。
 */
function interfaceKeys(name: string): string[] {
  const head = `export interface ${name} {`
  const at = SRC.indexOf(head)
  assert.notEqual(at, -1, `盘上找不到 ${head}`)
  const body = SRC.slice(at + head.length, SRC.indexOf('\n}', at))
  const out: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const m = /^\s+readonly ([A-Za-z]+)\??:/.exec(line)
      if (m) out.push(m[1] as string)
    }
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
  }
  return out.sort()
}

/** 事件联合里那六个 `t`（从 `export type ModelEvent` 那一段里读，别的 `t:` 不算）。 */
function eventKinds(): string[] {
  const at = SRC.indexOf('export type ModelEvent')
  assert.notEqual(at, -1, '盘上找不到 export type ModelEvent')
  const body = SRC.slice(at, SRC.indexOf('\n\n', at))
  // 联合里两种写法都有：`{ readonly t: 'x'; … }` 与把字段摊成几行的。判据只认 `t: '…'` 那一处。
  return [...body.matchAll(/[{\s]t: '([a-z-]+)'/g)].map((m) => m[1] as string).sort()
}

/** `checkEvents` 实际产出的键集。 */
function producedKeys(call: ModelCall): string[] {
  return Object.keys(call).sort()
}

// ── ① 往返序列化，字段一个不多一个不少 ────────────────────────────────────────

test('① 一个请求与一串事件能往返序列化，字段一个不多一个不少', () => {
  // 请求那一栏：接口上的键 == 声明的那四个 == 从盘上读出来的那四个。
  assert.deepEqual(interfaceKeys('ModelRequest'), ['call', 'model', 'promptCache', 'tools', 'zones'])
  assert.deepEqual(interfaceKeys('ModelRequest').filter((k) => k !== 'tools' && k !== 'call'), ['model', 'promptCache', 'zones'])
  assert.deepEqual(interfaceKeys('Usage'), [...USAGE_FIELDS].sort(), '用量那一栏与 USAGE_FIELDS 对不上')
  assert.equal(USAGE_FIELDS.length, 6)
  // 架构 § 8.15 说的"用量的四个数"就是这四个——`USAGE_FIELDS` 多出来的两样是坐标，不是用量。
  assert.deepEqual(USAGE_COUNTS, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'])
  assert.equal(USAGE_COUNTS.length, 4)

  // 事件那六个 `t`：联合里读出来的（不是第二份名单）。
  assert.deepEqual(eventKinds(), ['delta', 'stop', 'tool-call', 'tool-delta', 'tool-start', 'usage'])
  // 每一种事件都造一条真的出来（联合里有的，就得有东西能产出它）。
  const every: ModelEvent[] = [
    { t: 'delta', text: '先' },
    { t: 'tool-start', index: 0, id: 't1', name: 'read' },
    { t: 'tool-delta', index: 0, args: '{"path":"a"}' },
    { t: 'tool-call', index: 0, id: 't1', name: 'read', arguments: '{"path":"a"}' },
    { t: 'tool-call', index: 1, id: 't2', name: 'grep', arguments: '{"pattern":"a"}' },
    { t: 'usage', usage: { inputTokens: 1 } },
    { t: 'stop', reason: 'tool-calls' },
  ]
  assert.deepEqual([...new Set(every.map((e) => e.t))].sort(), eventKinds(), '造出来的事件没盖满联合')

  // 往返：逐字段比，不靠 `JSON.stringify` 的键序（那是写下来的顺序，不是保证）。
  const r = requestWith(1)
  const back = JSON.parse(JSON.stringify(r)) as ModelRequest
  assert.deepEqual(interfaceKeys('ModelRequest'), Object.keys(back).sort(), '往返之后请求的键集变了')
  assert.equal(back.model, r.model)
  assert.deepEqual(Object.keys(back.zones).sort(), ['A', 'B', 'C'])
  assert.deepEqual(back.tools?.length, r.tools?.length)
  assert.deepEqual(back.call, r.call)
  // `JSON.stringify` 把 `Uint8Array` 写成 `{"0":…}` 那样的对象，所以比字节之前先还原：
  // 这一条量的是"三区那几个字节往返之后还在"，不是"JSON 认不认识 Uint8Array"。
  const bytesOf = (v: unknown): Uint8Array => {
    if (v instanceof Uint8Array) return v
    const o = v as Record<string, number>
    return new Uint8Array(Object.keys(o).map((k) => Number(k)).sort((a, b) => a - b).map((k) => o[String(k)] as number))
  }
  const asText = (u: unknown): string => Buffer.from(bytesOf(u)).toString('base64')
  for (const z of ['A', 'B', 'C'] as const) {
    assert.equal(typeof back.zones[z], 'object', `zones.${z} 往返之后不是二进制了`)
    assert.equal(asText(back.zones[z]), asText(r.zones[z]), `zones.${z} 往返之后字节变了`)
  }

  // 事件那一串：`JSON.stringify` 之后再积一次，得到的账与直接积的**逐字段相同**。
  const events: ModelEvent[] = [
    { t: 'delta', text: '我看一下。\n' },
    { t: 'tool-start', index: 0, id: null, name: 'grep' },
    { t: 'tool-delta', index: 0, args: '{"pattern":"x"' },
    { t: 'tool-delta', index: 0, args: ',"path":"src"}' },
    // **一条调用只有一种到法**：分片那一条走 `tool-start`/`tool-delta`，整条到手的那一条走
    // `tool-call`。同一个 index 两样都来是矛盾的（真实的两条线协议各自只走一种）。
    { t: 'tool-call', index: 1, id: 'call_2', name: 'read', arguments: '{"path":"src/model/contract.ts"}' },
    { t: 'tool-call', index: 0, id: null, name: 'grep', arguments: '{"pattern":"x","path":"src"}' },
    { t: 'usage', usage: { inputTokens: 2_000, cacheReadTokens: 20_000 } },
    { t: 'usage', usage: { outputTokens: 300, cacheWriteTokens: null, rawStop: 'tool_use', model: 'deepseek-chat' } },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ]
  const direct = checkEvents(events)
  const roundTrip = checkEvents(JSON.parse(JSON.stringify(events)) as ModelEvent[])
  assert.deepEqual(roundTrip, direct, '事件往返之后积出来的账不一样')
  assert.deepEqual(producedKeys(direct), ['rawStop', 'stop', 'text', 'toolCalls', 'usage'], '积出来的账的键集不是那五个')
})

// ── 这一份测试要读的两样：盘上的源码与模型目录 ────────────────────────────────

// `REPO` 由上面那一半（B0）声明，指的同一个目录——**不重复声明**（合成之后是同一个文件）。
const SRC = readFileSync(new URL('contract.ts', import.meta.url), 'utf8')
/** 模型那一栏的第一个声明：请求里那个 `model` 是**提供方那边的名字**（不是我们这边的键）。 */
const DECL = MODEL_DECLS[MODEL_IDS[0] as string] as (typeof MODEL_DECLS)[string]

assert.ok(REPO.endsWith('/') || REPO.endsWith('\\'), `仓库根那一串要是个目录：${REPO}`)
assert.ok(SRC.includes('export interface ModelRequest'), '盘上读到的那一份里没有 ModelRequest')
assert.equal(DECL.model, 'deepseek-chat')

// ── ② 一串事件积得出一次完整调用 ──────────────────────────────────────────────

test('② 一串事件积得出一次完整调用：工具调用三段拼成一条，用量缺失时如实报"没有读数"', () => {
  // 工具调用三段：起点（名字后到）· 参数分片（分两次）· 收尾。拼出来的参数是**原样的 JSON 文本**。
  const three: ModelEvent[] = [
    { t: 'delta', text: '先读一眼。' },
    { t: 'tool-start', index: 0, id: null, name: null },
    { t: 'tool-delta', index: 0, args: '{"path"' },
    { t: 'tool-delta', index: 0, args: ':"README.md"}' },
    { t: 'tool-call', index: 0, id: 'call_1', name: 'read', arguments: '{"path":"README.md"}' },
    { t: 'stop', reason: 'tool-calls' },
  ]
  const call = checkEvents(three)
  assert.deepEqual(call.toolCalls, [{ id: 'call_1', name: 'read', arguments: '{"path":"README.md"}' }])
  assert.deepEqual(JSON.parse((call.toolCalls[0] as ToolCall).arguments), { path: 'README.md' }, '拼出来的参数不是一份 JSON')
  assert.equal(call.text, '先读一眼。')
  // **没有用量事件 → `usage` 是 `null`**：那是"没有读数"，不是"四个 0"。
  assert.equal(call.usage, null)
  assert.equal(call.stop, 'tool-calls')
  assert.equal(call.rawStop, null, '没有 stop 的 raw 时它该是 null')

  // 用量并多次：只覆盖真的报了的字段，别的保持"没有读数"。
  const merged = checkEvents([
    { t: 'usage', usage: { inputTokens: 0, cacheWriteTokens: 0 } },
    { t: 'usage', usage: { outputTokens: 12 } },
    { t: 'stop', reason: 'end-turn' },
  ])
  assert.deepEqual(merged.usage, {
    inputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: 0,
    outputTokens: 12,
    rawStop: null,
    model: null,
  })
  // 0 与 null 分得开：报上来的 0 就是 0，没报的那两项是 null。
  assert.equal(usageCount(merged.usage as Usage), 3)
  assert.equal(usageCount({ ...(merged.usage as Usage), cacheReadTokens: 5 }), 4)
  assert.ok(JSON.stringify(merged.usage).includes('"cacheReadTokens":null'), '没读数的那一项在序列化里也要看得见')

  // 五种结束原因各积得出来，且 `stopped()` 与 `checkEvents` 同一份答案。
  const seen: StopReason[] = STOP_REASONS.map((reason) => stopped([{ t: 'stop', reason }]))
  assert.deepEqual(seen, [...STOP_REASONS])
  assert.deepEqual(STOP_REASONS.length, 5)
  // 交错：文本与两条工具调用混着来，顺序按 index 各自收。
  const interleaved = checkEvents([
    { t: 'delta', text: 'A' },
    { t: 'tool-start', index: 1, id: 'c2', name: 'write' },
    { t: 'delta', text: 'B' },
    // `index 0` 是整条到手的那一档，`index 1` 是分片那一档——**一条调用只有一种到法**。
    { t: 'tool-call', index: 0, id: 'c1', name: 'read', arguments: '{}' },
    { t: 'tool-delta', index: 1, args: '{"path":"x"}' },
    { t: 'tool-call', index: 1, id: 'c2', name: 'write', arguments: '' },
    { t: 'stop', reason: 'tool-calls' },
  ])
  assert.equal(interleaved.text, 'AB')
  assert.deepEqual(interleaved.toolCalls.map((c) => c.name), ['read', 'write'])
  assert.equal((interleaved.toolCalls[1] as ToolCall).arguments, '{"path":"x"}', '分片累下来的那一串就是它的参数')
  assert.deepEqual([...toolCallsIn(three)], [...call.toolCalls], 'toolCallsIn 与 checkEvents 不是同一条实现')

  // 负对照：五种坏法各抛一条带指路的话（一条坏事件都不许静默过去）。
  const bads: [string, ModelEvent[]][] = [
    ['`stop` 之后又来一条', [three[5] as ModelEvent, { t: 'delta', text: '迟到的' }]],
    ['两条 `stop`', [three[5] as ModelEvent, { t: 'stop', reason: 'end-turn' }]],
    ['没开过就分片', [{ t: 'tool-delta', index: 0, args: '{}' }, three[5] as ModelEvent]],
    ['分片开在负数上', [{ t: 'tool-delta', index: -1, args: '{}' }, three[5] as ModelEvent]],
    ['开着没收尾', [{ t: 'tool-start', index: 0, id: null, name: 'read' }, three[5] as ModelEvent]],
    ['整串没有 `stop`', [three[0] as ModelEvent, three[1] as ModelEvent]],
    [
      '收尾那一条的参数与分片累下来的对不上',
      [...three.slice(1, 4), { t: 'tool-call', index: 0, id: 'call_1', name: 'read', arguments: '{"path":"别的.md"}' }, three[5] as ModelEvent],
    ],
  ]
  for (const [what, events] of bads) {
    // 判据是"它抛了"，正则只是顺手核一下抛出来的是哪一类话（对不上就是测试自己写错了）。
    assert.throws(() => checkEvents(events), /没有|收尾|落在一个没开过|排在|对不上|非负整数/, `负对照（${what}）没有抛`)
  }
  assert.throws(() => checkEvents([{ t: 'tool-start', index: -1, id: null, name: 'read' }, three[5] as ModelEvent]), /非负整数/)
  assert.throws(() => checkEvents([{ t: 'stop', reason: 'whatever' as StopReason }]), /没有这一种/)
})

// ── ③ 同一份状态两次装配 → 请求体逐字节相同；工具 schema 跨状态不变 ──────────────

test('③ 同一份状态装配两次的请求体逐字节相同；工具 schema 是 A 区级稳定', () => {
  const one = requestWith(0)
  const two = requestWith(0)
  // 三区逐字节相同（这是"请求体相同"的**前提**，不是同义反复）。
  for (const z of ['A', 'B', 'C'] as const) {
    assert.deepEqual([...two.zones[z]], [...one.zones[z]], `${z} 区两次装配不一样`)
  }
  const body = requestJson(one)
  assert.equal(requestJson(two), body, '同一份状态两次装配的请求体不是逐字节相同')
  assert.ok(body.length > 0)

  // 工具 schema 跨状态转移不变（架构 § 8.10 的硬纪律 2）：三种状态同一个哈希。
  const hashes = CATALOG_STATES.map((s) => catalogHash(catalog(s)))
  assert.equal(new Set(hashes).size, 1, `三种状态下工具 schema 的哈希不一样：${hashes.join(' · ')}`)
  // 而它进的是请求里那个 `tools` 字段，**不在三区里**（架构 § 8.11 表外那一项）。
  const schemaHash = hashOf(new TextEncoder().encode(JSON.stringify(one.tools)))
  assert.notEqual(schemaHash, hashOf(one.zones.A), '工具 schema 混进 A 区了')
  // 请求里那 15 条就是目录那 15 条（逐字段相同；`catalog()` 每次给一份新数组，引用不同是设计如此）。
  assert.deepEqual(one.tools, TOOL_ENTRIES)
  assert.equal(one.tools?.length, TOOL_ENTRIES.length)

  // 负对照：把工具 schema 补一个字段 → 哈希当场变。
  const grown = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number]).map((t, i) => (i === 0 ? { ...t, extra: 1 } : t))
  assert.notEqual(catalogHash(grown as never), hashes[0], '给 schema 补一个字段哈希却没变——③ 那条不变量是恒等式')
})

// ── ④ 凭据的值不出现在请求体里 ────────────────────────────────────────────────

test('④ 凭据的值不出现在请求体里（签名里没有那个位置），而工具有一个位置', () => {
  const r = requestWith(2)
  const body = requestJson(r)
  // 环境里真有凭据时，它一个字节都不该出现在请求体里；没有时这一条照样成立（并如实说明）。
  const key = process.env['DEEPSEEK_API_KEY']
  if (typeof key === 'string' && key.length > 0) {
    assert.equal(body.includes(key), false, '凭据的值出现在请求体里了')
    assert.equal(Buffer.from(r.zones.A).toString('utf8').includes(key), false, '凭据的值出现在 A 区里了')
  }
  // 请求里那几栏的名字与凭据无关（`auth` 这一类字段一个都没有）。
  assert.equal(/\b(auth|authorization|api[-_]?key|token)\b/i.test(body.replace(/"maxTokens"/g, '')), false, `请求体里有凭据那一类的字段：${body.slice(0, 200)}`)
  // 源码那一层：请求那一段附近不该出现凭据那一类的名字，也不该认识线协议那一层（B2 的）。
  assert.equal(/ModelRequest[\s\S]{0,400}auth/i.test(SRC), false, '请求那一段附近出现了凭据那一类的名字')
  assert.equal(SRC.includes('wire/'), false, '这一份不该认识线协议那一层')
  // 而 `tools` 那一个位置是有的（不是"什么都没带"）：工具 schema 随请求走。
  assert.notEqual(r.tools, undefined)
  const without = requestWith(2, null)
  assert.equal(without.tools, undefined, '不带工具时那一栏该缺省')
  assert.notEqual(requestJson(without), body, '带不带工具的请求体居然一样')
})

// ── 这一份的读数：请求体有多大 · 哪几栏 · 两档各长什么样（断言之外的那一半）────────
//
// 接口冻结点上要看的**不是**"测试过了"，而是"这一份请求体长什么样"：它的字段集 · 字节数 ·
// 带不带工具两档的差别。打印在一行里，进 `node --test` 的输出，也进那一次的提交信息。

{
  const withTools = requestWith(0)
  const withoutTools = requestWith(0, null)
  const a = requestJson(withoutTools)
  const b = requestJson(withTools)
  console.log(
    [
      `B1 读数 · 请求体：不带工具 ${Buffer.byteLength(a, 'utf8')} 字节（${Object.keys(JSON.parse(a) as object).join(' · ')}）`,
      `带工具 ${Buffer.byteLength(b, 'utf8')} 字节（+${Buffer.byteLength(b, 'utf8') - Buffer.byteLength(a, 'utf8')}）`,
      `zones A/B/C = ${withTools.zones.A.length}/${withTools.zones.B.length}/${withTools.zones.C.length} 字节`,
      `tools = ${withTools.tools?.length ?? 0} 条`,
      `model = ${withTools.model}`,
    ].join(' · '),
  )
  const forms: ModelEvent[][] = [
    [
      { t: 'tool-start', index: 0, id: 'c1', name: 'read' },
      { t: 'tool-delta', index: 0, args: '{"path":"a"}' },
      { t: 'tool-call', index: 0, id: 'c1', name: 'read', arguments: '{"path":"a"}' },
      { t: 'stop', reason: 'tool-calls' },
    ],
    [
      { t: 'tool-call', index: 0, id: 'c1', name: 'read', arguments: '{"path":"a"}' },
      { t: 'stop', reason: 'tool-calls' },
    ],
  ]
  const calls = forms.map((e) => checkEvents(e))
  console.log(
    `B1 读数 · 两种到法积出同一条：分片档 ${JSON.stringify(calls[0]?.toolCalls)} · 整条档 ${JSON.stringify(calls[1]?.toolCalls)} · ` +
      `用量缺席时 ${JSON.stringify(calls[0]?.usage)}（不是四个 0）`,
  )
}
