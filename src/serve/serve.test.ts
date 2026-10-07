// serve 骨架的**断言**。出处：施工单 § 五 ②③④ 与 § 三 5 那几条点名断言。
//
// 这一份盯六件事：
//
//   ① **两面 result 逐字节相同**——同一条命令经 CLI（`fugue <cmd> --json`）与经 serve（一条
//      JSON-RPC 调用）的 `result.stdout` 逐字节相同；
//   ② **方法面从 `FLAGS_OF` 派生**——方法名集合与那张表派生出来的逐条相同（入口不出方法名）；
//   ③ **版本协商**——不认得的版本明确拒 + `data.supported`；
//   ④ **三档死法各有形状**——干净断开走收尾 · `shutdown` 只停止接受新请求（不伪造成功）·
//      `kill -9` 之后锁留盘、下一条命令按 § 9.2 既有判据接管、重启后同一问询回执逐字节不变；
//   ⑤ **退化档真的被走到**——值层没迁的那些命令走子进程 `fugue <cmd> --json`，`via` 是
//      `subprocess`，`stdout` 与 CLI 逐字节相同；
//   ⑥ **`--wait` 糖**——等到了报等到了 · 到点如实报超时（不静默成功）。
//
// **它不测 TUI · 外观 · attach/pause/step**（0.4.3 的活，施工单 § 三 7）。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { stdinOf, runCli } from '../../test/helpers/run-cli.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { FLAGS_OF } from '../cli/flags.ts'
import { PROTOCOL_VERSION } from '../protocol.ts'
import { ENTRY_KEYS, methodOf } from '../value/registry.ts'
import { openLog } from '../log/log.ts'
import { IDLE_MS, methodSurface, serveConnection } from './connect.ts'
import type { StatusRow } from '../probe/status.ts'
import { createRootTail, posKey } from './tail.ts'
import type { TailReader } from './tail.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const HOLDER = fileURLToPath(new URL('../../test/golden/hold.mjs', import.meta.url))
/** 产品的安装版本（`serveCmd` 从 package.json 读同一份）——断言里对着它比。 */
const PRODUCT = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}).version

export interface Root {
  readonly dir: string
  readonly sys: string
}

/** 一个一次性工作区：git 仓 + 三条命令摆出来的账（提交号因此是同一个）。 */
async function makeRoot(): Promise<Root> {
  const dir = tmpDir('fugue-serve-')
  const sys = join(dir, '.syshome')
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: dir }).status, 0)
  const w1 = await runCli(['--root', dir, 'write', 'a.txt', '--stdin'], stdinOf('alpha\n'))
  assert.equal(w1.code, 0, w1.stderr)
  const w2 = await runCli(['--root', dir, 'write', 'b.txt', '--stdin'], stdinOf('beta\n'))
  assert.equal(w2.code, 0, w2.stderr)
  const c = await runCli(['--root', dir, 'commit', '-m', '第一版'])
  assert.equal(c.code, 0, c.stderr)
  return { dir, sys }
}

/** serve 的上游：把几行请求喂进去，把回执收回来。走的是**真的连接那一份**（不起子进程）。 */
async function serveLines(root: Root, lines: readonly string[], idleMs = 0): Promise<string[]> {
  const input = new PassThrough()
  const out: string[] = []
  const done = serveConnection({
    input,
    output: { write: (s: string) => out.push(s) },
    cli: CLI,
    root: root.dir,
    idleMs,
    product: PRODUCT,
  })
  for (const l of lines) input.write(l + '\n')
  input.end()
  await done
  return out
}

/** 一条请求（**每一次调用都带 `_protocol`**：版本住在调用上，不住在会话上）。 */
function ask(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params: { _protocol: PROTOCOL_VERSION, ...params } })
}

