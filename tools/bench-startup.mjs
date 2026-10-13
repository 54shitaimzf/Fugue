// **启动与装载的取证件**（0.5.0 维护批）。取证件，不是产品的一部分——但**读数的口径只有这一处**，
// 所以要改口径就改这里，别在别处另写一遍。
//
// 跑法（**在一等档主机上跑**——ext4，不是 9p/共享盘）：
//
//   node tools/bench-startup.mjs
//   node tools/bench-startup.mjs --runs 5 --cmd 'round plan'
//   node tools/bench-startup.mjs --json
//
// 三样读数：
//
//   · **装载闭包**。`NODE_DEBUG=esm` 数两个数，两个都印出来，因为两个都有用：
//       - `装载行`：匹配 `Translating` 的**行数**。这是交接单 § 七 那一句
//         （`NODE_DEBUG=esm node src/cli/fugue.ts --version 2>&1 | grep -c Translating`）的口径，
//         所以"349 份"那个基线只有跟它比才是同一把尺。
//         **它数的是行、不是模块**：Node 一份 `.ts` 会打两行（`TypeScript <url>` 与
//         `StandardModule <url>`），`node:` 内建每个一行——所以它比模块数虚高。
//       - `模块`：那些行里属于本仓 `src/` 的**去重模块数**。这才是"这一条命令装了几份代码"，
//         也是 `src/cli/load.test.ts` ⑥ 断言拿的那个数（同一份口径，只有这一处实现）。
//   · **墙钟** = 同一趟 bash `time` 的 `%R`，连起跑前与收尾的 `/proc/loadavg` 一起记
//     （路线图 § 1「本机取数记两杆」：宿主忙时墙钟能涨四成以上，所以取数条件要跟读数一起落）。
//   · **子进程 CPU 秒** = 同一趟的 `%U + %S`，就是 `cutime + cstime`（路线图 § 1 那一句）。
//     **「套件悄悄变慢」看 CPU 那一杆**，墙钟只作趋势与取数条件的记录。
//
// 每档跑 `--runs` 趟取**中位数**（缺省 3），三趟原始值一并印出来。**不断言快慢**（工作区约定
// 「断言在位，不断言快慢」）：这一份只报数；盯装载那一半的断言在 `src/cli/load.test.ts`。
//
// 这一份**自己不带读数**：数落在 `CHANGELOG.md` 的 `[0.5.0]` 段与停点报告里（抄一份就是两处真相）。
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(ROOT, 'src', 'cli', 'fugue.ts')

/** 缺省量哪几条命令行（每条给 argv，不给一整串——省掉分词那一层）。 */
const DEFAULT_CMDS = [
  ['--version'],
  ['--help'],
  ['doctor'],
  ['status', '--once'],
  ['round', 'plan'],
]

/** `Translating` 那一行的形状：`ESM <pid>: Translating TypeScript file:///… [Object: null prototype] {`。 */
const TRANSLATING = /Translating\s+(?:TypeScript|StandardModule|BuiltinModule)\s+(\S+)/

/**
 * 一条命令行装了本仓的哪几份模块。
 *
 * 子进程的 stderr 直通一个临时文件：`NODE_DEBUG=esm` 每一行后面还跟着一份对象转储（几百行），
 * 一条命令几万行，走管道会撞缓冲区上限。
 *
 * 返回 `{ lines, modules, files, status }`：`lines` 是口径那一句数的行数，`modules` 是本仓
 * `src/` 里的去重模块数，`files` 是仓内相对路径（排序）。
 */
