/**
 * 样本盘判据的判据：**六条**，每一条都拿一棵树当输入，判它过不过。
 *
 * 负对照是这一份的重点：一份"什么都说对"的判据是没有牙的，所以 ② ③ ④ 各钉一条会红的，
 * ⑤ 钉"一条判据都没有不算过"，⑥ 钉"判据自己不碰输入"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { boardLines, judgeOf } from './board.ts'
import type { Answer, Tree } from './board.ts'

const T = (o: Record<string, string | null>): Tree => o

test('① 全中：过，而且每一条都留下读数', () => {
  const answer: Answer = [
    { path: 'src/format.ts', form: 'file', contains: ['toFixed(2)'], notContains: ['String(cents)'] },
    { path: 'legacy/old-format.js', form: 'absent' },
  ]
  const v = judgeOf(answer, T({ 'src/format.ts': 'export const yuan = (c: number) => (c / 100).toFixed(2)' }))
  assert.equal(v.ok, true)
  assert.deepEqual(v.failed, [])
  assert.equal(v.verdicts.length, 2)
  assert.match(v.why, /全中（2 条）/)
})

test('② 应当在而实得不在：不过，且指得出是哪一条', () => {
  const v = judgeOf([{ path: 'src/total.ts', form: 'file', contains: ['export function avg'] }], T({}))
  assert.equal(v.ok, false)
  assert.deepEqual(v.failed, ['src/total.ts'])
  assert.match(v.verdicts[0].note, /应当在，实得不在/)
  assert.match(v.why, /红 1\/1 条：src\/total\.ts/)
})

test('③ 内容不合：该有的没有、不该有的却在，各红一次', () => {
  const has: Answer = [{ path: 'a.ts', form: 'file', contains: ['toFixed(2)'] }]
  const not: Answer = [{ path: 'a.ts', form: 'file', notContains: ['TODO'] }]
  const tree = T({ 'a.ts': 'export const yuan = String(cents) // TODO' })
  assert.equal(judgeOf(has, tree).ok, false)
  assert.match(judgeOf(has, tree).verdicts[0].note, /找不到 "toFixed\(2\)"/)
  assert.equal(judgeOf(not, tree).ok, false)
  assert.match(judgeOf(not, tree).verdicts[0].note, /不该有 "TODO"/)
})

test('④ `absent` 那一档：不在算过，还在不算', () => {
  const answer: Answer = [{ path: 'legacy/old-format.js', form: 'absent' }]
  assert.equal(judgeOf(answer, T({})).ok, true)
  const still = judgeOf(answer, T({ 'legacy/old-format.js': 'module.exports = {}' }))
  assert.equal(still.ok, false)
  assert.match(still.verdicts[0].note, /应当不在，实得在/)
})

test('⑤ 一条判据都没有 = 不过（"没人能判"不许当绿，与 merge/accept.ts:115 同一条）', () => {
  const v = judgeOf([], T({ 'a.ts': '随便什么' }))
  assert.equal(v.ok, false)
  assert.match(v.why, /一条判据都没有/)
})

test('⑥ 判据自己不碰输入：同一份输入判两次逐字段相同，树一个字段没变', () => {
  const tree = T({ 'a.ts': 'x', 'b.ts': null })
  const before = JSON.stringify(tree)
  const answer: Answer = [
    { path: 'a.ts', form: 'file', contains: ['x'] },
    { path: 'b.ts', form: 'absent' },
  ]
  const one = judgeOf(answer, tree)
  const two = judgeOf(answer, tree)
  assert.deepEqual(one, two)
  assert.equal(JSON.stringify(tree), before)
  assert.deepEqual(boardLines('样本一', one), ['  样本一：已知答案全中（2 条）'])
})
