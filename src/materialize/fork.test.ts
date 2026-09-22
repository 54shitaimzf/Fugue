// M4·V2 的断言。四条，逐条对 PLAN § 5 的 V2 行：
//
//   ① `overlayfs` 档：`fork` 后物化树全树哈希 == 该提交的 tree（含 symlink 与可执行位）
//   ② `copy` 档同一断言成立；`hardlink-ro` 档在只读子树上走通，且负对照成立
//   ③ 挂载与落地互斥：挂载态从外部写 `upper` → `merged` 不可见（0/N），卸载重挂后可见（N/N）
//   ④ 某一档探下来不可用就退到下一档并如实报出用了哪一档
//
// **"全树哈希 == 该提交的 tree" 这一条是两边独立算的**：物化那一侧走 `scanTree`（真文件
// 系统的字节），提交那一侧走 `M1`（`listAt` + `readAt`，git 对象库里的字节）。两条路各读各的
// 源，比的是一个摘要——所以它不是自己跟自己比。
//
// **比的是"base 的路径空间"**（§ 8.5 的差异集口径）：物化树里那些 base 不认识的路径
// （`.git` · `.fugue`，overlayfs 档里它们天然可见）不进比较。判据是路径集合相等 + 逐条
// (mode, 内容哈希) 相等。
//
// **`unshare -Ur` 那一条断言是有意的**（④）：一个"userns 里没有 overlay、sudo 也不通"的
// 环境正是退档那一档成立的地方，而它造得出来——`unshare -Ur`（不带 `-m`）里 root 的
// CAP_SYS_ADMIN 管不到初始 mount namespace，`sudo` 也用不了。整个测试套因此可以在两处跑：
// 直接在会话里（overlayfs 走 sudo），或者 `unshare -Ur -m` 里（overlayfs 走 direct）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openLog } from '../log/log.ts'
import { createRoots } from '../roots/roots.ts'
import type { Roots } from '../roots/contract.ts'
import { openTruth } from '../truth/truth.ts'
import type { CommitId, RelPath } from '../terms.ts'
import { chooseStrategy, probePlatform, saveFacts } from './capability.ts'
import { DEFAULT_MATERIALIZE } from './contract.ts'
import type { MaterializeOptions } from './contract.ts'
import { WORKSPACE_STATE, scanTree } from './diffstat.ts'
import { fork } from './fork.ts'
import { clearMaterialization, isMounted, mountOverlay, unmountOverlay, removeTree } from './mount.ts'
import type { OverlaySpec } from './mount.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = 'round'

const made: string[] = []
after(() => {
  for (const d of made) removeTree(d)
})

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}

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
  readonly files: readonly RelPath[]
}

/**
 * 一个真仓库：内容里有嵌套目录 · 可执行位 · 软链，全树提交一次。
 * **工作树与那个提交逐字节一致**——这正是断言①要顺带核的那一句（"底与 base 一致"）。
 * `.fugue` 在这个提交之后才会由 `fugue` 自己建出来，所以它不在 base 里。
 */
