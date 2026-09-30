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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig, getConfig } from '../config.ts'
import { DEFAULT_CALL, ModelDeclError, authWith, isAuthChain, STOP_REASONS, USAGE_COUNTS, USAGE_FIELDS, WIRES, WIRE_NAMES, authOf, checkEvents, isAuthRef, prefixDeclOf, requestJson, stopped, toolCallsIn, triggerAt, usageCount } from './contract.ts'
import type { ModelCall, ModelDecl, ModelEvent, ModelRequest, StopReason, ToolCall, Turn, Usage } from './contract.ts'
import { BUILTIN_CATALOG, defaultModelOf, isModelRef, modelDeclOf, prefixModelsOf, providerOf } from './catalog.ts'
import { DEFAULT_MODEL_LIMIT, HANDOFF_MARGIN, checkContract, seedLimitOf, zoneABudgetOf } from '../contract/types.ts'
import type { ImplementContract } from '../contract/types.ts'
import { assemble, hashOf } from '../assemble/assemble.ts'
import { modelOf } from '../assemble/models.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState, sourcesFor } from '../assemble/sources.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import { CATALOG_STATES, TOOL_ENTRIES, catalog, catalogHash } from '../tools/catalog.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** 两条声明：目录里的第一个与第二个。**缺一条就当场红**——这一份测的就是"两条都在"。 */
const MODEL_NAMES = Object.keys(BUILTIN_CATALOG.models)
const FIRST = defaultModelOf(BUILTIN_CATALOG)
const SECOND = modelDeclOf('deepseek-flash/openai', BUILTIN_CATALOG)

/** 一次 `checkContract` 的原始输出（`[]` = 没问题）。 */
function issuesOf(c: ImplementContract, tokens: number, modelLimit?: number): string[] {
  const ctx = modelLimit === undefined ? { seedTokens: () => tokens } : { seedTokens: () => tokens, modelLimit }
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
  assert.deepEqual(modelDeclOf('deepseek-flash/anthropic', BUILTIN_CATALOG), modelDeclOf('deepseek-flash/anthropic', BUILTIN_CATALOG))
  assert.equal(modelDeclOf('deepseek-flash/anthropic', BUILTIN_CATALOG), FIRST)

  // 前缀那一侧的表是**按目录现折的投影**（`prefixModelsOf`），不是第二张表：键域与目录逐键相同，
  // 每一条又与 `prefixDeclOf(声明)` 逐字段相同——两份表不是各写一遍，是同一份折出来的。
  const PREFIX = prefixModelsOf(BUILTIN_CATALOG)
  assert.deepEqual(Object.keys(PREFIX), MODEL_NAMES)
  for (const [name, m] of Object.entries(BUILTIN_CATALOG.models)) {
    const p = PREFIX[name]
    assert.notEqual(p, undefined, `${name} 在前缀那一侧看不见`)
    assert.deepEqual(p, { id: m.id, systemPromptUpdate: m.systemPromptUpdate, contextLimit: m.contextLimit, call: m.call })
  }

  // 载入核对随 P2d 住在 `catalog.ts` 的 `validateCatalog`（内置档在模块载入时走一遍）：它核的是
  // 线协议 · 提供方 · 协议名 · 更新方式 · 价目命中——负例（wire 写错 · 价目缺行 · 跨提供方重名）
  // 在 `catalog.test.ts`。"投影与声明分家"那条旧核对结构性消失了：投影不再是第二张表，是现折的。

  // 负对照：把投影的 id 写成一个常量 → 第二条声明的投影认不出它自己。
  const faked: ModelDecl = { ...SECOND, id: 'fugue-default' as ModelDecl['id'] }
  assert.notEqual(prefixDeclOf(faked).id, SECOND.id, '负对照：投影的 id 写成常量之后仍然认得出第二条声明——那说明 id 没被投影')
})

