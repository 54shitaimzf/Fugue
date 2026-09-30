// 变异审计的牙（0.2.2 的审档）。它自己在审档里跑，所以这里断的是**它判得准不准**：
// 有牙的那一处必须报 killed · 没牙的那一处必须报 survived · 跑完原字节要还原 · 树脏了要拒。
//
// 夹具是一个真 git 仓（拷贝一份验收入口进去）：真改文件 · 真跑那一档 · 真还原。夹具里两个候选
// 是故意摆的——`unused()` 里的 `===` 没人测（该报 survived），`pick()` 里的 `>=` 有人测（该报
// killed）。只断"跑过了"是不够的：两个方向各要一条。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { audit, daySeed, plan, resolveSource, resolveSpecifier, specifiers } from '../tools/mutation-audit.js'
import { tmpDir } from './helpers/tmp.ts'

const REPO = join(import.meta.dirname, '..')
const TOOL = join(REPO, 'tools', 'mutation-audit.js')

const FOO =
  'export function pick(n: number): string {\n' +
  "  return n >= 10 ? 'big' : 'small'\n" +
  '}\n' +
  '\n' +
  'export function unused(n: number): string {\n' +
  "  return n === 1 ? 'x' : 'y'\n" +
  '}\n'

const FOO_TEST =
  'import { test } from "node:test"\n' +
  'import assert from "node:assert/strict"\n' +
  'import { pick } from "./foo.ts"\n' +
  '\n' +
  'test("pick", () => {\n' +
  '  assert.equal(pick(10), "big")\n' +
  '  assert.equal(pick(9), "small")\n' +
  '})\n'

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} 应当成功：${r.stderr}`)
  return r.stdout
}

/** 一个干净的真 git 仓：入口一份拷贝 + 一源一测（两个候选：一个有牙、一个没牙）。
 *  `package.json` 也在场——真仓都有一份，而 `node --check` 认不认 TS 就看它（见下面那两条）。 */
function fixture(): string {
  const dir = tmpDir('fugue-mut-')
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  cpSync(join(REPO, 'tools', 'test-entry.js'), join(dir, 'tools', 'test-entry.js'))
  writeFileSync(join(dir, 'src', 'foo.ts'), FOO)
  writeFileSync(join(dir, 'src', 'foo.test.ts'), FOO_TEST)
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.name=fugue-test', '-c', 'user.email=test@localhost', 'commit', '-qm', '夹具'])
  return dir
}

function tool(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('说明符解析：相对路径归一到仓根 · 非相对给 null · `.js` 也认一次同名 `.ts`', () => {
  assert.deepEqual(specifiers('import { a } from "../delta.ts"\nimport x from "node:fs"\n'), ['../delta.ts', 'node:fs'])
  assert.equal(resolveSpecifier('src/materialize/ensure.test.ts', '../delta.ts'), 'src/delta.ts')
  assert.equal(resolveSpecifier('test/a.test.ts', '../src/x.ts'), 'src/x.ts')
  assert.equal(resolveSpecifier('src/a.test.ts', '../tools/t.js'), 'tools/t.js', '说明符说什么就是什么')
  assert.equal(resolveSpecifier('src/a.test.ts', 'node:fs'), null)
  const sources = ['src/b.ts', 'tools/t.ts']
  assert.equal(resolveSource('src/a.test.ts', './b.ts', sources), 'src/b.ts')
  assert.equal(resolveSource('src/a.test.ts', '../tools/t.js', sources), 'tools/t.ts', '`.js` 指向仓里的 `.ts`')
  assert.equal(resolveSource('src/a.test.ts', 'node:fs', sources), null)
})

test('轮转起点：seed 对候选数取模（负 seed 也不越界）', () => {
  const dir = fixture()
  const a = plan({ root: dir, seed: 1, perFile: 2 })
  assert.equal(a.scope.candidates, 2, '夹具里应当正好两个候选')
  assert.equal(a.scope.startAt, 1)
  assert.equal(a.queue.length, 2)
  assert.deepEqual(plan({ root: dir, seed: -1, perFile: 2 }).scope.startAt, 1)
  assert.deepEqual(plan({ root: dir, seed: 0, perFile: 2 }).scope.startAt, 0)
})

test('真跑一趟（夹具仓）：有牙报 killed · 没牙报 survived · 原字节还原 · 退出码 0', () => {
  const dir = fixture()
  const out = join(dir, 'mutation-audit.json')
  const r = tool(['--root', dir, '--out', out, '--seed', '0', '--max-mutants', '2'])
  assert.equal(r.status, 0, `审计自己不该红（survivor 是发现不是失败）：${r.stderr}`)
  const rec = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(rec.schema, 1)
  assert.equal(rec.lane, 'fast')
  assert.equal(rec.clean, true, '跑完 src/ 不该有残留')
  assert.equal(rec.syntaxFilter, true, '夹具里有 package.json，语法过滤器该是可用的')
  assert.equal(rec.counts.candidates, 2)
  assert.equal(rec.counts.ran, 2)
  assert.equal(rec.counts.killed, 1, `应当恰好一处有牙：${JSON.stringify(rec.results)}`)
  assert.equal(rec.counts.survived, 1, `应当恰好一处没牙：${JSON.stringify(rec.results)}`)
  const survived = rec.results.find((x) => x.verdict === 'survived')
  assert.equal(survived.operator, '===', '没牙的应当是没人测的那个 ===')
  const killed = rec.results.find((x) => x.verdict === 'killed')
  assert.equal(killed.operator, '>=')
  assert.notEqual(killed.exitCode, 0, 'killed 的退出码应当是红的')
  assert.ok(killed.outputTail.length > 0, 'killed 要留下输出尾巴（红了才判得动）')
  assert.equal(readFileSync(join(dir, 'src', 'foo.ts'), 'utf8'), FOO, '原字节必须还原')
  assert.equal(git(dir, ['status', '--porcelain', '--', 'src']).trim(), '')
  console.log(
    `变异审计读数（夹具）：候选 ${rec.counts.candidates} · 跑了 ${rec.counts.ran} = 有牙 ${rec.counts.killed} + 没牙 ${rec.counts.survived} · 用时 ${rec.usedMs}ms`,
  )
})

test('时限到点就停：跑多少算多少，剩下的如实报（不假装跑完）', () => {
  const dir = fixture()
  const out = join(dir, 'mutation-audit.json')
  const r = tool(['--root', dir, '--out', out, '--seed', '0', '--budget-ms', '1'])
  assert.equal(r.status, 0, r.stderr)
  const rec = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(rec.counts.ran, 1, '预算 1ms：第一处跑完就停')
  assert.equal(rec.counts.skippedBudget, 1, '剩下那一处要如实记进"时限外没跑"')
  assert.match(r.stdout, /时限外没跑 1/)
})

// 实测：`node --check x.ts` 认不认 TS 看它**附近的 package.json**——同一个文件在 /tmp 里（没有
// package.json）报 `SyntaxError: Unexpected token ':'`，放一份就 OK。真仓有 package.json，所以
// 上面那条断言 `syntaxFilter === true`。校准本身用假 `check` / 假跑器直接断（不花墙钟）：
// 「过滤器判不了自己」时**不许**交一份"跑了 0 处"的报告。
test('过滤器自校准：连原样都判不过 → 不用它，照跑照判', () => {
  const dir = fixture()
  const { report } = audit({ root: dir, seed: 0, maxMutants: 2, check: () => false, run: () => ({ status: 0 }), say: () => {} })
  assert.equal(report.syntaxFilter, false, '校准该判这条过滤器不可用')
  assert.equal(report.counts.ran, 2, '不可用不等于一处都不跑')
  assert.equal(report.counts.survived, 2, '假跑器全绿 → 两处都该报 survived')
  assert.equal(report.counts.skippedSyntax, 0)
  assert.equal(report.clean, true)
})

test('过滤器可用时：语法先不过的那一处另记一档，不进判决', () => {
  const dir = fixture()
  let calls = 0
  const { report } = audit({
    root: dir,
    seed: 0,
    maxMutants: 2,
    check: () => calls++ === 0, // 第一次是校准（原样判得过），之后每一处都判不过
    run: () => ({ status: 0 }),
    say: () => {},
  })
  assert.equal(report.syntaxFilter, true)
  assert.equal(report.counts.ran, 0)
  assert.equal(report.counts.skippedSyntax, 2)
  assert.equal(report.counts.survived + report.counts.killed, 0)
})

test('负对照：src/ 不干净 → 拒绝跑（不覆盖没提交的改动）', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'src', 'foo.ts'), FOO.replace("'big'", "'BIG'"))
  const r = tool(['--root', dir, '--max-mutants', '1'])
  assert.equal(r.status, 2, `树脏应当拒绝，实得 ${r.status}`)
  assert.match(r.stderr, /src\/ 不干净/)
  assert.equal(
    readFileSync(join(dir, 'src', 'foo.ts'), 'utf8'),
    FOO.replace("'big'", "'BIG'"),
    '拒绝跑的时候一个字节都不许动',
  )
})

test('负对照：没有靶子 → 非零退出（不假装审计过了）', () => {
  const dir = fixture()
  const r = tool(['--root', dir, '--target', 'src/nope.ts'])
  assert.equal(r.status, 1, `没有靶子应当退 1，实得 ${r.status}`)
  assert.match(r.stderr, /没有靶子/)
})

test('负对照：参数不认识 / 档名拼错 → 退 2（不猜缺省）', () => {
  assert.equal(tool(['--nope', '1']).status, 2)
  assert.equal(tool(['--lane', 'quick']).status, 2)
  assert.equal(tool(['--budget-ms']).status, 2)
})

test('真仓读数：靶子与候选（只有有快档覆盖的源文件进候选）', () => {
  const { scope, queue } = plan({ root: REPO, lane: 'fast', seed: daySeed(), perFile: 2 })
  console.log(
    `变异审计靶子读数（真仓）：源文件 ${scope.sourceFiles} · 有快档覆盖 ${scope.covered} · 没覆盖 ${scope.uncovered} · 候选 ${scope.candidates} 处（每文件至多 2）· 起点 ${scope.startAt}`,
  )
  assert.equal(scope.uncovered, scope.sourceFiles - scope.covered)
  assert.equal(queue.length, scope.candidates)
  assert.ok(scope.covered > 0, '一个覆盖都没有，说明覆盖判据坏了')
  assert.ok(scope.candidates > 0, '一个候选都没有，说明算子表或覆盖判据坏了')
  for (const m of queue.slice(0, 5)) {
    assert.ok(m.file.startsWith('src/') && !m.file.endsWith('.test.ts'), `候选落在测试文件上了：${m.file}`)
    assert.ok(m.line >= 1 && m.from !== m.to)
  }
})
