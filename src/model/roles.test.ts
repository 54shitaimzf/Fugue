// 角色那一层的解析口径（路线图多模型面那行（角色层站） 本体第一件）：三个角色各配各的模型 + 全局回退链。
//
// 跑法：cd ~/fugue && node --test src/model/roles.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConfigDoc } from '../config.ts'
import { UsageError } from '../value/types.ts'
import type { Catalog, } from './catalog.ts'
import type { ModelDecl } from './contract.ts'
import { ModelDeclError } from './contract.ts'
import { faceHandle, faceOf, roleChainOf } from './roles.ts'
import type { ModelFace } from './roles.ts'
import { HOLDER_PROTOCOL } from '../assemble/protocol.ts'
import type { Target } from './http.ts'
import type { AgentHandle } from '../runtime/step.ts'
import { emptyState } from '../assemble/sources.ts'

/** 一份两模型的测试目录（手拼，不走 `readCatalog`——载入核对要价目，这里的脸不谈钱）。 */
const A: ModelDecl = {
  id: 'test/primary',
  protocol: 'subagent',
  provider: 'testco',
  wire: 'anthropic-messages',
  model: 'test-main',
  systemPromptUpdate: 'in-history',
  contextLimit: 100_000,
  budget: { trigger: 35_000, handoffMargin: 4_000 },
  call: { thinking: 'off' },
}
const B: ModelDecl = { ...A, id: 'test/backup', model: 'test-backup', wire: 'openai-chat' }
const CAT: Catalog = {
  providers: { testco: { id: 'testco', host: 'https://test.invalid' } },
  models: { [A.id]: A, [B.id]: B },
  prices: [],
}

const doc = (o: Record<string, unknown>): ConfigDoc => o as ConfigDoc

test('① 解析次序：--model 旗标 > 角色键 > round.model（base）> 目录第一条；角色间互不打扰', () => {
  // 旗标盖过角色键（一次性的那一趟就是"三个角色都换到 X"）；旗标不在，角色键才说了算。
  const d = doc({ round: { models: { holder: 'test/backup' }, model: 'test/primary' } })
  assert.equal(roleChainOf(d, CAT, 'holder', 'test/primary', 'test/primary')[0]?.id, 'test/primary', '旗标盖过角色键')
  assert.equal(roleChainOf(d, CAT, 'holder', 'test/primary')[0]?.id, 'test/backup', '旗标不在，角色键盖过 base')
  assert.equal(roleChainOf(d, CAT, 'cell', 'test/primary')[0]?.id, 'test/primary', '没配的角色用 base')
  assert.equal(roleChainOf(doc({}), CAT, 'ruler', undefined)[0]?.id, 'test/primary', 'base 也没有就目录第一条')
  // round.models 与 round.model 平级共存（round.model 仍是字符串，两种形状不打架）。
  assert.equal(typeof (d.round as { model: unknown }).model, 'string')
  // 角色键给了却不是非空字符串：打错了一个字，当场拒（不静默读成"没配"）。
  assert.throws(() => roleChainOf(doc({ round: { models: { cell: 7 } } }), CAT, 'cell', undefined), /round.models.cell 要是一个模型名字/)
  // 角色键指向目录里没有的名字：modelDeclOf 那一处拒并列出目录。
  assert.throws(() => roleChainOf(doc({ round: { models: { cell: 'nope/x' } } }), CAT, 'cell', undefined), ModelDeclError)
})

test('② 回退链：缺省是空链（不换模型）· 全局一份按次序 · 主脸与重复按角色跳过（不拦开跑）', () => {
  const none = roleChainOf(doc({ round: { model: 'test/primary' } }), CAT, 'cell', undefined)
  assert.equal(none.length, 1, '没配 round.fallback 就是空链——缺省不换模型')

  const chain = roleChainOf(doc({ round: { model: 'test/primary', fallback: ['test/backup'] } }), CAT, 'cell', undefined)
  assert.deepEqual(chain.map((m) => m.id), ['test/primary', 'test/backup'], '主脸在前，链按次序跟在后面')
  // 三个角色共用同一条链；链里有这一角色的主脸时跳过它——cell=A, ruler=B, fallback=[B] 该能开跑
  // （base 是调用方解析完的缺省：`selectedModelId` 把 round.model 折进去了）。
  const shared = doc({ round: { models: { ruler: 'test/backup' }, fallback: ['test/backup'] } })
  assert.deepEqual(
    roleChainOf(shared, CAT, 'cell', 'test/primary').map((m) => m.id),
    ['test/primary', 'test/backup'],
    '子格的链是 A→B（正当组合，不因裁断的主脸在链里而被拦）',
  )
  assert.deepEqual(
    roleChainOf(shared, CAT, 'ruler', 'test/primary').map((m) => m.id),
    ['test/backup'],
    '全局链里就是这一角色的主脸：跳过，链里没有别人',
  )
  // 主脸自己与重复的名字跳过（一张脸在这一格里至多试一次），不是拒——拒会把别的角色的正当组合拦死。
  assert.deepEqual(
    roleChainOf(doc({ round: { fallback: ['test/primary'] } }), CAT, 'cell', undefined).map((m) => m.id),
    ['test/primary'],
    '主脸自己被跳过：链空了，与没配一样',
  )
  assert.deepEqual(
    roleChainOf(doc({ round: { fallback: ['test/backup', 'test/backup', 'test/primary'] } }), CAT, 'cell', undefined).map((m) => m.id),
    ['test/primary', 'test/backup'],
    '重复与主脸都跳过，其余按次序去重',
  )
  // 形状不对 · 名字未知——仍然当场拒，话里指得出是哪一条。
  assert.throws(() => roleChainOf(doc({ round: { fallback: 'test/backup' } }), CAT, 'cell', undefined), /round.fallback 要是一份模型名字的表/)
  assert.throws(() => roleChainOf(doc({ round: { fallback: ['nope/x'] } }), CAT, 'cell', undefined), ModelDeclError)
})

