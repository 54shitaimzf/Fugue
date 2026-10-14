#!/usr/bin/env node
// `ARCHITECTURE.md` § 9.4「实测基线」那一行的取证件：**进程启动 · 每事件重建 · 2 万事件端到端**。
//
// 口径（与那一行同一把尺，逐条写在这里，免得读数换了尺还在比）：
//
//   字节/事件   一条 `view/write`（路径约 25 字符，另带 40 个字符的内容指纹）落在日志里的净增
//   进程启动    同一棵树上 `--version` 的墙钟（最薄的一条命令）
//   每事件重建  （端到端 − 进程启动）÷ 事件数
//   端到端      同一棵树上 `status --once` 的墙钟（它把整份账从头重放一遍）
//   提交        把 N 条事件 append 进日志的墙钟
//
// 为什么要有这一份：那一行的三处读数原先各取各的（探针跑完就删），换一台机器 · 换一版就没人量
// 得动第二遍——"三处读数各说各的"正是这一批要收掉的那类东西。收成一条命令、一把尺，旁边写着
// 复现命令：`node tools/bench-replay.mjs`（缺省 20000 条），读数落进提交信息与那一行里。
//
// 两杆：墙钟取中位数（三次），前后各印一次 loadavg——读数自己带着当时的负载。
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {withCompileCache} from '../src/cli/boot.ts'
import {openLog} from '../src/log/log.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src/cli/fugue.ts')

function argOf(name, dflt) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : dflt
}

function loadavg() {
  try {
    return readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(' ')
  } catch {
    return '（这一台没有 /proc/loadavg）'
  }
}

function median(xs) {
  return xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
}

function runCli(args, cwd, sys) {
  const t0 = process.hrtime.bigint()
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: withCompileCache({...process.env, FUGUE_SYSTEM_DIR: sys}),
  })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  if (r.status !== 0) throw new Error(`${args.join(' ')} 退出码 ${r.status}\n${r.stderr}`)
  return {ms, out: r.stdout}
}

const events = Number(argOf('--events', '20000'))
const runs = Number(argOf('--runs', '3'))
const ws = mkdtempSync(join(tmpdir(), 'fugue-bench-replay-'))
const sys = mkdtempSync(join(tmpdir(), 'fugue-bench-replay-sys-'))

try {
  console.log(`loadavg before: ${loadavg()}`)
  const log = openLog(ws, {write: 'bench', sync: 'never'})
  const paths = []
  const t0 = process.hrtime.bigint()
  for (let i = 1; i <= events; i++) {
    // 路径与内容指纹的长度照真实形状取（后者是 sha1 十六进制，40 个字符）。
    const path = `src/perf/work-${String(i).padStart(5, '0')}.ts`
    paths.push(path.length)
    await log.append('bench', {
      t: 'view/write',
      agent: 'agent/r1/1',
      path,
      rev: i,
      blob: createHash('sha1').update(path).digest('hex'),
      mode: 0o100644,
    })
  }
  const commitMs = Number(process.hrtime.bigint() - t0) / 1e6
  await log.close()

  const dir = join(ws, '.fugue', 'log')
  const bytes = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .reduce((s, f) => s + statSync(join(dir, f)).size, 0)

  const version = []
  const end2end = []
  let face = ''
  for (let i = 0; i < runs; i++) {
    version.push(runCli(['--version'], ws, sys).ms)
    const r = runCli(['status', '--once'], ws, sys)
    end2end.push(r.ms)
    face = r.out.split('\n')[0]
  }
  const startup = median(version)
  const whole = median(end2end)
  const rebuild = whole - startup

  // 同一份账在进程内重放一遍：把"命令那一层的账"与"重放本身"分开量（两者该对得上）。
  const again = openLog(ws, {write: 'bench'})
  const t1 = process.hrtime.bigint()
  let read = 0
  for await (const _ of again.readMerged()) read++
  const inProc = Number(process.hrtime.bigint() - t1) / 1e6
  await again.close()
  console.log(`loadavg after:  ${loadavg()}`)
  console.log('')
  console.log(`事件数        ${events}（路径平均 ${(paths.reduce((a, b) => a + b, 0) / paths.length).toFixed(1)} 字符 · 指纹 40 字符）`)
  console.log(`字节/事件     ${(bytes / events).toFixed(1)}（整份 ${(bytes / 1024 / 1024).toFixed(2)} MiB）`)
  console.log(`进程启动      ${startup.toFixed(0)} ms（${runs} 趟中位数：${version.map((v) => v.toFixed(0)).join(' · ')}）`)
  console.log(`端到端        ${whole.toFixed(0)} ms（${runs} 趟中位数：${end2end.map((v) => v.toFixed(0)).join(' · ')}）`)
  console.log(`每事件重建    ${(rebuild / events).toFixed(4)} ms（重建合计 ${(rebuild / 1000).toFixed(2)} s）`)
  console.log(`进程内重放    ${inProc.toFixed(0)} ms（${read} 条 · ${(inProc / read).toFixed(4)} ms/事件——与上一行该是同一档）`)
  console.log(`提交          ${(commitMs / 1000).toFixed(2)} s（${events} 条 append）`)
  console.log(`那一趟印的    ${face.slice(0, 120)}`)
} finally {
  rmSync(ws, {recursive: true, force: true})
  rmSync(sys, {recursive: true, force: true})
}
