// 值层与命令面的**对账**：两张脸共用同一份实现这件事，一次说清。
//
// 出处：施工单 § 三 5 那两条点名断言——「同一命令经 CLI 与经 serve 的 result 逐字节相同」·
// 「两脸动词集合从 `FLAGS_OF` 派生互核（缺一即红）」；§ 八 那一条真信号是「`--json` 与人读面各自
// 为政」。
//
// 这一份盯四件事，每条都配一个对手：
//
//   ① **动词集合从 `FLAGS_OF` 派生互核**：命令面 · 值层登记表 · serve 方法面——三者逐条相同
//      （入口不出方法名）。**负对照**：手抄一份目录去比，当场红。
//   ② **值层每一格都在命令面里**：迁了的命令不许有 `FLAGS_OF` 里没有的键（否则它是一处没声明的
//      第二份命令面）。
//   ③ **值层与 shell 是同一份**：`unit()` 给的那两条脸就是壳写出去的那两条（这里拿 `list`：纯读 ·
//      值是小数组）。
//   ④ **负对照（这条断言抓得住「两面各写一遍」）**：把值层登记表里那一格换成**手抄的一份渲染**
//      ——`serve.test.ts` 那条逐字节断言当场红；换回来又绿。修的是「两面真是同一个值，不是两个
//      巧合」这一句：serve 与 CLI **共用同一个值层入口**，所以换掉它两边一起动，而任何一处
//      「自己再写一遍」都会与另一处对不上。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { runCli } from '../../test/helpers/run-cli.ts'
import { FLAGS_OF } from '../cli/flags.ts'
import { PROTOCOL_VERSION } from '../protocol.ts'
import { VALUE_LAYER, methodOf, verbKeys } from '../value/registry.ts'
import { methodSurface, serveConnection } from './connect.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))

/** 命令面那 29 条（顶层）：`round` 的五个子命令算一条（速查表那一侧的同一口径）。 */
const TOP_LEVEL = [...new Set(Object.keys(FLAGS_OF).map((k) => k.split(' ')[0]))]

function seededRoot(): { dir: string; sys: string } {
  const dir = tmpDir('fugue-surface-')
  const sys = join(dir, '.syshome')
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: dir }).status, 0)
  const w = spawnSync(process.execPath, [CLI, '--root', dir, 'write', 'a.txt', '--stdin'], {
    cwd: dir,
    input: 'alpha\n',
    encoding: 'utf8',
    env: { ...process.env, FUGUE_SYSTEM_DIR: sys },
  })
  assert.equal(w.status, 0, w.stderr)
  return { dir, sys }
}

test('① 动词集合从 `FLAGS_OF` 派生互核：命令面 · 值层 · serve 方法面三者逐条相同', () => {
  const keys = Object.keys(FLAGS_OF).sort()
  const verbs = [...verbKeys()].sort()
  const derived = verbs.map(methodOf).sort()
  const surface = methodSurface()
    .map((m) => m.method)
    .sort()
  // `derived` 从 `FLAGS_OF` 推、`surface` 是 serve 真摆出去的那一份——两边各自独立走一遍，
  // 相等才有意义（手抄一份目录去比就是这条断言要挡的那种做法）。
  assert.deepEqual(surface, derived, 'serve 的方法面与 `FLAGS_OF` 派生出来的那一份逐条相同')
  assert.deepEqual(verbs, keys.filter((k) => !['serve', 'tui'].includes(k)), '动词集合 = 命令面的键减去入口那两个')
  assert.equal(TOP_LEVEL.length, 29, `命令面顶层 29 条（这一站加了 \`serve\` 那一行入口），拿到 ${TOP_LEVEL.length}`)
  assert.ok(TOP_LEVEL.includes('serve'), '`serve` 在命令面里（入口行）')
  assert.ok(!surface.includes(methodOf('serve')), '`serve` 是入口，不出方法名')
  console.log(`① 读数：命令面 ${TOP_LEVEL.length} 条顶层 → ${keys.length} 个键 → 动词 ${verbs.length} → 方法面 ${surface.length}（逐条相同）`)
})

