// **一份能跑的样例客户端**（0.5.0 · 活文档）。出处：架构 § 9.11 全节（方法面 · 错误码两段 · 事件
// 通道 · 游标每 writer 一个 · 字节走带外）。
//
// 这一份的用处不是"演示一遍"，是**把协议当外部契约消费一遍**：它不 import 这一份代码里的任何
// 模块，只认 stdio 上的 JSON-RPC 2.0 报文——所以它能跑，说明"外部客户端照可跑样例消费同一份
// 协议"这句话量得出来。跑法：
//
//   node tools/sample-client.mjs                 # 自己造一个最小工作区，全套走一遍
//   node tools/sample-client.mjs --root <路径>   # 拿一个已有工作区，只读那几趟
//
// 它做的四件事，每一件都带一条**当场打印的判据**：
//
//   ① 握手：`initialize` 报出协议版本 · 安装版本 · 方法面；不认得的版本当场拒（`-32602` +
//      `data.supported`）——这一条在同一个连接上拿 `_protocol: "9.9"` 再问一次就能看到。
//   ② **两条脸逐字节相同**：`result.stdout` 是那条命令 `--json` 面的字节（含末尾换行），
//      同一趟调用另跑一次同一条命令的 `--json` 面（`fugue --json <命令>`），两串必须相等。
//   ③ 事件通道：`watch` 一趟回一趟事——响应里带这一趟读到的事件与下一趟要用的游标
//      （`result.result.resume`），拿它接着问下一趟，读到的就是严格之后的那些。
//   ④ 错误两段：方法面/参数不成立是 `-32602`（用法错 · 退出码 2），调用成立而事情没成是
//      `-32000`（失败 · 退出码 1）——两个都当场各撞一次。
//
// **不做的事**：这一份不发 `write`。载荷字节走带外（§ 9.11「字节走带外」那一段）：`write` 从
// stdin 收字节，而 serve 的 stdin 上跑的就是这条 JSON-RPC 通道——今天的方法面只到元数据那一条边。
// 要写字节：用 CLI 的 `fugue write`（或 `--from`），或者按将来那条内容寻址引用的形状走。
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli', 'fugue.ts')
const PROTOCOL = '0.1'

