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
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ModelDecl } from './contract.ts'
import {
  DEFAULT_CALL,
  DEFAULT_MODEL,
  MODEL_DECLS,
  MODEL_IDS,
  ModelDeclError,
  PREFIX_MODELS,
  PREFIX_MODEL_IDS,
  PROVIDERS,
  WIRES,
  WIRE_NAMES,
  authOf,
  isAuthRef,
  isModelRef,
  modelDeclOf,
  prefixDeclOf,
  providerOf,
  triggerAt,
} from './contract.ts'
import { HANDOFF_MARGIN, ZONE_A_BUDGET, checkContract, seedLimitOf } from '../contract/types.ts'
import type { ImplementContract } from '../contract/types.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { assemble, hashOf } from '../assemble/assemble.ts'
import { emptyState, sourcesFor } from '../assemble/sources.ts'
import type { AgentCoord } from '../assemble/sources.ts'
import { MODELS, modelOf } from '../assemble/models.ts'

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
