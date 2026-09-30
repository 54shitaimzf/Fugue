// tier: real —— bwrap（真沙箱的圈禁面）
// Y1 的断言（PLAN § 5.5 的 Y1 行 · 架构 § 20 的 S5 交付物 · § 8.8 的验证性质前半）。
//
//   ① **仪器可证伪**：一条该通的（树内读）与一条该拒的（树内新建）各跑一次，读数分别是
//      "通""拒"；**负对照**——同一张表 · 同一个跑器，只把沙箱那一层拆掉（X4 的退化档），
//      那条该拒的变"通"。一台只会说"拒"（或只会说"通"）的仪器在这两条上当场露馅。
//   ② 表里每条都给读数与文案，**不吞异常**：没起得来不算读数（`verdict: null`）；读法是
//      落点的那几条，读成"拒"时子进程必须留了一句文案（否则"没写成"与"根本没跑"分不开）。
//      每条该拒的用例都带一句指路——**Y1 只立这一栏**，"那句指路对不对"由 Y3 落。
//   ③ 丁 那一组（宿主那一侧那六条）今天的样子——**这是读数不是断言**（PLAN § 5.5 的 ③）：
//      Y1 立表时它们全"通"，Y3 之后全"拒"。这里只打印，不拿它判红绿——它进 Y3 的断言 ①，
//      而美化一个读数，Y3 就少一条能证伪它的证据。
//
// 两个 fixture：一个跑全档、一个跑退化档。**不许共用一个**——退化档那一趟真往树里写
// （新建 · 追加 · 删除），那些痕迹会变成下一趟的读数（"删除源文件"会因为已经被删过而报"通"）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { DEFAULT_PORTS, DEFAULT_ENV_SPEC, envFor, readEnvSpec, type EnvSpec } from './binding.ts'
import { cacheLayoutOf } from '../roots/coords.ts'
import { createRoots } from '../roots/roots.ts'
import type { Roots } from '../roots/contract.ts'
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
  type EscapeReading,
} from './escape.ts'
import { resolvePolicy } from './policy.ts'
import type { Policy } from './policy.ts'
import { DEFAULT_REACH } from './reach.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const C_SRC = '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n'
const TS_SRC = 'export const b = 2\n'

/**
 * P1a 那一条读数要「宿主真的有这个键」：整份照抄的那一档（今天）才会把它带进沙箱，翻面才是
 * 边界拦的。**测试进程自己的环境**就是 `envFor` 读的那一份——放一个假值，跑完删掉；宿主
 * 本来就有它的话用宿主那份（更真），`after` 里按记下的原样恢复。
 */
const HAD_DEEPSEEK = process.env.DEEPSEEK_API_KEY
if (HAD_DEEPSEEK === undefined) process.env.DEEPSEEK_API_KEY = 'y1-逃逸集的探测假值'

