// tier: real —— cc · 真端口（并发窗口与端口隔离）
// X3 的断言：**N 路并发执行，结果与串行逐字节一致**（PLAN § 5.4 的 X3 行 · 架构 § 8.6 那条验证性质）。
//
//   ① 四个 agent 各跑同一个动作：四路并发一趟、逐个串行一趟，比**同一批 agent 的两次**——
//      声明集内的产出逐字节相同 · 退出码相同 · `mat/*` 与 `run/*` 事件逐条相同（`ms` 是读数，不比）
//   ② 无串扰：四个 agent 的 `HOME` · `TMPDIR` · `XDG_CACHE_HOME` · 缓存目录 · 端口两两不同，
//      而且各自的坐标里只有自己写下的号
//   ③ 负对照：四个进程指到同一份坐标（同一个 agent 的缓存）→ 串扰出现
//   ④ 收尾：无残留挂载 · 无残留进程 · 无端口占用
//
// **比的为什么是"同一批 agent 的两次"。** 四路并发与逐个串行，两次跑的是同样四个 agent、
// 同一批坐标（`cacheRoot(a)` · `tempRoot(a)` · 端口片都按 agent 定，两趟一样），所以两趟的
// 产物没有理由不同。反过来**跨 agent 比**是错的：物化树在 `.fugue/mat/<agent>/merged`，
// 路径进了二进制（`-g` 的 DWARF 里就是编译目录，S4 前的探针量过 4 个文件不同）——那是
// 路径不同，不是并发不同。所以断言只比同一个 agent 的两趟。
//
// **动作是真的**：`build` 走 `cc` 编出一个可执行文件（声明成产出、回收进视图），并且把本
// agent 的 `PORT` 真的 `listen` 起来撑住一会儿——四路并发若有两路撞号，那一下就是 EADDRINUSE。
// `seen` 只做端口与三处坐标的记录：它是"串扰"那条断言的读数（自己的坐标里出现了别人的号）。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { envFor } from '../boundary/binding.ts'
import type { ActionBinding } from '../boundary/binding.ts'
import { confine } from '../boundary/confine.ts'
import { createExecutor } from './exec.ts'
import { resolvePolicy } from '../boundary/policy.ts'
import { isMounted } from '../materialize/mount.ts'
import { createRoots } from '../roots/roots.ts'
import type { AgentId } from '../terms.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

function fugue(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

/** 二进制安全的那一条：`read` 吐的是原始字节，不能让 `utf8` 把它搅了。 */
function fugueBytes(root: string, ...args: string[]): Buffer {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args])
  assert.equal(r.status, 0, String(r.stderr))
  return r.stdout
}

