// T16 ① 的第一半：**walk 清单按视图代缓存**。出处：TARGETS `T16` ① · ROADMAP § 3 里"walk 清单按视图代缓存"那一行 ·
// 架构 § 8.10（`glob` 与 `grep` 走的是同一份清单）。跑法：cd ~/fugue && node --test src/tools/walk.test.ts
//
//   ① 纯机制：同代复用（数 `list` 调用）· 代变重枚举 · 枚举失败不缓存 · 结果彼此独立
//   ② 产品失效路径：真 `MemoryView` 上走 write / rename / chmod / remove（墓碑）/ 执行回写 /
//      重建——每一步之后 `host.walk()` 如实变，且同代第二次不再列目录
//   ③ 语义逐项不变：行序 · 深度与条数截断 · 软链与 gitlink 不跟——与一份不同源的参照逐项比
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/events.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import { applyEdit } from '../view/edit.ts'
import type { View } from '../view/contract.ts'
import { createRoots } from '../roots/roots.ts'
import type { AgentId, RelPath, WriterId } from '../terms.ts'
import type { ToolHost } from './execute.ts'
import { createToolHost } from './host.ts'
import { refHeadOf } from '../round/head.ts'
import { createWalk } from './walk-cache.ts'
import type { DirRow, WalkView } from './walk-cache.ts'

const AGENT = 'agent-1' as AgentId

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

const asBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

// ── ① 纯机制（不起视图：这一条只量缓存那三件事）────────────────────────────────

const row = (name: string, kind: string): DirRow => ({ name, kind })

interface FakeWalk {
  readonly view: WalkView
  /** 到此刻为止 `list` 被调了几次（同代复用就是靠它量的）。 */
  readonly calls: () => number
  /** 视图代前进一格（真视图上是 `write`/`rename`/… 那些动 upper 的那一下）。 */
  readonly bump: () => void
  readonly setRows: (dir: string, next: readonly DirRow[]) => void
  /** 让某一层列不出来（`null` = 恢复正常）。 */
  readonly failAt: (dir: string | null) => void
}

function fakeWalk(init: Record<string, readonly DirRow[]> = {}): FakeWalk {
  const rows = new Map<string, readonly DirRow[]>(Object.entries(init))
  let rev = 0
  let calls = 0
  let failing: string | null = null
  const view: WalkView = {
    // **活读数**：每一次问都现读 `rev`（真视图上它是一个 getter，快照下来就永远是同一个数了）。
    get rev(): number {
      return rev
    },
    async list(dir: string): Promise<readonly DirRow[]> {
      calls += 1
      if (failing !== null && failing === dir) throw new Error(`这一层列不了：${dir}`)
      return rows.get(dir) ?? []
    },
  }
  return {
    view,
    calls: () => calls,
    bump: () => {
      rev += 1
    },
    setRows: (dir, next) => {
      rows.set(dir, next)
    },
    failAt: (dir) => {
      failing = dir
    },
  }
}

test('① 同代复用 · 代变重枚举 · 失败不缓存 · 结果彼此独立', async () => {
  const f = fakeWalk({ '': [row('a.ts', 'file'), row('src', 'dir')], src: [row('b.ts', 'file')] })
  const walk = createWalk(f.view, { depth: 24, rows: 5000 })

  const first = await walk()
  assert.deepEqual([...first], ['a.ts', 'src/b.ts'])
  const cold = f.calls()
  assert.equal(cold, 2, `首走要列两层（根 + src），实际 ${cold} 次`)

  // 一 · 同代复用：一个 `list` 调用都不多。
  const again = await walk()
  assert.deepEqual([...again], [...first])
  assert.equal(f.calls(), cold, '代没变，第二次不该再列目录')

  // 二 · 代变重枚举，而且新清单如实反映那一变。
  f.setRows('', [row('a.ts', 'file'), row('src', 'dir'), row('c.ts', 'file')])
  f.bump()
  const third = await walk()
  assert.deepEqual([...third], ['a.ts', 'src/b.ts', 'c.ts'], '代变了要重走，新加的那一条要在里面')
  assert.ok(f.calls() > cold, '代变了就该重枚举')
  const warm = f.calls()
  assert.deepEqual([...await walk()], [...third])
  assert.equal(f.calls(), warm, '代变了之后的那一代同样是一次枚举')

  // 三 · 结果彼此独立：交出去的那一份是冻结的——改它当场失败，而不是悄悄影响下一位。
  assert.ok(Object.isFrozen(third), '清单该是冻结的（"彼此独立"那一条就是这么做出来的）')
  assert.throws(() => {
    ;(third as string[]).push('悄悄加一条')
  }, /not extensible|read only|Cannot add/i)
  assert.deepEqual([...await walk()], [...third], '改不动它，于是下一位拿到的还是同一份')

  // 四 · 枚举失败不缓存：这一代当场抛，**下一次调用重试**（修好之后同一代也成）。
  const beforeFail = f.calls()
  f.failAt('src')
  f.bump()
  await assert.rejects(async () => await walk(), /这一层列不了/)
  assert.ok(f.calls() > beforeFail, '失败那一次真的问了')
  f.failAt(null)
  const retried = await walk()
  // 代没再动：半份清单要是被缓存了，这一次会直接返回缺 `src/b.ts` 的那一份。
  assert.deepEqual([...retried], ['a.ts', 'src/b.ts', 'c.ts'], '一次失败不许毒化这一代')
  console.log(
    `① 读数：首走列 ${cold} 层 · 同代复用 0 次 · 代变后 ${warm - cold} 层 · 失败重试拿到 ${retried.length} 条 · 清单冻结`,
  )
})

