// X2 的断言：**反向通道**——声明集内的回收、声明集外的拒绝（PLAN § 5.4 的 X2 行 · 架构 § 8.7）。
//
//   ① 一个往视图里写文件的动作：声明过的产出出现在视图里（`read` 读得到 · `diff` 报得出 ·
//      `ensure` 之后落在盘上），且**正好**是声明的那几条——声明成 `cache` 的那条目录里的东西
//      一个字节都不进视图
//   ② 未声明的路径写不进去、也不进视图：默认档由内核拒（子进程非零退出 · 树一个字节没变）；
//      树可写那一档由回收拒（`undeclared` 报出它，`collect` 一条都不收它）
//   ③ 负对照：动作不声明 `outputs` 时，它写下的一切一条都不进视图（写是写成功了，字节在缓存里）
//   ⑦ 声明集外那一栏的两条边界：祖先白障（声明的删除在上一层留下的影子）不算集外改动，
//      而"别处的白障"与"不是白障的祖先"照报
//
// 夹具与 `run.test.ts` 同一套（真 git 仓库 + 真 fork + 真 bwrap），动作外加一个 `gen`：
// 它往**两处**写——声明过的 `gen/`（要回写）与声明成 `cache` 的 `dist/`（不回写）。两处的
// 去处不同，正是断言①要看的那件事。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { envFor } from '../boundary/binding.ts'
import type { ActionBinding } from '../boundary/binding.ts'
import { confine } from '../boundary/confine.ts'
import { cacheLayoutOf } from '../roots/coords.ts'
import { createExecutor } from './exec.ts'
import { createReclaim } from './reclaim.ts'
import { resolvePolicy } from '../boundary/policy.ts'
import { makeWhiteout, unmountOverlay } from '../materialize/mount.ts'
import { createRoots } from '../roots/roots.ts'
import type { AbsPath, AgentId } from '../terms.ts'

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

/** 往两处写：`gen/` 是声明过的产出（要回写视图），`dist/` 声明成 `cache`（不回写）。 */
const GEN = `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('gen/sub', { recursive: true })
writeFileSync('gen/out.txt', '一二三\\n')
writeFileSync('gen/sub/inner.txt', 'inner\\n')
mkdirSync('dist', { recursive: true })
writeFileSync('dist/junk.txt', 'junk\\n')
writeFileSync(process.env.HOME + '/home.txt', 'home\\n')
writeFileSync(process.env.TMPDIR + '/tmp.txt', 'tmp\\n')
console.log('gen ok')
`

/** 负对照③用：**只往绑得住的地方写**（声明成 `cache` 的 `dist/` 与本 agent 的坐标）。 */
const GEN2 = `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('dist/sub', { recursive: true })
writeFileSync('dist/junk.txt', 'junk\\n')
writeFileSync('dist/sub/deep.txt', 'deep\\n')
writeFileSync(process.env.HOME + '/home.txt', 'home\\n')
writeFileSync(process.env.XDG_CACHE_HOME + '/xdg.txt', 'xdg\\n')
writeFileSync(process.env.TMPDIR + '/tmp.txt', 'tmp\\n')
console.log('gen2 ok')
`

const C_SRC = '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n'

interface Made {
  readonly root: string
  readonly base: string
  readonly agents: string[]
}
const MADE: Made[] = []

