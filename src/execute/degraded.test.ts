// X4 的断言：**退化档——沙箱不在时，同一批动作照样跑得出同一份结果**（PLAN § 5.4 的 X4 行）。
//
//   ① 沙箱关掉时跑得出**同一份声明集**：声明集内的产出与全档那一趟逐字节相同，退出码也相同
//   ② 这一档上未声明的写入长得出来，且被回收拒绝、在日志里留下 `mat/reclaim`（`declared` 与
//      `changed` 两栏）——第三条验证"记事件"那一半在这里兑现
//   ③ 如实报出这次是哪个档（`run/confined` 的 `enforcement`），不静默降级
//   ④ **地板**：把 `bwrap` 从 PATH 上拿掉（§ 15.7 的 E4 真的不成立），同一趟照样跑得出同一份
//      声明集，并且如实报 partial——判据是"变慢，还是跑不起来"。**Y6 起这里降一档而不是降到
//      底**：第二层（Landlock）接过来，"未声明的写入当场拒"那一维还在，于是树不可写
//      （`mode` 如实报 `read-only`）。两层都不在时才是原样那一档（树可写 + 回收兜底）。
//
// **两处落点**是这一档最要紧的一件事：默认档里声明目录整个绑到 per-agent 缓存上（§ 8.6 第 2 步），
// 产出落在**绑定那一侧**；退化档里没有挂载就没有绑定，产出落在**树自己那一侧**。所以
// `collect()` 读的落点随档变（`reclaim.ts` 的 `landingOf`），而"声明集外的改动"照旧是
// `upper` 的叶子减掉清单——两件事各是各的读数。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

function fugue(root: string, ...args: string[]): Run {
  return fugueEnv({}, root, ...args)
}

