// M4·V5 的断言。两条，逐条对 PLAN § 5.2 的 V5 行；第三条是命令面。
//
//   ① `dispose` 后挂载不在了、两个根下不留东西、无常驻进程
//   ② 把物化树改坏 → `dispose` + `fork` + `ensure` → 全树哈希与未损坏时相同，`verify-mat` 仍为 1
//   ③ 命令面：幂等 · 丢掉之后 `verify-mat` 与 `ensure` 都拒绝并指路
//
// ② 就是 § 3 那张表里"物化：增量 → 全量"那一行的**走通一次**：机制死掉时系统该是变慢，
// 不是跑不起来。这里量的是"重铺出来的那一棵与没坏的那一棵逐字节相同"——比的**只有内容**
// （路径 · 模式 · 内容哈希），不比 mtime：重铺一次当然会重写时间戳，那不是损坏。
//
// ①里的"两个根"按 § 8.4 读：`upper` 与 `merged` 是同一份物化的两个面。**四个坐标一起删**
// （加上 `tmp` 与 `cache`）——留半个会被下一次 `fork` 当成"已经铺好的"。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WORKSPACE_STATE, scanTree } from './diffstat.ts'
import { isMounted, removeTree, unmountOverlay } from './mount.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'cli', 'fugue.ts')
const AGENT = 'round'

const made: string[] = []
after(() => {
  for (const d of made) {
    try {
      unmountOverlay(join(d, '.fugue', 'mat', AGENT, 'merged'))
    } catch {
      // 没挂着就没什么可卸的
    }
    try {
      removeTree(d)
    } catch {
      // 收尾失败不改结论
    }
  }
})

