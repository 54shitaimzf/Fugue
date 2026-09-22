#!/usr/bin/env node
// fugue —— 环境的操作面。出处：架构 § 9.6。
//
// **单次进程 + 每次重建**：不需要守护进程、不需要常驻状态、崩溃恢复就是"下一条命令照常
// 加载"。§ 9.6 那张表里属于 S1 的每一行都在这里：读 · 写 · 检视 · 提交 · 重放 · 配置。
//
// 这一层只做三件事：解析参数 · 把结构化结果排成两列（人读的与 `--json` 的）· 决定退出码。
// **语义不在这里**：一次变更的顺序与校验住在 `src/view/edit.ts`，提交住在
// `src/checkpoint.ts`——两个都是跨层接线（§ 7），这里只是它们的一个人侧入口。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkpoint } from '../checkpoint.ts'
import {
  ConfigError,
  configFileOf,
  getConfig,
  parseConfigValue,
  readConfig,
  setConfig,
  writeConfig,
} from '../config.ts'
import { agentFor } from '../identity.ts'
import type { Delta } from '../delta.ts'
import type { TreeEntry } from '../entries.ts'
import type { LogEvent } from '../log/events.ts'
import { LogCorruptError, logDir, mergedFace, openLog } from '../log/log.ts'
import type { LogHandle, SyncLevel } from '../log/log.ts'
import type { ChangeStatus, TreeStat } from '../materialize/diffstat.ts'
import { TreeStatError, WORKSPACE_STATE, diffStat, loadTreeStat, scanTree, storeTreeStat } from '../materialize/diffstat.ts'
import { DEFAULT_MATERIALIZE } from '../materialize/contract.ts'
import { EnsureRefused, ensure } from '../materialize/ensure.ts'
import { ForkRefused, fork } from '../materialize/fork.ts'
import { LandError } from '../materialize/land.ts'
import { LayError } from '../materialize/lay.ts'
import { MountError } from '../materialize/mount.ts'
import { HostError, assertHost } from '../roots/host.ts'
import { createRoots } from '../roots/roots.ts'
import type { CommitId, ForkStrategy, LogPos, ViewRev, WriterId } from '../terms.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import type { View } from '../view/contract.ts'
import { applyEdit } from '../view/edit.ts'
import { lowerFor } from '../view/lower.ts'
import { readSnapshot, saveSnapshot, snapshotOf } from '../view/snapshot.ts'
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
  revs                       全部可达修订点，升序；0 是 base 本身
  commit -m <msg>            把当前视图提交成一个提交点，推进它的 ref
  replay [--to <rev>]        从日志重建视图并报出它；--verify 逐 agent 比对两条重建路径
  diff-stat [<dir>] [--baseline <f>] [--save <f>]
                             全树 (mtime,size,hash) 快照对比；不给 <dir> 时扫本 agent 的合并树，
                             基线由 --baseline 读、--save 存（三个路径都相对当前目录，不是 --root）
  fork <base> [--strategy <s>] [--ro <p1,p2>]
                             把 base 那棵树物化出来并挂上，返回合并树（本 agent 的坐标）
                             <base> 是一个提交；--strategy 取 overlayfs | hardlink-ro | copy，
                             不给就按策略表探着退档，用了哪一档写在 stderr 与 --json 里；
                             --ro 声明哪几处子树只读（hardlink-ro 那一档只链它们）
  ensure [--to <rev>]
                             把这个 agent 到 <rev> 为止的改动落到物化树里（不给 --to 就是此刻），
                             返回合并树；已最新就什么都不落。一次落哪些路径由日志里的 mat/*
                             重放得来，落完追加一条 mat/sync
  config show                工作区配置的全文
  config get <key>           配置里的一条；<key> 是点分路径，如 docs.trace.path
  config set <key> <value>   改一条；<value> 整份解析得了就当 JSON 值，否则当字符串

选项
  --root <dir>    工作区根，默认当前目录；日志在 <root>/.fugue/log/，对象库在 <root>/.git，
                  配置在 <root>/.fugue/config。工作区要落在一块原生的本地文件系统上：
                  落在 9p / drvfs 那一类跨内核的落点上时拒绝启动（架构 § 15.7 的 E1）
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
const VALUED: ReadonlySet<string> = new Set(['root', 'agent', 'm', 'from', 'since', 'to', 'baseline', 'save', 'strategy', 'ro'])

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

/**
 * `--agent` 决定操作哪个视图，等价于选择一份日志（§ 9.6）。未指定时取主线：`round` 是
 * 持轮者这个位置的名字，它在 git 侧的落点是 `refs/heads/main`（§ 4）——所以不带参数读到
 * 的视图，与 git 侧的主干是同一段历史。
 */
