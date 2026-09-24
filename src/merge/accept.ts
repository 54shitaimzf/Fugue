// M13 验收与推进：**顺序就是那条承重不变量的形态**。出处：架构 § 8.14 的 4–7 步与那句
// 「真实工作树只被推进到已通过验收的状态」· § 8.14 的验证性质 · § 20 S7 的第二条与第四条验证 ·
// § 9.10（保留前缀不进真实工作树）· § 8.12 末段的三档结果 · PLAN § 5.7 的 A6 行。
//
// **这一份要守的就一句话**：验收没过，真实工作树**一个字节都不动**。
//
// 落到代码上，它是两条不同的路径，而在**签名**上就分开了：
//
//   `verify(root, assertions)`  只读：跑验收、给判决。它**收不到** `realRoot`——所以它没有
//                               一条路能碰到真实工作树。这是"顺序即不变量"最硬的那一半：
//                               不是"我记得先验收后推进"，是**验收那一步手里没有那个句柄**。
//   `commitThenAdvance(...)`    写：**先 `commit` 定格提交点，再 `advance` 真实工作树**。
//                               没通过时它提前返回，`advance` 那一段根本走不到。
//
// **验收跑在物化出来的那棵树上**（架构 § 8.14 第 5 步："装配体 verifyGate，跑在第 4 步那棵树
// 上"）——`verify` 的 `root` 参数就是那棵树的根，不是真实工作树。
//
// **保留前缀不进真实工作树**（§ 9.10）：`.fugue` 那几样在视图与提交里，而 `advance` 跳过它们
// ——既不改它们，也不删它们。
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AbsPath, CommitId, RelPath } from '../terms.ts'
import type { Assertion, AssertionResult, AssertionRun, Contract } from '../contract/types.ts'
import { resultOf } from '../contract/types.ts'
import { WORKSPACE_STATE } from '../materialize/diffstat.ts'
import { treeOfCommit } from '../merge/merge.ts'
import type { Truth } from '../truth/contract.ts'
import type { TreeEntry } from '../entries.ts'

/** 这一层自己的失败：验收跑不起来 · 推进时撞上写不动的东西。 */
export class AcceptError extends Error {}

/**
 * 一条断言的运行时形状：**给子进程的那一份**。
 *
 * 它与 `Assertion`（契约里那一份，`contract/types.ts`）分开是故意的：契约里的断言说的是
 * "哪一件事要跑"（动作名 · 期望退出码 · 在哪跑），而这里是"这一趟怎么起进程"（命令行 · 环境 ·
 * 工作目录）。**契约不认识命令行**——那正是 § 8.12 让 `Assertion` 只带动作名的理由；而这一份
 * 由 `M7` 的策略与 `M5` 的执行器给定，验收门因此与单个 agent 自检**走完全相同的执行机制**
 * （§ 14.6：把"跑断言"做成独立装配体，两个消费者共用）。
 */
export interface AssertionRunSpec {
  /** 契约里那一条（它的 `name` 与 `expect` 是判决的依据）。 */
  readonly assertion: Assertion
  /** 真起的那个命令行。 */
  readonly argv: readonly string[]
  /** 子进程的环境。**由调用方给全**——这一份不做环境继承的判断。 */
  readonly env: Record<string, string>
  /** 在哪跑。**是那棵树的根下的一个相对位置**，不是绝对路径。 */
  readonly cwd?: RelPath
}

/**
 * 跑一条断言。**三种情形分得开**（架构 § 8.12 末段）：
 *
 *   · 进程起不来（`ENOENT`：命令不在）→ `not-run` → `unrunnable`
 *   · 起得来、退出码不等于期望 → `ran` 且不等 → `fail`
 *   · 起得来、退出码等于期望 → `ran` 且相等 → `pass`
 *
 * **退出码 127 也归 `not-run`**：那是 shell 说"这个命令找不到"，与 `ENOENT` 是同一件事的两种
 * 报法——一个是 `spawnSync` 直接给的，一个是经 shell 走一圈给的。两处都收，判据一处。
 */
