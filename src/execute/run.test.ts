// X1 的断言：**一个动作在自己的物化环境里跑起来**。四条，逐条对 PLAN § 5.4 的 X1 行。
//
//   ① 一次真构建在沙箱里 rc=0，产物**只**落在声明目录——`upper` 0 个文件、物化树里看不见、
//      真源一个字节没动
//   ② 树内四项全拒，子进程拿到 errno 30
//   ③ 子进程的 `HOME` / `TMPDIR` / `XDG_CACHE_HOME` / 端口落在本 agent 的坐标上，
//      四个 agent 的这四项读数两两不同
//   ④ 负对照两条：去掉 `--dev /dev` → 写 `/dev/null` 当场失败；去掉按 agent 的 temp 的绑定
//      → 构建当场失败（`Cannot create temporary file`）
//
// **夹具是一棵真 git 仓库**：`fork` 的底就是工作树与 HEAD（§ 8.4），所以 base 是 git 的提交，
// 分支头由 `fugue branch` 定上去。四条路线共用一份 `probe.mjs`：它把七项"能不能写"的 errno
// 与六项坐标一起打出来——**读数从子进程里来，不是我们替它说的**。
//
// ④ 那两条走的是**产品自己的那两段**：`confine()` 包出来的命令行原样拿来，只从里面摘掉一样，
// 再交给 `createExecutor()` 跑。这样红的才是"少了那一样就不行"，不是"另一个手写的骨架不行"。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { cacheLayoutOf, confine } from '../boundary/confine.ts'
import { createExecutor } from './exec.ts'
import { envFor } from '../boundary/binding.ts'
import type { ActionBinding } from '../boundary/binding.ts'
import { resolvePolicy } from '../boundary/policy.ts'
import { createRoots } from '../roots/roots.ts'
import type { AgentId, RelPath } from '../terms.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