function writerOf(flags: Map<string, string | true>): WriterId {
  const a = flags.get('agent')
  return (typeof a === 'string' ? a : 'round') as WriterId
}

interface Ctx {
  root: string
  log: LogHandle
  truth: TruthHandle
  view: View
  writer: WriterId
  close(): Promise<void>
}

interface OpenOptions {
  /**
   * 要变更序列的命令（`diff`）。**快照换掉的正是历史**，所以这些命令明说不看快照——
   * 加速项不该在任何一处改变语义，答不上来的问题就得从 0 重放。
   */
  history?: boolean
  upToRev?: ViewRev
  /** 日志的耐久档位。提交点用 `each`（§ 9.5 把提交点与检查点列在同一档）。 */
  sync?: SyncLevel
}

/**
 * 一条命令要的三样：日志 · 真源 · 视图。
 *
 * **base 取该 agent 的 ref 现在指向的提交**：视图 = 该提交 + 这个 agent 自己写过的路径。
 * 提交把视图定格成一个新的提交点之后，base 随之前移——上层仍然带着这次 agent 写过的
 * 全部路径，所以读出不变。
 */
async function openCtx(
  root: string,
  flags: Map<string, string | true>,
  opts: OpenOptions = {},
): Promise<Ctx> {
  const writer = writerOf(flags)
  const log = openLog(root, opts.sync === undefined ? {} : { sync: opts.sync })
  let truth: TruthHandle | null = null
  try {
    truth = openTruth(root)
    const lower = await lowerFor(truth, writer)
    // 有快照就从快照起（§ 9.4 的第一步）：这一步只影响快慢，影响不到读出来的东西——
    // `diff` 那种要历史的命令在上面的 `history` 里被排除掉了。
    const snap =
      opts.history === true
        ? null
        : await readSnapshot(root, writer, opts.upToRev === undefined ? {} : { upToRev: opts.upToRev })
    const view = await loadView(
      log,
      writer,
      snap === null ? { lower, upToRev: opts.upToRev } : { lower, upToRev: opts.upToRev, snap },
    )
    const t = truth
    return {
      root,
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
  if (!/^[0-7]{3,4}$/.test(text)) throw new UsageError(`模式要八进制三位或四位：${raw}`)
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
    // 视图铺在哪个提交上，这次提交就推在哪个提交之上（`checkpoint` 的 CAS 期望）。
    expectedOld: ctx.view.base,
  })
  // 提交点同时是快照点（§ 9.5 把提交点与检查点列在同一档）：那一行日志已经落了，把上层的
  // 折叠留在 `<root>/.fugue/snap/` 下。**写不成就当没写**——快照从不阻塞写入（§ 9.4）。
  await saveSnapshot(ctx.root, ctx.writer, ctx.view, r.seq)
  if (json) emitJson({ ...r, rev: ctx.view.rev })
  else emitLine(`${r.commit}\t${r.ref}\t${r.entries} 个条目`)
  return 0
}

/**
 * `fugue config show|get|set`（§ 9.6 的配置组 · § 15.3.a 的工作区级配置）。
 *
 * 三条命令都**不建视图、不读日志**——配置是工作区的输入，不是它的状态。所以它们在一个还
 * 没有对象库的目录里照常可用；反过来说，重放这条链上没有任何一处读配置（PLAN § 5 的 U5
 * 断言一：配置改动后重放结果不变）。
 *
 * 三个动词各报自己那件事：`show` 报全文 · `get` 报一条值 · `set` 报这次改动（含老值——
 * § 15.3.a 要"每次改动记原值"，人这一面先做到"改一次就报一次"，留档与逆操作是 T5）。
 */
