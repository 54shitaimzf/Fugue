// tier: real —— bwrap · cc（真沙箱加真编译探针）
// Y6 的断言（PLAN § 5.5 的 Y6 行 · 架构 § 8.8 的"两层机制，实测均可用" · § 15.7 的 E5 ·
// § 3 那张表里"边界 受限令牌 → 只读"）。
//
//   ① **退化档里未声明的写入当场被拒**：挂载层不在（`bwrap` 从 PATH 上拿掉）、第二层在。
//      同一趟里：未声明的那些写入由**内核**当场拒（EACCES，树里一个字节不变），声明目录照写、
//      产物照回收。
//      **负对照**：第二层也拿掉（两层都不在）→ 同一趟把那些字真写进树里，回收报出来
//      （`undeclared` 一栏）——**X4 的读数原样**。两个读数的差别就是这一层在不在。
//   ② **ABI 用系统调用探，不读 `/sys`**：把 `/sys` 那一扇门自己关上（`bwrap --tmpfs /sys`）再问
//      一次，答案不变，而层照样在场——按文件探会得到假阴性（架构 § 8.8 那条）。WSL 里 `securityfs`
//      本来就没挂，CI 的 runner 上挂着；所以这一条的条件是**造出来的**，不是"读读看读不到"。
//   ③ **可写集含 `/dev/null` 那一类**：不含它时任何一次重定向都翻车（直接问包装器，两个读数），
//      而命令面那一档给的就是含它的那一份。
//
// 这一份用**真命令行**（`fugue run <动作>`），不是直驱 `confine()`：地板那一档是命令面定下来的
// （`probeLayers` → `resolvePolicy` → `degradedArgv`），断言要落在那一整条路上。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { createRoots } from '../roots/roots.ts'
import { ensureHelper, helperPath, probeLandlock } from './landlock.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const AGENT = 'round'

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** `env` 是**加在**宿主环境上的那几栏（那几条"层不在"的负对照要换掉 `PATH`）。 */
function fugueEnv(env: Record<string, string>, root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

const fugue = (root: string, ...args: string[]): Run => fugueEnv({}, root, ...args)

interface Json {
  readonly layers: string[]
  readonly mode: string
  readonly enforcement: string
  readonly mechanism: string
  readonly sandbox: boolean
  readonly sandboxNote: string
  readonly reclaimed: string[]
  readonly undeclared: string[]
}

function runJson(env: Record<string, string>, root: string, ...args: string[]): Json {
  const r = fugueEnv(env, root, '--json', '--agent', AGENT, ...args)
  assert.equal(r.code, 0, r.err)
  return JSON.parse(r.out.trim()) as Json
}

function git(cwd: string, ...args: string[]): void {
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
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`)
}

/** 写一条进树、一条进声明目录：两个读数在同一趟里，免得"被拒"与"照写"各说各话。 */
const WRITE_JUNK = {
  argv: ['sh', '-c', 'echo junk > junk.txt; echo app > dist/app'],
  cache: ['dist'],
  outputs: ['dist/app'],
}
/** 只做一件事：往 `/dev/null` 重定向（断言 ③ 在真命令行上那一条）。 */
const REDIRECT = { argv: ['sh', '-c', 'echo x > /dev/null; echo 重定向 ok'] }

const MADE: string[] = []
const BINS: string[] = []

/** 一棵仓库 + 两个动作 + 一条分出去的分支（物化好）。**helper 还没编过**——两个负对照要这个。 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'fugue-y6-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.txt'), 'hi\n')
  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  for (const [k, v] of [
    ['actions.write-junk', JSON.stringify(WRITE_JUNK)],
    ['actions.redirect', JSON.stringify(REDIRECT)],
  ]) {
    assert.equal(fugue(root, 'config', 'set', k, v).code, 0, `config set ${k}`)
  }
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  for (const cmd of ['branch', 'fork', 'ensure']) {
    assert.equal(fugue(root, '--agent', AGENT, cmd, cmd === 'ensure' ? '' : base).code, 0, cmd)
  }
  MADE.push(root)
  return root
}

/**
 * 一条"这个程序起不来"的 PATH：前面挂一个临时目录，里面每个名字都软链到 `/bin/false`。
 *
 * 拿掉 `bwrap` 就是 E4（挂载层不在）；再拿掉 `cc` 就是"两层都不在"——第二层要 `cc` 才编得出来，
 * 而**没有编过一次的工作区**里它编不出来，于是这一层如实缺。
 */
function shim(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-y6-bin-'))
  BINS.push(dir)
  for (const n of names) symlinkSync('/bin/false', join(dir, n))
  return dir
}

const pathWith = (dir: string): string => `${dir}:${process.env.PATH ?? ''}`

/**
 * 把 `/sys` 遮掉再问一次探针（`bwrap --tmpfs /sys`）——**条件是造出来的**。
 *
 * WSL 里 `securityfs` 本来就没挂、那个文件读不到，CI 的 runner 上挂着：那一条要是写成"读读看
 * 读不到"，它就只在一种宿主上成立。这里用挂载层把那扇门关上（同一个探针 · 同一个内核 · `/sys`
 * 里空无一物），并在同一门里确认那个文件确实读不到了。
 *
 * `null` = 这一台起不了 `bwrap`：那一档有自己的断言（Y6 ① 与 `degraded.test.ts`），这里只是
 * 造不出这个条件，如实降成一条 diagnostic，不静默地把断言吞掉。
 */
function probeWithoutSys(bin: string): { out: string; err: string } | null {
  const r = spawnSync(
    'bwrap',
    [
      '--dev-bind', '/', '/',
      '--tmpfs', '/sys',
      '--', 'sh', '-c',
      'if [ -r /sys/kernel/security/lsm ]; then echo SYS-READABLE; fi; exec "$0" --probe',
      bin,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  )
  if (r.error !== undefined && r.error !== null) return null
  return { out: r.stdout ?? '', err: r.stderr ?? '' }
}

after(() => {
  for (const root of MADE) {
    fugue(root, '--agent', AGENT, 'dispose')
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', root], { encoding: 'utf8' })
    }
  }
  for (const b of BINS) rmSync(b, { recursive: true, force: true })
})

test('Y6 ① · 地板：挂载层不在、第二层在——未声明的写入当场拒，声明目录照写、产物照回收', () => {
  const root = fixture()
  const roots = createRoots(root)
  const noBwrap = { PATH: pathWith(shim('bwrap')) }

  // 正对照先来：两层都在的那一档，同一个动作跑得通（免得下面那两条红的只是"这台机器跑不动"）。
  const full = runJson({}, root, 'run', 'write-junk')
  assert.deepEqual(full.layers, ['bwrap', 'landlock'], '两层都在场')
  assert.equal(full.enforcement, 'full')
  assert.equal(full.mechanism, 'bwrap')

  const raw = fugueEnv(noBwrap, root, '--json', '--agent', AGENT, 'run', 'write-junk')
  assert.equal(raw.code, 0, raw.err)
  const deg = JSON.parse(raw.out.trim()) as Json
  console.log(
    `\n── ① 挂载层不在那一档 ──\n  layers=${deg.layers.join('+')} · mode=${deg.mode} · ` +
      `enforcement=${deg.enforcement} · mechanism=${deg.mechanism}\n  子进程那一侧：` +
      JSON.stringify(raw.err.trim().split('\n')),
  )
  assert.deepEqual(deg.layers, ['landlock'], '挂载层不在，第二层接过来')
  assert.equal(deg.mode, 'read-only', '它管着"写得动什么"那一维：树因此不可写')
  assert.equal(deg.enforcement, 'partial', '少一层纵深，如实降')
  assert.equal(deg.sandbox, false, '没有挂载层')
  assert.equal(deg.mechanism, 'landlock')
  assert.match(deg.sandboxNote, /bwrap/, '那两句原话都在：bwrap 为什么不在')

  // **未声明的那一条**：内核当场拒（EACCES 的那句话在子进程的 stderr 上），树里一个字节不变。
  assert.match(raw.err, /junk\.txt: Permission denied/, '当场拒，报的是内核的话')
  assert.equal(existsSync(join(roots.mergedRoot(AGENT), 'junk.txt')), false, '合并树里没有它')
  assert.equal(existsSync(join(roots.scratchRoot(AGENT), 'junk.txt')), false, '`upper` 里也没有它')
  assert.deepEqual(deg.undeclared, [], '声明集外没有可报的东西——那些写入根本没落下去')

  // **声明的那一条**：照写，而且照回收进视图（落点是树那一侧：没有挂载层就没有绑定）。
  assert.deepEqual(deg.reclaimed, ['dist/app'], '声明集内的产出照收')
  assert.equal(fugue(root, '--agent', AGENT, 'read', 'dist/app').code, 0, '视图里读得到')
  assert.equal(fugue(root, '--agent', AGENT, 'read', 'junk.txt').code, 1, '视图里读不到 junk.txt')
})

test('Y6 ① 负对照 · 两层都不在：同一趟写得进树里，回收报出来（X4 的读数原样）', () => {
  const root = fixture()
  const roots = createRoots(root)
  const neither = { PATH: pathWith(shim('bwrap', 'cc')) }

  const deg = runJson(neither, root, 'run', 'write-junk')
  console.log(
    `\n── ① 负对照：两层都不在 ──\n  layers=[${deg.layers.join(',')}] · mode=${deg.mode} · ` +
      `mechanism=${deg.mechanism} · undeclared=${JSON.stringify(deg.undeclared)}`,
  )
  assert.deepEqual(deg.layers, [], '两层都不在')
  assert.equal(deg.mode, 'workspace-write', '树可写是那一档的事实')
  assert.equal(deg.mechanism, 'none', '命令行就是它自己')
  assert.equal(existsSync(join(roots.mergedRoot(AGENT), 'junk.txt')), true, '这一档真写得进去')
  assert.deepEqual(deg.undeclared, ['junk.txt'], '回收把这笔账报出来了')
  assert.equal(fugue(root, '--agent', AGENT, 'read', 'junk.txt').code, 1, '照旧进不来视图')
})

test('Y6 ② · ABI 用系统调用探：把 `/sys` 遮掉，探针照样报出 ABI', (t) => {
  const root = fixture()
  const roots = createRoots(root)
  const p = JSON.parse(fugue(root, '--agent', AGENT, '--json', 'policy').out.trim()) as {
    layers: string[]
  }
  assert.ok(p.layers.includes('landlock'), '这一门内核里 Landlock 在场')
  // **ABI 是跑出来的**：探针的原话里带着那个数（`layers` 里那一项就是它给的答案）。
  const probed = probeLandlock(roots)
  assert.equal(probed.ok, true, probed.note)
  assert.match(probed.note, /Landlock ABI \d+（系统调用探到的）/, 'ABI 是探出来的，原话在 note 里')
  console.log(`  ${probed.note}`)

  // **按文件探会得到假阴性**：那个文件读不读得到是**宿主事实**（WSL 里 `securityfs` 没挂，
  // CI 的 runner 上挂着），所以不拿它当断言——把那个条件自己造出来，再问同一个探针一次。
  let sysReadable = true
  try {
    readFileSync('/sys/kernel/security/lsm', 'utf8')
  } catch {
    sysReadable = false
  }
  console.log(
    `  /sys/kernel/security/lsm 这一门宿主上读得到吗：${sysReadable ? '读得到' : '读不到（securityfs 没挂）'}`,
  )
  const masked = probeWithoutSys(probed.bin)
  if (masked === null) {
    t.diagnostic('这一台起不了 bwrap，遮不住 /sys：这一条只走到"探针自己报出 ABI"')
  } else {
    assert.doesNotMatch(masked.out, /SYS-READABLE/, '遮住之后那个文件读不到了——这就是"按文件探"的条件')
    console.log(`  遮掉 /sys 之后再问一次：${masked.out.trim()}`)
    assert.match(masked.out, /ABI=\d+/, `遮住 /sys 之后探针照样报 ABI：${masked.out.trim()} ${masked.err.trim()}`)
  }

  // 探的是**真跑一次**，不是"文件在就算在"：把 `cc` 拿走、工作区里又没编过 → 这一层如实缺。
  const fresh = fixture()
  const noCc = { PATH: pathWith(shim('cc')) }
  const q = JSON.parse(fugueEnv(noCc, fresh, '--agent', AGENT, '--json', 'policy').out.trim()) as {
    layers: string[]
    note: string
  }
  assert.equal(q.layers.includes('landlock'), false, '编不出来就是不在场')
  assert.match(q.note, /cc/, '为什么不在：原话在 note 里')
})

test('Y6 ③ · 可写集含 `/dev/null` 那一类：不含它时任何一次重定向都翻车', () => {
  const root = fixture()
  const roots = createRoots(root)
  const made = ensureHelper(roots)
  assert.equal(made.ok, true, made.note)
  const rw = mkdtempSync(join(tmpdir(), 'fugue-y6-rw-'))
  BINS.push(rw)
  const shot = (args: string[]): { code: number; err: string } => {
    const r = spawnSync(made.bin, args, { encoding: 'utf8' })
    return { code: r.status ?? -1, err: r.stderr }
  }

  // 两个读数：只给一个可写目录 vs 再给上 `/dev/null`。
  const without = shot(['--rw', rw, '--', 'sh', '-c', 'echo x > /dev/null'])
  assert.notEqual(without.code, 0, '不含它：重定向当场翻车')
  assert.match(without.err, /cannot create \/dev\/null: Permission denied/)
  const withDev = shot(['--rw', rw, '--rw', '/dev/null', '--', 'sh', '-c', 'echo x > /dev/null'])
  assert.equal(withDev.code, 0, withDev.err)

  // 而命令面那一档给的就是含它的那一份：同一句话在真跑一趟里成立（`/dev/null` 是那一类设备的代表）。
  const dev = spawnSync(made.bin, ['--probe'], { encoding: 'utf8' })
  assert.equal(dev.status, 0, dev.stderr)
  const r = runJson({}, root, 'run', 'redirect')
  assert.deepEqual(r.layers, ['bwrap', 'landlock'], '沙箱档里也叠着这一层')
  assert.deepEqual(r.reclaimed, [], '这一条没声明产出')

  // `probeLandlock()` 与 `helperPath()` 是同一份落点：两处指着同一个文件。
  assert.equal(helperPath(roots), made.bin)
  assert.equal(probeLandlock(roots).ok, true, '探一次还是在场')
})