function fugue(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
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

/** 探针：七项"能不能写"的 errno，加六项坐标。**在子进程里跑，读数是它给的。** */
const PROBE = `import { appendFileSync, writeFileSync, unlinkSync } from 'node:fs'
const t = (f) => { try { f(); return 'ok' } catch (e) { return e.errno } }
console.log(JSON.stringify({
  mod: t(() => appendFileSync('src/a.c', 'x')),
  mk: t(() => writeFileSync('new.txt', 'x')),
  del: t(() => unlinkSync('src/a.c')),
  etc: t(() => writeFileSync('/etc/fugue-x1-probe', 'x')),
  devnull: t(() => writeFileSync('/dev/null', 'x')),
  home: t(() => writeFileSync(process.env.HOME + '/home.txt', 'x')),
  tmp: t(() => writeFileSync(process.env.TMPDIR + '/tmp.txt', 'x')),
  // **同名不同地**：坐标的名字四个 agent 一样，落点各是各的——who.txt
  // 里写下自己的号，宿主那一侧读它就知道那一趟写进了哪一份缓存。（这里不能用反引号：
  // 这一段住在模板串里，一个反引号就把探针那一段截断了。）
  who: t(() => writeFileSync(process.env.HOME + '/who.txt', process.env.PORT ?? 'x')),
  whoTmp: t(() => writeFileSync(process.env.TMPDIR + '/who.txt', process.env.PORT ?? 'x')),
}))
console.log(JSON.stringify({
  HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  PORT: process.env.PORT, PORTS: process.env.PORTS, cwd: process.cwd(),
}))
`

const C_SRC = '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n'

interface Made {
  readonly root: string
  readonly base: string
  readonly agents: string[]
}
const MADE: Made[] = []

/** 一棵真仓库 + 一个提交 + 两个动作（`build` 真编译 · `probe` 只读地量）。 */
function workspace(agents: readonly string[]): Made {
  // **不用 `tmpDir` 那个帮手**：它的收尾在文件级 `after` 里，跑在我的 dispose 之前的话，
  // 挂着 overlay 的那棵树删不掉（实测 EACCES）。这一份自己收：先逐个 dispose，再删目录。
  const root = mkdtempSync(join(tmpdir(), 'fugue-x1-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.c'), C_SRC)
  writeFileSync(join(root, 'probe.mjs'), PROBE)
  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  const base = git(root, 'rev-parse', 'HEAD')
  const made: Made = { root, base, agents: [...agents] }
  MADE.push(made)
  fugue(root, 'config', 'set', 'actions.build', '{"argv":["cc","-o","dist/app","src/a.c"],"cache":["dist"]}')
  fugue(root, 'config', 'set', 'actions.probe', '{"argv":["node","probe.mjs"]}')
  for (const a of agents) {
    const b = fugue(root, '--agent', a, 'branch', base)
    assert.equal(b.code, 0, b.err)
    const f = fugue(root, '--agent', a, 'fork', base)
    assert.equal(f.code, 0, f.err)
  }
  return made
}

after(() => {
  for (const w of MADE) {
    for (const a of w.agents) fugue(w.root, '--agent', a, 'dispose')
    try {
      rmSync(w.root, { recursive: true, force: true })
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', w.root], { encoding: 'utf8' })
    }
  }
})

/** 子进程打出来的两份 JSON（它走我们的 stderr）。 */
function readings(err: string): { writes: Record<string, number | string>; env: Record<string, string> } {
  const lines = err
    .split('\n')
    .filter((l) => l.startsWith('{"'))
    .map((l) => JSON.parse(l) as Record<string, never>)
  assert.equal(lines.length >= 2, true, `探针没有打出两行 JSON：${err}`)
  const writes = lines[lines.length - 2] as unknown as Record<string, number | string>
  const env = lines[lines.length - 1] as unknown as Record<string, string>
  return { writes, env }
}

test('X1 ① · 一次真构建：产物只落在声明目录，树与真源一个字节没动', () => {
  const w = workspace(['round'])
  const merged = join(w.root, '.fugue', 'mat', 'round', 'merged')
  const cache = join(w.root, '.fugue', 'mat', 'round', 'cache')
  const upper = join(w.root, '.fugue', 'mat', 'round', 'upper')

  const before = git(w.root, 'status', '--porcelain')
  const r = fugue(w.root, 'run', 'build')
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^0\t\d+\tfull\n$/, 'stdout 上是结果那一行')

  // 产物在缓存里，而且是一个真能跑的程序。
  assert.equal(existsSync(join(cache, 'dist', 'app')), true, '产物落在声明目录绑的那份缓存里')
  const app = spawnSync(join(cache, 'dist', 'app'), { encoding: 'utf8' })
  assert.equal(app.stdout, 'hi\n', '它是一个真编译出来的程序')

  // 物化树里看不见它，真源一个字节没动。
  assert.equal(existsSync(join(merged, 'dist', 'app')), false, '合并树里看不见产物')
  assert.equal(readdirSync(join(merged, 'dist')).length, 0, '声明目录在树里是一个空目录')
  assert.equal(existsSync(join(w.root, 'dist')), false, '真源里没有它')
  assert.equal(git(w.root, 'status', '--porcelain'), before, '真源的工作树一个字节没动')

  // `upper` 里 0 个文件：产出一个字节都没进树，也没有发生 copy-up。
  assert.equal(statSync(upper).isDirectory(), true)
  const upperFiles = spawnSync('find', [upper, '-type', 'f'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(upperFiles, '', 'upper 里 0 个文件')
  // 预建的那个挂载点留在 upper 里（§ 8.6 第 1 步）：一个空目录，进不了清单也进不了差异集。
  const upperDirs = spawnSync('find', [upper, '-mindepth', '1', '-type', 'd'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(upperDirs, join(upper, 'dist'), 'upper 里只有那个预建的挂载点')
  assert.equal(fugue(w.root, 'verify-mat').code, 0, '清单 == 差异集，预建的空目录不在里面')

  // 三件事都记进了日志。
  const types = fugue(w.root, '--json', 'log')
    .out.trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { e: { t: string; exit?: number } }).e)
  assert.deepEqual(
    types.filter((e) => e.t.startsWith('run/')).map((e) => e.t),
    ['run/start', 'run/confined', 'run/end'],
  )
  assert.equal(types[types.length - 1]?.exit, 0)
})

test('X1 ② · 树内四项全拒（errno 30），而树里其他位置一个字节没变', () => {
  const w = workspace(['round'])
  const before = git(w.root, 'status', '--porcelain')
  const r = fugue(w.root, 'run', 'probe')
  assert.equal(r.code, 0, r.err)
  const { writes } = readings(r.err)
  assert.deepEqual(
    { mod: writes.mod, mk: writes.mk, del: writes.del, etc: writes.etc },
    { mod: -30, mk: -30, del: -30, etc: -30 },
    '改 · 建 · 删 · 写 /etc 四项全拒，errno 30 (EROFS)',
  )
  // 负对照的另一半：按 agent 的那两处是可写的（拒的不是"什么都写不动"）。
  assert.equal(writes.devnull, 'ok', '--dev /dev 在位：/dev/null 写得动')
  assert.equal(writes.home, 'ok', 'HOME 在缓存里，写得动')
  assert.equal(writes.tmp, 'ok', 'TMPDIR 在 temp 里，写得动')
  assert.equal(git(w.root, 'status', '--porcelain'), before, '真源没有被那四次尝试碰到')

  // `--step` 是这一步的署名，落进两条事件；不给就是 `-`（这一站还没有轮次）。
  const stepped = fugue(w.root, 'run', 'probe', '--step', 'r1-s3')
  assert.equal(stepped.code, 0, stepped.err)
  const runEvents = fugue(w.root, '--json', 'log')
    .out.trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { e: { t: string; step?: string } }).e)
    .filter((e) => e.t.startsWith('run/'))
  assert.deepEqual(
    runEvents.filter((e) => e.t !== 'run/confined').map((e) => e.step),
    ['-', '-', 'r1-s3', 'r1-s3'],
    '两次跑的 run/start 与 run/end 各自带上这一步的署名（run/confined 没有那个字段）',
  )
})

