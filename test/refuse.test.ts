// 0.2.6 ④：「拒了之后什么都没动」的统一口径（PR15 审查件 § 5 教训 2 · 路线图 0.2.6 行）。
//
// 这一份装两样东西，分开读：
//
//   一 · **助手自己的负对照**——"故意多一个字节 → 红"。助手要是不红，后面那几格全是空话：
//        它们量的是"这两份快照一样吗"，而"两份快照一样吗"这件事本身得先证得动。
//   二 · **四个拒绝位**（在进程里驱动得动的那四个；第五个"边界声明档起跑前拒"要真 bwrap，
//        接在 `src/boundary/policy.test.ts` 的 P1c 那一格上）：
//          · overlay 重开整批拒（`land.ts` 的 `refuseReopen`）
//          · `EnsureRefused`（还没铺过物化树）
//          · 写者锁不是这条句柄持有的那个 writer（`log.ts` 的 `append` 当面报出来）
//          · 执行档不足拒（`reclaim.ts`：树可写而没有 `upper` 可枚举）
//
// **每一格必含三条**（路线图 0.2.6 行 · 崩溃注入矩阵那三条在这一档的对应物）：拒得住 ·
// 旧状态没被改坏 · **下一次操作照常成功**。第三条不是客套：拒绝要是把句柄、序号或锁弄脏了，
// 前两条照样绿。
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Delta } from '../src/delta.ts'
import type { EntryMeta } from '../src/entries.ts'
import { createReclaim, ReclaimRefused } from '../src/execute/reclaim.ts'
import type { LogEvent } from '../src/log/events.ts'
import { openLog } from '../src/log/log.ts'
import { EnsureRefused, ensure } from '../src/materialize/ensure.ts'
import { LandError, landDeltas } from '../src/materialize/land.ts'
import type { LandOptions, ViewReads } from '../src/materialize/land.ts'
import { createRoots } from '../src/roots/roots.ts'
import type { AgentId, RelPath, WriterId } from '../src/terms.ts'
import { assertUnchanged, refusedAndUnchanged, snapshotOf } from './helpers/refuse.ts'
import { tmpDir } from './helpers/tmp.ts'

const AGENT = 'round' as AgentId

/** 一条视图读口：给定的那几条路径上有内容，别处没有。 */
function readsOf(files: Readonly<Record<string, string>>): ViewReads {
  const at = (p: RelPath): { bytes: Buffer; meta: EntryMeta } | null => {
    const body = files[p]
    if (body === undefined) return null
    const bytes = Buffer.from(body, 'utf8')
    const meta = { kind: 'file', mode: 0o100644, size: bytes.length, id: `id-${p}` } as unknown as EntryMeta
    return { bytes, meta }
  }
  return {
    stat: async (p) => at(p)?.meta ?? null,
    read: async (p) => at(p)?.bytes ?? null,
  }
}

const EMPTY_READS: ViewReads = { stat: async () => null, read: async () => null }

// ────────────────────────────────── 一 · 助手自己的负对照

test('0.2.6 ④ 助手 · 什么都没动就不抛（读一遍也算没动）', () => {
  const root = tmpDir('fugue-refuse-idle-')
  mkdirSync(join(root, '.fugue', 'log'), { recursive: true })
  writeFileSync(join(root, '.fugue', 'log', 'round.jsonl'), '{"seq":1}\n')
  writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
  const before = snapshotOf([root])
  readFileSync(join(root, '.fugue', 'log', 'round.jsonl'))
  readFileSync(join(root, 'a.ts'))
  assertUnchanged(before, snapshotOf([root]), '两次快照之间只读过')
})

test('0.2.6 ④ 助手 负对照 · 账多一个字节 → 红（这一条不红，后面几格全是空话）', () => {
  const root = tmpDir('fugue-refuse-neg-')
  mkdirSync(join(root, '.fugue', 'log'), { recursive: true })
  const file = join(root, '.fugue', 'log', 'round.jsonl')
  writeFileSync(file, '{"seq":1}\n') // 10 字节
  const before = snapshotOf([root])
  appendFileSync(file, 'x')
  assert.throws(
    () => assertUnchanged(before, snapshotOf([root]), '账多了一个字节'),
    /账变了 0\|round\.jsonl（10 → 11 字节）/,
  )
})