/** 并发跑：四路真的同时开着（各自的 `run` 窗口重叠——动作里那一次 `listen` + 撑住就是为此）。 */
function fugueAll(root: string, calls: readonly string[][]): Promise<Run[]> {
  return Promise.all(
    calls.map(
      (args) =>
        new Promise<Run>((done) => {
          const c = spawn(process.execPath, [CLI, '--root', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
          let out = ''
          let err = ''
          c.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
          c.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
          c.on('close', (code) => done({ code: code ?? -1, out, err }))
        }),
    ),
  )
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'fugue',
      GIT_AUTHOR_EMAIL: 'fugue@localhost',
      GIT_COMMITTER_NAME: 'fugue',
      GIT_COMMITTER_EMAIL: 'fugue@localhost',
      GIT_AUTHOR_DATE: '2026-02-01T00:00:00+0000',
      GIT_COMMITTER_DATE: '2026-02-01T00:00:00+0000',
    },
  })
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`)
  return r.stdout.trim()
}

/** 把本 agent 的号真的绑上：四路并发若撞号，这一句当场 EADDRINUSE（子进程非零退出）。 */
const LISTEN = `const port = Number(process.env.PORT)
const server = createServer()
await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok) })
`

const BUILD = `import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
// 真构建：产物落在声明目录绑的那份缓存里（dist 是 cache，dist/app 是要回收的产出）。
mkdirSync('dist', { recursive: true })
execFileSync('cc', ['-o', 'dist/app', 'src/a.c'])
${LISTEN}// 撑住一会儿，让四路真的重叠
await new Promise((r) => setTimeout(r, 600))
server.close()
console.log(JSON.stringify({ port }))
`

const SEEN = `import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
${LISTEN}// 三处坐标各记一笔自己的号：串扰的读数就是"这里出现了别人的号"。
const note = (d) => appendFileSync(d + '/seen.txt', port + '\\n')
for (const d of [process.env.HOME, process.env.TMPDIR, process.env.XDG_CACHE_HOME]) note(d)
await new Promise((r) => setTimeout(r, 600))
const read = (d) => [...new Set(readFileSync(d + '/seen.txt', 'utf8').trim().split('\\n'))].sort()
console.log(JSON.stringify({ port, home: read(process.env.HOME), tmp: read(process.env.TMPDIR), xdg: read(process.env.XDG_CACHE_HOME) }))
server.close()
`

const C_SRC = '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n'
const AGENTS = ['agent/r1/1', 'agent/r1/2', 'agent/r1/3', 'agent/r1/4']

interface Made {
  readonly root: string
  readonly base: string
}
const MADE: Made[] = []

function workspace(): Made {
  // 与 `run.test.ts` 同一条理由：自己收尾（先 dispose 再删），不用 `tmpDir` 那个帮手。
  const root = mkdtempSync(join(tmpdir(), 'fugue-x3-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.c'), C_SRC)
  writeFileSync(join(root, 'build.mjs'), BUILD)
  writeFileSync(join(root, 'seen.mjs'), SEEN)
  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  const base = git(root, 'rev-parse', 'HEAD')
  const made: Made = { root, base }
  MADE.push(made)
  fugue(root, 'config', 'set', 'actions.build', '{"argv":["node","build.mjs"],"cache":["dist"],"outputs":["dist/app"]}')
  fugue(root, 'config', 'set', 'actions.seen', '{"argv":["node","seen.mjs"]}')
  for (const a of AGENTS) {
    assert.equal(fugue(root, '--agent', a, 'branch', base).code, 0)
    assert.equal(fugue(root, '--agent', a, 'fork', base).code, 0)
  }
  return made
}

after(() => {
  for (const w of MADE) {
    for (const a of AGENTS) fugue(w.root, '--agent', a, 'dispose')
    try {
      rmSync(w.root, { recursive: true, force: true })
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', w.root], { encoding: 'utf8' })
    }
  }
})

interface Row {
  readonly pos: { writer: string; seq: number }
  readonly e: Record<string, unknown> & { t: string }
}

/** 该 agent 此刻的全部事件——两趟之间的"增量"由线数切出来。 */
function eventsOf(root: string, agent: string): Row[] {
  const r = fugue(root, '--json', 'log', '--agent', agent)
  assert.equal(r.code, 0, r.err)
  return r.out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
}

/** 这一趟里 `mat/*` 与 `run/*` 两类事件（`ms` 是读数，不比）。 */
function window(rows: readonly Row[]): Record<string, unknown>[] {
  return rows
    .filter((r) => r.e.t.startsWith('mat/') || r.e.t.startsWith('run/'))
    .map((r) => {
      const { ms: _ms, ...rest } = r.e
      return rest
    })
}

/** 这一趟里写进视图的那几条（`blob` 就是内容的 sha1：逐字节相同 == 这一栏相同）。 */
function wrote(rows: readonly Row[]): Record<string, unknown>[] {
  return rows
    .filter((r) => r.e.t === 'view/write')
    .map((r) => ({ path: r.e.path, blob: r.e.blob, mode: r.e.mode }))
}

/** 子进程打出来的那份 JSON（它走我们的 stderr）。 */
function childJson(err: string): Record<string, unknown> {
  const line = err
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop()
  assert.notEqual(line, undefined, `子进程没有打出 JSON：${err}`)
  return JSON.parse(line as string) as Record<string, unknown>
}

function cliJson(r: Run): Record<string, unknown> {
  assert.equal(r.code, 0, r.err)
  return JSON.parse(r.out.trim()) as Record<string, unknown>
}

/** 127.0.0.1:<port> 此刻空着吗。连着试试——连得上说明有人听着，连不上就是空着。 */
function portFree(port: number): Promise<boolean> {
  return new Promise<boolean>((done) => {
    let settled = false
    const finish = (v: boolean): void => {
      if (settled) return
      settled = true
      s.destroy()
      done(v)
    }
    const s = connect({ host: '127.0.0.1', port })
    s.once('connect', () => finish(false))
    s.once('error', () => finish(true))
    setTimeout(() => finish(true), 500)
  })
}