function workspace(agents: readonly string[]): Made {
  // 与 `run.test.ts` 同一条理由：自己收尾（先 dispose 再删），不用 `tmpDir` 那个帮手。
  const root = mkdtempSync(join(tmpdir(), 'fugue-x2-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.c'), C_SRC)
  writeFileSync(join(root, 'gen.mjs'), GEN)
  writeFileSync(join(root, 'gen2.mjs'), GEN2)
  git(root, 'init', '-q', '-b', 'main', '.')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', '起点')
  const base = git(root, 'rev-parse', 'HEAD')
  const made: Made = { root, base, agents: [...agents] }
  MADE.push(made)
  fugue(root, 'config', 'set', 'actions.gen', '{"argv":["node","gen.mjs"],"outputs":["gen"],"cache":["dist"]}')
  fugue(root, 'config', 'set', 'actions.gen2', '{"argv":["node","gen2.mjs"],"cache":["dist"]}')
  fugue(root, 'config', 'set', 'actions.escape', '{"argv":["sh","-c","echo x > src/a.c"]}')
  fugue(root, 'config', 'set', 'actions.mixed', '{"argv":["sh","-c","echo x > src/a.c; echo y > gen/out.txt"],"outputs":["gen"]}')
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

interface Row {
  readonly pos: { writer: string; seq: number }
  readonly e: Record<string, unknown> & { t: string }
}

function logRows(root: string, ...args: string[]): Row[] {
  const r = fugue(root, '--json', 'log', ...args)
  assert.equal(r.code, 0, r.err)
  return r.out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
}

function diffPaths(root: string): string[] {
  const r = fugue(root, 'diff')
  assert.equal(r.code, 0, r.err)
  return r.out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t')[1] ?? '')
}

function upperLeaves(root: string, agent: string): string[] {
  const upper = join(root, '.fugue', 'mat', agent, 'upper')
  if (!existsSync(upper)) return []
  const r = spawnSync('find', [upper, '-mindepth', '1', '!', '-type', 'd'], { encoding: 'utf8' })
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n').map((p) => p.slice(upper.length + 1))
}

test('X2 ① · 声明集内的产出进视图：read 读得到 · diff 正好那几条 · ensure 之后落在盘上', () => {
  const w = workspace(['round'])
  const merged = join(w.root, '.fugue', 'mat', 'round', 'merged')
  const cache = join(w.root, '.fugue', 'mat', 'round', 'cache')
  const before = git(w.root, 'status', '--porcelain')

  const r = fugue(w.root, 'run', 'gen')
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^0\t\d+\tfull\n$/, 'stdout 上是结果那一行')
  assert.match(r.err, /gen ok/, '子进程的输出走 stderr')
  assert.match(r.err, /回收 2 条进视图/)

  // 视图里读得到，内容逐字节是子进程写的那一份。
  assert.equal(fugue(w.root, 'read', 'gen/out.txt').out, '一二三\n')
  assert.equal(fugue(w.root, 'read', 'gen/sub/inner.txt').out, 'inner\n')
  // **正好是声明的那几条**：声明成 `cache` 的 `dist/` 与本 agent 的坐标都不进视图。
  assert.deepEqual(diffPaths(w.root), ['gen/out.txt', 'gen/sub/inner.txt'])
  assert.equal(fugue(w.root, 'read', 'dist/junk.txt').code, 1, 'cache 声明里的东西不回写')
  assert.equal(fugue(w.root, 'read', 'home.txt').code, 1, '本 agent 的坐标不回写')

  // 写是写成功了：字节在缓存那一侧（绑定落点），只是没进视图。
  assert.equal(readFileSync(join(cache, 'dist', 'junk.txt'), 'utf8'), 'junk\n')
  assert.equal(readFileSync(join(cache, 'home.txt'), 'utf8'), 'home\n')

  // `ensure` 之后落在盘上：合并树里读得到、verify-mat 仍然相等。
  const e = fugue(w.root, 'ensure')
  assert.equal(e.code, 0, e.err)
  assert.equal(readFileSync(join(merged, 'gen', 'out.txt'), 'utf8'), '一二三\n')
  assert.equal(readFileSync(join(merged, 'gen', 'sub', 'inner.txt'), 'utf8'), 'inner\n')
  assert.equal(fugue(w.root, 'verify-mat').code, 0, '清单 == 差异集：预建的空目录不进它')

  // 真源一个字节没动：视图不是工作树（§ 8.4）。
  assert.equal(git(w.root, 'status', '--porcelain'), before)

  // 两条 `view/write`（路径有序）+ 没有 `mat/reclaim`（这一趟没有越声明的地方）。
  const rows = logRows(w.root, '--agent', 'round')
  const kinds = rows.map((x) => x.e.t)
  assert.deepEqual(
    kinds.filter((k) => k === 'view/write').length,
    2,
    '正好两条 view/write',
  )
  assert.equal(kinds.includes('mat/reclaim'), false, '声明集外没有改动：不记那条事件')
  const end = rows.filter((x) => x.e.t === 'run/end').pop()
  assert.equal(end?.e.denied, false, '这一趟没有被拒的写入')
})

