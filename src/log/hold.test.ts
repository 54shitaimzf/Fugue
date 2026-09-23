// W0 的断言：**一份日志一个写者进程**。六条，逐条对 PLAN § 5.3 的 W0 行。
//
//   ① 两路并发 `write`（同一个 agent）：恰一个进去，被拒的那一路报出持者的 pid，日志序号唯一
//      （对照：加这道栅栏之前是 `[1,1]`／`[1,2,3,3]`）
//   ② 提交与写入并发：`replay --verify` 报一致（对照：之前退 1——从快照重放把另一条整条丢掉）
//   ③ 两路并发 `ensure`：非零退出的那一路是**明确拒绝**（对照：之前是"overlay 卸不下来"），
//      而盘上仍然对
//   ④ 一路持着写锁时三条读命令（`read` · `log` · `verify-mat`）照常跑——观察不得影响状态
//   ⑤ 负对照：a1 持锁时 `--agent a2` 的写命令完全不受影响（锁按 writer 分）
//   ⑥ 持锁者被 `kill -9` 之后，下一条命令照常拿到（陈旧锁按 pid + 起始时刻 + boot 判死）
//
// **每一条的确定性形在先**：本进程自己持着锁，再敲那条命令，看它退几、说什么——这一半每一轮
// 都会红。并发那一半是加码：它的通过条件是"每一轮不变量都成立"，而它要抓的东西恰恰是随机的
// （探针跑出来的是"有时 `[1,1]` 有时 `[1,2]`"）。一条只在坏的时候才红的断言，红的那一次才是
// 它说话的时候——所以它不单独承担举证，确定性那一半才承担。
//
// 探针（取证）在 `tools/probe-concurrent.ts`：这里量的是"栅栏之后不变量成立"，那里量的是
// "没有栅栏时的现象"。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { removeTree } from '../materialize/mount.ts'
import type { AgentId, WriterId } from '../terms.ts'
import { LogHeldError, holdWriter, lockFileOf } from './hold.ts'
import { openLog } from './log.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'

const REPO = join(import.meta.dirname, '..', '..')
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')
const HOLDER = join(REPO, 'test', 'helpers', 'hold-writer.ts')

const A = (s: string): AgentId => s as AgentId
const W = (s: string): WriterId => s as WriterId

/**
 * 夹具登记：这一份跑完，先把每个 agent 的物化卸干净再删目录。
 *
 * **不能只 `rmSync`**：挂着 overlay 的 `merged` 底下摊的是真源，而内核在 `work/` 里建的
 * `work/work`（`root:root 000`）普通删除进不去（`dispose` 那条路就是为这个存在的）。
 */
const MADE: string[] = []
const AGENTS = ['round', 'a1', 'a2']

after(() => {
  for (const dir of MADE) {
    for (const a of AGENTS) {
      spawnSync(process.execPath, [CLI, '--root', dir, '--agent', a, 'dispose'], { encoding: 'utf8' })
    }
    try {
      removeTree(dir)
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', dir])
    }
  }
})

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

/** 一棵真仓库，工作树与 HEAD 逐字节一致（`fork` 的底就是它，§ 8.4）。 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-hold-'))
  MADE.push(dir)
  const put = (rel: string, body: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  put('src/a.ts', 'export const a = 1\n')
  put('src/b.ts', 'export const b = 2\n')
  symlinkSync('src/a.ts', join(dir, 'link.ts'))
  put('bin/run.sh', '#!/bin/sh\necho hi\n')
  chmodSync(join(dir, 'bin/run.sh'), 0o755)
  git(dir, ['init', '-q', '-b', 'main', '.'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

/** 给某个 agent 定一条分支头（`fugue branch` 是 W1 的事，这里先用 git 直接指）。 */
function branchRef(dir: string, agent: string): string {
  const base = git(dir, ['rev-parse', 'HEAD'])
  git(dir, ['update-ref', 'refs/heads/' + agent, base])
  return base
}

interface Run {
  code: number
  out: string
  err: string
}

function cli(root: string, args: readonly string[], stdin = ''): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: stdin,
    maxBuffer: 1 << 26,
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

function cliAsync(root: string, args: readonly string[], stdin = ''): Promise<Run> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, '--root', root, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (b: Buffer) => (out += b.toString()))
    p.stderr.on('data', (b: Buffer) => (err += b.toString()))
    p.on('close', (code) => res({ code: code ?? -1, out, err }))
    p.stdin.end(stdin)
  })
}

