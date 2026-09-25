// 工具的那道缝的产品实现：**视图 + 围栏 + 真源**接成一份 `ToolHost`。出处：架构 § 8.9 那四条
// 推论各自的落点（`M4.ensure` · `M3.Roots.resolveVirtual` · `M7.confine` · `M6` 反向通道）·
// § 8.10 的工具目录 · § 9.6（`checkpoint` 与 `fugue commit` 是同一个操作）。
//
// **为什么这一份住在 `src/tools/` 而不是住在命令行里**：工具面的实现只该有一处。"围栏怎么过 ·
// 写落成哪种 delta · 提交走哪条路"这三件事在命令行那一面已经有过一次（`fugue write` ·
// `fugue commit`），模型侧那一面照抄一遍就是第二处——两处漂移的表现是"同一次写，模型与人得到
// 两个结果"，而那不报错。`checkpoint.ts` 顶部那条理由逐字适用于这里。
//
// **它不认识模型、不认识线协议。** 上一层的接线归 `capability/dispatch.ts`。
import { spawn } from 'node:child_process'
import type { Log } from '../log/events.ts'
import type { Truth } from '../truth/contract.ts'
import type { TreeEntry } from '../entries.ts'
import { normMode } from '../delta.ts'
import type { Delta } from '../delta.ts'
import type { AgentId, CommitId, RelPath, WriterId } from '../terms.ts'
import type { Denied as FenceDenied, Roots } from '../roots/contract.ts'
import { applyEdit } from '../view/edit.ts'
import { snapshotOf } from '../view/snapshot.ts'
import type { View } from '../view/contract.ts'
import { checkpoint } from '../checkpoint.ts'
import type { RunReply } from './execute.ts'
import type { ActionAsk, AskItem, DenyAsk, EditRaw, PlanAsk, RunAsk, TodoItem, ToolHost, ToolListing } from './execute.ts'
import { refuse } from './execute.ts'
import { shellArgv } from '../capability/dispatch.ts'
import { digestOf } from '../runtime/restart.ts'

/** 走多远就停。**两条都是必须的**：软链穿过去就绕开了路径围栏（§ 8.4 的 `through-symlink`），
 * 而不封顶的深树能把一步走成挂死。 */
const MAX_DEPTH = 24
const MAX_ROWS = 5000

/** 落日志与提交要的那一半（读与写视图那一半在 `view` 里）。 */
export interface HostActions {
  readonly writer: WriterId
  readonly log: Log
  readonly truth: Truth
  /** 这一次提交铺在哪个提交上（`View.base`）——它同时是 parent 与 CAS 的期望。 */
  readonly expectedOld: CommitId | null
}

export interface HostOptions {
  /** 起一个进程要什么：命令行 · cwd · 超时。**怎么关起来归调用方**（`M7` 包命令行 · `M5` 起进程）。 */
  readonly commandFor?: (ask: RunAsk) => { readonly argv: readonly string[]; readonly cwd: string }
  /** 没有它这一份宿主只能读：写与提交会改视图，而视图的每一次变更都要落日志（§ 9.3 的顺序）。 */
  readonly actions?: HostActions
}

/**
 * 一份 `ToolHost`。
 *
 * `view` 是读与写的唯一去处（写走 `view/edit.ts` 那一份：blob → 日志 → 内存，顺序在那儿）；
 * `roots` 只用来过围栏——**它不拼物理路径**：这一档里文件的字节住在视图的上层，不在物化出来的
 * 那棵树上（`B6` 把"执行前物化"接上时，`bash` 那一条才真的落在树里）。
 */
