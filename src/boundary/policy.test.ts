// tier: real —— bwrap（层探测与降档对真沙箱）
// Y2 的断言（PLAN § 5.5 的 Y2 行 · 架构 § 8.8 · § 15.7 的对接点）。
//
//   ① **两处读同一份**：`fugue policy --json` 报的那五栏（`mode` · `enforcement` · `layers` ·
//      `net` · `reach`）与某一趟 `fugue run` 写下的 `run/confined` 事件逐字相等
//   ② **从同一处来**：改工作区配置里那一栏（`boundary.reach`）· 把动作的 `net` 点成 `"host"`，
//      两处一起变——不是各读各的、碰巧一样
//   ③ **负对照**：把 `bwrap` 从 PATH 上拿掉（§ 15.7 的 E4 真的不成立），两处一起降——
//      **第二层接过来**（Y6）：`layers: ['landlock']` · `mode: 'read-only'`（它管着"写得动什么"
//      那一维，所以树不可写）· `enforcement: partial` · `net: host`（没有哪一层能把网拿走）
//
// **"逐字相等"只有一种做法**：两处都读同一个 `resolvePolicy()` 的返回值。所以这个测试同时也是
// 那条机制的负对照——把事件那一侧换成自己算的一份，① 当场红。
//
// **"网真的切掉了没有"不在这一份里**：那是 Y5 的读数（DNS · 直连 IP · 回环）。这一份只判
// "报出来的那一栏是同一份值，而且供给跟不上时会如实降"。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

const BUILD = `import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
execFileSync('cc', ['-o', 'dist/app', 'src/a.c'])
console.log('build ok')
`
const C_SRC = '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n'
/** 一条真跑得起来的动作：`net` 那一栏由 ② 单加上去（缺省一个动作是不要网的）。 */
const ACTION = { argv: ['node', 'build.mjs'], cache: ['dist'], outputs: ['dist/app'] }

const MADE: string[] = []
const BINS: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'fugue-y2-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.c'), C_SRC)
  writeFileSync(join(root, 'build.mjs'), BUILD)
  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  const base = git(root, 'rev-parse', 'HEAD')
  MADE.push(root)
  assert.equal(fugue(root, 'config', 'set', 'actions.build', JSON.stringify(ACTION)).code, 0)
  assert.equal(fugue(root, 'branch', base).code, 0)
  assert.equal(fugue(root, 'fork', base).code, 0)
  return root
}