test('③ 脸是惰性的：凭据没配不在构造时报，在第一次 target() 那一跑才报；给了 credential 就用它', () => {
  const noCreds = faceOf(B, CAT, { doc: doc({}) })
  assert.throws(() => noCreds.target(), /凭据没有配|credentials/, '真要用这张脸才报得出凭据那一档')
  // 配了引用表（环境变量那一档）：设一个临时变量。
  process.env.FUGUE_ROLES_TEST_KEY = 'sk-test-value'
  try {
    const viaEnv = faceOf(B, CAT, { doc: doc({ credentials: { testco: [{ from: 'env', name: 'FUGUE_ROLES_TEST_KEY' }] } }) })
    const t = viaEnv.target()
    assert.equal(t.host, 'https://test.invalid', '目标从目录拼出来')
    assert.equal(t.model, 'test-backup', '提供方那边的名字是这张脸自己的')
    assert.equal(t.wire.name, 'openai-chat', '线协议跟着这张脸换')
  } finally {
    delete process.env.FUGUE_ROLES_TEST_KEY
  }
  // 给了 credential 就用它（主脸那一档——`--credential` / 回放档的口径由调用方拼好递进来）。
  const given = faceOf(A, CAT, { doc: doc({}), credential: '直接给的值' })
  assert.equal(given.target().headers['authorization'] ?? given.target().headers['Authorization'] ?? '（看下一条）', '（看下一条）')
  assert.ok(Object.values(given.target().headers).includes('直接给的值'), '凭据原样进了头')
  console.log('①②③ 读数：次序 旗标>角色键>base>目录第一条 · 链缺省空 · 主脸与重复跳过 · 脸惰性（凭据那一跑才取）')
})

test('④ 换脸不换角色：faceHandle 只动模型那几栏，protocol（角色）与 state 原样', () => {
  // 持轮者的句柄：HOLDER_PROTOCOL 是它角色的那一份（工具派发按 `h.protocol === HOLDER_PROTOCOL`
  // 认持轮者——`exit_plan_mode` 交卷靠它）。回退脸的声明 protocol 是 'subagent'：换模型不许把
  // 角色也换了。
  const fakeTarget = { host: 'https://test.invalid', path: '/x', headers: {}, from: 'test', wire: { name: 'openai-chat' } } as Target
  const face: ModelFace = { decl: B, target: () => fakeTarget }
  const h: AgentHandle = {
    agent: 'round' as AgentHandle['agent'],
    coord: null,
    branch: 'refs/heads/main' as AgentHandle['branch'],
    contract: '' as AgentHandle['contract'],
    protocol: HOLDER_PROTOCOL,
    model: A.id,
    wireModel: A.model,
    target: fakeTarget,
    adapter: { name: A.wire },
    call: A.call,
    state: emptyState(),
  }
  const out = faceHandle(h, face)
  assert.equal(out.protocol, HOLDER_PROTOCOL, '角色协议原样——换模型不换角色（exit_plan_mode 的派发闸读它）')
  assert.equal(out.model, B.id, '我们这边的键跟着换')
  assert.equal(out.wireModel, B.model, '提供方那边的名字跟着换')
  assert.equal(out.adapter.name, B.wire, '线协议跟着换')
  assert.equal(out.call, B.call, '调用配置跟着换（声明里那一档）')
  assert.equal(out.target, fakeTarget, '目标换成新脸的那一个')
  assert.equal(out.state, h.state, '状态与坐标不动：换脸不改这一格走到哪儿了')
})
