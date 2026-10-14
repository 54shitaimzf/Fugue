// **多调用 wall-time / CPU 对照**（0.5.0 · 路线图那一行要的读数）。取证件，不是产品的一部分。
//
// 跑法（**在一等档主机上跑**——ext4，不是 9p/共享盘；这一份自己造夹具、自己收尾）：
//
//   node tools/bench-parallel.mjs                      # 默认量 bash 那一路（每次调用真起一个进程）
//   node tools/bench-parallel.mjs --load read --files 500
//   node tools/bench-parallel.mjs --load bash --files 48 --repeats 5
//
// 量的是**同一批只读调用**在两条路上的墙钟与 CPU：
//
//   · **串行**：撤掉批次那一栏（一次一条地调 `executor.execute`）——0.5.0 之前的行为，也是地板
//   · **并行**：默认那条路（`capability/dispatch.ts` 把连续只读一起交下去，一次一批）
//
// **两种负载**（这一栏是这一份要紧的地方）：
//
//   · `bash`：N 条真起进程（每条一次 `sh -c`）。每一条的成本是**一段真延迟**（fork/exec + 等）。
//   · `read`：N 条真读文件（`tools/execute.ts` 读字节）。每一条的成本是**字节搬运**。
//
// **为什么默认是 bash**：只读并行省的是**等待**，不是**搬字节**。第一版只量了 `read` × 32 MiB
// 的热档，两条路都是 ~440 ms——那一段是内存带宽在拖，并行没有可省的东西（如实记在停点报告里）。
// 换成"每次调用带一段真延迟"的负载才看得出来：那段延迟原本是一条压一条。
//
// **口径**：墙钟 `process.hrtime.bigint()` · CPU `process.cpuUsage()`（本进程）· 上下文切换读
// `/proc/self/status` 的 `voluntary_ctxt_switches`（"等了多久"的旁证）。每档先跑 `--repeats`
// 趟预热，再跑 `--repeats` 趟取**中位数**。**不断言快慢**（工作区约定「断言在位，不断言快慢」）：
// 这一份只报数，不看数决定成败；断言在那张并发计数的表里（`src/runtime/batch.test.ts`）。
//
// **实测读数**（2026-10-13 · 20 核 ext4 · `--repeats 3` 取中位数）：
//
//   延迟担着的负载（12 条 read × 1 KiB · 每条等 40 ms）
//     串行 484.8 ms   并行 40.6 ms   **快了 11.93×**   同时开着的最多 12 条
//     CPU 串行 3.7 ms / 并行 0.7 ms（18%）· 上下文切换 12 → 1
//
//   字节担着的负载（2000 条 read × 1 KiB · 不等）
//     串行 14.3 ms   并行 19.2 ms   **0.74×**   同时开着的最多 1 条
//     CPU 串行 24.6 ms / 并行 24.4 ms（99%）· 上下文切换 3 → 3
//
// **两行读数合起来才是这一条的结论**：批次那一栏**本身不更快**——它只在"延迟担着"的负载上
// 兑现，那一档里 12 段等待叠在一起（上下文切换从 12 降到 1 就是它）。字节担着的那一档它在
// 噪声里（0.74×，两次读数各自的抖动就有 14–24 ms），"同时开着的最多 1 条"说明那种负载下
// 每次调用几乎不在等。**所以这一条不许写成"多调用更快"**：省下的是**等**，不是**算**。
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CHILD = join(HERE, 'bench-parallel-child.ts')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  const n = Number(v)
  return Number.isNaN(n) ? v : n
}
const LOAD = String(arg('load', 'bash'))
const FILES = Number(arg('files', LOAD === 'bash' ? 24 : 500))
const KB = Number(arg('kb', 2))
const REPEATS = Number(arg('repeats', 4))
/** 每一次只读要等多久（毫秒）：**并行服务的是这一段**——把它设成 0 就等于"字节担着"的负载。 */
const WAIT = Number(arg('wait', LOAD === 'read' ? 3 : 0))

/** 夹具：N 个小文件（`bash` 那一档起 `cat` 读它们；`read` 那一档整份读它们）。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-bench-'))
  mkdirSync(join(dir, 'bench'), { recursive: true })
  const blob = Buffer.alloc(KB * 1024, 0x78)
  const rows = []
  for (let i = 0; i < FILES; i += 1) {
    const name = `bench/f${String(i).padStart(4, '0')}.txt`
    writeFileSync(join(dir, name), blob)
    rows.push(name)
  }
  return { dir, rows }
}

function run(mode, dir, rows) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', CHILD, dir, mode, LOAD, JSON.stringify(rows), String(REPEATS), String(WAIT)],
    { encoding: 'utf8', cwd: HERE },
  )
  if (r.status !== 0) return { why: `子进程退了 ${r.status}：${(r.stderr || r.stdout || '').trim().split('\n').at(-1)}` }
  const got = JSON.parse(r.stdout.trim().split('\n').at(-1))
  const all = got.passes
  const warm = all.slice(0, REPEATS)
  const measured = all.slice(REPEATS)
  const pick = (list, key) => {
    const v = list.map((x) => x[key]).sort((a, b) => a - b)
    return v[Math.floor(v.length / 2)]
  }
  return {
    maxActive: got.maxActive,
    warmMs: pick(warm, 'ms'),
    ms: pick(measured, 'ms'),
    cpuMs: pick(measured, 'userMs') + pick(measured, 'sysMs'),
    switches: pick(measured, 'switches'),
    raw: measured,
  }
}

const { dir, rows } = fixture()
try {
  const serial = run('serial', dir, rows)
  const parallel = run('parallel', dir, rows)
  const num = (x, digits = 1) => (typeof x === 'number' ? x.toFixed(digits) : '—')
  console.log(`夹具：${FILES} 条 ${LOAD} × ${KB} KiB · 每条等 ${WAIT} ms · 每档预热 ${REPEATS} 趟取中位数 · ${dir}`)
  if (serial.why !== undefined || parallel.why !== undefined) {
    console.log(`取不到：${serial.why ?? parallel.why}`)
    process.exitCode = 1
  } else {
    console.log(
      `串行 ${num(serial.ms)} ms（预热 ${num(serial.warmMs)}）\t并行 ${num(parallel.ms)} ms（预热 ${num(parallel.warmMs)}）\t` +
        `快了 ${num(serial.ms / parallel.ms, 2)}×\t每条 ${num(serial.ms / FILES, 3)} ms → ${num(parallel.ms / FILES, 3)} ms`,
    )
    console.log(
      `同时开着的最多条数：串行 ${serial.maxActive} / 并行 ${parallel.maxActive}` +
        (serial.maxActive === 1 ? '（串行那一档是地板：一次一条）' : ''),
    )
    console.log(
      `CPU：串行 ${num(serial.cpuMs)} ms / 并行 ${num(parallel.cpuMs)} ms（${num((parallel.cpuMs / serial.cpuMs) * 100, 0)}%）\t` +
        `上下文切换：${serial.switches} → ${parallel.switches}`,
    )
    console.log(`原始读数（串行）：${JSON.stringify(serial.raw)}`)
    console.log(`原始读数（并行）：${JSON.stringify(parallel.raw)}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
