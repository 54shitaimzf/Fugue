// ROADMAP §10：搜索描述字节一次改齐，三种状态同一份目录，离线夹具跟着它走。
//
// 回放夹具（`src/cli/__fixture__/wire-in/`）那一侧由 `src/cli/wire-in-catalog.test.ts` 盯着：
// 整份 `tools` 栏逐条对上 + 整份请求字节与"按当前目录改齐"的结果相同 + 改一个字节仍当场拒。
// 这一份只管 `src/model/fixtures/*.json` 那三份。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { catalog, catalogHash, CATALOG_STATES } from './catalog.ts'
import type { ToolEntry } from './catalog.ts'

const names = ['deepseek-flash-anthropic.json','deepseek-flash-openai.json','deepseek-flash-openai-thinking.json']

test('all offline request fixtures capture the new stable search catalog bytes', () => {
  const hashes = CATALOG_STATES.map(state => catalogHash(catalog(state)))
  assert.equal(new Set(hashes).size,1)
  const expected = catalog(CATALOG_STATES[0]!)
  for (const name of names) {
    const fixture = JSON.parse(readFileSync(new URL(`../model/fixtures/${name}`,import.meta.url),'utf8'))
    assert.deepEqual(fixture.tools,expected,name)
    assert.match(fixture.tools.find((tool: ToolEntry) => tool.name === 'grep').description,/receipt budget.*incomplete/)
    assert.match(fixture.tools.find((tool: ToolEntry) => tool.name === 'glob').description,/limited traversal or unknown coverage/)
  }
})
