// M4·V3 的断言。四条，逐条对 PLAN § 5.2 的 V3 行：
//
//   ① 六种变更各一条（`add` · `modify` · `delete` · `rename` · `chmod` · `symlink`）→ 落地根的
//      枚举集 == 变化集，whiteout 数 == 删除数
//   ② 承重性质：改 3 个无关文件 → 未变文件的 `(mtime, size, inode, hash)` 逐字节不变；
//      负对照：关掉 `preserveMtime` 时这条必须失败
//   ③ 幂等：第二次 `ensure` 空操作，全树快照零变化
//   ④ 大小写两种拼写在同一批里各落各的；写回原内容的路径不碰盘
//
// **"变化集"是两边独立算的**：一侧是视图的 delta（日志那一侧），另一侧是盘上两次全树快照之差
// （`scanTree` + `diffStat`，§ 9.6 那把尺子）。两条路各读各的源，比的是路径集合——不是自己跟
// 自己比。**"未变文件"量的是底与物化树之差**：§ 8.5 的承重性质说的是"`ensure` 之后未变文件的
// mtime / inode / 内容逐字节不变"，而"变没变"只有拿底那一份比才答得出来（两次快照都取自
// `ensure` 之后的话，`fork` 自己铺坏的那一份也能蒙混过关——负对照要抓的正是它）。
//
// **口径上的两处收窄，都是本平台的性质**：
//
//   · `find upper` 那一句只在 `overlayfs` 档上有意义（另两档的落地根就是 `merged`，`upper`
//     是空的）；whiteout 数 == 删除数同理。copy 档上等价的那一条是"两次全树快照之差 == 变化集"。
//   · 大小写不敏感的文件系统上没有第二条路可走（E1 要的是 ext4 这一档，它是大小写敏感的），
//     所以 § 8.5 那句"同一路径的两种大小写拼写视作同一处"在本平台上测不到——它是 `applyDelta`
//     的事，不是落地的事。这里测的是它的**落地面**：同一批里的两种拼写互不覆盖。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Delta } from '../delta.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { Roots } from '../roots/contract.ts'
import { createRoots } from '../roots/roots.ts'
import type { CommitId, RelPath, ViewRev } from '../terms.ts'
import { openTruth } from '../truth/truth.ts'
import type { View } from '../view/contract.ts'
import { applyEdit } from '../view/edit.ts'
import { lowerFor } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import { probePlatform } from './capability.ts'
import { DEFAULT_MATERIALIZE } from './contract.ts'
import type { MaterializeOptions } from './contract.ts'
import { WORKSPACE_STATE, diffStat, scanTree } from './diffstat.ts'
import { EnsureRefused, ensure } from './ensure.ts'
import { fork } from './fork.ts'
import { touchedBy } from './land.ts'
import { clearMaterialization, isMounted } from './mount.ts'
import { matState } from './manifest.ts'
import { removeTree } from './mount.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'cli', 'fugue.ts')
const AGENT = 'round'

const made: string[] = []
after(() => {
  for (const d of made) removeTree(d)
})

