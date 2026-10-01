#!/usr/bin/env node
// 0.2.5 的两处机制读数：**walk 清单按视图代缓存**与 **read 的 offset/limit 下推**。
//
// **读的是"这一版这一跑量到什么"，不是断言。** 不作 CI 时长断言（先例 `bench-input-wrap.js`），
// 也不进 `test-entry.js` 的套件（文件名不是 `*.test.ts`）。
//
// 两条口径：
//   · **机制隔离**：这一份不碰 git，也不碰真源。视图是纯内存的 `MemoryView`（上层就是全部，
//     `lower.base === null`，那几样下层读口一律抛）——walk 省的是"每目录一次 Promise + 逐层合并
//     + 数组重建"，read 省的是"解码与行切"，两者都不含对象库往返（那一头是 0.2.4 的读数，
//     在 `bench-grep.js` 里量）。
//   · **内置等价自校验**：量之前先断言新旧两条路给的结果相同（walk 与一份逐步重走的参照比 ·
//     read 与整读 + 独立切片的参照比），量错了自己炸——读数不是"看起来像"。
//
// 四组（外加一条地板）：
//   一 · walk 冷：刚建的缓存第一次走
//   二 · walk 热：同一代第二次走（`view.list` 应当一次都不发）
//   三 · walk 代变后重走：视图动一格（代 +1）之后第一次走
//   四 · read 整读 vs 窗口读：≥2 MB 语料上取深处一个小窗（归因读数：交给解码器的字节数）
//   五 · 地板：缓存死 = 每次未命中 = 本站之前那条路（每一趟现起一份缓存）
//
// 跑法：cd ~/fugue && node tools/bench-walk-read.js [--runs 5] [--json]
//       FUGUE_ROOT=/tmp/fugue-baseline node tools/bench-walk-read.js   # 同一把尺量另一份 checkout
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.env.FUGUE_ROOT ?? process.cwd())
const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const at = argv.indexOf(name)
  return at === -1 ? dflt : argv[at + 1]
}
const RUNS = Number(argOf('--runs', '5'))
const AS_JSON = argv.includes('--json')

const load = (rel) => import(pathToFileURL(join(root, rel)).href)
const { loadView } = await load('src/view/view.ts')
const { createRoots } = await load('src/roots/roots.ts')
const { createToolHost } = await load('src/tools/host.ts')
const { createWalk } = await load('src/tools/walk-cache.ts')
const { lineWindow } = await load('src/tools/window.ts')
const { faceOf, parseArgs } = await load('src/tools/execute.ts')

const AGENT = 'bench'
const LIMITS = { depth: 24, rows: 5000 }
/** 走树时那两样：这一跑**不碰真源**（`base: null` 时视图根本不会问下层），也**不碰日志**。 */
const NO_LOG = {
  readByWriter: async function* () {
    /* 空日志：这一跑不为重放建视图（上层就是全部内容） */
  },
}
const boom = () => {
  throw new Error('这一跑不碰真源：视图是纯内存的（lower.base === null）')
}
const NO_TRUTH = { base: null, readBlob: boom, stat: boom, read: boom, list: boom }

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const ms = (t0) => performance.now() - t0
const fix = (x) => Number(x.toFixed(3))

/** 一份纯内存视图：外面包一层只数 `list` 调用（归因读数）。 */
async function makeBench() {
  const where = mkdtempSync(join(tmpdir(), 'fugue-bench-walk-read-'))
  const view = await loadView(NO_LOG, AGENT, { lower: NO_TRUTH })
  let lists = 0
  const counted = new Proxy(view, {
    get(target, key) {
      const v = Reflect.get(target, key, target)
      if (key === 'list' && typeof v === 'function') {
        return async (dir) => {
          lists += 1
          return await v.call(target, dir)
        }
      }
      return v
    },
  })
  const host = createToolHost(counted, createRoots(where), {})
  return { where, view: counted, host, lists: () => lists }
}

