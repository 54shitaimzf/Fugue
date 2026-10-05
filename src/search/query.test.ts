// 查询接线的主断言：**索引只指路，答案从原卷验出来**。
// 跑法：cd ~/fugue && node --test src/search/query.test.ts
//
//   ① **查询等价**：同一份语料 · 同一问法，索引在场（候选 ∩ 视图 → 从缓存/真源字节上逐行试正则）
//      与索引缺席（扫描）的回执**逐字节相同**（含命中顺序）；而且在场那一趟**真少读了**。
//      量法：`blobMisses`（真源取回了几份 blob 的内容）——请求是按批走的（256 条一批），小语料上
//      两态的批数一样，量不出"少读了"；`gitRequests` 一并落账但不作判据。
//      对手：**错报**（验证放水、拿候选当答案）· **错序**（拿 blob id 序顶了视图序）。
//   ② 候选不是答案：候选里多一条，命中不许跟着多那一条（验证那一趟真的在验）。
//   ③ 早停那一句逐字节照旧：索引在场但仍然早停时，"扫到哪儿"数的是清单的第几条，不是读了几份。
//   ④ 地板五态：短查询（单汉字/两字）· 密集 · 越限（这一组建不出工件）· 损坏（工件截短）·
//      陈旧（视图里多了一份没进索引的）——回执与账都回到缺席那一趟。对手：**漏报**。
//
// 语料是"窄字母表 · 多份文件"那个形状（工件小、语料大）：本仓那种"字典与语料一样大"的形状上
// 派发直接回扫描（`plan.test.ts` ⑦ 量的就是它），接线走不到，所以这一份另起一份合用的语料。
// 边界那一档（索引在场但工件比语料还贵）由 `plan.test.ts` ⑦ 单独量。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync, truncateSync } from 'node:fs'
import { after, test } from 'node:test'
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
import { idxFileOf, rebuildIndex, sourceOfView } from '../index/store.ts'
import { INDEX_LIMITS, IndexBudgetExceeded } from '../index/budget.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { View } from '../view/contract.ts'
import type { AgentId, CommitId, RefName } from '../terms.ts'

const AGENT = 'agent-1' as AgentId
/**
 * 窄字母表的填充：三字组种类有上限（工件于是很小），而语料一样能堆大。
 *
 * **一行一行地排**：单行一超回执上限，内容档就走"超长行"那一条路（0.3.0 的 `noteShortened`），
 * 回执只剩一行——那不是这一站要量的东西，量的是逐文件的命中。
 */
const FILLER = `${'abcdefgh'.repeat(64)}\n`.repeat(96)

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
const idOf = (text: string): string => createHash('sha1').update(text, 'utf8').digest('hex')

/**
 * 语料（20 份 · 约 900 KiB）：
 *   · `bulk/f000..f015.txt` —— 16 份窄字母表的填充（各自内容不同 → 16 个 blob），语料的那一大坨；
 *   · `docs/big.txt` —— 五百行同一句，内容档的回执在它里面就满了（早停那一条要它）；
 *   · `docs/f.txt` —— 含 `zebrax`：`zebra` 那几条三字组都在，而 `zebra$` 不匹配它（**候选 ≠ 答案**）；
 *   · `docs/p0.txt` · `docs/p1.txt` —— 各自一行 `zebra`（稀疏命中）。两份内容不同、id 由哈希定；
 *     名字**按 id 序反着派**，于是"路径序"与"blob id 序"相反——错序那个变异才判得出来。
 */
function corpus(): { files: Record<string, string>; orderSwapped: boolean } {
  const files: Record<string, string> = {}
  for (let i = 0; i < 16; i++) files[`bulk/f${String(i).padStart(3, '0')}.txt`] = `blob-${i}\n${FILLER}`
  files['docs/big.txt'] = 'quagga marker line\n'.repeat(500)
  files['docs/f.txt'] = `${FILLER}zebrax\n`
  const alpha = `p0\n${FILLER}\nzebra\n`
  const omega = `p1\n${FILLER}\nzebra\n`
  const first = idOf(alpha) > idOf(omega) ? alpha : omega
  const second = first === alpha ? omega : alpha
  files['docs/p0.txt'] = first
  files['docs/p1.txt'] = second
  return { files, orderSwapped: idOf(first) > idOf(second) }
}