export function closureOf(args, o = {}) {
  const root = o.root ?? ROOT
  const dir = mkdtempSync(join(tmpdir(), 'fugue-bench-'))
  const errFile = join(dir, 'stderr.txt')
  const fd = openSync(errFile, 'w')
  let status = null
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      stdio: ['ignore', 'ignore', fd],
      env: { ...process.env, NODE_DEBUG: 'esm' },
    })
    status = r.status
  } finally {
    closeSync(fd)
  }
  const text = readFileSync(errFile, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  let lines = 0
  const files = new Set()
  for (const line of text.split('\n')) {
    const m = TRANSLATING.exec(line)
    if (m === null) continue
    lines += 1
    const p = (m[1] ?? '').replace(/^file:\/\//, '')
    if (p.startsWith(ROOT)) files.add(relative(ROOT, p).replace(/\\/g, '/'))
  }
  return { lines, modules: files.size, files: [...files].sort(), status }
}

/** 取数条件：`/proc/loadavg`（一等档主机上有；别处给 `null`，不假装量到了）。 */
function loadavg() {
  try {
    return readFileSync('/proc/loadavg', 'utf8').trim()
  } catch {
    return null
  }
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * 一趟两杆：墙钟（ms）与子进程 CPU（ms）。
 *
 * `TIMEFORMAT` 只认 `real` / `user` / `sys` 三个量，`time` 把结果写 stderr——所以那一趟的
 * stderr 里最后一行非空的行就是它（命令自己的 stderr 排在前面）。
 */
export function leversOf(args, o = {}) {
  const root = o.root ?? ROOT
  const before = loadavg()
  const cmdline = [process.execPath, CLI, ...args].map(quote).join(' ')
  const r = spawnSync('bash', ['-c', `TIMEFORMAT='%3R %3U %3S'; time ${cmdline}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const after = loadavg()
  const last = (r.stderr ?? '').trim().split('\n').filter((x) => x !== '').at(-1) ?? ''
  const parts = last.trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return { why: `读不出 time 那三栏（最后一行是 ${JSON.stringify(last)}）`, before, after, status: r.status }
  }
  return {
    realMs: parts[0] * 1000,
    userMs: parts[1] * 1000,
    sysMs: parts[2] * 1000,
    cpuMs: (parts[1] + parts[2]) * 1000,
    before,
    after,
    status: r.status,
  }
}

/** 一档的量法：装载闭包量一趟（它是确定值），两杆量 `runs` 趟取中位数。 */
export function measure(args, o = {}) {
  const runs = o.runs ?? 3
  const closure = closureOf(args, o)
  const all = []
  for (let i = 0; i < runs; i += 1) all.push(leversOf(args, o))
  const why = all.find((x) => x.why !== undefined)?.why
  const median = (key) => {
    const v = all.map((x) => x[key]).filter((n) => typeof n === 'number').sort((a, b) => a - b)
    return v.length === 0 ? null : v[Math.floor(v.length / 2)]
  }
  return {
    argv: args,
    lines: closure.lines,
    modules: closure.modules,
    files: closure.files,
    status: closure.status,
    wallMs: median('realMs'),
    cpuMs: median('cpuMs'),
    userMs: median('userMs'),
    sysMs: median('sysMs'),
    before: all[0]?.before ?? null,
    after: all.at(-1)?.after ?? null,
    runs: all.map((x) => ({ wallMs: x.realMs ?? null, cpuMs: x.cpuMs ?? null })),
    ...(why === undefined ? {} : { why }),
  }
}

function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--runs')
  const runs = i < 0 ? 3 : Number(argv[i + 1])
  const cmds = []
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === '--cmd') cmds.push(String(argv[k + 1]).split(/\s+/))
  }
  const list = cmds.length > 0 ? cmds : DEFAULT_CMDS
  const out = list.map((args) => measure(args, { runs }))
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ schema: 1, node: process.version, runs, readings: out }, null, 2))
    return
  }
  const num = (x) => (typeof x === 'number' ? x.toFixed(1) : '—')
  console.log(`仓：${ROOT}`)
  console.log(`node ${process.version} · 两杆各 ${runs} 趟取中位数 · 装载量一趟（确定值）`)
  console.log('')
  console.log(
    '命令行'.padEnd(20) + '模块'.padStart(6) + '装载行'.padStart(8) + '墙钟 ms'.padStart(10) + 'CPU ms'.padStart(10) + '   三趟墙钟/CPU',
  )
  for (const r of out) {
    const face = (r.argv.length === 0 ? '(无参数)' : r.argv.join(' ')).padEnd(20)
    const raw = r.runs.map((x) => `${num(x.wallMs)}/${num(x.cpuMs)}`).join('  ')
    console.log(
      face +
        String(r.modules).padStart(6) +
        String(r.lines).padStart(8) +
        num(r.wallMs).padStart(10) +
        num(r.cpuMs).padStart(10) +
        '   ' +
        raw,
    )
    if (r.why !== undefined) console.log(`    ！${r.why}`)
  }
  const first = out.find((r) => r.before !== null)
  const last = [...out].reverse().find((r) => r.after !== null)
  if (first !== undefined) console.log(`\nloadavg 起跑前：${first.before}`)
  if (last !== undefined) console.log(`loadavg 收尾：${last.after}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