// ── ③ 语义逐项不变（行序 · 深度 · 条数 · 软链与 gitlink）────────────────────────

/**
 * **一份不同源的参照**：把缓存之前那一段枚举原样写在这里，两边逐项比。
 *
 * 它只做参照，不进产品：两边比的是**清单的内容与次序**，不是同一个对象。
 */
async function referenceWalk(view: WalkView, depth: number, rows: number): Promise<string[]> {
  const out: string[] = []
  const step = async (dir: string, at: number): Promise<void> => {
    if (at > depth || out.length >= rows) return
    for (const one of await view.list(dir)) {
      if (out.length >= rows) return
      const path = dir === '' ? one.name : `${dir}/${one.name}`
      if (one.kind === 'dir') await step(path, at + 1)
      else if (one.kind === 'file') out.push(path)
    }
  }
  await step('', 0)
  return out
}

test('③ 语义逐项不变：行序 · 深度与条数截断 · 软链与 gitlink 不跟', async () => {
  const tree: Record<string, readonly DirRow[]> = {
    '': [row('b.ts', 'file'), row('a', 'dir'), row('link', 'symlink'), row('sub', 'gitlink'), row('x', 'other')],
    a: [row('deep.ts', 'file'), row('deeper', 'dir')],
    'a/deeper': [row('bottom.ts', 'file')],
  }
  // 逐档比：深度与条数各取几个界，两边必须逐项相同。
  for (const limits of [
    { depth: 24, rows: 5000 },
    { depth: 0, rows: 5000 },
    { depth: 1, rows: 5000 },
    { depth: 24, rows: 1 },
    { depth: 24, rows: 2 },
    { depth: 24, rows: 3 },
  ]) {
    const cached = [...(await createWalk(fakeWalk(tree).view, limits)())]
    const want = await referenceWalk(fakeWalk(tree).view, limits.depth, limits.rows)
    assert.deepEqual(cached, want, `depth=${limits.depth} rows=${limits.rows}：缓存那一份与逐步重走的参照不同`)
  }
  // 三条边界本身也点名断一次——两边同时错才不会互相遮住。
  const all = [...(await createWalk(fakeWalk(tree).view, { depth: 24, rows: 5000 })())]
  assert.deepEqual(all, ['b.ts', 'a/deep.ts', 'a/deeper/bottom.ts'])
  assert.equal(all.includes('link'), false, '软链不跟、也不进清单（§ 8.4 的 through-symlink）')
  assert.equal(all.includes('sub'), false, 'gitlink 一个都不进')
  assert.equal(all.includes('x'), false, '其余形状也不进（只有 file 进、只有 dir 下钻）')
  const shallow = [...(await createWalk(fakeWalk(tree).view, { depth: 0, rows: 5000 })())]
  assert.deepEqual(shallow, ['b.ts'], '深度 0 只列根那一层里的文件')
  const one = [...(await createWalk(fakeWalk(tree).view, { depth: 24, rows: 1 })())]
  assert.deepEqual(one, ['b.ts'], '条数 1 就停在第一条')
  console.log(`③ 读数：6 档界（深度 0/1/24 × 条数 1/2/3）两边逐项相同 · 全走 ${all.length} 条`)
})

// ── ② 产品失效路径：真视图上那六种变更各推一代 ──────────────────────────────────

