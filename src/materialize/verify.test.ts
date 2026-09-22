// M4·V4 的断言。三条，逐条对 PLAN § 5.2 的 V4 行：
//
//   ① 重放 `mat/*` 得到的 `manifest` 与"base 与视图之间内容不同的路径"相等
//   ② `materialize-precision == 1`：三种会话（新建 · 改 3 个 · 删 1 个）触碰数都等于变更数
//   ③ 物化树被外部改坏 → 报出不等，不自愈
//
// **这一份整个走命令行**：`verify-mat` 交出去的就是一条命令（§ 9.6 的物化行），而那些量
// ——清单 · 差异集 · 落地集——正是它的出账。**三个来源两两独立**（日志 · 真源 · 文件系统，
// 见 `verify.ts` 的文件头），所以"相等"不是自己跟自己比；下面第三个用例专门验它不相等的时候
// 抓不抓得住，第四个用例是那条量度的负对照。
//
// **负对照为什么长这样**（④）：§ 8.5 明写"按账本算……比值恒等于 1，于是抓不住'重写整棵树'
// 这一类失效"。所以负对照就是**假装物化器把整棵树重写了一遍**——把 base 里每一条都照抄进
// `upper`。合并树上看不出来（内容一模一样），全树快照也看不出来；看得见它的只有 `find upper`。
// 这一条不成立的话，`materialize-precision` 就只是账本的复读机。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { removeTree, unmountOverlay } from './mount.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'cli', 'fugue.ts')
const AGENT = 'round'