/** 语料一：60 个目录 × 20 个文件（1200 条路径）——走的是"每目录一次 Promise + 合并 + 排序"。 */
const DIRS = 60
const PER_DIR = 20
async function fillTree(view) {
  for (let d = 0; d < DIRS; d++) {
    for (let i = 0; i < PER_DIR; i++) {
      await view.write(`d${String(d).padStart(2, '0')}/f${String(i).padStart(2, '0')}.ts`, new Uint8Array(Buffer.from(`export const n${d}_${i} = ${i}\n`)))
    }
  }
}

/** 语料二：一份 ≥2 MB 的文本（行固定，好让窗口那一侧对得上号）。 */
const LINES = 40000
const lineOf = (n) => `第 ${n} 行：这一段汉字要长到让整份文件超过两兆字节，窗口那一侧才量得出来。\n`
async function fillBig(view) {
  const text = Array.from({ length: LINES }, (_, i) => lineOf(i + 1)).join('')
  const bytes = new Uint8Array(Buffer.from(text, 'utf8'))
  await view.write('big.txt', bytes)
  return { text, bytes }
}

/** 参照那一份：**不同源**的逐步重走（缓存之前那一段枚举）。 */
async function referenceWalk(view) {
  const out = []
  const step = async (dir, at) => {
    if (at > LIMITS.depth || out.length >= LIMITS.rows) return
    for (const row of await view.list(dir)) {
      if (out.length >= LIMITS.rows) return
      const p = dir === '' ? row.name : `${dir}/${row.name}`
      if (row.kind === 'dir') await step(p, at + 1)
      else if (row.kind === 'file') out.push(p)
    }
  }
  await step('', 0)
  return out
}

const readOf = faceOf('read')
async function readOnce(host, args) {
  const parsed = parseArgs(JSON.stringify(args))
  const t0 = performance.now()
  const r = await readOf(parsed.value, host, { agent: AGENT, step: 0, cwd: '', holder: false })
  return { ms: ms(t0), output: r.output }
}

/** **量之前先自校验**：两边给的结果不同就当场炸（读数不该建立在错的实现上）。 */
async function selfCheck(bench, big) {
  const walked = [...(await bench.host.walk())]
  const want = await referenceWalk(bench.view)
  if (JSON.stringify(walked) !== JSON.stringify(want)) throw new Error(`walk 的等价自校验没过：缓存那一份 ${walked.length} 条，参照 ${want.length} 条`)

  const whole = await readOnce(bench.host, { path: 'big.txt' })
  const head = `big.txt (${big.bytes.byteLength} bytes · ${LINES} lines · mode 100644`
  if (whole.output !== `${head})\n${big.text}`) throw new Error('read 整档那一份与"头 + 原样正文"的参照不同')

  const offset = LINES - 19
  const win = await readOnce(bench.host, { path: 'big.txt', offset, limit: 20 })
  const rows = big.text.split('\n')
  rows.pop()
  const body = rows.slice(offset - 1).map((s, k) => `${offset + k}\t${s}`).join('\n')
  if (win.output !== `${head} · lines ${offset}–${LINES} shown)\n${body}`) throw new Error('read 窗口那一份与独立切片的参照不同')
  return { walked: walked.length, wholeBytes: whole.output.length, winLines: 20 }
}

