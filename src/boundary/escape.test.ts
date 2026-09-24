// Y1 的断言（PLAN § 5.5 的 Y1 行 · 架构 § 20 的 S5 交付物 · § 8.8 的验证性质前半）。
//
//   ① **仪器可证伪**：一条该通的（树内读）与一条该拒的（树内新建）各跑一次，读数分别是
//      "通""拒"；**负对照**——同一张表 · 同一个跑器，只把沙箱那一层拆掉（X4 的退化档），
//      那条该拒的变"通"。一台只会说"拒"（或只会说"通"）的仪器在这两条上当场露馅。
//   ② 表里每条都给读数与文案，**不吞异常**：没起得来不算读数（`verdict: null`）；读法是
//      落点的那几条，读成"拒"时子进程必须留了一句文案（否则"没写成"与"根本没跑"分不开）。
//      每条该拒的用例都带一句指路——**Y1 只立这一栏**，"那句指路对不对"由 Y3 落。
//   ③ 今天物理侧那六条如实报"通"——**这是读数不是断言**（PLAN § 5.5 的 ③），它进 Y3 的
//      负对照。所以这里只打印，不拿它判红绿：美化一个读数，Y3 就少一条能证伪它的证据。
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
import { cacheLayoutOf } from '../execute/confine.ts'
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
 */
function fixture(): Made {
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
  const env = envFor({
    roots,
    agent: AGENT,
    binding: { name: 'y1', argv: ['true'], cwd: '', outputs: [], cache: [...DECLARED], env: {}, net: 'none' },
    injections: {},
    portIndex: 0,
    range: DEFAULT_PORTS,
  })
  const made: Made = {
    root,
    outside,
    fx: {
      roots,
      agent: AGENT,
      coords: { work: roots.mergedRoot(AGENT), real: root, cache: cache.home, outside, home },
      declared: DECLARED,
      env,
      // 跑器照一份真策略包（Y2 起）：缺省档——bwrap 在场 · 网切掉 · 清单是缺省那份。
      policy: resolvePolicy({ roots, agent: AGENT, doc: {} }),
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
  const deg = fixture()
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

test('Y1 ③ · 今天物理侧那六条如实报"通"（读数，进 Y3 的负对照）', () => {
  const rows = fullRun().filter((r) => r.group === GROUPS.leak)
  console.log('\n── ③ 物理侧今天够得着的六条（读数，不是断言）──')
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
