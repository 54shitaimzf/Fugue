// V1 · `diff-stat`：全树 `(mtime, size, hash)` 快照，与两次快照之间的差异。
// 出处：PLAN § 5.2 的 V1 行 · 架构 § 9.6 的物化行 · § 9.8 的 `fugue diff-stat` ·
// § 8.5 的第一条验证性质（"改 3 个文件后，全树快照必须恰好 3 条变化"）。
//
// 三条断言，各对着一条会失效的机制：
//
//   ① 静置的树两次快照逐字节全等 ← 尺子自己不带时间；带了，"变了几条"就永远说不清
//   ② 改 3 个文件 → 恰好 3 条，且正是那 3 条 ← § 8.5 的第一条验证性质
//   ③ 只 touch 一个文件 → 1 条，且分得出"mtime 变了、内容没变" ← 承重性质那一栏的仪器
//
// 负对照：③ 报的列**恰好**是 `mtime`（多一列就说明尺子在猜）；⑦ 里基线读不出来时命令拒绝
// （退出 1），而不是报"0 条变化"——尺子最坏的一种错法，是把"量不了"说成"没变"；同一处，
// 基线落在被扫的树里也拒绝，并且拒绝之后盘上不留那份快照。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { waitUntil } from '../../test/helpers/wait.ts'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { TreeStatError, WORKSPACE_STATE, diffStat, loadTreeStat, scanTree, statOrNull, storeTreeStat } from './diffstat.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))