test('② 目录：两条真声明，各指得出提供方 · 线协议 · 上限；查不到的名字当场拒', () => {
  assert.deepEqual(MODEL_NAMES, ['deepseek-flash/anthropic', 'deepseek-flash/openai'])
  assert.deepEqual(WIRE_NAMES, ['anthropic-messages', 'openai-chat'])
  assert.deepEqual(Object.keys(WIRES), [...WIRE_NAMES])
  // 两条线协议的路径两样：同一个 host 上两条路，这是"同一模型两个协议"那条验证的落点。
  assert.notEqual(WIRES['anthropic-messages'].path, WIRES['openai-chat'].path)

  for (const [name, m] of Object.entries(BUILTIN_CATALOG.models)) {
    assert.equal(m.id, name, `${name} 的 id 与它的键不一致`)
    assert.deepEqual([WIRE_NAMES.includes(m.wire), BUILTIN_CATALOG.providers[m.provider] !== undefined], [true, true], `${name} 的线协议或提供方指不到`)
    assert.equal(m.model, 'deepseek-flash', `${name} 那边叫的名字`)
    assert.deepEqual([m.systemPromptUpdate], ['in-history'], `${name} 的系统提示词更新方式`)
    // 上限那一个数是**上游报的**（`GET /models` 的 `context_window` · `tools/probe-models.ts` 核它），
    // 不是"1M"那个取整的整数——差 48 576（4.6%），而预算三个数与 `seed` 的上限都从它长出来。
    assert.deepEqual([m.contextLimit], [1_048_576], `${name} 的上限`)
    assert.deepEqual([m.budget.trigger, m.budget.handoffMargin], [triggerAt(1_048_576), 16_000], `${name} 的预算两栏`)
    assert.equal(m.budget.trigger, 367_001, '上限的 35%（取整到整数）')
    // **思考那一档必须写出来**（两条线对"没写"的解释相反），输出预算跟着抬到 32K：
    // 思考与答案共用同一个输出预算，"想完再说"在 4096 那一档装不下。
    assert.deepEqual(m.call, { thinking: 'high', maxTokens: 32_768 }, `${name} 的调用配置`)
  }
  // 缺省 = 目录的第一条，不是另一条写死的常量。
  assert.equal(defaultModelOf(BUILTIN_CATALOG), FIRST)
  assert.equal(modelDeclOf(undefined, BUILTIN_CATALOG), FIRST)
  assert.equal(modelDeclOf('', BUILTIN_CATALOG), FIRST)
  assert.equal(modelDeclOf(MODEL_NAMES[1] as string, BUILTIN_CATALOG), SECOND)

  // 负对照：给一个不存在的名字 → 拒，且报出来的话里列出有的那几个。
  assert.throws(() => modelDeclOf('gpt-9', BUILTIN_CATALOG), (err: unknown) => {
    assert.ok(err instanceof ModelDeclError, `要拒成一个 ModelDeclError，拿到 ${String(err)}`)
    for (const name of MODEL_NAMES) assert.ok(err.message.includes(name), `那句话里该列出 ${name}：${err.message}`)
    return true
  })
  assert.throws(() => providerOf('openai', BUILTIN_CATALOG), ModelDeclError)
  assert.deepEqual(
    [isModelRef('deepseek-flash/anthropic', BUILTIN_CATALOG), isModelRef('deepseek-flash', BUILTIN_CATALOG), isModelRef('', BUILTIN_CATALOG)],
    [true, false, false],
  )
})

test('③ 凭据是一个引用：只收环境变量的名字或工作区外的路径，值不进声明', () => {
  for (const [id, p] of Object.entries(BUILTIN_CATALOG.providers)) {
    assert.equal(p.id, id)
    assert.ok(p.host.startsWith('https://'), `${id} 的 host 要是 https`)
    // **凭据不在声明里**（P2c）：引用表住两级配置的 `credentials.<id>` 键——声明里连那个位置都没有。
    assert.equal('auth' in p, false, `${id} 的声明里不该有 auth 那一格（凭据住配置的 credentials 键）`)
  }

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

  // **一份表**：非空 · 每条合形状。**不强迫一条环境变量**（P2c 的口径：表住配置、由人拥有，
  // "临时换 key"由 `--credential` 覆盖接住；只配一个文件是正当放法，优先序由表的次序表达）。
  assert.deepEqual(
    [
      isAuthChain([{ from: 'env', name: 'K' }]),
      isAuthChain([{ from: 'env', name: 'K' }, { from: 'file', path: '/p' }]),
      isAuthChain([{ from: 'file', path: '/p' }]),
      isAuthChain([]),
      isAuthChain([{ from: 'env', name: 'sk-live-x' }]),
      isAuthChain([{ from: 'env', name: 'K' }, 'DEEPSEEK_API_KEY']),
      isAuthChain({ from: 'env', name: 'K' }),
      isAuthChain(undefined),
    ],
    [true, true, true, false, false, false, false, false],
  )

  // 声明是一份常量表：全表逐字节里没有一处能装下一个凭据的值——只装得下引用。
  const decls = JSON.stringify(BUILTIN_CATALOG)
  assert.ok(!decls.includes('credentials'), '声明里不该出现 credentials（它住配置，两级合并读）')
  assert.ok(!/\bsk-[A-Za-z0-9]/.test(decls), '声明里出现了一串像凭据的值')
})

