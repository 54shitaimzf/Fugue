#!/usr/bin/env node
// 判定读数（0.4.0 那一站）：**按档派发在几种语料形状上的冷路径墙钟**，工件在场与不在场**两态分开报**。
//
// 口径与 `bench-grep.js` 同一套（真装配：openTruth → lowerAt → loadView → createToolHost → grepFace；
// **冷 = 新句柄 + 新视图 + 新宿主**，每一格另起一个进程），区别只有两处：
//
//   · 这一份量的是**索引那一档**（稀疏与未命中走索引 · 密集走扫描早停 · 短查询与计数按定稿规格走扫描）；
//   · 工件有**两种状态，分开报**——"在场冷查"（工件先建好，不计进这一趟）与"不在场首查"（盘上没有
//     工件，缺省那一档会不会自己建、这一趟几分几秒）。**不拿"先付建工件再量"冒充冷查。**
//
// 它不作断言、不进套件（文件名不是 *.test.ts）。语料是确定性生成的，同一个形状每一跑都是同一份字节。
//
// 跑法：cd ~/fugue && node tools/bench-grep-index.js
//       node tools/bench-grep-index.js --runs 3 --json
//       node tools/bench-grep-index.js --keep            # 留下语料仓（缺省跑完删）
//       node tools/bench-grep-index.js --only name,narrow
//       node tools/bench-grep-index.js --cjk512          # 另量一档"512 汉字"：0.3.4 记的是建不出来
//       node tools/bench-grep-index.js --no-trigger      # 同一台子上量"缺省档那一层接线"的代价：
//                                                        # 触发器不接（= 0.3.4 的形态：读盘上那份，不建）
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const AS_JSON = argv.includes('--json')
const KEEP = argv.includes('--keep')
const WITH_CJK512 = argv.includes('--cjk512')
const NO_TRIGGER = argv.includes('--no-trigger')
const RUNS = Number(argOf('--runs', '3'))
const ONLY = argOf('--only', '')
const DIR = resolve(argOf('--dir', join(tmpdir(), 'fugue-index-bench')))

const load = (rel) => import(pathToFileURL(join(root, rel)).href)
const BENCH = 'bench'

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

// ── 语料的四个形状（确定性） ──────────────────────────────────────────────────

const SIZE = 128 * 1024
const FILES = 128
/** 最杂 ASCII：95 个可打印字符全部用上（三字组几乎铺满 95³）。 */
const POOL95 = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
/** 窄字母表：8 个符号（三字组种类有上限，工件于是很小）——本仓夹具一直用的那个池。 */
const POOL8 = 'abcdefgh'
/** 本仓这类中文注释：64 个汉字 + ASCII 那些。 */
const POOL_CJK =
  '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实'
/** 512 汉字那一档（只用来量 gram 上限那件事）。 */
const POOL_512 = Array.from({ length: 512 }, (_, i) => String.fromCharCode(0x4e00 + i * 7)).join('')

/** 一块确定性随机文本（分块拼，别一口气开一个一千六百万格的数组）。 */
function randomText(size, pool, seed) {
  let s = seed >>> 0
  const parts = []
  const CHUNK = 8192
  for (let at = 0; at < size; at += CHUNK) {
    const n = Math.min(CHUNK, size - at)
    const chars = new Array(n)
    for (let i = 0; i < n; i += 1) {
      s = (s * 1664525 + 1013904223) >>> 0
      chars[i] = pool[(s >>> 16) % pool.length]
    }
    parts.push(chars.join(''))
  }
  return parts.join('')
}

const DENSE = 'DENSEMARK'
const SPARSE = 'SPARSEMARK'
const MISS = 'NOMATCHQQ'

/** 中文注释那一档：一行一行排（单行一超回执上限就走"超长行"那条路，那不是这一站要量的）。 */
function cjkText(size, pool, seed) {
  let s = seed >>> 0
  const parts = []
  let bytes = 0
  while (bytes < size) {
    let line = '  // 注释：'
    for (let i = 0; i < 12; i += 1) {
      s = (s * 1664525 + 1013904223) >>> 0
      line += pool[(s >>> 16) % pool.length]
    }
    line += ' export function f(n) { return n + 1 }\n'
    parts.push(line)
    bytes += Buffer.byteLength(line, 'utf8')
  }
  return parts.join('')
}

