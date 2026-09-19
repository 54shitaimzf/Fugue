#!/usr/bin/env node
// fugue —— 环境的操作面。出处：架构 § 9.6。
//
// **单次进程 + 每次重建**：不需要守护进程、不需要常驻状态、崩溃恢复即"下一条命令
// 照常加载"。命令逐个单元长出来，U1 只有 `log` 一条；U6 收口时这张表才齐。
//
// 全部输出是结构化的，`--json` 给的就是机器读的那一份；人读的那一列只是同一份
// 数据的另一种排布，不构成第二份定义。
import { LogCorruptError, logDir, openLog } from '../log/log.ts'
import type { LogEvent } from '../log/events.ts'
import type { LogPos, WriterId } from '../terms.ts'

const USAGE = `用法: fugue [--root <dir>] [--json] <command> [args]

命令
  log [--agent <id>]        按 (seq, writer) 全序列出日志事件

选项
  --root <dir>    工作区根，默认当前目录；日志在 <root>/.fugue/log/
  --agent <id>    只看某一个 writer
  --json          结构化输出：每行一个 {"pos":…,"e":…}
  --help          这张表
`

interface Parsed {
  flags: Map<string, string | true>
  positional: string[]
}

/**
 * 取值的选项，就只有这两个。其余 `--x` 一律是开关——因为 § 9.6 的规范形是
 * `fugue [--root <dir>] [--agent <id>] [--json] <command>`，开关排在命令**前面**，
 * 一个贪心的解析器会把命令当成开关的值吃掉。
 */
const VALUED: ReadonlySet<string> = new Set(['root', 'agent'])

function parseArgv(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1))
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (VALUED.has(key) && next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      i++
    } else {
      flags.set(key, true)
    }
  }
  return { flags, positional }
}

function emit(pos: LogPos, e: LogEvent, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ pos, e }) + '\n')
    return
  }
  const { t, ...payload } = e as { t: string } & Record<string, unknown>
  const keys = Object.keys(payload)
  const brief = keys.map((k) => `${k}=${JSON.stringify(payload[k])}`).join(' ')
  process.stdout.write(`${pos.writer}\t${pos.seq}\t${t}\t${brief}\n`)
}

async function main(argv: readonly string[]): Promise<number> {
  const { flags, positional } = parseArgv(argv)
  const json = flags.has('json')
  const rootFlag = flags.get('root')
  const root = typeof rootFlag === 'string' ? rootFlag : process.cwd()
  const cmd = positional[0]

  if (flags.has('help') || cmd === undefined) {
    process.stdout.write(USAGE)
    return cmd === undefined ? 1 : 0
  }

  switch (cmd) {
    case 'log': {
      const only = flags.get('agent')
      const log = openLog(root)
      try {
        for await (const { pos, e } of log.readMerged()) {
          if (typeof only === 'string' && pos.writer !== (only as WriterId)) continue
          emit(pos, e, json)
        }
      } finally {
        await log.close()
      }
      return 0
    }
    default:
      process.stderr.write(`未知命令：${cmd}\n\n${USAGE}`)
      return 2
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof LogCorruptError) {
      process.stderr.write(`日志损坏，拒绝加载 —— ${err.message}\n`)
      process.stderr.write(`日志目录：${logDir(process.cwd())}\n`)
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    }
    process.exit(1)
  })
