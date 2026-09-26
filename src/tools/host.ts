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
import type { AgentId, CommitId, RelPath, ViewRev, WriterId } from '../terms.ts'
import type { Denied as FenceDenied, Roots } from '../roots/contract.ts'
import { applyEdit } from '../view/edit.ts'
import { snapshotOf } from '../view/snapshot.ts'
import type { View } from '../view/contract.ts'
import { checkpoint } from '../checkpoint.ts'
import type { RunReply } from './execute.ts'
import type { ActionAsk, AskItem, DenyAsk, EditRaw, PlanAsk, RunAsk, TodoItem, ToolHost, ToolListing } from './execute.ts'
import { refuse } from './execute.ts'
import { shellArgv } from './argv.ts'
import { digestOf } from '../runtime/restart.ts'
import { join } from 'node:path'
import type { ForkStrategy } from '../terms.ts'
import type { ForkResult } from '../materialize/fork.ts'
import { ensure } from '../materialize/ensure.ts'
import type { EnsureResult } from '../materialize/ensure.ts'
import { matState } from '../materialize/manifest.ts'
import type { MatState } from '../materialize/manifest.ts'
import { isMounted, unmountOverlay } from '../materialize/mount.ts'
import { matParts } from '../roots/paths.ts'
import { lowerAt } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import type { Reclaim, DeclaredSet } from '../execute/reclaim.ts'
import type { AbsPath } from '../terms.ts'

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
  /**
   * 起一个进程要什么：命令行 · cwd · 超时。**怎么关起来归调用方**（`M7` 包命令行 · `M5` 起进程）。
   *
   * 可以返回一个承诺：包命令行那一步要读这一格的策略值（那一层在不在场），而策略值现探。
   */
  readonly commandFor?: (
    ask: RunAsk,
  ) => { readonly argv: readonly string[]; readonly cwd: string } | Promise<{ readonly argv: readonly string[]; readonly cwd: string }>
  /** 没有它这一份宿主只能读：写与提交会改视图，而视图的每一次变更都要落日志（§ 9.3 的顺序）。 */
  readonly actions?: HostActions
  /**
   * **这一格的写入面**（架构 § 8.9 那条反向通道的声明集）。W8 起它是**契约的写入面**
   * （`contract/types.ts` 的 `declaredSetOf`），由调用点递进来——不开新配置面。
   *
   * 给了它，执行类工具跑完就把声明集内的差异从物化根读回视图（`collect`），并把集外的改动
   * 记一条 `mat/reclaim`。**没给就是“这条反向通道没接上”**：`bash` 跑得起来，产出却留在物化树里不进视图。
   */
  readonly ownedPaths?: readonly RelPath[]
  /**
   * 回收那一份（`M6`）。**由调用点装配**：它要的减数（清单 · 落点 · 树敞开与否）都是
   * 这一格的机制事实，而宿主不该知道怎么探它们。
   */
  readonly reclaim?: Reclaim
  /**
   * **在哪一棵树上执行**（执行面）。不给就没有物化：执行类工具跑在 `roots.toReal('')` 上——
   * 那是 W8 之前的形状，夹具与单测照旧走它。
   */
  readonly execRoot?: {
    readonly log: Log
    /** 这一格是哪个 writer（视图与物化都按它索引）。 */
    readonly writer: WriterId
    /** `base` 那一份的读口：`ensure` 要拿它当 delta 的下层（`mat/fork.base`）。 */
    readonly truth: Truth
    readonly base: CommitId | null
    readonly forkOf: (parts: { upper: AbsPath; merged: AbsPath; temp: AbsPath }) => Promise<ForkResult>
    /** 每次问答完执行面之后的那一下（**给调用点记账用**）。 */
    readonly onState?: (r: { readonly root: string; readonly strategy: ForkStrategy | null }) => void
    /**
     * **这一趟落下去的清单**（`ensure` 的 `manifest`），每次同步之后交出去。
     *
     * 回收那一侧要它当减数：`upper` 里本来就有东西（`ensure` 把视图的 delta
     * 落在那儿），“子进程改了什么”只能是“枚举到的 − 清单里的”（架构 § 8.7）。
     * 少这一减，第二趟运行会把上一趟的产出当成越声明（**本地实测撞到过**）。
     */
    readonly onSync?: (manifest: readonly RelPath[]) => void
  }
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

  // ── 执行面（W8：视图是读面，物化根是执行面）──────────────────────────
  //
  // **账不新开：起跑重放一次，格内只缓存。** 物化那一侧从 `mat/*` 事件重放出 `forked · rev · 清单`
  // （`matState`，“物化读日志、不写日志”）；这一格是唯一的写者，每次自己写完之后同步它。
  // 缓存里的 `rev` 与清单就是“物化落到哪儿了”那一份事实——不是第二处状态。
  let mat: { parts: { upper: AbsPath; merged: AbsPath; temp: AbsPath }; state: MatState } | null = null

  /**
   * 视图在这一条声明路径下**动过**什么——回写那一支里删除那一条的源一。
   */
  function writtenNow(rel: RelPath): { readonly paths: readonly RelPath[]; readonly dead: ReadonlySet<RelPath> } {
    const out: RelPath[] = []
    const dead = new Set<RelPath>()
    for (const e of view.state().upper) {
      if (e.path !== rel && !e.path.startsWith(rel + '/')) continue
      if (e.kind === 'tombstone') dead.add(e.path)
      else out.push(e.path)
    }
    return { paths: [...out, ...dead].sort(), dead }
  }

  /**
   * **执行面在哪儿**（`ToolHost.execCwd`）。第一次被问到时才 fork——纯 `write`/`read` 的格
   * 不付这份钱；之后每次把视图此刻的 delta 铺过去（rev 没变就是 `noop`）。
   */
  async function execCwd(): Promise<{ readonly root: string; readonly strategy: ForkStrategy | null }> {
    const cfg = opts.execRoot
    if (cfg === undefined) return { root: roots.toReal('' as RelPath), strategy: null }
    const tell = (r: { readonly root: string; readonly strategy: ForkStrategy | null }) => {
      cfg.onState?.(r)
      return r
    }
    if (mat === null) {
      const me = view.id as unknown as AgentId
      const st = await matState(cfg.log, me)
      const where = matParts(roots.realRoot, me)
      mat = { parts: where, state: st }
      if (!st.forked) {
        const r = await cfg.forkOf(where)
        mat.state = { forked: true, base: r.base, strategy: r.strategy, rev: 0, paths: [], hashes: [] }
        return tell({ root: where.merged, strategy: r.strategy })
      }
    }
    const now = await loadView(cfg.log, cfg.writer, { lower: lowerAt(cfg.truth, mat.state.base) })
    const out = await syncTo(now, now.rev)
    return tell({ root: mat.parts.merged, strategy: out.strategy })
  }

  /** 把视图的 delta 落到物化树（`M4.ensure`），并同步格内那份缓存。 */
  async function syncTo(now: View, upTo: ViewRev): Promise<EnsureResult> {
    const cfg = opts.execRoot
    if (cfg === undefined || mat === null) throw new Error('这一份宿主没有接上执行面：execRoot 没给。')
    const out = await ensure(
      {
        roots,
        log: cfg.log,
        root: roots.realRoot,
        view: {
          stat: (p) => now.stat(p),
          read: (p) => now.read(p),
          rev: now.rev,
          deltasSince: (from) => now.diff(from),
          tombstones: () => now.state().upper.filter((e) => e.kind === 'tombstone').map((e) => e.path),
        },
        base: lowerAt(cfg.truth, mat.state.base),
        state: mat.state,
      },
      now.id as unknown as AgentId,
      upTo,
    )
    mat.state = {
      forked: true,
      base: mat.state.base,
      strategy: out.strategy,
      rev: out.to,
      paths: [...out.manifest],
      hashes: [],
    }
    cfg.onSync?.(out.manifest)
    return out
  }

  /** 子进程的工作目录：**相对 cwd 拼到执行根上**。空串是根。 */
  function execWorkdir(exec: string, cwd: string): string {
    return cwd === '' ? exec : join(exec, cwd)
  }

  /** 旧格（没有物化）那一条路：视图内的路径 → 真实工作区里的落点。 */
  function workdirOf(cwd: string): string {
    return roots.toReal(cwd as RelPath)
  }

  async function runWith(ask: RunAsk, userArgv: readonly string[], cwd: string): Promise<RunReply> {
    const timeoutMs = ask.timeoutMs
    const exec = (await execCwd()).root
    const t0 = Date.now()
    let made: { readonly argv: readonly string[]; readonly cwd: string } | undefined
    try {
      made = await opts.commandFor?.(ask)
    } catch (err) {
      const why = (err as Error).message
      await afterRun()
      return { exit: 1, ms: Date.now() - t0, denied: true, stdout: '', stderr: why }
    }
    const argv = made?.argv ?? userArgv
    const workdir = opts.execRoot === undefined ? (made?.cwd ?? workdirOf(cwd)) : execWorkdir(exec, cwd)
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
    const reply: RunReply = {
      exit,
      ms: Date.now() - t0,
      denied: false,
      stdout,
      stderr: (timedOut ? `超过 ${timeoutMs} 毫秒被掉\n` : '') + stderr,
    }
    await afterRun()
    return reply
  }

  /**
   * 这一格的声明集：**跑之前 `declare`，跑完 `collect`**——两个调用，中间的 `ensure` 不管它。
   */
  function declaredNow(): DeclaredSet | null {
    const re = opts.reclaim
    if (re === undefined || opts.ownedPaths === undefined) return null
    const set = re.declare(view.id as unknown as AgentId, opts.ownedPaths)
    return {
      ...set,
      isDeclared: (rel) => writtenNow(rel).paths,
      isTombstone: (p) => view.state().upper.some((e) => e.kind === 'tombstone' && e.path === p),
    }
  }

  /**
   * **执行之后那一下**：把物化树里、声明集内的差异读回视图。
   */
  async function afterRun(): Promise<void> {
    const re = opts.reclaim
    const cfg = opts.execRoot
    const declared = declaredNow()
    if (re === undefined || cfg === undefined || mat === null || declared === null) return
    if (mat.parts.merged !== '' && isMounted(mat.parts.merged)) unmountOverlay(mat.parts.merged)
    const outside = await re.undeclared(view.id as unknown as AgentId, declared)
    if (outside.length > 0 && parts !== undefined) {
      await parts.log.append(parts.writer, {
        t: 'mat/reclaim',
        agent: view.id,
        declared: [...declared.paths],
        changed: [...outside],
      })
    }
    const deltas = await re.collect(view.id as unknown as AgentId, declared)
    for (const d of deltas) {
      // **已经落过的那一条跳过**：一条 `delete` 只在视图里还**有**它的时候才是一次真的变更。
      //
      // 两种情形都走这一条，而它们都不该再 `applyEdit` 一次：
      //   · **已经是墓碑**（本格的 `bash rm` 已经落过一次）；
      //   · **视图里压根没有它**（先删、随后又在同名路径下建了目录那一类）。
      // 不跳的话，`applyEdit` 会当场报“删除 `<p>`：这个路径不存在”（本地实测撞到的就是它）。
      if (d.kind === 'delete') {
        const tomb =
          declared.isTombstone === undefined
            ? view.state().upper.some((e) => e.kind === 'tombstone' && e.path === d.path)
            : declared.isTombstone(d.path)
        if (tomb || (await view.stat(d.path)) === null) continue
      }
      // 逐条走 `view/edit.ts` 那一份（blob → 日志 → 内存）——与 `write` 工具逐字节同一条路，
      // 所以“后写的赢”是结构，不是断言：最后落在视图里的那一版就是收尾提交的那一版。
      await applyEdit({ view, truth: cfg.truth, log: cfg.log, writer: cfg.writer }, d)
    }
  }
  return {
    readBytes: readBytesOf,
    execCwd,
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
