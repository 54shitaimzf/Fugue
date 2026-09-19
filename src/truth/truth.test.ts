// M1 的断言。四条对应 PLAN § 5 给 U2 的验收，其余几条守的是它周边的边界。
//
// ① ② ④ 要真并发与真崩溃，所以写者与崩溃都是**真进程**（test/helpers/truth-writer.ts）：
// 同一个进程里的四个 promise 共用一个人工事件循环，验不出"零协调"，也验不出 CAS 是不是
// 恰好放行一个。断言**在位**，不断言快慢。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { logDir, openLog } from '../log/log.ts'
import { kindOf, openTruth, RefConflictError, RefNotCommitError, RefNotFoundError } from './truth.ts'
import type { TreeEntry } from './contract.ts'
import type { AgentId, BlobId, CommitId, RefName, WriterId } from '../terms.ts'

const REPO = join(import.meta.dirname, '..', '..')
const HELPER = join(REPO, 'test', 'helpers', 'truth-writer.ts')
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')

/** 测试自己起 git 时用同一套隔离：用户级配置不该决定测试的读数。 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

function git(root: string, ...args: string[]) {
  return spawnSync('git', ['--git-dir=' + join(root, '.git'), ...args], {
    env: GIT_ENV,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fugue-truth-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

/**
 * `fsck` 的判据是退出码。**dangling 是正常输出，不是错误**——架构 § 9.3 那张表里，
 * 崩溃在协议第 1–2 步之间留下的就是孤儿 blob，而它"不影响正确性"。
 */
function fsck(root: string): { status: number; out: string; err: string } {
  const r = git(root, 'fsck')
  return { status: r.status ?? 1, out: r.stdout, err: r.stderr }
}

function locks(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.lock')) out.push(p)
    }
  }
  walk(join(root, '.git'))
  return out
}

interface HelperRun {
  code: number
  stdout: string
  stderr: string
}

function runHelper(root: string, ref: string, ...args: string[]): Promise<HelperRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, root, ref, ...args], { env: GIT_ENV })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }))
  })
}

function jsonLines(out: string): Record<string, unknown>[] {
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl !== -1) resolve(buf.slice(0, nl))
    })
    child.on('error', reject)
  })
}

/** 本进程起的 git 子进程。用来把"批量子进程真的在跑"从自报数变成外部可见的事实。 */
function gitChildren(): number[] {
  const out: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (comm === 'git' && ppid === process.pid) out.push(Number(name))
    } catch {
      // 进程可能刚好退出，跳过
    }
  }
  return out
}

// ────────────────────────────────── 断言 ① 并发提交

test('断言①：N=4 并发提交 → 4 个有效提交，git fsck 干净，零协调', async (ctx) => {
  const root = tmpRoot()
  const refs = [1, 2, 3, 4].map((i) => `refs/heads/agent/r1/${i}`)
  const outs = await Promise.all(refs.map((r) => runHelper(root, r, 'commit', '20')))
  for (const [i, o] of outs.entries()) {
    assert.equal(o.code, 0, `第 ${i + 1} 个写者退出码非零：${o.stderr}`)
    const rows = jsonLines(o.stdout)
    assert.equal(rows.filter((r) => r.ok === true).length, 20, `第 ${i + 1} 个写者应当产出 20 个提交`)
  }

  const t = openTruth(root)

  ctx.after(() => t.close())
  const heads: string[] = []
  for (const ref of refs) {
    const head = await t.resolve(ref as RefName)
    heads.push(head)
    assert.equal((await t.listAt(head, '')).length, 20, `${ref} 的树里应当有 20 个文件`)
    assert.equal((await t.readAt(head, 'w1.txt'))?.toString(), `${ref} 的第 1 条内容\n`)
    assert.equal((await t.readAt(head, 'w20.txt'))?.toString(), `${ref} 的第 20 条内容\n`)
  }
  await t.close()
  assert.equal(new Set(heads).size, 4, '四个写者应当是四个不同的提交')
  assert.equal(existsSync(join(root, '.git', 'index')), false, 'M1 不落索引（§ 8.2 硬约束 1）')
  assert.deepEqual(locks(root), [], '并发跑完不该留下任何 ref 锁')

  const f = fsck(root)
  assert.equal(f.status, 0, `git fsck 非零：${f.err}${f.out}`)
  assert.doesNotMatch(f.out, /dangling commit/, '四个写者的提交都该是可达的')
  assert.doesNotMatch(f.out, /error in/, '不该有对象级错误')
})