async function makeRepo(files: Record<string, string>): Promise<{ where: string; base: CommitId }> {
  const where = tmpDir('fugue-query-')
  execFileSync('git', ['init', '-q', '.'], { cwd: where, env: GIT_ENV })
  const build = openTruth(where)
  const entries = []
  for (const [name, text] of Object.entries(files)) {
    entries.push({ name, mode: 0o100644, id: await build.putBlob(asBytes(text)) })
  }
  const base = (await build.commit(await build.putTree(entries), [], 'corpus')) as CommitId
  await build.advance(refFor(AGENT) as RefName, base, null)
  await build.close()
  return { where, base }
}

/** 一份共用台子：这一份测试里各态来回切（切之前先把盘上那份工件去掉/重建），省下建仓的钱。 */
let shared: Promise<{ where: string; base: CommitId }> | null = null
function repo(): Promise<{ where: string; base: CommitId }> {
  shared ??= makeRepo(corpus().files)
  return shared
}
after(async () => {
  if (shared !== null) rmSync((await shared).where, { recursive: true, force: true })
})

/** 把盘上那份工件去掉（回到"索引缺席"那一态）。 */
function dropIndex(where: string): void {
  rmSync(idxFileOf(where), { force: true })
}

interface Assembly {
  readonly host: ToolHost
  readonly view: View
  readonly truth: ReturnType<typeof openTruth>
  readonly close: () => Promise<void>
}

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

/**
 * 这一趟的账：回执原文 · 真源要了几份 blob 的内容 · 真源请求数 · 取回来几份 · 候选数（没接线是 `null`）。
 *
 * **"真少读了"量的是 `reads`**（`blobHits + blobMisses`，即这一趟向真源要过几次 blob 内容）：
 * 预取那一趟把整窗先取进缓存，于是逐文件读全是命中（`misses` 恒为 0，量不出差别），而请求是按
 * 批走的（256 条一批，小语料上两态批数一样）。命中与未命中合起来数的才是"要了几份"。
 */
interface Run {
  readonly output: string
  readonly reads: number
  readonly requests: number
  readonly misses: number
  readonly candidates: number | null
}

/** 跑一问。`plan` 为真时另问一次那道缝（同一份清单 · 同一次装配）——候选数与命中数分开看。 */
async function grepRun(where: string, base: CommitId, pattern: string, mode = 'content', plan = false): Promise<Run> {
  const a = await assemble(where, base)
  try {
    const parsed = parseArgs(JSON.stringify({ pattern, output_mode: mode }))
    assert.equal(parsed.ok, true)
    const r = await faceOf('grep')(parsed.value, a.host, { agent: AGENT, step: 0, cwd: '', holder: false })
    const stats = a.truth.stats()
    let candidates: number | null = null
    if (plan) {
      const walked = await a.host.walk()
      const seam = (a.host as unknown as {
        searchPlan: (ask: unknown) => Promise<{ paths: ReadonlySet<string> | null }>
      }).searchPlan
      const got = await seam.call(a.host, { pattern, walked, targets: walked, earlyStop: mode !== 'count' })
      candidates = got.paths === null ? null : got.paths.size
    }
    return {
      output: r.output,
      reads: stats.blobHits + stats.blobMisses,
      requests: stats.gitRequests,
      misses: stats.blobMisses,
      candidates,
    }
  } finally {
    await a.close()
  }
}

/** 建一份索引，然后交给 `fn`（**建完就收句柄**：一份日志一个写者进程）。 */
async function withIndex<T>(where: string, base: CommitId, fn: () => Promise<T>): Promise<T> {
  const a = await assemble(where, base)
  try {
    const built = await rebuildIndex(where, await sourceOfView(a.view, a.truth))
    assert.equal(built.wrote, true, '索引没落盘——这一条对照是空话')
  } finally {
    await a.close()
  }
  return await fn()
}

const line = (r: Run): string => `${r.output.length} 字节 / ${r.reads} 份读 / ${r.requests} 请求`

