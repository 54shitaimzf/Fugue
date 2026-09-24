// Y3 的断言（PLAN § 5.5 的 Y3 行 · 架构 § 8.8 的承重不变量 · § 23 的 U13 · § 20 S5 第二条验证）。
//
//   ① Y1 那六条泄漏用例（丁 那一组）**全部从"通"变"拒"**——其中「工作区配置」与「工作区日志」
//      走的正是 `@work/.fugue/…`，靠树里挖掉那两块关掉；且 `ls /` 只剩清单那几条
//   ② 正对照：真构建 + 真测试在沙箱里照跑得出，产物落声明目录、`upper` 里 0 个文件
//   ③ 负对照：从清单里抽掉 `/lib64` 与 `/etc/alternatives` 各一次 → 当场起不来，报的是那两条
//      实测文案
//
// **① 的对照面是 Y1 立表那天那份读数**：那一版里九条"该拒而今天通"（`src/boundary/escape.ts`
// 的头注记着原样），这一条拿同一张表 · 同一台跑器再跑一遍——同一个读法在两处读出不同的数，
// 正是"一个单元一条会失败的断言"要的东西。② 的对照面是清单本身（③）：抽掉一样，构建当场起不来。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { DEFAULT_PORTS, envFor } from '../execute/binding.ts'
import { createRoots } from '../roots/roots.ts'
import type { Roots } from '../roots/contract.ts'
import { cacheLayoutOf, confine } from './confine.ts'
import {
  AGENT,
  DECLARED,
  ESCAPE_CASES,
  GROUPS,
  OTHER_AGENT,
  PROBE_FILES,
  applySetups,
  formatReading,
  runEscapeTable,
  type EscapeFixture,
} from './escape.ts'
import { resolvePolicy } from './policy.ts'
import type { ReachSpec } from './reach.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const C_SRC = '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n'
const TS_SRC = 'export const b = 2\n'

/** 真构建：产物写进声明目录（`cache` 那一侧）。**这个动作不回写视图**——所以 `upper` 里该是 0 个文件。 */
const BUILD = `import { execFileSync } from 'node:child_process'
execFileSync('cc', ['-o', 'dist/app', 'src/a.c'])
console.log('build ok')
`

/** 真测试：`node --test` 在沙箱里跑得起来（它要 TMPDIR 与一个读得动的 cwd）。 */
const TESTFILE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('沙箱里跑得出真测试', () => { assert.equal(1 + 1, 2) })
`

/**
 * 跑一次命令行。**把 `NODE_TEST_CONTEXT` 摘掉**：验收本身就跑在 `node --test` 里，那一条会跟着
 * 宿主环境递进沙箱，而子进程里的 `node --test` 见到它就拒绝再跑测试文件（实测那句警告：
 * `node:test run() is being called recursively within a test file. skipping running files.`）。
 * **真用户从 shell 里跑没有这一条**，所以摘它的是这一层的帮手，不是产品那一面。
 */
function fugue(root: string, ...args: string[]): { code: number; out: string; err: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env,
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

interface Made {
  readonly root: string
  readonly outside: string
  readonly fx: EscapeFixture
}
const MADE: Made[] = []

/**
 * 一份 fixture 供三条断言共用：一棵有提交的树（含 `build.mjs` 与一个 `node --test` 的测试文件）·
 * 两个 agent 的物化 · 表里那几条路的形状 · 本 agent 的缓存与声明目录。
 *
 * **`applySetups` 先于物化**：软链那一条要写在真源工作树里（那时还没有 `@work`）。
 */
function fixture(): Made {
  const root = mkdtempSync(join(tmpdir(), 'fugue-y3-'))
  const outside = mkdtempSync(join(tmpdir(), 'fugue-y3-out-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, DECLARED[0]), { recursive: true })
  writeFileSync(join(root, PROBE_FILES.a), C_SRC)
  writeFileSync(join(root, PROBE_FILES.b), TS_SRC)
  writeFileSync(join(root, 'build.mjs'), BUILD)
  writeFileSync(join(root, 't.test.mjs'), TESTFILE)
  const home = process.env.HOME ?? '/root'
  const roots0 = createRoots(root)
  applySetups(ESCAPE_CASES, { work: root, real: root, cache: root, outside, home })

  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  const base = git(root, 'rev-parse', 'HEAD')
  for (const [k, v] of [
    ['actions.build', '{"argv":["node","build.mjs"],"cache":["dist"]}'],
    ['actions.test', '{"argv":["node","--test"]}'],
  ]) {
    const r = fugue(root, 'config', 'set', k, v)
    assert.equal(r.code, 0, `config set ${k}：${r.err}`)
  }
  for (const a of [AGENT, OTHER_AGENT]) {
    for (const cmd of [['branch', base], ['fork', base], ['ensure']]) {
      const r = fugue(root, '--agent', a, ...cmd)
      assert.equal(r.code, 0, `${a} ${cmd[0]}：${r.err}`)
    }
  }

  const roots: Roots = roots0
  const cache = cacheLayoutOf(roots, AGENT)
  mkdirSync(cache.home, { recursive: true })
  mkdirSync(cache.xdgCache, { recursive: true })
  // 声明目录两侧都要先是一个存在的目录：树里那一侧由 `ensure` 落，缓存那一侧是绑定源
  // （§ 8.6 第 1 步）。少一个，bwrap 当场报 `Can't find source path`。
  for (const rel of DECLARED) mkdirSync(cache.bound(rel), { recursive: true })
  // 跑器照一份真策略包（Y2 起）：缺省档——bwrap 在场 · 网切掉 · 清单是缺省那份 · 坐标是沙箱里那三条。
  const policy = resolvePolicy({ roots, agent: AGENT, doc: {} })
  const env = envFor({
    agent: AGENT,
    binding: { name: 'y3', argv: ['true'], cwd: '', outputs: [], cache: [...DECLARED], env: {}, net: 'none' },
    injections: {},
    portIndex: 0,
    range: DEFAULT_PORTS,
    policy,
  })
  const host = { work: roots.mergedRoot(AGENT), real: root, cache: cache.home, outside, home }
  const made: Made = {
    root,
    outside,
    fx: {
      roots,
      agent: AGENT,
      // 子进程那一侧：沙箱档的树是挂载点（`policy.coords.tree`）。
      coords: { ...host, work: policy.coords.tree },
      host,
      declared: DECLARED,
      env,
      policy,
    },
  }
  MADE.push(made)
  return made
}

