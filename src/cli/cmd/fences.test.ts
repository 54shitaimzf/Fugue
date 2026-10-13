// **多写者那一族：要 N 把栅栏就先拿全 N 把，再开第一个口**（本版的登记接线）。
// 跑法：cd ~/fugue && node --test src/cli/cmd/fences.test.ts
//
// 出处：架构 § 9.11「要 N 把栅栏的请求先拿全再开口。中途撞上任何一把，已拿到的**全部放掉**，
// 请求以明确的 busy 结束——**不领重复序号，不留半份日志**」· § 9.2（一份日志一个写者进程）。
//
// 这一份量四件事，各配一条会红的判据：
//
//   ① **拿手的语义**（`fences.ts` 那一份单元）：两个 writer 一次拿全；拿不全时**一把不剩**
//      （后面那一把还拿得回来，就说明前面那把真放了）。
//   ② **四处入口一条都没落下**：静态读一遍 `round.ts`——四处都走 `acquireFences`，开的口都经
//      `fenceSet`，而**没有一处**再自己 `openLog(..., write:)`。加第五处入口而忘了拿手时，这一条红。
//   ③ **负对照（命令那一趟）**：第 1 个 writer 的栅栏在别人手里时 `round new` 以 busy 结束，
//      而盘上**第二个 writer 一个字节都没落**（日志目录里只剩那把别人持着的锁）。
//   ④ **正对照 + 全部放掉**：把那一把还给命令之后，同一条命令跑得通，跑完之后**两把都又拿得回来**
//      ——"成功那一趟没有一直扣着锁"。没有这一条，③ 里那个"没落"可能只是"压根没走到那儿"。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { AgentId, WriterId } from '../../terms.ts'
import { holdWriter, lockFileOf } from '../../log/hold.ts'
import { logDir, logFileOf } from '../../log/log.ts'
import { runCli } from '../../../test/helpers/run-cli.ts'
import { acquireFences } from './fences.ts'

/** 一条 git 命令（全局与系统配置都不读，作者身份钉住——与别的夹具同一套环境）。 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
  GIT_AUTHOR_DATE: '2026-02-01T00:00:00+0000',
  GIT_COMMITTER_DATE: '2026-02-01T00:00:00+0000',
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`)
}

/** 两份草案那一份拆分（**两个 agent**：这是这一份夹具的全部意义）。 */
const SPLIT = JSON.stringify([
  { goal: '写 src/parse.ts', ownedPaths: ['src/parse.ts'], assertions: [{ action: '总是过', name: '总是过' }] },
  { goal: '写 src/render.ts', ownedPaths: ['src/render.ts'], assertions: [{ action: '总是过', name: '总是过' }] },
])

/** 一个工作区：真提交一个底（轮次要 HEAD）· 一个绑定过的动作 · 两份草案。 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-fences-'))
  git(dir, 'init', '-q', '-b', 'main', '.')
  writeFileSync(join(dir, 'README.md'), '底\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', '底')
  // 动作绑定住 `<realRoot>/.fugue/config`（架构 § 15.3.a）：断言那一栏要一个已绑定的动作名。
  mkdirSync(join(dir, '.fugue'), { recursive: true })
  writeFileSync(join(dir, '.fugue', 'config'), JSON.stringify({ actions: { 总是过: { argv: ['/bin/true'] } } }) + '\n')
  return dir
}

/** 两条 `round new` 会用的 writer 名（`identFor(round, n)` 一处给名字）。 */
const AGENT_1 = 'agent/r1/1' as WriterId
const AGENT_2 = 'agent/r1/2' as WriterId

const clean = (dir: string): void => rmSync(dir, { recursive: true, force: true })

/** 日志目录下的**全部**文件（相对路径）——锁与日志都住在子目录里（`log/agent/r1/1.lock`）。 */
function logFiles(dir: string): string[] {
  const base = logDir(dir)
  if (!existsSync(base)) return []
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(join(abs, e.name), next)
      else out.push(next)
    }
  }
  walk(base, '')
  return out.sort()
}

/** 一条 `round new`（**不走 `--materialize`**：那一档要 overlay 挂载，验收入口上不一定有权限）。 */
function roundNew(dir: string): ReturnType<typeof runCli> {
  return runCli(['--root', dir, '--json', 'round', 'new', '把两件事做完', '--split', SPLIT])
}