const runs = []
let checked = null
for (let i = 0; i < RUNS; i++) {
  const bench = await makeBench()
  await fillTree(bench.view)
  const big = await fillBig(bench.view)
  // **预热那两趟不进读数**：一趟热（这一份宿主）、一趟冷（另一份宿主）——把 JIT 与视图那两个
  // Map 都走热。只预热一趟的话，"冷"那一格量到的是**首次走树**的额外代价（GC / Map 扩容），
  // 与"地板"那一格（同一段枚举、只是没有缓存）比不出来。
  await bench.host.walk()
  await createToolHost(bench.view, createRoots(bench.where), {}).walk()
  if (checked === null) checked = await selfCheck(bench, big)

  // 一 · walk 冷：**另一份宿主**（它的缓存是空的——缓存住在宿主闭包里，与视图无关）。
  const coldHost = createToolHost(bench.view, createRoots(bench.where), {})
  const at0 = bench.lists()
  const t0 = performance.now()
  await coldHost.walk()
  const coldMs = ms(t0)
  const coldLists = bench.lists() - at0

  // 五 · 地板：缓存整个摘掉（每一趟现起一份，就是本站之前那条路）。它量的是**同一段枚举**，
  // 所以紧跟"冷"那一格——两格都在同一个热态里，读数才是可比的。
  const at3 = bench.lists()
  const t3 = performance.now()
  await createWalk(bench.view, LIMITS)()
  const floorMs = ms(t3)
  const floorLists = bench.lists() - at3

  // 二 · walk 热：同一代第二次。
  const at1 = bench.lists()
  const t1 = performance.now()
  await coldHost.walk()
  const hotMs = ms(t1)
  const hotLists = bench.lists() - at1

  // 三 · 代变后重走：视图动一格（`write` 推一代）。
  await bench.view.write('d00/new.ts', new Uint8Array(Buffer.from('export const fresh = 1\n')))
  const at2 = bench.lists()
  const t2 = performance.now()
  await coldHost.walk()
  const regenMs = ms(t2)
  const regenLists = bench.lists() - at2

  // 四 · read：整读 vs 深处小窗（归因：交给解码器的字节数）。
  const whole = await readOnce(coldHost, { path: 'big.txt' })
  const offset = LINES - 19
  const win = await readOnce(coldHost, { path: 'big.txt', offset, limit: 20 })
  const decoded = lineWindow(big.bytes, offset, 20).decodedBytes

  runs.push({ coldMs, coldLists, hotMs, hotLists, regenMs, regenLists, wholeMs: whole.ms, winMs: win.ms, decoded, floorMs, floorLists, bytes: big.bytes.byteLength })
  rmSync(bench.where, { recursive: true, force: true })
}

const pick = (k) => runs.map((r) => r[k])
const report = {
  语料: {
    走树: `${DIRS} 个目录 × ${PER_DIR} 个文件`,
    整读: `${LINES} 行 / ${runs[0].bytes} 字节`,
    真源: '不碰（纯内存视图）',
    趟数: RUNS,
  },
  自校验: checked,
  一_walk冷: { 中位数ms: fix(median(pick('coldMs'))), list调用: median(pick('coldLists')) },
  二_walk热: { 中位数ms: fix(median(pick('hotMs'))), list调用: median(pick('hotLists')) },
  三_walk代变后: { 中位数ms: fix(median(pick('regenMs'))), list调用: median(pick('regenLists')) },
  四_read整读: { 中位数ms: fix(median(pick('wholeMs'))) },
  四_read窗口: { 中位数ms: fix(median(pick('winMs'))), 交给解码器字节: median(pick('decoded')) },
  五_地板_无缓存: { 中位数ms: fix(median(pick('floorMs'))), list调用: median(pick('floorLists')) },
}
report.热冷比 = fix(report.二_walk热.中位数ms / report.一_walk冷.中位数ms)
report.窗口整读比 = fix(report.四_read窗口.中位数ms / report.四_read整读.中位数ms)

if (AS_JSON) console.log(JSON.stringify(report))
else {
  const c = report.语料
  console.log(`语料：走树 ${c.走树} · 整读 ${c.整读} · ${c.真源} · ${RUNS} 趟取中位数`)
  console.log(`自校验：walk ${checked.walked} 条与参照逐条相同 · 整档与窗口各与独立参照逐字相同`)
  console.log(`一 · walk 冷：${report.一_walk冷.中位数ms} ms · view.list ${report.一_walk冷.list调用} 次`)
  console.log(`二 · walk 热（同代）：${report.二_walk热.中位数ms} ms · view.list ${report.二_walk热.list调用} 次（热/冷 ${report.热冷比}）`)
  console.log(`三 · walk 代变后重走：${report.三_walk代变后.中位数ms} ms · view.list ${report.三_walk代变后.list调用} 次`)
  console.log(`四 · read 整读：${report.四_read整读.中位数ms} ms · 窗口读（深处 20 行）：${report.四_read窗口.中位数ms} ms · 交给解码器 ${report.四_read窗口.交给解码器字节} 字节（窗口/整读 ${report.窗口整读比}）`)
  console.log(`五 · 地板（缓存死 = 每次未命中）：${report.五_地板_无缓存.中位数ms} ms · view.list ${report.五_地板_无缓存.list调用} 次`)
}