// ────────────────────────────────── 断言 ② CAS

test('断言②：同一个 expectedOld 并发 advance 同一个 ref → 恰一个成功', async (ctx) => {
  const root = tmpRoot()
  const barrier = join(mkdtempSync(join(tmpdir(), 'fugue-bar-')), 'go')

  const t = openTruth(root)

  ctx.after(() => t.close())
  const baseBlob = await t.putBlob(Buffer.from('base\n'))
  const base = await t.commit(
    await t.putTree([{ name: 'base.txt', mode: 0o100644, id: baseBlob }]),
    [],
    'base',
  )
  await t.advance('refs/heads/main', base, null)
  await t.close()

  const kids = [0, 1, 2, 3].map(() => runHelper(root, 'refs/heads/main', 'race', base, barrier))
  // 让四个都造好自己的提交、走到栅栏前，再一起放行——这样才是"同时"。
  await new Promise((r) => setTimeout(r, 500))
  writeFileSync(barrier, '')
  const outs = await Promise.all(kids)

  const rows = outs.flatMap((o) => jsonLines(o.stdout))
  for (const [i, o] of outs.entries()) {
    assert.equal(o.code, 0, `第 ${i + 1} 个进程应当正常退出（输掉 CAS 不是异常）：${o.stderr}`)
  }
  assert.equal(rows.length, 4)
  const won = rows.filter((r) => r.ok === true)
  const lost = rows.filter((r) => r.ok === false)
  assert.equal(won.length, 1, `恰一个成功，实际 ${won.length}`)
  assert.equal(lost.length, 3)
  for (const l of lost) assert.equal(l.error, 'RefConflictError', `输的原因应当是 CAS：${JSON.stringify(l)}`)
  assert.equal(new Set(rows.map((r) => r.commit)).size, 4, '四个提交各不相同')

  const t2 = openTruth(root)

  ctx.after(() => t2.close())
  assert.equal(await t2.resolve('refs/heads/main'), won[0].commit, 'ref 应当停在赢家那个提交上')
  await t2.close()

  // 输掉的三个提交成了孤儿提交：**fsck 照样干净**，它们留给屏障点的 gc 回收。
  const f = fsck(root)
  assert.equal(f.status, 0, `git fsck 非零：${f.err}${f.out}`)
  assert.equal((f.out.match(/dangling commit/g) ?? []).length, 3)
})

// ────────────────────────────────── 断言 ③ 批量读

test('断言③：读 500 个 blob 只起一个 git 进程（§ 8.2 的批量读）', async (ctx) => {
  const root = tmpRoot()
  const writer = openTruth(root)
  ctx.after(() => writer.close())
  const ids: BlobId[] = []
  for (let i = 0; i < 500; i++) ids.push(await writer.putBlob(Buffer.from(`第 ${i} 个 blob\n`)))
  await writer.close()

  const t = openTruth(root)

  ctx.after(() => t.close())
  assert.equal(t.stats().gitSpawns, 0, '开句柄本身不该起进程')
  for (let i = 0; i < 500; i++) {
    assert.equal(Buffer.from(await t.getBlob(ids[i])).toString(), `第 ${i} 个 blob\n`, `第 ${i} 个`)
  }
  const spawns = t.stats().gitSpawns
  assert.equal(spawns, 1, `读 500 个 blob 起了 ${spawns} 个 git 进程`)
  assert.equal(t.stats().readTier, 'batch')
  await t.close()
})

test('退化档：批量子进程被杀 → 退回逐次读，读数一个不差', async (ctx) => {
  const root = tmpRoot()
  const writer = openTruth(root)
  ctx.after(() => writer.close())
  const ids: BlobId[] = []
  for (let i = 0; i < 50; i++) ids.push(await writer.putBlob(Buffer.from(`降级 ${i}\n`)))
  await writer.close()

  const t = openTruth(root)

  ctx.after(() => t.close())
  assert.equal((await t.getBlob(ids[0])).toString(), '降级 0\n')
  assert.equal(t.stats().gitSpawns, 1, '第一个读起了那一个批量子进程')

  const kids = gitChildren()
  assert.equal(kids.length, 1, `应当恰好有一个 cat-file 子进程在跑，实际 ${kids.length}`)
  process.kill(kids[0], 'SIGKILL')
  await new Promise((r) => setTimeout(r, 200))

  for (let i = 0; i < 50; i++) {
    assert.equal(Buffer.from(await t.getBlob(ids[i])).toString(), `降级 ${i}\n`, `第 ${i} 个`)
  }
  assert.equal(t.stats().readTier, 'oneshot', '批量子进程死了之后应当报逐次读')
  assert.equal(t.stats().gitSpawns, 1 + 50, '退化之后每个读各起一个进程——变慢，不是跑不起来')
  await t.close()
})