/** 该 writer 的日志里出现过的序号，按文件顺序。 */
function seqs(root: string, w: string): number[] {
  const f = join(root, '.fugue', 'log', w + '.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { seq: number }).seq)
}

function dups(list: readonly number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const n of list) {
    if (seen.has(n)) out.push(n)
    seen.add(n)
  }
  return out
}

/** 一个 agent 的现场：定分支头 → `fork` → 写一条自己的；`ensure` 由调用方决定什么时候落。 */
function staged(agent: string, ensure: boolean): string {
  const dir = fixture()
  const base = branchRef(dir, agent)
  const f = cli(dir, ['--agent', agent, 'fork', base])
  assert.equal(f.code, 0, `fork 没成：${f.err}`)
  const w = cli(dir, ['--agent', agent, 'write', 'src/own.ts', '--stdin'], 'own\n')
  assert.equal(w.code, 0, `写没成：${w.err}`)
  if (ensure) {
    const e = cli(dir, ['--agent', agent, 'ensure'])
    assert.equal(e.code, 0, `ensure 没成：${e.err}`)
  }
  return dir
}

interface Holder {
  readonly pid: number
  kill(): void
  readonly gone: Promise<void>
}

/** 一个只做两件事的进程：拿到该 writer 的锁，然后一直不放手。第一行 stdout 就是它的 pid。 */
function spawnHolder(root: string, w: string): Promise<Holder> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [HOLDER, root, w], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stderr.on('data', (b: Buffer) => (err += b.toString()))
    p.stdout.on('data', (b: Buffer) => {
      out += b.toString()
      const nl = out.indexOf('\n')
      if (nl === -1) return
      res({
        pid: Number(out.slice(0, nl)),
        kill: () => void p.kill('SIGKILL'),
        gone: new Promise((g) => p.on('exit', () => g())),
      })
    })
    p.on('error', rej)
    p.on('exit', (code) => {
      if (code !== 0) rej(new Error(`持锁进程退 ${code}：${err}`))
    })
  })
}

/** 记一条锁文件（判死那几条要的是"记录还在、人不在"的现场，所以直接写文件）。 */
function writeRecord(path: string, rec: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(rec) + '\n')
}

test('锁的形状：拿到 · 记录里写清了谁持的 · 同进程再拿被拒 · 放掉之后一个字节不剩', async () => {
  const dir = tmpDir('fugue-hold-')
  const path = lockFileOf(dir, W('a1'))
  const hold = holdWriter(dir, W('a1'))
  assert.equal(hold.path, path, '锁与日志同目录同名，只换后缀')
  assert.equal(hold.pid, process.pid)

  const rec = JSON.parse(readFileSync(path, 'utf8')) as {
    writer: string
    pid: number
    start: number
    boot: string
  }
  assert.equal(rec.writer, 'a1')
  assert.equal(rec.pid, process.pid)
  assert.ok(rec.start > 0, '起始时刻要真读到了 /proc/<pid>/stat')
  assert.notEqual(rec.boot, '', 'boot id 要真读到了')

  // **同一个进程里再拿一次也拒绝**：一份日志一个写者，"同一个进程两份句柄"是它的特例，不是例外。
  assert.throws(
    () => holdWriter(dir, W('a1')),
    (err: unknown) => {
      assert.ok(err instanceof LogHeldError, `抛的不是 LogHeldError：${String(err)}`)
      assert.equal(err.holder?.pid, process.pid)
      assert.match(err.message, new RegExp(`pid ${process.pid}`))
      assert.match(err.message, /已经有写者/)
      assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '文案里要有锁的位置')
      assert.match(err.message, /kill -0 /, '失败要指路：等它、或者确认它不在了再删')
      return true
    },
  )

  // 句柄那一层的当面拦：持着 a1 的锁，却往 a2 的日志里追加。
  // **换一个目录**：同一个进程里 a1 的锁已经在本进程手上了（上面那一句断言的就是它挡得住）。
  const dir2 = tmpDir('fugue-hold-')
  const log = openLog(dir2, { sync: 'never', write: W('a1') })
  await assert.rejects(
    log.append(W('a2'), { t: 'view/write', agent: A('a2'), path: 'src/x.ts', rev: 1, blob: 'b1', mode: 420 }),
    /一次命令只写一个 writer/,
  )
  await log.close()
  assert.equal(existsSync(lockFileOf(dir2, W('a1'))), false, '句柄 close() 之后锁要放掉')

  hold.release()
  hold.release() // 幂等：放过的再放一次不算错
  assert.equal(existsSync(path), false)
  const again = holdWriter(dir, W('a1'))
  again.release()
})