function git(cwd: string, args: readonly string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'fugue',
      GIT_AUTHOR_EMAIL: 'fugue@localhost',
      GIT_COMMITTER_NAME: 'fugue',
      GIT_COMMITTER_EMAIL: 'fugue@localhost',
    },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 退 ${r.status}：${r.stderr}`)
  return r.stdout.trim()
}

interface Fixture {
  readonly dir: string
  readonly commit: CommitId
}

/**
 * 一个真仓库，**工作树与 HEAD 逐字节一致**（`git status` 干净）。
 *
 * 这一条是 V3 的断言能成立的前提：物化的底是真实工作树（§ 8.4），而"清单 = 相对 base 变了的
 * 路径"里的 base 就是这个提交。工作树与它不一致时（手改过 · 忘了 checkout），清单会诚实地
 * 把那些差异也报进来——那是 V4 的 `verify-mat` 要审的事。
 */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-ensure-'))
  made.push(dir)
  const put = (rel: string, body: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  put('src/a.ts', 'export const a = 1\n')
  put('src/deep/nest/b.ts', 'export const b = 2\n')
  put('src/c.ts', 'export const c = 3\n')
  put('docs/manual.md', '# 手册\n')
  put('vendor/lib.txt', 'vendored\n')
  put('bin/run.sh', '#!/bin/sh\necho hi\n')
  chmodSync(join(dir, 'bin/run.sh'), 0o755)
  symlinkSync('src/a.ts', join(dir, 'link.ts'))
  // **初始提交落在 `main` 上**：视图的下层就是这个 ref（§ 4 的 ref 方案：round 走主线），
  // 而物化的底是工作树。两边指向同一个提交，整个夹具才是自洽的。
  git(dir, ['init', '-q', '-b', 'main', '.'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  assert.equal(git(dir, ['status', '--porcelain']), '', '夹具的工作树要是干净的')
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']) as CommitId }
}

interface Stage {
  readonly dir: string
  readonly roots: Roots
  readonly view: View
  readonly log: Awaited<ReturnType<typeof openLog>>
  edit(d: Delta): Promise<ViewRev>
  ensure(upTo?: ViewRev, opt?: MaterializeOptions): Promise<Awaited<ReturnType<typeof ensure>>>
  events(): LogEvent[]
  close(): Promise<void>
}

/** 一个工作区 + 一份视图 + 接好的物化依赖。**视图那一侧的读口在这里接上**（§ 8.3）。 */
async function stage(f: Fixture): Promise<Stage> {
  const roots = createRoots(f.dir)
  const log = openLog(f.dir)
  const truth = openTruth(f.dir)
  const view = await loadView(log, AGENT, { lower: await lowerFor(truth, AGENT) })
  return {
    dir: f.dir,
    roots,
    view,
    log,
    edit: (d) => applyEdit({ log, truth, view, writer: AGENT }, d),
    // **`history: true` 那一半在这里由全量重放体现**：`ensure` 要变更序列，快照答不了它（§ 9.4）。
    ensure: (upTo, opt) =>
      ensure(
        {
          roots,
          log,
          root: f.dir,
          ...(opt === undefined ? {} : { opt }),
          view: {
            stat: (p: RelPath) => view.stat(p),
            read: (p: RelPath) => view.read(p),
            deltasSince: (from: ViewRev) => view.diff(from),
          },
        },
        AGENT,
        upTo ?? view.rev,
      ),
    events: () => readEvents(f.dir),
    close: async () => {
      await log.close()
      await truth.close()
    },
  }
}

function readEvents(dir: string): LogEvent[] {
  const text = readFileSync(join(dir, '.fugue', 'log', `${AGENT}.jsonl`), 'utf8')
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LogEvent)
}

const opts = (o: Partial<MaterializeOptions>): MaterializeOptions => ({ ...DEFAULT_MATERIALIZE, ...o })

/** 六种变更各一条。**改名与改权限各自还带一条"钉住下层内容"的 `view/write`**（§ 9.3 的装配体），
 *  所以 delta 的条数比 6 多——判据是**路径集合**，不是条数。 */
async function sixShapes(s: Stage): Promise<void> {
  await s.edit({ kind: 'add', path: 'src/new.ts', bytes: Buffer.from('export const n = 1\n'), mode: 0o100644 })
  await s.edit({ kind: 'modify', path: 'src/a.ts', bytes: Buffer.from('export const a = 2\n'), mode: 0o100644 })
  await s.edit({ kind: 'delete', path: 'docs/manual.md' })
  await s.edit({ kind: 'rename', from: 'vendor/lib.txt', to: 'vendor/lib2.txt' })
  // **`chmod` 要挑一个真的会变的模式。** 视图的模式模型是 git 那一种：普通文件只有 `100644`
  // 与 `100755` 两种（`view.ts` 的 `normMode`），所以"644 → 700"在视图里什么都没变，也就没有
  // 可落的 delta。要动就动可执行位本身。
  await s.edit({ kind: 'chmod', path: 'src/c.ts', mode: 0o100755 })
  await s.edit({ kind: 'symlink', path: 'notes/link.ts', target: 'src/a.ts' })
}

/** 落地根里的叶子：普通文件与软链一类 · whiteout（字符设备 0:0，`upper` 独有）。 */
function upperLeaves(upper: string): { files: RelPath[]; whiteouts: RelPath[] } {
  const files: RelPath[] = []
  const whiteouts: RelPath[] = []
  const walk = (rel: RelPath): void => {
    const abs = rel === '' ? upper : join(upper, rel)
    for (const name of readdirSync(abs)) {
      const child = rel === '' ? name : `${rel}/${name}`
      const st = lstatSync(join(upper, child))
      if (st.isDirectory()) walk(child)
      else if (st.isCharacterDevice() && st.rdev === 0) whiteouts.push(child)
      else files.push(child)
    }
  }
  walk('')
  return { files, whiteouts }
}

/** 全树 `(mtime, size, inode, hash)` ——承重性质要的四样，inode 由这里补（`diffstat` 的尺子不带它）。 */
interface Print {
  mtimeNs: string
  /** 同一个时间戳的毫秒读数：**与底比时间戳时要容一个亚毫秒的偏移**，见下。 */
  ms: number
  size: number
  ino: number
  hash: string
  /** 整模式（`0o100755` 那种），与 `scanTree` 同一个口径。 */
  mode: number
}

/**
 * **与底比 mtime 要容一个亚毫秒的偏移。** `lay.ts` 走的是 Node 的 `utimesSync`（秒的浮点），
 * 分到纳秒会丢几位——实测约 172 µs（V2 的读数）。这条偏移只出现在 `fork` 铺出来的抄本上，
 * `ensure` 一个字节都不写的那几条是**逐纳秒相同**的（下面 `a.mtimeNs === b.mtimeNs` 那一句）。
 */
function prints(dir: string): Map<RelPath, Print> {
  const out = new Map<RelPath, Print>()
  for (const l of scanTree(dir, { skip: WORKSPACE_STATE }).leaves) {
    out.set(l.path, {
      mtimeNs: l.mtimeNs,
      ms: Number(l.mtimeNs) / 1e6,
      size: l.size,
      ino: lstatSync(join(dir, l.path)).ino,
      hash: l.hash,
      mode: l.mode,
    })
  }
  return out
}

/** 两份快照之间**内容层面**的差异（形状 · 模式 · 内容哈希），不看时间戳。 */
function contentDiff(a: Map<RelPath, Print>, b: Map<RelPath, Print>): RelPath[] {
  const out: RelPath[] = []
  for (const [p, x] of a) {
    const y = b.get(p)
    if (y === undefined || y.hash !== x.hash || y.size !== x.size || y.mode !== x.mode) out.push(p)
  }
  for (const p of b.keys()) if (!a.has(p)) out.push(p)
  return out.sort()
}

/** 视图里的 delta 说它碰了哪些路径。 */
function changeSet(view: View): RelPath[] {
  return touchedBy(view.diff(0)).sort()
}

test('① overlayfs 档：六种变更 → upper 的枚举集 == 变化集，whiteout 数 == 删除数', async () => {
  const f = fixture()
  const s = await stage(f)
  try {
    mkdirSync(s.roots.tempRoot(AGENT), { recursive: true })
    const facts = probePlatform(f.dir, join(s.roots.tempRoot(AGENT), 'probe'))
    assert.notEqual(
      facts.overlayfs,
      null,
      `这一档在这台机器上验不了：${facts.overlayfsNote}\n整份测试跑在 \`unshare -Ur -m\` 里，或者给无密码 sudo。`,
    )
    assert.notEqual(facts.whiteout, null, `whiteout 造不出来：${facts.whiteoutNote}`)

    const res = await fork({ roots: s.roots, log: s.log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'overlayfs' }))
    assert.equal(res.strategy, 'overlayfs')
    const before = scanTree(f.dir, { skip: WORKSPACE_STATE })
    await sixShapes(s)
    const out = await s.ensure()
    assert.equal(out.strategy, 'overlayfs')
    assert.equal(out.from, 0)
    assert.equal(out.to, s.view.rev)

    // 盘那一侧：底与合并树的全树快照之差。
    const diff = diffStat(before, scanTree(res.merged, { skip: WORKSPACE_STATE }))
    const onDisk = diff.map((c) => c.path).sort()
    const inView = changeSet(s.view)
    assert.deepEqual(onDisk, inView, '落地根里变了的路径集，要与视图的变更集逐条相等')
    // 路径口径的 diff 把一次改名看成"删一条 + 加一条"（§ 8.5 的差异集是路径集合）。
    const removed = diff.filter((c) => c.status === 'removed').map((c) => c.path)
    assert.deepEqual(removed.sort(), ['docs/manual.md', 'vendor/lib.txt'])
    const upper = upperLeaves(s.roots.scratchRoot(AGENT))
    assert.equal(upper.whiteouts.length, removed.length, 'whiteout 数 == 这张 diff 里"没有了"的条数')

    // 上层那一侧：`find upper` 的枚举集。
    assert.deepEqual(
      [...upper.whiteouts].sort(),
      ['docs/manual.md', 'vendor/lib.txt'],
      'whiteout 恰好是"视图里没有了而底里有的"两条：删掉的那条与改名的来源',
    )
    assert.deepEqual(
      [...upper.files].sort(),
      ['notes/link.ts', 'src/a.ts', 'src/c.ts', 'src/new.ts', 'vendor/lib2.txt'],
      'upper 里留下的普通条目，恰好是新增与改写的那几条——没有多出来的一条',
    )
    // **`upper` 的叶子数 == 变化集的路径数**：这就是 § 20 验证 5 的那一句。
    assert.equal(upper.files.length + upper.whiteouts.length, inView.length)

    // 视图里那一条（改名之后来源不在、终点在）与盘上一致。
    assert.equal(readFileSync(join(res.merged, 'vendor/lib2.txt'), 'utf8'), 'vendored\n')
    assert.equal(lstatSync(join(res.merged, 'docs/manual.md'), { throwIfNoEntry: false }), undefined)
    // **软链读它自己那串字符，不跟过去**（§ 8.5 的差异集口径）：目标是相对的，跟过去是另一棵树。
    assert.equal(readlinkSync(join(res.merged, 'notes/link.ts')), 'src/a.ts')
    assert.equal(lstatSync(join(res.merged, 'src/c.ts')).mode & 0o7777, 0o755, '可执行位要落进去')
    assert.equal(lstatSync(join(res.merged, 'bin/run.sh')).mode & 0o7777, 0o755)
    assert.equal(isMounted(res.merged), true, 'ensure 走完，合并树是挂着的')
  } finally {
    clearMaterialization(s.roots.mergedRoot(AGENT), [
      s.roots.scratchRoot(AGENT),
      s.roots.mergedRoot(AGENT),
      s.roots.tempRoot(AGENT),
    ])
    await s.close()
  }
})