after(() => {
  for (const m of MADE) {
    for (const a of [AGENT, OTHER_AGENT]) fugue(m.root, '--agent', a, 'dispose')
    for (const dir of [m.root, m.outside]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        spawnSync('sudo', ['-n', 'rm', '-rf', dir], { encoding: 'utf8' })
      }
    }
  }
})

/** `upper` 里落下的**文件**（目录不算：声明目录的挂载点是预建的，它本来就该在）。 */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p.slice(dir.length + 1))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

const lastLine = (text: string): string => {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines.length === 0 ? '' : lines[lines.length - 1].trim()
}

/** 照这一份策略值起一次，把原始读数交回去（③ 的两次抽条与两条正对照都走它）。 */
function runConfined(m: Made, reach: ReachSpec, argv: readonly string[]) {
  const packed = confine({
    roots: m.fx.roots,
    agent: AGENT,
    argv,
    cwd: '',
    declared: m.fx.declared,
    env: m.fx.env,
    policy: { ...m.fx.policy, reach },
  })
  return spawnSync(packed.argv[0], packed.argv.slice(1), {
    cwd: m.fx.roots.mergedRoot(AGENT),
    env: m.fx.env,
    encoding: 'utf8',
    maxBuffer: 1 << 24,
    timeout: 60_000,
  })
}

test('Y3 ① · 六条泄漏用例全部翻成"拒"，且 `ls /` 只剩清单那几条', () => {
  const m = fixture()
  assert.deepEqual([...m.fx.policy.layers], ['bwrap'], '这一趟 bwrap 在场——不在场的话下面读的不是沙箱档')
  const rows = runEscapeTable(ESCAPE_CASES, m.fx)
  console.log('\n── Y3 ① · 全档（清单落地之后）：十九条 ──')
  for (const r of rows) console.log(`  ${formatReading(r)}`)

  // 整张表：该通的通着、该拒的拒着（"没问成"不算拒，它自己一栏）。
  const wrong = rows.filter((r) => r.verdict !== r.want)
  assert.deepEqual(
    wrong.map((r) => `${r.name}：期望 ${r.want}，读到 ${r.verdict ?? '（没问成）'}｜${r.message}`),
    [],
    '十九条里该通的通、该拒的拒',
  )

  // 逐条点名 Y1 那一组（组名是判据的一部分）：那六条从"通"翻成"拒"。
  const leak = rows.filter((r) => r.group === GROUPS.leak)
  assert.equal(leak.length, 6, '六条')
  assert.deepEqual(
    leak.filter((r) => r.verdict !== 'deny').map((r) => `${r.name}：${r.verdict ?? '（没问成）'}`),
    [],
    '物理侧那六条全"拒"',
  )

  // `ls /`：整机换成了数得出来的十二个名字（清单那几条 + 树与两处可写落点）。
  const ls = runConfined(m, m.fx.policy.reach, ['ls', '/'])
  assert.equal(ls.status, 0, ls.stderr)
  assert.deepEqual(
    ls.stdout.split('\n').filter((l) => l !== '').sort(),
    ['bin', 'cache', 'dev', 'etc', 'lib', 'lib64', 'opt', 'proc', 'sbin', 'tmp', 'usr', 'work'],
    '`ls /` 只剩清单那几条',
  )

  // 掩码那两块的读数：树里那一支在子进程眼里**空且只读**（`--tmpfs` + `--remount-ro`）。
  const mask = m.fx.policy.reach.mask.map((x) => join(m.fx.policy.coords.tree, x))
  const probe = runConfined(m, m.fx.policy.reach, ['sh', '-c', `ls -a ${mask[0]}; echo x > ${mask[0]}/x`])
  assert.equal(lastLine(probe.stderr), `sh: 1: cannot create ${mask[0]}/x: Read-only file system`)
  assert.equal(probe.stdout.trim(), '.\n..', `${mask[0]} 在子进程眼里是空的`)
})

