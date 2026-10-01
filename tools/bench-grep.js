#!/usr/bin/env node
// 同靶二次 grep 对首次的微基准（0.2.4：blob LRU + objectMany 预取那道缝的验收读数）。
//
// **读的是"这一版这一跑量到什么"，不是断言。** 不作 CI 时长断言（先例 `bench-input-wrap.js`），
// 也不进 `test-entry.js` 的套件（文件名不是 `*.test.ts`）。
//
// 量法：
//   · 自建临时 git 仓，语料 = 本仓 `src/` 的逐字节副本（确定性：同一棵树量出来就是同一份）。
//   · 经**真装配**起视图：`openTruth` → `lowerAt` → `loadView` → `createToolHost` → `grepFace`。
//   · 同一进程内量**冷（首次）**与**热（同靶第二次）**两组墙钟 + `stats().gitRequests` 归因。
//   · 多趟取中位数（`--runs`，缺省 5）；每趟另开句柄，所以每一趟的"冷"都是真冷。
//   · **跨进程第二趟仍是冷**：缓存随进程死，这是「单次进程 + 每次重建」的语义，如实量出来。
//   · `--cache 0` 量退化档那一侧（容量 0 = 直通）；`--no-prefetch` 量"那道缝缺席"那一侧
//     （把宿主上那一栏摘掉，同一台子上跑，其余一模一样）。
//
// 跑法：cd ~/fugue && node tools/bench-grep.js
//       FUGUE_ROOT=/tmp/fugue-baseline node tools/bench-grep.js   # 同一把尺量另一份 checkout
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(process.env.FUGUE_ROOT ?? process.cwd())
const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const at = argv.indexOf(name)
  return at === -1 ? dflt : argv[at + 1]
}
const ONCE = argv.includes('--once')
const NO_PREFETCH = argv.includes('--no-prefetch')
const RUNS = Number(argOf('--runs', '5'))
const CACHE = Number(argOf('--cache', String(8 * 1024 * 1024)))
const PATTERN = argOf('--pattern', 'export function')
const AS_JSON = argv.includes('--json')

const load = (rel) => import(pathToFileURL(join(root, rel)).href)
const { openTruth } = await load('src/truth/truth.ts')
const { openLog } = await load('src/log/log.ts')
const { loadView } = await load('src/view/view.ts')
const { lowerAt } = await load('src/view/lower.ts')
const { createRoots } = await load('src/roots/roots.ts')
const { createToolHost } = await load('src/tools/host.ts')
const { refHeadOf } = await load('src/round/head.ts')
const { faceOf, parseArgs } = await load('src/tools/execute.ts')

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}
const AGENT = 'bench'
const grepOf = faceOf('grep')

/** 语料：本仓 `src/` 的逐字节副本（确定性）。 */
function corpusFiles() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push([p.slice(root.length + 1).replace(/\\/g, '/'), readFileSync(p)])
    }
  }
  walk(join(root, 'src'))
  return out
}

