// P2d 的断言（PLAN § 5.20 的 P2d 行 · 架构 § 15.3.a 的 models.json 段 · § 10.3）。
// 跑法：cd ~/fugue && node --test src/model/catalog.test.ts
//
// **目录住数据文件，不住源码。** `~/.fugue/models.json` 在 → 它就是整份目录（不与内置合并）；
// 不在 → 内置档顶上。于是"接一个新模型"是一个数据改动，不是一次代码改动。
//
//   ① 加第三条模型（不改源码）→ readCatalog 读到它，modelDeclOf 查得到，缺省仍是文件的第一条
//   ② 负对照：删到只剩一条 → 缺省就是那一条 · wire 写错 → 拒 · 价目缺一行 → 拒 · 跨提供方重名 → 拒
//   ③ 地板：文件不在 → readCatalog 给的就是内置档（全量绿照旧是行为地板）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelDeclError, triggerAt, WIRE_NAMES } from './contract.ts'
import { priceOf } from './price.ts'
import { BUILTIN_CATALOG, defaultModelOf, modelDeclOf, providerOf, readCatalog } from './catalog.ts'

/** 内置那两条的人写法：文件里要写的正是这几样（provider 由所在那一层带出来，不写在模型上）。 */
const flashAnthropic = {
  protocol: 'subagent',
  wire: 'anthropic-messages',
  model: 'deepseek-flash',
  systemPromptUpdate: 'in-history',
  contextLimit: 1_048_576,
  budget: { handoffMargin: 16_000 },
  call: { thinking: 'high', maxTokens: 32_768 },
}
const flashOpenai = { ...flashAnthropic, wire: 'openai-chat' as const }
/** 第三条：今天源码目录里没有的（接它不改一行源码，就是这一格要证的）。 */
const proOpenai = { ...flashOpenai, model: 'deepseek-v4-pro' }

/** 一份目录文件：一个提供方底下铺那几条模型与价目（价目两行照官方页抄的口径）。 */
function catalogFile(models: Record<string, unknown>, prices: readonly unknown[] = priceRows()): string {
  return JSON.stringify({
    deepseek: { host: 'https://api.deepseek.com', models, prices },
  })
}
function priceRows(): readonly unknown[] {
  return [
    {
      model: 'deepseek-flash',
      aliases: ['deepseek-chat', 'deepseek-reasoner'],
      peak: { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 },
      offPeak: { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 },
    },
    {
      model: 'deepseek-v4-pro',
      aliases: [],
      peak: { cacheMiss: 1.32, cacheHit: 0.044, output: 3.96 },
      offPeak: { cacheMiss: 0.66, cacheHit: 0.022, output: 1.98 },
    },
  ]
}

/** 一个临时系统根，放一份 models.json 进去。**自己搭的自己收**。 */
function withCatalogFile(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-catalog-'))
  writeFileSync(join(dir, 'models.json'), text)
  return dir
}