function fixture(): Fixture {
  const dir = tmp('fugue-fork-')
  const put = (rel: string, body: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  put('src/a.ts', 'export const a = 1\n')
  put('src/deep/nest/b.ts', 'export const b = 2\n')
  put('docs/manual.md', '# 手册\n')
  put('vendor/lib.txt', 'vendored\n')
  put('bin/run.sh', '#!/bin/sh\necho hi\n')
  chmodSync(join(dir, 'bin/run.sh'), 0o755)
  symlinkSync('src/a.ts', join(dir, 'link.ts'))
  git(dir, ['init', '-q', '.'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  assert.equal(git(dir, ['status', '--porcelain']), '', '夹具的工作树要是干净的')
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']) as CommitId, files: ['link.ts', 'src/a.ts'] }
}

interface Leaf {
  path: RelPath
  mode: number
  hash: string
}

function digest(leaves: readonly Leaf[]): string {
  const lines = leaves
    .map((l) => `${l.path}\t${l.mode.toString(8)}\t${l.hash}`)
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** git 那一侧：一个提交的树，逐条读出内容来算哈希。 */
async function fromCommit(dir: string, commit: CommitId): Promise<Leaf[]> {
  const truth = openTruth(dir)
  const out: Leaf[] = []
  const walk = async (at: RelPath): Promise<void> => {
    for (const e of await truth.listAt(commit, at)) {
      const rel: RelPath = at === '' ? e.name : `${at}/${e.name}`
      if (e.kind === 'dir') {
        await walk(rel)
        continue
      }
      if (e.kind === 'gitlink') throw new Error(`夹具里不该有 gitlink：${rel}`)
      const bytes = await truth.readAt(commit, rel)
      assert.notEqual(bytes, null, `${rel} 读不出来`)
      out.push({
        path: rel,
        mode: e.mode,
        hash: createHash('sha256').update(bytes as Uint8Array).digest('hex'),
      })
    }
  }
  await walk('')
  await truth.close()
  return out
}

/** 物化那一侧：真文件系统的字节。模式折算成 git 的那三种（普通文件按可执行位分两档）。 */
async function fromTree(root: string): Promise<Leaf[]> {
  return scanTree(root, { skip: WORKSPACE_STATE }).leaves.map((l) => ({
    path: l.path,
    mode: l.kind === 'symlink' ? 0o120000 : 0o100000 | (l.mode & 0o777),
    hash: l.hash,
  }))
}

async function openFixture(f: Fixture): Promise<{ roots: Roots; log: ReturnType<typeof openLog> }> {
  const roots = createRoots(f.dir)
  const log = openLog(f.dir)
  return { roots, log }
}

function opts(extra: Partial<MaterializeOptions>): MaterializeOptions {
  return { ...DEFAULT_MATERIALIZE, ...extra }
}

/** 日志里最后一条 `mat/fork`。 */
function lastForkEvent(dir: string): Record<string, unknown> {
  const text = readFileSync(join(dir, '.fugue', 'log', 'round.jsonl'), 'utf8')
  // 信封是平的一行：`{seq, writer, crc, t, …载荷}`（§ 9.2 的自描述信封）。
  const rows = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  const forks = rows.filter((r) => r['t'] === 'mat/fork')
  assert.ok(forks.length > 0, '日志里要有一条 mat/fork')
  return forks[forks.length - 1]
}

test('① 探针与选档：能用的第一档胜出（偏好先试），跳过的每一档都带由头报出来', () => {
  const noOverlay = {
    fs: 'ext2/3/4',
    overlayfs: null,
    overlayfsNote: '当前命名空间里挂不动（测试造的）',
    hardlink: true,
  }
  const pick = (opt: MaterializeOptions, facts = noOverlay) => chooseStrategy(facts, opt)

  const a = pick(opts({}))
  assert.equal(a.ok, true)
  assert.equal(a.ok && a.choice.strategy, 'copy')
  assert.match(a.ok ? a.choice.why : '', /跳过 overlayfs/)

  const b = pick(opts({ readOnlyPaths: ['vendor'] }))
  assert.equal(b.ok && b.choice.strategy, 'hardlink-ro')

  // 偏好不是命令：先试它，不可用照样往下退，但退的时候要说得出来。
  const c = pick(opts({ preferredStrategy: 'overlayfs' }))
  assert.equal(c.ok && c.choice.strategy, 'copy')
  assert.match(c.ok ? c.choice.why : '', /跳过 overlayfs/)
  assert.match(c.ok ? c.choice.why : '', /挂不动/)

  const d = pick(opts({ preferredStrategy: 'reflink' }))
  assert.equal(d.ok && d.choice.strategy, 'copy')
  assert.match(d.ok ? d.choice.why : '', /跳过 reflink/)
  assert.match(d.ok ? d.choice.why : '', /XFS/)

  // 链不起来时 `hardlink-ro` 那一档也不成立，退到 copy——理由要是物理前提，不是"没有声明"。
  const e = pick(opts({ readOnlyPaths: ['vendor'] }), { ...noOverlay, hardlink: false })
  assert.equal(e.ok && e.choice.strategy, 'copy')
  assert.match(e.ok ? e.choice.why : '', /硬链接铺不动/)

  // 有 overlay 就用 overlay，一档都不跳。
  const f = pick(opts({}), { ...noOverlay, overlayfs: 'direct' })
  assert.equal(f.ok && f.choice.strategy, 'overlayfs')
  assert.equal(f.ok ? f.choice.mount : 'x', 'direct')
})

test('② copy 档：全树哈希 == 该提交的 tree，且清单记的是变化不是铺设', async () => {
  const f = fixture()
  const { roots, log } = await openFixture(f)
  try {
    const res = await fork({ roots, log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'copy' }))
    assert.equal(res.strategy, 'copy')
    assert.equal(res.mount, null)
    assert.ok((res.laid?.files ?? 0) >= 4, `铺了 ${res.laid?.files} 个文件`)

    assert.equal(digest(await fromTree(res.merged)), digest(await fromCommit(f.dir, f.commit)))

    // 可执行位与软链是断言①那半句"含 symlink 与可执行位"的落点，单独再钉一次。
    assert.equal(statSync(join(res.merged, 'bin/run.sh')).mode & 0o777, 0o755)
    assert.equal(lstatSync(join(res.merged, 'link.ts')).isSymbolicLink(), true)
    assert.equal(readFileSync(join(res.merged, 'link.ts'), 'utf8'), 'export const a = 1\n')
    // 工作区的状态不进物化树（`WORKSPACE_STATE`）。
    for (const s of WORKSPACE_STATE) assert.equal(existsSync(join(res.merged, s)), false, s)
    // `preserveMtime` 默认 true：按修改时间判定新旧的工具链不该因为一次 fork 就全部重编。
    // 精度断言到**亚毫秒**：`utimes` 这一族接口给到纳秒，而 `Date` 那一档只到毫秒（实测偏
    // 172 µs），所以这里钉的是"没有整秒/整毫秒的挪动"，不是逐纳秒相等。
    const delta = Math.abs(statSync(join(res.merged, 'src/a.ts')).mtimeMs - statSync(join(f.dir, 'src/a.ts')).mtimeMs)
    assert.ok(delta < 1, `mtime 偏了 ${delta} ms`)

    const e = lastForkEvent(f.dir)
    assert.equal(e['t'], 'mat/fork')
    assert.equal(e['strategy'], 'copy')
    assert.equal(e['base'], f.commit)
    assert.deepEqual(e['paths'], [], '清单记的是变化：fork 什么都没"铺"过（§ 8.5）')
    assert.deepEqual(e['hashes'], [])
  } finally {
    await log.close()
  }
})

test('③ hardlink-ro 档：只链声明过的只读子树，穿透与不穿透两个负对照都在位', async () => {
  const f = fixture()
  const { roots, log } = await openFixture(f)
  try {
    const res = await fork(
      { roots, log, root: f.dir },
      AGENT,
      f.commit,
      opts({ preferredStrategy: 'hardlink-ro', readOnlyPaths: ['vendor'] }),
    )
    assert.equal(res.strategy, 'hardlink-ro')
    assert.equal(digest(await fromTree(res.merged)), digest(await fromCommit(f.dir, f.commit)))

    // 声明过的：共享 inode。
    assert.equal(statSync(join(res.merged, 'vendor/lib.txt')).ino, statSync(join(f.dir, 'vendor/lib.txt')).ino)
    // 没声明的：独立的一份。
    assert.notEqual(statSync(join(res.merged, 'src/a.ts')).ino, statSync(join(f.dir, 'src/a.ts')).ino)

    // 负对照一 · 穿透是真的：就地写链上那条，底里那条跟着变（§ 8.5 硬链接纪律的原文）。
    const before = statSync(join(f.dir, 'vendor/lib.txt')).size
    appendFileSync(join(res.merged, 'vendor/lib.txt'), '污染\n')
    assert.equal(statSync(join(f.dir, 'vendor/lib.txt')).size, before + 7, '共享 inode 被穿透，真源被污染')

    // 负对照二 · 没声明的路径写不穿：它是复制出来的那一份。
    const srcBefore = statSync(join(f.dir, 'src/a.ts')).size
    appendFileSync(join(res.merged, 'src/a.ts'), 'x\n')
    assert.equal(statSync(join(f.dir, 'src/a.ts')).size, srcBefore)

    // 负对照三 · 全树用硬链接必须被拒（没有只读声明时那一档直接不成立）。
    const refused = chooseStrategy(
      { fs: 'ext2/3/4', overlayfs: null, overlayfsNote: '挂不动', hardlink: true },
      opts({ preferredStrategy: 'hardlink-ro' }),
    )
    assert.equal(refused.ok && refused.choice.strategy, 'copy')
    assert.match(refused.ok ? refused.choice.why : '', /跳过 hardlink-ro/)
    assert.match(refused.ok ? refused.choice.why : '', /硬链接纪律/)
  } finally {
    await log.close()
  }
})

test('④ 退档：没有 overlay、sudo 也不通的环境里，fork 自己用 copy 并报出为什么', async () => {
  const f = fixture()
  const code = `
    const forkMod = await import(process.env.FORK_MODULE)
    const logMod = await import(process.env.LOG_MODULE)
    const rootsMod = await import(process.env.ROOTS_MODULE)
    const roots = rootsMod.createRoots(process.env.FIXTURE)
    const log = logMod.openLog(process.env.FIXTURE)
    try {
      const res = await forkMod.fork({ roots, log, root: process.env.FIXTURE }, 'round', process.env.COMMIT)
      console.log(JSON.stringify({ strategy: res.strategy, why: res.why, merged: res.merged }))
    } finally {
      await log.close()
    }
  `
  const r = spawnSync('unshare', ['-Ur', '--', process.execPath, '--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FORK_MODULE: join(HERE, 'fork.ts'),
      LOG_MODULE: join(HERE, '..', 'log', 'log.ts'),
      ROOTS_MODULE: join(HERE, '..', 'roots', 'roots.ts'),
      FIXTURE: f.dir,
      COMMIT: f.commit,
    },
  })
  assert.equal(r.status, 0, `userns 那一趟没跑成：${r.stderr}`)
  const got = JSON.parse(r.stdout.trim()) as { strategy: string; why: string; merged: string }
  assert.equal(got.strategy, 'copy', `退档退到的是 ${got.strategy}`)
  assert.match(got.why, /跳过 overlayfs/)
  assert.match(got.why, /copy 档：处处可用/)
  assert.equal(existsSync(join(got.merged, 'src/a.ts')), true)
})

test('⑤ overlayfs 档：挂上、哈希相等、挂载与落地互斥、重挂后可见', async (t) => {
  const f = fixture()
  const { roots, log } = await openFixture(f)
  const spec = (): OverlaySpec => ({
    lower: f.dir,
    upper: roots.scratchRoot(AGENT),
    work: join(roots.tempRoot(AGENT), 'work'),
    merged: roots.mergedRoot(AGENT),
  })
  try {
    mkdirSync(roots.tempRoot(AGENT), { recursive: true })
    const facts = probePlatform(f.dir, join(roots.tempRoot(AGENT), 'probe'))
    assert.notEqual(
      facts.overlayfs,
      null,
      `这一档在这台机器上验不了：${facts.overlayfsNote}\n整份测试跑在 \`unshare -Ur -m\` 里，或者给无密码 sudo。`,
    )

    const res = await fork({ roots, log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'overlayfs' }))
    assert.equal(res.strategy, 'overlayfs')
    assert.equal(res.laid, null, 'overlayfs 什么都不铺')
    assert.equal(isMounted(res.merged), true)
    assert.equal(digest(await fromTree(res.merged)), digest(await fromCommit(f.dir, f.commit)))

    // 断言③：挂载与落地互斥。
    //
    // **口径按实测收窄了一格**（V2 的读数，内核 6.18）：挂载态从外部写 `upper` 之后，
    // **改过的已有路径**在 `merged` 里看不见新内容（0/3，dcache 陈旧）——这正是"delta 落地
    // 一律在卸载态"要防的那件事；而**新加进去的路径**当场就看得见（3/3）。所以断言的落点是
    // 前者，后者作为读数记在注释里，不当成"不可见"来钉——钉死它等于依赖 dcache 的具体行为。
    const upper = roots.scratchRoot(AGENT)
    const old = new Map<string, string>()
    const tweaked = ['src/a.ts', 'src/deep/nest/b.ts', 'docs/manual.md']
    for (const n of tweaked) {
      old.set(n, readFileSync(join(res.merged, n), 'utf8'))
      mkdirSync(dirname(join(upper, n)), { recursive: true })
      writeFileSync(join(upper, n), '挂载期间改的\n')
    }
    const added = ['probe1.txt', 'probe2.txt', 'probe3.txt']
    for (const n of added) writeFileSync(join(upper, n), '事后补的\n')

    let stale = tweaked.filter((n) => readFileSync(join(res.merged, n), 'utf8') === old.get(n)).length
    assert.equal(stale, tweaked.length, `挂载态下 upper 里改过的 ${tweaked.length} 个路径，merged 里该一个都看不见新内容`)
    // **这一条只记读数，不当断言**：实测（内核 6.18）挂载态下 upper 里**新加**的路径是当场
    // 可见的（3/3），与"改过的"那一半不同。把它钉成断言就等于依赖 dcache 的具体行为——而
    // 机制约束要的是"delta 落地一律在卸载态"，不是"每一个方向都看不见"。
    const addedVisible = added.filter((n) => existsSync(join(res.merged, n))).length
    t.diagnostic(`挂载态读数：改过的 ${tweaked.length - stale}/${tweaked.length} 看得见新内容，新加的 ${addedVisible}/${added.length} 当场可见`)

    unmountOverlay(res.merged)
    assert.equal(isMounted(res.merged), false)
    mountOverlay(spec(), res.mount ?? 'direct')
    stale = tweaked.filter((n) => readFileSync(join(res.merged, n), 'utf8') === old.get(n)).length
    assert.equal(stale, 0, `卸载重挂后该 ${tweaked.length} 个都看得见新内容`)
    for (const n of added) assert.equal(existsSync(join(res.merged, n)), true, `${n} 重挂后要可见`)
    assert.equal(digest(await fromTree(res.merged)) === digest(await fromCommit(f.dir, f.commit)), false, '改过之后当然不再等于 base 的树')
  } finally {
    clearMaterialization(roots.mergedRoot(AGENT), [roots.scratchRoot(AGENT), roots.mergedRoot(AGENT), roots.tempRoot(AGENT)])
    await log.close()
  }
})

test('⑥ 缓存说挂得动而真挂失败：重探一次，如实报出实际用的那一门', async () => {
  const f = fixture()
  const { roots, log } = await openFixture(f)
  try {
    mkdirSync(roots.tempRoot(AGENT), { recursive: true })
    const real = probePlatform(f.dir, join(roots.tempRoot(AGENT), 'probe'))
    if (real.overlayfs === null) return // 这一档本来就不成立；④ 已经覆盖了那条路
    // 埋一条假事实：说 direct 挂得上，而这一门命名空间里其实挂不动。
    await saveFacts(f.dir, { ...real, overlayfs: 'direct' })
    const res = await fork({ roots, log, root: f.dir }, AGENT, f.commit, opts({ preferredStrategy: 'overlayfs' }))
    assert.equal(res.strategy, 'overlayfs')
    assert.notEqual(res.mount, null)
    assert.equal(isMounted(res.merged), true)
    assert.equal(res.facts.overlayfs, res.mount, '重探之后缓存要跟上事实')
  } finally {
    clearMaterialization(roots.mergedRoot(AGENT), [roots.scratchRoot(AGENT), roots.mergedRoot(AGENT), roots.tempRoot(AGENT)])
    await log.close()
  }
})