/** 一台台子：临时仓 + 语料 + 提交。**建语料那个句柄用完就关**（它自己的缓存是热的）。 */
async function makeBench() {
  const files = corpusFiles()
  const where = mkdtempSync(join(tmpdir(), 'fugue-bench-grep-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: where, env: GIT_ENV })
  const build = openTruth(where)
  const entries = []
  for (const [rel, body] of files) {
    entries.push({ name: rel, mode: 0o100644, id: await build.putBlob(new Uint8Array(body)) })
  }
  const base = await build.commit(await build.putTree(entries), [], 'bench')
  await build.close()
  const totalBytes = files.reduce((n, [, b]) => n + b.byteLength, 0)
  return { where, base, files: files.length, totalBytes }
}

/** 测量用的那一份从零起：新句柄 + 真装配（`round.ts` 那条链的同一组零件）。 */
async function openBench(where, base, cacheBytes, noPrefetch = false) {
  const truth = openTruth(where, { blobCacheBytes: cacheBytes })
  const log = openLog(where, { write: AGENT, sync: 'never' })
  const view = await loadView(log, AGENT, { lower: lowerAt(truth, base) })
  const built = createToolHost(view, createRoots(where), {
    actions: { writer: AGENT, log, truth, head: await refHeadOf(log, AGENT, base) },
  })
  // `--no-prefetch`：把那道缝摘掉，就是"预取缺席"那一档（今天的逐文件读）。
  const host = noPrefetch ? (({ prefetch, ...rest }) => rest)(built) : built
  return {
    truth,
    host,
    close: async () => {
      await log.close()
      await truth.close()
    },
  }
}

async function grepOnce(host) {
  const parsed = parseArgs(JSON.stringify({ pattern: PATTERN }))
  const t0 = performance.now()
  const r = await grepOf(parsed.value, host, { agent: AGENT, step: 0, cwd: '', holder: false })
  return { ms: performance.now() - t0, output: r.output }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function twoPasses(where, base, cacheBytes, noPrefetch) {
  const b = await openBench(where, base, cacheBytes, noPrefetch)
  const c0 = b.truth.stats().gitRequests
  const t0 = performance.now()
  const cold = await grepOnce(b.host)
  const coldMs = performance.now() - t0
  const c1 = b.truth.stats().gitRequests
  const t1 = performance.now()
  const hot = await grepOnce(b.host)
  const hotMs = performance.now() - t1
  const c2 = b.truth.stats().gitRequests
  if (cold.output !== hot.output) throw new Error('冷热两趟回执不同——这一跑没量到东西')
  await b.close()
  return { coldMs, hotMs, coldReq: c1 - c0, hotReq: c2 - c1 }
}

if (ONCE) {
  // **跨进程那一趟**：同一台子、同一个模式，新进程的第一趟就是冷的。
  const { where, base } = JSON.parse(process.env.FUGUE_BENCH_TARGET)
  const r = await twoPasses(where, base, CACHE, NO_PREFETCH)
  console.log(JSON.stringify({ ms: Number(r.coldMs.toFixed(2)), req: r.coldReq }))
} else {
  const bench = await makeBench()
  const coldMs = []
  const hotMs = []
  const coldReq = []
  const hotReq = []
  for (let i = 0; i < RUNS; i++) {
    const r = await twoPasses(bench.where, bench.base, CACHE, NO_PREFETCH)
    coldMs.push(r.coldMs)
    hotMs.push(r.hotMs)
    coldReq.push(r.coldReq)
    hotReq.push(r.hotReq)
  }
  // 另外两组（只在默认那一档上量，免得读数成了矩阵）：
  //   · 容量 0（直通）—— 退化档"变慢"那一侧的读数
  //   · 同一档 + 摘掉预取 —— 那道缝缺席那一侧的读数（隔离出预取这一件事）
  const zero = await twoPasses(bench.where, bench.base, 0, false)
  const bare = await twoPasses(bench.where, bench.base, CACHE, true)
  const fresh = JSON.parse(
    execFileSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--once', '--pattern', PATTERN, '--cache', String(CACHE)],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FUGUE_ROOT: root,
          FUGUE_BENCH_TARGET: JSON.stringify({ where: bench.where, base: bench.base }),
        },
      },
    )
      .trim()
      .split('\n')
      .pop(),
  )

  const report = {
    语料: { 文件数: bench.files, 字节: bench.totalBytes, 来源: 'src/ 的逐字节副本' },
    配置: {
      档: CACHE === 0 ? '容量 0（直通）' : `blobCacheBytes=${CACHE}`,
      预取: NO_PREFETCH ? '摘掉' : '在位',
      趟数: RUNS,
      模式: PATTERN,
    },
    冷: { 墙钟中位数ms: Number(median(coldMs).toFixed(2)), 各趟ms: coldMs.map((x) => Number(x.toFixed(2))), 请求数: coldReq },
    热: { 墙钟中位数ms: Number(median(hotMs).toFixed(2)), 各趟ms: hotMs.map((x) => Number(x.toFixed(2))), 请求数: hotReq },
    热冷比: Number((median(hotMs) / median(coldMs)).toFixed(3)),
    容量0: { 冷请求数: zero.coldReq, 热请求数: zero.hotReq, 冷ms: Number(zero.coldMs.toFixed(2)), 热ms: Number(zero.hotMs.toFixed(2)) },
    预取缺席: { 冷请求数: bare.coldReq, 热请求数: bare.hotReq, 冷ms: Number(bare.coldMs.toFixed(2)), 热ms: Number(bare.hotMs.toFixed(2)) },
    跨进程第二趟: fresh,
  }
  if (AS_JSON) console.log(JSON.stringify(report))
  else {
    console.log(`语料：${report.语料.文件数} 个文件 · ${bench.totalBytes} 字节（src/ 的逐字节副本）`)
    console.log(`配置：${report.配置.档} · 预取${report.配置.预取} · ${RUNS} 趟取中位数 · 模式 ${JSON.stringify(PATTERN)}`)
    console.log(`冷（同进程首次）：墙钟中位数 ${report.冷.墙钟中位数ms} ms · 请求数 ${coldReq.join(' / ')}`)
    console.log(`热（同靶第二次）：墙钟中位数 ${report.热.墙钟中位数ms} ms · 请求数 ${hotReq.join(' / ')}`)
    console.log(`热/冷 墙钟比：${report.热冷比}`)
    console.log(
      `容量 0（直通）：冷 ${report.容量0.冷ms} ms / ${report.容量0.冷请求数} 次 · 热 ${report.容量0.热ms} ms / ${report.容量0.热请求数} 次`,
    )
    console.log(
      `预取缺席：冷 ${report.预取缺席.冷ms} ms / ${report.预取缺席.冷请求数} 次 · 热 ${report.预取缺席.热ms} ms / ${report.预取缺席.热请求数} 次`,
    )
    console.log(`跨进程第二趟（新进程首次）：${fresh.ms} ms · 请求数 ${fresh.req}`)
  }
  rmSync(bench.where, { recursive: true, force: true })
}
