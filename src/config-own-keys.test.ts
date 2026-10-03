// ① 的四条不变量（配置与文档对账批）：配置的**读 · 写 · 查询**三面只走自有属性——`__proto__` 这类键段
// 当**字面数据**存取，不再变成原型操作（架构 § 15.3.a 的键域是闭的，闭的是**顶层键名**，
// 不是"不许有叫 `__proto__` 的成员"）。
//
//   ① 写面报成功必须真写：set → 序列化（落盘那份的形状）→ 解析回来 → 读到的值全等。
//      `Object.defineProperty` 缺省 `enumerable: false`——不给全描述符的写法会把「假成功」
//      换成「静默丢键」，两种都不及格，所以这一条连**描述符**一起断。
//   ② `Object.prototype` 全程干净：写 · 合并 · 读三路都不许碰它（`constructor.prototype`
//      是同胞向量，按类收口，不是给 `__proto__` 开一张黑名单）。
//   ③ 查询面对不存在的键报缺：**继承成员不算数**（`config.toString` 那种），人要听见
//      「没有这条键」，而不是一个退 0 打印出来的 `undefined`。
//   ④ 两级合并（系统级 + 工作区级）对含此类键的文件同样当字面数据，且不污染。
//   ⑥ 读那一面也不许**看**原型链：`Object.prototype` 上挂了可枚举成员时，合并与查询都不受它
//      影响（不是"我们不去写它"，而是"它的内容不算配置"）。
//
// 负对照（改之前那一份码上：① ② ③ ④ ⑤ 全红，实测读数——版本号不写在这里，`test/version.test.ts` 只许它住在 package.json）：
//   · `setConfig(doc, 'config.__proto__.x', 'wrote-it')` → `Object.prototype.x === 'wrote-it'`，
//     而 `JSON.stringify(doc)` 还是 `{"config":{}}`——报成功，那份里一个字节没多；
//   · `getConfig({ config: {} }, 'config.toString')` → 拿回的是函数；CLI 那一面退 0 打印 `undefined`；
//   · 合并那一面：只有工作区那份带 `__proto__` 时，`out['__proto__'] = v` 撞上继承来的设值器，
//     `merged.config` 的原型被换成那个对象（JSON 里看不见，`getConfig` 却"读得到"）。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { getConfig, readConfig, setConfig, type ConfigDoc } from './config.ts'
import { runCli } from '../test/helpers/run-cli.ts'
import { tmpDir } from '../test/helpers/tmp.ts'

/** `Object.prototype` 上的自有成员名单（排序后比对：多一个名字就是被污染了）。 */
const protoNames = (): string[] => Object.getOwnPropertyNames(Object.prototype).sort()

/** 临时换掉系统级那一层（`readConfig` 缺省读 `~/.fugue`），跑完还原——测试不跟着这台机器走。 */
async function withSystemDir<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const had = process.env['FUGUE_SYSTEM_DIR']
  process.env['FUGUE_SYSTEM_DIR'] = dir
  try {
    return await body()
  } finally {
    if (had === undefined) delete process.env['FUGUE_SYSTEM_DIR']
    else process.env['FUGUE_SYSTEM_DIR'] = had
  }
}

test('① 写面报成功必须真写：JSON 往返全等，键还得是可枚举的自有属性', () => {
  const doc: ConfigDoc = { config: {} }
  setConfig(doc, 'config.__proto__.hidden', 'literal')
  setConfig(doc, 'config.constructor.prototype.value', 2)
  setConfig(doc, 'config.prototype', 3)
  setConfig(doc, 'config.toString', '字面成员，不是继承来的那个函数')

  const text = JSON.stringify(doc)
  assert.match(text, /"__proto__"/, `那份里看不见这个键（描述符不给 enumerable 就会在这被丢掉）：${text}`)
  const back = JSON.parse(text) as ConfigDoc
  assert.equal(getConfig(back, 'config.__proto__.hidden'), 'literal')
  assert.equal(getConfig(back, 'config.constructor.prototype.value'), 2)
  assert.equal(getConfig(back, 'config.prototype'), 3)
  assert.equal(getConfig(back, 'config.toString'), '字面成员，不是继承来的那个函数')
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
    const d = Object.getOwnPropertyDescriptor(back.config as ConfigDoc, key)
    assert.equal(d?.enumerable, true, `${key} 要落成自有的可枚举数据属性：${JSON.stringify(d)}`)
    assert.equal(d?.writable, true, `${key} 该是可写的普通数据属性`)
    assert.equal(d?.configurable, true, `${key} 该是可配置的普通数据属性`)
  }
  console.log(`① 读数：${text}`)
})

