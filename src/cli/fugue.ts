#!/usr/bin/env node
// fugue —— 环境的操作面。出处：架构 § 9.6。
//
// **单次进程 + 每次重建**：不需要守护进程、不需要常驻状态、崩溃恢复就是"下一条命令照常
// 加载"。命令逐个单元长出来：U1 挂上 `log`，U2 挂上 `commit`，U3 挂上视图的八条（§ 9.6
// 的读 · 写 · 检视三组）；U6 收口时这张表才齐。
//
// 这一层只做三件事：解析参数 · 把结构化结果排成两列（人读的与 `--json` 的）· 决定退出码。
// **语义不在这里**：一次变更的顺序与校验住在 `src/view/edit.ts`，提交住在
// `src/checkpoint.ts`——两个都是跨层接线（§ 7），这里只是它们的一个人侧入口。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkpoint } from '../checkpoint.ts'
import type { Delta } from '../delta.ts'
import type { TreeEntry } from '../entries.ts'
import type { LogEvent } from '../log/events.ts'
import { LogCorruptError, logDir, openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { refFor } from '../refs.ts'
import type { AgentId, CommitId, LogPos, ViewRev, WriterId } from '../terms.ts'
import { openTruth, RefNotFoundError } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import type { View } from '../view/contract.ts'
import { applyEdit } from '../view/edit.ts'
import { lowerAt } from '../view/lower.ts'
import { snapshotOf } from '../view/snapshot.ts'
import { loadView } from '../view/view.ts'

const USAGE = `用法: fugue [--root <dir>] [--agent <id>] [--json] <command> [args]

命令
  log [--agent <id>]         按 (seq, writer) 全序列出日志事件
  read <path>                读一个路径；默认吐原始字节
  list [dir]                 列一个目录
  stat <path>                一个路径的形状
  write <path> [--from <f>|--stdin]   写一个文件
  remove <path>              删一个路径（目录连同它下面）
  rename <from> <to>         改名
  chmod <path> <mode>        改模式；<mode> 是八进制，如 755
  diff [--since <rev>]       自某个修订点以来的变更
  commit -m <msg>            把当前视图提交成一个提交点，推进它的 ref

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
 * 一个贪心的解析器会把命令当成开关的值吃掉。
 */
const VALUED: ReadonlySet<string> = new Set(['root', 'agent', 'm', 'from', 'since'])

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

function emitJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v) + '\n')
}

function emitLine(s: string): void {
  process.stdout.write(s + '\n')
}

function fail(msg: string): number {
  process.stderr.write(msg + '\n')
  return 1
}

function usageFail(msg: string): number {
  process.stderr.write(`${msg}\n\n${USAGE}`)
  return 2
}

/** `--agent` 决定操作哪个视图；未指定时取主线。主 agent 的标识还没有规范命名（§ 4 只给了 ref 方案），这里沿用 round 这个写者。 */
function writerOf(flags: Map<string, string | true>): WriterId {
  const a = flags.get('agent')
  return (typeof a === 'string' ? a : 'round') as WriterId
}

interface Ctx {
  log: LogHandle
  truth: TruthHandle
  view: View
  writer: WriterId
  close(): Promise<void>
}

/**
 * 一条命令要的三样：日志 · 真源 · 视图。
 *
 * **base 取该 agent 的 ref 现在指向的提交**：视图 = 该提交 + 这个 agent 自己写过的路径。
 * 提交把视图定格成一个新的提交点之后，base 随之前移——上层仍然带着这次 agent 写过的
 * 全部路径，所以读出不变。
 */
async function openCtx(root: string, flags: Map<string, string | true>): Promise<Ctx> {
  const writer = writerOf(flags)
  const log = openLog(root)
  let truth: TruthHandle | null = null
  try {
    truth = openTruth(root)
    let base: CommitId | null = null
    try {
      base = await truth.resolve(refFor(writer))
    } catch (err) {
      if (!(err instanceof RefNotFoundError)) throw err
    }
    const view = await loadView(log, writer as AgentId, { lower: lowerAt(truth, base) })
    const t = truth
    return {
      log,
      truth: t,
      view,
      writer,
      close: async () => {
        await log.close()
        await t.close()
      },
    }
  } catch (err) {
    await log.close()
    if (truth !== null) await truth.close()
    throw err
  }
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Uint8Array))
  return Buffer.concat(chunks)
}

function parseOctal(raw: string): number {
  const text = raw.trim().replace(/^0o?/, '')
  if (!/^[0-7]{3,4}$/.test(text)) throw new Error(`模式要八进制三位或四位：${raw}`)
  return parseInt(text, 8)
}

/** `--json` 的 delta 形状。**字节不进去**——它可能是二进制，`JSON.stringify` 会把它摊成下标表。 */
function deltaJson(d: Delta): Record<string, unknown> {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return { kind: d.kind, path: d.path, mode: d.mode, size: d.bytes.length }
    default:
      return { ...d }
  }
}

function deltaLine(d: Delta): string {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return `${d.kind}\t${d.path}\t${d.bytes.length} 字节\t${d.mode.toString(8)}`
    case 'delete':
      return `delete\t${d.path}`
    case 'rename':
      return `rename\t${d.from}\t→ ${d.to}`
    case 'chmod':
      return `chmod\t${d.path}\t${d.mode.toString(8)}`
    case 'symlink':
      return `symlink\t${d.path}\t→ ${d.target}`
  }
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

async function commit(ctx: Ctx, msg: string, json: boolean): Promise<number> {
  // **条目来自视图的全量读出**（§ 8.3 的"先持久，后重建"）：U2 那个临时的日志折叠在
  // U3 落地时删除，调用点一行没改——`checkpoint` 收的本来就是条目与 rev。
  const entries: TreeEntry[] = await snapshotOf(ctx.view)
  const r = await checkpoint({
    log: ctx.log,
    truth: ctx.truth,
    writer: ctx.writer,
    entries,
    rev: ctx.view.rev,
    msg,
  })
  if (json) emitJson({ ...r, rev: ctx.view.rev })
  else emitLine(`${r.commit}\t${r.ref}\t${r.entries} 个条目`)
  return 0
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

  if (cmd === 'log') {
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

  if (cmd === 'commit') {
    const msg = flags.get('m')
    if (typeof msg !== 'string' || msg === '') return usageFail('commit 需要 -m <msg>')
    const ctx = await openCtx(root, flags)
    try {
      return await commit(ctx, msg, json)
    } finally {
      await ctx.close()
    }
  }

  const args = positional.slice(1)
  const need = (n: number): boolean => args.length >= n && !args.slice(0, n).some((a) => a === '')

  switch (cmd) {
    case 'read': {
      if (!need(1)) return usageFail('read 需要 <path>')
      const ctx = await openCtx(root, flags)
      try {
        const bytes = await ctx.view.read(args[0])
        if (bytes === null) return fail(`read：${args[0]} 不是可读的路径（目录 · gitlink · 或者不存在）`)
        if (json) {
          const meta = await ctx.view.stat(args[0])
          emitJson({ path: args[0], size: bytes.length, ...meta })
        } else {
          process.stdout.write(Buffer.from(bytes))
        }
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'list': {
      const ctx = await openCtx(root, flags)
      try {
        const rows = await ctx.view.list(args[0] ?? '')
        if (json) emitJson(rows)
        else for (const r of rows) emitLine(`${r.kind}\t${r.mode.toString(8)}\t${r.size}\t${r.name}`)
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'stat': {
      if (!need(1)) return usageFail('stat 需要 <path>')
      const ctx = await openCtx(root, flags)
      try {
        const meta = await ctx.view.stat(args[0])
        if (meta === null) return fail(`stat：${args[0]} 不存在`)
        if (json) emitJson({ path: args[0], ...meta })
        else emitLine(`${meta.kind}\t${meta.mode.toString(8)}\t${meta.size}\t${meta.id}`)
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'diff': {
      const sinceRaw = flags.get('since')
      let since: ViewRev | undefined
      if (typeof sinceRaw === 'string') {
        since = Number(sinceRaw)
        if (!Number.isInteger(since) || since < 0) return usageFail('--since 要一个非负整数修订号')
      }
      const ctx = await openCtx(root, flags)
      try {
        const deltas = ctx.view.diff(since)
        if (json) emitJson(deltas.map(deltaJson))
        else for (const d of deltas) emitLine(deltaLine(d))
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'write':
    case 'remove':
    case 'rename':
    case 'chmod': {
      const ctx = await openCtx(root, flags)
      try {
        const rev = await edit(ctx, cmd, args, flags)
        if (json) emitJson({ rev, agent: ctx.writer })
        else emitLine(`${rev}\t${ctx.writer}`)
        return 0
      } finally {
        await ctx.close()
      }
    }

    default:
      return usageFail(`未知命令：${cmd}`)
  }
}

/** 四条写命令共用的那一小段：把命令行收成一个 delta，落下去，报 rev。 */
async function edit(
  ctx: Ctx,
  cmd: string,
  args: string[],
  flags: Map<string, string | true>,
): Promise<ViewRev> {
  let delta: Delta
  switch (cmd) {
    case 'write': {
      const p = args[0]
      if (p === undefined) throw new Error('write 需要 <path>')
      const from = flags.get('from')
      let bytes: Uint8Array
      if (typeof from === 'string') bytes = readFileSync(from)
      else if (flags.has('stdin')) bytes = await readStdin()
      else throw new Error('write 需要 --from <file> 或 --stdin')
      // 默认 644；要可执行就再敲一条 chmod——两条命令各说一件事，不从写里猜。
      delta = { kind: 'add', path: p, bytes, mode: 0o100644 }
      break
    }
    case 'remove': {
      const p = args[0]
      if (p === undefined) throw new Error('remove 需要 <path>')
      delta = { kind: 'delete', path: p }
      break
    }
    case 'rename': {
      const from = args[0]
      const to = args[1]
      if (from === undefined || to === undefined) throw new Error('rename 需要 <from> <to>')
      delta = { kind: 'rename', from, to }
      break
    }
    default: {
      const p = args[0]
      const mode = args[1]
      if (p === undefined || mode === undefined) throw new Error('chmod 需要 <path> <mode>')
      delta = { kind: 'chmod', path: p, mode: parseOctal(mode) }
      break
    }
  }
  return await applyEdit({ log: ctx.log, truth: ctx.truth, view: ctx.view, writer: ctx.writer }, delta)
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
