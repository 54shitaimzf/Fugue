// 子进程那一侧：**同一批只读调用，两条路各跑一遍**（0.5.0 · `tools/bench-parallel.mjs` 的测量件）。
//
// 走的是**真那一条**：`capability/dispatch.ts` 的 `createToolExecutor`（查真能力表 · 过真围栏 →
// `tools/execute.ts` 真读字节 / 真起进程），宿主只做那两件真事。批次那一栏是唯一的自变量：
// **串行那一档一次一条地调 `execute`**（0.5.0 之前的行为），**并行那一档把整批交给 `executeAll`**。
//
// 位置参数：<dir> <serial|parallel> <read|bash> <rowsJson> <repeats>
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { createToolExecutor } from '../src/capability/dispatch.ts'
import { fixtureState } from '../src/model/fixture-state.ts'

const [dir, mode, load, rowsJson, repeatsRaw, waitRaw] = process.argv.slice(2)
const rows = JSON.parse(rowsJson)
const repeats = Number(repeatsRaw)
/** 每一次只读**要等多久**（毫秒；这一段是"那条工具什么时候回来"的那一段延迟）。 */
const WAIT_MS = Number(waitRaw ?? 0)

/** 一段真等待（`setTimeout`：它是**异步**的——并行的意义就在这里，串行那一档只能一条一条等）。 */
const rest = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** 不落事件的空日志口（这一份量的是执行那一趟，不是账）。 */
const LOG = {
  append: async () => 0,
  readByWriter: async () => [],
  readMerged: async function* () {},
  writers: async () => [],
  clocks: async () => ({}),
  close: async () => undefined,
}
const notHere = (what) => async () => {
  throw new Error(`这一份不该走到 ${what}`)
}
const host = {
  async readBytes(rel) {
    // **两件真事**：等一段（异步的延迟）+ 真读盘上那份字节。第一条是并行能省的那一段，
    // 第二条是省不掉的（字节还是要搬）。
    active += 1
    if (active > maxActive) maxActive = active
    try {
      if (WAIT_MS > 0) await rest(WAIT_MS)
      const abs = rel.startsWith('/') ? rel : join(dir, rel)
      return { bytes: readFileSync(abs), mode: 0o100644 }
    } finally {
      active -= 1
    }
  },
  async writeBytes() {
    throw new Error('只读那一批不该走到 writeBytes')
  },
  async list() {
    return rows.map((name) => ({ name, kind: 'file', size: 0 }))
  },
  async walk() {
    return rows
  },
  /** **真起进程**：每一次 `bash` 调用一条 `sh -c`（"每次调用带一段真延迟"的那种负载）。 */
  async run(req) {
    const t0 = process.hrtime.bigint()
    active += 1
    if (active > maxActive) maxActive = active
    // 下面一定减回去（`finally` 那一段在真正的返回之前）。
    // **异步那一档**：`execFile` 不占住事件循环，于是"几条一起在飞"这件事在盘上量得出来。
    // 同步那一档（`spawnSync`）会把这一份量成"两条路一样快"——那是夹具在串行，不是机制不重叠。
    const got = await new Promise((done) => {
      execFile('/bin/sh', ['-c', String(req.command ?? 'true')], { cwd: dir, encoding: 'utf8' }, (err, stdout, stderr) =>
        done({ err, stdout: stdout ?? '', stderr: stderr ?? '' }),
      )
    })
    active -= 1
    return {
      exit: got.err === null ? 0 : ((got.err as { code?: number }).code ?? 1),
      stdout: got.stdout,
      stderr: got.stderr,
      denied: false,
      ms: Number(process.hrtime.bigint() - t0) / 1e6,
    }
  },
  edit: notHere('edit'),
  /** 执行那一趟先问这一句（物化后的根在哪）：这一份的根就是夹具目录。 */
  async execCwd() {
    return dir
  },
  checkpoint: notHere('checkpoint'),
  runAction: notHere('runAction'),
  setTodos: notHere('setTodos'),
  declarePlan: notHere('declarePlan'),
  askUser: notHere('askUser'),
  deny: async () => undefined,
}

let active = 0
let maxActive = 0

const made = createToolExecutor({
  logOf: () => LOG,
  host,
  // **先物化那一条**（M4 的 ensure）：这一份的视图就是夹具目录，物化是恒真的。
  ensureOf: async () => undefined,
  fenceOf: (raw, cwd) => {
    const abs = resolve(dir, cwd === '' ? raw : join(cwd, raw))
    if (!abs.startsWith(resolve(dir))) return { ok: false, error: { reason: '越界' } }
    return { ok: true, value: abs }
  },
})

const handle = {
  agent: 'agent-bench',
  coord: { id: 'agent-bench', branch: 'refs/heads/main', outputPaths: [] },
  branch: 'refs/heads/main',
  contract: '',
  protocol: 'subagent',
  model: 'deepseek-flash/anthropic',
  wireModel: 'deepseek-flash',
  target: null,
  adapter: { name: 'none' },
  call: {},
  state: { ...fixtureState(0), step: 0, cwd: '' },
}

const calls =
  load === 'bash'
    ? rows.map((r, i) => ({ id: `c${i}`, name: 'bash', arguments: JSON.stringify({ command: `cat ${r}` }) }))
    : rows.map((r, i) => ({ id: `c${i}`, name: 'read', arguments: JSON.stringify({ path: r }) }))

/** **一趟**：串行就是一条一条地调单调用那一栏；并行就是把整批交给批次那一栏。 */
async function onePass() {
  if (mode === 'serial') {
    const out = []
    for (const c of calls) out.push(await made.execute(c, handle))
    return out
  }
  return await made.executeAll(calls, handle)
}

const switchOf = () => {
  const m = /voluntary_ctxt_switches:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))
  return m === null ? 0 : Number(m[1])
}
const out = []
for (let i = 0; i < repeats * 2; i += 1) {
  const cpu0 = process.cpuUsage()
  const sw0 = switchOf()
  const t0 = process.hrtime.bigint()
  const results = await onePass()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const cpu = process.cpuUsage(cpu0)
  const ok = results.filter((r) => r.ok === true).length
  if (ok !== calls.length) {
    console.error(`BAD ${ok}/${calls.length}：${JSON.stringify(results[0]).slice(0, 300)}`)
    process.exit(1)
  }
  out.push({ ms, userMs: cpu.user / 1000, sysMs: cpu.system / 1000, switches: switchOf() - sw0 })
}
console.log(JSON.stringify({ passes: out, maxActive }))
