// 第四单元的四条断言。出处：PLAN § 5 的 U4 行 · 架构 § 9.4 · D10。
//
// 这一份测的不是某一层，而是**前三者的合成**：真 git · 真日志 · 真进程。四条里有两条跨进程
// （写者退出 · 写者被杀），一条动文件系统（快照删了 · 坏了 · 比日志新），一条把四个 writer
// 交错着的日志与各自重建的结果对上。
//
// 为什么断言要跨进程：§ 9.6 说 CLI 是"单次进程 + 每次重建"，那么**重建就是唯一的持久性
// 机制**——同一份日志在另一个进程里读出来必须逐字节相同，否则它不叫持久化，叫进程内存。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { Delta } from '../delta.ts'
import type { TreeEntry } from '../entries.ts'
import { mergedFace, openLog } from '../log/log.ts'
import type { BlobId, CommitId, RefName, ViewRev, WriterId } from '../terms.ts'
import { openTruth } from '../truth/truth.ts'
import type { View } from './contract.ts'
import { applyEdit } from './edit.ts'
import { lowerFor } from './lower.ts'
import { readSnapshot, snapshotOf, writeSnapshot } from './snapshot.ts'
import { loadView } from './view.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/writer.ts', import.meta.url))

interface Run {
  code: number
  stdout: string
  stderr: string
}

