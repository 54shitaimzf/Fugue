// `-- k=v` 注入键的自有属性断言（配置与文档对账批的追收）：`parseInjections` 的键是人给的键名，与配置键
// 同一句语义——成员名是数据，`__proto__` 也在内。旧码是普通赋值：`__proto__=2` 撞上原型
// 设值器而值又不是对象，整个动作无声无效——命令照常成功，子进程里却没有那个变量。
//
//   ① 原型样的名字当字面数据：`__proto__` · `constructor` · `hasOwnProperty` 都落成自有的
//      可枚举数据格，一对不丢；`Object.prototype` 没动。
//   ② 正常注入与保留键检查照旧：`A=b=c` 的值带等号原样进 · `HOME` 那一档当场拒。
//
// 负对照（对未修的 parseInjections）：① 红——`__proto__` 那一对丢了（Object.keys 里没有它）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInjections } from './binding.ts'

test('① 原型样的注入键当字面数据：自有可枚举格，一对不丢', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort()
  const out = parseInjections(['__proto__=2', 'constructor=3', 'hasOwnProperty=4', 'plain=ok'])
  assert.deepEqual(
    Object.keys(out).sort(),
    ['__proto__', 'constructor', 'hasOwnProperty', 'plain'],
    `有注入对被无声丢掉：${JSON.stringify(out)}`,
  )
  assert.equal(out['__proto__'], '2')
  assert.equal(out['constructor'], '3')
  assert.equal(out['hasOwnProperty'], '4')
  assert.equal(out['plain'], 'ok')
  for (const k of Object.keys(out)) {
    const d = Object.getOwnPropertyDescriptor(out, k)
    assert.equal(d?.enumerable, true, `${k} 要是自有的可枚举数据格：${JSON.stringify(d)}`)
    assert.equal(d?.writable, true, `${k} 要可写`)
    assert.equal(d?.configurable, true, `${k} 要可配置`)
  }
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.prototype).sort(),
    before,
    'Object.prototype 没动',
  )
})

test('② 正常注入与保留键检查照旧', () => {
  const out = parseInjections(['CC=gcc', 'A=b=c'])
  assert.deepEqual(out, { CC: 'gcc', A: 'b=c' }, '值里的等号原样进')
  assert.throws(() => parseInjections(['HOME=/x']), '坐标那一档照旧当场拒')
})