export function runAssertion(root: AbsPath, spec: AssertionRunSpec): AssertionResult {
  const cwd = join(root, spec.cwd ?? '')
  if (!existsSync(cwd)) {
    return resultOf(spec.assertion, {
      kind: 'not-run',
      note: `在哪跑不存在：${spec.cwd === undefined || spec.cwd === '' ? '（树根）' : spec.cwd}`,
    })
  }
  const started = performance.now()
  const r = spawnSync(spec.argv[0] as string, spec.argv.slice(1), {
    cwd,
    env: spec.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ms = Math.round(performance.now() - started)
  const head = (s: string | null): string => (s ?? '').split('\n').slice(0, 3).join(' / ').slice(0, 200)
  if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return resultOf(spec.assertion, { kind: 'not-run', note: `命令不在：${spec.argv[0]}（ENOENT）` })
  }
  const exit = r.status === null ? 1 : r.status
  if (exit === 127) {
    return resultOf(spec.assertion, { kind: 'not-run', note: `退出码 127：命令找不到（${spec.argv[0]}）` })
  }
  const note = `exit ${exit}${r.stderr !== null && r.stderr !== '' ? `｜${head(r.stderr)}` : ''}${r.stdout !== null && r.stdout !== '' ? `｜${head(r.stdout)}` : ''}`
  return resultOf(spec.assertion, { kind: 'ran', ms, exit, note })
}

/** 一次验收的结果：逐条判决 + 三档各几条。 */
export interface VerifyReport {
  readonly results: readonly AssertionResult[]
  readonly pass: number
  readonly fail: number
  /** **跑不起来的那一档不进打回**（架构 § 8.12 末段）：它单独成一栏。 */
  readonly unrunnable: number
  /** 全部通过才算通过。**"跑不起来"不算通过**——它既不是好也不是坏，是没量到。 */
  readonly ok: boolean
}

/** 把一串判决收成一份报告。三档各数一遍，判据在这一处。 */
export function reportOf(results: readonly AssertionResult[]): VerifyReport {
  let pass = 0
  let fail = 0
  let unrunnable = 0
  for (const r of results) {
    if (r.verdict === 'pass') pass++
    else if (r.verdict === 'fail') fail++
    else unrunnable++
  }
  return { results, pass, fail, unrunnable, ok: fail === 0 && unrunnable === 0 && pass > 0 }
}

/**
 * 跑一遍验收。**它只读**：收的是那棵树的根（物化出来的那一棵），跑的是一串已经包好的命令行。
 *
 * 它**不 commit、不 advance、不认识真实工作树**——那三件事在下面那一个函数里。
 */
export function verify(root: AbsPath, specs: readonly AssertionRunSpec[]): VerifyReport {
  return reportOf(specs.map((s) => runAssertion(root, s)))
}

/** 一次推进的结果：改了几条 · 删了几条 · 跳过哪几处。 */
export interface AdvanceResult {
  readonly written: readonly RelPath[]
  readonly removed: readonly RelPath[]
  readonly skipped: readonly RelPath[]
  readonly commit: CommitId
}

export interface AdvanceDeps {
  readonly truth: Truth
  readonly realRoot: AbsPath
  /**
   * 不碰的路径前缀。**缺省就是 `WORKSPACE_STATE`**（`.git` · `.fugue`）——§ 9.10 说保留前缀
   * 不进真实工作树，而这两处是工作区自己的本子，不是被物化的内容（`diffstat.ts` 那一句）。
   */
  readonly preserve?: readonly RelPath[]
}

/**
 * 把一棵树推进真实工作树：**跳过保留前缀**（§ 9.10），其余逐条落成 `base` 那棵树的样子。
 *
 * 判据是"推进之后 `scanTree(realRoot, {skip: preserve})` 与 `scanTree(那棵树)` 逐条相等"
 * （PLAN § 5.7 的 A6 ②）——所以这一份的做法是**先算差异，再逐条落**：它不动与目标一致的
 * 那些文件（不 touch、不改 mtime），只写该写的、删该删的。
 *
 * **"不 touch 一致的"是承重的**：全量重写会让每一个文件的 mtime 都变，而 § 8.5 明说按修改时间
 * 判定新旧的工具链于是会重新编译整个项目——那是假失效。
 */
export async function advance(deps: AdvanceDeps, commit: CommitId): Promise<AdvanceResult> {
  const preserve = deps.preserve ?? WORKSPACE_STATE
  const root = deps.realRoot
  const tree = await treeOfCommit(deps.truth, commit)
  const want = new Map<RelPath, { mode: number; bytes: Uint8Array | null; link: string | null }>()
  {
    const walk = async (dir: RelPath): Promise<void> => {
      for (const e of await deps.truth.listAt(commit, dir)) {
        const p = dir === '' ? e.name : `${dir}/${e.name}`
        if (e.kind === 'dir') await walk(p)
        else if (e.kind === 'symlink') want.set(p, { mode: e.mode, bytes: null, link: new TextDecoder().decode((await deps.truth.getBlob(e.id as never)) as Uint8Array) })
        else want.set(p, { mode: e.mode, bytes: (await deps.truth.getBlob(e.id as never)) as Uint8Array, link: null })
      }
    }
    await walk('')
  }
  void tree

  const skipped: RelPath[] = []
  const isPreserved = (rel: RelPath): boolean => preserve.some((s) => rel === s || rel.startsWith(`${s}/`))

  const written: RelPath[] = []
  const removed: RelPath[] = []

  // 一 · 目标里有的，逐条落。**一致的跳过**（比内容哈希，不比 mtime）。
  for (const [rel, w] of want) {
    if (isPreserved(rel)) {
      skipped.push(rel)
      continue
    }
    const abs = join(root, rel)
    if (w.link !== null) {
      const now = lstatSync(abs, { throwIfNoEntry: false })
      if (now !== undefined && now.isSymbolicLink() && readlinkSync(abs) === w.link) continue
      mkdirSync(dirname(abs), { recursive: true })
      if (now !== undefined) rmSync(abs, { force: true })
      symlinkSync(w.link, abs)
      written.push(rel)
      continue
    }
    const now = lstatSync(abs, { throwIfNoEntry: false })
    if (now !== undefined && now.isFile() && Number(now.mode) === w.mode && hashOfFile(abs) === hashOf(w.bytes)) continue
    mkdirSync(dirname(abs), { recursive: true })
    if (now !== undefined && !now.isFile()) rmSync(abs, { recursive: true, force: true })
    writeFileSync(abs, w.bytes)
    chmodSync(abs, w.mode & 0o7777)
    written.push(rel)
  }

  // 二 · 目标里没有的，逐条删（保留前缀那几处跳过；`scanTree` 也不看它们）。
  const walkDrop = (dir: RelPath): void => {
    const abs = dir === '' ? root : join(root, dir)
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (isPreserved(rel)) {
        skipped.push(rel)
        continue
      }
      const child = join(root, rel)
      if (e.isDirectory()) {
        walkDrop(rel)
        // 空目录收掉：目标树里没有它（git 里目录不是条目）。
        try {
          if (readdirSync(child).length === 0) {
            rmSync(child, { force: true })
            removed.push(rel)
          }
        } catch {
          // 删不动就算了：它不是内容，下一次推进还会经过这里。
        }
        continue
      }
      if (!want.has(rel)) {
        unlinkSync(child)
        removed.push(rel)
      }
    }
  }
  walkDrop('')

  return { written, removed, skipped, commit }
}