// ── ① 查询等价（含命中顺序）+ 真少读了 ───────────────────────────────────────

test('① 索引在场与缺席：三档输出模式的回执逐字节相同 · 在场那一趟真源取回的份数更少', async () => {
  const { where, base } = await repo()
  const swapped = corpus().orderSwapped
  // **这条对照不是空话**：两份命中的路径序与 blob id 序相反，拿 id 序顶视图序的那个变异才判得出来。
  assert.equal(swapped, true, '这份语料的 id 序与路径序没反着——错序那个变异会漏判')

  dropIndex(where)
  const absent = {
    content: await grepRun(where, base, 'zebra', 'content'),
    paths: await grepRun(where, base, 'zebra', 'files_with_matches'),
    count: await grepRun(where, base, 'zebra', 'count'),
  }
  // 缺席那一趟：路径序就是回执序（f 在 p0 前，p0 在 p1 前）。
  const at = (s: string): number => absent.content.output.indexOf(s)
  assert.ok(at('docs/f.txt') < at('docs/p0.txt') && at('docs/p0.txt') < at('docs/p1.txt'), '路径序该是 f · p0 · p1')

  const present = await withIndex(where, base, async () => ({
    content: await grepRun(where, base, 'zebra', 'content', true),
    paths: await grepRun(where, base, 'zebra', 'files_with_matches', true),
    count: await grepRun(where, base, 'zebra', 'count', true),
  }))

  for (const what of ['content', 'paths', 'count'] as const) {
    assert.equal(present[what].output, absent[what].output, `${what} 那一档：索引在场时回执变了`)
    assert.ok(
      present[what].reads < absent[what].reads,
      `${what}：在场那一趟要的 blob 份数没少（${present[what].reads} 对 ${absent[what].reads}）`,
    )
    // **机制真的接上了**：候选不多不少就是那三条（两份命中 + 一份只像候选的）。
    assert.equal(present[what].candidates, 3, `${what}：候选数不是 3——接线没走到或者交集算错了`)
  }
  assert.ok(absent.content.reads > 0, '缺席那一趟一份都没读——这条对照是空话')
  assert.ok(absent.count.output.length > 0, '回执是空的——这条对照是空话')
  console.log(
    `① 读数：content ${line(absent.content)} 对 ${line(present.content)} · paths ${line(absent.paths)} 对 ${line(present.paths)}` +
      ` · count ${line(absent.count)} 对 ${line(present.count)} · 候选 ${present.content.candidates} 条`,
  )
})

// ── ② 候选不是答案 ──────────────────────────────────────────────────────────

test('② 候选里多一条，命中不许多那一条：验证那一趟真的在原卷上试', async () => {
  const { where, base } = await repo()
  dropIndex(where)
  const absent = await grepRun(where, base, 'zebra$')
  const present = await withIndex(where, base, async () => await grepRun(where, base, 'zebra$', 'content', true))
  assert.equal(present.output, absent.output)
  // 候选三条（f · p0 · p1），命中两条：`f.txt` 里是 `zebrax`，`zebra$` 不该匹配它。
  assert.equal(present.candidates, 3, '候选该是三条')
  assert.equal(present.output.includes('docs/f.txt'), false, '只像候选的那一份被当成命中了——验证放水')
  assert.equal(present.output.includes('docs/p0.txt'), true, '真命中不在回执里')
  assert.equal(present.output.includes('docs/p1.txt'), true, '真命中不在回执里')
  assert.match(present.output, /^2 lines/, `头上那一栏该是 2 行：${present.output.split('\n')[0]}`)
  console.log(`② 读数：候选 3 条 → 命中 2 条（f.txt 只像候选）· 回执 ${present.output.length} 字节两态相同`)
})

// ── ③ 早停那一句 ────────────────────────────────────────────────────────────

