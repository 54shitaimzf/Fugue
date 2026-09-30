// P3a 的四条：①声明了探测 → 读数落缓存 ②换探测命令 → 缓存失效重探 ③失败 → 读数 null
// 且下一次照探 ④没声明 → 工作区配置一个字节不动（地板）。探针全用 `node -e`：输出确定、
// 不碰网、不碰盘外。红侧在提交信息里：改动之前，带 `toolchain` 的配置整份被顶层键域拒掉。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readConfig } from '../config.ts'
import { ensureToolchain } from './toolchain.ts'

// 系统根钉到空目录：读数不取决于这台机器配没配过系统级。
process.env.FUGUE_SYSTEM_DIR = mkdtempSync(join(tmpdir(), 'p3a-sys-'))

function makeWs(): string {
  const root = mkdtempSync(join(tmpdir(), 'p3a-ws-'))
  mkdirSync(join(root, '.fugue'), { recursive: true })
  return root
}

function declare(root: string, toolchain: Record<string, unknown>): void {
  writeFileSync(join(root, '.fugue', 'config'), JSON.stringify({ toolchain }, null, 2) + '\n')
}

async function readingOf(root: string, name: string): Promise<unknown> {
  const doc = await readConfig(root)
  const table = doc['toolchain'] as Record<string, unknown>
  return (table[name] as Record<string, unknown>)['reading']
}

const P3A = ['node', '-e', 'process.stdout.write("p3a")']
const P3B = ['node', '-e', 'process.stdout.write("p3b")']

test('① 声明了探测 → 读数落缓存', async () => {
  const root = makeWs()
  declare(root, { node: { probe: P3A } })
  await ensureToolchain(root)
  assert.deepEqual(await readingOf(root, 'node'), { probe: P3A, value: 'p3a' })
})

test('② 换探测命令 → 缓存失效重探', async () => {
  const root = makeWs()
  declare(root, { node: { probe: P3A } })
  await ensureToolchain(root)
  declare(root, { node: { probe: P3B } })
  await ensureToolchain(root)
  assert.deepEqual(await readingOf(root, 'node'), { probe: P3B, value: 'p3b' })
})

test('③ 失败 → 读数 null，下一次照探（打标计数）', async () => {
  const root = makeWs()
  const mark = join(root, 'mark')
  const fail = ['node', '-e', 'require("node:fs").appendFileSync(process.argv[1], "x"); process.exit(3)', mark]
  declare(root, { bad: { probe: fail } })
  await ensureToolchain(root)
  await ensureToolchain(root)
  assert.deepEqual(await readingOf(root, 'bad'), { probe: fail, value: null })
  assert.equal(readFileSync(mark, 'utf8'), 'xx', '两次 ensure 两次探——null 永不命中')
})

test('④ 没声明 → 工作区配置一个字节不动', async () => {
  const root = makeWs()
  const file = join(root, '.fugue', 'config')
  writeFileSync(file, '{\n  "round": {\n    "id": "r1"\n  }\n}\n')
  const before = readFileSync(file, 'utf8')
  await ensureToolchain(root)
  assert.equal(readFileSync(file, 'utf8'), before)
  const bare = makeWs()
  await ensureToolchain(bare)
  assert.equal(existsSync(join(bare, '.fugue', 'config')), false, '没声明时连配置文件都不建')
})