async function config(root: string, args: string[], json: boolean): Promise<number> {
  const verb = args[0]
  try {
    if (verb === 'show') {
      const doc = await readConfig(root)
      emitLine(json ? JSON.stringify(doc) : JSON.stringify(doc, null, 2))
      return 0
    }
    if (verb === 'get') {
      const key = args[1]
      if (key === undefined) return usageFail('config get 需要 <key>')
      const value = getConfig(await readConfig(root), key)
      if (value === undefined) return fail(`config get：没有这条键 —— ${key}`)
      // 人这一面：字符串吐原样（好接管道），别的吐 JSON。`--json` 那一面一律是 JSON。
      if (json) emitJson(value)
      else emitLine(typeof value === 'string' ? value : JSON.stringify(value))
      return 0
    }
    if (verb === 'set') {
      const key = args[1]
      const raw = args[2]
      if (key === undefined || raw === undefined) return usageFail('config set 需要 <key> <value>')
      const doc = await readConfig(root)
      const old = getConfig(doc, key)
      const value = parseConfigValue(raw)
      setConfig(doc, key, value)
      await writeConfig(root, doc)
      const out: Record<string, unknown> = { key, value, path: configFileOf(root) }
      // **老值只在原本有这条键时出现**：凭空多一个 `old: null` 会与"存了个 null"混起来。
      if (old !== undefined) out.old = old
      if (json) emitJson(out)
      else {
        emitLine(`${key}	${old === undefined ? '(没有)' : JSON.stringify(old)}	→	${JSON.stringify(value)}`)
      }
      return 0
    }
    return usageFail(`config 需要 show|get|set，收到：${verb ?? '(空)'}`)
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message)
    throw err
  }
}

/**
 * `fugue diff-stat [<dir>] [--baseline <file>] [--save <file>]`（§ 9.6 的物化行 · § 9.8）。
 *
 * 它是**尺子**，不是物化的一步：只读——不动物化树、不动挂载态（§ 8.5 把 `diff-stat` 与
 * `verify-mat` 并列写成只读）。所以它既不建视图也不读日志：树在盘上什么样，它就报什么样。
 *
 * 不给 `<dir>` 时扫的是这个 agent 的合并树（§ 8.4 的 `merged`）。树还没铺就**拒绝并指路
 * `fork`**——不当成"空树，0 条变化"：那是尺子最坏的一种错法，量出来的 0 会被读成"树没变"。
 * 基线由 `--baseline` 给、`--save` 存，它自己不占持久化位置（PLAN § 5.2 的 V1 行）。
 *
 * **变化条数不进退出码**：退出 0 就是"扫完了、比完了"。§ 9.8 里 `1` 是"这件事没做成"，
 * 而"树变了"不是没做成。
 */
function diffStatCmd(root: string, flags: Map<string, string | true>, args: string[], json: boolean): number {
  const where = args[0]
  let dir: string
  try {
    dir = where === undefined ? createRoots(resolve(root)).mergedRoot(agentFor(writerOf(flags))) : resolve(where)
  } catch (err) {
    return fail((err as Error).message)
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    if (where !== undefined) return fail(`不是一棵能扫的树：${dir}`)
    return fail(`物化的合并树还没铺：${dir}\n先 fugue fork <base> 铺一棵（§ 8.5）。`)
  }

  const baseFlag = flags.get('baseline')
  const saveFlag = flags.get('save')
  if (baseFlag === true || saveFlag === true) return usageFail('--baseline 与 --save 都要一个文件名')
  const baseFile = typeof baseFlag === 'string' ? resolve(baseFlag) : undefined
  const saveFile = typeof saveFlag === 'string' ? resolve(saveFlag) : undefined
  // **别把尺子放进树里**：基线自己也是一份新文件，留在被扫的树里，下一轮它会被报成
  // "多了一条"——量树的人亲手污染读数。拦住比事后解释便宜。
  for (const [what, file] of [
    ['--baseline', baseFile],
    ['--save', saveFile],
  ] as const) {
    if (file !== undefined && insideTree(dir, file)) {
      return fail(`${what} 指向被扫的树里：${file}\n基线是尺子，不是树的一部分——把它挪到 ${dir} 之外。`)
    }
  }

  let before: TreeStat | undefined
  let now: TreeStat
  try {
    // 基线**先读**：读不动就拒绝，绝不当成"什么都没变"（与配置同一条纪律）。
    if (baseFile !== undefined) before = loadTreeStat(baseFile)
    now = scanTree(dir, { skip: WORKSPACE_STATE })
    if (saveFile !== undefined) storeTreeStat(saveFile, now)
  } catch (err) {
    if (err instanceof TreeStatError) return fail(err.message)
    return fail(`扫不动 ${dir}：${(err as Error).message}`)
  }
  // 过程走 stderr（§ 9.8 的 stdout 纪律）。
  if (saveFile !== undefined) process.stderr.write(`快照存到 ${saveFile}\n`)

  const paths = now.leaves.length
  // 没给基线：这是一次"拍快照"，报的是树自己。
  if (before === undefined) {
    if (json) emitJson({ root: now.root, paths, leaves: now.leaves })
    else emitLine(`${paths} 个叶子\t${now.root}`)
    // 指路：裸敲这一次拿到的是快照，不是对比。"要对比该给什么"不能靠人去猜（§ 24 纪律 5）。
    process.stderr.write('没有给 --baseline：这是一张快照，不是对比——--save <f> 存下来，下一次 --baseline <f> 读它\n')
    return 0
  }

  const changes = diffStat(before, now)
  if (json) emitJson({ root: now.root, baseline: baseFile, paths, count: changes.length, changes })
  else {
    for (const c of changes) emitLine(`${STATUS_MARK[c.status]}\t${c.path}\t${c.columns.join(',')}`)
    process.stderr.write(
      changes.length === 0
        ? `没有变化\t${paths} 个叶子\t基线 ${baseFile}\n`
        : `${changes.length} 条变化\t${paths} 个叶子\t基线 ${baseFile}\n`,
    )
  }
  return 0
}