test('陈旧判死看三样：pid 不在了 · pid 被复用 · 跨了一次启动 —— 而活着的持者仍然挡着', () => {
  const dir = tmpDir('fugue-hold-')
  const path = lockFileOf(dir, W('a1'))

  // 先拿一次，把"一条真记录"长什么样取下来（这三条判死各改其中一个字段）。
  const seed = holdWriter(dir, W('a1'))
  const real = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  seed.release()

  // ① 持者进程不在了（`kill -9` 之后 `unlink` 不会发生，锁文件就停在这个样子）
  writeRecord(path, { ...real, pid: 999999999 })
  holdWriter(dir, W('a1')).release()

  // ② pid 被复用了：这个号是活的（就是本进程），但起始时刻对不上
  writeRecord(path, { ...real, pid: process.pid, start: Number(real.start) + 1 })
  holdWriter(dir, W('a1')).release()

  // ③ 跨了一次启动：boot id 不一样，记录里的 pid 属于上一次
  writeRecord(path, { ...real, boot: '00000000-0000-0000-0000-000000000000' })
  holdWriter(dir, W('a1')).release()

  // 负对照：三样都对得上（pid 是本进程、起始时刻是真的、boot 是这一次）——必须挡住。
  writeRecord(path, real)
  assert.throws(
    () => holdWriter(dir, W('a1')),
    (err: unknown) => {
      assert.ok(err instanceof LogHeldError)
      assert.equal(err.holder?.pid, process.pid, '报出来的持者要正是记录里那一个')
      assert.match(err.why, /还活着/)
      return true
    },
  )
  rmSync(path)
  holdWriter(dir, W('a1')).release()
})

test('锁文件读不动时：拒绝，并把"确认之后删掉它"这条路给出来', () => {
  const dir = tmpDir('fugue-hold-')
  const path = lockFileOf(dir, W('a1'))

  for (const bad of ['这不是 JSON\n', '{"v":1}\n', '']) {
    writeRecord(path, {})
    writeFileSync(path, bad)
    assert.throws(
      () => holdWriter(dir, W('a1')),
      (err: unknown) => {
        assert.ok(err instanceof LogHeldError, `抛的不是 LogHeldError：${String(err)}`)
        assert.equal(err.holder, null, '读不出来就说读不出来，不编一个持者')
        assert.match(err.message, /读不出来/)
        assert.match(err.message, /删掉那个锁文件/, '失败要指路')
        return true
      },
      `坏记录 ${JSON.stringify(bad)} 必须拒绝`,
    )
  }

  // 人按指路删掉之后就照常——这道拒绝不是死结。
  rmSync(path)
  holdWriter(dir, W('a1')).release()
})

test('取锁顺手建出来的那两层空目录，放锁时还回去；里面有东西就不动它', () => {
  const dir = tmpDir('fugue-hold-')
  const log2 = join(dir, '.fugue', 'log')
  const hold = holdWriter(dir, W('a1'))
  assert.equal(existsSync(log2), true, '锁住在 log/ 底下，取锁这一步会把它建出来')
  hold.release()
  assert.equal(existsSync(join(dir, '.fugue')), false, '自己建的空目录要还回去')

  // 负对照：那一层里有东西（别人的日志）时不许动它。
  mkdirSync(log2, { recursive: true })
  writeFileSync(join(log2, 'a2.jsonl'), '')
  const again = holdWriter(dir, W('a1'))
  again.release()
  assert.equal(existsSync(log2), true, '非空就不是我该收的')
  assert.equal(existsSync(join(log2, 'a2.jsonl')), true, '别人的日志一个字没动')
})