test('③b 凭据的引用表住配置（P2c）：credentials.<provider> 配了就读它 · 没配就拒并指路', async () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DEEPSEEK_API_KEY')
  const keep = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  try {
    // **配了引用 → 读到那份**：临时工作区的 config 给一个文件引用，`authOf` 照表走它
    // （值是本测试自己写的假串，不进任何事件/夹具/沙箱，断言完即弃）。
    const root = mkdtempSync(join(tmpdir(), 'fugue-credentials-'))
    const keyFile = join(root, 'test-only.key')
    writeFileSync(keyFile, 'fugue-test-key-not-a-credential\n')
    mkdirSync(join(root, '.fugue'), { recursive: true })
    writeFileSync(join(root, '.fugue', 'config'), JSON.stringify({ credentials: { deepseek: [{ from: 'file', path: keyFile }] } }))
    const doc = await readConfig(root)
    assert.equal(
      authOf('deepseek', getConfig(doc, 'credentials.deepseek')),
      'fugue-test-key-not-a-credential',
      '配了文件引用就读那份',
    )
    rmSync(root, { recursive: true, force: true })

    // **没配 → 拒，话里带键名与去处**（PLAN § 5.20 的 P2c 断言原话）。
    const empty = mkdtempSync(join(tmpdir(), 'fugue-credentials-'))
    const doc2 = await readConfig(empty)
    assert.throws(
      () => authOf('deepseek', getConfig(doc2, 'credentials.deepseek')),
      (err: unknown) => {
        assert.ok(err instanceof ModelDeclError, `该是 ModelDeclError：${String(err)}`)
        assert.ok(err.message.includes('credentials.deepseek'), err.message)
        assert.ok(err.message.includes('config set --system'), err.message)
        return true
      },
    )
    rmSync(empty, { recursive: true, force: true })
  } finally {
    if (had === true) process.env.DEEPSEEK_API_KEY = keep
  }
  console.log('③b 读数：配了文件引用 → authOf 读到那份 · 没配 → 拒且话里带 credentials.deepseek 与 config set --system 去处')
})