test('Y3 ② · 正对照：真构建 + 真测试在沙箱里照跑得出，产物落声明目录、`upper` 里 0 个文件', () => {
  const m = fixture()
  assert.deepEqual([...m.fx.policy.layers], ['bwrap'], '这一趟 bwrap 在场——不在场的话下面读的不是沙箱档')
  const cache = cacheLayoutOf(m.fx.roots, AGENT)
  const upper = join(m.root, '.fugue', 'mat', AGENT, 'upper')

  const build = fugue(m.root, '--agent', AGENT, '--json', 'run', 'build')
  assert.equal(build.code, 0, build.err)
  const j = JSON.parse(build.out) as Record<string, unknown>
  assert.equal(j.exit, 0, build.err)
  assert.equal(j.mode, 'read-only')
  assert.equal(j.enforcement, 'full')
  assert.equal(j.tree, '/work', '子进程看到树在 `/work`（沙箱里的坐标）')
  assert.equal(j.home, '/cache', '子进程的家在 `/cache`')
  assert.match(build.err, /build ok/, '真构建跑出了它自己那一行')

  // 产物落在声明目录（`cache` 那一侧），而且是个真能跑的程序。
  const app = join(cache.bound(DECLARED[0]), 'app')
  assert.equal(existsSync(app), true, `产物在声明目录里：${app}`)
  assert.equal(spawnSync(app, [], { encoding: 'utf8' }).stdout, 'hi\n', '那个产物真跑得起来')
  // **没有回写视图**：这个动作只声明了 cache——树那一侧没有它，`upper` 里 0 个文件。
  assert.equal(existsSync(join(m.fx.roots.mergedRoot(AGENT), DECLARED[0], 'app')), false)
  assert.deepEqual(filesUnder(upper), [], '声明目录绑在缓存上：`upper` 里一个文件都没有')

  // 真测试：`node --test` 在沙箱里跑得出（要 TMPDIR 与一个读得动的 cwd）。
  const t = fugue(m.root, '--agent', AGENT, '--json', 'run', 'test')
  assert.equal(t.code, 0, t.err)
  assert.equal((JSON.parse(t.out) as Record<string, unknown>).exit, 0, t.err)
  assert.match(t.err, /pass 1/, '一条真测试跑过了')
  assert.match(t.err, /fail 0/)
  assert.deepEqual(filesUnder(upper), [], '测试那一趟也没往 `upper` 里落文件')
})

test('Y3 ③ · 负对照：从清单里抽掉 `/lib64` 与 `/etc/alternatives` 各一次，当场起不来', () => {
  const m = fixture()
  assert.deepEqual([...m.fx.policy.layers], ['bwrap'], '这一趟 bwrap 在场')
  const base = m.fx.policy.reach

  // **正对照先来**：清单不抽，那两条都起得来——否则下面那两条红的可能只是"这台机器上 bwrap
  // 起不来"，而不是"清单少了一条"。
  const okEcho = runConfined(m, base, ['/usr/bin/echo', 'hi'])
  assert.equal(okEcho.status, 0, okEcho.stderr)
  assert.equal(okEcho.stdout.trim(), 'hi')
  const okCc = runConfined(m, base, ['cc', '--version'])
  assert.equal(okCc.status, 0, lastLine(okCc.stderr))
  assert.notEqual(okCc.stdout.trim(), '', '`cc` 起得来')

  // ① 抽掉 `/lib64` 那条软链：动态链接器不在，连 `/usr/bin/echo` 都起不来。
  const noLib64 = runConfined(m, { ...base, symlinks: base.symlinks.filter((s) => s.at !== '/lib64') }, [
    '/usr/bin/echo',
    'hi',
  ])
  assert.notEqual(noLib64.status, 0, '清单少一条：当场起不来')
  assert.equal(lastLine(noLib64.stderr), 'bwrap: execvp /usr/bin/echo: No such file or directory')

  // ② 抽掉 `/etc/alternatives`：`cc` 那条链子断在半路（`/usr/bin/cc` 指向它）。
  const noAlt = runConfined(m, { ...base, roRoots: base.roRoots.filter((p) => p !== '/etc/alternatives') }, [
    'cc',
    '--version',
  ])
  assert.notEqual(noAlt.status, 0, '清单少一条：当场起不来')
  assert.equal(lastLine(noAlt.stderr), 'bwrap: execvp cc: No such file or directory')
})