after(() => {
  for (const root of MADE) {
    fugue(root, 'dispose')
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', root], { encoding: 'utf8' })
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

/** 某一类事件，按发生次序。 */
function events(root: string, t: string): (Record<string, unknown> & { t: string })[] {
  return rowsOf(root)
    .filter((r) => r.e.t === t)
    .map((r) => r.e)
}

function policyOf(root: string, ...args: string[]): Record<string, unknown> {
  const r = fugue(root, '--json', 'policy', ...args)
  assert.equal(r.code, 0, r.err)
  return JSON.parse(r.out.trim()) as Record<string, unknown>
}

/** 那五栏，两处各读一遍。`reach` 在策略值里是整份形状，在事件里是只读根那一栏。 */
function fiveOfPolicy(p: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: p.mode,
    enforcement: p.enforcement,
    layers: p.layers,
    net: p.net,
    reach: (p.reach as { roRoots: string[] }).roRoots,
  }
}

function fiveOfEvent(e: Record<string, unknown>): Record<string, unknown> {
  return { mode: e.mode, enforcement: e.enforcement, layers: e.layers, net: e.net, reach: e.reach }
}

const roRoots = (p: Record<string, unknown>): string[] => (p.reach as { roRoots: string[] }).roRoots

/** 一面"除了 bwrap 什么都有"的 PATH：把两个 bin 目录整个镜像过来，去掉那一个（Y2 ③ · P1c 共用）。 */
function noBwrapPath(): { readonly PATH: string } {
  const bin = mkdtempSync(join(tmpdir(), 'fugue-y2-bin-'))
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
  return { PATH: bin }
}

test('Y2 ① · 两处读同一份：fugue policy 与 run/confined 的五栏逐字相等', () => {
  const root = workspace()
  const run = fugue(root, '--json', 'run', 'build')
  assert.equal(run.code, 0, run.err)

  const p = policyOf(root)
  const evs = events(root, 'run/confined')
  assert.equal(evs.length, 1, '一趟 run 写一条 run/confined')
  assert.deepEqual(fiveOfPolicy(p), fiveOfEvent(evs[0] as Record<string, unknown>), '两处读同一份')

  // **空对空也算"相等"**：那五栏各要有实测值，否则 ① 会被一份空策略值蒙混过去。
  assert.equal(p.mode, 'read-only', '缺省档')
  assert.equal(p.enforcement, 'full', '两层都在场才是 full（§ 15.7 的 E5：少一层纵深，如实降）')
  assert.deepEqual(p.layers, ['bwrap', 'landlock'], '这一趟在场的层：挂载层 + 第二层')
  assert.equal(p.net, 'none', '没有动作点名要网')
  assert.equal(roRoots(p).length, 6, '缺省清单 = /usr · /opt · /etc 的三条 · /etc/resolv.conf（点名要网那一档要的）')

  // 换一档也一样是同一份：`--mode workspace-write` 时两处一起变成那一档的三栏。
  const deg = fugue(root, '--json', 'run', 'build', '--mode', 'workspace-write')
  assert.equal(deg.code, 0, deg.err)
  const p2 = policyOf(root, '--mode', 'workspace-write')
  const evs2 = events(root, 'run/confined')
  assert.equal(evs2.length, 2)
  assert.deepEqual(fiveOfPolicy(p2), fiveOfEvent(evs2[1] as Record<string, unknown>), '那一档也是同一份')
  // **这一档也要挂载围栏**（见 `policy.ts` 那一段由头）：档管的是树可不可写，围栏管的是
  // 子进程看得见什么——两件事正交，缺了后者就是"bash 在宿主上裸跑"（第十五趟样本盘量到的）。
  assert.deepEqual(p2.layers, ['bwrap', 'landlock'], '这一档两层都在场（挂载层把树挂成可写，树以外照旧不在）')
  assert.equal(p2.enforcement, 'full')
})

test('Y2 ② · 从同一处来：配置里那一栏一改，两处一起变', () => {
  const root = workspace()
  const before = policyOf(root)
  const narrow = ['/usr', '/opt', '/etc/ld.so.cache', '/etc/alternatives']
  assert.equal(fugue(root, 'config', 'set', 'boundary.reach', JSON.stringify(narrow)).code, 0)

  const after = policyOf(root)
  assert.notDeepEqual(roRoots(before), narrow, '改之前不是这份清单')
  assert.deepEqual(roRoots(after), narrow, 'fugue policy 读的是新那一栏')
  assert.equal(fugue(root, '--json', 'run', 'build').code, 0)
  assert.deepEqual(events(root, 'run/confined').pop()?.reach, narrow, '那一趟的事件读的是同一栏')

  // 动作那一栏：点名要网 → `fugue policy <动作>` 与那一趟的事件一起变。
  assert.equal(fugue(root, 'config', 'set', 'actions.build', JSON.stringify({ ...ACTION, net: 'host' })).code, 0)
  assert.equal(policyOf(root, 'build').net, 'host', '给了动作就读它那一栏')
  assert.equal(policyOf(root).net, 'none', '不给动作就是缺省那一份——没有动作就没有要求')
  assert.equal(fugue(root, '--json', 'run', 'build').code, 0)
  assert.equal(events(root, 'run/confined').pop()?.net, 'host', '那一趟的事件跟着变')
})

test('Y2 ③ · 负对照：bwrap 不在 PATH 上，两处一起降（降一档，不是降到底：第二层接过来）', () => {
  const root = workspace()
  const noBwrap = noBwrapPath()
  const probe = spawnSync('bwrap', ['--version'], { env: { ...process.env, ...noBwrap }, encoding: 'utf8' })
  assert.equal((probe.error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT', '这条路上真没有 bwrap')

  const r = fugueEnv(noBwrap, root, '--json', 'policy')
  assert.equal(r.code, 0, r.err)
  const p = JSON.parse(r.out.trim()) as Record<string, unknown>
  assert.deepEqual(p.layers, ['landlock'], '挂载层没了，第二层还在（Y6 的同一件事）')
  assert.equal(p.enforcement, 'partial', '如实降，不夸大：少一层就少一维')
  assert.equal(p.mode, 'read-only', '第二层管着"写得动什么"那一维 → 树不可写')
  assert.equal(p.net, 'host', '没有哪一层能把网拿走，就不许报 none')

  const run = fugueEnv(noBwrap, root, '--json', 'run', 'build')
  assert.equal(run.code, 0, run.err)
  assert.equal(JSON.parse(run.out.trim()).mode as string, 'read-only', '那一趟也报同一档')
  const e = events(root, 'run/confined').pop() as Record<string, unknown>
  assert.deepEqual(fiveOfPolicy(p), fiveOfEvent(e), '两处一起降，不是只有一处')
})

test('P1c · 声明 full 而实测层不齐：起跑前拒并指两条出路；声明 partial 照跑照实报', () => {
  const root = workspace()
  const noBwrap = noBwrapPath()

  // 声明期望档 full，实测只有第二层（bwrap 不在）——fugue policy 与 fugue run 都在起跑前拒，
  // 文案指两条出路（把层补齐 · 把声明改 partial）。**错误那一行走 stderr**（§ 9.8：stdout 纪律）。
  assert.equal(fugue(root, 'config', 'set', 'boundary.enforcement', '"full"').code, 0)
  const denied = fugueEnv(noBwrap, root, '--json', 'policy')
  assert.equal(denied.code, 1, '起跑前拒（fail=1）——不是静默降档照跑')
  assert.ok(denied.err.includes('把层补齐'), `指路要给"补层"那条出路：${denied.err}`)
  assert.ok(denied.err.includes('partial'), `指路要给"改声明"那条出路：${denied.err}`)
  const refused = fugueEnv(noBwrap, root, '--json', 'run', 'build')
  assert.equal(refused.code, 1, 'fugue run 同一处拒（resolvePolicy 一处解析两处读）')

  // 负对照：声明 partial（= 把"我知道在降档"写下来）→ 照跑，如实报实测那一档（今天的行为）。
  assert.equal(fugue(root, 'config', 'set', 'boundary.enforcement', '"partial"').code, 0)
  const ok = fugueEnv(noBwrap, root, '--json', 'policy')
  assert.equal(ok.code, 0, ok.err)
  const p = JSON.parse(ok.out.trim()) as Record<string, unknown>
  assert.equal(p.enforcement, 'partial', '如实报，不夸大')

  // degraded 那一档跑一趟真动作：run/start 记的 argv 该是实际 spawn 的那条——原先这里恒记裸
  // binding.argv（execute.ts 读了个不存在的 `policy.degraded` 栏）。P1b 起包装链多一层
  // （seccomp 在最外、landlock 居中、命令收尾），这里把整条链钉住。
  const run = fugueEnv(noBwrap, root, '--json', 'run', 'build')
  assert.equal(run.code, 0, run.err)
  const start = events(root, 'run/start').pop() as Record<string, unknown>
  const argv = start.argv as readonly string[]
  const argv0 = String(argv[0])
  assert.notEqual(argv0, 'node', `degraded 档的 argv[0] 不该还是裸的动作名：${argv0}`)
  assert.ok(
    argv0.includes('seccomp-exec') && String(argv[1] ?? '').includes('landlock-exec'),
    `degraded 档的包装链该是 seccomp 在最外、landlock 居中：${JSON.stringify(argv)}`,
  )

  // 坏值在读的时候拒（载入核对，set 本身不校验值域）。stderr 上是一行 JSON（引号带转义），
  // 断言用不带引号的子串：原值回显 + 取值域里那两个字。
  assert.equal(fugue(root, 'config', 'set', 'boundary.enforcement', '"FULL"').code, 0)
  const bad = fugue(root, '--json', 'policy')
  assert.equal(bad.code, 1, '坏值起跑前拒')
  assert.ok(
    bad.err.includes('FULL') && bad.err.includes('partial'),
    `坏值的拒绝要回显原值并说出取值域：${bad.err}`,
  )
})