const parse = (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>

/** 数「全量走了几遍」的读源（包着真账本）：**不做时长断言**。 */
function countingReader(
  root: string,
  onRow?: (row: StatusRow) => void,
): { reader: TailReader; walks: () => number } {
  const log = openLog(root)
  let walks = 0
  const reader: TailReader = {
    async *readMerged(fromSeq = 0) {
      walks++
      for await (const row of log.readMerged(fromSeq)) {
        onRow?.(row)
        yield row
      }
    },
  }
  return { reader, walks: () => walks }
}

/** 拿一条连接问一次 `watch`，只要那一趟的 `result.stdout`（弃掉重建那条断言用它）。 */
async function serveWithTail(root: Root, reader: TailReader, cursor: string): Promise<string> {
  const input = new PassThrough()
  const out: string[] = []
  const done = serveConnection({
    input,
    output: { write: (s: string) => out.push(s) },
    cli: CLI,
    root: root.dir,
    idleMs: 0,
    product: PRODUCT,
    tailFactory: () => createRootTail(root.dir, { reader }),
  })
  input.write(ask(1, 'watch', { resume: cursor }) + '\n')
  input.end()
  await done
  const reply = parse(out[0] ?? '{}')
  return resultOf(reply).stdout
}
const resultOf = (r: Record<string, unknown>): { stdout: string; via: string } =>
  r.result as { stdout: string; via: string }
const errorOf = (r: Record<string, unknown>): { code: number; message: string; data?: Record<string, unknown> } =>
  r.error as { code: number; message: string; data?: Record<string, unknown> }

test('① 两面 result 逐字节相同：同一条命令经 CLI 与经 serve', async () => {
  const root = await makeRoot()
  const cases: readonly { method: string; params: Record<string, unknown>; cli: string[]; via: string }[] = [
    { method: 'status', params: {}, cli: ['status'], via: 'value' },
    { method: 'list', params: {}, cli: ['list'], via: 'value' },
    { method: 'stat', params: { args: ['a.txt'] }, cli: ['stat', 'a.txt'], via: 'value' },
    { method: 'read', params: { args: ['a.txt'] }, cli: ['read', 'a.txt'], via: 'value' },
    { method: 'revs', params: {}, cli: ['revs'], via: 'value' },
    { method: 'log', params: {}, cli: ['log'], via: 'value' },
    { method: 'watch', params: {}, cli: ['watch'], via: 'value' },
    { method: 'diff-stat', params: {}, cli: ['diff-stat'], via: 'subprocess' }, // 值层没迁：退化档
  ]
  // `diff-stat` 要一棵铺出来的树：现场先提交一次（拿提交号）再 `fork`
  const cm = await runCli(['--root', root.dir, '--json', 'commit', '-m', '铺之前这一份'])
  const head = (JSON.parse(cm.stdout) as { commit: string }).commit
  const fork = await runCli(['--root', root.dir, 'fork', head, '--strategy', 'copy'])
  assert.equal(fork.code, 0, fork.stderr)
  const replies = (await serveLines(root, cases.map((c, i) => ask(i + 1, c.method, c.params)))).map(parse)
  assert.equal(replies.length, cases.length)
  for (const [i, c] of cases.entries()) {
    const got = resultOf(replies[i])
    const cli = await runCli(['--root', root.dir, '--json', ...c.cli])
    assert.equal(cli.code, 0, `CLI ${c.cli.join(' ')}：${cli.stderr}`)
    assert.equal(got.stdout, cli.stdout, `${c.method}：serve 的 result.stdout 与 CLI 的 --json 面不同`)
    assert.equal(got.via, c.via, `${c.method} 的 via 不对`)
  }
  const value = cases.filter((c) => c.via === 'value').length
  console.log(`① 读数：${cases.length} 条命令两面逐字节相同（${value} 条走值层 · ${cases.length - value} 条走子进程顶班）`)
})

test('① 事件通道：一趟调用一趟事，回执带得出下一趟要用的游标（§ 9.11）', async () => {
  const root = await makeRoot()
  const first = (await serveLines(root, [ask(1, 'watch')])).map(parse)[0]
  const v1 = resultOf(first) as unknown as { result: { resume: string; events: unknown[]; cursors: Record<string, number> } }
  assert.ok(v1.result.resume !== undefined, '回执里要带 next cursor')
  assert.equal(v1.result.resume, 'round:3', '游标串沿用 `--resume` 的串形（writer:seq）')
  const second = (await serveLines(root, [ask(1, 'watch', { resume: v1.result.resume })])).map(parse)[0]
  const v2 = resultOf(second) as unknown as { result: { events: unknown[] }; stdout: string }
  assert.equal(v2.result.events.length, 0, '接着问的那一趟没有新事件')
  assert.equal(v2.stdout, '', '没有新事件时 stdout 一个字节都不写')
  // 账往前动一条：同一个游标再问，只多出那一条（**游标是排他下界**）
  const w = await runCli(['--root', root.dir, 'write', 'c.txt', '--stdin'], stdinOf('c\n'))
  assert.equal(w.code, 0, w.stderr)
  const third = (await serveLines(root, [ask(1, 'watch', { resume: v1.result.resume })])).map(parse)[0]
  const v3 = resultOf(third) as unknown as { result: { events: { pos: { writer: string; seq: number } }[]; resume: string } }
  assert.equal(v3.result.events.length, 1, '只多那一条')
  assert.equal(v3.result.events[0]?.pos.seq, 4)
  assert.equal(v3.result.resume, 'round:4')
  console.log("① 读数：watch 回执带游标 round:3；接着问 0 条；账动一条之后同游标只多那一条（round:4）")
})


test('③ 按根的尾部索引：弃掉重建之后，同一个游标问出来的字节逐字节相同', async () => {
  const root = await makeRoot()
  const { reader, walks } = countingReader(root.dir)
  const cursor = 'round:2'
  const one = await serveWithTail(root, reader, cursor)
  const first = walks()
  // **弃掉重建**：换一条连接（新的一份尾部索引，从零走一遍），同一个游标再问
  const two = await serveWithTail(root, reader, cursor)
  assert.equal(two, one, '弃掉重建之后同一个游标的答案逐字节相同')
  assert.ok(walks() > first, '重建那一份确实从零走过一遍（不是复用了上一份）')
  console.log(
    `③ 读数：游标 ${cursor} → 第一份 ${JSON.stringify(one.slice(0, 60))}… · ` +
      `重建那一份逐字节相同（全量共走 ${walks()} 遍：一份一遍）`,
  )
})
test('② 方法面从 `FLAGS_OF` 派生：方法名集合逐条相同，入口不出方法名', () => {
  const derived = Object.keys(FLAGS_OF)
    .filter((k) => !ENTRY_KEYS.includes(k))
    .map(methodOf)
    .sort()
  const surface = methodSurface()
    .map((m) => m.method)
    .sort()
  assert.deepEqual(surface, derived, '方法面与 `FLAGS_OF` 派生出来的那一份逐条相同')
  for (const e of ENTRY_KEYS) {
    assert.ok(!surface.includes(methodOf(e)), `${e} 是入口，不该有方法名`)
  }
  console.log(
    `② 读数：方法面 ${surface.length} 条（命令面 ${Object.keys(FLAGS_OF).length} 个键，入口 ${ENTRY_KEYS.length} 个）`,
  )
})

test('③ 按根的尾部索引：一条连接一份 · 读过的行不重复收 · 弃掉重建逐字节相同', async () => {
  const root = await makeRoot()
  const input = new PassThrough()
  const out: string[] = []
  const { reader, walks } = countingReader(root.dir)
  let built = 0
  const done = serveConnection({
    input,
    output: { write: (s: string) => out.push(s) },
    cli: CLI,
    root: root.dir,
    idleMs: 0,
    product: PRODUCT,
    tailFactory: () => {
      built++
      return createRootTail(root.dir, { reader })
    },
  })
  // 一 · **同一个 tick 上发四条**：连接把调用串成一条（**回执按调用序归位**，批准过的那一
  // 句），所以四条各推一趟；但**按根只有一份索引**——四条问共用它，收过的行不重复收。
  // （同一 tick 上把并发合并在一次在飞的扫描上，是 `tail.ts` 的模块级性质，`tail.test.ts` ① 量它。）
  input.write([ask(1, 'watch'), ask(2, 'watch'), ask(3, 'watch'), ask(4, 'watch')].join('\n') + '\n')
  for (let i = 0; i < 400 && out.length < 4; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(out.length, 4, '四条都要有回执')
  assert.equal(built, 1, `按根该只建一份尾部索引，实际 ${built} 份`)
  assert.equal(walks(), 4, `一次一条：四条问各推一趟，实际 ${walks()} 遍`)
  const one = resultOf(parse(out[0])) as unknown as { result: { resume: string; events: unknown[] }; stdout: string }
  assert.equal(one.result.events.length, 3, '第一条问拿到账上那三条')
  for (const i of [1, 2, 3]) {
    assert.equal(resultOf(parse(out[i])).stdout, one.stdout, '同一次扫描的四条问答案逐字节相同')
  }
  // 二 · **一条一条问**：每一条推一趟（各自走一遍全量），而**那份索引与读过的行是同一份**——
  // 收过的行不会再收一遍（`seenSeq` 里一个坐标只出现一次）。
  // 第五条：**等到这一条的回执再发下一条**——两条真的不是"同时"的
  input.write(ask(5, 'watch', { resume: one.result.resume }) + '\n')
  for (let i = 0; i < 400 && out.length < 5; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(walks(), 5, '第五条再推一趟')
  input.write(ask(6, 'watch', { resume: one.result.resume }) + '\n')
  for (let i = 0; i < 400 && out.length < 6; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(walks(), 6, '第六条再推一趟')
  const v6 = resultOf(parse(out[5])) as unknown as { result: { events: unknown[] }; stdout: string }
  assert.equal(v6.result.events.length, 0, '按同一份游标再问：0 条')
  assert.equal(v6.stdout, '', '0 条时 stdout 一个字节都不写')
  // 三 · 账往前动一条：同一条连接再问一次——**那一份索引里已经有前三条**，这一趟只多新的那条
  const w = await runCli(['--root', root.dir, 'write', 'c.txt', '--stdin'], stdinOf('c\n'))
  assert.equal(w.code, 0, w.stderr)
  input.write(ask(7, 'watch', { resume: one.result.resume }) + '\n')
  for (let i = 0; i < 400 && out.length < 7; i++) await new Promise((r) => setTimeout(r, 5))
  const v7 = resultOf(parse(out[6])) as unknown as { result: { events: { pos: { seq: number } }[] } }
  assert.equal(v7.result.events.length, 1, '只多那一条')
  assert.equal(v7.result.events[0]?.pos.seq, 4)
  input.write(ask(8, 'watch') + '\n')
  for (let i = 0; i < 400 && out.length < 8; i++) await new Promise((r) => setTimeout(r, 5))
  input.end()
  await done
  const all = resultOf(parse(out[7])) as unknown as {
    result: { events: { pos: { writer: string; seq: number } }[] }
  }
  const keys = all.result.events.map((e) => posKey(e.pos as never))
  assert.equal(keys.length, 4, '收尾那一趟带零游标问：账上四条事件，一条不少')
  assert.equal(new Set(keys).size, keys.length, `同一份索引把行收重了：${keys.join(',')}`)
  console.log(
    `③ 读数：一条连接一份尾部索引（建了 ${built} 份）· 八条问各推一趟（全量共走 ${walks()} 遍）· ` +
      `收尾带零游标问 ${keys.length} 条（${keys.join(' · ')}，一条一个不重不漏）`,
  )
})
test('③ 版本协商：不认得的版本明确拒 + `data.supported` 报出支持的列表', async () => {
  const root = await makeRoot()
  const idleMsOfTest = 0
  const replies = (
    await serveLines(root, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { _protocol: '9.9' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'status', params: {} }), // 连 _protocol 都没给
      ask(3, 'initialize'),
    ], idleMsOfTest)
  ).map(parse)
  for (const r of [replies[0], replies[1]]) {
    const err = errorOf(r)
    assert.equal(err.code, -32602)
    assert.deepEqual(err.data?.supported, [PROTOCOL_VERSION])
  }
  const ok = replies[2].result as { protocol: string; methods: string[]; idleMs: number; product: string }
  assert.equal(ok.protocol, PROTOCOL_VERSION)
  assert.ok(ok.methods.length >= 25, `方法面回执里要列出全部方法（拿到 ${ok.methods.length} 条）`)
  assert.equal(ok.idleMs, idleMsOfTest, '闲时阈值报给客户端（与这一次给的一致）')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
  assert.equal(ok.product, pkg.version, '安装版本报给客户端（与 package.json 同一处）')
  console.log(
    `③ 读数：版本拒两档都是 -32602 + supported=[${PROTOCOL_VERSION}]；initialize 报出 ${ok.methods.length} 条方法 · 闲时 ${ok.idleMs} ms · 版本 ${ok.product}`,
  )
})

test('④ 干净断开走收尾：读口一结束，连接就收（不多读一个字节）', async () => {
  const root = await makeRoot()
  const replies = await serveLines(root, [ask(1, 'revs')])
  assert.equal(replies.length, 1)
  const after = await serveLines(root, [ask(1, 'revs')])
  assert.equal(after.length, 1)
  console.log('④ 读数：断开即收尾，回执一条不多')
})

test('④ `shutdown` 只停止接受新请求——不伪造成功', async () => {
  const root = await makeRoot()
  const replies = (
    await serveLines(root, [ask(1, 'shutdown'), ask(2, 'status'), ask(3, 'list')])
  ).map(parse)
  assert.deepEqual(replies[0].result, { stopping: true })
  for (const r of [replies[1], replies[2]]) {
    const err = errorOf(r)
    assert.equal(err.code, -32600)
    assert.match(err.message, /不再接受新请求/)
  }
  console.log('④ 读数：shutdown 之后两条调用各回 -32600（不是成功，也不是静默丢掉）')
})

test('④ 闲时自退：到点自己走（onClose 被调到）', async () => {
  const root = await makeRoot()
  const input = new PassThrough()
  let closedAt = 0
  const t0 = Date.now()
  const done = serveConnection({
    input,
    output: { write: () => undefined },
    cli: CLI,
    root: root.dir,
    idleMs: 150,
    onClose: () => {
      closedAt = Date.now() - t0
      // **产品里那一条就是这个形状**（`serveCmd` 的 `close`）：收尾要把读口收掉，
      // 不然 `for await` 那一圈还在等人说话，连接谈不上「自己走」。`end()` 而不是
      // `destroy()`：后者会让那一圈抛 `ERR_STREAM_PREMATURE_CLOSE`。
      input.end()
    },
  })
  await Promise.race([
    done,
    new Promise((_r, reject) => setTimeout(() => reject(new Error('闲时没有自退：等了 3 秒')), 3000)),
  ])
  assert.ok(closedAt >= 100, `自退发生得太早：${closedAt} ms`)
  input.destroy()
  console.log(`④ 读数：闲时阈值 150 ms → 实际自退在 ${closedAt} ms`)
})

test('④ 闲时自退（端到端）：stdin 开着、一条请求都不给 → 它自己退，退出码 0', async () => {
  const root = await makeRoot()
  const child = spawn(process.execPath, [CLI, '--root', root.dir, 'serve', '--idle-ms', '200'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ""
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")))
  const t0 = Date.now()
  const code = await new Promise<number | null>((done) => {
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      done(null)
    }, 4000)
    child.on('close', (c) => {
      clearTimeout(killer)
      done(c)
    })
  })
  const dt = Date.now() - t0
  assert.equal(code, 0, `闲时自退要退 0（拿到 ${code}）：${stderr}`)
  assert.ok(dt < 3500, `退得太慢：${dt} ms`)
  console.log(`④ 读数：stdin 开着不给请求 → ${dt} ms 自己退（退出码 0）`)
})

test('④ `kill -9`：锁留盘 · 下一条命令按既有判据接管 · 重启后同一问询逐字节不变', async () => {
  const root = await makeRoot()
  const ready = join(root.dir, '.holder.json')
  const holder = spawn(process.execPath, [HOLDER, root.dir, 'round', ready], {
    env: { ...process.env, FUGUE_SYSTEM_DIR: root.sys },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50))
  assert.ok(existsSync(ready), '持锁的那一支没起来')
  const info = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; path: string }
  assert.ok(existsSync(info.path), `锁文件要在盘上：${info.path}`)
  // 杀它（**信号 9：什么都不清理**）
  process.kill(info.pid, 'SIGKILL')
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(info.pid, 0)
      await new Promise((r) => setTimeout(r, 20))
    } catch {
      break
    }
  }
  assert.ok(existsSync(info.path), 'kill -9 之后锁要留在盘上（什么都不清理）')
  void holder
  // 下一条命令按既有判据接管：同一问询的回执从账派生，serve 无记忆
  const beforeLines = await serveLines(root, [ask(1, 'status')])
  const before = parse(beforeLines[0] ?? '')
  const afterCli = await runCli(['--root', root.dir, '--json', 'status'])
  assert.equal(resultOf(before).stdout, afterCli.stdout)
  const againLines = await serveLines(root, [ask(1, 'status')])
  const again = parse(againLines[0] ?? '')
  // **整行逐字节**（不是只按对象比）：这条断言抓的是「谁把内存态漏进了回执」——按对象比会
  // 放过"只在某一栏上不同"的那些回执。
  assert.equal(againLines[0], beforeLines[0], '重启之后同一问询的回执整行逐字节不变')
  assert.deepEqual(again, before, '按对象也比一遍')
  // 写一条：kill -9 留下的锁由既有判据（pid 不在 · 进程起始时刻 · boot id）接管
  process.env.FUGUE_SYSTEM_DIR = root.sys
  let w
  try {
    w = await runCli(['--root', root.dir, '--json', 'write', 'c.txt', '--stdin'], stdinOf('gamma\n'))
  } finally {
    delete process.env.FUGUE_SYSTEM_DIR
  }
  assert.equal(w.code, 0, `接管失败：${w.stderr}`)
  console.log('④ 读数：kill -9 之后锁留盘 · 同一条 status 回执逐字节不变 · 下一条写命令照常接管')
})

