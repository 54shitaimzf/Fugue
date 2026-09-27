// § 9.6 全表的端到端：读 · 写 · 检视 · 提交 · 重放 · 配置，真 git · 真日志 · 真进程。
//
// 断言在 `src/view/view.test.ts` 里（纯逻辑）；这一份问的是另一件事：**这些命令真的能
// 用吗**——单次进程 + 每次重建，所以每条命令都是一次完整的加载。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { openTruth } from '../truth/truth.ts'
import type { BlobId, CommitId, RefName } from '../terms.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))

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
  const root = tmpDir('fugue-cli-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

test('读 · 写 · 名字 · 模式 · 提交：一条命令一个进程，下一条命令靠重放回来', async () => {
  const root = tmpRoot()

  const w1 = fugueStdin(root, '第一版\n', 'write', 'a.txt', '--stdin')
  assert.equal(w1.code, 0, w1.stderr)
  assert.match(w1.stdout, /^1\tround\n$/, '第一次写落在 rev 1')

  const r1 = fugue(root, 'read', 'a.txt')
  assert.equal(r1.code, 0, r1.stderr)
  assert.equal(r1.stdout, '第一版\n', '下一条命令从日志重放回来')

  const s1 = fugue(root, '--json', 'stat', 'a.txt')
  assert.equal(s1.code, 0, s1.stderr)
  const meta = JSON.parse(s1.stdout) as { kind: string; mode: number; size: number; id: string }
  assert.equal(meta.kind, 'file')
  assert.equal(meta.mode, 0o100644)
  assert.equal(meta.size, Buffer.byteLength('第一版\n'))

  const d1 = fugueStdin(root, '子目录里的\n', 'write', 'd/x.txt', '--stdin')
  assert.equal(d1.code, 0, d1.stderr)
  const l1 = fugue(root, 'list', 'd')
  assert.equal(l1.code, 0, l1.stderr)
  assert.match(l1.stdout, /^file\t100644\t\d+\tx\.txt\n$/)
  const l0 = fugue(root, 'list')
  assert.match(l0.stdout, /dir\t40000\t0\td\n/)

  const mv = fugue(root, 'rename', 'a.txt', 'b.txt')
  assert.equal(mv.code, 0, mv.stderr)
  assert.equal(fugue(root, 'read', 'b.txt').stdout, '第一版\n')
  assert.equal(fugue(root, 'stat', 'a.txt').code, 1, '改走的路径不在了')

  // 断言③的端到端面：一次改名叫 `rename` 是一条，不是删一条加一条。
  const diff = fugue(root, '--json', 'diff')
  assert.equal(diff.code, 0, diff.stderr)
  const deltas = JSON.parse(diff.stdout) as { kind: string; from?: string; to?: string }[]
  assert.deepEqual(
    deltas.filter((d) => d.kind === 'rename'),
    [{ kind: 'rename', from: 'a.txt', to: 'b.txt' }],
  )
  assert.equal(deltas.some((d) => d.kind === 'delete'), false)

  const ch = fugue(root, 'chmod', 'b.txt', '755')
  assert.equal(ch.code, 0, ch.stderr)
  const s2 = JSON.parse(fugue(root, '--json', 'stat', 'b.txt').stdout) as { mode: number }
  assert.equal(s2.mode, 0o100755)

  const c1 = fugue(root, '-m', '第一次提交', 'commit')
  assert.equal(c1.code, 0, c1.stderr)
  const first = JSON.parse(fugue(root, '--json', '-m', '不，这次要 JSON', 'commit').stdout) as {
    commit: string
  }
  assert.match(first.commit, /^[0-9a-f]{40}$/)

  // 提交出来的树就是视图的全量读出：两个文件都在，模式跟着走。
  const t = openTruth(root)
  try {
    const head = await t.resolve('refs/heads/main' as RefName)
    assert.equal((await t.readAt(head, 'b.txt'))?.toString(), '第一版\n')
    assert.equal((await t.statAt(head, 'b.txt'))?.mode, 0o100755)
    assert.equal((await t.readAt(head, 'd/x.txt'))?.toString(), '子目录里的\n')
  } finally {
    await t.close()
  }
})

test('下层才有的文件：改名与改权限先把它钉进日志，base 前移之后重放照样对', async () => {
  const root = tmpRoot()

  // 造一个"人类先提交过"的底稿：视图的 base 是它，而日志里一个字都没有。
  const t = openTruth(root)
  const blob = await t.putBlob(Buffer.from('底稿的内容\n'))
  const tree = await t.putTree([{ name: 'from-base.txt', mode: 0o100644, id: blob as BlobId }])
  const c0 = await t.commit(tree, [], '底稿')
  await t.advance('refs/heads/main' as RefName, c0, null)
  await t.close()

  const r0 = fugue(root, 'read', 'from-base.txt')
  assert.equal(r0.code, 0, r0.stderr)
  assert.equal(r0.stdout, '底稿的内容\n', 'base 里的文件要能读')

  const ch = fugue(root, 'chmod', 'from-base.txt', '755')
  assert.equal(ch.code, 0, ch.stderr)
  const s = JSON.parse(fugue(root, '--json', 'stat', 'from-base.txt').stdout) as { mode: number }
  assert.equal(s.mode, 0o100755)
  assert.equal(fugue(root, 'read', 'from-base.txt').stdout, '底稿的内容\n', '内容照旧')

  // 改权限依赖下层的内容，所以日志里应当先有一条把它钉下来的写：两条事件 · rev 到 2。
  const log = JSON.parse(fugue(root, '--json', 'diff').stdout) as { kind: string }[]
  assert.deepEqual(
    log.map((d) => d.kind),
    ['add', 'chmod'],
    '只有下层才有的内容，先钉一条写进日志',
  )

  const mv = fugue(root, 'rename', 'from-base.txt', 'renamed.txt')
  assert.equal(mv.code, 0, mv.stderr)
  assert.equal(fugue(root, 'read', 'renamed.txt').stdout, '底稿的内容\n')

  const c1 = fugue(root, '-m', '第二次提交', 'commit')
  assert.equal(c1.code, 0, c1.stderr)

  // **base 现在前移了**（新的提交里这个文件已经叫 renamed.txt）。整条日志重新重放一遍：
  // 每一步的内容都在日志里，所以照样对。
  const after = fugue(root, 'read', 'renamed.txt')
  assert.equal(after.code, 0, after.stderr)
  assert.equal(after.stdout, '底稿的内容\n')
  assert.equal(fugue(root, 'stat', 'from-base.txt').code, 1)
  const mv2 = fugue(root, 'rename', 'renamed.txt', 'again.txt')
  assert.equal(mv2.code, 0, mv2.stderr)
  assert.equal(fugue(root, 'read', 'again.txt').stdout, '底稿的内容\n')
})

test('revs：修订点由事件给出，提交也是一个点（§ 9.6 的检视组）', async () => {
  const root = tmpRoot()
  const revsOf = (): number[] => JSON.parse(fugue(root, '--json', 'revs').stdout) as number[]

  assert.deepEqual(revsOf(), [0], '还没有任何修订时，0 就是 base 本身')
  assert.equal(fugue(root, 'revs').stdout, '0\n', '人读的那一面：一行一个')

  assert.equal(fugueStdin(root, '一\n', 'write', 'a.txt', '--stdin').stdout, '1\tround\n')
  assert.equal(fugueStdin(root, '二\n', 'write', 'b.txt', '--stdin').stdout, '2\tround\n')
  assert.deepEqual(revsOf(), [0, 1, 2])

  const c = JSON.parse(fugue(root, '--json', '-m', '第一次提交', 'commit').stdout) as { rev: number }
  assert.equal(c.rev, 2, '提交不改视图的内容：它停在当刻那个 rev 上')
  assert.deepEqual(revsOf(), [0, 1, 2], '提交把已有的点又记了一遍——修订点是集合，不是计数')

  assert.equal(fugueStdin(root, '三\n', 'write', 'c.txt', '--stdin').stdout, '3\tround\n')
  assert.deepEqual(revsOf(), [0, 1, 2, 3])

  // 快照换掉的是历史，不是状态：修订点跟着状态走，所以把快照删掉答得一样全（§ 9.4）。
  rmSync(join(root, '.fugue', 'snap'), { recursive: true, force: true })
  assert.deepEqual(revsOf(), [0, 1, 2, 3])

  // 报出来的每一个点，`diff --since` 都答得上来——这条命令给的东西是能用的。
  for (const r of revsOf()) {
    assert.equal(fugue(root, '--json', 'diff', '--since', String(r)).code, 0, `--since ${r}`)
  }
})

test('--agent 切视图：换一个参数就是换一份日志 · 一条分支头 · 一段 base（§ 9.6）', async () => {
  const root = tmpRoot()
  const sub = 'agent/r1/1'

  // 主线：写两个、提交。
  assert.equal(fugueStdin(root, '主线的\n', 'write', 'main.txt', '--stdin').code, 0)
  assert.equal(fugueStdin(root, '主线的第二个\n', 'write', 'main2.txt', '--stdin').code, 0)
  assert.equal(fugue(root, 'commit', '-m', '主线的提交').code, 0)

  // 子 agent：自己的日志、自己的分支头、自己的 rev 序列。
  const w = fugueStdin(root, '子 agent 的\n', '--agent', sub, 'write', 'sub.txt', '--stdin')
  assert.equal(w.code, 0, w.stderr)
  assert.equal(w.stdout, `1\t${sub}\n`, '它从 rev 1 数起，与主线各数各的')
  assert.equal(fugue(root, '--agent', sub, 'commit', '-m', '子 agent 的提交').code, 0)

  // 两份视图互不可见：路径是身份的判据，读得到的才是它的。
  assert.equal(fugue(root, 'read', 'main.txt').stdout, '主线的\n')
  assert.equal(fugue(root, 'read', 'sub.txt').code, 1, '主线的视图里没有子 agent 写的路径')
  assert.equal(fugue(root, '--agent', sub, 'read', 'sub.txt').stdout, '子 agent 的\n')
  assert.equal(fugue(root, '--agent', sub, 'read', 'main.txt').code, 1, '子 agent 铺在自己的分支头上')
  assert.equal(fugue(root, '--agent', sub, 'stat', 'main2.txt').code, 1)

  // 修订点各是各的。
  assert.deepEqual(JSON.parse(fugue(root, '--json', 'revs').stdout), [0, 1, 2])
  assert.deepEqual(JSON.parse(fugue(root, '--json', '--agent', sub, 'revs').stdout), [0, 1])

  // git 侧两条分支头 · 日志侧两份日志——同一个 writer，两种落点（§ 4）。
  const refs = spawnSync('git', ['show-ref'], { cwd: root, encoding: 'utf8' }).stdout
  assert.equal(refs.split('\n').filter((l) => l.endsWith(' refs/heads/main')).length, 1)
  assert.equal(refs.split('\n').filter((l) => l.endsWith(' refs/heads/agent/r1/1')).length, 1)
  assert.equal(existsSync(join(root, '.fugue', 'log', 'round.jsonl')), true)
  assert.equal(existsSync(join(root, '.fugue', 'log', 'agent', 'r1', '1.jsonl')), true)

  // 重放的两条路对这两份视图都成立：快照是加速项，交错读不串味。
  const v = fugue(root, '--json', 'replay', '--verify')
  assert.equal(v.code, 0, v.stderr)
  const report = JSON.parse(v.stdout) as { ok: boolean; agents: { writer: string }[] }
  assert.equal(report.ok, true)
  assert.deepEqual(
    report.agents.map((a) => a.writer),
    ['agent/r1/1', 'round'],
    '每一个写过日志的 writer 各比一遍',
  )
})

test('拒绝与退出码：0 成功 · 1 做不成 · 2 用法错（§ 9.8 的退出码行）', async () => {
  const root = tmpRoot()
  const miss = fugue(root, 'read', '没有这个')
  assert.equal(miss.code, 1)
  assert.match(miss.stderr, /不是可读的路径/)

  // 1 · 成立的请求，得到一个"没成"的结果。
  assert.equal(fugue(root, 'stat', '没有这个').code, 1)
  assert.equal(fugue(root, 'remove', '没有这个').code, 1)
  assert.equal(fugue(root, 'write', 'a.txt', '--from', '/没有这个文件').code, 1, '来源读不到')
  assert.equal(fugue(root, '--agent', 'agent/r1/1', 'read', 'a.txt').code, 1, '子视图里没有主线的路径')

  // 2 · 命令行本身就不成立——它有自己的退出码。
  assert.equal(fugue(root, 'write', 'a.txt').code, 2, 'write 少了 --from/--stdin')
  assert.equal(fugue(root, 'remove').code, 2)
  assert.equal(fugue(root, 'rename', 'a.txt').code, 2)
  assert.equal(fugue(root, 'chmod', 'a.txt').code, 2)
  assert.equal(fugue(root, 'chmod', 'a.txt', '999').code, 2, '999 不是八进制模式')
  assert.equal(fugue(root, 'diff', '--since', 'x').code, 2)
  assert.equal(fugue(root, '把目录挪走', 'd', 'd2').code, 2, '未知命令')
  assert.equal(fugue(root).code, 2, '不给命令是用法错')
  assert.equal(fugue(root, 'config', 'set', 'a.b').code, 2, 'config set 少了值')
  assert.equal(fugue(root, '--help').code, 0, '要帮助是一条成功的命令')
  assert.equal(fugue(root, '--help').stdout.startsWith('用法: fugue'), true)

  // **用法错的命令在磁盘上留不下任何东西**：参数先收成一个 delta，视图后开（`deltaFrom`）。
  assert.equal(existsSync(join(root, '.fugue')), false, '用法错不该建出日志目录')
})

// ── 走出工作区的路径：拒在围栏上，文案带指路（Y7 的走查量到的那一处）──────────────
//
// `read ../outside.txt` 与 `read /etc/passwd` 这一类输入在视图那一步的路径检查上（`view.pathOf`
// 的 `throw new Error`）**拒得出，而文案里没有去处**。架构 § 8.4 纪律 2 要求拒绝必须指路，
// 而那道围栏（`fence.ts` 的 `Denied.message`）本来就带着那句原话。四条写命令与两条读命令因此
// 都在围栏上过一道，拒的时候报的是围栏那句话。
test('路径走出工作区：拒在围栏上，文案带指路', async () => {
  const root = tmpRoot()
  const w = fugueStdin(root, 'hi\n', 'write', 'a.txt', '--stdin')
  assert.equal(w.code, 0, w.stderr)

  // 两条由头各来一次：`..` 越界（escape）与绝对路径（absolute）。四条写命令与读命令同一条路。
  for (const p of ['../outside.txt', '/etc/passwd']) {
    for (const [what, r] of [
      ['read', fugue(root, 'read', p)],
      ['stat', fugue(root, 'stat', p)],
      ['list', fugue(root, 'list', p)],
      ['write', fugueStdin(root, 'hi\n', 'write', p, '--stdin')],
      ['remove', fugue(root, 'remove', p)],
      ['rename', fugue(root, 'rename', p, 'x.txt')],
      ['chmod', fugue(root, 'chmod', p, '755')],
    ] as [string, Run][]) {
      assert.equal(r.code, 1, `${what} ${p} 该拒：${r.stderr}`)
      assert.match(r.stderr, /^\[boundary: /, `${what} ${p} 报的是围栏那句话：${r.stderr}`)
      assert.match(r.stderr, /走申请（§ 15\.3\.b）/, `${what} ${p} 带指路：${r.stderr}`)
    }
  }
  // 围栏不误伤：根之上不许走，**根之内可以走**（`a.txt` 与 `./a.txt` 是同一条路径）。
  assert.equal(fugue(root, 'read', 'a.txt').stdout, 'hi\n')
  assert.equal(fugue(root, 'read', './a.txt').stdout, 'hi\n')

  // 拒的时候磁盘上一个字节都不该动：围栏排在开视图之前（用法错那一条也是这个口径）。
  assert.equal(existsSync(join(root, '..', 'outside.txt')), false, '工作区外没有落下东西')
})

// ── X0（S4 之前要收的那一处）──────────────────────────────────────────────────
//
// 模式只认两档（§ 8.3），所以 `fugue chmod <path> 700` 这条命令要禁的是**落一条 `view/chmod` 而
// 视图里那个路径的模式没变**——报出来的与做的不一致。三条断言逐条对 PLAN § 5.3 尾的 X0 行。

/** 一条 git 命令：身份与时间戳钉死，全局/系统配置不参与（与 `concurrent.test.ts` 同一套）。 */
function gitIn(cwd: string, args: readonly string[]): string {
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

test('X0 · chmod 的「没有变化」：一句话、不落一条变更；真变化照旧落（§ 8.3 的模式两档）', (t) => {
  const root = tmpDir('fugue-x0-')
  t.after(() => {
    fugue(root, 'dispose')
  })

  // 一棵真仓库加一个提交：`fork` 的底就是工作树与 HEAD（§ 8.4），底里有一个 755 的文件。
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(join(root, 'run.sh'), 0o755)
  gitIn(root, ['init', '-q', '-b', 'main', '.'])
  gitIn(root, ['add', '-A'])
  gitIn(root, ['commit', '-qm', '起点'])
  const base = gitIn(root, ['rev-parse', 'HEAD'])
  assert.equal(gitIn(root, ['status', '--porcelain']), '', '夹具的工作树要是干净的')

  const br = fugue(root, 'branch', base)
  assert.equal(br.code, 0, br.stderr)
  const fk = fugue(root, 'fork', base)
  assert.equal(fk.code, 0, fk.stderr)
  const merged = fk.stdout.trim()
  assert.equal(statSync(join(merged, 'run.sh')).mode & 0o777, 0o755, '底里那个文件的模式')

  /** 日志里的事件类型，按顺序。**清单那一侧的读数从这里来，不靠命令的自述。** */
  const eventTypes = (): string[] =>
    fugue(root, '--json', 'log')
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { e: { t: string } }).e.t)
  const syncs = (): number => eventTypes().filter((x) => x === 'mat/sync').length

  const e1 = fugue(root, '--json', 'ensure')
  assert.equal(e1.code, 0, e1.stderr)
  assert.equal((JSON.parse(e1.stdout) as { noop: boolean }).noop, true, '底就是清单那个 rev')
  const sync0 = syncs()

  // ① 归一之后与现值相同：底里那个 755 的文件上敲 700 不是一次变更——**一条都不落**。
  const n1 = fugue(root, 'chmod', 'run.sh', '700')
  assert.equal(n1.code, 0, n1.stderr)
  assert.equal(n1.stderr, '没有变化：run.sh 已经是 100755\n')
  assert.match(n1.stdout, /^0\tround\n$/, 'rev 不动（底就是 rev 0）')
  assert.equal(fugue(root, '--json', 'diff').stdout.trim(), '[]', 'diff 里没有这一条')
  assert.equal((JSON.parse(fugue(root, '--json', 'stat', 'run.sh').stdout) as { mode: number }).mode, 0o100755)
  assert.equal(syncs(), sync0, '清单不增：日志里没有多一条 mat/sync')
  const e2 = fugue(root, '--json', 'ensure')
  assert.equal(e2.code, 0, e2.stderr)
  assert.equal((JSON.parse(e2.stdout) as { landed: string[] }).landed.length, 0, '没有 delta 要落')

  // ③ 归一只有一处：`700` 与 `755` 是同一件事，两条命令给的话逐字相同。
  const n2 = fugue(root, 'chmod', 'run.sh', '700')
  const n3 = fugue(root, 'chmod', 'run.sh', '755')
  assert.equal(n2.stderr, n3.stderr)
  assert.equal(n2.stdout, n3.stdout)

  // ② 负对照一：底下那个文件上的真变化，照旧落两条（先拷上来，再改）· `diff` 报得出 · 落地。
  const real = fugue(root, 'chmod', 'run.sh', '644')
  assert.equal(real.code, 0, real.stderr)
  assert.equal(real.stderr, '', '真变化不说什么')
  assert.match(real.stdout, /^2\tround\n$/)
  assert.deepEqual(JSON.parse(fugue(root, '--json', 'diff').stdout), [
    { kind: 'add', path: 'run.sh', mode: 0o100755, size: 18 },
    { kind: 'chmod', path: 'run.sh', mode: 0o100644 },
  ], '报出来的是两档里的数，不是人敲的那个八进制串')
  const e3 = fugue(root, '--json', 'ensure')
  assert.equal(e3.code, 0, e3.stderr)
  const r3 = JSON.parse(e3.stdout) as { noop: boolean; landed: string[] }
  assert.equal(r3.noop, false)
  assert.deepEqual(r3.landed, ['run.sh'], '落地记的是路径：两条事件落在同一个文件上')
  assert.equal(statSync(join(merged, 'run.sh')).mode & 0o777, 0o644, '落地到了盘上')
  assert.equal(fugue(root, 'verify-mat').code, 0, '清单 == 差异集')

  // ② 负对照二：上层那个文件上同样是一句话，而它连"拷贝上来"那一条都不需要。
  const w = fugueStdin(root, '自己写的\n', 'write', 'own.txt', '--stdin')
  assert.equal(w.code, 0, w.stderr)
  // 人敲 700，报出来的是 100755——接缝上收过一次。
  const up = fugue(root, 'chmod', 'own.txt', '700')
  assert.equal(up.code, 0, up.stderr)
  assert.match(up.stdout, /^4\tround\n$/)
  assert.deepEqual(JSON.parse(fugue(root, '--json', 'diff', '--since', '3').stdout), [
    { kind: 'chmod', path: 'own.txt', mode: 0o100755 },
  ])
  const e4 = fugue(root, '--json', 'ensure')
  assert.equal(e4.code, 0, e4.stderr)
  const sync4 = syncs()
  const n4 = fugue(root, 'chmod', 'own.txt', '755')
  assert.equal(n4.code, 0, n4.stderr)
  assert.equal(n4.stderr, '没有变化：own.txt 已经是 100755\n')
  assert.match(n4.stdout, /^4\tround\n$/, 'rev 不动')
  assert.equal(fugue(root, '--json', 'diff', '--since', '4').stdout.trim(), '[]')
  assert.equal(syncs(), sync4, '清单不增')
  assert.equal((JSON.parse(fugue(root, '--json', 'ensure').stdout) as { noop: boolean }).noop, true)
  assert.equal(statSync(join(merged, 'own.txt')).mode & 0o777, 0o755, '盘上还是那次真变化的模式')
})

test('观察那三条命令：认不得的开关当场退 2（不静默收下），认得的照旧', () => {
  const root = tmpRoot()
  const w = fugueStdin(root, '第一版\n', 'write', 'a.txt', '--stdin')
  assert.equal(w.code, 0, w.stderr)

  // **认不得的**：退 2（命令行不成立），且报的话里指名道姓 + 说得出这一条认哪几个。
  const grep = fugue(root, 'log', '--grep', 'llm')
  assert.equal(grep.code, 2, `log 收下了一个不认识的开关：${grep.stdout.slice(0, 120)}`)
  assert.match(grep.stderr, /log 不认这几个开关：--grep/)
  assert.match(grep.stderr, /--agent/)
  const once = fugue(root, 'watch', '--once')
  assert.equal(once.code, 2, `watch 收下了 --once：${once.stdout.slice(0, 120)}`)
  assert.match(once.stderr, /watch 不认这几个开关：--once/)
  assert.match(once.stderr, /--follow/)
  const iv = fugue(root, 'status', '--interval', '200')
  assert.equal(iv.code, 2, `status 收下了 --interval：${iv.stdout.slice(0, 120)}`)
  assert.match(iv.stderr, /status 不认这几个开关：--interval/)

  // **认得的照旧**：退 0，读数一个字节不变（闸不认识的那几个才拒）。
  assert.equal(fugue(root, 'log').code, 0)
  assert.equal(fugue(root, '--json', 'log', '--agent', 'round').code, 0)
  assert.equal(fugue(root, 'watch').code, 0)
  assert.equal(fugue(root, 'status', '--once').code, 0)
  console.log(
    '读数：log --grep → 2 · watch --once → 2 · status --interval → 2 · 认得的四条（log · --json log --agent · watch · status --once）照旧 0',
  )
})