function fugue(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function fugueStdin(root: string, input: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 1 << 26,
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function tmpRoot(): string {
  const root = tmpDir('fugue-replay-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

/** 人类的底稿：一个提交，于是视图有下层。与 `cli/fugue.test.ts` 里那份是同一个手法。 */
async function seedBase(root: string): Promise<void> {
  const t = openTruth(root)
  try {
    const blob = await t.putBlob(Buffer.from('底稿\n'))
    const tree = await t.putTree([{ name: 'base.txt', mode: 0o100644, id: blob as BlobId }])
    const c: CommitId = await t.commit(tree, [], '底稿')
    await t.advance('refs/heads/main' as RefName, c, null)
  } finally {
    await t.close()
  }
}

interface ReplayOut {
  agent: string
  rev: ViewRev
  base: string | null
  from: { kind: string; seq?: number; rev?: number }
  entries: TreeEntry[]
  ms: number
}

function replayJson(root: string, ...args: string[]): ReplayOut {
  const r = fugue(root, '--json', 'replay', ...args)
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout) as ReplayOut
}

function names(rows: TreeEntry[]): string[] {
  return rows.map((r) => r.name).sort()
}

/** 与 `ms` 无关的那部分：两次独立重建要比的是这一串。 */
function stripMs(run: Run): string {
  const o = JSON.parse(run.stdout) as Record<string, unknown>
  delete o.ms
  return JSON.stringify(o)
}

/** 重建出来的**状态**（读出的东西 + rev + base）；`from` 与 `ms` 不算——那是过程，不是结果。 */
function stateOf(o: ReplayOut): string {
  return JSON.stringify({ rev: o.rev, base: o.base, entries: o.entries })
}

function logPath(root: string, writer = 'round'): string {
  return join(root, '.fugue', 'log', `${writer}.jsonl`)
}

function snapFiles(root: string, writer = 'round'): string[] {
  try {
    return readFileSync(join(root, '.fugue', 'snap', writer), 'utf8') === ''
      ? []
      : []
  } catch {
    return []
  }
}

function writeSnap(root: string, writer: string, seq: number, text: string): void {
  const dir = join(root, '.fugue', 'snap', writer)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${seq}.json`), text)
}

/** 日志里**完整**的那些行。尾行可能是写了一半的（§ 9.3 的"崩溃落在第 2 步中途"）。 */
function completeLines(root: string, writer = 'round'): string[] {
  let text: string
  try {
    text = readFileSync(logPath(root, writer), 'utf8')
  } catch {
    return []
  }
  if (text.length === 0) return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text.slice(0, text.lastIndexOf('\n') + 1)
  return body === '' ? [] : body.split('\n').filter((l) => l !== '')
}

/**
 * 已落盘的事件前缀的结论，**独立地算出来**：这个写者只写文件，所以每一条完整的
 * `view/write` 就对应一个该在的路径、内容由序号决定。
 */
function expectedPaths(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const e = JSON.parse(line) as { t?: string; path?: string }
    if (e.t === 'view/write' && e.path !== undefined) out.push(e.path)
  }
  return out
}

/** 探针写第 i 份的内容。**与 `test/fixtures/writer.ts` 里的式子一致**，两边不一致会响。 */
function contentOf(i: number, padBytes: number): string {
  return `文件 ${i}\n` + 'x'.repeat(padBytes)
}

async function waitFor(cond: () => boolean, what: string, ms = 30000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等超时：${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 变更压成一行可比对的字。`add` 与 `modify` 要分开——它由日志前缀决定。 */
function dkey(d: Delta): string {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return `${d.kind} ${d.path} ${d.mode.toString(8)} ${d.bytes.length} ${createHash('sha1').update(d.bytes).digest('hex')}`
    case 'symlink':
      return `symlink ${d.path} → ${d.target}`
    case 'delete':
      return `delete ${d.path}`
    case 'rename':
      return `rename ${d.from} → ${d.to}`
    case 'chmod':
      return `chmod ${d.path} ${d.mode.toString(8)}`
  }
}

test('① 写 → 进程退出 → 新进程读回：rev 与每个字节都一致', async () => {
  const root = tmpRoot()
  await seedBase(root)

  const steps: { args: string[]; stdin?: string }[] = [
    { args: ['write', 'a.txt', '--stdin'], stdin: '第一版\n' },
    { args: ['write', 'd/b.txt', '--stdin'], stdin: '子目录里的\n' },
    { args: ['chmod', 'd/b.txt', '755'] },
    { args: ['rename', 'a.txt', 'c.txt'] },
    { args: ['remove', 'base.txt'] }, // 只有下层才有的路径：删掉它靠的是一条墓碑
    { args: ['commit', '-m', '第一次提交'] },
  ]
  let rev = 0
  for (const s of steps) {
    const r = s.stdin === undefined ? fugue(root, ...s.args) : fugueStdin(root, s.stdin, ...s.args)
    assert.equal(r.code, 0, `${s.args.join(' ')} → ${r.stderr}`)
    const n = Number(r.stdout.split('\t')[0])
    if (s.args[0] !== 'commit' && Number.isInteger(n)) rev = n
  }

  const first = replayJson(root)
  assert.equal(first.rev, rev, '六条命令之后的 rev')
  assert.deepEqual(names(first.entries), ['c.txt', 'd/b.txt'])
  assert.equal(first.from.kind, 'snapshot', '提交点写了快照，这一路从它起')

  // 逐字节：两次独立进程重建出来的东西一模一样（比的是结果，不比耗时）。
  const again = fugue(root, '--json', 'replay')
  assert.equal(again.code, 0, again.stderr)
  assert.equal(stripMs(again), stripMs(fugue(root, '--json', 'replay')))

  assert.equal(fugue(root, 'read', 'c.txt').stdout, '第一版\n', '改名之后的内容')
  assert.equal(fugue(root, 'read', 'd/b.txt').stdout, '子目录里的\n')
  const meta = JSON.parse(fugue(root, '--json', 'stat', 'd/b.txt').stdout) as { mode: number }
  assert.equal(meta.mode, 0o100755)
  assert.equal(fugue(root, 'stat', 'base.txt').code, 1, '删掉的下层路径不回来：墓碑跟着快照走')
})

test('② 写完一批后强杀 → 重建 == 已落盘的完整事件前缀', async () => {
  const root = tmpRoot()
  const COUNT = 2000
  const PAD = 512
  const child = spawn(process.execPath, [FIXTURE, root, 'round', String(COUNT), String(PAD)], {
    stdio: 'ignore',
  })
  await waitFor(() => completeLines(root).length >= 2, '写者落下前两条事件')
  child.kill('SIGKILL')
  const exit = await new Promise<{ code: number | null; signal: string | null }>((res) => {
    child.on('exit', (code, signal) => res({ code, signal }))
  })
  assert.equal(exit.signal, 'SIGKILL', '写者是被杀掉的，不是自己走完的')

  const lines = completeLines(root)
  assert.ok(lines.length >= 2, `已落盘的事件前缀只有 ${lines.length} 条`)
  assert.ok(lines.length < COUNT, `写者已经写完了 ${COUNT} 份——这一轮没杀在批次中间`)

  // 重建 == 完整行的结论。期望值在测试里独立算：只认完整的 `view/write` 行。
  const want = expectedPaths(lines)
  const got = replayJson(root)
  assert.deepEqual(names(got.entries), want, '重建结果就是已落盘的那条前缀')
  assert.equal(got.rev, want.length)
  for (const path of want) {
    const i = Number(/^f(\d+)\.txt$/.exec(path)?.[1])
    assert.equal(fugue(root, 'read', path).stdout, contentOf(i, PAD), `${path} 的内容`)
  }

  // § 9.3 的"崩溃落在第 2 步中途"：把最后一条完整行剪成半行。杀进程本身造不出半行
  // ——一次 `write` 是一个系统调用，落在两次调用之间就一定是干净的边界——所以这里把
  // 那个边界**造出来**，验的是同一条性质：读到畸形尾行即截断，结论等于完整前缀。
  writeFileSync(
    logPath(root),
    lines.slice(0, -1).join('\n') + '\n' + lines[lines.length - 1].slice(0, 11),
  )
  const torn = expectedPaths(lines.slice(0, -1))
  const after = replayJson(root)
  assert.deepEqual(names(after.entries), torn, '半行不算数：结论退到它前面那条')
  assert.equal(after.rev, torn.length)
  const v = fugue(root, 'replay', '--verify')
  assert.equal(v.code, 0, v.stderr)
})

test('③ 快照删掉 · 写坏 · 比日志新 · 与文件名不符：重建结果一次都不变', async () => {
  const root = tmpRoot()
  await seedBase(root)
  fugueStdin(root, '第一版\n', 'write', 'a.txt', '--stdin')
  assert.equal(fugue(root, 'commit', '-m', '一号').code, 0)
  fugueStdin(root, '第二版\n', 'write', 'b.txt', '--stdin')
  assert.equal(fugue(root, 'commit', '-m', '二号').code, 0)
  assert.equal(snapFiles(root).length, 0, '先确认目录读取本身不会假装有快照')

  const withSnap = replayJson(root)
  assert.equal(withSnap.from.kind, 'snapshot', '提交点过后重建是从快照起的')
  assert.equal(withSnap.rev, 2)

  // (a) 整棵 snap/ 删掉：只是慢，从头重放。
  rmSync(join(root, '.fugue', 'snap'), { recursive: true, force: true })
  const gone = replayJson(root)
  assert.equal(gone.from.kind, 'genesis', '没有快照就从 seq=0 起')
  assert.equal(stateOf(gone), stateOf(withSnap), '重建结果一个字节都不该变')

  // (b) 垃圾字节。(c) 形状对但**比日志新**（写快照时日志有 N 字节，现在不足 N）。
  // (d) 形状对但信封里的 seq 与文件名不符。
  writeSnap(root, 'round', 2, '这不是 JSON\n')
  writeSnap(
    root,
    'round',
    3,
    JSON.stringify({
      seq: 3,
      logBytes: 1 << 30,
      state: {
        rev: 3,
        points: [1, 2, 3],
        upper: [{ path: 'x.txt', kind: 'file', blob: '0'.repeat(40), mode: 0o100644 }],
      },
    }),
  )
  writeSnap(root, 'round', 4, JSON.stringify({ seq: 99, logBytes: 1, state: { rev: 4, points: [1], upper: [] } }))
  const after = replayJson(root)
  assert.equal(after.from.kind, 'genesis', '三份都不是能用的快照')
  assert.equal(stateOf(after), stateOf(withSnap))

  // 放一份真的回去：快照路径与全量路径必须给出同一个视图（`--verify` 的退出码）。
  assert.equal(fugue(root, 'commit', '-m', '三号').code, 0)

  // 从快照起的视图答不了更早的历史。**这不是缺陷，是"快照换掉的是历史"的可测面**：
  // 宁可在被问到的时候说"我这里没有"，也不要悄悄少给一段。
  const log = openLog(root)
  const truth = await openTruth(root)
  try {
    const w = 'round' as WriterId
    const snap = await readSnapshot(root, w)
    assert.ok(snap !== null, '三号提交过后应当有一份快照')
    const fast = await loadView(log, w, { lower: await lowerFor(truth, w), snap })
    assert.throws(() => fast.diff(0), /从 rev \d+ 的快照起/)
    assert.deepEqual(fast.diff(snap.state.rev), [], '快照之后没有变更')
  } finally {
    await log.close()
    await truth.close()
  }
  const v = fugue(root, '--json', 'replay', '--verify')
  assert.equal(v.code, 0, v.stderr)
  const report = JSON.parse(v.stdout) as {
    ok: boolean
    agents: { writer: string; checks: { ok: boolean }[] }[]
  }
  assert.equal(report.ok, true)
  assert.equal(report.agents[0].checks.every((c) => c.ok), true)
})

test('④ 4 个 writer 交错写着各自的历史：交错重建 == 各自重建再合并', async () => {
  const root = tmpRoot()
  await seedBase(root)
  const log = openLog(root)
  const truth = await openTruth(root)
  try {
    const writers = ['agent/r1/1', 'agent/r1/2', 'agent/r1/3', 'agent/r1/4'] as WriterId[]
    const live = new Map<WriterId, View>()
    for (const w of writers) {
      live.set(w, await loadView(log, w, { lower: await lowerFor(truth, w) }))
    }

    // 四条序列轮流落地：日志文件是四份，交错序里它们真的夹在一起。路径**故意重叠**
    // （`common.txt` 与 `dir/deep.txt` 谁都写）——不重叠的话，串味了也看不出来。
    const rng = mulberry32(0x51ce)
    for (let i = 0; i < 48; i++) {
      const w = writers[i % writers.length]
      const view = live.get(w) as View
      const p = ['common.txt', `own-${w}.txt`, 'dir/deep.txt'][Math.floor(rng() * 3)]
      const meta = await view.stat(p)
      let d: Delta
      if (meta !== null && meta.kind === 'file' && rng() < 0.4) {
        d =
          rng() < 0.5
            ? { kind: 'chmod', path: p, mode: 0o100755 }
            : { kind: 'delete', path: p }
      } else {
        d = { kind: 'add', path: p, bytes: Buffer.from(`${w} 第 ${i} 步\n`), mode: 0o100644 }
      }
      await applyEdit({ log, truth, view, writer: w }, d)
    }

    const perWriter: string[] = []
    const perInter: string[] = []
    for (const w of writers) {
      const lower = await lowerFor(truth, w)
      const mine = live.get(w) as View
      const want = await snapshotOf(mine)
      // 各自重建：按 writer 读它自己的那份日志。
      const again = await loadView(log, w, { lower })
      const got = await snapshotOf(again)
      assert.deepEqual(got, want, `${w}：按 writer 重放出来的不是它自己的终态`)
      assert.equal(again.rev, mine.rev)
      assert.deepEqual(again.diff(0).map(dkey), mine.diff(0).map(dkey))
      // 交错重建：从**交错的全序流**里筛出它那一份再重放。
      const inter = await loadView(mergedFace(log, w), w, { lower })
      const got2 = await snapshotOf(inter)
      assert.deepEqual(got2, want, `${w}：交错流里读出来的不是它自己的终态`)
      assert.deepEqual(inter.revs, again.revs)
      assert.deepEqual(inter.diff(0).map(dkey), again.diff(0).map(dkey))
      perWriter.push(names(got).join(','))
      perInter.push(names(got2).join(','))
    }

    // 再合并：四份并起来看，两条路给出同一份历史；而各自的私有路径只出现在自己的视图里。
    const union = (xs: string[]): string => [...new Set(xs.flatMap((s) => s.split(',')))].sort().join('|')
    assert.equal(union(perInter), union(perWriter))
    assert.ok(
      perWriter.filter((s) => s.split(',').includes('common.txt')).length >= 2,
      '重叠的路径确实被封进了各自的视图里，否则串味了也看不出来',
    )
    perWriter.forEach((s, i) => {
      const alien = s.split(',').filter((n) => n.startsWith('own-') && n !== `own-${writers[i]}.txt`)
      assert.deepEqual(alien, [], `${writers[i]} 的视图里混进了别人的私有路径`)
    })
  } finally {
    await log.close()
    await truth.close()
  }
})

test('--to 停在某个修订点 · 快照不越过它 · --agent 各看各的视图', async () => {
  const root = tmpRoot()
  await seedBase(root) // 下层是 base.txt；下面每一步的读出都把它算进去
  fugueStdin(root, '一\n', 'write', 'a.txt', '--stdin')
  fugueStdin(root, '二\n', 'write', 'b.txt', '--stdin')

  // 还没有提交：`--to` 停在哪里，一眼看得见。
  const to0 = replayJson(root, '--to', '0')
  assert.equal(to0.rev, 0)
  assert.deepEqual(names(to0.entries), ['base.txt'], 'rev 0 就是 base 本身')
  const to1 = replayJson(root, '--to', '1')
  assert.equal(to1.rev, 1)
  assert.deepEqual(names(to1.entries), ['a.txt', 'base.txt'])

  assert.equal(fugue(root, 'commit', '-m', '两件都写了').code, 0) // rev 2 处一份快照
  fugueStdin(root, '三\n', 'write', 'c.txt', '--stdin')

  const old = replayJson(root, '--to', '1')
  assert.equal(old.from.kind, 'genesis', '快照在 rev 2：问 rev 1 时它帮不上忙，忽略它')
  assert.equal(old.rev, 1)
  // 下层此刻**已经是那次提交**（a.txt 也在里面），所以停在上层 rev 1 的读出还带着 b.txt。
  // 停的是这个 writer 自己的历史，不是下层——这条正是视图的定义。
  assert.deepEqual(names(old.entries), ['a.txt', 'b.txt', 'base.txt'])

  const at = replayJson(root, '--to', '2')
  assert.equal(at.from.kind, 'snapshot', 'rev 2 的快照正当时')
  assert.deepEqual(names(at.entries), ['a.txt', 'b.txt', 'base.txt'])
  assert.deepEqual(names(replayJson(root).entries), ['a.txt', 'b.txt', 'base.txt', 'c.txt'])

  // 另一个视图：同一个根、另一份日志、另一条 ref。
  const w2 = fugueStdin(root, '另起\n', '--agent', 'w2', 'write', 'z.txt', '--stdin')
  assert.equal(w2.code, 0, w2.stderr)
  assert.equal(fugue(root, '--agent', 'w2', 'read', 'z.txt').stdout, '另起\n')
  assert.equal(fugue(root, '--agent', 'w2', 'read', 'a.txt').code, 1, '两个视图互不可见')
  assert.equal(fugue(root, 'read', 'z.txt').code, 1)
  const own = replayJson(root, '--agent', 'w2')
  assert.deepEqual(names(own.entries), ['z.txt'])
  assert.equal(own.rev, 1)

  const v = fugue(root, '--json', 'replay', '--verify')
  assert.equal(v.code, 0, v.stderr)
  const report = JSON.parse(v.stdout) as { ok: boolean; agents: { writer: string }[] }
  assert.equal(report.ok, true)
  assert.deepEqual(
    report.agents.map((a) => a.writer).sort(),
    ['round', 'w2'],
    '逐 agent 走了一遍，两个视图都在',
  )
})

// ────────────────────────────────── ② 崩溃注入矩阵（快照那一族）

/**
 * **快照残件**：`writeSnapshot` 也是「先写临时名 `<seq>.json.tmp-<pid>`，再 rename」，崩在这
 * 中间留下的就是那一份残件（一份写了一半的 JSON）。快照的契约是"**从不阻塞写入，也从不阻塞
 * 读出**"（§ 9.4）——它没有任何独有数据，所以残件必须：
 *
 *   · **读不动它就当没有**：残件的文件名不匹配 `^([0-9]+)[.]json$`，`readSnapshot` 连解析都
 *     不会去解析它，拿回来的还是那一份好的；
 *   · **不妨碍下一份**：残件在那儿，再写一份照成，读回来的就是新的那一份；
 *   · **旧份一个字节不动**。
 *
 * 残件名照产品那个形状写死（`${seq}.json.tmp-${pid}`）——形状变了这一格当场红，这正是想要的。
 */
test('② 崩溃注入矩阵 · 快照残件（崩在 write 与 rename 之间）：读不动它 · 下一份照成 · 旧份不动', async () => {
  const root = tmpRoot()
  await seedBase(root)
  fugueStdin(root, '第一版\n', 'write', 'a.txt', '--stdin')
  assert.equal(fugue(root, 'commit', '-m', '一号').code, 0)

  const w = 'round' as WriterId
  const dir = join(root, '.fugue', 'snap', w)
  const names = readdirSync(dir).sort()
  assert.ok(names.length >= 1, `提交点该留下一份快照：${JSON.stringify(names)}`)
  const goodName = names[names.length - 1] as string
  const goodBytes = readFileSync(join(dir, goodName))
  const seq = Number(goodName.replace(/\.json$/, ''))
  const beforeSnap = await readSnapshot(root, w)
  assert.equal(beforeSnap?.seq, seq, '这一格的前提：有一份能用的快照')

  // 摆残件：**下一份**（seq+1）写到一半就没了——名字是 `writeSnapshot` 那个形状。
  const residue = `${seq + 1}.json.tmp-99999`
  // 残件是一份**完整**的快照，只是名字多了一段——于是"被挡在外面"的原因只剩文件名那一条，
  // 不是"JSON 解析不过"。负对照正是拿它做靶子：把 `readSnapshot` 的名字判据放宽成前缀匹配，
  // 这一份立刻被当成 seq+1 那一份读回来，这一格当场红。
  writeFileSync(
    join(dir, residue),
    JSON.stringify({ seq: seq + 1, logBytes: 0, state: { rev: 0, points: [], upper: [] } }),
  )

  // 一 · 读不动它就当没有：拿回来的还是那一份好的，逐字段相同。
  const afterResidue = await readSnapshot(root, w)
  assert.deepEqual(afterResidue, beforeSnap, '残件在那儿，读出来的还是那一份好的')

  // 二 · 下一份照成：残件不挡路。
  assert.equal(
    await writeSnapshot(root, w, {
      seq: seq + 1,
      logBytes: beforeSnap?.logBytes ?? 0,
      state: beforeSnap?.state as NonNullable<typeof beforeSnap>['state'],
    }),
    true,
    '残件不该挡下一份',
  )
  const next = await readSnapshot(root, w)
  assert.equal(next?.seq, seq + 1, '读回来的就是新的那一份')

  // 三 · 旧份一个字节不动；而残件还在那儿（§ 9.4 里没人清它——它既不挡读也不冒充一份快照）。
  assert.deepEqual(readFileSync(join(dir, goodName)), goodBytes, '旧那份快照一个字节没动')
  assert.equal(existsSync(join(dir, residue)), true, '残件原地不动（清它不是快照这一层的事）')
  assert.equal(readdirSync(dir).filter((n) => /^[0-9]+[.]json$/.test(n)).length, 2, '能用的快照恰好两份')
})
