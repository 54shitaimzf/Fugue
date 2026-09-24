// Y5 的断言（PLAN § 5.5 的 Y5 行 · 架构 § 8.8 机制表里 OS 沙箱那一栏 · § 20 S5 的可用性 ·
// 站前三件里的一件：缺省无网，要网由动作点名）。
//
//   ① 缺省档三条读数：**DNS 不通** · **直连 IP 不通** · **回环 服务端+客户端一次真连 通**
//   ② 负对照：动作点名要网（`net: "host"`）→ 那孩子与**宿主在同一门网络命名空间里**。证据是
//      **同一个靶子上的两个答案**：宿主侧起一个 TCP 服务端，缺省档连它是 `ECONNREFUSED`（那是
//      孩子自己那份回环），要网那一档**连得上**（那是宿主的回环）。这一对读数才说得上"那一刀
//      真切在命名空间上，不是碰巧没网"。
//   ③ `fugue policy` 与 `run/confined` 如实报这一栏（Y2 定的形状，这里给它配行为读数）。
//
// **靶子为什么不挑公网地址**：那要看这台机器有没有出口，读数就成了机器的读数。宿主自己起的那个
// 服务端不依赖出口——净结果只由"在不在同一门命名空间"决定。公网那一条照测、照印，只当读数。
//
// **"点名要网"这条点名兑现的是两半**：要网那一档拿到了宿主的命名空间（那一半），而**按域名出网还要
// 解析器配置**——它不在清单里时是 `err:EAI_AGAIN`。分档量过（同一个
// 工作区里改 `boundary.reach`，再跑一个按域名连一次的动作）：缺省清单 `err:EAI_AGAIN` · **只并
// `/etc/resolv.conf` 这一条**就 `dns=ok:104.20.23.154` 且 `https=ok:200`（连跑五遍五通）·
// `/etc/hosts` 与 `/etc/nsswitch.conf` **不必要**。所以缺省清单的第六项就是那一条，断言 ② 里因此多了
// 一条正向读数：**要网那一档按域名连得上**；缺省档一个字节没变（这一门命名空间里只有回环，
// `err:EAI_AGAIN` / `err:ENETUNREACH`）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const AGENT = 'round'

/**
 * 子进程里跑的那段探针。四读数：
 *   `dns` 按域名解析一次 · `ip` 直连一个公网地址 · `self` 沙箱里自己起服务端再连它 ·
 *   `hostLoop` 连宿主那个服务端（端口由 `-- HOST_PORT=<端口>` 注入）。
 *
 * **连上就 `destroy`**：留着那个 socket，进程不会自己退出（实测：4 秒的读数拖成 25 秒的超时）。
 */
const PROBE = [
  "import { connect, createServer } from 'node:net'",
  "import { lookup } from 'node:dns'",
  "const conn = (host, port, ms = 4000) => new Promise((res) => {",
  "  const s = connect({ host, port })",
  "  let done = false",
  "  const fin = (v) => { if (!done) { done = true; clearTimeout(t); res(v) } }",
  "  const t = setTimeout(() => { fin('timeout'); s.destroy() }, ms)",
  "  s.on('connect', () => { fin('ok'); s.destroy() })",
  "  s.on('error', (e) => { fin('err:' + e.code); s.destroy() })",
  "})",
  "const dns = await new Promise((res) => lookup('example.com', (e, a) => res(e ? 'err:' + e.code : 'ok:' + a)))",
  "const self = await new Promise((res) => {",
  "  const srv = createServer((s) => { s.on('error', () => {}); s.end('hi') })",
  "  srv.on('error', (e) => res('server-err:' + e.code))",
  "  srv.listen(0, '127.0.0.1', async () => { const got = await conn('127.0.0.1', srv.address().port); srv.close(); res(got) })",
  "})",
  "const hostLoop = await conn('127.0.0.1', Number(process.env.HOST_PORT), 4000)",
  "const ip = await conn('1.1.1.1', 53, 4000)",
  "console.log(JSON.stringify({ dns, self, hostLoop, ip }))",
].join('\n')

interface Readings {
  readonly dns: string
  readonly self: string
  readonly hostLoop: string
  readonly ip: string
}