test('X2 ② · 未声明的写入：默认档由内核拒，子进程非零退出而树一个字节没变', () => {
  const w = workspace(['round'])
  const before = git(w.root, 'status', '--porcelain')
  const upperBefore = upperLeaves(w.root, 'round')

  const r = fugue(w.root, 'run', 'escape')
  assert.equal(r.code, 1, '子进程没成功 → 命令行退出码 1（真实退出码在 run/end 里）')
  assert.match(r.err, /有被拒的写入/)
  assert.match(r.err, /Read-only file system/, '内核给的那一句话原样落在 stderr 上')

  assert.equal(fugue(w.root, 'read', 'src/a.c').out, C_SRC, '视图里那个文件没变')
  assert.deepEqual(diffPaths(w.root), [], '视图里一条变更都没有')
  assert.deepEqual(upperLeaves(w.root, 'round'), upperBefore, '树一个字节没变（upper 里还是那几条）')

  const rows = logRows(w.root, '--agent', 'round')
  const end = rows.filter((x) => x.e.t === 'run/end').pop()
  // 真实的退出码是 shell 自己给的（重定向失败：dash 报 2），命令行只把它折成 1——§ 9.8 的退出码
  // 只有三个数，那个真值住在 `run/end` 与 `--json` 里。
  assert.notEqual(end?.e.exit, 0, '子进程真实的退出码在 run/end 里')
  assert.equal(end?.e.denied, true, '被拒这件事记在 run/end 的 denied 那一栏')
  assert.equal(
    rows.some((x) => x.e.t === 'mat/reclaim'),
    false,
    '默认档里没有越声明的改动可记：mat/reclaim 不出现（§ 8.7：记事件那一半在树可写那一档上兑现）',
  )
  assert.equal(git(w.root, 'status', '--porcelain'), before)
})

test('X2 ② 补 · 一半越界一半声明：放行的进视图，被拒的留在树外', () => {
  const w = workspace(['round'])
  const r = fugue(w.root, 'run', 'mixed')
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /有被拒的写入/)
  assert.deepEqual(diffPaths(w.root), ['gen/out.txt'], '声明过的那一条进来了，越界那一条没有')
  assert.equal(readFileSync(join(w.root, 'src', 'a.c'), 'utf8'), C_SRC, '真源里那一条没被改')
})

test('X2 ③ 负对照 · 不声明 outputs：写下的一切一条都不进视图', () => {
  const w = workspace(['round'])
  const cache = join(w.root, '.fugue', 'mat', 'round', 'cache')
  const r = fugue(w.root, 'run', 'gen2')
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /gen2 ok/)

  // 写成功了：字节都在绑定那一侧的缓存里。
  assert.equal(readFileSync(join(cache, 'dist', 'junk.txt'), 'utf8'), 'junk\n')
  assert.equal(readFileSync(join(cache, 'dist', 'sub', 'deep.txt'), 'utf8'), 'deep\n')
  assert.equal(readFileSync(join(cache, 'home.txt'), 'utf8'), 'home\n')
  assert.equal(readFileSync(join(cache, 'xdg-cache', 'xdg.txt'), 'utf8'), 'xdg\n')

  // 一条都不进视图：没有声明，就没有可回收的东西。
  assert.deepEqual(diffPaths(w.root), [])
  assert.equal(fugue(w.root, 'read', 'dist/junk.txt').code, 1)
  const kinds = logRows(w.root, '--agent', 'round').map((x) => x.e.t)
  assert.equal(kinds.filter((k) => k === 'view/write').length, 0, '一条 view/write 都没有')
  assert.equal(kinds.includes('mat/reclaim'), false)
})