test('① copy 档：同一批六种变更，两次全树快照之差 == 变化集', async () => {
  const f = fixture()
  const s = await stage(f)
  try {
    const res = await fork({ roots: s.roots, log: s.log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'copy' }))
    assert.equal(res.strategy, 'copy')
    const before = scanTree(f.dir, { skip: WORKSPACE_STATE })
    await sixShapes(s)
    const out = await s.ensure()
    assert.equal(out.whiteouts, 0, 'copy 档没有 overlay，删除就是删掉那一条')
    assert.deepEqual(out.landed.slice().sort(), changeSet(s.view), '动过盘的恰好是那几条（改名算两处）')
    // **这一档与底比内容，不比时间戳**：`fork` 抄出来的那几条带着亚毫秒的偏移（`prints` 上面
    // 那段），而 overlayfs 那一档共享底的文件、连时间戳都不动——`diffStat` 那把带 mtime 的尺子
    // 因此只在那一档上量得出"一个字节都没碰"。
    const onDisk = contentDiff(prints(f.dir), prints(res.merged))
    assert.deepEqual(onDisk, changeSet(s.view))
    assert.equal(lstatSync(join(res.merged, 'docs/manual.md'), { throwIfNoEntry: false }), undefined)
    assert.equal(readFileSync(join(res.merged, 'vendor/lib2.txt'), 'utf8'), 'vendored\n')
    assert.equal(lstatSync(join(res.merged, 'src/c.ts')).mode & 0o7777, 0o755)
  } finally {
    await s.close()
  }
})