test('③ 索引在场但这一趟仍然早停：早停注记与缺席那一趟逐字节相同', async () => {
  const { where, base } = await repo()
  dropIndex(where)
  const absent = await grepRun(where, base, 'quagga')
  const present = await withIndex(where, base, async () => await grepRun(where, base, 'quagga', 'content', true))
  assert.equal(present.output, absent.output, '早停那一档的回执变了')
  assert.ok(present.output.includes('the search stopped at the receipt budget'), '这一趟没早停——这条对照是空话')
  assert.equal(present.candidates, 1, '候选该只有密的那一份')
  assert.ok(present.reads < absent.reads, `候选只有一份，要的 blob 份数该少（${present.reads} 对 ${absent.reads}）`)
  console.log(`③ 读数：${line(absent)} 对 ${line(present)} · 早停那一句逐字节相同`)
})

// ── ④ 地板五态 ──────────────────────────────────────────────────────────────

test('④ 地板：短查询 · 密集 · 越限 · 损坏 · 陈旧——回执与账都回到缺席那一趟', async () => {
  const { where, base } = await repo()

  // 一 · 短查询（单汉字/两字）：键空间里没有它们那一条，根本不问索引。
  for (const short of ['ze', '导']) {
    dropIndex(where)
    const absent = await grepRun(where, base, short)
    const present = await withIndex(where, base, async () => await grepRun(where, base, short, 'content', true))
    assert.equal(present.output, absent.output, `短查询 ${short}：回执变了`)
    assert.equal(present.candidates, null, `${short}：短查询不该交出一份候选名单`)
    assert.equal(present.reads, absent.reads, `${short}：短查询那一趟要的 blob 份数该与缺席完全相同`)
  }

  // 二 · 密集：填充那一串在每一份里都有 → 早停那两档让给扫描。
  dropIndex(where)
  const denseAbsent = await grepRun(where, base, 'abcdefgh')
  const dense = await withIndex(where, base, async () => await grepRun(where, base, 'abcdefgh', 'content', true))
  assert.equal(dense.candidates, null, '密集档该回扫描（不接线）')
  assert.equal(dense.output, denseAbsent.output)
  assert.equal(dense.reads, denseAbsent.reads, '回扫描那一趟要的 blob 份数该与缺席完全相同')

  // 三 · 越限：这一组建不出工件（blob 数那一条只留 4 个名额）→ 盘上不留半成品，查询照旧扫描。
  dropIndex(where)
  const absent = await grepRun(where, base, 'zebra')
  const a = await assemble(where, base)
  try {
    await assert.rejects(
      async () => await rebuildIndex(where, await sourceOfView(a.view, a.truth), { ...INDEX_LIMITS, blobs: 4 }),
      (e: unknown) => e instanceof IndexBudgetExceeded && (e as IndexBudgetExceeded).over === 'blobs',
    )
  } finally {
    await a.close()
  }
  const over = await grepRun(where, base, 'zebra', 'content', true)
  assert.equal(over.candidates, null, '越限那一趟之后盘上不该有能用的工件')
  assert.equal(over.output, absent.output)
  assert.equal(over.reads, absent.reads)

  // 四 · 损坏：把工件截短（版本/节表读不回来）→ 当缺席。
  await withIndex(where, base, async () => {
    truncateSync(idxFileOf(where), 30)
    return null
  })
  const broken = await grepRun(where, base, 'zebra', 'content', true)
  assert.equal(broken.candidates, null, '工件读不回来却还是接了线')
  assert.equal(broken.reads, absent.reads)

  // 五 · 陈旧工件：建完索引之后视图里多了一份（索引里没有它）→ 覆盖不成立 → 回扫描。
  const stale = await withIndex(where, base, async () => {
    const w = await assemble(where, base)
    try {
      await w.host.writeBytes('docs/new.txt', asBytes(`${FILLER}\nzebra newcomer\n`))
    } finally {
      await w.close()
    }
    return await grepRun(where, base, 'zebra', 'content', true)
  })
  assert.equal(stale.candidates, null, '索引罩不住这一组视图，却还是接了线——漏报就在这一步')
  assert.ok(stale.output.includes('docs/new.txt'), '新加进来的那一份没被找到——漏报')
  assert.equal(stale.output, (await grepRun(where, base, 'zebra')).output)
  console.log('④ 读数：短查询 2 种 · 密集 · 越限 · 损坏 · 陈旧——五态都回扫描，回执与账与缺席相同')
})