test('② Object.prototype 全程干净：写与读两路都不许碰它', () => {
  const marker = 'fugueOwnKeyProbe0211'
  const before = protoNames()
  try {
    setConfig({ config: {} }, `config.__proto__.${marker}`, 'wrote-it')
    getConfig({ config: {} }, 'config.toString')
    getConfig({ config: {} }, 'config.constructor')
    assert.equal((Object.prototype as Record<string, unknown>)[marker], undefined, 'Object.prototype 上被挂上了键')
    assert.deepEqual(protoNames(), before, 'Object.prototype 的自有成员名单变了')
  } finally {
    delete (Object.prototype as Record<string, unknown>)[marker]
  }
  console.log(`② 读数：Object.prototype 自有成员 ${before.length} 个，跑完没变`)
})

test('③ 查询面对不存在的键报缺：继承成员不算数', async () => {
  assert.equal(getConfig({ config: {} }, 'config.toString'), undefined)
  assert.equal(getConfig({ config: {} }, 'config.constructor'), undefined)
  assert.equal(getConfig({ config: {} }, 'config.hasOwnProperty'), undefined)
  const inheritedRoot = Object.create({ config: { x: 1 } }) as unknown as ConfigDoc
  assert.equal(getConfig(inheritedRoot, 'config.x'), undefined, '根那一层的继承成员不算')
  const inheritedMid = { config: Object.create({ x: 1 }) } as ConfigDoc
  assert.equal(getConfig(inheritedMid, 'config.x'), undefined, '中间那一层的继承成员不算')

  const sys = tmpDir('fugue-own-keys-get-sys-')
  await withSystemDir(sys, async () => {
    const root = tmpDir('fugue-own-keys-get-')
    const r = await runCli(['--root', root, 'config', 'get', 'config.toString'])
    assert.equal(r.code, 1, `继承成员被当成配好了：stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`)
    assert.match(r.stderr, /没有这条键/)
    console.log(`③ 读数：人面那一句是「${r.stderr.split('\n')[0]}」，退 ${r.code}`)
  })
})

test('④ 两级合并对含此类键的文件同样当字面数据，且不换原型', async () => {
  const root = tmpDir('fugue-own-keys-merge-')
  const sys = tmpDir('fugue-own-keys-merge-sys-')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  writeFileSync(
    join(root, '.fugue', 'config'),
    '{"config":{"__proto__":{"local":"from-workspace"},"ordinary":1,"object":{"right":2}},"ui":{"keys":{"__proto__":"g"}}}',
  )
  // 第一趟：只有工作区那份带 `__proto__`——旧码在这里撞上继承来的设值器，把原型换掉。
  writeFileSync(join(sys, 'config'), '{"config":{"object":{"left":1}}}')
  const before = protoNames()
  const merged = await readConfig(root, sys)
  assert.equal(getConfig(merged, 'config.__proto__.local'), 'from-workspace')
  assert.equal(getConfig(merged, 'config.ordinary'), 1)
  assert.deepEqual(getConfig(merged, 'config.object'), { left: 1, right: 2 }, '普通对象照旧深合并')
  assert.equal(Object.getPrototypeOf(merged.config), Object.prototype, '合并出来的 config 原型被换掉了')
  assert.deepEqual(
    JSON.parse(JSON.stringify(merged)),
    JSON.parse(
      '{"config":{"__proto__":{"local":"from-workspace"},"ordinary":1,"object":{"left":1,"right":2}},' +
        '"ui":{"keys":{"__proto__":"g"}}}',
    ),
    '序列化出来要逐字等于两份输入该合出来的样子',
  )
  assert.deepEqual(
    Object.entries(getConfig(merged, 'ui.keys') as ConfigDoc),
    [['__proto__', 'g']],
    '手改文件里的字面动作名读得出来（写那面拦不拦是另一条）',
  )
  // 第二趟：两份都带——两个**字面对象**照深合并，不是"整份赢"
  writeFileSync(join(sys, 'config'), '{"config":{"__proto__":{"net":"from-system"}}}')
  const both = await readConfig(root, sys)
  assert.equal(getConfig(both, 'config.__proto__.net'), 'from-system')
  assert.equal(getConfig(both, 'config.__proto__.local'), 'from-workspace')
  assert.equal(Object.getPrototypeOf(both.config), Object.prototype)
  assert.deepEqual(protoNames(), before, '合并这一路也没碰 Object.prototype')
  console.log('④ 读数：两份的 `__proto__` 都当字面数据深合并；原型与 Object.prototype 都没动')
})