test('② 承重性质：未变文件的 (mtime, size, inode, hash) 与底逐字节相同；负对照在位', async () => {
  const f = fixture()
  const s = await stage(f)
  try {
    const forked = await fork({ roots: s.roots, log: s.log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'copy' }))
    const before = prints(forked.merged)
    const under = prints(f.dir)
    // 改 3 个互不相干的文件（另外 3 条路径不动）。
    await s.edit({ kind: 'modify', path: 'src/a.ts', bytes: Buffer.from('export const a = 9\n'), mode: 0o100644 })
    await s.edit({ kind: 'add', path: 'src/new.ts', bytes: Buffer.from('新的\n'), mode: 0o100644 })
    await s.edit({ kind: 'delete', path: 'docs/manual.md' })
    const out = await s.ensure()
    assert.deepEqual(out.landed.sort(), ['docs/manual.md', 'src/a.ts', 'src/new.ts'])

    const after = prints(forked.merged)
    const changed = new Set(out.landed)
    const same = (p: RelPath): boolean => {
      const a = before.get(p)
      const b = after.get(p)
      const c = under.get(p)
      return (
        a !== undefined &&
        b !== undefined &&
        c !== undefined &&
        a.mtimeNs === b.mtimeNs &&
        a.size === b.size &&
        a.ino === b.ino &&
        a.hash === b.hash &&
        // **与底那一份比**：内容逐字节相同，时间戳在亚毫秒之内（抄本那点偏移）。
        c.hash === b.hash &&
        c.size === b.size &&
        Math.abs(c.ms - b.ms) < 1
      )
    }
    const untouched = [...after.keys()].filter((p) => !changed.has(p))
    assert.ok(untouched.length >= 4, `未变的叶子要有几条可比：${untouched.length}`)
    for (const p of untouched) assert.equal(same(p), true, `${p} 未变，四样都该原样`)

    // **只改模式那一条**：内容一个字节没动，所以 mtime 与 inode 也不该动（`applyEntry` 那一支
    // 就地 `chmod`）。它不在上面的"未变文件"里——模式变了，它是变了的文件——但它同样是
    // "按修改时间判定新旧的工具链不该白重建"这件事的一部分。
    const beforeC = prints(forked.merged).get('src/c.ts')
    await s.edit({ kind: 'chmod', path: 'src/c.ts', mode: 0o100755 })
    const out2 = await s.ensure()
    assert.deepEqual(out2.landed, ['src/c.ts'], '模式变了，这一条要动盘')
    const afterC = prints(forked.merged).get('src/c.ts')
    assert.equal(lstatSync(join(forked.merged, 'src/c.ts')).mode & 0o7777, 0o755)
    assert.equal(afterC?.mtimeNs, beforeC?.mtimeNs, '只改模式：mtime 不动')
    assert.equal(afterC?.ino, beforeC?.ino, '只改模式：inode 不动')
    assert.equal(afterC?.hash, beforeC?.hash)

    // 负对照：`preserveMtime` 关掉，`fork` 铺出来的那几条 mtime 就不是底的那一个了——
    // 这一条必须失败，否则上面那句"逐字节相同"量的是空气。
    const f2 = fixture()
    const s2 = await stage(f2)
    try {
      const forked2 = await fork(
        { roots: s2.roots, log: s2.log, root: f2.dir },
        AGENT,
        f2.commit,
        opts({ preferredStrategy: 'copy', preserveMtime: false }),
      )
      const after2 = prints(forked2.merged)
      const under2 = prints(f2.dir)
      const a = after2.get('src/c.ts')
      const b = under2.get('src/c.ts')
      assert.ok(
        a !== undefined && b !== undefined && Math.abs(a.ms - b.ms) > 1,
        `关掉 preserveMtime，铺出来的那份 mtime 就该明显不是底的那一个：${a?.mtimeNs} vs ${b?.mtimeNs}`,
      )
      assert.equal(a?.hash, b?.hash, '内容还是同一份——变的只是时间戳，这正是假失效的来路')
    } finally {
      await s2.close()
    }
  } finally {
    await s.close()
  }
})