test('X3 ① · 四路并发一趟 · 逐个串行一趟：同一批 agent 的两次，产出逐字节相同', async () => {
  const w = workspace()
  const calls = AGENTS.map((a) => ['--agent', a, '--json', 'run', 'build'])

  // 并发那一趟：四路同时开。线数各自记下来——事件的"这一趟"由它切。
  const before = AGENTS.map((a) => eventsOf(w.root, a).length)
  const par = await fugueAll(w.root, calls)
  for (const r of par) assert.equal(r.code, 0, r.err)
  const slicePar = AGENTS.map((a, i) => eventsOf(w.root, a).slice(before[i]))

  // 两趟之间把视图与物化对齐（`ensure`）：串行那一趟因此从同一个起点出发，
  // 它的隐式物化不会多落一条 `mat/sync`——两趟的 `mat/*` 与 `run/*` 才谈得上逐条比。
  for (const a of AGENTS) assert.equal(fugue(w.root, '--agent', a, 'ensure').code, 0)
  const bytesPar = AGENTS.map((a) => ({
    view: fugueBytes(w.root, '--agent', a, 'read', 'dist/app'),
    cache: readFileSync(join(w.root, '.fugue', 'mat', a, 'cache', 'dist', 'app')),
  }))

  // 串行那一趟：逐个来。
  const mark = AGENTS.map((a) => eventsOf(w.root, a).length)
  for (const c of calls) assert.equal(fugue(w.root, ...c).code, 0)
  const sliceSer = AGENTS.map((a, i) => eventsOf(w.root, a).slice(mark[i]))

  for (let i = 0; i < AGENTS.length; i++) {
    const a = AGENTS[i] as string
    const tag = `agent ${a}`
    // 这一趟的窗口：跑起来 · 报档 · 报退出码。**`view/write` 不在这一份里**——
    // ① 里的三样：事件逐条相同（ms 不比）· 产出逐字节相同（blob 是内容的 sha1）· 退出码相同。
    assert.deepEqual(window(sliceSer[i] as Row[]), window(slicePar[i] as Row[]), `${tag}：mat/* 与 run/* 逐条相同`)
    assert.deepEqual(wrote(sliceSer[i] as Row[]), wrote(slicePar[i] as Row[]), `${tag}：产出逐字节相同`)
    const end = (rows: readonly Row[]): Record<string, unknown> =>
      rows.filter((r) => r.e.t === 'run/end')[0]?.e ?? {}
    assert.equal(end(sliceSer[i] as Row[]).exit, end(slicePar[i] as Row[]).exit, `${tag}：退出码相同`)
    assert.equal(end(slicePar[i] as Row[]).exit, 0)
    assert.equal(end(slicePar[i] as Row[]).denied, false)
    // 盘上那两份也逐字节比一遍（blob 是日志那一侧，这两份是盘与视图那一侧）。
    assert.deepEqual(
      {
        view: fugueBytes(w.root, '--agent', a, 'read', 'dist/app'),
        cache: readFileSync(join(w.root, '.fugue', 'mat', a, 'cache', 'dist', 'app')),
      },
      bytesPar[i],
      `${tag}：盘上与视图里的字节都没变`,
    )
    // 它是一份真编译出来的东西（ELF 头 + 一万多字节），不是一份空产出。
    assert.equal((bytesPar[i] as { view: Buffer }).view.subarray(0, 4).toString('latin1'), '\x7fELF', `${tag}：产出是一个 ELF`)
    assert.equal((bytesPar[i] as { view: Buffer }).view.length > 1000, true, `${tag}：它有一万多字节`)
  }

  // 声明集内的产出确实进了视图，而且没有一条"越了声明"。
  for (const rows of slicePar) {
    assert.equal(rows.some((r) => r.e.t === 'mat/reclaim'), false)
  }
})

test('X3 ② · 无串扰：宿主那一侧的坐标两两不同，各自的坐标里只有自己的号（四路并发里各自绑得上号）', async () => {
  const w = workspace()
  const res = await fugueAll(
    w.root,
    AGENTS.map((a) => ['--agent', a, '--json', 'run', 'seen']),
  )
  const jsons = res.map(cliJson)
  const child = res.map((r) => childJson(r.err))

  // **两两不同的是宿主那一侧**：物化树 `merged` 与端口。家 · temp ·
  // XDG 那三条子进程看到的名字四个 agent **一样**（`/cache` `/tmp` `/cache/xdg-cache`），
  // 隔离落在"同一个名字绑到各自的缓存"上——那一条的读数在下面（各自的坐标里只有自己的号）。
  for (const k of ['merged', 'ports'] as const) {
    const seen = new Set(jsons.map((j) => String(j[k])))
    assert.equal(seen.size, AGENTS.length, `${k} 四个 agent 两两不同：${[...seen].join(' · ')}`)
  }
  for (const k of ['home', 'tmp', 'xdgCache'] as const) {
    const seen = new Set(jsons.map((j) => String(j[k])))
    assert.equal(seen.size, 1, `${k} 四个 agent 的名字一样（沙箱里那一条坐标）：${[...seen].join(' · ')}`)
  }
  // 端口那一片两两不相交（四个号，池子按 4 个一片切开）。
  const ports = jsons.map((j) => Number(j.port))
  assert.equal(new Set(ports).size, AGENTS.length)
  for (const j of jsons) assert.equal(String(j.ports), `${j.port}-${Number(j.port) + 3}`)

  // 四路并发里四个都绑上了自己那个号：绑不上就 EADDRINUSE，子进程非零退出——`cliJson` 已经要求了 0。
  for (let i = 0; i < AGENTS.length; i++) {
    const j = jsons[i] as Record<string, unknown>
    const c = child[i] as Record<string, unknown>
    assert.equal(c.port, j.port, `agent ${AGENTS[i]}：子进程看到的号就是命令行给的那一个`)
    // 三处坐标里只有自己写下的那一个号——别人写进来的话，这里就会多一个。
    for (const k of ['home', 'tmp', 'xdg'] as const) {
      assert.deepEqual(c[k], [String(j.port)], `agent ${AGENTS[i]} 的 ${k} 里只有自己的号`)
    }
  }
})

