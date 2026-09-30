#!/usr/bin/env node
// 计时读数：跑一档验收入口，把那一档的**墙钟**落成一份 JSON——PR 档的可下载 artifact。
//
// **为什么是脚本，不是 workflow 里几行 bash**：artifact 的形状是 0.2.2 的冻结面之一，而冻结点
// 要有一条会红的断言（`test/ci-timing.test.ts` 断的就是这份 JSON 的键集）。而且 CI 的每一步都得
// 是本地一条命令能复现的：这一步就是 `node tools/ci-timing.js fast`。
//
// 用法：`node tools/ci-timing.js <all|fast|real> [--out <路径>]`
//   · 退出码 = 那一档的退出码（判据还是验收本身，不是计时）
//   · 缺省只把 JSON 印到 stdout；给了 `--out` 就写文件，stdout 印一行人读的那一行
//   · **跑不动也先落读数**：那一档红了，文件照写、退出码照传——artifact 要的是"红了也看得见墙钟"
//
// 形状（`schema: 1`，冻结）：`schema` · `lane` · `wallMs` · `exitCode` · `startedAt` ·
// `finishedAt` · `files` · `runner` · `run`。**条数（tests/pass/fail）不进读数**：那要解析
// `node --test` 的输出格式，格式一变就静默丢；文件数是分档器直接给的（`discover` + `splitLanes`），
// 断言得住——读数只取拿得准的那半。
//
// **读数带机器**（runner 名 · cpu 数 · 平台 · node 版本）：路线图 §2 边界 2——runner 读数只作趋势
// 与回归哨兵，当架构常数的读数取在一等档主机上。不记机器，事后没法对账。零凭据：只读
// `GITHUB_*` 里那几个定位用的变量，不碰任何 token。
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { arch, cpus, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discover, splitLanes } from './test-entry.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** artifact 的形状版本。改形状就跳这个数——断言在 `test/ci-timing.test.ts`。 */
export const SCHEMA = 1

export const LANES = ['all', 'fast', 'real']

/** 冻结面：这一份读数的键集与含义。多一个键、少一个键都算改形状。 */
export function timingRecord(o) {
  return {
    schema: SCHEMA,
    lane: o.lane,
    wallMs: o.wallMs,
    exitCode: o.exitCode,
    startedAt: o.startedAt,
    finishedAt: o.finishedAt,
    /** 这一档的发现数与分档读数（来自分档器，不是解析输出）。 */
    files: o.files,
    /** 跑它的那台机器：name · image · os · arch · cpus · node。 */
    runner: o.runner,
    /** CI 上的这一趟：id · attempt · event · workflow · ref · sha（不在 CI 上时全是 null）。 */
    run: o.run,
  }
}

/** 本地那趟真跑：同一份入口、同一档，stdio 直通（读数不改行为）。 */
export function spawnLane(lane, root = ROOT) {
  // `NODE_TEST_CONTEXT` 一在场，`node --test` 就把自己当成"被测试递归调起"：**静默跳过所有文件
  // 并退 0**（实测输出 `Warning: node:test run() is being called recursively within a test file.
  // skipping running files.`）。CI 上计时器是顶层进程，这个变量根本不存在；只有"在测试里跑计时器"
  // 那种夹具会撞上它——不擦掉的话夹具会**假绿**（读数照样落盘，只是那一档根本没跑）。擦掉它，
  // 让夹具与 CI 走同一条路。
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [join(root, 'tools', 'test-entry.js'), lane], {
    cwd: root,
    stdio: 'inherit',
    env,
  })
}

/** 跑一档并量它。`run` 与 `now` 可换——测试用假跑器，免得在测试里递归跑整套。 */
export function timeLane(lane, { root = ROOT, run = spawnLane, now = Date.now } = {}) {
  const { fast, real } = splitLanes(discover(root))
  const startedAt = new Date(now()).toISOString()
  const t0 = now()
  const r = run(lane, root)
  const wallMs = now() - t0
  const finishedAt = new Date(now()).toISOString()
  const status = r === undefined || r === null ? 1 : (r.status ?? 1)
  return {
    record: timingRecord({
      lane,
      wallMs,
      exitCode: status,
      startedAt,
      finishedAt,
      files: { fast: fast.length, real: real.length, all: fast.length + real.length },
      runner: {
        name: env('RUNNER_NAME'),
        image: env('ImageOS'),
        os: platform(),
        arch: arch(),
        cpus: cpus().length,
        node: process.version,
      },
      run: {
        id: env('GITHUB_RUN_ID'),
        attempt: env('GITHUB_RUN_ATTEMPT'),
        event: env('GITHUB_EVENT_NAME'),
        workflow: env('GITHUB_WORKFLOW'),
        ref: env('GITHUB_REF'),
        sha: env('GITHUB_SHA'),
      },
    }),
    status,
  }
}

function env(k) {
  const v = process.env[k]
  return v === undefined || v === '' ? null : v
}

export function writeRecord(path, record) {
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
}

export function main(argv) {
  const lane = argv.find((a) => !a.startsWith('-'))
  const at = argv.indexOf('--out')
  const out = at === -1 ? null : argv[at + 1]
  if (lane === undefined || !LANES.includes(lane) || (at !== -1 && (out === undefined || out.startsWith('-')))) {
    process.stderr.write('用法：node tools/ci-timing.js <' + LANES.join('|') + '> [--out <路径>]\n')
    return 2
  }
  const { record, status } = timeLane(lane)
  if (out === null) {
    process.stdout.write(JSON.stringify(record, null, 2) + '\n')
  } else {
    writeRecord(out, record)
    process.stdout.write('档 ' + lane + ' 墙钟 ' + record.wallMs + 'ms 退出码 ' + status + ' → ' + out + '\n')
  }
  return status
}

// 直接运行时才执行；被测试 import 时不执行。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
