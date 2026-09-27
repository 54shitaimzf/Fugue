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
import { DEFAULT_PORTS, envFor } from '../execute/binding.ts'
import { cacheLayoutOf } from './confine.ts'
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

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const C_SRC = '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n'
const TS_SRC = 'export const b = 2\n'

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
function fixture(sandbox = true, mode?: 'read-only' | 'workspace-write'): Made {
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
      ? { roots, agent: AGENT, doc: {}, ...(mode === undefined ? {} : { mode }) }
      : { roots, agent: AGENT, doc: {}, mode: 'workspace-write', probed: { layers: [], note: '退化档：两层都不在（E4）' } },
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
  // 翻成"通"），而"够得着什么"那一维由挂载层管——丙六条 + 丁六条必须**一条都够不着**。
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
  // 二 · 树以外：**十二条一条都不许够得着**（这就是那一处泄漏的封口）。
  const outside = ['写工作区外', '绝对路径读宿主', '.. 穿越读宿主', '软链指向树外', '经 /proc 的另一条坐标', 'shell 里 cd / 再读']
  const leak = ['工作区配置', '工作区日志', '真源工作树（宿主路径）', '别家的物化树（宿主路径）', '宿主那个家', '挂进来的宿主盘']
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
  assert.equal(ESCAPE_CASES.filter((c) => c.group === GROUPS.leak).length, 6, '物理侧够得着的那六条')
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

test('Y1 ③ · 丁 那一组今天如实报"拒"（读数：Y3 之前这六条全"通"）', () => {
  // **这一条是读数，不是断言**（PLAN § 5.5 的 ③）：翻面这件事由 Y3 自己的断言看着
  // （`src/boundary/reach.test.ts` 的 ①）——这里只把它原样印出来。
  const rows = fullRun().filter((r) => r.group === GROUPS.leak)
  console.log('\n── ③ 丁 那一组（宿主那一侧）今天的样子 ──')
  for (const r of rows) console.log(`  ${formatReading(r)}`)
  const today = rows.map((r) => `${r.name}：${r.verdict}`)
  console.log(`  今天：${today.join(' · ')}`)
  assert.equal(rows.length, 6, '六条')
})

// 全档那一趟跑一次就够：② 与 ③ 读的是同一份读数（多跑一趟只是多花时间，还多一份 fixture）。
let CACHED: { rows: EscapeReading[] } | null = null
function fullRun(): readonly EscapeReading[] {
  if (CACHED === null) CACHED = { rows: runEscapeTable(ESCAPE_CASES, fixture().fx) }
  return CACHED.rows
}