export function createToolHost(view: View, roots: Roots, opts: HostOptions = {}): ToolHost {
  const parts = opts.actions

  async function deny(d: DenyAsk): Promise<void> {
    // 没有日志口就不记（夹具档与单测里那几份宿主就是这样）——但**有口就一定要记**：
    // "模型看见它为什么不行"与"日志里有一次拒"是同一件事的两个面，不该只发生一半。
    if (parts === undefined) return
    await parts.log.append(parts.writer, {
      t: 'bound/deny',
      agent: view.id,
      path: d.path,
      space: d.space,
      rule: d.rule,
    })
  }

  /** 过一道围栏。**这是 `M3` 的 `resolveVirtual` 被工具面调到的唯一一处**（架构 § 8.4）。 */
  async function fence(
    raw: string,
    cwd: string,
  ): Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string }> {
    const got = roots.resolveVirtual(raw, cwd as RelPath)
    if (got.ok) return { ok: true, value: got.value }
    const d: FenceDenied = got.error
    await deny(refuse(`fence:${d.kind}`, d.message, d.raw, 'virtual'))
    return { ok: false, message: d.message }
  }

  /** 一次变更落下去（`view/edit.ts` 那一份：blob → 日志 → 内存。校验在追加之前，在那儿）。 */
  async function change(d: Delta): Promise<{ readonly rev: number; readonly changed: boolean }> {
    if (parts === undefined) {
      throw new Error(
        '这一份宿主没有接上日志：写会改视图，而视图的每一次变更都要先落日志（架构 § 9.3 的顺序）——请给 options.actions。',
      )
    }
    const r = await applyEdit({ view, truth: parts.truth, log: parts.log, writer: parts.writer }, d)
    return { rev: r.rev, changed: r.changed }
  }

  async function writeBytesOf(rel: string, bytes: Uint8Array): Promise<{ readonly rev: number }> {
    const path = rel as RelPath
    // 新增还是改写**只有视图答得对**（`View.kindOf`：只看上层——下层会随 base 前移而变）。
    const kind = view.kindOf(path)
    const d: Delta =
      kind === 'add'
        ? { kind: 'add', path, bytes, mode: normMode(0o100644) }
        : { kind: 'modify', path, bytes, mode: normMode(0o100644) }
    const r = await change(d)
    return { rev: r.rev }
  }

  async function readBytesOf(rel: string): Promise<{ readonly bytes: Uint8Array; readonly mode: number } | null> {
    const path = rel as RelPath
    const meta = await view.stat(path)
    // 只读文件：目录与软链不给字节（给出去的必须是"那个文件的字节"，不是它的形状）。
    if (meta === null || meta.kind !== 'file') return null
    const bytes = await view.read(path)
    if (bytes === null) return null
    return { bytes, mode: normMode(meta.mode) }
  }

  async function walk(): Promise<readonly string[]> {
    const out: string[] = []
    const step = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || out.length >= MAX_ROWS) return
      const rows = await view.list(dir as RelPath)
      for (const row of rows) {
        if (out.length >= MAX_ROWS) return
        const path = dir === '' ? row.name : `${dir}/${row.name}`
        // **软链不跟**：它指向的东西不在视图的可达集里（§ 8.4 的 `through-symlink`）。
        if (row.kind === 'dir') await step(path, depth + 1)
        else if (row.kind === 'file') out.push(path)
      }
    }
    await step('', 0)
    return out
  }

  /**
   * 子进程从哪儿起步：**视图内的路径 → 这个根下的物理落点**（`M3` 的 `toPhysical`）。
   *
   * **空串就是根**——与围栏那一侧同一个意思（`roots.resolveVirtual(path, '')` 也把空 cwd 读成根），
   * 而这一处原先落成 `process.cwd()`：那是**发出这条命令的人**的当前目录，不是这一格的根。后果
   * 不是报错，是"工具在一棵别的树上干活"：`fugue round run --root /tmp/w` 从 `~/fugue` 里发出去
   * 时，模型那一条 `find .` 跑在产品仓库上，它于是看见 187 个文件的树、永远看不到这一格刚写的那
   * 一份——**模型据此绕圈，而命令面照旧报成功**（第一次联网验证量到的就是它：四步全在 `find`，
   * `写 0 条`，退出码 0）。
   */
  function workdirOf(cwd: string): string {
    return roots.toReal(cwd as RelPath)
  }

  async function runWith(ask: RunAsk, userArgv: readonly string[], cwd: string): Promise<RunReply> {
    const timeoutMs = ask.timeoutMs
    // **命令行只拼这一处**：`commandFor` 给了就用它（那是调用方"怎么关起来"的那一半——`M7` 包
    // 命令行），没给就是"交给 shell"。所以工具面那一层不用知道沙箱存不存在。
    const made = opts.commandFor?.(ask)
    const argv = made?.argv ?? userArgv
    // 沙箱那一档给的（`made.cwd`）是**绝对**落点：`M7` 包命令行时 `--chdir <物化根>/<cwd>` 与
    // 这里拼的是同一个根。相对路径交给 `spawn` 会按进程自己的目录解——那是同一个坑换一层。
    const workdir = made?.cwd ?? workdirOf(cwd)
    const t0 = Date.now()
    let stdout = ''
    let stderr = ''
    let exit = 1
    let timedOut = false
    await new Promise<void>((done) => {
      const child = spawn(argv[0] ?? '/bin/sh', argv.slice(1), { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] })
      let timer: NodeJS.Timeout | null = null
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (s: string) => {
        stdout += s
      })
      child.stderr.on('data', (s: string) => {
        stderr += s
      })
      child.on('error', (e: Error) => {
        stderr += `${e.message}\n`
        done()
      })
      child.on('close', (code: number | null) => {
        exit = code ?? 1
        if (timer !== null) clearTimeout(timer)
        done()
      })
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
      }
    })
    return { exit, ms: Date.now() - t0, denied: false, stdout, stderr: (timedOut ? `超过 ${timeoutMs} 毫秒被掐掉\n` : '') + stderr }
  }

  return {
    readBytes: readBytesOf,
    writeBytes: writeBytesOf,

    async edit(rel, raw: EditRaw) {
      const path = rel as RelPath
      if (raw.kind === 'rename') {
        const r = await change({ kind: 'rename', from: path, to: raw.to as RelPath })
        return { rev: r.rev, changed: r.changed }
      }
      if (raw.kind === 'chmod') {
        const r = await change({ kind: 'chmod', path, mode: raw.mode })
        return { rev: r.rev, changed: r.changed }
      }
      // **替换按"整串恰好出现一次"判。** 0 次与 2 次都拒（拒的话说清是哪种），因为"猜他想改
      // 哪一处"是静默的错误。架构 § 8.10 只给了 `edit` 这个工具名，没定匹配语义——所以这里取
      // 最保守的那一格，并把这一条写进疑点。
      const got = await readBytesOf(rel)
      if (got === null) throw new Error(`视图里没有这个文件：${rel}`)
      const before = Buffer.from(got.bytes).toString('utf8')
      const at = before.indexOf(raw.find)
      if (at === -1) {
        throw new Error(`没有找到要被替换的那段文本（${raw.find.length} 个字符）——用 write 写一整份，或者把 find 写成原样的那一段。`)
      }
      if (before.indexOf(raw.find, at + raw.find.length) !== -1) {
        throw new Error(`那段文本在 ${rel} 里出现了不止一次——edit 一次只改一处，请把 find 写到只匹配那一处。`)
      }
      const after = before.slice(0, at) + raw.replace + before.slice(at + raw.find.length)
      const r = await writeBytesOf(rel, new Uint8Array(Buffer.from(after, 'utf8')))
      return { rev: r.rev, changed: true }
    },

    async list(dir) {
      const rows = await view.list(dir as RelPath)
      return rows.map(
        (r): ToolListing => ({
          name: r.name,
          kind: r.kind === 'file' ? 'file' : r.kind === 'dir' ? 'dir' : r.kind === 'symlink' ? 'symlink' : 'other',
          size: r.size,
        }),
      )
    },

    walk,

    async run(ask: RunAsk) {
      return runWith(ask, shellArgv(ask.command), ask.cwd)
    },

    async runAction(ask: ActionAsk) {
      // **回写那一条今天没有接上**：架构 § 8.9 说执行类的产出经声明集回写视图（`M6` 的反向通道），
      // 而声明集是 `fugue run` 那一趟的（`reclaim.declare`）。所以这一格跑得起来，产出却留在
      // 沙箱里、不进视图——回写接上之前，它不比 `bash` 多什么。
      const asRun: RunAsk = { command: ask.action, cwd: ask.cwd, timeoutMs: null }
      return runWith(asRun, shellArgv(ask.action), ask.cwd)
    },

    async checkpoint(msg) {
      if (parts === undefined) {
        throw new Error('这一份宿主没有接上日志与真源：提交要落日志（架构 § 9.6）——请给 options.actions。')
      }
      const entries: TreeEntry[] = await snapshotOf(view)
      const r = await checkpoint({
        log: parts.log,
        truth: parts.truth,
        writer: parts.writer,
        entries,
        rev: view.rev,
        msg,
        expectedOld: parts.expectedOld,
      })
      return { commit: String(r.commit) }
    },

    async askUser(asks: readonly AskItem[]) {
      if (parts === undefined) return
      const body = JSON.stringify({ questions: asks })
      await parts.log.append(parts.writer, { t: 'holder/ask', agent: view.id, digest: digestOf(body), body })
    },

    async declarePlan(ask: PlanAsk) {
      // 与 `deny` · `setTodos` 同一条规矩：没有日志口就不记，有口就一定记。
      if (parts === undefined) return
      const body = JSON.stringify(ask)
      await parts.log.append(parts.writer, { t: 'holder/plan', agent: view.id, digest: digestOf(body), body })
    },

    async setTodos(list: readonly TodoItem[]) {
      // 与 `deny` 同一条规矩：**没有日志口就不记**（夹具档与单测里那几份宿主），有口就一定记。
      if (parts === undefined) return { count: list.length }
      const body = JSON.stringify({ todos: list })
      await parts.log.append(parts.writer, { t: 'holder/todos', agent: view.id, digest: digestOf(body), body })
      return { count: list.length }
    },

    deny,
  }
}

/** 从 `<root>` 起一份真源与一份日志（模型侧那一面**不经过命令行**的一条路：`B5` 的断言 ⑤ 用它）。 */
export async function openHostParts(
  root: string,
  writer: WriterId,
): Promise<{
  readonly truth: Truth
  readonly log: Log & { readonly close: () => Promise<void> }
  readonly close: () => Promise<void>
}> {
  const { openLog } = await import('../log/log.ts')
  const { openTruth } = await import('../truth/truth.ts')
  const truth = openTruth(root)
  const log = openLog(root, { write: writer, sync: 'each' })
  return {
    truth,
    log,
    close: async () => {
      await log.close()
      await truth.close()
    },
  }
}