test('④ 凭据只在出网那一步取：不在会话环境里时，装配与夹具档一条断言都不碰它', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DEEPSEEK_API_KEY')

  // **表里一条都取不到时，那句话把每一条都写出来**（只报最后一条会让人以为前一条路不存在）。
  assert.throws(
    () => authOf('deepseek', [{ from: 'env', name: 'FUGUE_B0_NO_SUCH_VAR' }]),
    (err: unknown) => {
      assert.ok(err instanceof ModelDeclError)
      assert.ok(err.message.includes('FUGUE_B0_NO_SUCH_VAR'), err.message)
      return true
    },
  )
  // **没配（undefined）→ 拒并指路**；只认文件的表也不合形状 → 同一句指路（P2c 的口径）。
  assert.throws(() => authOf('deepseek', undefined), (err: unknown) => {
    assert.ok(err instanceof ModelDeclError)
    assert.ok(err.message.includes('credentials.deepseek'), err.message)
    assert.ok(err.message.includes('config set --system'), err.message)
    return true
  })
  assert.throws(() => authOf('deepseek', [{ from: 'file', path: '/nonexistent/b0-credentials' }]), ModelDeclError)
  // 两条路都没有时：**两条的名字都在同一句话里**（这条量的是"按表逐条试"这件事真的发生了）。
  const both: readonly ({ readonly from: 'env'; readonly name: string } | { readonly from: 'file'; readonly path: string })[] = [
    { from: 'env', name: 'FUGUE_B0_NO_SUCH_VAR' },
    { from: 'file', path: '/nonexistent/b0-credentials' },
  ]
  assert.throws(() => authOf('deepseek', both), (err: unknown) => {
    assert.ok(err instanceof ModelDeclError)
    assert.ok(err.message.includes('FUGUE_B0_NO_SUCH_VAR'), err.message)
    assert.ok(err.message.includes('/nonexistent/b0-credentials'), err.message)
    assert.match(err.message, /那 2 条路都不行/, err.message)
    return true
  })
  // 顺序是承重的：**第一条能取到时，第二条一个字节都不碰**（那个文件根本不存在，也不该被读）。
  const firstWins: readonly ({ readonly from: 'env'; readonly name: string } | { readonly from: 'file'; readonly path: string })[] = [
    { from: 'env', name: 'FUGUE_B0_SET_VAR' },
    { from: 'file', path: '/nonexistent/b0-credentials' },
  ]
  const keep = process.env['FUGUE_B0_SET_VAR']
  process.env['FUGUE_B0_SET_VAR'] = 'sk-from-env-first'
  try {
    assert.equal(authOf('deepseek', firstWins), 'sk-from-env-first', '第一条取到了就该返回它')
  } finally {
    if (keep === undefined) delete process.env['FUGUE_B0_SET_VAR']
    else process.env['FUGUE_B0_SET_VAR'] = keep
  }

  // 装配这一路：一个字节都不取决于凭据在不在。
  const st = emptyState()
  const who: AgentCoord = { id: 'agent-1', branch: 'refs/heads/agent-1', outputPaths: [] }
  const prefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: FIRST.id, segments: sourcesFor(SUBAGENT_PROTOCOL, st, who) })
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
  assert.equal(seedLimitOf({}), DEFAULT_MODEL_LIMIT - zoneABudgetOf(DEFAULT_MODEL_LIMIT) - HANDOFF_MARGIN)
  // **这一处从序 29 起可证伪了**：声明里那一个上限是上游说的 1 048 576，而 `DEFAULT_MODEL_LIMIT`
  // 是**这一份的缺省**（"不是任何一个模型的声明"，`types.ts` 那一行写着）——两个数不再相等，于是
  // "命令面漏递一处"这件事在读数上看得见了（原先两个数一样，漏递一个字节都不变）。
  // 算式那一层本来就有牙（`round/start.test.ts` ⑥）；这一条补的是**接线**那一层的牙。
  const declaredLimit = defaultModelOf(BUILTIN_CATALOG).contextLimit
  assert.notEqual(declaredLimit, DEFAULT_MODEL_LIMIT, '两个数一样的话，漏递一处在读数上看不出来')
  assert.notEqual(seedLimitOf({ modelLimit: declaredLimit }), seedLimitOf({}), '递与不递的种子上限该不同')
  assert.equal(seedLimitOf({ modelLimit: 128_000 }), 128_000 - zoneABudgetOf(128_000) - HANDOFF_MARGIN)
  assert.equal(seedLimitOf({ modelLimit: 128_000 }), 101_760)
  // `seedLimit` 明写时仍然最优先（它是一条显式的窄化，架构 § 8.12 的"只可收窄"）。
  assert.equal(seedLimitOf({ modelLimit: 128_000, seedLimit: 1_000 }), 1_000)

  const c = contractWithSeed(['README.md'])
  const limit = seedLimitOf({ modelLimit: 128_000 })
  assert.deepEqual(issuesOf(c, limit - 1, 128_000), [], '差一个 token 没超，不该报')
  const over = issuesOf(c, limit + 1, 128_000)
  assert.equal(over.length, 1, `超一个 token 要报一条，拿到 ${JSON.stringify(over)}`)
  const said = over[0] as string
  assert.ok(said.includes(String(limit + 1)) && said.includes(String(limit)), `那句话要同时带用量与上限：${said}`)
  assert.ok(said.includes('超限要拒绝派发，不裁剪后照发'), said)

  // 一份真契约走一遍：`checkContract` 收得到那条读数（不是只测了 `seedLimitOf` 一个数）。
  const real = contractWithSeed(['src/model/contract.ts'])
  assert.deepEqual(issuesOf(real, 40_000, 128_000), [], '装得下就不该报')
  assert.equal(issuesOf(real, 200_000, 128_000).length, 1, '装不下要报一条')
  const saidOver = issuesOf(real, 200_000, 128_000)[0] as string
  assert.ok(saidOver.includes('超 98240 token'), `超出来的那一段要印出来（200000 − 101760）：${saidOver}`)
  assert.ok(saidOver.includes('98240') && saidOver.includes('101760'), saidOver)
  assert.ok(saidOver.includes('不裁剪后照发'), saidOver)
})