interface Bench {
  readonly root: string
  readonly view: View
  readonly host: ToolHost
  readonly truth: TruthHandle
  readonly log: LogHandle
  /** 到此刻为止视图被列了几层（`list` 的调用数）。 */
  readonly lists: () => number
  readonly close: () => Promise<void>
}

/**
 * 一份真台子：真对象库 · 真日志 · 真 `MemoryView`（空日志 + 空 lower 起一份）· 真围栏 · 工具面宿主。
 *
 * **视图外面包一层只数 `list`**：缓存量的是"同一代里还列不列目录"，而 `list` 是唯一的枚举口。
 * 包在测试这一层而不是改产品：产品那一份不认识计数器（归因不进口）。
 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-walk-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const truth = openTruth(root)
  const log = openLog(root, { write: AGENT as WriterId, sync: 'each' })
  const view = await loadView(log, AGENT as WriterId, { lower: lowerAt(truth, null) })
  let calls = 0
  const counted = new Proxy(view, {
    get(target, key) {
      const v = Reflect.get(target, key, target)
      if (key === 'list' && typeof v === 'function') {
        return async (dir: RelPath) => {
          calls += 1
          return await (v as (d: RelPath) => Promise<unknown>).call(target, dir)
        }
      }
      return v
    },
  }) as View
  const host = createToolHost(counted, createRoots(root as never), {
    actions: { writer: AGENT as WriterId, log, truth, head: await refHeadOf(log, AGENT as WriterId, null) },
  })
  return {
    root,
    view: counted,
    host,
    truth,
    log,
    lists: () => calls,
    close: async () => {
      await log.close()
      await truth.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('② 产品失效路径：write / rename / chmod / remove / 执行回写 / 重建 各推一代，清单如实变', async () => {
  const b = await bench()
  try {
    /**
     * 走一步：先按产品路径变更，再问清单——两次同代（第二次必须一个 `list` 都不发）。
     *
     * `lists` 是累计读数，所以比的是**增量**。
     */
    const step = async (what: string, want: readonly string[], mutate: () => Promise<unknown>): Promise<void> => {
      await mutate()
      const at = b.lists()
      const first = [...(await b.host.walk())]
      assert.deepEqual(first, [...want], `${what} 之后清单该是 ${want.join(' ')}，实际 ${first.join(' ')}`)
      assert.ok(b.lists() > at, `${what} 推进了一代，却一条目录都没重列`)
      const warm = b.lists()
      assert.deepEqual([...(await b.host.walk())], first, `${what} 之后同代的清单该相同`)
      assert.equal(b.lists(), warm, `${what} 之后同代第二次不该再列目录`)
    }

    // 起步：空视图（一份文件都没有）。
    assert.deepEqual([...(await b.host.walk())], [], '空视图的清单是空的')

    await step('write', ['a.ts'], async () => await b.host.writeBytes('a.ts', asBytes('第一份\n')))
    await step('write（更深一层）', ['a.ts', 'd/b.ts'], async () => await b.host.writeBytes('d/b.ts', asBytes('第二份\n')))
    await step('rename', ['c.ts', 'd/b.ts'], async () => await b.view.rename('a.ts' as RelPath, 'c.ts' as RelPath))
    await step('chmod', ['c.ts', 'd/b.ts'], async () => await b.view.chmod('c.ts' as RelPath, 0o100755))
    await step('remove（墓碑）', ['c.ts'], async () => await b.view.remove('d/b.ts' as RelPath))
    // **执行回写那一条**：`bash` 跑完把声明集内的差异写回视图，走的就是 `applyEdit` 这一份
    // （`host.ts` 的 `afterRun` 逐条调它）——与 `write` 工具逐字节同一条路。
    await step(
      '执行回写',
      ['c.ts', 'e/f.ts'],
      async () =>
        await applyEdit(
          { view: b.view, truth: b.truth, log: b.log, writer: AGENT as WriterId },
          { kind: 'add', path: 'e/f.ts' as RelPath, bytes: asBytes('回写\n'), mode: 0o100644 },
        ),
    )
    // **重建那一条**：一次性应用一批 delta（重放与重建走的也是它）。
    await step(
      '重建（一批 delta）',
      ['c.ts', 'e/f.ts', 'g/h.ts'],
      async () =>
        await b.view.applyDelta([{ kind: 'add', path: 'g/h.ts' as RelPath, bytes: asBytes('重建\n'), mode: 0o100644 }]),
    )
    console.log(
      `② 读数：六种变更（write · rename · chmod · remove · 执行回写 · 重建）各推一代，清单逐次如实变 · 同代第二次 0 次列目录`,
    )
  } finally {
    await b.close()
  }
})
