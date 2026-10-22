// argv 解析的两条表外纪律：**取值的开关**与"开关后面跟的还是开关"。
//
// `VALUED` 少列一个名字的症状不是报错，而是它的值变成位置参数、命令当场退 2（实测：
// `docs build --theme govuk` 里 govuk 被当成多出来的位置参数）。这一份把"谁取值"钉成断言。
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgv } from './argv.ts'

test('① docs 的两个开关取值：--at 与 --theme 后面那一段不是位置参数', () => {
  const p = parseArgv(['docs', 'build', '--at', 'abc123', '--theme', 'govuk'])
  assert.equal(p.flags.get('at'), 'abc123')
  assert.equal(p.flags.get('theme'), 'govuk')
  assert.deepEqual(p.positional, ['docs', 'build'], '两个值都不该落成位置参数')
  console.log(`① 读数：at=${p.flags.get('at')} theme=${p.flags.get('theme')} positional=${p.positional.join(' ')}`)
})

test('② 负对照：后面紧跟另一个开关时，前一个不吞值；表外的开关仍是开关', () => {
  const p = parseArgv(['docs', 'build', '--at', '--theme', 'govuk', '--nope'])
  assert.equal(p.flags.get('at'), true, '--at 后面是开关时它不该把开关吃掉')
  assert.equal(p.flags.get('theme'), 'govuk')
  assert.equal(p.flags.get('nope'), true, '表外开关一律是开关，值由命令自己去拒')
  assert.deepEqual(p.positional, ['docs', 'build'])
  console.log('② 读数：--at 成开关 · --theme 取值 · --nope 是开关')
})
