// **最小样例客户端**（0.4.2 站 · 验收件 · **活文档**）。出处：施工单 § 五 ⑥——「住 `tools/`
// （取证件，不进产品命令面）：走通 **status** 与**事件尾随**（一趟调用一趟事 · 游标串沿用
// `--resume` 串形 · 事件形状可对 `events.schema.json` 核）」。
//
// 走法（**它自己起 serve、自己收**——「不引守护进程」在这一份上就是「客户端持有那个进程」）：
//
//   node tools/sample-client.mjs [--root <dir>] [--follow]
//
// 它做四件事，每件都印给人看：
//
//   ① **握手**：发一次 `initialize`，把服务端报的协议版本 · 安装版本 · 闲时阈值 · 方法面印出来；
//   ② **一次读**：`status`（`result.stdout` 就是 `fugue status --json` 那一串字节——**一行一调用**）；
//   ③ **事件尾随**：`watch` 一趟一趟地问，游标是**每一趟带回来的那一串**（`writer:seq,…`，与
//      `fugue watch --follow` 退出时印的那一串同形）——`--follow` 给了就接着问到 Ctrl-C；
//   ④ **收尾**：`shutdown`（服务端只停止接受新请求），然后关掉 stdin——**命绑客户端**：这一头一
//      走，serve 那边就收（闲时也会自退）。
//
// 事件形状怎么核：每一趟回来的是 `result.stdout`（NDJSON，一行一个 `{pos,e}`）；把它按行
// `JSON.parse` 之后，`e` 那一栏就是账上那条事件本身（字段名对 `src/log/events.schema.json` 那一份
// 契约件）。这一份不引依赖、不做第二份形状表——**核形状要用那一份**，不在这里再抄一张。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const PROTOCOL = '0.1'
const CLI = fileURLToPath(new URL('../src/cli/fugue.ts', import.meta.url))

function argOf(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

const root = resolve(argOf('--root', process.cwd()))
const follow = process.argv.includes('--follow')

/** 一行一调用：发出去的是**一行** JSON-RPC 报文。 */
function line(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params: { _protocol: PROTOCOL, ...params } }) + '\n'
}

function main() {
  const child = spawn(process.execPath, [CLI, '--root', root, 'serve'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let buf = ''
  /** 收下的回执按 `id` 配对（基范：批量回可以任意次序）。 */
  const waiting = new Map()
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const raw of parts) {
      if (raw.trim() === '') continue
      const msg = JSON.parse(raw)
      const done = waiting.get(msg.id)
      if (done === undefined) {
        process.stderr.write(`样例客户端：收到一条没人等的回执 id=${String(msg.id)}\n`)
        continue
      }
      waiting.delete(msg.id)
      done(msg)
    }
  })
  let nextId = 1
  const ask = (method, params = {}) =>
    new Promise((done) => {
      const id = nextId++
      waiting.set(id, done)
      child.stdin.write(line(id, method, params))
    })

  const finish = (code) => {
    // **收尾**：`shutdown` 只停止接受新请求；真正结束靠关掉 stdin（命绑客户端）。
    try {
      child.stdin.end()
    } catch {
      /* 已经关了 */
    }
    child.on('close', () => process.exit(code))
    setTimeout(() => {
      child.kill('SIGKILL')
      process.exit(code)
    }, 1000).unref()
  }

  ;(async () => {
    // ① 握手
    const init = await ask('initialize')
    if (init.error !== undefined) {
      process.stderr.write(`握手失败：${JSON.stringify(init.error)}\n`)
      finish(1)
      return
    }
    const { protocol, product, idleMs, methods } = init.result
    process.stdout.write(
      `① 握手：协议 ${protocol} · 安装 ${product || '(未报)'} · 闲时 ${idleMs} ms · 方法面 ${methods.length} 条\n`,
    )

    // ② 一次读（`status`）
    const st = await ask('status')
    if (st.error !== undefined) {
      process.stderr.write(`status 失败：${JSON.stringify(st.error)}\n`)
      finish(1)
      return
    }
    const one = JSON.parse(st.result.stdout)
    process.stdout.write(
      `② status：${st.result.stdout.trim().length} 字节 · 事件 ${one.snapshot.events} 条 · ` +
        `最近 ${one.snapshot.last === null ? '(没有)' : one.snapshot.last.t}（via=${st.result.via}）\n`,
    )

    // ③ 事件尾随：一趟一趟地问，游标每趟带回来
    let cursor = ''
    const onePass = async (label) => {
      const w = await ask('watch', cursor === '' ? {} : { resume: cursor })
      if (w.error !== undefined) {
        process.stderr.write(`watch 失败：${JSON.stringify(w.error)}\n`)
        return 0
      }
      const lines = w.result.stdout.split('\n').filter((l) => l !== '')
      const events = lines.map((l) => JSON.parse(l))
      // **下一趟要用的游标**：§ 9.11「响应里带这一趟读到的事件与下一趟要用的游标」——
      // `stdout` 是 NDJSON（与 CLI 逐字节相同），游标住在 `result` 那一栏里。
      cursor = w.result.result?.resume ?? ''
      process.stdout.write(
        `③ ${label}：这一趟 ${events.length} 条 · 游标 ${cursor === '' ? '(空)' : cursor}\n`,
      )
      // 事件形状：拿一条出来给 `events.schema.json` 核（这里只印出 `t`，形状那一份是契约件）
      for (const e of events.slice(0, 3)) {
        process.stdout.write(`   · ${e.pos.writer}:${e.pos.seq} ${e.e.t}\n`)
      }
      return events.length
    }
    let total = await onePass('第一趟')
    if (!follow) {
      total += await onePass('第二趟（同一个游标接着问）')
      process.stdout.write(`③ 尾随：两趟合计 ${total} 条事件\n`)
      await ask('shutdown')
      finish(0)
      return
    }
    process.stdout.write('③ 跟着看（Ctrl-C 停）\n')
    process.on('SIGINT', () => {
      process.stdout.write(`\n③ 收尾：最后那个游标是 ${cursor}\n`)
      void ask('shutdown').then(() => finish(0))
    })
    for (;;) {
      await new Promise((r) => setTimeout(r, 200))
      await onePass('接着问')
    }
  })().catch((err) => {
    process.stderr.write(`样例客户端崩了：${err?.stack ?? String(err)}\n`)
    finish(1)
  })
}

main()