function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function hashOfFile(abs: AbsPath): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

/** 一次"验收 → 定格 → 推进"的产出。 */
export interface AcceptOutcome {
  readonly report: VerifyReport
  /** 通过才有：定格的那个提交（`merge/accept` 那一条事件带的就是它）。 */
  readonly commit?: CommitId
  /** 通过才有：推进改了什么。 */
  readonly advanced?: AdvanceResult
}

/**
 * **先验收，再定格，最后推进。** 没通过时提前返回——`advance` 那一段根本走不到，
 * 于是"真实工作树一个字节都没动"不是一条纪律，是这段代码的形状。
 *
 * 三个参数各司其职：`tree` 是**验收跑在哪**（物化出来的那棵树）· `realRoot` 是**推进推到哪**
 * （真实工作树）· `commitOf` 是**拿什么定格**（那棵树的条目，通常就是 `fold` 折出来的那个提交）。
 */
export async function commitThenAdvance(deps: {
  readonly truth: Truth
  readonly realRoot: AbsPath
  /** 验收跑在哪棵树上（物化出来的那一棵）。 */
  readonly tree: AbsPath
  /** 验收要跑的那几条（已经包好的命令行）。 */
  readonly specs: readonly AssertionRunSpec[]
  /** 要定格的那个提交：`fold` 折出来的。 */
  readonly commit: CommitId
  readonly preserve?: readonly RelPath[]
}): Promise<AcceptOutcome> {
  const report = verify(deps.tree, deps.specs)
  if (!report.ok) {
    // **一条都不落。** 没有 commit · 没有 advance · 真实工作树与进来时逐字节相同。
    return { report }
  }
  const advanced = await advance({ truth: deps.truth, realRoot: deps.realRoot, ...(deps.preserve === undefined ? {} : { preserve: deps.preserve }) }, deps.commit)
  return { report, commit: deps.commit, advanced }
}

/**
 * 把一个提交里的条目摊成 `TreeEntry[]`。**给"把冲突树或合并树落一次提交"的地方用**——
 * `merge.ts` 里那一份是私有的，而验收这一侧也要它（推进入口与冲突物化各要一次）。
 */
export async function entriesOf(truth: Truth, commit: CommitId): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  const walk = async (dir: RelPath): Promise<void> => {
    for (const e of await truth.listAt(commit, dir)) {
      const p = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.kind === 'dir') await walk(p)
      else out.push({ name: p, mode: e.mode, id: e.id })
    }
  }
  await walk('')
  return out
}

/** 契约里那几条断言：给验收门算判决用的那一份（`Assertion` 逐条）。 */
export function assertionsOf(c: Contract): readonly Assertion[] {
  return c.kind === 'investigate' ? [] : c.assertions
}

/** 一条断言的判决该不该算进"打回"。**跑不起来不算**（架构 § 8.12 末段）——这一处是那句话的落点。 */
export function countsAsReject(r: AssertionResult): boolean {
  return r.verdict === 'fail'
}
