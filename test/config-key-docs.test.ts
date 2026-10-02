// Developer-only documentation net with independently mutated source and docs.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkCliHelp, checkConfigKeyDocs, configDocsProblems, literalConfigKeys } from '../tools/config-key-docs.ts'
import { USAGE } from '../src/cli/shared.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const doc = read('docs/configuration.md')
const sources = ['src/assemble/sources-state.ts', 'src/cli/shared.ts', 'src/cli/cmd/round.ts', 'src/cli/cmd/observe.ts', 'src/boundary/binding.ts'].map(read)
const keys = literalConfigKeys(sources)

test('actual top-level domains and literal consumers have current configuration docs', () => {
  assert.deepEqual(checkConfigKeyDocs(doc, keys), [])
  assert.ok(keys.includes('round.model')); assert.ok(keys.includes('boundary.reach'))
})

test('missing, duplicate and invented documented domains each fail independently', () => {
  assert.deepEqual(checkConfigKeyDocs(doc.replace(/^\| `ui` \|.*\n/m, ''), keys), ['配置域缺文档：ui'])
  assert.deepEqual(checkConfigKeyDocs(doc + '\n| `ui` | duplicate |\n', keys), ['配置域文档重名：ui'])
  assert.deepEqual(checkConfigKeyDocs(doc + '\n| `invented` | never supported |\n', keys), ['配置域文档不在当前顶层键域：invented'])
})

test('new consumer key and removed key documentation cannot silently stay green', () => {
  assert.deepEqual(checkConfigKeyDocs(doc, literalConfigKeys([...sources, "getConfig(doc, 'round.newSetting')"])), ['实际配置读取键缺文档：round.newSetting'])
  assert.deepEqual(checkConfigKeyDocs(doc.replaceAll('`round.model`', 'model-selection'), keys), ['实际配置读取键缺文档：round.model'])
})

test('actual help covers the independent flag-table entries, including assemble', () => {
  assert.deepEqual(checkCliHelp(USAGE), [])
  assert.deepEqual(checkCliHelp(USAGE.replace(/^  assemble .*\n/m, '')), ['命令帮助漏旗标表入口：assemble'])
  assert.deepEqual(checkCliHelp(USAGE + '\n  invented <value>  absent command\n'), ['命令帮助列出未知入口：invented'])
})

test('file-based CLI coverage discovers a new consumer outside any former file list', () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-config-key-docs-'))
  try {
    mkdirSync(join(root, 'src/new-consumer'), { recursive: true }); mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs/configuration.md'), doc)
    writeFileSync(join(root, 'src/ignored.test.ts'), "getConfig(doc, 'round.testOnly')")
    assert.deepEqual(configDocsProblems(root), [])
    writeFileSync(join(root, 'src/new-consumer/entry.ts'), "getConfig(doc, 'round.newSetting')")
    assert.deepEqual(configDocsProblems(root), ['实际配置读取键缺文档：round.newSetting'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