test('① 目录住数据：models.json 加第三条模型 → readCatalog 读到它，缺省仍是文件的第一条', () => {
  const dir = withCatalogFile(
    '三条',
    catalogFile({
      'deepseek-flash/anthropic': flashAnthropic,
      'deepseek-flash/openai': flashOpenai,
      'deepseek-v4-pro/openai': proOpenai,
    }),
  )
  try {
    const cat = readCatalog(dir)
    assert.equal(Object.keys(cat.models).length, 3, `该读到三条，拿到 ${Object.keys(cat.models).join(' · ')}`)
    const decl = modelDeclOf('deepseek-v4-pro/openai', cat)
    assert.equal(decl.provider, 'deepseek', 'provider 由它所在的那一层带出来')
    assert.equal(decl.wire, 'openai-chat')
    assert.equal(decl.model, 'deepseek-v4-pro')
    assert.equal(decl.protocol, 'subagent')
    // **触发点缺省由上限算**（人不该手抄派生数）：文件里没写 trigger，读出来就是 triggerAt(上限)。
    assert.equal(decl.budget.trigger, triggerAt(decl.contextLimit))
    assert.equal(decl.budget.handoffMargin, 16_000)
    // **文件的次序承重**：第一条仍是缺省（Messages 优先那一条口径随文件走）。
    assert.equal(defaultModelOf(cat).id, 'deepseek-flash/anthropic')
    assert.equal(modelDeclOf(undefined, cat).id, 'deepseek-flash/anthropic')
    // 价目跟着目录走：新模型那条在文件的价目里命中它自己的行。
    assert.equal(priceOf('deepseek-v4-pro/openai', cat)?.model, 'deepseek-v4-pro')
    assert.equal(providerOf('deepseek', cat).host, 'https://api.deepseek.com')
    console.log(`① 读数：三条 ${Object.keys(cat.models).join(' · ')} · 触发点缺省 ${decl.budget.trigger}（triggerAt 算的）· 价目命中 deepseek-v4-pro`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('② 负对照：只剩一条 → 缺省就是它 · wire 写错 · 价目缺行 · 跨提供方重名，各该当场拒', () => {
  // 只剩一条：缺省就是那一条（单模型档与多模型档同一条口径）。
  const one = withCatalogFile('一条', catalogFile({ 'deepseek-v4-pro/openai': proOpenai }))
  try {
    const cat = readCatalog(one)
    assert.equal(defaultModelOf(cat).id, 'deepseek-v4-pro/openai')
    assert.equal(modelDeclOf('', cat).id, 'deepseek-v4-pro/openai')
  } finally {
    rmSync(one, { recursive: true, force: true })
  }

  // wire 写错是打错了一个字，不是"以后再支持"——当场拒，并列出有的。
  const badWire = withCatalogFile('坏线协议', catalogFile({ 'deepseek-flash/nope': { ...flashAnthropic, wire: 'anthropic' } }))
  try {
    assert.throws(
      () => readCatalog(badWire),
      (err: unknown) =>
        err instanceof ModelDeclError &&
        err.message.includes('deepseek-flash/nope') &&
        WIRE_NAMES.every((w) => err.message.includes(w)),
      '该拒并指出那一条与有的线协议',
    )
  } finally {
    rmSync(badWire, { recursive: true, force: true })
  }

  // 价目缺一行：那一条模型的钱算不出来，而"没有价目"不该等到读账那天才发现。
  const noPrice = withCatalogFile('缺价目', catalogFile({ 'deepseek-v4-pro/openai': proOpenai }, priceRows().slice(0, 1)))
  try {
    assert.throws(
      () => readCatalog(noPrice),
      (err: unknown) => err instanceof ModelDeclError && err.message.includes('deepseek-v4-pro'),
      '价目缺行该在载入时拒',
    )
  } finally {
    rmSync(noPrice, { recursive: true, force: true })
  }

  // 跨提供方重名：同一个模型键出现两次，两处的价目与 host 会静默分家——当场拒。
  // （同一份 JSON 对象里的重复键 JSON.parse 静默去重，那一种检不了——口径记在 catalog.ts 头注。）
  const dup = withCatalogFile(
    '重名',
    JSON.stringify({
      deepseek: { host: 'https://api.deepseek.com', models: { 'x/one': flashAnthropic }, prices: [] },
      other: { host: 'https://example.invalid', models: { 'x/one': flashOpenai }, prices: [] },
    }),
  )
  try {
    assert.throws(
      () => readCatalog(dup),
      (err: unknown) => err instanceof ModelDeclError && err.message.includes('x/one'),
      '跨提供方重名该拒',
    )
  } finally {
    rmSync(dup, { recursive: true, force: true })
  }
  console.log('② 读数：一条档缺省=那一条 · 坏 wire / 缺价目 / 跨提供方重名 各当场拒')
})

test('③ 地板：文件不在 → readCatalog 给的就是内置档（逐字段，不是合并）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-catalog-'))
  try {
    assert.equal(readCatalog(dir), BUILTIN_CATALOG, '文件不在 → 内置档顶上（同一个对象，不是合出来的另一份）')
    assert.deepEqual(readCatalog(dir), BUILTIN_CATALOG)
    // 内置档自己的读数照旧：缺省第一条 · 目录两条 · 价目两行。
    assert.equal(defaultModelOf(BUILTIN_CATALOG).id, 'deepseek-flash/anthropic')
    assert.equal(Object.keys(BUILTIN_CATALOG.models).length, 2)
    assert.equal(BUILTIN_CATALOG.prices.length, 2)
    assert.equal(priceOf('deepseek-flash/openai', BUILTIN_CATALOG)?.model, 'deepseek-flash')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('③ 读数：文件不在 = 内置档（同对象）· 两条声明 · 价目两行，与今天逐字段相同')
})