test('X1 ③ · 四个 agent 的子进程看到同一套坐标，而那一套各自落在自己的缓存与 temp 上', () => {
  // 坐标固定成 `/work` `/cache` `/tmp` 之后，四个 agent 的子进程看到的名字**一模一样**（宿主布局
  // 不再漏进沙箱），隔离从"名字不同"落到"同一个名字在宿主上是四处"——所以下面读的是**落点**：
  // 各自那份缓存里的 `who.txt` 各是各的号。
  const agents = ['agent/r1/1', 'agent/r1/2', 'agent/r1/3', 'agent/r1/4']
  const w = workspace(agents)
  const ports: string[] = []
  for (const a of agents) {
    const r = fugue(w.root, '--agent', a, 'run', 'probe')
    assert.equal(r.code, 0, r.err)
    const { env } = readings(r.err)
    assert.equal(env.cwd, '/work', 'cwd 是树那一处（沙箱里的坐标）')
    assert.equal(env.HOME, '/cache', '家与缓存在沙箱里是那一处')
    assert.equal(env.TMPDIR, '/tmp', 'temp 在沙箱里是那一处')
    assert.equal(env.XDG_CACHE_HOME, '/cache/xdg-cache')
    ports.push(env.PORT ?? '')
    // 命令行给的那一片号与子进程看到的一致。
    const slice = env.PORTS ?? ''
    assert.equal(env.PORT, slice.split('-')[0], 'PORT 是自己那一片的第一个号')
  }
  // 端口那一片两两不同（它不靠坐标隔离，靠池子按 writer 次序切）。
  assert.equal(new Set(ports).size, 4, `四个 agent 的号两两不同：${ports.join(' · ')}`)
  // **同名不同地**：`$HOME/who.txt` 与 `$TMPDIR/who.txt` 在宿主上落在各自那一份里。
  for (let i = 0; i < agents.length; i++) {
    const home = join(w.root, '.fugue', 'mat', agents[i], 'cache')
    const tmp = join(w.root, '.fugue', 'mat', agents[i], 'tmp')
    assert.equal(readFileSync(join(home, 'who.txt'), 'utf8'), ports[i], `${agents[i]}：家是它自己那一份`)
    assert.equal(readFileSync(join(tmp, 'who.txt'), 'utf8'), ports[i], `${agents[i]}：temp 是它自己那一份`)
    // 也别家的号写进来了：这一份里只有自己那一个。
    for (const other of ports.filter((p) => p !== ports[i])) {
      assert.equal(existsSync(join(home, `who-${other}.txt`)), false)
    }
  }
})

test('X1 ③ 补 · 注入进得去，本 agent 的坐标盖不了（两个入口都拒）', () => {
  const w = workspace(['round'])
  const ok = fugue(w.root, 'run', 'probe', '--', 'FOO=bar')
  assert.equal(ok.code, 0, ok.err)
  const bad = fugue(w.root, 'run', 'probe', '--', 'HOME=/tmp')
  assert.equal(bad.code, 1, '动作的坐标盖不了')
  assert.match(bad.err, /不能盖这几样：HOME/)
  const cfg = fugue(w.root, 'config', 'set', 'actions.probe', '{"argv":["node","probe.mjs"],"env":{"PORT":"1"}}')
  assert.equal(cfg.code, 0, cfg.err)
  const fromCfg = fugue(w.root, 'run', 'probe')
  assert.equal(fromCfg.code, 1, '配置里的 env 也盖不了')
  assert.match(fromCfg.err, /不能盖这几样：PORT/)
  const missing = fugue(w.root, 'run', '没有这个')
  assert.equal(missing.code, 1)
  assert.match(missing.err, /配置里没有这个动作：没有这个（现有的：build · probe）/)
})

