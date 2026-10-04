// 本站的边界断言：**索引在不在场，既有命令的输出逐字节相同**。
// 出处：§ 五 ③「索引在场/缺席两态下既有命令输出逐字节相同」· § 三 第 2 条（索引不接查询，
// 那是 0.3.3 的事）· 圣典第 5 条（`.fugue/idx/` 不进视图 · 不进事件）。
// 跑法：cd ~/fugue && node --test src/index/unwired.test.ts
//
// 两态各起一套**全新装配**（新句柄 · 新视图 · 新宿主）：真源那一层的 blob 缓存随句柄生死，
// 两态因此都在冷档上比——不然"索引在场"那一趟会带着建索引时留下的热缓存，量到的是缓存不是接线。
//
//   ① 工具面：`grep` 两档 + `glob`，两态输出逐字节相同，且**向真源发的请求数也相同**
//      对手：任何一处"查询路上顺手用一下索引"的接线——一旦候选集被索引过滤过，两态就会分叉
//   ② 命令面：`fugue list` / `read` / `revs` 三条只读命令的 stdout · stderr · 退出码逐字节相同
//      对手：把索引塞进视图或日志（那样命令的输出会多一条、少一条，或者形状变了）
//   ③ 建索引这一趟自己不写账：账的字节数在建设前后一个不差（② 的另一半）
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openLog } from '../log/log.ts'
import { createRoots } from '../roots/roots.ts'
import { openTruth } from '../truth/truth.ts'
import { refFor } from '../identity.ts'
import { refHeadOf } from '../round/head.ts'
import { lowerAt } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import { createToolHost } from '../tools/host.ts'
import { faceOf, parseArgs } from '../tools/execute.ts'
import type { ToolHost } from '../tools/execute.ts'
import { idxFileOf, indexExists, rebuildIndex, sourceOfView } from './store.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { View } from '../view/contract.ts'
import type { AgentId, CommitId, RefName } from '../terms.ts'

const AGENT = 'agent-1' as AgentId
const PATTERN = 'export function'
const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))

/** 测试自己起 git 时用同一套隔离：用户级配置不该决定测试的读数。 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

const asBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

const CORPUS: Record<string, string> = {
  'a.ts': 'export function alpha(x) {\n  return x + 1\n}\n',
  'b.ts': 'export function beta(y) {\n  return y * 2\n}\n',
  'src/c.ts': '导出 索引 落盘 格式 —— export function gamma(z) {}\n',
  'src/notes.md': 'postings delta varint dictionary fixed width sorted by gram\n',
  'src/other.txt': 'export function delta(w) {}\n',
}

/** 建一份临时仓：真 git 对象库 + 一个 writer 的 ref，产品那一边读得到的那一份。 */
async function makeRepo(): Promise<{ where: string; base: CommitId }> {
  const where = tmpDir('fugue-idx-wire-')
  execFileSync('git', ['init', '-q', '.'], { cwd: where, env: GIT_ENV })
  const build = openTruth(where)
  const entries = []
  for (const [name, text] of Object.entries(CORPUS)) {
    entries.push({ name, mode: 0o100644, id: await build.putBlob(asBytes(text)) })
  }
  const base = (await build.commit(await build.putTree(entries), [], 'corpus')) as CommitId
  await build.advance(refFor(AGENT) as RefName, base, null)
  await build.close()
  return { where, base }
}

interface Assembly {
  readonly host: ToolHost
  readonly view: View
  readonly truth: ReturnType<typeof openTruth>
  readonly close: () => Promise<void>
}

/** 一套全新装配（与 `tools/bench-grep.js` 用同一组零件、同一条链）。 */
async function assemble(where: string, base: CommitId): Promise<Assembly> {
  const truth = openTruth(where)
  const log = openLog(where, { write: AGENT, sync: 'never' })
  const view = await loadView(log, AGENT, { lower: lowerAt(truth, base) })
  const host = createToolHost(view, createRoots(where), {
    actions: { writer: AGENT, log, truth, head: await refHeadOf(log, AGENT, base) },
  })
  return {
    host,
    view,
    truth,
    close: async () => {
      await log.close()
      await truth.close()
    },
  }
}

async function grepOnce(host: ToolHost, mode: string): Promise<string> {
  const parsed = parseArgs(JSON.stringify({ pattern: PATTERN, output_mode: mode }))
  const r = await faceOf('grep')(parsed.value, host, { agent: AGENT, step: 0, cwd: '', holder: false })
  return r.output
}

/** 工具面那一趟：两档 grep + glob，外加向真源发的请求数。 */
async function toolRun(where: string, base: CommitId): Promise<{ outputs: string[]; requests: number }> {
  const a = await assemble(where, base)
  try {
    const outputs = [
      await grepOnce(a.host, 'content'),
      await grepOnce(a.host, 'count'),
      await faceOf('glob')(parseArgs(JSON.stringify({ pattern: '**/*.ts' })).value, a.host, {
        agent: AGENT,
        step: 0,
        cwd: '',
        holder: false,
      }).then((r) => r.output),
    ]
    return { outputs, requests: a.truth.stats().gitRequests }
  } finally {
    await a.close()
  }
}