test('⑤ 退化档真的被走到：值层没迁的命令经子进程顶班，`via` 是 subprocess', async () => {
  const root = await makeRoot()
  const replies = (await serveLines(root, [ask(1, 'branch', { args: ['nope'] }), ask(2, 'doctor')])).map(parse)
  assert.ok(replies[0].error !== undefined, 'branch nope 应当失败')
  const ok = resultOf(replies[1])
  assert.equal(ok.via, 'subprocess', 'doctor 是退化档')
  const cli = await runCli(['--root', root.dir, '--json', 'doctor'])
  assert.equal(ok.stdout, cli.stdout, '退化档的 stdout 与 CLI 逐字节相同')
  console.log('⑤ 读数：doctor 走子进程顶班，stdout 与 CLI 逐字节相同（via=subprocess）')
})

test('未知方法 · 参数错 · 解析错 · 命令失败：四条各自的错误码（§ 9.11 那张表）', async () => {
  const root = await makeRoot()
  const replies = (
    await serveLines(root, [
      ask(1, 'nope'),
      ask(2, 'status', { bogus: true }),
      'not json at all',
      ask(4, 'read', { args: ['missing.txt'] }),
    ])
  ).map(parse)
  assert.equal(errorOf(replies[0]).code, -32601)
  assert.equal(errorOf(replies[1]).code, -32602)
  assert.equal(errorOf(replies[2]).code, -32700)
  assert.equal(errorOf(replies[3]).code, -32000)
  console.log('读数：未知方法 -32601 · 参数错 -32602 · 解析错 -32700 · 命令失败 -32000')
})