/** 造一棵小树，返回它的根。建的时候**按字面顺序**——刻意与路径序不同。 */
function tree(files: Record<string, string>): string {
  const root = tmpDir('fugue-diffstat-')
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

/** 与 `roots.test.ts` 同一套：子进程跑命令行，`cwd` 设在临时工作区里（相对路径就落在这里）。 */
function fugue(root: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    cwd: root,
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

test('① 静置：两次快照逐字节全等；叶子按路径排序；目录本身不进快照', async () => {
  // 建的顺序是 z · m · a：快照里排的是路径，不是 `readdir` 的返回顺序
  const root = tree({ 'z.txt': 'z', 'm.txt': 'm', 'a.txt': 'hello', 'src/deep/b.txt': 'b' })
  const one = scanTree(root)
  // **等到稳定**（U17）：静置的树本来就两次相同，稳定即走——不再垫 20ms。
  await waitUntil(() => JSON.stringify(scanTree(root)) === JSON.stringify(one), 1000, '静置的树两次快照相同')
  const two = scanTree(root)
  assert.equal(JSON.stringify(two), JSON.stringify(one), '静置的树两次快照必须逐字节相同')
  assert.deepEqual(
    one.leaves.map((l) => l.path),
    ['a.txt', 'm.txt', 'src/deep/b.txt', 'z.txt'],
  )

  const a = one.leaves[0]
  assert.equal(a.kind, 'file')
  assert.equal(a.size, 5)
  assert.equal(a.hash, createHash('sha256').update('hello').digest('hex'))
  assert.equal(a.mode & 0o777, 0o644)
  assert.match(a.mtimeNs, /^\d+$/, 'mtime 是纳秒的十进制串——double 在 2^53 之上丢整数')

  // 目录自己的 mtime 会因为增删条目而变，而它没有内容：记上它，一次改名就报 4 条
  utimesSync(join(root, 'src'), new Date(0), new Date(0))
  assert.equal(JSON.stringify(scanTree(root)), JSON.stringify(one), '目录不是叶子')
})

test('② 改 3 个文件 → 恰好 3 条，且正是那 3 条（§ 8.5 的第一条验证性质）', () => {
  const root = tree({
    'a.txt': 'a',
    'b.txt': 'b',
    'c.txt': 'c',
    'readme.md': '# x',
    'src/one.ts': 'export const one = 1',
    'src/two.ts': 'export const two = 2',
    'src/deep/b.txt': 'b',
    'src/deep/c.txt': 'c',
    'src/deep/d.txt': 'd',
    'src/z.txt': 'z',
    'test/a.test.ts': 'x',
    'test/b.test.ts': 'y',
  })
  const before = scanTree(root)
  const touched = ['a.txt', 'src/deep/b.txt', 'src/z.txt']
  for (const p of touched) writeFileSync(join(root, p), `改过 ${p}\n`)

  const changes = diffStat(before, scanTree(root))
  assert.equal(changes.length, 3, `恰好 3 条，实际 ${changes.length}：${changes.map((c) => c.path).join(' ')}`)
  assert.deepEqual(changes.map((c) => c.path), [...touched].sort())
  for (const c of changes) {
    assert.equal(c.status, 'changed')
    assert.ok(c.columns.includes('content'), `改内容要报 content：${c.columns.join(',')}`)
    assert.ok(c.columns.includes('size'), `内容长了也要报 size：${c.columns.join(',')}`)
  }
})

test('③ 只 touch 一个文件 → 1 条，且列恰好是 mtime（内容一个字节没动）', async () => {
  const root = tree({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })
  const before = scanTree(root)
  // 时钟垫层（U17 保留）：让 touch 设的时刻与 `before` 那次快照隔着墙钟差——垫的是时间不是等待。
  await sleep(5)
  // touch 的干净写法：只改 mtime，别的都不动（`utimesSync` 不碰内容也不碰 mode）
  const f = join(root, 'b.txt')
  utimesSync(f, new Date(), new Date(Date.now() + 5000))

  const changes = diffStat(before, scanTree(root))
  assert.deepEqual(changes, [{ path: 'b.txt', status: 'changed', columns: ['mtime'] }])
})

test('④ 增 · 删 · 软链重指 · chmod：各报各的列', () => {
  const root = tree({ 'exec.sh': '#!/bin/sh\n', 'gone.txt': 'x', 'other.txt': 'o', 'keep.txt': 'k' })
  symlinkSync('keep.txt', join(root, 'link'))
  const before = scanTree(root)

  writeFileSync(join(root, 'new.txt'), 'n')
  rmSync(join(root, 'gone.txt'))
  chmodSync(join(root, 'exec.sh'), 0o755)
  // 软链重指：它的"内容"就是目标那串字符，所以报 content；`lutimes` 把 mtime 钉死在纪元上，
  // 免得这一行靠"两个时刻恰好不同"才成立。
  unlinkSync(join(root, 'link'))
  symlinkSync('other.txt', join(root, 'link'))
  lutimesSync(join(root, 'link'), new Date(0), new Date(0))

  const changes = diffStat(before, scanTree(root))
  assert.deepEqual(changes, [
    { path: 'exec.sh', status: 'changed', columns: ['mode'] },
    { path: 'gone.txt', status: 'removed', columns: [] },
    { path: 'link', status: 'changed', columns: ['size', 'content', 'mtime'] },
    { path: 'new.txt', status: 'added', columns: [] },
  ])

  // 软链记的是它自己：把目标的内容改掉，动的是目标那一条，不是软链那一条
  const mid = scanTree(root)
  writeFileSync(join(root, 'keep.txt'), 'k2')
  assert.deepEqual(
    diffStat(mid, scanTree(root)).map((c) => c.path),
    ['keep.txt'],
  )
})

test('⑧ 软链记的是"指向哪"，不是"指向的那份内容"', () => {
  // 出处：§ 8.5 的差异集口径（"符号链接比目标"）· PLAN § 5.2 的 V1.2 行。
  const root = tree({ 'same1.txt': 'same', 'same2.txt': 'same' })
  symlinkSync('same1.txt', join(root, 'link'))
  symlinkSync('nowhere.txt', join(root, 'dead'))
  // 两条链的 mtime 都先钉在纪元上：**这一条要证的是"内容"这一列会动**，不是"两个时刻恰好
  // 不同"——不钉的话，重指那一步会把 mtime 一起带上，断言就绕过了要证的那一列。
  for (const n of ['link', 'dead']) lutimesSync(join(root, n), new Date(0), new Date(0))
  const before = scanTree(root)

  // 改指向：两条目标**内容逐字节相同、长度也相同**——按内容算的那一版这里会一条都不报
  // （内容哈希一样、size 一样、mtime 被钉住），而"符号链接比目标"（§ 8.5）要求它报出来。
  unlinkSync(join(root, 'link'))
  symlinkSync('same2.txt', join(root, 'link'))
  lutimesSync(join(root, 'link'), new Date(0), new Date(0))
  assert.deepEqual(diffStat(before, scanTree(root)), [
    { path: 'link', status: 'changed', columns: ['content'] },
  ])

  // 负对照：改**被指向的那份内容**，动的是目标那一条，不是软链那一条。
  const mid = scanTree(root)
  writeFileSync(join(root, 'same1.txt'), 'changed')
  assert.deepEqual(
    diffStat(mid, scanTree(root)).map((c) => c.path),
    ['same1.txt'],
  )

  // 悬空软链照样扫得动，而且它的"内容"就是那串指不到任何地方的目标。
  const dead = scanTree(root).leaves.find((l) => l.path === 'dead')
  assert.equal(dead?.kind, 'symlink')
  assert.equal(dead?.hash, createHash('sha256').update('nowhere.txt').digest('hex'))
  assert.equal(dead?.size, 'nowhere.txt'.length)
})

test('⑤ 跳过是前缀判定：`.git` 跳的是 `.git/…`，`.gitignore` 照扫', () => {
  const root = tree({ '.git/HEAD': 'ref: x', '.gitignore': 'node_modules\n', '.fugue/log/a.jsonl': '{}\n', 'src/a.ts': 'a' })
  assert.deepEqual(
    scanTree(root).leaves.map((l) => l.path),
    ['.fugue/log/a.jsonl', '.git/HEAD', '.gitignore', 'src/a.ts'],
    '引擎默认一个都不跳：取舍留给调用方',
  )
  assert.deepEqual(
    scanTree(root, { skip: WORKSPACE_STATE }).leaves.map((l) => l.path),
    ['.gitignore', 'src/a.ts'],
  )
})

test('⑥ 基线：写读往返；读不动 · 不是 JSON · 没有 leaves 一律拒绝', () => {
  const root = tree({ 'a.txt': 'a' })
  const snap = scanTree(root)
  const dir = tmpDir('fugue-diffstat-base-')
  const file = join(dir, 'deep/base.json')
  storeTreeStat(file, snap)
  assert.deepEqual(loadTreeStat(file), snap)
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'), '落盘那份以换行收尾')

  assert.throws(() => loadTreeStat(join(dir, 'nope.json')), TreeStatError)
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{ 这不是 JSON')
  assert.throws(() => loadTreeStat(bad), TreeStatError)
  const noLeaves = join(dir, 'no.json')
  writeFileSync(noLeaves, '{"root":"/x"}')
  assert.throws(() => loadTreeStat(noLeaves), TreeStatError)
})

test('⑦ 命令行：三条断言都从 `fugue diff-stat` 走得通；量不了 · 尺子进了树一律拒绝', async () => {
  const root = tree({
    'tree/a.txt': 'a',
    'tree/b.txt': 'b',
    'tree/c.txt': 'c',
    'tree/src/d.txt': 'd',
    'tree/.git/HEAD': 'ref: refs/heads/main',
    'tree/.fugue/log/round.jsonl': '{"seq":0}\n',
  })

  // ① 静置：两次快照各存一份，两份逐字节相同（**等到稳定**——U17，不再垫 20ms）
  const one = fugue(root, 'diff-stat', 'tree', '--save', 'one.json')
  assert.equal(one.code, 0, one.stderr)
  await waitUntil(
    () => {
      const again = fugue(root, 'diff-stat', 'tree', '--save', 'two.json')
      return again.code === 0 && readFileSync(join(root, 'two.json'), 'utf8') === readFileSync(join(root, 'one.json'), 'utf8')
    },
    5000,
    '静置的树两次 --save 的快照相同',
  )
  assert.equal(readFileSync(join(root, 'two.json'), 'utf8'), readFileSync(join(root, 'one.json'), 'utf8'))
  // `--save` 落盘的就是快照本身（`--baseline` 读的也是它，不是命令行的输出信封）
  const scan = JSON.parse(readFileSync(join(root, 'one.json'), 'utf8')) as {
    root: string
    leaves: { path: string }[]
  }
  assert.equal(scan.root, join(root, 'tree'))
  // 工作区自己的本子不进快照：`.git` 与 `.fugue` 是命令行这一层给的 skip
  assert.deepEqual(scan.leaves.map((l) => l.path), ['a.txt', 'b.txt', 'c.txt', 'src/d.txt'])

  // ② 改 3 个文件 → 恰好 3 条。顺带把基线推进到改完那一刻（`--baseline` 读在前、`--save` 写在后）
  writeFileSync(join(root, 'tree/a.txt'), 'a2')
  writeFileSync(join(root, 'tree/b.txt'), 'b2')
  writeFileSync(join(root, 'tree/src/d.txt'), 'd2')
  const moved = fugue(root, 'diff-stat', 'tree', '--baseline', 'one.json', '--save', 'two.json', '--json')
  assert.equal(moved.code, 0, moved.stderr)
  const out = JSON.parse(moved.stdout) as {
    count: number
    baseline: string
    changes: { path: string; status: string; columns: string[] }[]
  }
  assert.equal(out.count, 3)
  assert.deepEqual(out.changes.map((c) => c.path), ['a.txt', 'b.txt', 'src/d.txt'])
  assert.ok(out.baseline.endsWith('/one.json'), out.baseline)

  // ③ 只 touch → 1 条，人读那一面就是一行 `~ b.txt mtime`，汇总在 stderr
  utimesSync(join(root, 'tree/b.txt'), new Date(), new Date(Date.now() + 5000))
  const human = fugue(root, 'diff-stat', 'tree', '--baseline', 'two.json')
  assert.equal(human.code, 0, human.stderr)
  assert.deepEqual(human.stdout.trim().split('\n'), ['~\tb.txt\tmtime'])
  assert.ok(human.stderr.includes('1 条变化'), human.stderr)

  // 只读（§ 8.5 把 diff-stat 与 verify-mat 并列写成只读）：跑完一趟，那棵树逐字节没动
  // 裸敲（没有 --baseline）：人读那一面指路，机器那一面还是那份 JSON
  const bare = fugue(root, 'diff-stat', 'tree')
  assert.equal(bare.code, 0, bare.stderr)
  assert.deepEqual(bare.stdout.trim().split('\n'), [`4 个叶子\t${join(root, 'tree')}`])
  assert.ok(bare.stderr.includes('--baseline'), bare.stderr)
  assert.ok(bare.stderr.includes('不是对比'), bare.stderr)
  const bareJson = fugue(root, 'diff-stat', 'tree', '--json')
  assert.equal(JSON.parse(bareJson.stdout).paths, 4)

  // 尺子别放进树里：基线/快照在被扫的树之内就拦住，且一个字节都不写
  const insideSave = fugue(root, 'diff-stat', 'tree', '--baseline', 'one.json', '--save', 'tree/base.json')
  assert.equal(insideSave.code, 1)
  assert.ok(insideSave.stderr.includes('挪到'), insideSave.stderr)
  assert.equal(existsSync(join(root, 'tree/base.json')), false, '拒绝之后不该留下那份快照')
  const insideBase = fugue(root, 'diff-stat', 'tree', '--baseline', 'tree/one.json')
  assert.equal(insideBase.code, 1)
  assert.ok(insideBase.stderr.includes('--baseline'), insideBase.stderr)
  // 负对照：同一份基线放在树外，同一条命令照常退 0
  assert.equal(fugue(root, 'diff-stat', 'tree', '--baseline', 'one.json').code, 0)

  const beforeRun = JSON.stringify(scanTree(join(root, 'tree'), { skip: WORKSPACE_STATE }))
  assert.equal(fugue(root, 'diff-stat', 'tree', '--baseline', 'two.json').code, 0)
  assert.equal(
    JSON.stringify(scanTree(join(root, 'tree'), { skip: WORKSPACE_STATE })),
    beforeRun,
    '尺子不碰树',
  )

  // 基线读不动 → 拒绝（1），不是"0 条变化"
  const missing = fugue(root, 'diff-stat', 'tree', '--baseline', '没有这份.json', '--json')
  assert.equal(missing.code, 1)
  assert.equal(missing.stdout, '', '拒绝时 stdout 一个字节都不吐')
  assert.ok(missing.stderr.includes('读不出来'), missing.stderr)

  // 选项要值：`--baseline` 光杆是用法错（2），不是"没有基线"
  assert.equal(fugue(root, 'diff-stat', 'tree', '--save').code, 2)

  // 不给 <dir>：扫的是本 agent 的合并树；还没铺就拒绝并指路 fork
  const dflt = fugue(root, 'diff-stat', '--json')
  assert.equal(dflt.code, 1)
  assert.ok(dflt.stderr.includes('fork'), dflt.stderr)
  assert.ok(dflt.stderr.includes(join('.fugue', 'mat', 'round', 'merged')), dflt.stderr)

  // 显式给一个不存在的目录：同样拒绝，但不说"先 fork"
  const nope = fugue(root, 'diff-stat', '没有这棵树')
  assert.equal(nope.code, 1)
  assert.ok(nope.stderr.includes('不是一棵能扫的树'), nope.stderr)
})

test('⑧ `statOrNull`：祖先不是目录也算"不在"（`ENOENT` 与 `ENOTDIR` 同义）', () => {
  const root = tree({ 'dir/x.ts': 'x', plain: 'not a dir' })
  assert.ok(statOrNull(join(root, 'dir', 'x.ts')) !== null, '在的那一条要读得出来')
  assert.equal(statOrNull(join(root, 'dir', 'missing.ts')), null, '父亲在、它不在 → null（ENOENT）')
  // 父亲**不是目录**：`{ throwIfNoEntry: false }` 在这种情形上照抛 `ENOTDIR`（本地实测），而
  // 这一条口径说的是"它就不存在"。
  assert.equal(statOrNull(join(root, 'plain', 'x.ts')), null, '祖先不是目录 → null（ENOTDIR）')
  assert.equal(
    (() => {
      try {
        lstatSync(join(root, 'plain', 'x.ts'), { throwIfNoEntry: false })
        return 'no-throw'
      } catch (err) {
        return (err as NodeJS.ErrnoException).code
      }
    })(),
    'ENOTDIR',
    '负对照：裸 `lstatSync(..., { throwIfNoEntry: false })` 在祖先不是目录时照抛',
  )
})