test('0.2.6 ④ 助手 负对照 · 树里多一条 · 少一条 · 只改模式 → 各自红', () => {
  const root = tmpDir('fugue-refuse-neg2-')
  writeFileSync(join(root, 'a.ts'), 'a\n')

  const before = snapshotOf([root])
  writeFileSync(join(root, 'b.ts'), 'b\n')
  assert.throws(() => assertUnchanged(before, snapshotOf([root]), '树里多了一条'), /多出一条 0\|b\.ts/)

  const before2 = snapshotOf([root])
  unlinkSync(join(root, 'b.ts'))
  assert.throws(() => assertUnchanged(before2, snapshotOf([root]), '树里少了一条'), /少了一条 0\|b\.ts/)

  // **只改模式**：内容一个字节没动，但那是"动了"——`land.ts` 的承重性质量的就是这一维。
  const before3 = snapshotOf([root])
  chmodSync(join(root, 'a.ts'), 0o755)
  assert.throws(() => assertUnchanged(before3, snapshotOf([root]), '只改了模式'), /那一条变了 0\|a\.ts/)
})

// ────────────────────────────────── 二 · 四个拒绝位

test('0.2.6 ④ · overlay 重开整批拒：一条路径都还没动，换一档照落', async () => {
  // 摆出那一支的前提：视图里有一条**墓碑**祖先 `a`，而底里 `a` 还是一个有内容的目录。
  // 一条 whiteout 遮住的是一整棵目录、而它打不开——`refuseReopen` 在**任何一条路径动盘之前**拒。
  const root = tmpDir('fugue-refuse-land-')
  const target = join(root, 'upper')
  const next = join(root, 'merged')
  const lower = join(root, 'lower')
  mkdirSync(target, { recursive: true })
  mkdirSync(next, { recursive: true })
  mkdirSync(join(lower, 'a'), { recursive: true })
  writeFileSync(join(lower, 'a', 'old.ts'), '旧的\n')

  const deltas: Delta[] = [
    { kind: 'add', path: 'a/b.ts' as RelPath, bytes: Buffer.from('新的\n'), mode: 0o100644 },
  ]
  const view: ViewReads = {
    ...readsOf({ 'a/b.ts': '新的\n' }),
    tombstones: () => ['a' as RelPath],
  }
  const optionsAt = (where: string, overlay: boolean): LandOptions => ({
    target: where as LandOptions['target'],
    lower: lower as LandOptions['lower'],
    base: EMPTY_READS,
    overlay,
    whiteout: null,
    pruneEmptyDirs: false,
    view,
  })

  const err = await refusedAndUnchanged(
    () => landDeltas(optionsAt(target, true), new Map(), deltas),
    [root],
    'overlay 重开整批拒',
  )
  assert.ok(err instanceof LandError, `该是 LandError，实得 ${String(err)}`)
  assert.match((err as Error).message, /一条 whiteout 遮住的是下层的一整棵目录/)

  // **下一次操作照常成功**：拒绝不是死路——换另两档的落地根（没有下层会漏回来）照落。
  const out = await landDeltas(optionsAt(next, false), new Map(), deltas)
  assert.deepEqual([...out.landed], ['a/b.ts'])
  assert.equal(readFileSync(join(next, 'a/b.ts'), 'utf8'), '新的\n')
})

