// T16 ① 的第一半：**walk 清单按视图代缓存**。出处：TARGETS `T16` ① · ROADMAP § 3 里"walk 清单按视图代缓存"那一行 ·
// 架构 § 8.10（`glob` 与 `grep` 走的是同一份清单）。跑法：cd ~/fugue && node --test src/tools/walk.test.ts
//
//   ① 纯机制：同代复用（数 `list` 调用）· 代变重枚举 · 枚举失败不缓存 · 结果彼此独立
//   ② 产品失效路径：真 `MemoryView` 上走 write / rename / chmod / remove（墓碑）/ 执行回写 /
//      重建——每一步之后 `host.walk()` 如实变，且同代第二次不再列目录
//   ③ 语义逐项不变：行序 · 深度与条数截断 · 软链与 gitlink 不跟——与一份不同源的参照逐项比
//   ⑤ 清单里那两栏（id · 字节数）：与 view.list 的行同源 · 代变跟着换 · 手搓清单没有
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
import { createWalk, walkCutOf, walkRowsOf } from './walk-cache.ts'
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

test('④ 截没截是一个读数：两条上限各记一笔，没截就是两笔都假（本站 ②）', async () => {
  const tree: Record<string, readonly DirRow[]> = {
    '': [row('b.ts', 'file'), row('a', 'dir')],
    a: [row('deep.ts', 'file'), row('deeper', 'dir')],
    'a/deeper': [row('bottom.ts', 'file')],
  }
  // 一 · 都没顶到：两笔都是假——"树里恰好这么多"与"截在上限上"要分得开。
  const whole = await createWalk(fakeWalk(tree).view, { depth: 24, rows: 5000 })()
  assert.deepEqual(walkCutOf(whole), { rows: false, depth: false, limits: { depth: 24, rows: 5000 } })
  // 二 · 条数顶到：根那一层还有没列出来的行。
  const byRows = await createWalk(fakeWalk(tree).view, { depth: 24, rows: 1 })()
  assert.deepEqual([...byRows], ['b.ts'])
  assert.equal(walkCutOf(byRows)?.rows, true, '条数停在上限上，那是截了')
  assert.equal(walkCutOf(byRows)?.depth, false, '深度这一趟没顶到')
  // 三 · 深度顶到：`a` 那一条目录没被列过，它下面还有东西没走到。
  const byDepth = await createWalk(fakeWalk(tree).view, { depth: 0, rows: 5000 })()
  assert.deepEqual([...byDepth], ['b.ts'])
  assert.equal(walkCutOf(byDepth)?.depth, true, '深度停在上限上，那是截了')
  assert.equal(walkCutOf(byDepth)?.rows, false, '条数这一趟没顶到')
  // 四 · 上限那一趟用的两个数**跟着清单走**：印给人看的那句话不必另抄一份常数。
  assert.deepEqual(walkCutOf(byDepth)?.limits, { depth: 0, rows: 5000 })
  // 五 · **恰好顶到不算截**（对照吸收）：树上正好 3 条文件、后面一条都没有——循环自然走完，
  //     两条都是假。这一档与「真的还有第 4 条」（rows: 2 → rows=true）分开，才拦得住
  //     「凑巧顶到就报截尾」那个变异。
  const exact = await createWalk(fakeWalk(tree).view, { depth: 24, rows: 3 })()
  assert.equal(exact.length, 3, '这一棵树上一共 3 条文件')
  assert.equal(walkCutOf(exact)?.rows, false, '正好 3 条、没有第 4 条：那不是截')
  const short = await createWalk(fakeWalk(tree).view, { depth: 24, rows: 2 })()
  assert.equal(short.length, 2)
  assert.equal(walkCutOf(short)?.rows, true, '还有第 3 条没列出来：那是截了')
  // 六 · **名额只被候选（文件）用掉**（对照吸收）：收满之后往后看，看到的全是软链 / gitlink——
  //     一个候选都没漏，那就不是截尾。判据要摆在「跳过非候选」**之后**，否则这一档会把该报绿的
  //     报成截尾（对照那一支的同一条判据在同一个位置）。
  const tailOnly: Record<string, readonly DirRow[]> = {
    '': [row('a.ts', 'file'), row('b.ts', 'file'), row('link', 'symlink'), row('sub', 'gitlink')],
  }
  const noLoss = await createWalk(fakeWalk(tailOnly).view, { depth: 24, rows: 2 })()
  assert.deepEqual([...noLoss], ['a.ts', 'b.ts'])
  assert.equal(walkCutOf(noLoss)?.rows, false, '收满之后只剩软链与 gitlink：一个候选都没漏，那不是截')
  // 与上面那一档配成一对：同一个位置上真有一条文件，就是截——两档都断，单看一档会放过「一律不报截」。
  const realLoss: Record<string, readonly DirRow[]> = {
    '': [row('a.ts', 'file'), row('b.ts', 'file'), row('link', 'symlink'), row('c.ts', 'file')],
  }
  const lost = await createWalk(fakeWalk(realLoss).view, { depth: 24, rows: 2 })()
  assert.deepEqual([...lost], ['a.ts', 'b.ts'])
  assert.equal(walkCutOf(lost)?.rows, true, '软链后面还有第三条文件：那是截了')
  // 七 · 机制缺席：手搓的清单没有这份读数——不猜、不报错。
  assert.equal(walkCutOf(Object.freeze(['x.ts'])), null, '不是枚举出来的清单就是没有读数')
  console.log(
    '④ 读数：全走 rows=false/depth=false · 条数 1 → rows=true · 深度 0 → depth=true' +
      ' · 正顶到 3 条 → rows=false · 差一条（3 条只要 2）→ rows=true' +
      ' · 尾上只有软链/gitlink → rows=false · 尾上还有一条文件 → rows=true · 手搓清单 null',
  )
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

// ── ⑤ 清单里那两栏（id · 字节数）──────────────────────────────────────────────

test('⑤ 清单里带着 id 与字节数：与 view.list 的行同源 · 代变跟着换 · 手搓清单没有', async () => {
  // 一 · 纯机制：行里给了就收下，没给就没有（查询接线据此不接线）。
  const withIds = fakeWalk({
    '': [
      { name: 'a.ts', kind: 'file', id: 'aa', size: 5 },
      { name: 'd', kind: 'dir' },
    ],
    d: [
      { name: 'b.ts', kind: 'file', id: 'bb', size: 7 },
      { name: 'link', kind: 'symlink', id: 'cc', size: 3 },
    ],
  })
  const walked = await createWalk(withIds.view, { depth: 24, rows: 5000 })()
  const rows = walkRowsOf(walked)
  assert.deepEqual([...(rows?.ids ?? new Map())], [['a.ts', 'aa'], ['d/b.ts', 'bb']])
  assert.deepEqual([...(rows?.sizes ?? new Map())], [['a.ts', 5], ['d/b.ts', 7]])
  assert.equal(rows?.ids.has('d/link'), false, '软链不进清单，也就不该有它那一栏')

  const bare = await createWalk(fakeWalk({ '': [row('a.ts', 'file')] }).view, { depth: 24, rows: 5000 })()
  assert.equal(walkRowsOf(bare)?.ids.size, 0, '行里没给 id：那一栏就是空的（查询接线据此回扫描）')
  assert.equal(walkRowsOf(Object.freeze(['x.ts'])), null, '不是枚举出来的清单就是没有这两栏')

  // 二 · 真视图：与 `view.stat` 逐条相同，而且代一变就跟着换（内容变了 → 新 id）。
  const b = await bench()
  try {
    await b.host.writeBytes('a.ts', asBytes('第一份\n'))
    const first = await b.host.walk()
    const rows1 = walkRowsOf(first)
    for (const p of first) {
      const meta = await b.view.stat(p as RelPath)
      assert.equal(rows1?.ids.get(p), meta?.id, `${p} 的 id 与 view.stat 不一致`)
      assert.equal(rows1?.sizes.get(p), meta?.size, `${p} 的字节数与 view.stat 不一致`)
    }
    await b.host.writeBytes('a.ts', asBytes('第一份改过了，写长一点\n'))
    const second = await b.host.walk()
    const rows2 = walkRowsOf(second)
    assert.notEqual(rows2?.ids.get('a.ts'), rows1?.ids.get('a.ts'), '内容改了，id 该换一个')
    assert.ok((rows2?.sizes.get('a.ts') ?? 0) > (rows1?.sizes.get('a.ts') ?? 0), '写长了，字节数该跟着长')
    assert.equal(walkRowsOf(first)?.ids.get('a.ts'), rows1?.ids.get('a.ts'), '旧那一份清单的读数不许被后来的走树改写')
    console.log(`⑤ 读数：${first.length} 条路径的 id 与字节数逐条对上 view.stat · 改写一份之后 id 换新`)
  } finally {
    await b.close()
  }
})