const made: string[] = []
after(() => {
  // **先卸再删**：`fork` 挂上的那个合并树还挂在这些临时目录里，`rm -rf` 会在挂载点上出
  // `EACCES`（而且挂载点底下是内核的草稿本 `work/work`）。`removeTree` 是 rmdir 先试那一个。
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

/** 一个真仓库：工作树与 `main` 上那个提交逐字节一致（清单的 base 就是它）。 */
function fixture(extra: readonly string[] = []): { dir: string; base: string; merged: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-verify-'))
  made.push(dir)
  const put = (rel: string, body: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  put('src/a.ts', 'export const a = 1\n')
  put('src/b.ts', 'export const b = 2\n')
  put('src/c.ts', 'export const c = 3\n')
  put('docs/manual.md', '# 手册\n')
  git(dir, ['init', '-q', '-b', 'main', '.'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  const base = git(dir, ['rev-parse', 'HEAD'])
  const forked = run(dir, ['fork', base, ...extra])
  assert.equal(forked.status, 0, `fork 没成：${forked.stderr}`)
  return { dir, base, merged: forked.stdout.trim() }
}

function run(dir: string, args: readonly string[], input?: string): Ran {
  const r = spawnSync(process.execPath, [CLI, '--root', dir, ...args], {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  })
  return { status: r.status ?? -1, stdout: r.stdout.trim(), stderr: r.stderr }
}

function write(dir: string, rel: string, body: string): void {
  const r = run(dir, ['write', rel, '--stdin'], body)
  assert.equal(r.status, 0, `写 ${rel} 没成：${r.stderr}`)
}

interface Verdict {
  ok: boolean
  precision: number | null
  rev: number
  strategy: string
  manifest: { paths: string[]; hashes: string[] }
  diff: { paths: string[]; hashes: string[] }
  landed: { paths: string[]; hashes: string[] }
  onlyManifest: string[]
  onlyDiff: string[]
  onlyLanded: string[]
  missing: string[]
  mismatch: string[]
}

function verify(dir: string): Verdict {
  const r = run(dir, ['--json', 'verify-mat'])
  assert.ok(r.stdout !== '', `verify-mat 没吐 JSON（退 ${r.status}）：${r.stderr}`)
  return JSON.parse(r.stdout) as Verdict
}

/** 落地根里那几条叶子：内容哈希或"这儿没有了"（whiteout 的哈希记的是空串）。 */
function landing(dir: string): Map<string, string> {
  const upper = join(dir, '.fugue', 'mat', AGENT, 'upper')
  const out = new Map<string, string>()
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel === '' ? upper : join(upper, rel))) {
      const child = rel === '' ? name : `${rel}/${name}`
      const abs = join(upper, child)
      const st = lstatSync(abs)
      if (st.isDirectory()) walk(child)
      else if (st.isCharacterDevice() && st.rdev === 0) out.set(child, '')
      else out.set(child, createHash('sha256').update(readFileSync(abs)).digest('hex'))
    }
  }
  walk('')
  return out
}

test('① 清单 == 差异集：三种会话之后三者两两相等', async () => {
  const f = fixture()
  // 新建一条
  write(f.dir, 'notes/first.txt', '第一份\n')
  assert.equal(run(f.dir, ['ensure']).status, 0)
  let v = verify(f.dir)
  assert.equal(v.ok, true, JSON.stringify({ onlyManifest: v.onlyManifest, onlyDiff: v.onlyDiff }))
  assert.deepEqual(v.manifest.paths, ['notes/first.txt'])
  assert.deepEqual(v.diff.paths, v.manifest.paths, '重放出的清单 == base 与视图之间的差异集')
  assert.deepEqual(v.landed.paths, v.manifest.paths, '盘上落地根里那几条 == 清单')

  // 改 3 个
  for (const [rel, body] of [
    ['src/a.ts', 'export const a = 2\n'],
    ['src/b.ts', 'export const b = 22\n'],
    ['docs/manual.md', '# 手册（改过）\n'],
  ] as const) {
    write(f.dir, rel, body)
  }
  assert.equal(run(f.dir, ['ensure']).status, 0)
  v = verify(f.dir)
  assert.equal(v.ok, true)
  assert.deepEqual(v.manifest.paths, ['docs/manual.md', 'notes/first.txt', 'src/a.ts', 'src/b.ts'])
  assert.deepEqual(v.diff.paths, v.manifest.paths)
  // **内容哈希逐一相等**，不只是路径集合相等。
  assert.deepEqual(v.landed.hashes, v.manifest.hashes)
  assert.deepEqual(v.diff.hashes, v.manifest.hashes)

  // 删 1 个
  assert.equal(run(f.dir, ['remove', 'src/c.ts']).status, 0)
  assert.equal(run(f.dir, ['ensure']).status, 0)
  v = verify(f.dir)
  assert.equal(v.ok, true)
  assert.deepEqual(v.manifest.paths, ['docs/manual.md', 'notes/first.txt', 'src/a.ts', 'src/b.ts', 'src/c.ts'])
  const at = v.manifest.paths.indexOf('src/c.ts')
  assert.equal(v.manifest.hashes[at], '', '删掉的那条哈希是空串：这儿没有了')
  assert.equal(landing(f.dir).get('src/c.ts'), '', '落地根里它是一条 whiteout')
  assert.equal(lstatSync(join(f.merged, 'src/c.ts'), { throwIfNoEntry: false }), undefined)
})

test('② materialize-precision == 1：新建 · 改 3 个 · 删 1 个，三会话都是 1', async () => {
  const f = fixture()
  const sessions: readonly (readonly string[])[] = [
    ['notes/new.txt'],
    ['src/a.ts', 'src/b.ts', 'docs/manual.md'],
    ['src/c.ts'],
  ]
  const expects = [
    ['notes/new.txt'],
    ['docs/manual.md', 'notes/new.txt', 'src/a.ts', 'src/b.ts'],
    ['docs/manual.md', 'notes/new.txt', 'src/a.ts', 'src/b.ts', 'src/c.ts'],
  ]
  for (let i = 0; i < sessions.length; i++) {
    for (const rel of sessions[i]) {
      if (rel.endsWith('new.txt')) write(f.dir, rel, '新的\n')
      else if (rel === 'src/c.ts') assert.equal(run(f.dir, ['remove', rel]).status, 0)
      else write(f.dir, rel, `${rel} 改过\n`)
    }
    assert.equal(run(f.dir, ['ensure']).status, 0)
    const v = verify(f.dir)
    assert.equal(v.ok, true, `第 ${i + 1} 次会话之后不等：${JSON.stringify(v.mismatch)}`)
    assert.equal(v.precision, 1, `第 ${i + 1} 次会话的比值该是 1，实得 ${v.precision}`)
    assert.equal(v.landed.paths.length, v.diff.paths.length)
    assert.deepEqual(v.manifest.paths, expects[i], `第 ${i + 1} 次会话之后的清单`)
  }
})

test('③ 物化树被外部改坏：报出不等，而且不修', async () => {
  const f = fixture()
  write(f.dir, 'src/a.ts', 'export const a = 2\n')
  write(f.dir, 'notes/n.txt', '一份\n')
  assert.equal(run(f.dir, ['ensure']).status, 0)
  const before = landing(f.dir)
  const events = readFileSync(join(f.dir, '.fugue', 'log', `${AGENT}.jsonl`), 'utf8').trim().split('\n').length
  assert.equal(verify(f.dir).ok, true)

  // 一 · 改内容：`upper` 里那条被就地改坏。
  const damaged = join(f.dir, '.fugue', 'mat', AGENT, 'upper', 'src', 'a.ts')
  writeFileSync(damaged, '从外面塞进来的\n')
  const first = run(f.dir, ['verify-mat'])
  assert.equal(first.status, 1, '不等要退 1（与 replay --verify 同一条纪律）')
  assert.match(first.stdout, /两边都有而内容对不上/)

  // 二 · **不自愈**：再核一次，报的还是同一条，而且那个文件还是坏的。
  const second = run(f.dir, ['verify-mat'])
  assert.equal(second.status, 1)
  assert.equal(readFileSync(damaged, 'utf8'), '从外面塞进来的\n', 'verify-mat 只报不修（§ 8.5：删除重建）')
  assert.equal(
    readFileSync(join(f.dir, '.fugue', 'log', `${AGENT}.jsonl`), 'utf8').trim().split('\n').length,
    events,
    '核一遍不写日志',
  )

  // 三 · 一条该在的没了（whiteout 被删）：`missing` 那一栏说话，比值跟着掉。
  rmSync(join(f.dir, '.fugue', 'mat', AGENT, 'upper', 'notes', 'n.txt'))
  const third = verify(f.dir)
  assert.equal(third.ok, false)
  assert.deepEqual(third.missing, ['notes/n.txt'])
  assert.ok(third.precision !== null && third.precision < 1, `落地少了，比值该小于 1：${third.precision}`)
  assert.ok(before.size >= 2)
})

test('④ 负对照：整棵树被照抄进 upper（内容一样）——只有枚举看得见，账本看不见', async () => {
  const f = fixture()
  write(f.dir, 'notes/n.txt', '一份\n')
  assert.equal(run(f.dir, ['ensure']).status, 0)
  assert.equal(verify(f.dir).precision, 1)

  // 假装物化器把整棵树重写了一遍：base 里每一条都照抄进 `upper`，内容一字不差。
  const upper = join(f.dir, '.fugue', 'mat', AGENT, 'upper')
  const copied: string[] = []
  for (const rel of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'docs/manual.md']) {
    mkdirSync(join(upper, dirname(rel)), { recursive: true })
    writeFileSync(join(upper, rel), readFileSync(join(f.dir, rel)))
    copied.push(rel)
  }
  // 合并树上看不出任何变化——内容与 lower 一模一样。
  const v = verify(f.dir)
  assert.equal(v.ok, false, '整棵树被重写这一类，要抓得住')
  assert.deepEqual(v.onlyLanded, copied.slice().sort(), '它们出现在"只有落地有"那一栏')
  assert.ok(v.precision !== null && v.precision > 1, `比值该大于 1：${v.precision}`)
  assert.equal(v.diff.paths.length, 1, '真正的变更还是只有一条')
  assert.deepEqual(v.diff.paths, ['notes/n.txt'])
})

test('⑤ copy 档：同一套核对在另一档上也成立，改坏的是 `merged` 里那一条', async () => {
  const f = fixture(['--strategy', 'copy'])
  write(f.dir, 'src/a.ts', 'export const a = 2\n')
  write(f.dir, 'notes/n.txt', '一份\n')
  assert.equal(run(f.dir, ['ensure']).status, 0)
  const v = verify(f.dir)
  assert.equal(v.strategy, 'copy')
  assert.equal(v.ok, true)
  assert.equal(v.precision, 1)
  assert.deepEqual(v.manifest.paths, ['notes/n.txt', 'src/a.ts'])

  // 一 · 塞进去的内容与谁都不一样：它还在落地集里，但哈希对不上清单。
  writeFileSync(join(f.merged, 'src/a.ts'), '从外面塞进来的\n')
  const junk = verify(f.dir)
  assert.equal(junk.ok, false)
  assert.deepEqual(junk.mismatch, ['src/a.ts'])

  // 二 · 改回 base 那一份：这一档里"与 base 一样"就是"没落地"，它从落地集里掉出去。
  writeFileSync(join(f.merged, 'src/a.ts'), readFileSync(join(f.dir, 'src/a.ts')))
  const reverted = verify(f.dir)
  assert.equal(reverted.ok, false)
  assert.deepEqual(reverted.missing, ['src/a.ts'])
  assert.equal(reverted.precision, 0.5, '两条变更里只剩一条真的落地了')
})