test('0.2.6 ④ · EnsureRefused（还没铺过物化树）：账一个字节不动，接着写照走', async () => {
  const root = tmpDir('fugue-refuse-ensure-')
  const log = openLog(root, { sync: 'never' })
  try {
    const write = (i: number): LogEvent =>
      ({ t: 'view/write', agent: AGENT, path: `src/f${i}.ts`, rev: i, blob: `b${i}`, mode: 420 }) as unknown as LogEvent
    assert.equal(await log.append(AGENT, write(1)), 1)
    const view = {
      ...EMPTY_READS,
      rev: 1,
      deltasSince: () => [] as readonly Delta[],
      tombstones: () => [] as readonly RelPath[],
    }
    const err = await refusedAndUnchanged(
      () => ensure({ roots: createRoots(root), log, root, view, base: EMPTY_READS }, AGENT, 1),
      [root],
      'EnsureRefused（还没铺过物化树）',
    )
    assert.ok(err instanceof EnsureRefused, `该是 EnsureRefused，实得 ${String(err)}`)
    assert.match((err as EnsureRefused).why, /还没铺过物化树/)
    // **下一次操作照常成功**：账还写得进（那次拒没把句柄或序号弄脏）。
    assert.equal(await log.append(AGENT, write(2)), 2)
  } finally {
    await log.close()
  }
})

test('0.2.6 ④ · 写者锁不是这条句柄持有的那个 writer：经 log.append 那一趟，账不动、序号不跳', async () => {
  const root = tmpDir('fugue-refuse-writer-')
  // 这条句柄持的是 `round` 的锁（`openLog` 的 `write` 那一栏，`hold.ts`）。
  const log = openLog(root, { sync: 'never', write: AGENT })
  try {
    const write = (i: number): LogEvent =>
      ({ t: 'view/write', agent: AGENT, path: `src/f${i}.ts`, rev: i, blob: `b${i}`, mode: 420 }) as unknown as LogEvent
    assert.equal(await log.append(AGENT, write(1)), 1)

    const err = await refusedAndUnchanged(
      // 持着 `round` 的锁却往 `other` 里追加——"一次命令只写一个 writer"这条规矩被违反。
      // （这一格原先量的是编码器那道保留字拒；0.2.9 ⑥ 把那道撤了，判据搬到声明那一侧，
      // 这一格改成量同一层上另一道真在的拒——它同样是"经 `log.append` 那一趟"。）
      () => log.append('other' as WriterId, write(2)),
      [root],
      '写者锁不是这条句柄持有的那个 writer',
    )
    assert.match((err as Error).message, /这条句柄持的是 round 的锁，却要往 other 的日志里追加/)

    // **下一次操作照常成功，而且序号没被那次拒跳掉**（`nextSeq` 只在写成功之后才往前）。
    assert.equal(await log.append(AGENT, write(2)), 2)
  } finally {
    await log.close()
  }
})

test('0.2.6 ④ · 执行档不足拒（树可写而没有 `upper` 可枚举）：什么都没动', async () => {
  const root = tmpDir('fugue-refuse-reclaim-')
  mkdirSync(join(root, '.fugue', 'log'), { recursive: true })
  writeFileSync(join(root, '.fugue', 'log', 'round.jsonl'), '{"seq":1}\n')
  const err = await refusedAndUnchanged(
    () =>
      createReclaim({
        roots: createRoots(root),
        strategy: 'copy',
        manifest: [],
        landing: 'cache',
        treeOpen: true,
      }).undeclared(AGENT, { agent: AGENT, paths: [] }),
    [root],
    '执行档不足拒（树可写 · 非 overlayfs）',
  )
  assert.ok(err instanceof ReclaimRefused, `该是 ReclaimRefused，实得 ${String(err)}`)
  assert.match((err as Error).message, /查不出声明集外的改动/)

  // **下一次操作照常成功**：换回 overlayfs 那一档（有 `upper` 可枚举）就不拒了——拒的是这一档的
  // 能力，不是这件事本身。
  const ok = createReclaim({
    roots: createRoots(root),
    strategy: 'overlayfs',
    manifest: [],
    landing: 'cache',
    treeOpen: true,
  })
  assert.deepEqual(await ok.undeclared(AGENT, { agent: AGENT, paths: [] }), [])
})