test('X2 ④ · 树可写那一档：回收拒掉声明集外的改动，声明集内的照收', async () => {
  const w = workspace(['round'])
  const seed = fugue(w.root, 'run', 'gen')
  assert.equal(seed.code, 0, seed.err)
  const strategy = (JSON.parse(fugue(w.root, '--json', 'ensure').out) as { strategy: string }).strategy
  assert.equal(strategy, 'overlayfs', '这一档才有 `upper` 可枚举（架构 § 8.5）')

  const roots = createRoots(w.root)
  const agent = 'round' as AgentId
  const cache = cacheLayoutOf(roots, agent)
  const binding: ActionBinding = { name: 'mixed', argv: [], cwd: '', outputs: ['gen'], cache: ['dist'], env: {}, net: 'none' }
  // 树可写那一档得配一份那一档的策略值（Y2 起 `confine()` 读它，不再自己判断档）：
  // 没有层在场 → mode 记 workspace-write · enforcement 记 partial · net 记 host · **坐标是
  // 宿主那三条**（Y3 起），所以 `envFor` 也读它。
  const policy = resolvePolicy({ roots, agent, doc: {}, mode: 'workspace-write' })
  const env = envFor({ agent, binding, injections: {}, portIndex: 0, range: '31000-31099', policy })
  const confined = confine({
    roots,
    agent,
    argv: ['sh', '-c', 'echo x > src/a.c; echo z > gen/from-tree.txt'],
    cwd: '',
    declared: ['dist', 'gen'],
    env,
    policy,
  })
  assert.equal(confined.mode, 'workspace-write')
  const res = await createExecutor({ onChunk: () => {} }).run(
    agent,
    { action: 'mixed', confined, cwd: '', env },
    new AbortController().signal,
  )
  assert.equal(res.exit, 0, res.stderr)
  // 树里那一条真的写下去了：这一档的沙箱是关着的（这正是 § 15.7 的 E4 那一档）。
  assert.equal(readFileSync(join(roots.mergedRoot(agent), 'src', 'a.c'), 'utf8'), 'x\n')

  // **回收在卸载之后**（§ 8.7）：枚举 `upper` 之前先把树卸下来。
  unmountOverlay(roots.mergedRoot(agent))
  // 这一份回收读的是**绑定那一侧**（产出一路走 `--bind` 过去的），而树在那一档里是敞开的。
  const reclaim = createReclaim({
    roots,
    strategy: 'overlayfs',
    manifest: [],
    landing: 'cache',
    treeOpen: true,
  })
  const declared = reclaim.declare(agent, ['gen'])
  const deltas = await reclaim.collect(agent, declared)
  // **收的是那条声明落点的全貌**（§ 8.7：读绑定落点、不做内容比对）：种子那一趟的两条还在缓存里，
  // 加上这一趟新写的那一条。这不是缺陷，是"枚举而非 diff"的直接后果——记在疑点里。
  assert.deepEqual(
    deltas.map((d) => (d.kind === 'rename' ? d.to : d.path)),
    ['gen/from-tree.txt', 'gen/out.txt', 'gen/sub/inner.txt'],
    '声明集内的照收（落点里有什么收什么）',
  )
  assert.deepEqual(await reclaim.undeclared(agent, declared), ['src/a.c'], '声明集外的那一条被拒')
  // 缓存那一侧的落点确实有它（收的是绑定落点，不是 `upper`）。
  assert.equal(readFileSync(cache.bound('gen/from-tree.txt'), 'utf8'), 'z\n')
})

test('X2 ⑤ · 物化刚落下去的那些不许被报成"越了声明"（减数是落地之后的清单）', () => {
  const w = workspace(['round'])
  // 视图里先有一条**不在任何声明下面**的改动，而且它还没有 `mat/sync`（没 ensure 过）。
  assert.equal(fugue(w.root, 'write', 'notes.txt', '--stdin').code, 0)
  // 那扇窗就在这一条命令里：`run` 起进程之前先兑现一次物化，**那一下把 notes.txt 落进了
  // `upper`**。减数若是运行前从日志里读的那一份（还是空的），这条合法落地就成了"越了声明"。
  const r = fugue(w.root, 'run', 'gen')
  assert.equal(r.code, 0, r.err)
  assert.equal(readFileSync(join(w.root, '.fugue', 'mat', 'round', 'upper', 'notes.txt'), 'utf8'), '', '它确实在 upper 里')
  const claims = logRows(w.root, '--agent', 'round').filter((x) => x.e.t === 'mat/reclaim')
  assert.deepEqual(claims, [], '一条 mat/reclaim 都不该有：notes.txt 是物化落下去的，不是子进程写的')
  assert.equal(fugue(w.root, 'verify-mat').code, 0, '清单 == 差异集 == 盘上那几条')
  // 视图里那一份是：自己写下的 notes.txt + 声明集里收回来的那两条。
  assert.deepEqual(new Set(diffPaths(w.root)), new Set(['gen/out.txt', 'gen/sub/inner.txt', 'notes.txt']))
})

