// 0.2.9 ①：开发诊断网的正反两半。只读声明、调用纯诊断函数，属于 fast。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAPABILITY_TABLE } from '../src/capability/table.ts'
import type { CapabilityRow } from '../src/capability/table.ts'
import { TOOL_ENTRIES } from '../src/tools/catalog.ts'
import { checkCapabilityInvariants } from '../tools/check-invariants.ts'

test('实际独立目录与能力表：跨文件对账为零违反', () => {
  assert.deepEqual(checkCapabilityInvariants(), [])
})

test('目录截短、能力表漏行与表外名字：各指得出失配的工具', () => {
  const first = TOOL_ENTRIES[0]!
  assert.match(checkCapabilityInvariants(TOOL_ENTRIES.slice(1)).join('\n'), new RegExp(first.name))
  const missing = { ...CAPABILITY_TABLE }
  delete missing[first.name]
  assert.deepEqual(checkCapabilityInvariants(TOOL_ENTRIES, missing), [`目录里有这个工具，能力表里没有它：${first.name}`])
  const extra = { ...CAPABILITY_TABLE, invented: { layer: 'view', capability: 'invented', decl: false } } as const
  assert.deepEqual(checkCapabilityInvariants(TOOL_ENTRIES, extra), ['能力表里有这个工具，目录里没有它：invented'])
})

test('目录重复同一条：集合相等不能吞掉重名', () => {
  const first = TOOL_ENTRIES[0]!
  assert.deepEqual(checkCapabilityInvariants([...TOOL_ENTRIES, first]), [`工具目录重名：${first.name}`])
})

test('已有工具带未知层：没有声明集也必须报出，不能只核名字集合', () => {
  const invalid = {
    ...CAPABILITY_TABLE,
    read: { ...CAPABILITY_TABLE.read!, layer: 'unknown', decl: false },
  } as unknown as Readonly<Record<string, CapabilityRow>>
  assert.deepEqual(checkCapabilityInvariants(TOOL_ENTRIES, invalid), ['能力表里的层未声明：read → unknown'])
})

test('能力身份与声明集：内部常量的类型注解不是运行时证明', () => {
  const wrongIdentity = { ...CAPABILITY_TABLE, read: { ...CAPABILITY_TABLE.read!, capability: 'write' } }
  assert.deepEqual(checkCapabilityInvariants(TOOL_ENTRIES, wrongIdentity), ['能力标识不是这一格的工具名：read → write'])
  const wrongDecl = { ...CAPABILITY_TABLE, read: { ...CAPABILITY_TABLE.read!, decl: true } }
  assert.deepEqual(checkCapabilityInvariants(TOOL_ENTRIES, wrongDecl), ['只有执行层能有声明集：read'])
  const untypedDecl = { ...CAPABILITY_TABLE, read: { ...CAPABILITY_TABLE.read!, decl: 'false' } } as unknown as Readonly<Record<string, CapabilityRow>>
  assert.deepEqual(checkCapabilityInvariants(TOOL_ENTRIES, untypedDecl), ['声明集标记不是布尔值：read'])
})