test('写命令经 serve：按请求开、按请求关（失败之后锁不在盘上）', async () => {
  const root = await makeRoot()
  const replies = (await serveLines(root, [ask(1, 'write', { args: ['c.txt'] })])).map(parse)
  // `write` 要 `--stdin` 的正文，而报文里没有 stdin 的位置：这一条**失败**，但失败得对
  // （不静默写一个空文件，也不留一把没放的锁）。
  assert.ok(replies[0].error !== undefined)
  const lock = join(root.dir, '.fugue', 'log', 'round.lock')
  assert.ok(!existsSync(lock), '按请求开、按请求关：失败之后锁不该留在盘上')
  console.log('读数：经 serve 的写命令失败之后锁不在盘上（按请求开 · 按请求关）')
})

test('半行不算一行：回执一行一条', async () => {
  const root = await makeRoot()
  const input = new PassThrough()
  const out: string[] = []
  const done = serveConnection({
    input,
    output: { write: (s: string) => out.push(s) },
    cli: CLI,
    root: root.dir,
    idleMs: 0,
  })
  const req = ask(1, 'revs')
  input.write(req.slice(0, 10))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(out.length, 0, '半行不算一行')
  input.write(req.slice(10) + '\n')
  input.end()
  await done
  assert.equal(out.length, 1)
  console.log('读数：半行不算一行；一条回执一行')
})