test('X2 ⑥ · 声明的那条路径的祖先在落地根里不是目录：回收照样收得动（不抛 ENOTDIR）', async () => {
  // 真档那一趟（样本盘第 1 案 · `agent/r1/4`）：同格 `bash rm` 删掉 `legacy/old-format.js`，
  // 随后又 `rmdir legacy`，而 `upper/legacy` 是那次 `rm` 留下来的**白障**（字符设备 0:0）。
  // 下一趟回收去 `lstat` 那条叶子路径（`topLevel()` 给的是路径本身，不是它那一段）→ `ENOTDIR`
  // 穿出工具面（`tool-threw`），那一格就此收场。
  //
  // 这里拿一条普通文件当那个祖先：**ENOTDIR 是同一种**（父亲不是目录），而白障要 `mknod`。
  const w = workspace(['round'])
  const roots = createRoots(w.root)
  const agent = 'round' as AgentId
  const upper = roots.scratchRoot(agent)
  assert.ok(existsSync(upper), 'fork 之后落地根该在')
  writeFileSync(join(upper, 'legacy'), 'not a dir\n')

  const reclaim = createReclaim({ roots, strategy: 'overlayfs', manifest: [], landing: 'upper', treeOpen: true })
  const declared = reclaim.declare(agent, ['legacy/old-format.js'])
  const deltas = await reclaim.collect(agent, declared)
  // 那一条在盘上够不着，所以收不回来；而**不抛**才是这一条要的——不该被报成一条产出，也不该
  // 让这一格收场。
  assert.deepEqual(deltas, [], '够不着的那一条不该被报成产出')
})

test('X2 ⑦ · 声明的删除在父亲那一层留下的白障，不算"集外的改动"', async () => {
  // 真档那一趟（样本盘第九趟 · 案一）：契约声明的就是 `legacy/old-format.js` 这一条，同格 `bash`
  // 把它删掉、又把空掉的 `legacy` 目录 `rmdir` 掉，内核在 `upper` 里为 `legacy` 留下一条白障
  // （字符设备 0:0）——于是回收把**一次干净的声明删除**报成了"集外改动"：
  // `mat/reclaim declared ["legacy/old-format.js"] changed ["legacy"]`（那一趟同一格连报四条）。
  // 那一栏的用处是判越界率（§ 8.13.a），而它是同一个改动在上一层的影子，不是第二件事。
  const w = workspace(['round'])
  const roots = createRoots(w.root)
  const agent = 'round' as AgentId
  const upper = roots.scratchRoot(agent)
  assert.ok(existsSync(upper), 'fork 之后落地根该在')
  const reclaim = createReclaim({ roots, strategy: 'overlayfs', manifest: [], landing: 'upper', treeOpen: true })
  const declared = reclaim.declare(agent, ['legacy/old-format.js'])

  // 一 · 祖先那一条白障（`mknod c 0 0`，内核留下的那一种）：不报。
  makeWhiteout(join(upper, 'legacy') as AbsPath, 'direct')
  assert.equal(lstatSync(join(upper, 'legacy')).isCharacterDevice(), true, '这一条该是白障')
  assert.deepEqual(await reclaim.undeclared(agent, declared), [], '祖先白障不是集外的改动')

  // 二 · 同一棵里**没被声明盖住**的那一条白障：照报——跳的只是"祖先"那一档，不是"凡是白障都跳"。
  makeWhiteout(join(upper, 'notes.md') as AbsPath, 'direct')
  assert.deepEqual(await reclaim.undeclared(agent, declared), ['notes.md'])

  // 三 · 祖先那一层落的**不是**白障（子进程把父亲换成了一条普通文件）：照报。判据是"这条白障是
  //      不是某条声明路径的祖先"，不是"这条路径是不是祖先"。
  rmSync(join(upper, 'legacy'), { force: true })
  rmSync(join(upper, 'notes.md'), { force: true })
  writeFileSync(join(upper, 'legacy2'), 'a plain file\n')
  const declared2 = reclaim.declare(agent, ['legacy2/old-format.js'])
  assert.deepEqual(await reclaim.undeclared(agent, declared2), ['legacy2'], '不是白障的祖先照报')
})