/** 一条 git 命令（全局与系统配置都不读，作者身份钉住——与别的夹具同一套环境）。 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
  GIT_AUTHOR_DATE: '2026-02-01T00:00:00+0000',
  GIT_COMMITTER_DATE: '2026-02-01T00:00:00+0000',
}

/**
 * 一个最小工作区：真对象库（真源是既有的 git 对象库，§ 9.1）· 一次提交 · 一条账。
 *
 * 账里那条事件走**产品那条路**落（`fugue commit -m`），不是手抄一份 JSON——手抄的话这一份量的
 * 是"我抄得对不对"，而它要量的是"这条路读不读得到账上的东西"。
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fugue-sample-'))
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV })
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`)
  }
  git('init', '-q', '-b', 'main', '.')
  writeFileSync(join(root, 'README.md'), '底\n')
  git('add', '-A')
  git('commit', '-qm', '底')
  const first = spawnSync(process.execPath, [CLI, '--root', root, 'commit', '-m', '样例那一笔'], {
    encoding: 'utf8',
    env: GIT_ENV,
  })
  assert.equal(first.status, 0, `落一笔账：${first.stderr}`)
  return root
}

/** 一条 serve：stdio 上一行一调用（§ 9.11）。这一份只认报文，不 import 那一侧的任何模块。 */
async function serve(root) {
  const child = spawn(process.execPath, [CLI, '--root', root, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let stderr = ''
  const waiting = new Map()
  let id = 0
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) {
      if (line.trim() === '') continue
      const msg = JSON.parse(line)
      const done = waiting.get(msg.id)
      if (done === undefined) throw new Error(`回执的 id 对不上任何一次调用：${line.slice(0, 120)}`)
      waiting.delete(msg.id)
      done(msg)
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const ask = (method, params = {}, protocol = PROTOCOL) =>
    new Promise((done, fail) => {
      id += 1
      const mine = id
      waiting.set(mine, done)
      child.on('close', (code) => {
        if (waiting.delete(mine)) fail(new Error(`serve 退了（${code ?? '?'}）：${stderr.trim()}`))
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params: { _protocol: protocol, ...params } }) + '\n')
    })
  return {
    ask,
    async close() {
      try {
        await ask('shutdown')
      } catch {
        /* 那一头已经不在了 */
      }
      child.stdin.end()
    },
  }
}

/** 成功那一趟的 `result`；失败当场把错误码与正文抛出来（这一份的每一趟都要看得见结果）。 */
async function call(conn, method, params = {}) {
  const msg = await conn.ask(method, params)
  if (msg.error !== undefined) return { error: msg.error }
  return { result: msg.result }
}

/** `result.stdout` 的字节**不含**末尾那个换行也比得上：两边都留着或都去掉。 */
const strip = (s) => (s.endsWith('\n') ? s.slice(0, -1) : s)

const lines = []
const say = (s) => {
  lines.push(s)
  process.stdout.write(s + '\n')
}

const root = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : fixture()
const mine = !process.argv.includes('--root')
const conn = await serve(root)
try {
  // ── ① 握手 ────────────────────────────────────────────────────────────────
  const init = await call(conn, 'initialize')
  assert.equal(init.error, undefined, `握手该成：${JSON.stringify(init.error)}`)
  const hello = init.result
  assert.equal(hello.protocol, PROTOCOL, `协议版本该是 ${PROTOCOL}：${hello.protocol}`)
  assert.ok(hello.methods.includes('watch'), '方法面里该有 watch')
  assert.ok(hello.methods.includes('round.new'), '§ 9.6 的二级命令该折成 `round.new` 那种方法名')
  say(`① 握手：协议 ${hello.protocol} · 安装 ${hello.product} · 方法面 ${hello.methods.length} 条`)

  const refused = await call(conn, 'initialize', { _protocol: '9.9' })
  assert.equal(refused.error?.code, -32602, '不认得的版本该拒 -32602')
  assert.deepEqual(refused.error?.data?.supported, [PROTOCOL], 'data.supported 该报出服务端支持的那一版')
  say(`   版本拒：-32602 · supported=${JSON.stringify(refused.error.data.supported)}`)

  // ── ② 两条脸逐字节相同 ────────────────────────────────────────────────────
  const viaServe = await call(conn, 'log')
  assert.equal(viaServe.error, undefined, `log 那一趟该成：${JSON.stringify(viaServe.error)}`)
  assert.equal(viaServe.result.via, 'value', '迁移过的命令该进程内跑（`via` 那一栏看得见）')
  const cliFace = spawnSync(process.execPath, [CLI, '--root', root, '--json', 'log'], { encoding: 'utf8', env: GIT_ENV })
  assert.equal(cliFace.status, 0, `CLI 那一趟该成：${cliFace.stderr}`)
  assert.equal(viaServe.result.stdout, cliFace.stdout, 'serve 的 result.stdout 与 CLI 的 --json 面该逐字节相同')
  assert.ok(strip(viaServe.result.stdout).length > 0, '这一趟该真读到账上的行（不然上面那句是空话）')
  const rows = strip(viaServe.result.stdout).split('\n').map((l) => JSON.parse(l))
  assert.ok(rows.every((r) => r.pos !== undefined && r.e !== undefined), '每一行该是 {pos,e}')
  say(`② 两条脸：${rows.length} 行 · 与 \`fugue --json log\` 逐字节相同 · via=${viaServe.result.via}`)

  // ── ③ 事件通道：一趟回一趟事 · 游标接着问 ─────────────────────────────────
  const first = await call(conn, 'watch')
  assert.equal(first.error, undefined, `watch 那一趟该成：${JSON.stringify(first.error)}`)
  const cursor = first.result.result.resume
  assert.ok(first.result.result.events.length > 0, '首趟该读到账上已有的那些事件')
  const again = await call(conn, 'watch', { resume: cursor })
  assert.equal(again.result.result.events.length, 0, '拿着刚给的游标再问一趟，该一条都不剩（排他下界）')
  say(`③ 事件通道：首趟 ${first.result.result.events.length} 条 · resume=${JSON.stringify(cursor)} · 再问一趟 0 条`)

  // ── ④ 错误两段 ────────────────────────────────────────────────────────────
  const badParam = await call(conn, 'log', { 没有这个开关: 1 })
  assert.equal(badParam.error?.code, -32602, '表外的参数名该拒 -32602（这条调用本身不成立）')
  const badMethod = await call(conn, '没有这个方法')
  assert.equal(badMethod.error?.code, -32601, '没有的方法该拒 -32601')
  const notMine = await call(conn, 'read', { args: ['没有这一条路径'] })
  assert.equal(notMine.error?.code, -32000, '调用成立而事情没成该是 -32000（实现段）')
  say(`④ 错误两段：参数不成立 -32602 · 方法不存在 -32601 · 命令失败 -32000（"${notMine.error.message.slice(0, 40)}…"）`)

  say(`\n全套走通 · 工作区 ${root}${mine ? '（这一趟自己造的，退出时删）' : ''}`)
} finally {
  await conn.close()
  if (mine) rmSync(root, { recursive: true, force: true })
}