test('断言①：两路并发写同一个 agent —— 恰一个进去，另一个报出持者的 pid，序号唯一', async () => {
  const dir = fixture()
  branchRef(dir, 'a1')

  // 确定性那一半：本进程持着锁。
  const hold = holdWriter(dir, W('a1'))
  try {
    const denied = cli(dir, ['--agent', 'a1', 'write', 'x.ts', '--stdin'], 'x\n')
    assert.equal(denied.code, 1, `该拒的没拒：${denied.out}${denied.err}`)
    assert.match(denied.err, /已经有写者/)
    assert.match(denied.err, new RegExp(`pid ${process.pid}`), '被拒的那一路要报出持者是谁')
    assert.deepEqual(seqs(dir, 'a1'), [], '被拒的命令不在盘上留东西')
  } finally {
    hold.release()
  }

  // 并发那一半：五轮。**每一轮的不变量是"序号唯一"**——探针里它有时是 `[1,1]`。
  for (let i = 1; i <= 5; i++) {
    const [r1, r2] = await Promise.all([
      cliAsync(dir, ['--agent', 'a1', 'write', `p${i}.ts`, '--stdin'], 'p\n'),
      cliAsync(dir, ['--agent', 'a1', 'write', `q${i}.ts`, '--stdin'], 'q\n'),
    ])
    const s = seqs(dir, 'a1')
    assert.deepEqual(dups(s), [], `第 ${i} 轮序号重复：${JSON.stringify(s)}`)
    assert.ok(r1.code === 0 || r2.code === 0, `第 ${i} 轮两个都没成：${r1.err} | ${r2.err}`)
    for (const r of [r1, r2]) {
      if (r.code !== 0) assert.match(r.err, /已经有写者/, `第 ${i} 轮失败的那一路：${r.err}`)
    }
    const v = cli(dir, ['--agent', 'a1', 'replay', '--verify'])
    assert.equal(v.code, 0, `第 ${i} 轮重放不一致：${v.out}${v.err}`)
  }
})

test('断言②：提交与写入并发 —— 序号唯一，两条重建路径读出来的视图一致', async () => {
  const dir = fixture()
  branchRef(dir, 'a1')
  const seed = cli(dir, ['--agent', 'a1', 'write', 'seed.ts', '--stdin'], 'seed\n')
  assert.equal(seed.code, 0, seed.err)

  for (let i = 1; i <= 3; i++) {
    const [c, w] = await Promise.all([
      cliAsync(dir, ['--agent', 'a1', 'commit', '-m', `第 ${i} 次提交`]),
      cliAsync(dir, ['--agent', 'a1', 'write', `x${i}.ts`, '--stdin'], 'x\n'),
    ])
    const s = seqs(dir, 'a1')
    assert.deepEqual(dups(s), [], `第 ${i} 轮序号重复：${JSON.stringify(s)}`)
    assert.ok(c.code === 0 || w.code === 0, `第 ${i} 轮两个都没成：${c.err} | ${w.err}`)
    for (const r of [c, w]) {
      if (r.code !== 0) assert.match(r.err, /已经有写者/, `第 ${i} 轮失败的那一路：${r.err}`)
    }
    // **这一条正是今天会红的那个**：提交把快照的戳写成自己的序号，另一个进程那条事件的序号
    // 比它小，从快照重放就把那条整条丢掉——`replay --verify` 的两条路于是对不上。
    const v = cli(dir, ['--agent', 'a1', 'replay', '--verify'])
    assert.equal(v.code, 0, `第 ${i} 轮重放不一致：${v.out}${v.err}`)
  }
})