// ────────────────────────────────── 断言 ④ 协议中途崩溃

test('断言④：提交协议第 1–2 步之间崩溃 → 孤儿 blob，git fsck 仍干净', async (ctx) => {
  const root = tmpRoot()
  const t = openTruth(root)
  ctx.after(() => t.close())
  const baseBlob = await t.putBlob(Buffer.from('base\n'))
  const base = await t.commit(
    await t.putTree([{ name: 'base.txt', mode: 0o100644, id: baseBlob }]),
    [],
    'base',
  )
  await t.advance('refs/heads/main', base, null)
  await t.close()

  const child = spawn(process.execPath, [HELPER, root, 'refs/heads/main', 'crash'], { env: GIT_ENV })
  ctx.after(() => child.kill('SIGKILL'))
  const line = await firstLine(child)
  const blob = JSON.parse(line).blob as string
  assert.equal(git(root, 'cat-file', '-e', blob).status, 0, '崩溃前写下的 blob 必须真的在对象库里')
  child.kill('SIGKILL')
  await once(child, 'close')

  // 第 2 步没发生：没有任何东西指向这个 blob，日志也一行都没有。
  assert.equal(existsSync(join(logDir(root), 'main.jsonl')), false, '协议第 2 步不该留下日志')
  const t2 = openTruth(root)
  ctx.after(() => t2.close())
  assert.equal(await t2.readAt(base, 'orphan.txt'), null)
  await t2.close()

  const f = fsck(root)
  assert.equal(f.status, 0, `fsck 必须干净（§ 9.3：孤儿 blob 可修，不影响正确性）：${f.err}${f.out}`)
  assert.match(f.out, new RegExp(`dangling blob ${blob}`), '那个 blob 应当被报成 dangling')
  assert.equal(git(root, 'rev-parse', 'refs/heads/main').stdout.trim(), base, '基线不受影响')
})

// ────────────────────────────────── 读路径与树

test('读路径：blob 逐字节往返（含 NUL 与换行），readAt / statAt / listAt 的边界', async (ctx) => {
  const root = tmpRoot()
  const t = openTruth(root)
  ctx.after(() => t.close())
  const raw = Buffer.from([0x00, 0x01, 0xff, 0x0a, 0x0d, 0x00, 0x7f, 0x80])
  const bin = await t.putBlob(raw)
  assert.deepEqual(Buffer.from(await t.getBlob(bin)), raw, 'blob 必须逐字节回得来')

  const text = Buffer.from('一行\n两行\n')
  const doc = await t.putBlob(text)
  const target = Buffer.from('目标/路径')
  const link = await t.putBlob(target)
  const tree = await t.putTree([
    { name: 'bin', mode: 0o100644, id: bin },
    { name: 'doc/a.txt', mode: 0o100644, id: doc },
    { name: 'link', mode: 0o120000, id: link },
  ])
  const c = await t.commit(tree, [], '读路径')

  assert.deepEqual(Buffer.from(await t.readAt(c, 'bin')), raw)
  assert.equal((await t.readAt(c, 'doc/a.txt'))?.toString(), text.toString())
  assert.equal(await t.readAt(c, 'doc'), null, '目录没有字节')
  assert.equal(await t.readAt(c, '没有这个'), null)
  assert.equal(await t.statAt(c, '没有这个'), null)

  assert.deepEqual(await t.statAt(c, 'link'), {
    kind: 'symlink',
    mode: 0o120000,
    size: target.length,
    id: link,
  })
  const dirMeta = await t.statAt(c, 'doc')
  assert.equal(dirMeta?.kind, 'dir')
  assert.equal(dirMeta?.mode, 0o40000)
  assert.equal(dirMeta?.size, 0, '目录的 size 是形状要求的 0，不是读数')
  assert.equal((await t.statAt(c, 'doc/a.txt'))?.size, text.length)

  assert.deepEqual(
    (await t.listAt(c, '')).map((e) => `${e.name}:${e.kind}`),
    ['bin:file', 'doc:dir', 'link:symlink'],
  )
  assert.deepEqual(
    (await t.listAt(c, 'doc')).map((e) => `${e.name}:${e.kind}:${e.size}`),
    [`a.txt:file:${text.length}`],
  )
  assert.deepEqual(await t.listAt(c, '没有这个'), [], '不存在的目录列出来是空的')
  assert.deepEqual(await t.listAt(c, 'bin'), [], '文件不是目录')

  // 160000（submodule）有它自己的 kind：既不报成 0 字节的文件（那是说谎，后面每一层
  // 都会拿着错的形状干活），也不让整棵树读不了。
  assert.equal(kindOf(0o160000), 'gitlink')
  assert.throws(() => kindOf(0o100664), /不认识这个条目类型/)
  await t.close()
})