/**
 * 四个形状。每个 `make(i)` 给第 i 份文件的正文（字符串）。
 *
 * 三档 16 MiB（128 份 × 128 KiB）照路线图那一行的记法；`repo` 那一档是本仓 `src/` 的逐字节副本
 * （0.3.4 的读数就是它），它也是"缺省那一道闸放得过去"的那一档——两态那一栏它才有分别。
 */
const SHAPES = [
  {
    name: 'ascii95',
    label: '纯 ASCII 最杂（95 个可打印字符 · 128 份 × 128 KiB）',
    make: (i) => {
      let body = randomText(SIZE, POOL95, 20261006 + i * 7919)
      if (i === 3 || i === 17) body += SPARSE
      return body + DENSE
    },
    asks: [
      { label: '稀疏', pattern: SPARSE, mode: 'content' },
      { label: '未命中', pattern: MISS, mode: 'content' },
      { label: '密集', pattern: DENSE, mode: 'content' },
      { label: '短查询', pattern: 'ze', mode: 'content' },
      { label: '计数', pattern: DENSE, mode: 'count' },
    ],
  },
  {
    name: 'cjk64',
    label: '本仓这类中文注释（64 个汉字 · 128 份 × 128 KiB）',
    make: (i) => {
      let body = cjkText(SIZE, POOL_CJK, 20261006 + i * 7919)
      if (i === 3 || i === 17) body += `${SPARSE}\n`
      body += `${DENSE}\n`
      return body
    },
    asks: [
      { label: '稀疏', pattern: SPARSE, mode: 'content' },
      { label: '未命中', pattern: MISS, mode: 'content' },
      { label: '密集', pattern: '注释：', mode: 'content' },
      { label: '短查询', pattern: '导', mode: 'content' },
      { label: '计数', pattern: '注释：', mode: 'count' },
    ],
  },
  {
    name: 'narrow8',
    label: '窄字母表（池 abcdefgh · 128 份 × 128 KiB）',
    make: (i) => {
      let body = randomText(SIZE, POOL8, 20261006 + i * 7919)
      // **池外的符号**做标记：池里那 8 个符号的三字组**每一条都常见**（池只有 512 条三字组），
      // 拿它们当"稀疏"问法量不到索引那一档——本仓夹具一直是"窄字母表正文 + 池外标记"这个形状。
      if (i === 3 || i === 17) body += 'ZZQQXX'
      return body + `${DENSE}\n`
    },
    asks: [
      { label: '稀疏', pattern: 'ZZQQXX', mode: 'content' },
      { label: '未命中', pattern: MISS, mode: 'content' },
      { label: '密集', pattern: 'abcd', mode: 'content' },
      { label: '短查询', pattern: 'ze', mode: 'content' },
      { label: '计数', pattern: DENSE, mode: 'count' },
    ],
  },
  {
    name: 'repo',
    label: '本仓 src/ 的逐字节副本（0.3.4 的读数就是这一档）',
    from: join(root, 'src'),
    asks: [
      { label: '稀疏', pattern: 'walkRowsOf', mode: 'content' },
      { label: '未命中', pattern: 'zzqqxx-never', mode: 'content' },
      { label: '密集', pattern: 'const', mode: 'content' },
      { label: '短查询', pattern: '导', mode: 'content' },
      { label: '计数', pattern: 'const', mode: 'count' },
    ],
  },
  ...(WITH_CJK512
    ? [
        {
          name: 'cjk512',
          label: '512 个汉字（只量 gram 上限那一件事 · 128 份 × 128 KiB）',
          make: (i) => cjkText(SIZE, POOL_512, 20261006 + i * 7919),
          asks: [{ label: '稀疏', pattern: 'zzqqxx', mode: 'content' }],
        },
      ]
    : []),
]

// ── 子进程那一条（一问 / 建一次，都短命） ─────────────────────────────────────

