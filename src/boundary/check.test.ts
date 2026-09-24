// Y4 的断言（PLAN § 5.5 的 Y4 行 · 架构 § 8.8 的 fail-closed 那一句 · § 20 S5 第二条验证的另一半）。
//
//   ① 三条"落不到策略里"的情形各被拒，且拒的话**指出是哪一条**：可写落点（`cache`）落在树外 ·
//      动作声明的 `outputs` 带 `..` · 清单里一条不存在的路径。三条都**在起进程之前**拒——日志里
//      一条 `run/start` 都不该有。
//   ② 正例照常启动：声明规规矩矩的那一个照跑，产物落在声明目录、产出照收进视图。
//   ③ 负对照：**把检查短路**（直接拿 `confine()` 起），那两条照跑——写出树外的那个文件真落在
//      宿主上别处，清单里那条不存在的路径报的是 bwrap 那句"源找不到"。这两处读数就是"没有这一
//      层检查"时的样子，也是 `check.ts` 头注里那两条实测。
//
// 外加两条守"地板"的读数：**层不在场时不查清单**（同一份过期清单 + `--mode workspace-write`
// 照跑——查了就是把地板调低）· **`fugue policy` 照旧照报**（它只读策略值，不做启动检查）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { createExecutor } from '../execute/exec.ts'
import { cacheLayoutOf, confine } from './confine.ts'
import { createRoots } from '../roots/roots.ts'
import { resolvePolicy } from './policy.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const AGENT = 'round'
/** 清单里那条**不存在**的路径：它进 `boundary.reach` 就是那一栏写错了。 */
const GHOST = '/opt/没有这个'

/** 往声明目录里写：规规矩矩的那一个。 */
const GOOD = `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
writeFileSync('dist/ok.txt', 'fine\\n')
console.log('good ok')
`
/** 往 `../` 写：声明写成 `cache: ["../x"]` 时，"可写落点"就落在树外了。 */
const BADCACHE = `import { writeFileSync } from 'node:fs'
writeFileSync('../x/f.txt', 'escaped\\n')
console.log('badcache ok')
`
const BADOUT = `import { writeFileSync } from 'node:fs'
writeFileSync('../out.txt', 'escaped\\n')
console.log('badout ok')
`

function fugue(root: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
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
}
const MADE: Made[] = []

/**
 * 一棵仓库 + 四个动作：`good`（规规矩矩）· `badcache`（`cache` 带 `..`）· `badout`（`outputs`
 * 带 `..`）· 加一个用来验证"正例照常启动"的 `good` 第二趟。
 *
 * **清单不在这里配**：那一栏由 ① 里那条用例自己 `config set`（它是工作区级的，不是动作级的）。
 */
function fixture(): Made {
  const root = mkdtempSync(join(tmpdir(), 'fugue-y4-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.txt'), 'hi\n')
  writeFileSync(join(root, 'good.mjs'), GOOD)
  writeFileSync(join(root, 'badcache.mjs'), BADCACHE)
  writeFileSync(join(root, 'badout.mjs'), BADOUT)
  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  const base = git(root, 'rev-parse', 'HEAD')
  for (const [k, v] of [
    ['actions.good', '{"argv":["node","good.mjs"],"cache":["dist"],"outputs":["dist/ok.txt"]}'],
    ['actions.badcache', '{"argv":["node","badcache.mjs"],"cache":["../x"]}'],
    ['actions.badout', '{"argv":["node","badout.mjs"],"outputs":["../out"]}'],
  ]) {
    const r = fugue(root, 'config', 'set', k, v)
    assert.equal(r.code, 0, `config set ${k}：${r.err}`)
  }
  for (const cmd of [['branch', base], ['fork', base], ['ensure']]) {
    const r = fugue(root, '--agent', AGENT, ...cmd)
    assert.equal(r.code, 0, `${cmd[0]}：${r.err}`)
  }
  const made: Made = { root }
  MADE.push(made)
  return made
}

