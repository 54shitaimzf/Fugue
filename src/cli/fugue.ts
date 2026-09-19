#!/usr/bin/env node
// fugue —— 环境的操作面。出处：架构 § 9.6。
//
// **单次进程 + 每次重建**：不需要守护进程、不需要常驻状态、崩溃恢复即"下一条命令
// 照常加载"。命令逐个单元长出来，U1 有 `log`，U2 挂上 `commit`；U6 收口时这张表才齐。
//
// 这一层只做三件事：解析参数 · 把结构化结果排成两列（人读的与 `--json` 的）· 决定退出码。
// **提交本身的顺序不在这里**——`checkpoint` 与 `fugue commit` 是同一个操作的两个名字
// （§ 9.6），所以那个操作住在 `src/checkpoint.ts`，这里只是它的一个人侧入口。
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { LogCorruptError, logDir, openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import type { LogEvent } from '../log/events.ts'
import { checkpoint } from '../checkpoint.ts'
import { openTruth } from '../truth/truth.ts'
import type { TreeEntry } from '../truth/contract.ts'
import type { BlobId, LogPos, ViewRev, WriterId } from '../terms.ts'

const USAGE = `用法: fugue [--root <dir>] [--agent <id>] [--json] <command> [args]

命令
  log [--agent <id>]        按 (seq, writer) 全序列出日志事件
  commit -m <msg>           把该 agent 的视图提交成一个提交点，推进它的 ref

选项
  --root <dir>    工作区根，默认当前目录；日志在 <root>/.fugue/log/，对象库在 <root>/.git
  --agent <id>    操作哪个视图；未指定时取 round（主线）
  --json          结构化输出
  --help          这张表
`

interface Parsed {
  flags: Map<string, string | true>
  positional: string[]
}

/**
 * 取值的选项。其余 `--x` 一律是开关——因为 § 9.6 的规范形是
 * `fugue [--root <dir>] [--agent <id>] [--json] <command>`，开关排在命令**前面**，
 * 一个贪心的解析器会把命令当成开关的值吃掉。`m` 是 `-m <msg>`，§ 9.6 表里 commit 的形。
 */
const VALUED: ReadonlySet<string> = new Set(['root', 'agent', 'm'])

function parseArgv(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-') || a === '-') {
      positional.push(a)
      continue
    }
    const long = a.startsWith('--')
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags.set(a.slice(long ? 2 : 1, eq), a.slice(eq + 1))
      continue
    }
    const key = a.slice(long ? 2 : 1)
    const next = argv[i + 1]
    if (VALUED.has(key) && next !== undefined && !next.startsWith('-')) {
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

interface Folded {
  entries: TreeEntry[]
  rev: ViewRev
  unsupported?: string
}

/**
 * 把该 writer 的日志折成一份条目表。**这一步是 M2 的活，U2 只是先借一下。**
 *
 * 只有两种事件能折：`view/write` 与 `view/remove`（后来的写覆盖先前的写，remove 抹掉
 * 指向）。**其余 `view/*` 一律拒绝**，不静默忽略——`view/rename` 被忽略的话，提交出来
 * 的树会声称一个已经被改名走的路径还在原处，而"重放必须一致"是承重性质。
 *
 * U3 的 `loadView` 落地之后，这个函数整个删掉：`checkpoint` 收的就是条目，来源换成视图
 * 的全量读出，**调用点一行都不用改**。
 */
async function foldLog(log: LogHandle, writer: WriterId): Promise<Folded> {
  const files = new Map<string, { mode: number; id: BlobId }>()
  let rev: ViewRev = 0
  let unsupported: string | undefined
  for await (const e of log.readByWriter(writer)) {
    switch (e.t) {
      case 'view/write':
        files.set(e.path, { mode: e.mode, id: e.blob })
        rev = Math.max(rev, e.rev)
        break
      case 'view/remove':
        files.delete(e.path)
        rev = Math.max(rev, e.rev)
        break
      default:
        if (e.t.startsWith('view/') && unsupported === undefined) unsupported = e.t
    }
  }
  return {
    entries: [...files].map(([name, v]) => ({ name, mode: v.mode, id: v.id })),
    rev,
    unsupported,
  }
}

async function commit(root: string, writer: WriterId, msg: string, json: boolean): Promise<number> {
  const log = openLog(root)
  const truth = openTruth(root)
  try {
    const folded = await foldLog(log, writer)
    if (folded.unsupported !== undefined) {
      process.stderr.write(
        `这条日志里有 ${folded.unsupported} 事件，本单元的提交只认 view/write 与 view/remove —— ` +
          `拒绝提交，不给出一个少了改名/改权限的树（U3 的视图重放接管这一步）\n`,
      )
      return 2
    }
    const r = await checkpoint({
      log,
      truth,
      writer,
      entries: folded.entries,
      rev: folded.rev,
      msg,
    })
    if (json) {
      process.stdout.write(JSON.stringify({ ...r, rev: folded.rev }) + '\n')
    } else {
      process.stdout.write(`${r.commit}\t${r.ref}\t${r.entries} 个条目\n`)
    }
    return 0
  } finally {
    await log.close()
    await truth.close()
  }
}

export async function main(argv: readonly string[]): Promise<number> {
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

    case 'commit': {
      const msg = flags.get('m')
      if (typeof msg !== 'string' || msg === '') {
        process.stderr.write(`commit 需要 -m <msg>\n\n${USAGE}`)
        return 2
      }
      const agentFlag = flags.get('agent')
      // § 9.6：`--agent` 决定操作哪个视图；未指定时取主线。主 agent 的标识还没有规范
      // 命名（§ 4 只给了 ref 方案），这里沿用 U1 里 round 这个写者。
      const writer = (typeof agentFlag === 'string' ? agentFlag : 'round') as WriterId
      return await commit(root, writer, msg, json)
    }

    default:
      process.stderr.write(`未知命令：${cmd}\n\n${USAGE}`)
      return 2
  }
}

/**
 * 只有直接运行才执行。**这个守卫不能用 `import.meta.main`**：它是 Node 24.2 才有的，
 * 而 `package.json` 声明的 engines 是 ≥22.6——在那个版本上它会静默什么都不做。
 * 与 `tools/test-entry.js` 用同一个写法，所以本模块**可以被 import 而不产生副作用**。
 */
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
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
}