/** `env` 是**加在**宿主环境上的那几栏（`PATH` 那一条负对照要换掉它）。 */
function fugueEnv(env: Record<string, string>, root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env: { ...process.env, ...env },
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

function git(cwd: string, ...args: string[]): string {
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
      GIT_AUTHOR_DATE: '2026-02-01T00:00:00+0000',
      GIT_COMMITTER_DATE: '2026-02-01T00:00:00+0000',
    },
  })
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`)
  return r.stdout.trim()
}

/** 干净的构建：**只写声明过的那一处**，两个档应当给出同一个退出码与同一份字节。 */
const CLEAN = `import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
execFileSync('cc', ['-o', 'dist/app', 'src/a.c'])
console.log('build ok')
`

/** 脏的那一个：除了声明过的产出，还往树里写一条**没声明**的。 */
const DIRTY = `import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
execFileSync('cc', ['-o', 'dist/app', 'src/a.c'])
appendFileSync('junk.txt', 'undeclared\\n')
console.log('dirty ok')
`

const C_SRC = '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n'

interface Made {
  readonly root: string
  readonly base: string
}
const MADE: Made[] = []
const BINS: string[] = []

function workspace(): Made {
  const root = mkdtempSync(join(tmpdir(), 'fugue-x4-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.c'), C_SRC)
  writeFileSync(join(root, 'build.mjs'), CLEAN)
  writeFileSync(join(root, 'dirty.mjs'), DIRTY)
  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  const base = git(root, 'rev-parse', 'HEAD')
  const made: Made = { root, base }
  MADE.push(made)
  fugue(root, 'config', 'set', 'actions.build', '{"argv":["node","build.mjs"],"cache":["dist"],"outputs":["dist/app"]}')
  fugue(root, 'config', 'set', 'actions.dirty', '{"argv":["node","dirty.mjs"],"cache":["dist"],"outputs":["dist/app"]}')
  assert.equal(fugue(root, 'branch', base).code, 0)
  assert.equal(fugue(root, 'fork', base).code, 0)
  return made
}

after(() => {
  for (const w of MADE) {
    fugue(w.root, 'dispose')
    try {
      rmSync(w.root, { recursive: true, force: true })
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', w.root], { encoding: 'utf8' })
    }
  }
  for (const b of BINS) rmSync(b, { recursive: true, force: true })
})

interface Row {
  readonly pos: { writer: string; seq: number }
  readonly e: Record<string, unknown> & { t: string }
}

function rowsOf(root: string): Row[] {
  const r = fugue(root, '--json', 'log')
  assert.equal(r.code, 0, r.err)
  return r.out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
}

function writes(rows: readonly Row[]): { path: string; blob: string }[] {
  return rows.filter((r) => r.e.t === 'view/write').map((r) => ({ path: String(r.e.path), blob: String(r.e.blob) }))
}

const at = (root: string, ...parts: string[]): string => join(root, '.fugue', 'mat', 'round', ...parts)

test('X4 ① · 同一份声明集：全档与退化档的产出逐字节相同，退出码也相同', () => {
  const w = workspace()
  const full = fugue(w.root, '--json', 'run', 'build')
  assert.equal(full.code, 0, full.err)
  const first = JSON.parse(full.out.trim()) as Record<string, unknown>
  assert.equal(first.exit, 0)
  assert.equal(first.enforcement, 'full')
  const blobFull = writes(rowsOf(w.root))[0]?.blob

  // 全档的落点是**绑定那一侧**：缓存的 `dist/app`。树里那一条不存在（产出一个字节没进树）。
  const cacheApp = at(w.root, 'cache', 'dist', 'app')
  const upperApp = at(w.root, 'upper', 'dist', 'app')
  assert.equal(existsSync(cacheApp), true, '全档：产物落在缓存的落点上')
  assert.equal(existsSync(upperApp), false, '全档：树那一侧没有它')
  const bytesFull = readFileSync(cacheApp)

  // 对齐之后跑退化档：**同一个 agent 的第二次**，比的是同一棵树里的同一份产出。
  assert.equal(fugue(w.root, 'ensure').code, 0)
  const deg = fugue(w.root, '--json', 'run', 'build', '--mode', 'workspace-write')
  assert.equal(deg.code, 0, deg.err)
  const second = JSON.parse(deg.out.trim()) as Record<string, unknown>
  assert.equal(second.exit, first.exit, '退出码相同')
  assert.deepEqual(second.reclaimed, ['dist/app'], '声明集内的产出照样收得回来')
  assert.equal(second.enforcement, 'partial')

  // 退化档的落点是**树自己那一侧**：树上有了，而缓存那一侧没有新的字节（它没被绑）。
  assert.equal(existsSync(upperApp), true, '退化档：产物落在树那一侧的落点上（upper）')
  const blobDeg = writes(rowsOf(w.root))[1]?.blob
  assert.equal(blobDeg, blobFull, '产出逐字节相同（view/write 的 blob 就是内容的 sha1）')
  assert.equal(readFileSync(upperApp).equals(bytesFull), true, '盘上那两份也逐字节相同')
})

test('X4 ② · 未声明的写入：这一档长得出来，被回收拒，日志里留下 mat/reclaim 两栏', () => {
  const w = workspace()
  // 先看默认档：同一条写入**被内核拒**（子进程非零退出），树一个字节没变，也没有那条事件。
  const blocked = fugue(w.root, '--json', 'run', 'dirty')
  assert.equal(blocked.code, 1, '默认档：子进程没成功')
  const bj = JSON.parse(blocked.out.trim()) as Record<string, unknown>
  assert.equal(bj.denied, true, '被内核拒这件事读出来了——node 报的是 EROFS 那一句')
  assert.match(blocked.err, /EROFS|Read-only file system/)
  assert.equal(rowsOf(w.root).some((r) => r.e.t === 'mat/reclaim'), false, '默认档里不落那条事件')
  assert.equal(existsSync(at(w.root, 'upper', 'junk.txt')), false)

  // 退化档：同一条写入长得出来，被回收拒，并记一条 `mat/reclaim`。
  const r = fugue(w.root, '--json', 'run', 'dirty', '--mode', 'workspace-write')
  assert.equal(r.code, 0, r.err)
  const j = JSON.parse(r.out.trim()) as Record<string, unknown>
  assert.deepEqual(j.reclaimed, ['dist/app'], '声明过的照样收')
  assert.deepEqual(j.undeclared, ['junk.txt'], '越了声明的那一条被拒')
  // 长得出来：它真在树里（这一档的沙箱是关着的）。
  assert.equal(existsSync(at(w.root, 'upper', 'junk.txt')), true, '未声明的那一条真写下去了')
  assert.equal(readFileSync(at(w.root, 'upper', 'junk.txt'), 'utf8'), 'undeclared\n')
  // 绝不静默收下：它没有进视图，`diff` 里只有声明过的那一条。
  assert.equal(fugue(w.root, 'read', 'junk.txt').code, 1, '视图里读不到它')
  // 视图里**一条它的写入都没有**——`read` 读不到还可以有别的原因，这条是正面读数。
  assert.deepEqual(
    rowsOf(w.root)
      .filter((r) => r.e.t === 'view/write')
      .map((r) => r.e.path),
    ['dist/app', 'dist/app'],
    '两次运行各收一条（默认档那一次声明过的产出照样收），越了声明的一条都没进视图',
  )
  // `diff` 是"自某个修订点以来的变更序列"（两趟就是两行），所以这里比的是**路径的集合**。
  const diff = fugue(w.root, 'diff')
  assert.deepEqual(
    [...new Set(diff.out.trim().split('\n').filter(Boolean).map((l) => l.split('\t')[1]))],
    ['dist/app'],
  )
  // 两栏都对，而且**正好一条**。
  const claims = rowsOf(w.root).filter((x) => x.e.t === 'mat/reclaim')
  assert.equal(claims.length, 1, '一条 mat/reclaim')
  assert.deepEqual((claims[0] as Row).e.declared, ['dist/app'])
  assert.deepEqual((claims[0] as Row).e.changed, ['junk.txt'])
})

test('X4 ③ · 如实报档：run/confined 与 stderr 都说清这一次是哪个档', () => {
  const w = workspace()
  const deg = fugue(w.root, 'run', 'build', '--mode', 'workspace-write')
  assert.equal(deg.code, 0, deg.err)
  assert.match(deg.err, /workspace-write · partial 档/)
  assert.match(deg.err, /没有沙箱（命令行上点名要树可写那一档（--mode workspace-write））/)
  assert.match(deg.out, /^0\t\d+\tpartial\n$/, 'stdout 上那一行也报的是 partial')

  const confined = rowsOf(w.root).filter((r) => r.e.t === 'run/confined')
  assert.deepEqual(
    confined.map((r) => ({ mode: r.e.mode, enforcement: r.e.enforcement })),
    [{ mode: 'workspace-write', enforcement: 'partial' }],
  )

  // 默认档一行没动：还是 read-only + full。
  const full = fugue(w.root, 'run', 'build')
  assert.equal(full.code, 0, full.err)
  assert.match(full.out, /^0\t\d+\tfull\n$/)
  assert.deepEqual(
    rowsOf(w.root)
      .filter((r) => r.e.t === 'run/confined')
      .map((r) => r.e.enforcement),
    ['partial', 'full'],
  )
})

test('X4 ④ · 地板：bwrap 从 PATH 上拿掉，同一趟照样跑得出同一份声明集', () => {
  const w = workspace()
  const full = fugue(w.root, '--json', 'run', 'build')
  assert.equal(full.code, 0, full.err)
  const sandboxed = JSON.parse(full.out.trim()) as Record<string, unknown>
  assert.equal(sandboxed.sandbox, true, '这台机器上 bwrap 在')
  const bytes = readFileSync(at(w.root, 'cache', 'dist', 'app'))

  // 一面"除了 bwrap 什么都有"的 PATH：把两个 bin 目录整个镜像过来，去掉那一个。
  const bin = mkdtempSync(join(tmpdir(), 'fugue-x4-bin-'))
  BINS.push(bin)
  for (const dir of ['/usr/bin', '/usr/local/bin']) {
    for (const name of readdirSync(dir)) {
      if (name === 'bwrap') continue
      try {
        symlinkSync(join(dir, name), join(bin, name))
      } catch {
        // 重名（/usr/local/bin 覆盖 /usr/bin）不是错，先来的那个算
      }
    }
  }
  const noBwrap = { PATH: bin }
  const probe = spawnSync('bwrap', ['--version'], { env: { ...process.env, ...noBwrap }, encoding: 'utf8' })
  assert.equal((probe.error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT', '这条路上真没有 bwrap')

  // 挂载层死掉了：同一趟照样跑得出来，第二层接过来——**报 partial，不静默降级，也不是跑不起来**。
  assert.equal(fugue(w.root, 'ensure').code, 0)
  const deg = fugueEnv(noBwrap, w.root, '--json', 'run', 'build')
  assert.equal(deg.code, 0, deg.err)
  const j = JSON.parse(deg.out.trim()) as Record<string, unknown>
  assert.equal(j.sandbox, false, '自己探出来 bwrap 不在')
  assert.deepEqual(j.layers, ['landlock'], '挂载层不在，第二层还在场（Y6）')
  assert.equal(j.enforcement, 'partial')
  assert.match(String(j.sandboxNote), /bwrap/)
  assert.deepEqual(j.reclaimed, ['dist/app'])
  assert.equal(readFileSync(at(w.root, 'upper', 'dist', 'app')).equals(bytes), true, '产出与全档那一趟逐字节相同')

  const confined = rowsOf(w.root).filter((r) => r.e.t === 'run/confined').pop()
  assert.deepEqual(
    { mode: confined?.e.mode, enforcement: confined?.e.enforcement },
    { mode: 'read-only', enforcement: 'partial' },
     '`run/confined` 那一条也如实报：树不可写（第二层管着那一维）· 少一层纵深',
  )
  // 这一档里 `junk.txt` 那类写入**由内核当场拒**（第二层），树里长不出来、也进不来视图。
  assert.equal(fugue(w.root, 'read', 'junk.txt').code, 1)
})