test('putTree：同一集合得到同一个 tree id；空树有定值；两种冲突拒绝', async (ctx) => {
  const root = tmpRoot()
  const t = openTruth(root)
  ctx.after(() => t.close())
  const a = await t.putBlob(Buffer.from('a\n'))
  const b = await t.putBlob(Buffer.from('b\n'))
  const entries: TreeEntry[] = [
    { name: 'a.txt', mode: 0o100644, id: a },
    { name: 'sub/b.txt', mode: 0o100644, id: b },
    { name: 'sub/deep/c.txt', mode: 0o100755, id: a },
  ]
  const one = await t.putTree(entries)
  const two = await t.putTree([...entries].reverse())
  assert.equal(one, two, '同一个条目集必须得到同一个 tree id，与输入顺序无关')
  assert.equal(
    await t.putTree([]),
    '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    '空树是 git 的定值',
  )
  await assert.rejects(() => t.putTree([...entries, entries[0]]), /给了两次/)
  await assert.rejects(
    () => t.putTree([{ name: 'x', mode: 0o100644, id: a }, { name: 'x/y', mode: 0o100644, id: b }]),
    /既是文件又是目录/,
  )
  await assert.rejects(() => t.putTree([{ name: '../越界', mode: 0o100644, id: a }]), /\.\./)
  await assert.rejects(() => t.putTree([{ name: '/绝对', mode: 0o100644, id: a }]), /相对路径/)
  await t.close()
})

test('putTree：`sub`（目录）与 `sub.txt`（文件）同在一棵树里，git 的树序成立', async (ctx) => {
  // git 的树序把目录当成"名字加一个斜杠"参与比较，所以 `sub.txt` 排在 `sub/` **前面**；
  // 顺序反了的树 `git fsck` 直接报 treeNotSorted 并以非零退出（实测）。
  const root = tmpRoot()
  const t = openTruth(root)
  ctx.after(() => t.close())
  const blob = await t.putBlob(Buffer.from('x\n'))
  const tree = await t.putTree([
    { name: 'sub/c.txt', mode: 0o100644, id: blob },
    { name: 'sub.txt', mode: 0o100644, id: blob },
  ])
  const c = await t.commit(tree, [], '树序')
  assert.deepEqual(
    (await t.listAt(c, '')).map((e) => e.name),
    ['sub.txt', 'sub'],
    'git 的树序：sub.txt 在前',
  )
  const f = fsck(root)
  assert.equal(f.status, 0, `fsck 必须干净：${f.err}${f.out}`)
  await t.close()
})

// ────────────────────────────────── refs 与 CAS 的边界

