// 本站的边界断言：**索引只指路，不改答案——既有命令的输出在两态下逐字节相同**。
// 验收句：**索引在场/缺席两态下既有命令输出逐字节相同**。查询接线接上之后（本站），工具面那一条
// 的判据翻了一半：输出照旧逐字节相同，而**在场那一趟少读**（接线就在这个“少读”上）。
// 派生物纪律：`.fugue/idx/` 不进视图 · 不进事件 · 不进提交。
// 跑法：cd ~/fugue && node --test src/index/unwired.test.ts
//
// 两态各起一套**全新装配**（新句柄 · 新视图 · 新宿主）：真源那一层的 blob 缓存随句柄生死，
// 两态因此都在冷档上比——不然"索引在场"那一趟会带着建索引时留下的热缓存，量到的是缓存不是接线。
//
//   ① 工具面：`grep` 两档 + `glob`，两态输出逐字节相同；而**索引在场那一趟少读**
//      （这一站之前断的是“查询路上没人读它”，本站把这一半翻过来：候选 ∩ 视图 → 不可能的路径不读）
//      对手：任何一处**把索引当证据**的接线——答案只要有一份是从索引那一侧来（不是从真源字节
//      逐行验出来），编码 · 大小写 · 正则语义 · 超长行里总有一条让两态分叉
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

/**
 * **一批不可能命中的大文件**：这一条要量的是“索引在场时少读了几份”，而少读要看得出来，就得让
 * 全扫那一趟真的有事可做（4 份候选之外还有 20 份要读）。
 *
 * 字母表收得很窄（`ab` 两个字母加空格）：字典的条数是**全语料出现过的三字组**，宽字母表会让产物
 * 比语料还重，那一侧就要退化成扫描（`plan.ts` 的 `artifact-heavy`）——这个夹具要的是“索引这一趟
 * 真的被用上”，所以形状要与本仓那种窄字母表语料一致。
 */
const FILLER = 'abab abab abab\n'.repeat(128)
for (let i = 0; i < 20; i++) CORPUS[`bulk/f${String(i).padStart(2, '0')}.txt`] = FILLER

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

/**
 * 一套全新装配（与 `tools/bench-grep.js` 用同一组零件、同一条链）。
 *
 * `indexBuild: false` 是**必须的**：这一份量的就是"索引在场与缺席"那两态，而缺省档（触发器接上）
 * 会把"缺席"那一态自己建出来——那两态于是都不存在了。缺省那一档另有它自己的断言。
 */
async function assemble(where: string, base: CommitId): Promise<Assembly> {
  const truth = openTruth(where)
  const log = openLog(where, { write: AGENT, sync: 'never' })
  const view = await loadView(log, AGENT, { lower: lowerAt(truth, base) })
  const host = createToolHost(view, createRoots(where), {
    actions: { writer: AGENT, log, truth, head: await refHeadOf(log, AGENT, base) },
    indexBuild: false,
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

/** 工具面那一趟：两档 grep + glob，外加向真源发的请求数与**真源被问到的内容份数**。 */
async function toolRun(where: string, base: CommitId): Promise<{ outputs: string[]; requests: number; reads: number }> {
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
    const stats = a.truth.stats()
    // `blobHits + blobMisses` 就是“这一趟向真源要了几份内容”（预取那一道缝只写 `set`、
    // 不记 hit/miss）——本站量“真少读了”用的就是它。
    return { outputs, requests: stats.gitRequests, reads: stats.blobHits + stats.blobMisses }
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

test('① 工具面：索引在场与缺席，grep 两档 + glob 的输出逐字节相同，而场下少读', async () => {
  const { where, base } = await makeRepo()
  // 缺席那一趟。
  assert.equal(await indexExists(where), false)
  const absent = await toolRun(where, base)

  // 建索引（走产品那一条入口：`sourceOfView` + `rebuildIndex`），然后在场那一趟：全新装配，冷档。
  const present = await withIndex(where, base, () => toolRun(where, base))

  // **等价那一半不动的判据**：答案逐字节相同。索引只指路、不作证——它说哪几条值得读，命中与否
  // 照旧在真源字节上逐行验出来。
  assert.deepEqual(present.outputs, absent.outputs, '索引在场时工具面的输出变了——接线不许改答案')
  assert.ok(absent.outputs.every((o) => o.length > 0), '两态都是空回执，那这条对照是空话')
  // **接线那一半翻过来的判据**：在场那一趟向真源要的内容份数少了（不可能命中的路径没读）。
  assert.ok(
    present.reads < absent.reads,
    `索引在场时该少读那几条不可能命中的路径：缺席 ${absent.reads} 份 → 在场 ${present.reads} 份`,
  )
  // 请求数只许不涨（少读不一定少发：批量档下一批 256 条算一趟，这个语料两态都装得下一批）。
  assert.ok(present.requests <= absent.requests, `索引在场不许比缺席多发请求：${absent.requests} → ${present.requests}`)
  assert.ok(absent.requests > 0 && absent.reads > 0, '缺席那一趟什么都没问，那这条对照是空话')
  console.log(
    `① 读数：三段回执两态逐字节相同（${absent.outputs.map((o) => o.length).join(' / ')} 字节）· ` +
      `真源内容份数 缺席 ${absent.reads} → 在场 ${present.reads} · 请求数 ${absent.requests} → ${present.requests}`,
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