after(() => {
  for (const m of MADE) {
    fugue(m.root, '--agent', AGENT, 'dispose')
    try {
      rmSync(m.root, { recursive: true, force: true })
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', m.root], { encoding: 'utf8' })
    }
  }
})

/** 日志里所有 `run/*` 事件的类型，按次序。用了它才知道"拒"是不是发生在起进程之前。 */
function runEvents(root: string): string[] {
  const r = fugue(root, '--json', 'log')
  assert.equal(r.code, 0, r.err)
  return r.out
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { e: { t: string } }).e.t)
    .filter((t) => t.startsWith('run/'))
}

test('Y4 ① · 三条"落不到策略里"各被拒、指出是哪一条，且都拒在起进程之前', () => {
  const m = fixture()

  // 一 · 可写落点落在树外：`cache: ["../x"]`。
  const a1 = fugue(m.root, '--agent', AGENT, 'run', 'badcache')
  assert.equal(a1.code, 1, a1.err)
  assert.match(a1.err, /动作声明的目录落不到视图里：\.\.\/x/, '拒的话要点出是哪一条')
  assert.match(a1.err, /cache 与 \.outputs/, '并说清它写在哪一栏')

  // 二 · `outputs` 带 `..`：同一条围栏，同一个说法。
  const a2 = fugue(m.root, '--agent', AGENT, 'run', 'badout')
  assert.equal(a2.code, 1, a2.err)
  assert.match(a2.err, /动作声明的目录落不到视图里：\.\.\/out/)

  // 三 · 清单里一条不存在的路径。
  assert.equal(fugue(m.root, 'config', 'set', 'boundary.reach', `["/usr","/opt","${GHOST}"]`).code, 0)
  const a3 = fugue(m.root, '--agent', AGENT, 'run', 'good')
  assert.equal(a3.code, 1, a3.err)
  assert.match(a3.err, new RegExp(`boundary\\.reach 里这一条在宿主上不存在：${GHOST}`))
  assert.match(a3.err, /Can't find source path/, '把没有它的时候会报的那句话一起说出来')

  // **三条都拒在起进程之前**：日志里一条 `run/start` 都没有。
  assert.deepEqual(runEvents(m.root), [], '拒绝启动就是一行日志都不落')

  // 清掉那一栏，回到正例。
  assert.equal(fugue(m.root, 'config', 'set', 'boundary.reach', '["/usr"]').code, 0)
  assert.equal(fugue(m.root, 'run', 'good').code, 1, '只留 /usr：软链指不到清单里去，也要拒')
})

test('Y4 ② · 正例照常启动：声明规矩的那一个照跑，产物落声明目录、产出照收', () => {
  const m = fixture()
  const r = fugue(m.root, '--agent', AGENT, '--json', 'run', 'good')
  assert.equal(r.code, 0, r.err)
  const j = JSON.parse(r.out) as Record<string, unknown>
  assert.equal(j.exit, 0, r.err)
  assert.equal(j.mode, 'read-only')
  assert.deepEqual(j.declared, ['dist'])
  assert.deepEqual(j.reclaimed, ['dist/ok.txt'], '声明过的产出照收进视图')
  assert.deepEqual(j.missing, [])
  const cache = cacheLayoutOf(createRoots(m.root), AGENT)
  assert.equal(existsSync(join(cache.bound('dist'), 'ok.txt')), true, '产物落在声明目录（缓存那一侧）')
  assert.deepEqual(
    runEvents(m.root).filter((t) => t === 'run/start'),
    ['run/start'],
    '这一趟真起了进程',
  )
})

test('Y4 ③ · 负对照：把检查短路，那两条照跑（一条真写出树外，一条报 bwrap 那句）', async () => {
  const m = fixture()
  const roots = createRoots(m.root)
  const agent = AGENT as Parameters<typeof cacheLayoutOf>[1]
  const cache = cacheLayoutOf(roots, agent)
  // 直驱 `confine()` 的那条路不建缓存那几处，这里补上（命令面平时替它建）。
  mkdirSync(cache.home, { recursive: true })
  for (const rel of ['../x', 'dist']) mkdirSync(cache.bound(rel), { recursive: true })

  // ① 短路之后，`cache: ["../x"]` 的那一条**照跑**：写下去的东西落在树外——
  //    宿主机上是 `<mat>/<agent>/x/f.txt`，而"树"是 `merged`。
  const binding = { name: 'badcache', argv: [], cwd: '', outputs: [], cache: ['../x'], env: {}, net: 'none' as const }
  const policy = resolvePolicy({ roots, agent, doc: {} })
  const confined = confine({
    roots,
    agent,
    argv: ['node', 'badcache.mjs'],
    cwd: '',
    declared: ['../x'],
    env: { ...process.env } as Record<string, string>,
    policy,
  })
  const res = await createExecutor({ onChunk: () => {} }).run(
    agent,
    { action: 'badcache', confined, cwd: '', env: { ...process.env } as Record<string, string> },
    new AbortController().signal,
  )
  assert.equal(res.exit, 0, res.stderr)
  assert.match(res.stdout, /badcache ok/)
  const escaped = join(roots.cacheRoot(agent), '..', 'x', 'f.txt')
  assert.equal(existsSync(escaped), true, `写出树外的那一份真在：${escaped}`)
  assert.equal(existsSync(join(roots.mergedRoot(agent), 'x', 'f.txt')), false, '它不在树里')

  // ② 短路之后，清单里那条不存在的路径报的是 bwrap 那句：说的是"源找不到"，而真正要改的是配置。
  const bad = { ...policy, reach: { ...policy.reach, roRoots: [...policy.reach.roRoots, GHOST] } }
  const packed = confine({
    roots,
    agent,
    argv: ['/usr/bin/echo', 'hi'],
    cwd: '',
    declared: [],
    env: { ...process.env } as Record<string, string>,
    policy: bad,
  })
  const r = spawnSync(packed.argv[0], packed.argv.slice(1), {
    cwd: roots.mergedRoot(agent),
    env: { ...process.env } as Record<string, string>,
    encoding: 'utf8',
  })
  assert.notEqual(r.status, 0)
  assert.equal(
    (r.stderr ?? '').split('\n').filter((l) => l.trim() !== '').pop()?.trim(),
    `bwrap: Can't find source path ${GHOST}: No such file or directory`,
  )
  assert.equal(binding.cache[0], '../x', '这条负对照用的就是那条坏声明')
})

test('Y4 ④ · 两条守地板的读数：层不在场时不查清单 · `fugue policy` 照旧照报', () => {
  const m = fixture()
  assert.equal(fugue(m.root, 'config', 'set', 'boundary.reach', `["/usr","/opt","${GHOST}"]`).code, 0)

  // 树可写那一档：清单不参与任何事，所以同一份过期清单**拦不住这一趟**（查了就是把地板调低）。
  const deg = fugue(m.root, '--agent', AGENT, '--json', 'run', 'good', '--mode', 'workspace-write')
  assert.equal(deg.code, 0, deg.err)
  const j = JSON.parse(deg.out) as Record<string, unknown>
  assert.equal(j.mode, 'workspace-write')
  assert.equal(j.enforcement, 'partial')
  assert.equal(j.sandbox, false, '这一档没有沙箱：清单根本没被读')

  // `fugue policy` 只读策略值：它照旧把这份清单原样报出来（如实报告，不做启动检查）。
  const p = fugue(m.root, '--agent', AGENT, 'policy', 'good')
  assert.equal(p.code, 0, p.err)
  assert.match(p.out, new RegExp(`只读根 /usr · /opt · ${GHOST}`))
})