test('③ 幂等：第二次 ensure 空操作，盘上零变化、日志里不多一条事件', async () => {
  const f = fixture()
  const s = await stage(f)
  try {
    await fork({ roots: s.roots, log: s.log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'copy' }))
    await s.edit({ kind: 'modify', path: 'src/deep/nest/b.ts', bytes: Buffer.from('b9\n'), mode: 0o100644 })
    const first = await s.ensure()
    assert.equal(first.noop, false)
    const snapshot = prints(s.roots.mergedRoot(AGENT))
    const events = s.events().filter((e) => e.t === 'mat/sync').length

    const second = await s.ensure()
    assert.equal(second.noop, true, '已最新就是空操作')
    assert.deepEqual(second.landed, [])
    assert.deepEqual(second.untouched, [])
    assert.equal(second.from, second.to)
    assert.equal(s.events().filter((e) => e.t === 'mat/sync').length, events, '空操作不写事件')
    const after = prints(s.roots.mergedRoot(AGENT))
    assert.equal(JSON.stringify([...after]), JSON.stringify([...snapshot]), '全树快照零变化')

    // 清单的两条读法在这里对上：日志重放出的 rev 与清单，就是第一次那一条。
    const st = await matState(s.log, AGENT)
    assert.equal(st.rev, first.to)
    assert.deepEqual([...st.paths], ['src/deep/nest/b.ts'])
  } finally {
    await s.close()
  }
})