test('① 拿手的语义：两个 writer 一次拿全；拿不全时一把不剩', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-fences-u-'))
  try {
    const set = acquireFences(dir, [AGENT_1, AGENT_2])
    assert.deepEqual(set.writers, [AGENT_1, AGENT_2], '名单该原样交回来（次序就是拿的次序）')
    const l1 = set.open(AGENT_1)
    assert.equal(set.open(AGENT_1), l1, '同一个 writer 要第二次，该拿到同一个口（幂等）')
    assert.throws(() => set.open('agent/r1/9' as AgentId as WriterId), /没有拿它/, '名单外的 writer 该当场拒')
    // **全放**：放完之后两把都拿得回来（拿不回来就说明有漏）。
    await set.closeAll()
    const left = logFiles(dir).filter((n) => n.endsWith('.jsonl') || n.endsWith('.lock'))
    for (const w of [AGENT_1, AGENT_2]) {
      const again = holdWriter(dir, w)
      again.release()
    }
    // 负对照的另一半：名单里重复同一个 writer → 当场拒（不然第二次必然撞上自己）。
    assert.throws(() => acquireFences(dir, [AGENT_1, AGENT_1]), /同一把栅栏要了两次/)
    assert.deepEqual(left, [], `全放之后日志目录里不该留下任何锁或日志：${left.join(' · ')}`)
    console.log('① 读数：两个 writer 一次拿全 · open 幂等 · 全放之后两把都拿得回来 · 重复名单当场拒')
  } finally {
    clean(dir)
  }
})

test('② 四处入口一条都没落下：都走 acquireFences + fenceSet.open，没有一处自己取锁', () => {
  const src = readFileSync(new URL('./round.ts', import.meta.url), 'utf8')
  // 四处：`round new` · `round run` · `round work`（声明式）· `round go`（赋给同一栏，见下一句）。
  const prefetch = src.match(/acquireFences\(root,/g) ?? []
  assert.equal(prefetch.length, 4, `该有四处拿手，实际 ${prefetch.length}`)
  const opens = src.split('fenceSet.open(').length - 1
  assert.ok(opens >= 3, `该有三处以上经 fenceSet 开口，实际 ${opens}`)
  // **负对照**：谁再写一句"自己取锁再开"，这一条红——那正是拿手被绕过的形状。
  assert.equal(
    /openLog\(root, \{ write: a as WriterId/.test(src),
    false,
    '还有一处自己取锁再开（`openLog(root, { write: a as WriterId …})`）：拿手那一句被绕过了',
  )
  // 锁与它守的那份日志**同一层**（§ 9.2 那张布局表）：名字带层的 writer 也不例外。
  assert.equal(
    lockFileOf('/tmp/x', AGENT_1),
    join(dirname(logFileOf('/tmp/x', AGENT_1)), '1.lock'),
    `锁该与它守的那份日志同一层：${lockFileOf('/tmp/x', AGENT_1)}`,
  )
  console.log(`② 读数：拿手 ${prefetch.length} 处 · 经 fenceSet 开口 ${opens} 处 · 自己取锁 0 处`)
})

test('③ 撞上 busy 的那一趟：第 1 把在别人手里 → 当场拒，第二个 writer 一个字节都没落', async () => {
  const dir = repo()
  const held = holdWriter(dir, AGENT_1)
  try {
    const r = await roundNew(dir)
    assert.equal(r.code, 1, `这一趟该以 1 结束（busy 是"做不成"），实际 ${r.code}：${r.stdout}${r.stderr}`)
    assert.match(r.stderr + r.stdout, /agent\/r1\/1/, `错话该点名是谁持着那一把：${r.stderr}${r.stdout}`)
    const files = logFiles(dir)
    assert.equal(files.filter((n) => n.endsWith('.jsonl')).length, 0, `busy 那一趟竟然落了日志：${files.join(' · ')}`)
    assert.deepEqual(
      files.filter((n) => n.endsWith('.lock')),
      ['agent/r1/1.lock'],
      `该只剩那把别人持着的锁：${files.join(' · ')}`,
    )
    console.log(`③ 读数：退出码 ${r.code} · 日志目录 ${files.length} 个文件（${files.join(' · ')}）· 一条 .jsonl 都没有`)
  } finally {
    held.release()
    clean(dir)
  }
})

test('④ 正对照 + 全部放掉：锁还回去之后跑得通，跑完两把都又拿得回来', async () => {
  const dir = repo()
  const held = holdWriter(dir, AGENT_1)
  try {
    const busy = await roundNew(dir)
    assert.equal(busy.code, 1, `锁还在手里时该以 1 结束，实际 ${busy.code}`)
    // **这一句是"全部放掉"的判据**：那一趟拿过第 2 把（第 1 把被占），撞上之后必须全放——
    // 拿不回来只有两种可能：没放，或者那一趟没走到拿手那一步（后者由 ② 那句读数分开）。
    const second = holdWriter(dir, AGENT_2)
    second.release()
    held.release()
    const ok = await roundNew(dir)
    assert.equal(ok.code, 0, `锁还回去之后该跑得通：${ok.stdout}${ok.stderr}`)
    // 成功那一趟也不许一直扣着锁：跑完之后两把又都拿得回来。
    for (const w of [AGENT_1, AGENT_2]) {
      const again = holdWriter(dir, w)
      again.release()
    }
    console.log('④ 读数：busy 那一趟 1 · 归还后 0 · 跑完两把都又拿得回来')
  } finally {
    held.release()
    clean(dir)
  }
})