/** 人读那一面的记号：增 · 删 · 改。`--json` 那一面给的是 `status` 这个字本身。 */
const STATUS_MARK: Record<ChangeStatus, string> = { added: '+', removed: '-', changed: '~' }

/** 策略名——给用法错与 `--json` 用；次序就是 § 8.5 策略表里的那三档（`reflink` 不在列）。 */
const STRATEGIES: readonly ForkStrategy[] = ['overlayfs', 'hardlink-ro', 'copy']

/**
 * `fugue fork <base>`：把 base 那棵树物化出来，返回合并树（§ 8.5 · § 9.6）。
 *
 * **它不建视图、不读日志的历史**：物化的底是**真实工作树**，`fork` 只是把它挂上来（§ 8.4）。
 * `base` 在这里只做两件事——解析成一个真提交（免得把一串敲错的字符当成标签记进日志），
 * 以及进 `mat/fork` 事件。**不拿它跟真实工作树比对**：那一步 § 8.4 说得明白，不做检测。
 *
 * 退出码：0 物化好了（**用了哪一档由 stderr 那一行说，也由 `--json` 的 `strategy` 说**）·
 * 1 做不成（底不在 · 挂不上 · 铺不动）· 2 命令行本身不成立。
 */
async function forkCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const base = args[0]
  if (base === undefined || base === '') return usageFail('fork 需要 <base>：一个提交')
  const want = flags.get('strategy')
  if (typeof want === 'string' && !(STRATEGIES as readonly string[]).includes(want)) {
    return usageFail(`--strategy 只认 ${STRATEGIES.join(' · ')}；不给就按策略表探着退档`)
  }
  const roRaw = flags.get('ro')
  const readOnly =
    typeof roRaw === 'string' ? roRaw.split(',').map((s) => s.trim()).filter((s) => s !== '') : undefined

  const abs = resolve(root)
  const agent = agentFor(writerOf(flags))
  const log = openLog(abs)
  let truth: TruthHandle | null = null
  try {
    truth = openTruth(abs)
    let commit: CommitId
    try {
      commit = await truth.resolve(base)
    } catch (err) {
      return fail(
        `fork：${base} 不是这个工作区里一个能用的提交——<base> 要指向一棵树\n  ${(err as Error).message}`,
      )
    }
    const res = await fork({ roots: createRoots(abs), log, root: abs }, agent, commit, {
      ...DEFAULT_MATERIALIZE,
      ...(typeof want === 'string' ? { preferredStrategy: want as ForkStrategy } : {}),
      ...(readOnly === undefined ? {} : { readOnlyPaths: readOnly }),
    })
    if (json) {
      emitJson({
        agent,
        base: res.base,
        strategy: res.strategy,
        mount: res.mount,
        merged: res.merged,
        laid: res.laid,
        ms: res.ms,
        why: res.why,
        platform: res.facts,
      })
    } else {
      // 用了哪一档是**读数**，不是进度条：它在 stderr 上，与 stdout 那条坐标分得开（§ 9.8）。
      // `why` 自己开头就写着是哪一档（"overlayfs 档：…"或者"跳过 …；copy 档：…"），不再另起一句。
      process.stderr.write(res.why + '\n')
      emitLine(res.merged)
    }
    return 0
  } catch (err) {
    if (err instanceof ForkRefused) return fail(err.why)
    if (err instanceof MountError || err instanceof LayError) return fail(err.message)
    throw err
  } finally {
    await log.close()
    if (truth !== null) await truth.close()
  }
}