test('④ 写回原内容不碰盘；同一批里两种大小写拼写各落各的', async () => {
  const f = fixture()
  const s = await stage(f)
  try {
    const res = await fork({ roots: s.roots, log: s.log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'copy' }))
    const before = prints(res.merged)
    // **写回原内容**：新写的字节与底一模一样（模型整份重写 · formatter 跑一遍没改动）。
    await s.edit({
      kind: 'add',
      path: 'src/a.ts',
      bytes: Buffer.from(readFileSync(join(f.dir, 'src/a.ts'), 'utf8')),
      mode: 0o100644,
    })
    // 大小写两种拼写：先建一个、再删掉、再建另一种拼写——**同一批 delta 里的三处**。
    await s.edit({ kind: 'add', path: 'Case.txt', bytes: Buffer.from('大写\n'), mode: 0o100644 })
    await s.edit({ kind: 'delete', path: 'Case.txt' })
    await s.edit({ kind: 'add', path: 'case.txt', bytes: Buffer.from('小写\n'), mode: 0o100644 })
    const out = await s.ensure()

    assert.deepEqual(out.landed, ['case.txt'], '只有它真的动了盘：写回原样那条不算，删掉的那条本来就不在底里')
    assert.ok(out.untouched.includes('src/a.ts'), '写回原内容要走 untouched 那条路')
    const after = prints(res.merged)
    assert.deepEqual(before.get('src/a.ts'), after.get('src/a.ts'), '四样逐字节不变（mtime · inode 也在里面）')
    assert.equal(readFileSync(join(res.merged, 'case.txt'), 'utf8'), '小写\n')
    assert.equal(lstatSync(join(res.merged, 'Case.txt'), { throwIfNoEntry: false }), undefined)

    // 清单记的是"相对 base 变了"：写回原样的那条不在里面，大写那条也不在（底里本来就没有它）。
    const st = await matState(s.log, AGENT)
    assert.deepEqual([...st.paths], ['case.txt'])
    const sync = s.events().filter((e) => e.t === 'mat/sync').pop()
    assert.deepEqual(sync !== undefined && sync.t === 'mat/sync' ? sync.paths : [], ['case.txt'])
  } finally {
    await s.close()
  }
})