test('② 值层每一格都在命令面里（迁了的命令不许是一处没声明的第二份命令面）', () => {
  const keys = new Set(Object.keys(FLAGS_OF))
  const stray = Object.keys(VALUE_LAYER).filter((k) => !keys.has(k))
  assert.deepEqual(stray, [], `值层里有、命令面里没有的键：${stray.join(' · ')}`)
  console.log(`② 读数：值层 ${Object.keys(VALUE_LAYER).length} 格全在命令面里；命令面 ${keys.size} 个键`)
})

test('③ 值层与 shell 是同一份：`list` 的两条脸就是壳写出去的那两条', async () => {
  const root = seededRoot()
  const cli = await runCli(['--root', root.dir, '--json', 'list'])
  assert.equal(cli.code, 0, cli.stderr)
  const value = await VALUE_LAYER.list({ root: root.dir, flags: new Map(), args: [], rest: [] })
  assert.ok(value.ok)
  assert.equal(cli.stdout, value.value.faces.json + '\n', '`--json` 那一面的字节就是值层给的那一串')
  const human = await runCli(['--root', root.dir, 'list'])
  assert.equal(human.stdout, value.value.faces.human + '\n', '人读那一面同样是值层给的那一串')
  console.log('③ 读数：list 的两条脸逐字节来自值层那两条投影')
})

test('④ 负对照：把值层那一格换成手抄的一份渲染 → 两面逐字节断言当场红', async () => {
  const root = seededRoot()
  const real = VALUE_LAYER.list
  /** 手抄的一份：与真那一份**不同**（多一个条目）——这就是「另一处自己再写一遍」的样子。 */
  const handCopy: typeof real = async () => ({
    ok: true,
    value: {
      kind: 'unit',
      jsonValue: [],
      faces: { json: '[]', human: '（手抄的那一份）' },
    },
  })
  const truth = await runCli(['--root', root.dir, '--json', 'list'])
  const before = await serveWith(root, 1, 'list')
  assert.equal(before.stdout, truth.stdout, '拆掉之前：两面逐字节相同')
  ;(VALUE_LAYER as Record<string, typeof real>).list = handCopy
  try {
    const bad = await serveWith(root, 1, 'list')
    assert.equal(bad.stdout, '[]\n', '值层那一格被换掉之后，serve 用的是换上去的那一份')
    assert.notEqual(bad.stdout, truth.stdout, '**这条不相等就是 serve.test.ts ① 会红的那一处**')
    const cliToo = await runCli(['--root', root.dir, '--json', 'list'])
    assert.equal(cliToo.stdout, '[]\n', 'CLI 与 serve 读的是同一个值层入口——所以两边一起动')
  } finally {
    ;(VALUE_LAYER as Record<string, typeof real>).list = real
  }
  const after = await serveWith(root, 1, 'list')
  assert.equal(after.stdout, truth.stdout, '换回来之后又逐字节相同')
  console.log('④ 读数：手抄的一份 → 两面同时变（红）；换回真的 → 逐字节相同（绿）')
})

/** 拿一条连接问一次，只看 `result.stdout`。 */
async function serveWith(root: { dir: string }, id: number, method: string): Promise<{ stdout: string }> {
  const input = new PassThrough()
  const out: string[] = []
  const done = serveConnection({
    input,
    output: { write: (s: string) => out.push(s) },
    cli: CLI,
    root: root.dir,
    idleMs: 0,
  })
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { _protocol: PROTOCOL_VERSION } }) + '\n')
  input.end()
  await done
  const reply = JSON.parse(out[0] ?? '{}') as { result?: { stdout?: string } }
  return { stdout: reply.result?.stdout ?? '' }
}