test('⑥ 前缀那一侧的四个字段与声明逐项相同（投影漏一个字段，装配读到的就是另一个模型）', () => {
  for (const [name, m] of Object.entries(BUILTIN_CATALOG.models)) {
    const p = prefixDeclOf(m)
    assert.deepEqual(Object.keys(p).sort(), ['call', 'contextLimit', 'id', 'systemPromptUpdate'], `${name} 的投影字段`)
    assert.equal(p.id, m.id)
    assert.equal(p.systemPromptUpdate, m.systemPromptUpdate)
    assert.equal(p.contextLimit, m.contextLimit)
    assert.equal(p.call, m.call)
    // 提供方那三样**不在**投影里：装配不该认识 host 与线协议（架构 § 13.4 的 P1）。
    assert.deepEqual(Object.keys(p).some((k) => k === 'provider' || k === 'wire' || k === 'model'), false)
  }
  // `src/assemble/models.ts` 从 P2d 起只是转发：它的 `modelOf` 与 `modelDeclOf` 同一条口径——
  // **值相同**，不是同一个对象的引用（投影每次新建一份）。
  assert.deepEqual(modelOf('deepseek-flash/openai', BUILTIN_CATALOG), prefixDeclOf(modelDeclOf('deepseek-flash/openai', BUILTIN_CATALOG)))
  assert.deepEqual(modelOf('', BUILTIN_CATALOG), prefixDeclOf(defaultModelOf(BUILTIN_CATALOG)))
  assert.deepEqual(modelOf(undefined, BUILTIN_CATALOG), prefixDeclOf(defaultModelOf(BUILTIN_CATALOG)))
  assert.throws(() => modelOf('gpt-9', BUILTIN_CATALOG), ModelDeclError)
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
  // 走过的那几步：**第 0 步没有**（那时候还没有任何往返），第 1 步起有一条——两条路
  // （有 turns · 没有 turns）都在这一份构造里盖到。
  const walked: readonly Turn[] =
    step === 0
      ? []
      : [
          {
            text: '先看一眼。',
            calls: [{ id: 't1', name: 'read', arguments: '{"path":"a"}' }],
            results: [{ id: 't1', output: '读到了。', isError: false }],
          },
        ]
  // **第二档用 `null` 说"这次不带工具"**：显式传 `undefined` 会吃到缺省参数（JS 的规矩），
  // 那样"带工具"与"不带工具"两档就分不开了。
  return tools === null
    ? { model: DECL.model, zones: { A: prefix.zoneA, B: prefix.zoneB, C: prefix.zoneC }, ...(walked.length === 0 ? {} : { turns: walked }), call: DECL.call, promptCache: 'implicit' }
    : { model: DECL.model, zones: { A: prefix.zoneA, B: prefix.zoneB, C: prefix.zoneC }, tools, ...(walked.length === 0 ? {} : { turns: walked }), call: DECL.call, promptCache: 'implicit' }
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
  // 请求那一栏：接口上的键 == 声明的那几个 == 从盘上读出来的那几个。
  assert.deepEqual(interfaceKeys('ModelRequest'), ['cHead', 'call', 'model', 'promptCache', 'tools', 'turns', 'zones'])
  // `turns` · `tools` · `call` · `cHead` 是同一类：**可选栏**——第 0 步没有轮次，另一条线不认结构化
  // 那一面，C 区那一段头是空的时不给（那时全文与尾巴逐字节相同）。四个不给时它们连键都不在。
  assert.deepEqual(
    interfaceKeys('ModelRequest').filter((k) => k !== 'tools' && k !== 'call' && k !== 'turns' && k !== 'cHead'),
    ['model', 'promptCache', 'zones'],
  )
  assert.deepEqual(interfaceKeys('Usage'), [...USAGE_FIELDS].sort(), '用量那一栏与 USAGE_FIELDS 对不上')
  assert.equal(USAGE_FIELDS.length, 6)
  // 架构 § 8.15 说的"用量的四个数"就是这四个——`USAGE_FIELDS` 多出来的两样里，一样是输出的明细
  // （思考 token），一样是坐标（上游报的模型名）；**钱只从这四个数算**（`src/model/price.ts`）。
  assert.deepEqual(USAGE_COUNTS, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'])
  assert.equal(USAGE_COUNTS.length, 4)

  // 事件那六个 `t`：联合里读出来的（不是第二份名单）。
  assert.deepEqual(eventKinds(), [
    'delta',
    'reasoning-delta',
    'reasoning-signature',
    'stop',
    'tool-call',
    'tool-delta',
    'tool-start',
    'usage',
  ])
  // 每一种事件都造一条真的出来（联合里有的，就得有东西能产出它）。
  const every: ModelEvent[] = [
    { t: 'delta', text: '先' },
    { t: 'reasoning-delta', text: '它想：' },
    { t: 'reasoning-signature', signature: 'sig-1' },
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
  // **接口上的键 == 这一份实际给的键 + 明说出来那几个没给的可选栏**：不给的连键都不在，所以
  // 这里要把它们点出来——不然"少了 `cHead`"与"本来就没有 `cHead`"分不开。这一份是**子 agent**
  // 那一趟的装配，而 C 区那一段头是运行时装配（持轮者手里那句人说的话）给的。
  const missing = interfaceKeys('ModelRequest').filter((k) => !Object.keys(back).includes(k))
  assert.deepEqual(missing, ['cHead'], `接口上有、这一份没给的栏：${missing.join(' · ')}`)
  assert.deepEqual(Object.keys(back).sort(), ['call', 'model', 'promptCache', 'tools', 'turns', 'zones'], '往返之后请求的键集变了')
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
    { t: 'usage', usage: { outputTokens: 300, cacheWriteTokens: null, model: 'deepseek-chat' } },
    { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
  ]
  const direct = checkEvents(events)
  const roundTrip = checkEvents(JSON.parse(JSON.stringify(events)) as ModelEvent[])
  assert.deepEqual(roundTrip, direct, '事件往返之后积出来的账不一样')
  assert.deepEqual(producedKeys(direct), ['rawStop', 'stop', 'text', 'thinking', 'toolCalls', 'usage'], '积出来的账的键集不是那六个')
})

// ── 这一份测试要读的两样：盘上的源码与模型目录 ────────────────────────────────

// `REPO` 由上面那一半（B0）声明，指的同一个目录——**不重复声明**（合成之后是同一个文件）。
const SRC = readFileSync(new URL('contract.ts', import.meta.url), 'utf8')
/** 模型那一栏的第一个声明：请求里那个 `model` 是**提供方那边的名字**（不是我们这边的键）。 */
const DECL = FIRST

assert.ok(REPO.endsWith('/') || REPO.endsWith('\\'), `仓库根那一串要是个目录：${REPO}`)
assert.ok(SRC.includes('export interface ModelRequest'), '盘上读到的那一份里没有 ModelRequest')
assert.equal(DECL.model, 'deepseek-flash')

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
  // **没有思考事件 → `null`**：那是"没开思考"，与"想了但一个字都没说"是两件事。
  assert.equal(call.thinking, null)

  // 用量并多次：只覆盖真的报了的字段，别的保持"没有读数"。
  const merged = checkEvents([
    { t: 'usage', usage: { inputTokens: 0, cacheWriteTokens: 0 } },
    { t: 'usage', usage: { outputTokens: 12 } },
    { t: 'usage', usage: { reasoningTokens: 5 } },
    { t: 'stop', reason: 'end-turn' },
  ])
  assert.deepEqual(merged.usage, {
    inputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: 0,
    outputTokens: 12,
    reasoningTokens: 5,
    model: null,
  })
  // 0 与 null 分得开：报上来的 0 就是 0，没报的那两项是 null。
  // **思考那一栏不进这四个数**：它并进来了（上面那条断言里的 5），而 `usageCount` 照旧数三个。
  assert.equal(usageCount(merged.usage as Usage), 3)
  assert.equal(usageCount({ ...(merged.usage as Usage), cacheReadTokens: 5 }), 4)
  assert.ok(JSON.stringify(merged.usage).includes('"cacheReadTokens":null'), '没读数的那一项在序列化里也要看得见')

  // 六种结束原因各积得出来，且 `stopped()` 与 `checkEvents` 同一份答案。
  const seen: StopReason[] = STOP_REASONS.map((reason) => stopped([{ t: 'stop', reason }]))
  assert.deepEqual(seen, [...STOP_REASONS])
  assert.deepEqual(STOP_REASONS.length, 6)
  // 前五种是"走完了、因为什么走的"，第六种是**上游自己说没走完**（`insufficient_system_resource`
  // / `aborted` / `pause_turn` 归到它，原话留在 `rawStop` 上）——值域按动作分，不按措辞分。
  assert.equal(STOP_REASONS[5], 'incomplete')
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
  // 请求里那 12 条就是目录那 12 条（逐字段相同；`catalog()` 每次给一份新数组，引用不同是设计如此）。
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

// ── 凭据那两条路的判据 ────────────────────────────────────────────────────────
//
// 由头（第 5 批 · 疑点 4）：`authOf()`（按声明逐条试）与壳的 `credentialAt()`（自己读文件）原先
// 是**两处实现**，而 `--credential <文件>` 走的是后一处、拼目标时又调前一处——于是"文件里那份
// 读到了也没用"（实测）。现在壳那一层只把 `--credential` 当**覆盖**交给 `authWith()`，而覆盖
// 换的只是"那个文件在哪"（环境变量那条路照旧最优先）。这两条断言落在**唯一那一处**上。
test('③b 凭据：覆盖只换"文件在哪"，配置那份表按顺序试（值不印）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-auth-'))
  const at = join(dir, 'fake.key')
  const value = 'sk-from-a-temp-file-0123456789'
  writeFileSync(at, value + '\n')

  // 二 · 不给覆盖时按配置走：那一条读不到 → 拒，且话里带着那个路径。
  //     （只认文件的表在 P2c 之后是**合形状**的——"至少一条环境变量"那条旧口径随声明时代收走了。）
  const fileOnly: readonly [{ readonly from: 'file'; readonly path: string }] = [{ from: 'file', path: '/nonexistent/never-here' }]
  assert.equal(authWith('probe', fileOnly, at), value, '覆盖没有生效')
  assert.throws(
    () => authWith('probe', fileOnly, null),
    (err: unknown) => err instanceof ModelDeclError && err.message.includes('/nonexistent/never-here'),
    '配置里那个路径该出现在拒的话里',
  )
  // 三 · **顺序是承重的**：环境变量在表里排第一时，第二条那个"读不到"根本不该被走到
  //     （判据是它成功了——若真去读那个文件，这一条会抛）。
  const envName = 'FUGUE_AUTH_ORDER_PROBE'
  const keep = process.env[envName]
  process.env[envName] = 'sk-from-env'
  try {
    const chain: readonly ({ readonly from: 'env'; readonly name: string } | { readonly from: 'file'; readonly path: string })[] = [
      { from: 'env', name: envName },
      { from: 'file', path: '/nonexistent/never-here' },
    ]
    assert.equal(authWith('probe', chain, null), 'sk-from-env', '第一条取到了就该返回它')
    // 四 · 覆盖只换文件那一格：**环境变量那条路照旧最优先**。
    assert.equal(authWith('probe', chain, at), 'sk-from-env', '覆盖把环境变量那条路挤掉了')
    // 五 · **表整个没配时，覆盖自己就是那条路**（`--credential` 给了就是要出网，不该被"没配"拦住）。
    assert.equal(authWith('probe', undefined, at), value, '没配 + 覆盖该走覆盖那条路')
  } finally {
    if (keep === undefined) delete process.env[envName]
    else process.env[envName] = keep
  }
  // **自己搭的临时目录自己收**：这一条里的假凭据文件没有留着的价值（值不印，路径也不是现场）。
  rmSync(dir, { recursive: true, force: true })
  console.log(`凭据读数：覆盖取到 ${value.length} 个字符（值不印）· 覆盖只换文件那一格 · 环境变量最优先 · 没配+覆盖走覆盖`)
})