/** 子进程那一条：一问，或者建一次。两种都短命（每格一次）。 */
async function runOnce() {
  const ask = JSON.parse(process.env.FUGUE_IDX_BENCH)
  const { openTruth } = await load('src/truth/truth.ts')
  const { openLog } = await load('src/log/log.ts')
  const { loadView } = await load('src/view/view.ts')
  const { lowerAt } = await load('src/view/lower.ts')
  const { createRoots } = await load('src/roots/roots.ts')
  const { createToolHost } = await load('src/tools/host.ts')
  const { refHeadOf } = await load('src/round/head.ts')
  const { faceOf, parseArgs } = await load('src/tools/execute.ts')

  const truth = openTruth(ask.where)
  const log = openLog(ask.where, { write: BENCH, sync: 'never' })
  try {
    const view = await loadView(log, BENCH, { lower: lowerAt(truth, ask.base) })
    const host = createToolHost(view, createRoots(ask.where), {
      actions: { writer: BENCH, log, truth, head: await refHeadOf(log, BENCH, ask.base) },
      // `--no-trigger`：缺省档那一层接线摘掉（0.3.4 的形态）——两条读数一比就是它自己的代价。
      ...(ask.noTrigger === true ? { indexBuild: false } : {}),
    })
    if (ask.op === 'build') {
      const { openOrRebuild } = await load('src/index/store.ts')
      const { sourceOfView } = await load('src/index/store.ts')
      const t0 = performance.now()
      let out = null
      let over = null
      try {
        out = await openOrRebuild(ask.where, await sourceOfView(view, truth))
      } catch (error) {
        over = { name: error?.name, over: error?.over ?? null, message: String(error?.message ?? error) }
      }
      const ms = performance.now() - t0
      const ready = out !== null && out.ready
      console.log(
        JSON.stringify({
          ms: Number(ms.toFixed(1)),
          ready,
          over: out === null ? over : ready ? null : out.over,
          grew: ready ? out.grew !== null : null,
          artifactBytes: ready ? artifactSize(ask.where) : 0,
          grams: ready ? out.index.gramCount : 0,
          blobs: ready ? out.index.blobIds.length : 0,
        }),
      )
      return
    }
    // **一问**：先 grep（这一趟的墙钟就是它），再问那道缝（why 与候选数都按这一趟之后的那个状态）。
    const { indexExists } = await load('src/index/store.ts')
    const artifactBefore = await indexExists(ask.where)
    const parsed = parseArgs(JSON.stringify({ pattern: ask.pattern, output_mode: ask.mode }))
    const t0 = performance.now()
    const r = await faceOf('grep')(parsed.value, host, { agent: BENCH, step: 0, cwd: '', holder: false })
    const ms = performance.now() - t0
    const stats = truth.stats()
    const walked = await host.walk()
    const plan = await host.searchPlan({
      pattern: ask.pattern,
      flags: '',
      walked,
      targets: walked,
      earlyStop: ask.mode !== 'count',
    })
    console.log(
      JSON.stringify({
        ms: Number(ms.toFixed(2)),
        reads: stats.blobHits + stats.blobMisses,
        requests: stats.gitRequests,
        outputBytes: r.output.length,
        why: plan.why,
        candidates: plan.paths === null ? null : plan.paths.size,
        buildKind: plan.reading.build.kind,
        artifactBefore,
        artifactAfter: await indexExists(ask.where),
        artifactBytes: artifactSize(ask.where),
      }),
    )
  } finally {
    await log.close()
    await truth.close()
  }
}

/** 盘上那一份有多大（没有就是 0）。**只 stat**。 */
function artifactSize(where) {
  try {
    return statSync(join(where, '.fugue', 'idx', 'trigram.idx')).size
  } catch {
    return 0
  }
}

// ── 父进程：起语料 · 建工件 · 两态各量一遍 ─────────────────────────────────────

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function corpusFiles(shape) {
  if (shape.from !== undefined) {
    const out = []
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else out.push([p.slice(shape.from.length + 1).replace(/\\/g, '/'), readFileSync(p)])
      }
    }
    walk(shape.from)
    return out
  }
  const out = []
  for (let i = 0; i < FILES; i += 1) {
    out.push([`f${String(i).padStart(3, '0')}.txt`, Buffer.from(shape.make(i), 'utf8')])
  }
  return out
}