/**
 * `fugue ensure [--to <rev>]`：把这个 agent 的改动落到物化树里（§ 8.5 · § 9.6 的物化行）。
 *
 * **它是物化那一组里唯一要建视图的命令**：`fork` 铺的是真实工作树（§ 8.4），不读日志；而
 * `ensure` 落的是"这个 agent 自己写过的那些路径"，那份东西只存在于日志里。
 *
 * `--to` 不给就是视图此刻的修订点。**它必须是一个修订点**：这个号要进 `mat/sync`，落一个不存在
 * 的号进去，"清单落到哪儿了"从此说不准——下一句 `--since` 也对不上。
 *
 * 退出码：0 落好了（用了哪一档由 `--json` 的 `strategy` 说）· 1 做不成（没 fork 过 · 挂不动 ·
 * 落不下）· 2 命令行本身不成立。
 */
async function ensureCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const toRaw = flags.get('to')
  let want: ViewRev | undefined
  if (typeof toRaw === 'string') {
    const n = Number(toRaw)
    if (!Number.isInteger(n) || n < 0) return usageFail('--to 要一个非负整数修订号')
    want = n
  }
  const abs = resolve(root)
  // **要变更序列，所以不看快照**：`diff(since < 快照的 rev)` 答不了，那句限制是结构性的（§ 9.4）。
  const ctx = await openCtx(abs, flags, { history: true, upToRev: want })
  try {
    const upTo = want ?? ctx.view.rev
    if (!ctx.view.revs.includes(upTo)) {
      return fail(
        `ensure：rev ${upTo} 不是一个修订点\n可用的有 ${ctx.view.revs.join(' · ')}（fugue revs 列的就是它们）`,
      )
    }
    const res = await ensure(
      {
        roots: createRoots(abs),
        log: ctx.log,
        root: abs,
        opt: DEFAULT_MATERIALIZE,
        // 视图那一侧的读口：M4 不 import M2，所以由这里接上（§ 8.3：两者只共享 `Delta`）。
        view: {
          stat: (p) => ctx.view.stat(p),
          read: (p) => ctx.view.read(p),
          deltasSince: (from) => ctx.view.diff(from),
        },
      },
      agentFor(ctx.writer),
      upTo,
    )
    if (json) {
      emitJson({
        agent: res.agent,
        from: res.from,
        to: res.to,
        strategy: res.strategy,
        merged: res.merged,
        upper: res.upper,
        landed: res.landed,
        untouched: res.untouched,
        whiteouts: res.whiteouts,
        pruned: res.pruned,
        touched: res.touched,
        noop: res.noop,
        ms: res.ms,
        platform: res.facts,
      })
    } else {
      // 过程走 stderr（§ 9.8 的 stdout 纪律）：stdout 上那一行是合并树的坐标，与 `fork` 一致。
      process.stderr.write(
        res.noop
          ? `rev ${res.to} 已是最新：没有 delta 要落\n`
          : `rev ${res.from} → ${res.to} · 落地 ${res.landed.length} 条` +
            `${res.whiteouts === 0 ? '' : `（${res.whiteouts} 条 whiteout）`} · 原样 ${res.untouched.length} 条` +
            `${res.pruned === 0 ? '' : ` · 清掉空目录 ${res.pruned} 个`} · ${res.ms} ms · ${res.strategy} 档\n`,
      )
      emitLine(res.merged)
    }
    return 0
  } catch (err) {
    if (err instanceof EnsureRefused) return fail(err.why)
    if (err instanceof MountError || err instanceof LandError) return fail(err.message)
    throw err
  } finally {
    await ctx.close()
  }
}