test('X1 ④ · 负对照：摘掉 `--dev /dev` 与摘掉按 agent 的 temp 的绑定，各当场失败', async () => {
  const w = workspace(['round'])
  // 先成功跑一趟：缓存与预建的挂载点正是 `run` 的第二步建出来的（这一条负对照只摘骨架里的
  // 一样东西，别的东西都得在位——不然红的就不是"少了那一样"）。
  const seed = fugue(w.root, 'run', 'build')
  assert.equal(seed.code, 0, seed.err)
  const roots = createRoots(w.root)
  const agent = 'round' as AgentId
  const cache = cacheLayoutOf(roots, agent)
  const binding: ActionBinding = { name: 'probe', argv: [], cwd: '', outputs: [], cache: [], env: {}, net: 'none' }
  // 这一趟的策略值（Y2 起 `confine()` 要它）：缺省档——bwrap 在场 · 网切掉 · 清单是缺省那份。
  // `envFor` 的坐标也从它来（Y3 起），所以它排在前面。
  const policy = resolvePolicy({ roots, agent, doc: {} })
  const env = envFor({ agent, binding, injections: {}, portIndex: 0, range: '31000-31099', policy })
  const run = createExecutor({ onChunk: () => {} })

  // ① 摘掉 `--dev /dev`：写 /dev/null 当场失败（子进程自己报 errno）。
  // 走 shell：内核那句话原样落进 stderr。**这一趟 `denied` 读出来是 false**——`DENY` 那一条正则
  // 收的是"内核把写入拒了"（EROFS · EACCES · EPERM），而清单落地之后（Y3）`/dev/null` 是**不在**
  // （ENOENT）：那不是拒绝，是够不着。`--dev /dev` 的承重性照旧（非零退出 + 那句文案），
  // 但 `denied` 这一栏的形状随骨架变了——读数记在这里，不把它悄悄抹平。
  const probeArgv = ['sh', '-c', 'echo x > /dev/null']
  const full = confine({ roots, agent, argv: probeArgv, cwd: '', declared: [], env, policy }).argv.slice()
  const devAt = full.indexOf('--dev')
  const noDev = [...full.slice(0, devAt), ...full.slice(devAt + 2)]
  const a1 = await run.run(agent, { action: 'probe', confined: { argv: noDev, mechanism: 'bwrap', mode: 'read-only', enforcement: 'full' }, cwd: '', env }, new AbortController().signal)
  assert.notEqual(a1.exit, 0, '--dev /dev 不在时写 /dev/null 失败')
  // 文案随骨架变，两句话都是"那一样缺了"的读数：`--ro-bind / /` 那会儿 `/dev/null` **在**、只是
  // 只读（`Permission denied`）；清单落地之后（Y3）它**不在**——所以现在是 `Directory nonexistent`。
  assert.match(a1.stderr, /Directory nonexistent|Permission denied/)
  assert.equal(a1.denied, false, 'ENOENT 不算"被内核拒"（DENY 收的是 EROFS 与 EACCES）')

  // ② 摘掉按 agent 的 temp 的绑定：编译器当场起不来（TMPDIR 指向的那条在树里，只读）。
  const tmp = roots.tempRoot(agent)
  const build = confine({
    roots,
    agent,
    argv: ['cc', '-o', 'dist/app', 'src/a.c'],
    cwd: '',
    declared: ['dist'],
    env,
    policy,
  }).argv.slice()
  const at = build.findIndex((x, i) => x === '--bind' && build[i + 1] === tmp)
  assert.notEqual(at, -1, '骨架里本来有那一条绑定')
  // `--bind` 带两段（源与目标），所以摘的是三段——摘错一段，剩下的那一段会被 bwrap 当成命令。
  const noTmp = [...build.slice(0, at), ...build.slice(at + 3)]
  const product = join(cache.bound('dist'), 'app')
  const seeded = statSync(product).mtimeMs
  const a2 = await run.run(agent, { action: 'build', confined: { argv: noTmp, mechanism: 'bwrap', mode: 'read-only', enforcement: 'full' }, cwd: '', env }, new AbortController().signal)
  assert.notEqual(a2.exit, 0, '少了那条绑定就构建不起来')
  assert.match(a2.stderr, /Cannot create temporary file|Read-only/)
  assert.equal(statSync(product).mtimeMs, seeded, '那一趟什么都没写出来：缓存里那一个还是 seed 那趟的')

  // ③ 这一档本身死掉的样子：沙箱起不来时报出来，而不是挂住。**退化档是 X4**（串行 + 树可写 +
  // 回收），所以这一档现在只是"跑不起来"——那一条读数记在这里，断言等 X4。
  const a3 = await run.run(
    agent,
    { action: 'x', confined: { argv: ['bwrap-没有这个'], mechanism: 'bwrap', mode: 'read-only', enforcement: 'full' }, cwd: '', env },
    new AbortController().signal,
  )
  assert.equal(a3.exit, 1, '沙箱起不来：非零退出')
  assert.match(a3.stderr, /ENOENT|not found/)
})