interface Ran {
  status: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: readonly string[]): string {
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
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 退 ${r.status}：${r.stderr}`)
  return r.stdout.trim()
}

function run(dir: string, args: readonly string[], input?: string): Ran {
  const r = spawnSync(process.execPath, [CLI, '--root', dir, ...args], {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  })
  return { status: r.status ?? -1, stdout: r.stdout.trim(), stderr: r.stderr }
}

const must = (dir: string, args: readonly string[], input?: string): string => {
  const r = run(dir, args, input)
  assert.equal(r.status, 0, `${args.join(' ')} 没成：${r.stderr}`)
  return r.stdout
}

function fixture(): { dir: string; base: string; merged: string; mat: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-dispose-'))
  made.push(dir)
  const put = (rel: string, body: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  put('src/a.ts', 'export const a = 1\n')
  put('src/b.ts', 'export const b = 2\n')
  put('src/c.ts', 'export const c = 3\n')
  put('docs/manual.md', '# 手册\n')
  symlinkSync('src/a.ts', join(dir, 'link.ts'))
  git(dir, ['init', '-q', '-b', 'main', '.'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  const base = git(dir, ['rev-parse', 'HEAD'])
  const merged = must(dir, ['fork', base]).trim()
  return { dir, base, merged, mat: join(dir, '.fugue', 'mat', AGENT) }
}

/** 全树摘要：**路径 · 模式 · 内容哈希**，不含时间戳——重铺一次会重写时间戳，那不是损坏。 */
function digest(dir: string): string {
  // **跳过工作区自己的状态**（§ 9.6 的 `diff-stat` 用同一个口径）：合并树底下就挂着 `.fugue`，
  // 而物化的 `tmp/work` 是内核的草稿本——走进它是一次 `ELOOP`。
  const lines = scanTree(dir, { skip: WORKSPACE_STATE }).leaves.map(
    (l) => `${l.path}\t${l.mode.toString(8)}\t${l.hash}`,
  )
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex')
}

test('① dispose：挂载不在了 · 四个坐标一个不剩 · 没有进程挂在上面', async () => {
  const f = fixture()
  assert.equal(isMounted(f.merged), true, 'fork 之后该是挂着的')
  // `cache` 不在里面：它是 M5 的（§ 8.6），`fork` 不碰它——而 `dispose` 照样按四个坐标删。
  for (const p of ['upper', 'merged', 'tmp']) assert.equal(existsSync(join(f.mat, p)), true, p)

  const r = run(f.dir, ['dispose'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(isMounted(f.merged), false, '挂载不在了')
  for (const p of ['upper', 'merged', 'tmp', 'cache']) assert.equal(existsSync(join(f.mat, p)), false, `${p} 该一个不剩`)
  // 内核的草稿本 `tmp/work/work` 是 root:root 000——`removeTree` 的 rmdir 先试那一步就是为它写的。
  assert.equal(existsSync(f.mat), false, '物化根自己也不留')

  const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
  const lingering = ps.stdout.split('\n').filter((l) => l.includes(f.mat) && !l.includes('ps -eo'))
  assert.deepEqual(lingering, [], '没有进程挂在这个物化根上')

  // 幂等：本来就没有，照样成功。
  const again = run(f.dir, ['dispose'])
  assert.equal(again.status, 0)
  assert.match(again.stderr, /本来就没有/)
  const j = JSON.parse(must(f.dir, ['--json', 'dispose'])) as { existed: boolean; left: string[] }
  assert.deepEqual(j.left, [])
  assert.equal(j.existed, false)
})

test('② 退化档：改坏 → dispose + fork + ensure → 与没坏的那一棵逐字节相同', async () => {
  const f = fixture()
  // 三种变更各来一次：改一个 · 新加一个 · 删一个。
  must(f.dir, ['write', 'src/a.ts', '--stdin'], 'export const a = 9\n')
  must(f.dir, ['write', 'notes/n.txt', '--stdin'], '一份\n')
  must(f.dir, ['remove', 'src/c.ts'])
  must(f.dir, ['ensure'])
  const clean = digest(f.merged)
  assert.equal(run(f.dir, ['verify-mat']).status, 0, '先要有一棵核得过的树')

  // 从外面改坏三处：改内容 · 删掉一条 whiteout · 塞一条多出来的。
  writeFileSync(join(f.mat, 'upper', 'src', 'a.ts'), '从外面塞进来的\n')
  const wo = join(f.mat, 'upper', 'src', 'c.ts')
  assert.equal(lstatSync(wo).isCharacterDevice(), true, '删掉的那条在 upper 里该是一条 whiteout')
  spawnSync('rm', ['-f', wo])
  writeFileSync(join(f.mat, 'upper', 'src', 'extra.ts'), '多出来的\n')
  const broken = run(f.dir, ['verify-mat'])
  assert.equal(broken.status, 1)
  assert.match(broken.stdout, /内容对不上/)
  assert.match(broken.stdout, /只有落地有/)
  assert.match(broken.stdout, /清单有而落地没有/)

  // **退化档**：全部丢掉，从底重铺一遍。
  must(f.dir, ['dispose'])
  must(f.dir, ['fork', f.base])
  must(f.dir, ['ensure'])
  assert.equal(digest(f.merged), clean, '重铺出来的那一棵要与没坏的那一棵逐字节相同')
  const v = run(f.dir, ['--json', 'verify-mat'])
  assert.equal(v.status, 0, v.stderr)
  const parsed = JSON.parse(v.stdout) as { ok: boolean; precision: number; manifest: { paths: string[] } }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.precision, 1, '重铺之后 materialize-precision 仍是 1')
  assert.deepEqual(parsed.manifest.paths, ['notes/n.txt', 'src/a.ts', 'src/c.ts'])
  // 那一份底没有被动过：真源不因为物化重铺而变。
  assert.equal(readFileSync(join(f.dir, 'src/c.ts'), 'utf8'), 'export const c = 3\n')
})

test('③ 丢掉之后：verify-mat 与 ensure 都拒绝并指路', async () => {
  const f = fixture()
  must(f.dir, ['write', 'notes/n.txt', '--stdin'], '一份\n')
  must(f.dir, ['ensure'])
  must(f.dir, ['dispose'])

  const v = run(f.dir, ['verify-mat'])
  assert.equal(v.status, 1)
  assert.match(v.stderr, /物化树不在/)
  assert.match(v.stderr, /fork/)
  const e = run(f.dir, ['ensure'])
  assert.equal(e.status, 1)
  assert.match(e.stderr, /物化树不在/)
  // 日志还在：清单是派生的，丢掉它不影响历史。
  assert.match(must(f.dir, ['log']), /mat\/sync/)
  // 再铺一次就恢复：底没动，视图没动，落一次 delta 又对上了。
  must(f.dir, ['fork', f.base])
  must(f.dir, ['ensure'])
  assert.equal(run(f.dir, ['verify-mat']).status, 0)
  assert.equal(existsSync(join(f.merged, 'notes', 'n.txt')), true)
  assert.equal(readdirSync(join(f.mat, 'upper')).length > 0, true)
})