test('⑤ 端到端：set 报成功就有字节落盘，get / show 读得回来；`ui.keys` 的语义校验也不静默跳过', async () => {
  const root = tmpDir('fugue-own-keys-cli-')
  const sys = tmpDir('fugue-own-keys-cli-sys-')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  await withSystemDir(sys, async () => {
    const marker = 'fugueOwnKeyCli0211'
    const set = await runCli(['--root', root, 'config', 'set', `config.__proto__.${marker}`, 'wrote-it'])
    assert.equal(set.code, 0, set.stderr)
    const text = readFileSync(join(root, '.fugue', 'config'), 'utf8')
    assert.match(text, /"__proto__"/, `报成功却没写进那份：${text}`)
    assert.equal(getConfig(JSON.parse(text) as ConfigDoc, `config.__proto__.${marker}`), 'wrote-it')

    const get = await runCli(['--root', root, 'config', 'get', `config.__proto__.${marker}`])
    assert.equal(get.code, 0, get.stderr)
    assert.equal(get.stdout.trim(), 'wrote-it')

    const show = await runCli(['--root', root, 'config', 'show'])
    assert.equal(show.code, 0, show.stderr)
    assert.deepEqual(JSON.parse(show.stdout), JSON.parse(text), 'show 印的就是那份真有的')

    // `config set ui.keys.<动作>` 的暂存对象也走自有属性：`__proto__` 这个"动作名"不再从
    // 写面的语义校验里静默消失——与别的认不出的动作名同一面（当场拒，且不写盘）。
    const ui = await runCli(['--root', root, 'config', 'set', 'ui.keys.__proto__', 'g'])
    assert.equal(ui.code, 1, `认不出的动作该当场拒：stdout=${JSON.stringify(ui.stdout)} stderr=${JSON.stringify(ui.stderr)}`)
    assert.match(ui.stderr, /配不了/)
    assert.equal(
      getConfig(JSON.parse(readFileSync(join(root, '.fugue', 'config'), 'utf8')) as ConfigDoc, 'ui.keys.__proto__'),
      undefined,
      '拒了就不许写盘',
    )
    console.log(`⑤ 读数：set 退 ${set.code} · get 退 ${get.code}（${get.stdout.trim()}）· ui.keys.__proto__ 退 ${ui.code}`)
  })
})

test('⑥ 读那一面也不许看原型链：原型上挂着可枚举成员时，合并与查询都不受它影响', async () => {
  const canary = 'fugueProtoCanary0211'
  const root = tmpDir('fugue-own-keys-canary-')
  const sys = tmpDir('fugue-own-keys-canary-sys-')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  writeFileSync(join(root, '.fugue', 'config'), '{"config":{"__proto__":{"local":"from-workspace"}}}')
  // 系统级那份也带 `config`：合并要真的**递归进 config 这一层**，`__proto__` 那一格才走到下面
  // 那一步（只有一边有 `config` 时整份赢，压根不递归——那样这条断言是空的）。
  writeFileSync(join(sys, 'config'), '{"config":{"ordinary":1}}')
  // 造一个"原型上多出可枚举成员"的世界：合并那一处若还是 `out[k]`，读到的是 `Object.prototype`，
  // 展开它就把这一条也当成配置合进去。
  Object.defineProperty(Object.prototype, canary, {
    value: 'inherited',
    enumerable: true,
    writable: true,
    configurable: true,
  })
  try {
    const merged = await readConfig(root, sys)
    const literal = getConfig(merged, 'config.__proto__') as ConfigDoc
    assert.equal(getConfig(merged, 'config.ordinary'), 1, '系统级那一份要真的并进来，不然这一步没递归')
    assert.deepEqual(Object.keys(literal), ['local'], `合并把原型上的可枚举成员当成了配置：${JSON.stringify(literal)}`)
    assert.equal(getConfig(merged, `config.__proto__.${canary}`), undefined, '查询也不许顺着原型链拿到值')
    assert.equal(getConfig(merged, `config.${canary}`), undefined)
  } finally {
    delete (Object.prototype as Record<string, unknown>)[canary]
  }
  console.log('⑥ 读数：原型上挂着可枚举成员时，合并与查询都只认自有属性')
})