test('X3 ③ 负对照 · 四个进程指到同一份坐标：串扰出现', async () => {
  const w = workspace()
  // 先真跑一趟，把那份缓存与挂载点建出来（直驱 `confine` 的那条路不建它们）。
  assert.equal(fugue(w.root, '--agent', AGENTS[0], 'run', 'seen').code, 0)
  const roots = createRoots(w.root)
  const agent = AGENTS[0] as AgentId
  const binding: ActionBinding = { name: 'seen', argv: [], cwd: '', outputs: [], cache: [], env: {}, net: 'none' }
  const executor = createExecutor({ onChunk: () => {} })
  // 四个进程同一份策略值（Y2 起 `confine()` 要它）：缺省档——`envFor` 的坐标也从它来（Y3 起）。
  const policy = resolvePolicy({ roots, agent, doc: {} })
  // **四个进程同一个 agent**：`confine` 因此把同一份缓存绑给四个（家 · temp · XDG 都是同一处），
  // 只有端口那一片按 portIndex 分开。
  const results = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const env = envFor({ agent, binding, injections: {}, portIndex: i, range: '31000-31099', policy })
      const confined = confine({ roots, agent, argv: ['node', 'seen.mjs'], cwd: '', declared: [], env, policy })
      return await executor.run(agent, { action: 'seen', confined, cwd: '', env }, new AbortController().signal)
    }),
  )
  const seen = results.map(
    (r) =>
      JSON.parse(r.stdout.trim().split('\n').pop() as string) as {
        port: number
        home: string[]
        tmp: string[]
        xdg: string[]
      },
  )
  assert.equal(results.every((r) => r.exit === 0), true, results.map((r) => r.stderr).join('\n'))
  // 串扰出现：同一个家里堆着别人写下的号（四个进程都写进了同一份 HOME/seen.txt）。
  // **比的是数，不是字符串**：子进程打出来的是 JSON 里的字符串，`'31000' !== 31000` 会让这条
  // 断言永远成立——它曾经就是这样一句恒真的空话，负对照因此照不出来（实测撞到，见提交信息）。
  const others = seen.flatMap((s) =>
    s.home.filter((p) => Number(p) !== s.port).map((p) => `${s.port} 看见 ${p}`),
  )
  assert.notDeepEqual(others, [], `四个进程共用一份坐标时，家里该出现别人的号：${JSON.stringify(seen)}`)
})

test('X3 ④ · 收尾：无残留挂载 · 无残留进程 · 无端口占用', async () => {
  const w = workspace()
  const res = await fugueAll(
    w.root,
    AGENTS.map((a) => ['--agent', a, '--json', 'run', 'seen']),
  )
  const ports = res.map((r) => Number(cliJson(r).port))
  const roots = createRoots(w.root)
  // 跑完这会儿：四棵树都还挂着（挂载只包围执行，`run` 不卸它）。
  for (const a of AGENTS) assert.equal(isMounted(roots.mergedRoot(a as AgentId)), true, `${a} 的树挂着`)

  for (const a of AGENTS) assert.equal(fugue(w.root, '--agent', a, 'dispose').code, 0)
  // 挂载表里一条都不留（`dispose` 先卸后删），四个坐标也一起走了。
  for (const a of AGENTS) {
    assert.equal(isMounted(roots.mergedRoot(a as AgentId)), false, `${a}：不留挂载`)
    assert.equal(existsSync(roots.cacheRoot(a as AgentId)), false, `${a}：缓存跟着一起删`)
  }
  // 没有进程还挂在这个工作区上。
  const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
  const lingering = ps.stdout
    .split('\n')
    .filter((l) => l.includes(w.root) && !l.includes('ps -eo'))
  assert.deepEqual(lingering, [], '没有进程挂在这个工作区上')
  // 端口空着：跑的时候四个号都真绑上过（②里那一条），跑完一个都不占。
  const free = await Promise.all(ports.map((p) => portFree(p)))
  assert.deepEqual(free, [true, true, true, true], `跑完之后四个号都空着：${ports.join(' · ')}`)
})