function fugue(root: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

interface Made {
  readonly root: string
}
const MADE: Made[] = []

/** 一棵仓库 + 两个动作：`netprobe`（缺省：网切掉）与 `netprobe-host`（点名要网）。 */
function fixture(): Made {
  const root = mkdtempSync(join(tmpdir(), 'fugue-y5-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.txt'), 'hi\n')
  writeFileSync(join(root, 'netprobe.mjs'), PROBE)
  const genv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: root, env: genv, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`)
  }
  git('init', '-q', '-b', 'main', '.')
  git('add', '-A')
  git('commit', '-qm', '起点')
  for (const [k, v] of [
    ['actions.netprobe', '{"argv":["node","netprobe.mjs"]}'],
    ['actions.netprobe-host', '{"argv":["node","netprobe.mjs"],"net":"host"}'],
  ]) {
    const r = fugue(root, 'config', 'set', k, v)
    assert.equal(r.code, 0, `config set ${k}：${r.err}`)
  }
  for (const cmd of ['branch', 'fork', 'ensure']) {
    const r = fugue(root, '--agent', AGENT, cmd, cmd === 'ensure' ? '' : 'HEAD')
    assert.equal(r.code, 0, `${cmd}：${r.err}`)
  }
  const made: Made = { root }
  MADE.push(made)
  return made
}

after(() => {
  for (const m of MADE) {
    fugue(m.root, '--agent', AGENT, 'dispose')
    try {
      rmSync(m.root, { recursive: true, force: true })
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', m.root], { encoding: 'utf8' })
    }
  }
})

/** 宿主那一侧的服务端：**两个档连的是同一个靶子**，端口由探针从 `HOST_PORT` 读。 */
async function withHostServer<T>(fn: (port: number) => T | Promise<T>): Promise<T> {
  const srv = createServer((s) => {
    s.on('error', () => {})
    s.end('host-hi\n')
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as AddressInfo).port
  try {
    return await fn(port)
  } finally {
    srv.close()
  }
}

/** 跑一个要网/不要网的动作，把那四读数收回来（探针的 JSON 走子进程的 stdout，落在 CLI 的 stderr 上）。 */
function run(m: Made, action: string, port: number): { code: number; json: Readings; err: string } {
  const r = fugue(m.root, '--agent', AGENT, 'run', action, '--', `HOST_PORT=${port}`)
  assert.equal(r.code, 0, `${action} 退 ${r.code}：${r.err}`)
  const line = r.err
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop()
  assert.ok(line !== undefined, `探针没有打出读数：${r.err}`)
  return { code: r.code, json: JSON.parse(line) as Readings, err: r.err }
}

/** 日志里那两条 `run/confined` 的 `net` 栏，按次序。 */
function confinedNets(root: string): string[] {
  const r = fugue(root, '--json', 'log')
  assert.equal(r.code, 0, r.err)
  return r.out
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { e: { t: string; net?: string } }).e)
    .filter((e) => e.t === 'run/confined')
    .map((e) => String(e.net))
}

test('Y5 ① · 缺省档：DNS 不通 · 直连 IP 不通 · 回环照旧（服务端+客户端一次真连）', async () => {
  await withHostServer((port) => {
    const m = fixture()
    const r = run(m, 'netprobe', port)
    console.log('\n── ① 缺省档（net: none）──\n  ' + JSON.stringify(r.json))
    assert.match(r.json.dns, /^err:/, 'DNS 不通：这一门命名空间里没有出去的路（解析器配置在不在清单里都一样）')
    assert.equal(r.json.ip, 'err:ENETUNREACH', '直连 IP 不通：这一门命名空间里只有回环')
    assert.equal(r.json.self, 'ok', '回环照旧：沙箱里起个服务端、客户端一次真连得上')
    assert.equal(r.json.hostLoop, 'err:ECONNREFUSED', '宿主的回环不是孩子的回环：同一个端口，连不上')
  })
})

test('Y5 ② · 负对照：动作点名要网 → 与宿主同一门命名空间（同一个靶子，两个答案）', async () => {
  await withHostServer((port) => {
    const m = fixture()
    const off = run(m, 'netprobe', port)
    const on = run(m, 'netprobe-host', port)
    console.log('\n── ② 同一个靶子上的两个答案 ──')
    console.log('  缺省档（net: none）：' + JSON.stringify(off.json))
    console.log('  点名要网（net: host）：' + JSON.stringify(on.json))
    assert.equal(off.json.hostLoop, 'err:ECONNREFUSED', '缺省档：那不是宿主的回环')
    assert.equal(on.json.hostLoop, 'ok', '要网那一档连得上同一个端口——那一刀真切在命名空间上')
    assert.equal(on.json.self, 'ok', '回环在要网那一档照旧（它本来就与宿主共用回环）')
    // 公网那一条：**不挑机器**——这一档的读数只要不再是"隔离命名空间里那句 ENETUNREACH"就成立，
    // 真值随这台机器有没有出口（读数印在上面）。
    assert.notEqual(on.json.ip, 'err:ENETUNREACH', '出了那一门隔离的命名空间')
    // **按域名一次真解析**：这是"要网"这条点名兑现的那一半里，缺省清单必须带 `/etc/resolv.conf` 的
    // 全部理由（`/etc/hosts` 与 `/etc/nsswitch.conf` 量下来不必要）。公网那一条读数不挑机器，
    // 这一条挑：它要的是**名字解得开**，而解析器配置就在清单里列着。
    assert.match(on.json.dns, /^ok:/, '要网那一档按域名解得出地址（`/etc/resolv.conf` 在缺省清单里）')
  })
})

test('Y5 ③ · `fugue policy` 与 `run/confined` 如实报这一栏', async () => {
  await withHostServer((port) => {
    const m = fixture()
    const p1 = fugue(m.root, '--agent', AGENT, 'policy', 'netprobe')
    const p2 = fugue(m.root, '--agent', AGENT, 'policy', 'netprobe-host')
    assert.equal(p1.code, 0, p1.err)
    assert.equal(p2.code, 0, p2.err)
    assert.match(p1.out, /网络 none（--unshare-net 把网切掉；回环照旧）/)
    assert.match(p2.out, /网络 host（动作点名要的）/, '点名要网那一档如实报 host')
    // `--json` 那一面同一份值（Y2 的断言是"两处逐字相等"，这里只把它跟行为读数摆在一起）。
    const j1 = JSON.parse(fugue(m.root, '--agent', AGENT, '--json', 'policy', 'netprobe').out) as { net: string }
    const j2 = JSON.parse(fugue(m.root, '--agent', AGENT, '--json', 'policy', 'netprobe-host').out) as { net: string }
    assert.deepEqual([j1.net, j2.net], ['none', 'host'])

    run(m, 'netprobe', port)
    run(m, 'netprobe-host', port)
    assert.deepEqual(confinedNets(m.root), ['none', 'host'], '两趟各自把那一栏写进 run/confined')
  })
})