test('advance：创建即占位；输了给出实际值；resolve 只认提交', async (ctx) => {
  const root = tmpRoot()
  const t = openTruth(root)
  ctx.after(() => t.close())
  const blob = await t.putBlob(Buffer.from('x\n'))
  const tree = await t.putTree([{ name: 'x.txt', mode: 0o100644, id: blob }])
  const c1 = await t.commit(tree, [], '1')
  const c2 = await t.commit(tree, [c1], '2')

  await t.advance('refs/heads/main', c1, null)
  assert.equal(await t.resolve('refs/heads/main'), c1)
  await assert.rejects(
    () => t.advance('refs/heads/main', c2, null),
    (e: unknown) => e instanceof RefConflictError && e.actual === c1,
    'expectedOld=null 时 ref 已存在 → CAS 必须拒绝，并报出实际值',
  )
  await assert.rejects(() => t.resolve('refs/heads/nope'), RefNotFoundError)
  await t.advance('refs/heads/main', c2, c1)
  assert.equal(await t.resolve('refs/heads/main'), c2)

  // 指向 blob 的 ref 不是提交点：`resolve` 的 `^{commit}` 就是为这一条。分支名由 git
  // 自己挡（`refs/heads/*` 只收提交对象），tags 下可以指 blob——所以这里用 tags。
  await t.advance('refs/tags/round/r1/merged', blob as unknown as CommitId, null)
  await assert.rejects(
    () => t.resolve('refs/tags/round/r1/merged'),
    RefNotCommitError,
    '存在但不是提交，与"不存在"是两回事：混成一个，调用者会在一个有东西的位置上静默造出根提交',
  )
  // 而 advance 失败的原因不止一种：把分支指向 blob 是 git 拒的，不是 CAS 输的。
  await assert.rejects(
    () => t.advance('refs/heads/blobref', blob as unknown as CommitId, null),
    (e: unknown) => !(e instanceof RefConflictError),
    'git 拒绝把分支指向非提交对象，这不是 CAS 冲突',
  )
  await t.close()
})

// ────────────────────────────────── mergeTree

test('mergeTree：判据是退出码；冲突时不给出 tree', async (ctx) => {
  const root = tmpRoot()
  const t = openTruth(root)
  ctx.after(() => t.close())
  const put = (s: string) => t.putBlob(Buffer.from(s))
  const keep = await put('keep\n')
  const fBase = await put('base\n')
  const base = await t.commit(
    await t.putTree([
      { name: 'f.txt', mode: 0o100644, id: fBase },
      { name: 'keep.txt', mode: 0o100644, id: keep },
    ]),
    [],
    'base',
  )
  const sideA = await t.commit(
    await t.putTree([
      { name: 'f.txt', mode: 0o100644, id: await put('A\n') },
      { name: 'keep.txt', mode: 0o100644, id: keep },
      { name: 'a.txt', mode: 0o100644, id: await put('a\n') },
    ]),
    [base],
    'A',
  )
  const sideB = await t.commit(
    await t.putTree([
      { name: 'f.txt', mode: 0o100644, id: fBase },
      { name: 'keep.txt', mode: 0o100644, id: keep },
      { name: 'b.txt', mode: 0o100644, id: await put('b\n') },
    ]),
    [base],
    'B',
  )

  const clean = await t.mergeTree([sideA, sideB])
  assert.ok('tree' in clean, '两边改的不是同一个文件 → 干净合并，退出码 0')
  const merged = await t.commit(clean.tree, [sideA, sideB], 'merge')
  assert.deepEqual(
    (await t.listAt(merged, '')).map((e) => e.name),
    ['a.txt', 'b.txt', 'f.txt', 'keep.txt'],
  )
  assert.equal((await t.readAt(merged, 'f.txt'))?.toString(), 'A\n')

  const sideC = await t.commit(
    await t.putTree([
      { name: 'f.txt', mode: 0o100644, id: await put('C\n') },
      { name: 'keep.txt', mode: 0o100644, id: keep },
    ]),
    [base],
    'C',
  )
  const clash = await t.mergeTree([sideA, sideC])
  assert.ok(!('tree' in clash), '冲突时不该给出 tree —— 那棵树里是带冲突标记的 blob（§ 8.2）')
  assert.equal(clash.conflicts.length, 1)
  assert.equal(clash.conflicts[0].path, 'f.txt')
  assert.deepEqual(clash.conflicts[0].stages.map((s) => s.stage), [1, 2, 3])

  await assert.rejects(() => t.mergeTree([sideA, sideB, sideC]), /只支持两个 base/)
  await assert.rejects(
    () => t.mergeTree([sideA, '0'.repeat(40) as CommitId]),
    /退出码 1|not something we can merge/,
    '不存在的提交不是"冲突"，要显式失败',
  )
  await t.close()
})

// ────────────────────────────────── 命令：它是这一步"可用"的凭据