/** `p` 是不是在 `dir` 这棵树里。两边都已经 `resolve` 过；`dir` 自己不算"在树里"。 */
function insideTree(dir: string, p: string): boolean {
  const rel = relative(dir, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 最外面那一层只做一件事：**把用法错翻成退出码 2**（§ 9.8 的退出码行）。
 *
 * 判据是"这条命令行本身就不成立"。它与"做不成"（1）分开是有用的：脚本要能一眼分出
 * "我敲错了"与"我敲对了，只是这件事没成"。
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv)
  } catch (err) {
    if (err instanceof UsageError) return usageFail(err.message)
    throw err
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const { flags, positional } = parseArgv(argv)
  const json = flags.has('json')
  const rootFlag = flags.get('root')
  const root = typeof rootFlag === 'string' ? rootFlag : process.cwd()
  const cmd = positional[0]

  // `--help` 是一条成功的命令；什么都不给是用法错——两者的退出码不一样。
  if (flags.has('help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (cmd === undefined) return usageFail('需要一个命令')

  // 落点先探（架构 § 15.7 的 E1）。**E1 是硬要求，所以这里是拒绝启动，不是降级运行**：
  // 落在 9p / drvfs 那一类跨内核的落点上时，失败模式是静默的（§ 15.8 的"不成立"档）。
  // 根还不存在时探它最近的祖先（`host.ts`），所以这条检查不依赖"目录已经建好"；
  // `--help` 在上面，不受影响。
  try {
    assertHost(root)
  } catch (err) {
    if (err instanceof HostError) return fail(err.message)
    throw err
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

  if (cmd === 'replay') return await replay(root, flags, json)

  if (cmd === 'commit') {
    const msg = flags.get('m')
    if (typeof msg !== 'string' || msg === '') return usageFail('commit 需要 -m <msg>')
    const ctx = await openCtx(root, flags, { sync: 'each' })
    try {
      return await commit(ctx, msg, json)
    } finally {
      await ctx.close()
    }
  }

  // 配置不建视图、不读日志：它是工作区的输入，不是它的状态（§ 15.3.a 末段）。
  if (cmd === 'config') return await config(root, positional.slice(1), json)

  // 尺子只读，也不进那份"状态"——所以它排在视图之前（§ 8.5 把 diff-stat 与 verify-mat 并列只读）。
  if (cmd === 'diff-stat') return diffStatCmd(root, flags, positional.slice(1), json)
  if (cmd === 'fork') return await forkCmd(root, flags, positional.slice(1), json)
  if (cmd === 'ensure') return await ensureCmd(root, flags, positional.slice(1), json)

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
      const ctx = await openCtx(root, flags, { history: true })
      try {
        const deltas = ctx.view.diff(since)
        if (json) emitJson(deltas.map(deltaJson))
        else for (const d of deltas) emitLine(deltaLine(d))
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'revs': {
      // 检视组的一条（§ 9.6）：输出就是 `View.revs` 这个字段（§ 8.3）。**不看历史**——
      // 修订点跟着状态走，快照带着它，所以从快照起的视图答得一样全，这也是
      // `replay --verify` 把 `revs` 列进比对项的原因。
      const ctx = await openCtx(root, flags)
      try {
        const revs = ctx.view.revs
        if (json) emitJson(revs)
        else for (const r of revs) emitLine(String(r))
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'write':
    case 'remove':
    case 'rename':
    case 'chmod': {
      // 参数先收齐，再开视图：一条用法错的命令不该在磁盘上留下任何东西。
      const delta = await deltaFrom(cmd, args, flags)
      const ctx = await openCtx(root, flags)
      try {
        const rev = await applyEdit(
          { log: ctx.log, truth: ctx.truth, view: ctx.view, writer: ctx.writer },
          delta,
        )
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

/**
 * `fugue replay [--to <rev>]` / `fugue replay --verify`（§ 9.6 的重放组）。
 *
 * **只读。** 它同时是 S1 的验收脚本与崩溃恢复实验的探针：一个写者被杀之后，第一条要跑的
 * 就是它——所以它不能在坏现场上再写什么。
 */
async function replay(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const toRaw = flags.get('to')
  let upToRev: ViewRev | undefined
  if (typeof toRaw === 'string') {
    const n = Number(toRaw)
    if (!Number.isInteger(n) || n < 0) return usageFail('--to 要一个非负整数修订号')
    upToRev = n
  }
  const only = flags.get('agent')
  const log = openLog(root)
  let truth: TruthHandle | null = null
  const t0 = Date.now()
  try {
    truth = openTruth(root)
    if (flags.has('verify')) {
      const writers = typeof only === 'string' ? [only as WriterId] : await log.writers()
      if (writers.length === 0) {
        if (json) emitJson({ ok: true, agents: [] })
        else emitLine('还没有任何 writer 写过日志：没有可重放的视图')
        return 0
      }
      return await verify(root, log, truth, writers, upToRev, json)
    }
    const writer = writerOf(flags)
    const lower = await lowerFor(truth, writer)
    const snap = await readSnapshot(root, writer, upToRev === undefined ? {} : { upToRev })
    const view = await loadView(
      log,
      writer,
      snap === null ? { lower, upToRev } : { lower, upToRev, snap },
    )
    const entries = await snapshotOf(view)
    const ms = Date.now() - t0
    const from =
      snap === null ? { kind: 'genesis' } : { kind: 'snapshot', seq: snap.seq, rev: snap.state.rev }
    if (json) emitJson({ agent: writer, rev: view.rev, base: view.base, from, entries, ms })
    else {
      const where =
        snap === null ? '从 0 全量重放' : `从快照 seq ${snap.seq}（rev ${snap.state.rev}）起`
      emitLine(`${view.rev}\t${view.base ?? '(没有提交)'}\t${entries.length} 个条目\t${where}`)
    }
    return 0
  } finally {
    await log.close()
    if (truth !== null) await truth.close()
  }
}

/** 条目表压成一行可比对的字：走目录的顺序不该参与判定。 */
function entryKey(rows: TreeEntry[]): string {
  return rows
    .map((r) => `${r.mode.toString(8)} ${r.id} ${r.name}`)
    .sort()
    .join('\n')
}

/** 变更压成一行可比对的字。**`add` 与 `modify` 要分开**——它由日志前缀决定，不是细节。 */
function deltaKey(d: Delta): string {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return `${d.kind} ${d.path} ${d.mode.toString(8)} ${d.bytes.length} ${createHash('sha1').update(d.bytes).digest('hex')}`
    case 'symlink':
      return `symlink ${d.path} → ${d.target}`
    case 'delete':
      return `delete ${d.path}`
    case 'rename':
      return `rename ${d.from} → ${d.to}`
    case 'chmod':
      return `chmod ${d.path} ${d.mode.toString(8)}`
  }
}

/**
 * 两份视图是不是同一份：`rev` · `base` · `revs` · 全量读出 · 变更序列（从 `since` 起）。
 *
 * `since` 是给从快照起的视图留的：它答不了比快照更早的变更序列，所以两边都从快照那个
 * 修订点比起——**这正是"快照换掉的是历史，不是状态"的可测形式**。
 */
function sameView(
  a: View,
  aRows: TreeEntry[],
  b: View,
  bRows: TreeEntry[],
  since: ViewRev,
): boolean {
  if (a.rev !== b.rev || a.base !== b.base) return false
  if (JSON.stringify(a.revs) !== JSON.stringify(b.revs)) return false
  if (entryKey(aRows) !== entryKey(bRows)) return false
  const x = a.diff(since).map(deltaKey)
  const y = b.diff(since).map(deltaKey)
  return x.length === y.length && x.every((k, i) => k === y[i])
}

/**
 * `--verify`：逐 agent 重建视图，比对 `rev` · 全量读出 · `diff()` · `revs`（§ 9.6）。
 *
 * **两条独立的重建路径对着同一条日志，各走一遍**：
 *
 *   1. 按 writer 读（`readByWriter`） 与 按交错全序读再筛（`mergedFace`）
 *   2. 从 0 全量重放 与 从快照起再重放尾部
 *
 * 第 2 条就是"快照是纯加速项"的验收——它把快照删掉只是慢，不会不一样；第 1 条是"重建结果
 * 只由自己的操作决定"的验收——交错序里夹着别人的事件，读出来的还是自己那份。
 */
async function verify(
  root: string,
  log: LogHandle,
  truth: TruthHandle,
  writers: WriterId[],
  upToRev: ViewRev | undefined,
  json: boolean,
): Promise<number> {
  const reports: Record<string, unknown>[] = []
  let bad = 0
  for (const writer of writers) {
    const checks: { what: string; ok: boolean; detail?: string }[] = []
    let rev = 0
    let count = 0
    let snapInfo: Record<string, unknown> | null = null
    try {
      const lower = await lowerFor(truth, writer)
      const full = await loadView(log, writer, { lower, upToRev })
      const want = await snapshotOf(full)
      rev = full.rev
      count = want.length

      const inter = await loadView(mergedFace(log, writer), writer, { lower, upToRev })
      checks.push({
        what: '交错读 == 按 writer 读',
        ok: sameView(full, want, inter, await snapshotOf(inter), 0),
      })

      const snap = await readSnapshot(root, writer, upToRev === undefined ? {} : { upToRev })
      if (snap === null) {
        checks.push({
          what: '从快照起 == 从 0 起',
          ok: true,
          detail: '没有快照：这一路只跑了全量重放',
        })
      } else {
        snapInfo = { seq: snap.seq, rev: snap.state.rev }
        const fast = await loadView(log, writer, { lower, upToRev, snap })
        checks.push({
          what: `从快照 seq ${snap.seq}（rev ${snap.state.rev}）起 == 从 0 起`,
          ok: sameView(full, want, fast, await snapshotOf(fast), snap.state.rev),
        })
      }
    } catch (err) {
      checks.push({
        what: '重建',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
    const ok = checks.every((c) => c.ok)
    if (!ok) bad++
    reports.push({ writer, ok, rev, entries: count, snapshot: snapInfo, checks })
    if (!json) {
      emitLine(`${ok ? 'ok  ' : 'FAIL'}\t${writer}\trev ${rev}\t${count} 个条目`)
      for (const c of checks) {
        const mark = c.ok ? '·' : '×'
        const detail = c.detail === undefined ? '' : `（${c.detail}）`
        if (!c.ok || c.detail !== undefined) emitLine(`      ${mark} ${c.what}${detail}`)
      }
    }
  }
  if (json) emitJson({ ok: bad === 0, agents: reports })
  else if (bad === 0) emitLine(`${writers.length} 个视图全部一致`)
  if (bad !== 0) return fail(`${bad} 个视图没有通过重放比对`)
  return 0
}

/**
 * 用法错：**这条命令行本身就不成立**——参数缺了 · 模式不是八进制 · 动词不认识。§ 9.8 给了它
 * 自己的退出码（2），与"做不成"（1）分开是有用的：`read` 一个不存在的路径是一次成立的请求
 * 得到的一个结果，而 `write` 少一个来源根本不是一次请求。
 */
class UsageError extends Error {}

/**
 * 把命令行收成一个 delta。**这一步不开视图、不读日志**——参数不对的命令不该在磁盘上留下
 * 任何东西，而"先建再检查"会让一条用法错的命令也留下一个日志目录。
 *
 * 四条写命令共用它；与模型侧共用的是更下面那次 `applyEdit`——这里只做参数那一半。
 */
async function deltaFrom(
  cmd: string,
  args: string[],
  flags: Map<string, string | true>,
): Promise<Delta> {
  switch (cmd) {
    case 'write': {
      const p = args[0]
      if (p === undefined) throw new UsageError('write 需要 <path>')
      const from = flags.get('from')
      let bytes: Uint8Array
      if (typeof from === 'string') bytes = readFileSync(from)
      else if (flags.has('stdin')) bytes = await readStdin()
      else throw new UsageError('write 需要 --from <file> 或 --stdin')
      // 默认 644；要可执行就再敲一条 chmod——两条命令各说一件事，不从写里猜。
      return { kind: 'add', path: p, bytes, mode: 0o100644 }
    }
    case 'remove': {
      const p = args[0]
      if (p === undefined) throw new UsageError('remove 需要 <path>')
      return { kind: 'delete', path: p }
    }
    case 'rename': {
      const from = args[0]
      const to = args[1]
      if (from === undefined || to === undefined) throw new UsageError('rename 需要 <from> <to>')
      return { kind: 'rename', from, to }
    }
    default: {
      const p = args[0]
      const mode = args[1]
      if (p === undefined || mode === undefined) throw new UsageError('chmod 需要 <path> <mode>')
      return { kind: 'chmod', path: p, mode: parseOctal(mode) }
    }
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
        // 日志在哪，由 `--root` 说了算——壳让人在任何目录里敲这条命令，而"我在哪"与
        // "它的日志在哪"是两件事。默认值仍是 cwd（`run` 里那一句）。
        const asked = parseArgv(process.argv.slice(2)).flags.get('root')
        process.stderr.write(`日志损坏，拒绝加载 —— ${err.message}\n`)
        process.stderr.write(`日志目录：${logDir(typeof asked === 'string' ? asked : process.cwd())}\n`)
      } else {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      }
      process.exit(1)
    })
}
