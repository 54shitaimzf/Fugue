// **schema 与事件联合对账进闸**（可读性五件之一，验收格原句）。出处：ROADMAP § 5 的 0.4.1 行
// （事件联合 → JSON Schema 契约件，外部语言客户端不再手抄解析）· 架构 § 8.1（联合唯一那一处）。
//
// 判据住在 `tools/export-schema.ts`（从联合的源码推），这里跑它，并配两条负对照——联合一动，
// 契约当场对不上；联合里出现一个认不出的形状，生成器**报错**而不是给一个 `{}` 放过去。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  SCHEMA_FILE,
  buildSchema,
  membersOf,
  readSources,
  schemaText,
} from '../tools/export-schema.ts'

const REPO = join(import.meta.dirname, '..')
const TOOL = join(REPO, 'tools', 'export-schema.ts')

type Family = { title: string; required: readonly string[]; properties: Record<string, unknown> }
const oneOfOf = (schema: Record<string, unknown>): readonly Family[] => schema.oneOf as readonly Family[]

test('契约件与联合逐字节一致（提交的那一份 = 现推的那一份）', () => {
  const have = readFileSync(SCHEMA_FILE, 'utf8')
  assert.equal(have, schemaText(), 'src/log/events.schema.json 与联合漂了：跑 node tools/export-schema.ts')
  const schema = JSON.parse(have) as Record<string, unknown>
  const families = oneOfOf(schema).map((m) => m.title)
  // 一族一格、不重不漏；而"联合里有哪几族"由另一条路数一遍（`membersOf` 之外的那一条是下面那个正则）。
  assert.equal(new Set(families).size, families.length, `族名有重的：${families.join(' ')}`)
  const source = readSources().events
  const fromSource = [...source.matchAll(/t:\s*'([a-zA-Z]+\/[a-zA-Z]+|signal)'/g)].map((m) => m[1])
  assert.deepEqual([...families].sort(), [...new Set(fromSource)].sort(), '契约里的族与联合里的族对不上')
  assert.equal(families.length, 30, `族数变了：${families.length}——联合动了就得重推这一份`)
  console.log(`读数：${families.length} 族 · 契约 ${have.length} 字节 · 与联合逐字节一致`)
})

test('每一族的必需栏与 `t` 一致：`t` 恒在，可选栏不进 required', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as Record<string, unknown>
  for (const m of oneOfOf(schema)) {
    assert.equal(m.required[0], 't', `${m.title} 的 required 第一名该是 t`)
    assert.deepEqual(Object.keys(m.properties)[0], 't', `${m.title} 的 properties 第一名该是 t`)
    // 可选栏（`?` 那一类）不许进 required——它与联合里那几个 `?:` 对得上（抽查两条）。
    if (m.title === 'run/start') {
      assert.equal(m.required.includes('argv'), false, 'argv 是可选栏')
      assert.equal(m.required.includes('cwd'), false, 'cwd 是可选栏')
      assert.equal(m.required.includes('agent'), true)
    }
    if (m.title === 'ask/ruling') {
      assert.equal(m.required.includes('tier'), false, 'tier 是可选栏')
      assert.equal(m.required.includes('asked'), true)
    }
  }
})

test('负对照：联合加一栏 / 改族名 → 现推的那一份当场不同（对账进闸抓得住）', () => {
  const { events, terms } = readSources()
  const before = buildSchema(events, terms)
  const added = events.replace(
    "| { t: 'view/remove'; agent: AgentId; path: RelPath; rev: ViewRev }",
    "| { t: 'view/remove'; agent: AgentId; path: RelPath; rev: ViewRev; why?: string }",
  )
  assert.notEqual(added, events, '负对照没改到源码——那这一条是空话')
  const after = buildSchema(added, terms)
  assert.notDeepEqual(after, before, '联合加了一栏而契约一个字节没动——那"对账"没接上')
  const renamed = events.replace("t: 'view/remove'", "t: 'view/erase'")
  assert.notDeepEqual(buildSchema(renamed, terms), before, '族名改了而契约没动')
  assert.equal(membersOf(renamed).some((m) => m.family === 'view/erase'), true)
})

test('负对照：联合里一个认不出的形状 → 生成器报错，不给一个 `{}` 放过去', () => {
  const { events, terms } = readSources()
  const bad = events.replace('rev: ViewRev }', 'rev: WhateverThisIs }')
  assert.notEqual(bad, events, '负对照没改到源码')
  assert.throws(() => buildSchema(bad, terms), /认不出的形状/)
})

test('命令面：`node tools/export-schema.ts --check` 退 0（漂了退 1）', () => {
  const ok = spawnSync(process.execPath, [TOOL, '--check'], { encoding: 'utf8' })
  assert.equal(ok.status, 0, String(ok.stderr))
  console.log(String(ok.stdout).trim())
})