async function makeRepo(shape) {
  const files = corpusFiles(shape)
  const where = mkdtempSync(join(DIR, `${shape.name}-`))
  execFileSync('git', ['init', '-q', '.'], { cwd: where, env: GIT_ENV })
  const { openTruth } = await load('src/truth/truth.ts')
  const { refFor } = await load('src/identity.ts')
  const build = openTruth(where)
  const entries = []
  for (const [rel, body] of files) entries.push({ name: rel, mode: 0o100644, id: await build.putBlob(new Uint8Array(body)) })
  const base = await build.commit(await build.putTree(entries), [], 'bench')
  await build.advance(refFor(BENCH), base, null)
  await build.close()
  const bytes = files.reduce((n, [, b]) => n + b.byteLength, 0)
  return { where, base, files: files.length, bytes }
}

/** 子进程里跑一格（一问或一建）。 */
function child(where, base, extra) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--once'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FUGUE_ROOT: root,
      FUGUE_IDX_BENCH: JSON.stringify({ where, base, noTrigger: NO_TRIGGER, ...extra }),
    },
  })
  return JSON.parse(out.trim().split('\n').pop())
}

async function main() {
  mkdirSync(DIR, { recursive: true })
  const wanted = ONLY === '' ? null : new Set(ONLY.split(','))
  const report = []
  for (const shape of SHAPES) {
    if (wanted !== null && !wanted.has(shape.name)) continue
    const repo = await makeRepo(shape)
    const built = child(repo.where, repo.base, { op: 'build' })
    const row = { shape: shape.name, label: shape.label, where: repo.where, files: repo.files, bytes: repo.bytes, build: built, cells: {} }
    // 一 · 工件在场（先建好，那一笔不计进这一趟）
    for (const ask of shape.asks) {
      row.cells[ask.label] = { present: [], absent: [] }
      for (let i = 0; i < RUNS; i += 1) row.cells[ask.label].present.push(child(repo.where, repo.base, { op: 'query', ...ask }))
    }
    // 二 · 工件不在场（**每一趟之前都把那一份删掉**：缺省那一档放得过去时，第一问自己会把它建出来
    // ——不删的话第二趟起量到的就不是"不在场首查"了）
    for (const ask of shape.asks) {
      for (let i = 0; i < RUNS; i += 1) {
        rmSync(join(repo.where, '.fugue', 'idx'), { recursive: true, force: true })
        row.cells[ask.label].absent.push(child(repo.where, repo.base, { op: 'query', ...ask }))
      }
    }
    report.push(row)
    if (!KEEP) rmSync(repo.where, { recursive: true, force: true })
  }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const row of report) {
    const b = row.build
    console.log(`\n=== ${row.shape} · ${row.label}${NO_TRIGGER ? ' · 触发器不接线' : ''}`)
    console.log(
      `    语料 ${row.files} 份 · ${row.bytes} 字节 · 建工件 ${b.ms} ms（${b.ready ? (b.grew ? '增量' : '全量') : '建不出来：' + JSON.stringify(b.over)}）` +
        (b.ready ? ` · 工件 ${b.artifactBytes} 字节 · 三字组 ${b.grams} / 1000000 · blob ${b.blobs}` : ''),
    )
    console.log('    问法      在场冷查 ms / 读 / 请求 / 档          不在场首查 ms / 读 / 请求 / 档 / 盘上建了没有')
    for (const [label, cells] of Object.entries(row.cells)) {
      const one = (runs) => ({
        ms: median(runs.map((r) => r.ms)),
        reads: median(runs.map((r) => r.reads)),
        requests: median(runs.map((r) => r.requests)),
        why: runs[0].why,
        built: runs[runs.length - 1].artifactAfter,
      })
      const p = one(cells.present)
      const a = one(cells.absent)
      console.log(
        `    ${label.padEnd(8)}  ${String(p.ms).padStart(8)} / ${String(p.reads).padStart(4)} / ${String(p.requests).padStart(5)} / ${p.why.padEnd(18)}` +
          ` ${String(a.ms).padStart(8)} / ${String(a.reads).padStart(4)} / ${String(a.requests).padStart(5)} / ${a.why.padEnd(18)} / ${a.built ? '建了' : '没建'}`,
      )
    }
  }
  if (KEEP) console.log(`\n语料仓留在 ${DIR}`)
}

if (ONCE) await runOnce()
else await main()