test('CLI：fugue commit 把日志折成树、推进 ref、记下 ckpt/commit', async (ctx) => {
  const root = tmpRoot()
  const agent = 'agent/r1/1'
  const log = openLog(root, { sync: 'never' })
  ctx.after(() => log.close())
  const t = openTruth(root)
  ctx.after(() => t.close())
  const one = await t.putBlob(Buffer.from('第一版\n'))
  await log.append(agent as WriterId, {
    t: 'view/write',
    agent: agent as AgentId,
    path: 'src/a.ts',
    rev: 1,
    blob: one,
    mode: 0o100644,
  })
  await log.close()
  await t.close()

  const first = spawnSync(
    process.execPath,
    [CLI, '--root', root, '--agent', agent, '--json', 'commit', '-m', '第一次提交'],
    { encoding: 'utf8' },
  )
  assert.equal(first.status, 0, first.stderr)
  const r1 = JSON.parse(first.stdout) as { commit: string; ref: string; entries: number }
  assert.equal(r1.ref, `refs/heads/${agent}`)
  assert.equal(r1.entries, 1)

  const t2 = openTruth(root)

  ctx.after(() => t2.close())
  assert.equal((await t2.readAt(r1.commit as CommitId, 'src/a.ts'))?.toString(), '第一版\n')
  assert.equal(await t2.resolve(r1.ref as RefName), r1.commit)
  await t2.close()

  // 第二次：改一个文件、加一个文件。parent 要接上第一次的提交点。
  const log2 = openLog(root, { sync: 'never' })
  ctx.after(() => log2.close())
  const two = await t2.putBlob(Buffer.from('第二版\n'))
  const three = await t2.putBlob(Buffer.from('新增\n'))
  await log2.append(agent as WriterId, {
    t: 'view/write',
    agent: agent as AgentId,
    path: 'src/a.ts',
    rev: 2,
    blob: two,
    mode: 0o100644,
  })
  await log2.append(agent as WriterId, {
    t: 'view/write',
    agent: agent as AgentId,
    path: 'src/b.ts',
    rev: 3,
    blob: three,
    mode: 0o100644,
  })
  await log2.close()
  await t2.close()

  const second = spawnSync(
    process.execPath,
    [CLI, '--root', root, '--agent', agent, '--json', 'commit', '-m', '第二次提交'],
    { encoding: 'utf8' },
  )
  assert.equal(second.status, 0, second.stderr)
  const r2 = JSON.parse(second.stdout) as { commit: string; parents: string[]; entries: number }
  assert.deepEqual(r2.parents, [r1.commit])
  assert.equal(r2.entries, 2)
  assert.notEqual(r2.commit, r1.commit)

  const t3 = openTruth(root)

  ctx.after(() => t3.close())
  assert.equal((await t3.readAt(r2.commit as CommitId, 'src/a.ts'))?.toString(), '第二版\n')
  assert.equal((await t3.readAt(r2.commit as CommitId, 'src/b.ts'))?.toString(), '新增\n')
  await t3.close()

  const log3 = openLog(root, { sync: 'never' })

  ctx.after(() => log3.close())
  const events = []
  for await (const e of log3.readByWriter(agent as WriterId)) events.push(e)
  await log3.close()
  assert.equal(events.length, 5)
  // 顺序是：view/write rev1 · 第一次的 ckpt/commit · view/write rev2 · rev3 · 第二次的
  assert.deepEqual(events[1], {
    t: 'ckpt/commit',
    agent,
    commit: r1.commit,
    rev: 1,
    msg: '第一次提交',
  })
  assert.deepEqual(events[4], {
    t: 'ckpt/commit',
    agent,
    commit: r2.commit,
    rev: 3,
    msg: '第二次提交',
  })
  assert.equal(existsSync(join(root, '.git', 'index')), false, 'commit 也不该落索引')
})