/** 命令面那一趟：三条只读命令的 stdout · stderr · 退出码一起照下来。 */
function cliRun(where: string): string[] {
  return [['list'], ['read', 'a.ts'], ['revs']].map((args) => {
    const r = spawnSync(process.execPath, [CLI, '--root', where, '--agent', AGENT, ...args], {
      encoding: 'utf8',
      env: GIT_ENV,
    })
    return JSON.stringify({ args, status: r.status, stdout: r.stdout, stderr: r.stderr })
  })
}

/** 账那一侧：日志目录里有什么、各自多少字节。 */
function logSnapshot(where: string): [string, number][] {
  const dir = `${where}/.fugue/log`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.sort().map((n) => [n, readFileSync(`${dir}/${n}`).byteLength])
}

/**
 * 建一份索引，然后把"在场那一趟"交给 `fn`，**无论成不成一定收句柄**。
 *
 * 这个 try/finally 不是好看：写者锁是**一份日志一个写者进程**（`log/hold.ts`），
 * 断言在 `close()` 之前抛出去的话锁就留在测试进程手里，而下面那几条 `fugue` 子进程会一直等它
 * ——本文件第一版就那样挂住过一次（90 秒超时，报出来的是"文件超时"而不是那条断言）。
 */
async function withIndex<T>(where: string, base: CommitId, fn: () => Promise<T> | T): Promise<T> {
  const a = await assemble(where, base)
  try {
    const built = await rebuildIndex(where, await sourceOfView(a.view, a.truth))
    assert.equal(built.wrote, true)
    assert.equal(await indexExists(where), true)
  } finally {
    // **建完就收句柄**：一份日志一个写者进程，`fn` 里那几趟装配要拿同一个 writer 的锁
    // （`log/hold.ts`）。这里 `finally` 管的是"断言抛了也别把锁留下"。
    await a.close()
  }
  return await fn()
}

test('① 工具面：索引在场与缺席，grep 两档 + glob 的输出与请求数逐字节相同', async () => {
  const { where, base } = await makeRepo()
  // 缺席那一趟。
  assert.equal(await indexExists(where), false)
  const absent = await toolRun(where, base)

  // 建索引（走产品那一条入口：`sourceOfView` + `rebuildIndex`），然后在场那一趟：全新装配，冷档。
  const present = await withIndex(where, base, () => toolRun(where, base))

  assert.deepEqual(present.outputs, absent.outputs, '索引在场时工具面的输出变了——那就是接进查询的路了')
  assert.equal(present.requests, absent.requests, '索引在场时向真源发的请求数变了——查询路上有东西在读它')
  assert.ok(absent.requests > 0, '这一趟一个请求都没发，那这条对照是空话')
  assert.ok(absent.outputs.every((o) => o.length > 0), '两态都是空回执，那这条对照是空话')
  console.log(
    `① 读数：两态各 ${absent.requests} 次真源请求 · 三段回执逐字节相同（${absent.outputs.map((o) => o.length).join(' / ')} 字节）`,
  )
})

test('② 命令面：索引在场与缺席，三条只读命令的输出逐字节相同', async () => {
  const { where, base } = await makeRepo()
  const absent = cliRun(where)
  const present = await withIndex(where, base, () => cliRun(where))
  assert.deepEqual(present, absent, '索引在场时命令面的输出变了')
  const seen = absent.map((one) => JSON.parse(one) as { args: string[]; status: number | null; stdout: string })
  assert.ok(seen.every((r) => r.status === 0), '这一趟有命令没跑成，那这条对照是空话')
  // **"两边一样"要配一条"两边都有东西"**：两个空输出逐字节相同，那条对照什么也没量到。
  assert.ok(seen[0].stdout.length > 0, 'list 什么都没印，那这条对照是空话')
  assert.ok(seen[1].stdout.includes('export function alpha'), 'read 没读到那一份内容，那这条对照是空话')
  assert.ok(seen[2].stdout.length > 0, 'revs 什么都没印，那这条对照是空话')
  console.log(`② 读数：list / read / revs 三条的 stdout · stderr · 退出码两态逐字节相同（${absent.length} 条）`)
})

test('③ 建索引这一趟自己不写账：日志目录的件数与字节数不变', async () => {
  const { where, base } = await makeRepo()
  const a = await assemble(where, base)
  const before = logSnapshot(where)
  try {
    await rebuildIndex(where, await sourceOfView(a.view, a.truth))
    assert.deepEqual(logSnapshot(where), before, '建索引往日志里写了东西')
  } finally {
    await a.close()
  }
  console.log(`③ 读数：建设前后日志目录都是 ${before.length} 件 · ${before.map(([, n]) => n).join(' / ')} 字节`)
  assert.equal(idxFileOf(where).endsWith('.fugue/idx/trigram.idx'), true)
})