test('断言③：两路并发 ensure —— 被拒的那一路说"已经有写者"，不是"overlay 卸不下来"', async () => {
  const dir = staged('a1', false)

  // 确定性那一半：本进程持着锁。**文案必须是拒绝，不是那次假失败。**
  const hold = holdWriter(dir, W('a1'))
  try {
    const denied = cli(dir, ['--agent', 'a1', 'ensure'])
    assert.equal(denied.code, 1, `该拒的没拒：${denied.out}${denied.err}`)
    assert.match(denied.err, /已经有写者/)
    assert.doesNotMatch(denied.err, /卸不下来|not mounted/, '不许再报成"卸不下来"')
  } finally {
    hold.release()
  }

  // 并发那一半：两路同时落。非零退出的那一路必须是"被挡"，不是别的什么。
  const [r1, r2] = await Promise.all([
    cliAsync(dir, ['--agent', 'a1', 'ensure']),
    cliAsync(dir, ['--agent', 'a1', 'ensure']),
  ])
  for (const r of [r1, r2]) {
    if (r.code === 0) continue
    assert.match(r.err, /已经有写者/, `被拒的那一路要说清是被谁挡的：${r.err}`)
    assert.doesNotMatch(r.err, /卸不下来|not mounted/, r.err)
  }
  assert.ok(r1.code === 0 || r2.code === 0, `两路都没成：${r1.err} | ${r2.err}`)

  // 盘上仍然对：清单 == 差异集 == 落地根（§ 8.5 的第二条验证性质）。
  const m = cli(dir, ['--agent', 'a1', 'verify-mat'])
  assert.equal(m.code, 0, `verify-mat：${m.out}${m.err}`)
  assert.equal(
    readFileSync(join(dir, '.fugue', 'mat', 'a1', 'merged', 'src', 'own.ts'), 'utf8'),
    'own\n',
    '自己写的那一条要落在合并树里',
  )
})

test('断言④：一路持着写锁时，三条读命令照常跑（观察不得影响状态）', () => {
  const dir = staged('a1', true)
  const hold = holdWriter(dir, W('a1'))
  try {
    const rd = cli(dir, ['--agent', 'a1', 'read', 'src/own.ts'])
    assert.equal(rd.code, 0, `read 被锁挡住了：${rd.err}`)
    assert.equal(rd.out, 'own\n')

    const lg = cli(dir, ['--agent', 'a1', 'log'])
    assert.equal(lg.code, 0, `log 被锁挡住了：${lg.err}`)
    assert.ok(lg.out.trim().split('\n').length >= 2, `log 要有那几条事件：${lg.out}`)

    const vm = cli(dir, ['--agent', 'a1', 'verify-mat'])
    assert.equal(vm.code, 0, `verify-mat 被锁挡住了：${vm.out}${vm.err}`)
  } finally {
    hold.release()
  }
})

test('断言⑤：a1 持锁时 a2 的写命令完全不受影响（锁按 writer 分，D11 没动）', () => {
  const dir = fixture()
  branchRef(dir, 'a1')
  branchRef(dir, 'a2')
  const hold = holdWriter(dir, W('a1'))
  try {
    const r = cli(dir, ['--agent', 'a2', 'write', 'only-a2.ts', '--stdin'], 'a2\n')
    assert.equal(r.code, 0, `a2 被 a1 的锁挡住了：${r.err}`)
    assert.deepEqual(seqs(dir, 'a1'), [], 'a1 那一份日志一个字没动')
    assert.deepEqual(seqs(dir, 'a2'), [1])
    assert.equal(cli(dir, ['--agent', 'a2', 'read', 'only-a2.ts']).out, 'a2\n')
  } finally {
    hold.release()
  }
})

test('断言⑥：持锁者被 kill -9 之后，下一条命令照常拿到（锁文件还在，人不在）', async (t) => {
  const dir = fixture()
  branchRef(dir, 'a1')
  const path = lockFileOf(dir, W('a1'))

  const holder = await spawnHolder(dir, 'a1')
  // **收尾挂在测试生命周期上，不挂在最后一行**：中间哪一条断言红了，这个一直不放手的小进程
  // 就没人杀——它活着，测试进程的事件循环就不退出，一次失败于是表现成「整套挂住」而不是「这条红了」。
  t.after(() => holder.kill())
  assert.equal(existsSync(path), true, '子进程拿到之后锁文件要在')

  const blocked = cli(dir, ['--agent', 'a1', 'write', 'blocked.ts', '--stdin'], 'b\n')
  assert.equal(blocked.code, 1)
  assert.match(blocked.err, new RegExp(`pid ${holder.pid}`), '被拒的那一路要报出**另一个进程**的 pid')

  holder.kill()
  await holder.gone
  assert.equal(existsSync(path), true, 'kill -9 不清理任何东西——锁文件留在原地')

  const after = cli(dir, ['--agent', 'a1', 'write', 'after.ts', '--stdin'], 'a\n')
  assert.equal(after.code, 0, `陈旧锁没被拿回来：${after.err}`)
  assert.deepEqual(seqs(dir, 'a1'), [1])
  assert.equal(existsSync(path), false, '命令结束就放掉了')
})