test('CLI：commit 收的是视图的全量读出——改名过的事件不再拒绝，树里是改后的名字', async (ctx) => {
  const root = tmpRoot()
  const agent = 'agent/r1/1'
  const log = openLog(root, { sync: 'never' })
  ctx.after(() => log.close())
  const t = openTruth(root)
  ctx.after(() => t.close())
  const blob = await t.putBlob(Buffer.from('x\n'))
  await log.append(agent as WriterId, {
    t: 'view/write',
    agent: agent as AgentId,
    path: 'old.ts',
    rev: 1,
    blob,
    mode: 0o100644,
  })
  await log.append(agent as WriterId, {
    t: 'view/rename',
    agent: agent as AgentId,
    from: 'old.ts',
    to: 'new.ts',
    rev: 2,
  })
  await log.close()
  await t.close()

  // U2 时这里是"折不了就拒绝"：那时的提交只会折 `view/write` 与 `view/remove`，一条
  // `view/rename` 被忽略就会提交出一个少了改名的树。U3 的视图重放接管了这一步，所以
  // 现在它提交得出来，而且树里是改后的名字。
  const ok = spawnSync(
    process.execPath,
    [CLI, '--root', root, '--agent', agent, '--json', 'commit', '-m', '改名之后'],
    { encoding: 'utf8' },
  )
  assert.equal(ok.status, 0, ok.stderr)
  const r = JSON.parse(ok.stdout) as { commit: string; entries: number }
  assert.equal(r.entries, 1, '一条入口：改后的那个名字')
  const t2 = openTruth(root)
  ctx.after(() => t2.close())
  const head = await t2.resolve(`refs/heads/${agent}` as RefName)
  assert.equal(await t2.readAt(head, 'old.ts'), null, '旧名字不在树里')
  assert.equal((await t2.readAt(head, 'new.ts'))?.toString(), 'x\n')
  await t2.close()

  const noMsg = spawnSync(process.execPath, [CLI, '--root', root, 'commit'], { encoding: 'utf8' })
  assert.equal(noMsg.status, 2)
  assert.match(noMsg.stderr, /-m <msg>/)
})

// ────────────────────────────────── 批量往返与 gitlink

test('listAt：一个目录的 size 一次问完，往返数是 O(1) 而不是 O(条目数)', async (ctx) => {
  const root = tmpRoot()
  const w = openTruth(root)
  ctx.after(() => w.close())
  const entries: TreeEntry[] = []
  for (let i = 0; i < 200; i++) {
    const body = Buffer.from(`内容 ${i}\n`)
    entries.push({ name: `d/f${String(i).padStart(3, '0')}.txt`, mode: 0o100644, id: await w.putBlob(body) })
  }
  const c = await w.commit(await w.putTree(entries), [], '大目录')

  const t = openTruth(root)
  ctx.after(() => t.close())
  const got = await t.listAt(c, 'd')
  assert.equal(got.length, 200)
  assert.equal(got[0].size, Buffer.byteLength('内容 0\n'))
  assert.equal(got[199].size, Buffer.byteLength('内容 199\n'))
  const s = t.stats()
  assert.equal(s.gitSpawns, 1, `200 个条目只该起一个进程，实际 ${s.gitSpawns}`)
  // 4 = 提交 → 根树 → d 树（走树的三次 contents）+ 一次批量 info。**批量之前这里是 200+。**
  assert.equal(s.gitRequests, 4, `请求数应当是 4，实际 ${s.gitRequests}`)
})

test('gitlink：一个 submodule 不让整棵树读不了，也不冒充 0 字节的文件', async (ctx) => {
  const root = tmpRoot()
  const t = openTruth(root)
  ctx.after(() => t.close())
  const inner = await t.commit(
    await t.putTree([{ name: 'inner.txt', mode: 0o100644, id: await t.putBlob(Buffer.from('内层\n')) }]),
    [],
    '内层',
  )
  const outer = await t.putBlob(Buffer.from('外层\n'))
  const c = await t.commit(
    await t.putTree([
      { name: 'a.txt', mode: 0o100644, id: outer },
      { name: 'sub', mode: 0o160000, id: inner },
    ]),
    [],
    '带一个 gitlink',
  )
  assert.deepEqual(await t.statAt(c, 'sub'), { kind: 'gitlink', mode: 0o160000, size: 0, id: inner })
  assert.equal(await t.readAt(c, 'sub'), null, 'gitlink 指的是另一个仓库的一个提交，不是这个路径的字节')
  assert.equal((await t.readAt(c, 'a.txt'))?.toString(), '外层\n', '同一棵树里的普通文件照常读')
  assert.deepEqual(
    (await t.listAt(c, '')).map((e) => `${e.name}:${e.kind}:${e.size}`),
    [`a.txt:file:${Buffer.byteLength('外层\n')}`, 'sub:gitlink:0'],
  )
  assert.equal(fsck(root).status, 0)
})