test('⑤ 拒绝的两条路：没铺过物化树 · 往回走', async () => {
  const f = fixture()
  const s = await stage(f)
  const refused = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => null,
      (err: unknown) => err,
    )
  try {
    await s.edit({ kind: 'modify', path: 'src/a.ts', bytes: Buffer.from('先改一处\n'), mode: 0o100644 })
    const noFork = await refused(s.ensure())
    assert.ok(noFork instanceof EnsureRefused, '没 fork 过就该拒绝')
    assert.match(noFork instanceof EnsureRefused ? noFork.why : '', /fork/)

    await fork({ roots: s.roots, log: s.log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'copy' }))
    const first = await s.ensure()
    await s.edit({ kind: 'add', path: 'src/later.ts', bytes: Buffer.from('后来的\n'), mode: 0o100644 })
    const second = await s.ensure()
    assert.equal(second.from, first.to)
    // **往回走**：目标 rev 比已经落到的那个早。§ 9.6 那张表里没有"回退"这条路。
    const back = await refused(s.ensure(first.to))
    assert.ok(back instanceof EnsureRefused, '往回走不是一条路（§ 9.6 那张表里没有回退）')
    assert.match(back instanceof EnsureRefused ? back.why : '', /回退|往回走/)
  } finally {
    await s.close()
  }
})

test('⑥ 命令面：fugue ensure 的 stdout 是坐标、stderr 是读数，失败退 1、用法错退 2', async () => {
  const f = fixture()
  const run = (args: readonly string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, '--root', f.dir, ...args], { encoding: 'utf8' })
    return { status: r.status ?? -1, stdout: r.stdout.trim(), stderr: r.stderr }
  }
  try {
    const noFork = run(['ensure'])
    assert.equal(noFork.status, 1)
    assert.match(noFork.stderr, /fork/)

    const bad = run(['ensure', '--to', 'abc'])
    assert.equal(bad.status, 2, '用法错是 2（§ 9.8 的退出码行）')

    const base = run(['commit', '-m', '第一次']).stdout.split('\t')[0]
    const forked = run(['fork', base, '--strategy', 'copy'])
    assert.equal(forked.status, 0)
    assert.equal(run(['ensure']).status, 0, '一条 delta 都没有也算走通')

    const moved = spawnSync(process.execPath, [CLI, '--root', f.dir, 'write', 'notes/new.txt', '--stdin'], {
      encoding: 'utf8',
      input: '一份新的\n',
    })
    assert.equal(moved.status, 0)

    const out = run(['ensure'])
    assert.equal(out.status, 0)
    assert.equal(out.stdout, forked.stdout, '两条命令报的是同一个坐标：合并树')
    assert.match(out.stderr, /落地 1 条/)
    const again = run(['ensure'])
    assert.equal(again.status, 0)
    assert.match(again.stderr, /已是最新/)
    const gap = run(['ensure', '--to', '99'])
    assert.equal(gap.status, 1)
    assert.match(gap.stderr, /不是一个修订点/)
  } finally {
    // 这一条全在子进程里跑，测试这边没有开着的句柄要收。
  }
})