function fugue(root: string, ...args: string[]): { code: number; err: string } {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  return { code: r.status ?? -1, err: r.stderr }
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
 * 一个 fixture：一棵有提交的树 · 两个 agent 的物化 · 本 agent 的缓存与声明目录 · 表里那几条路
 * 的形状。**先摆形状再物化**：软链那一条要在树里、要在 `fork` 之前（`setup` 一律写 `@real`）。
 *
 * `sandbox` 说的是**这一份 fixture 打算跑哪一档**：沙箱档的策略值是缺省那份（树只读 · 坐标是
 * 沙箱里的三条），退化档那一份点名要树可写那一档——那一档里没有挂载，坐标照实写宿主那三条。
 * 两份策略各自的坐标都从这里进 `fx`（argv 那一侧），宿主那一侧另有一份 `host`。
 */
function fixture(sandbox = true, mode?: 'read-only' | 'workspace-write', doc: Record<string, unknown> = {}): Made {
  const root = mkdtempSync(join(tmpdir(), 'fugue-y1-'))
  const outside = mkdtempSync(join(tmpdir(), 'fugue-y1-out-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, DECLARED[0]), { recursive: true })
  writeFileSync(join(root, PROBE_FILES.a), C_SRC)
  writeFileSync(join(root, PROBE_FILES.b), TS_SRC)
  const home = process.env.HOME ?? '/root'
  const roots0 = createRoots(root)
  // 摆形状只认得 `@real`（这时还没有 `@work`）：五个记号里其余四个都指到树自己身上。
  const shape = { work: root, real: root, cache: root, outside, home }
  applySetups(ESCAPE_CASES, shape)

  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  const base = git(root, 'rev-parse', 'HEAD')
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
  // 声明目录两侧都要先是一个存在的目录：树里那一侧由 `ensure` 落（底里有它），缓存那一侧
  // 是绑定源（§ 8.6 第 1 步）。少一个，bwrap 当场报 `Can't find source path`。
  for (const rel of DECLARED) mkdirSync(cache.bound(rel), { recursive: true })
  // 跑器照一份真策略包（Y2 起）：沙箱档是缺省那份（bwrap 在场 · 网切掉 · 清单是缺省那份），
  // 退化档点名要树可写那一档（那一档里一层都没有）。
  const policy = resolvePolicy(
    // **退化档要说清两层都不在**：`mode` 那一栏只说树可不可写，而"看得见什么"那一维由
    // 挂载层定（`policy.ts`）。只给 `mode` 的话，探针照旧报 bwrap 在场、坐标是沙箱里那三条，
    // 而跑器走的是 `degradedArgv`——argv 里的 `/work/...` 在宿主上不存在，整张表全变"拒"。
    sandbox
      ? { roots, agent: AGENT, doc, ...(mode === undefined ? {} : { mode }) }
      : { roots, agent: AGENT, doc, mode: 'workspace-write', probed: { layers: [], note: '退化档：两层都不在（E4）' } },
  )
  const env = envFor({
    agent: AGENT,
    binding: { name: 'y1', argv: ['true'], cwd: '', outputs: [], cache: [...DECLARED], env: {}, net: 'none' },
    injections: {},
    portIndex: 0,
    range: DEFAULT_PORTS,
    policy,
  })
  // 宿主那一侧的坐标：`work` 是物化树在盘上的路径（读数按它翻）。
  const host = { work: roots.mergedRoot(AGENT), real: root, cache: cache.home, outside, home }
  const made: Made = {
    root,
    outside,
    fx: {
      roots,
      agent: AGENT,
      // 子进程那一侧：沙箱档的树是挂载点 `/work`，退化档没有挂载、就是宿主那条路径。
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
  if (HAD_DEEPSEEK === undefined) delete process.env.DEEPSEEK_API_KEY
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

function show(title: string, rows: readonly EscapeReading[]): void {
  console.log(`\n── ${title} ──`)
  for (const r of rows) console.log(`  ${formatReading(r)}`)
  const want = (w: string): number => rows.filter((r) => r.want === w).length
  const got = (v: string): number => rows.filter((r) => r.verdict === v).length
  console.log(
    `  合计 ${rows.length} 条：期望通 ${want('pass')} · 期望拒 ${want('deny')} · ` +
      `实得通 ${got('pass')} · 实得拒 ${got('deny')} · 没问成 ${rows.filter((r) => r.verdict === null).length}`,
  )
}

const pick = (rows: readonly EscapeReading[], name: string): EscapeReading => {
  const r = rows.find((x) => x.name === name)
  assert.ok(r !== undefined, `表里没有这一条：${name}`)
  return r
}

test('Y1 ① · 仪器可证伪：一条该通的读出通、一条该拒的读出拒；拆掉沙箱那一层，那条该拒的变通', () => {
  const full = fixture()
  const deg = fixture(false)
  const a = runEscapeTable(ESCAPE_CASES, full.fx)
  const b = runEscapeTable(ESCAPE_CASES, deg.fx, { sandbox: false })
  show('全档（bwrap 那一层在）', a)
  show('退化档（把沙箱那一层拆掉）', b)

  assert.equal(pick(a, '树内读').verdict, 'pass', '该通的那条要读得出通（否则仪器只会说"拒"）')
  assert.equal(pick(a, '树内读（相对 cwd）').verdict, 'pass', 'cwd 落在树里，相对路径就在树里')
  assert.equal(pick(a, '声明目录写').verdict, 'pass', '声明过的落点写得进去')
  assert.equal(pick(a, '本 agent 的家').verdict, 'pass', '孩子的家是本 agent 的缓存')
  assert.equal(pick(a, '树内新建').verdict, 'deny', '该拒的那条要读得出拒（否则仪器只会说"通"）')
  assert.equal(pick(a, '原地改源文件').verdict, 'deny')
  assert.equal(pick(a, '删除源文件').verdict, 'deny')
  assert.equal(pick(a, '写工作区外').verdict, 'deny')

  // 负对照：同一张表、同一个跑器，只把沙箱那一层拆掉。四条该拒的当场翻面。
  assert.equal(pick(b, '树内新建').verdict, 'pass', '拆掉沙箱那一层：树内新建当场变通')
  assert.equal(pick(b, '原地改源文件').verdict, 'pass', '同上：原地改源文件')
  assert.equal(pick(b, '删除源文件').verdict, 'pass', '同上：删除源文件')
  assert.equal(pick(b, '写工作区外').verdict, 'pass', '同上：写工作区外')
  // 负对照只动该拒的那一半：该通的四条在退化档上照旧通（`声明目录写` 那一趟落在树自己那一侧，
  // 读法取树里的落点，所以它也通——这正是 X4 ① 的"两处落点"）。
  assert.equal(pick(b, '树内读').verdict, 'pass')
  assert.equal(pick(b, '树内读（相对 cwd）').verdict, 'pass')
  assert.equal(pick(b, '声明目录写').verdict, 'pass')
  assert.equal(pick(b, '本 agent 的家').verdict, 'pass')
})

test('Y3 ⑤ · 树可写那一档：看得见什么那一维照旧关着（树内可写 · 树外十二条全拒）', () => {
  // 由头（第十五趟样本盘 · 案一）：`--mode workspace-write` 那一档以前**一层围栏都不上**
  // （`policy.ts` 的旧口径：挂载层只在 `read-only` 档用），于是真档那一趟的 `bash` 在宿主上
  // 裸跑——那一格读到了 `/tmp/scenario-b14/...` 下这一趟的验收结果与请求实录，"它自己解出来
  // 的"这句话就不再是一条证据。**判据落在这张表上**：档管的是树可不可写（乙那一组在这一档
  // 而这一条**拧着那一趟的语义**：这一档的树是可写的，"树内该拒"那三条在这一档里会翻成"通"
  // （乙那一组的语义），而"够得着什么"那一维由挂载层管——丙六条 + 丁八条必须**一条都够不着**。
  const w = fixture(true, 'workspace-write')
  const rows = runEscapeTable(ESCAPE_CASES, w.fx)
  show('树可写那一档（bwrap 那一层在 · mode=workspace-write）', rows)

  // 一 · 树以内：该通的通，而"树内该拒"那三条在这一档里**本来就可写**（这一档的语义）。
  for (const name of ['树内读', '树内读（相对 cwd）', '声明目录写', '本 agent 的家']) {
    assert.equal(pick(rows, name).verdict, 'pass', `${name}：这一档该通的要通`)
  }
  for (const name of ['树内新建', '原地改源文件', '删除源文件']) {
    assert.equal(pick(rows, name).verdict, 'pass', `${name}：这一档树是可写的（模式=workspace-write）`)
  }
  // 二 · 树以外：**十四条一条都不许够得着**（这就是那一处泄漏的封口）。
  const outside = ['写工作区外', '绝对路径读宿主', '.. 穿越读宿主', '软链指向树外', '经 /proc 的另一条坐标', 'shell 里 cd / 再读']
  const leak = ['工作区配置', '工作区日志', '真源工作树（宿主路径）', '别家的物化树（宿主路径）', '宿主那个家', '挂进来的宿主盘', '宿主的环境变量', 'vsock 那条道']
  for (const name of [...outside, ...leak]) {
    assert.equal(pick(rows, name).verdict, 'deny', `${name}：树以外那一条在这一档上够着了——账本与答案纸就在这条路上`)
  }
  // 三 · 这一档的两层都在场（档与围栏正交那句话的读数面）。
  assert.deepEqual(w.fx.policy.layers, ['bwrap', 'landlock'], '这一档两层都在场')
  assert.equal(w.fx.policy.enforcement, 'full')
  assert.equal(w.fx.policy.mode, 'workspace-write')
})

test('Y1 ② · 表里每条都给读数与文案，不吞异常；每条该拒的都带一句指路', () => {
  const rows = fullRun()
  show('全档（bwrap 那一层在）', rows)

  // 表的形状：名字唯一 · 四组都在 · 物理侧那六条一条不少（Y3 的负对照按组点名）。
  assert.equal(new Set(ESCAPE_CASES.map((c) => c.name)).size, ESCAPE_CASES.length, '用例名不许重')
  assert.equal(ESCAPE_CASES.filter((c) => c.group === GROUPS.leak).length, 8, '物理侧够得着的那八条')
  for (const g of [GROUPS.ok, GROUPS.inside, GROUPS.outside, GROUPS.leak]) {
    assert.ok(ESCAPE_CASES.some((c) => c.group === g), `这一组是空的：${g}`)
  }

  // ① 每条都问成了：没起得来（null）不算读数。
  assert.deepEqual(
    rows.filter((r) => r.verdict === null).map((r) => `${r.name}：${r.note}`),
    [],
    '每一条都要有一个读数',
  )
  // ② 不吞异常：读法是落点的那几条，读成"拒"时子进程必须留了一句文案——否则"没写成"与
  //    "根本没跑起来"是同一幅样子（起不来那条由 `bwrap: ` 那一关单独拦）。
  const byName = new Map(ESCAPE_CASES.map((c) => [c.name, c]))
  const mute = rows.filter((r) => {
    const c = byName.get(r.name)
    return r.verdict === 'deny' && c !== undefined && c.read.how !== 'exit' && r.message === ''
  })
  assert.deepEqual(mute.map((r) => r.name), [], '读成"拒"的那几条，子进程都留了一句文案')
  // ③ 每条该拒的都带一句指路（`remedy` 是非空的一段）。这一栏是 Y3 要判的东西。
  for (const c of ESCAPE_CASES) {
    if (c.want === 'deny') assert.ok(c.remedy.length > 0, `${c.name} 缺一句指路`)
    if (c.want === 'pass') assert.ok('remedy' in c === false, `${c.name} 该通，不该带指路`)
  }
})

test('Y1 ③ · 丁 那一组今天如实报读数（Y1 立表时那六条全"通"，Y3 之后全"拒"）', () => {
  // **这一条是读数，不是断言**（PLAN § 5.5 的 ③）：翻面这件事由 Y3 自己的断言看着
  // （`src/boundary/reach.test.ts` 的 ①）——这里只把它原样印出来。
  const rows = fullRun().filter((r) => r.group === GROUPS.leak)
  console.log('\n── ③ 丁 那一组（宿主那一侧）今天的样子 ──')
  for (const r of rows) console.log(`  ${formatReading(r)}`)
  const today = rows.map((r) => `${r.name}：${r.verdict}`)
  console.log(`  今天：${today.join(' · ')}`)
  assert.equal(rows.length, 8, '八条')
})

test('P1a · env 基线：core 档下宿主的凭据键读不到；inherit:all（今天的档）当场翻回通', () => {
  // P1a 的那条会红的断言（计划 § 5.20 的 P1a 行）：envFor 从「整份照抄」换成「基线 + 注入 +
  // 剔除」，缺省基线是 core 档——宿主的凭据键从此不进沙箱。落在丁组的那条用例问的就是这件事。
  const w = fixture()
  const rows = runEscapeTable(ESCAPE_CASES, w.fx)
  assert.equal(
    pick(rows, '宿主的环境变量').verdict,
    'deny',
    'core 基线：宿主环境里的凭据键读不到（读得到就是整份照抄还在）',
  )

  // 负对照（地板那一面）：inherit:all = 今天那一档——整份照抄，同一条当场读得到。
  // 地板不是摆设：凭据之外有些工作区就是要宿主那份环境（本机工具链那一类），退化档一直在。
  const old = fixture(true, undefined, { boundary: { env: { inherit: 'all' } } })
  const rows2 = runEscapeTable(ESCAPE_CASES, old.fx)
  assert.equal(
    pick(rows2, '宿主的环境变量').verdict,
    'pass',
    'all 档与今天的行为相同：整份照抄，读得到',
  )
})

test('P1a · envFor 三档与四键组合：core 基线 · all 与整份照抄逐字节相同 · none 只剩坐标', () => {
  // 手拼策略值：这一条只问 envFor 的合并算法，不探层（层在不在场只改坐标，不改基线逻辑）。
  const base: Policy = {
    mode: 'read-only',
    writableRoots: [],
    enforcement: 'partial',
    reach: DEFAULT_REACH,
    coords: { tree: '/work', home: '/cache', tmp: '/tmp' },
    net: 'none',
    layers: [],
    env: DEFAULT_ENV_SPEC,
  }
  const input = (env: EnvSpec) => ({
    agent: AGENT,
    binding: { name: 'p1a', argv: ['true'], cwd: '', outputs: [], cache: [], env: {}, net: 'none' },
    injections: {},
    portIndex: 0,
    range: DEFAULT_PORTS,
    policy: { ...base, env },
  })

  // core（缺省档）：凭据键不在 · 定位键在 · 坐标照旧。
  const core = envFor(input(DEFAULT_ENV_SPEC))
  assert.equal(core.DEEPSEEK_API_KEY, undefined, 'core 基线：宿主的凭据键不进沙箱')
  assert.ok(core.PATH !== undefined && core.PATH !== '', 'core 基线：PATH 还在')
  assert.equal(core.HOME, '/cache', 'HOME 是本 agent 的坐标')
  assert.equal(core.PORT, '31000')
  assert.equal(core.PORTS, '31000-31003')

  // all（退化档）：与「整份照抄 + 坐标」的旧算法逐字节相同——地板不许变低。
  const all = envFor(input({ inherit: 'all', set: {}, exclude: [], includeOnly: [] }))
  const legacy: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) legacy[k] = v
  assert.deepEqual(
    all,
    {
      ...legacy,
      HOME: '/cache',
      XDG_CACHE_HOME: '/cache/xdg-cache',
      TMPDIR: '/tmp',
      PORT: '31000',
      PORTS: '31000-31003',
    },
    'all 档与整份照抄的从前逐字节相同',
  )

  // none：只剩坐标五件套——argv 得全路径的那一档，完整性在，没人日常用。
  const none = envFor(input({ inherit: 'none', set: {}, exclude: [], includeOnly: [] }))
  assert.deepEqual(
    Object.keys(none).sort(),
    ['HOME', 'PORT', 'PORTS', 'TMPDIR', 'XDG_CACHE_HOME'],
    'none 档：坐标之外一个不进',
  )

  // 四键组合：include_only 收窄基线 · exclude 剔基线 · set 与坐标不受那两键影响。
  const combo = envFor(
    input({ inherit: 'all', set: { FUGUE_PROBE: 'v' }, exclude: ['SHELL'], includeOnly: ['PATH'] }),
  )
  assert.equal(combo.FUGUE_PROBE, 'v', 'set 的键恒在（include_only 只收窄基线）')
  assert.equal(combo.SHELL, undefined, 'exclude 把基线里的键剔掉')
  assert.deepEqual(
    Object.keys(combo).sort(),
    ['FUGUE_PROBE', 'HOME', 'PATH', 'PORT', 'PORTS', 'TMPDIR', 'XDG_CACHE_HOME'],
    '组合档：基线只剩 PATH，坐标与 set 照叠',
  )

  // readEnvSpec：不在 = 缺省那份 · 坏形状拒 · set 盖坐标拒（与 readReach 同一条纪律）。
  assert.deepEqual(readEnvSpec({}), DEFAULT_ENV_SPEC, '没配就是 core')
  assert.throws(() => readEnvSpec({ boundary: { env: { inherit: 'yes' } } }), /inherit 取/)
  assert.throws(() => readEnvSpec({ boundary: { env: { set: { HOME: '/x' } } } }), /不能盖/)
})

// 全档那一趟跑一次就够：② 与 ③ 读的是同一份读数（多跑一趟只是多花时间，还多一份 fixture）。
let CACHED: { rows: EscapeReading[] } | null = null
function fullRun(): readonly EscapeReading[] {
  if (CACHED === null) CACHED = { rows: runEscapeTable(ESCAPE_CASES, fixture().fx) }
  return CACHED.rows
}