test('⑥ `--wait` 糖：等到了报等到了 · 到点如实报超时（不静默成功）', async () => {
  const root = await makeRoot()
  // `--wait` 认的是**轮次那条链**上的状态（`round/state`）：先给它落一条（`round new` 的
  // 第一步就是 `Idle`），再从 `status` 回执里把那个名字取出来。
  const cfg = await runCli(['--root', root.dir, 'config', 'set', 'round.split',
    '[{"goal":"edit a.txt","ownedPaths":["a.txt"],"assertions":[{"action":"build","name":"ok"}]}]'])
  assert.equal(cfg.code, 0, cfg.stderr)
  const made = await runCli(['--root', root.dir, 'round', 'new', 'edit a.txt'])
  assert.equal(made.code, 0, made.stderr)
  const now = await runCli(['--root', root.dir, '--json', 'status'])
  const snap = JSON.parse(now.stdout) as { snapshot: { rounds: { state: string }[] } }
  const target = snap.snapshot.rounds[0]?.state ?? ''
  assert.notEqual(target, '', '账上应当有一条轮次链（`round/state`）')
  const hit = await runCli(['--root', root.dir, '--json', 'status', '--wait', target, '--timeout', '5'])
  assert.equal(hit.code, 0, hit.stderr)
  const v = JSON.parse(hit.stdout) as { waited: boolean; wait: string; timeoutS: number }
  assert.equal(v.waited, true)
  assert.equal(v.wait, target)
  assert.equal(v.timeoutS, 5)
  const t0 = Date.now()
  const miss = await runCli(['--root', root.dir, '--json', 'status', '--wait', 'Merging', '--timeout', '1'])
  const dt = Date.now() - t0
  assert.equal(miss.code, 1, '超时要退 1')
  assert.match(miss.stderr, /等到点也没等到 Merging/)
  assert.ok(dt >= 900, `等的时间太短（${dt} ms）——它没等到点上`)
  assert.equal(miss.stdout, '', '超时那一趟 stdout 一个字节都不写')
  console.log(`⑥ 读数：--wait ${target} 等到（code 0）· --wait Merging --timeout 1 到点报超时（code 1 · 等了 ${dt} ms）`)
})
