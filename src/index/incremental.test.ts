// 增量构建的判据：**只碰新进来的 blob** · **与全量重建逐字节相同** · 退化档。
// 出处：ROADMAP § 4 的增量构建那一行（随读随建 · 只爬新 blob）与它的验收格；底座是 § 9 的
// 「索引在盘格式」那一格（`trigram.idx` v1 冻结——格式面一个字节不动）。跑法：
//   cd ~/fugue && node --test src/index/incremental.test.ts
//
// 两条验收句各有一个点名对手，而且**互相补位**——这一对要一起看：
//
//   · 「与全量重建逐字节相同」抓**分叉**（漏一条 postings · 顺序号映射错一位 · 字典次序错了 ·
//     丢掉的那一份没清掉）。对手是一个"只把旧字节搬过来"的合并。
//   · 「只碰新 blob」抓**假增量**（嘴上增量、手上整库重爬），**也抓"合并坏了就悄悄回全量"**
//     ——回全量那一趟读的是整组，读数当场对不上。少了它，一个只会抛的合并会被全量兜成这样：
//     工件照样对，增量一次都没发生，而断言全绿。
//
//   ① 穷举等价：5 份 blob 的全部 32×32 组（旧组, 新组）配对（含空组与"删光"，且**有成对的
//      blob 共享窗口**），合并与全量重建逐字节相同。**直接调 `mergeTrigram`**（不走
//      `openOrRebuild` 的退化档）：那一条路上"合并抛了"就是红，不会被全量兜住
//   ② 多轮链：定种子随机增删 24 轮，每一轮**落盘的那一份**都与当步全量重建逐字节相同，而且
//      每一轮读的真源恰好是当步新进来的那些
//   ③ 只碰新 blob（读数断言）：加一份只读那一份 · 删一份一个字节都不读 · 换一份只读新那一份
//   ④ 增删分账：`freshBlobs` · `reusedBlobs` · `droppedBlobs` 三个读数逐档对上
//   ⑤ 四条上限在增量路上也报得出那一条，且盘上那一份不动
//   ⑥ 退化档：旧工件读不动（四种坏法）· 没有旧工件 → 回全量重建（整组都读一遍），结果与全量相同
//   ⑦ 真链：真 git 仓 · 真视图 · `sourceOfView`，加一份文件只读那一份，工件与全量重建逐字节相同
//   ⑧ 摘要重算过、形状坏掉的旧工件：读的一侧当损坏，增量那一趟给"走不通"，结果回全量重建
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { openLog } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { lowerAt } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import { INDEX_LIMITS } from './budget.ts'
import type { IndexBudgetLimits } from './budget.ts'
import { CODEC, SECTION, encodeIndex } from './format.ts'
import { buildFrom, growIndex, idxFileOf, openOrRebuild, rebuildIndex, sourceOfView } from './store.ts'
import type { BlobSource } from './store.ts'
import {
  ArtifactShapeError,
  GRAM_RECORD_BYTES,
  buildTrigram,
  encodeTrigram,
  mergeTrigram,
  sectionsOf,
} from './trigram.ts'
import type { BlobBytes, Trigram } from './trigram.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { AgentId, BlobId, CommitId } from '../terms.ts'

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

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))
/** 内容的名字：**键控 blob id**（增量复用旧工件那一侧的贡献，靠的就是这一条）。 */
const idOf = (bytes: Uint8Array): BlobId => createHash('sha256').update(bytes).digest('hex') as BlobId

/** 一份内容池：id → 字节。语料都是常量，id 因此在一趟跑里稳定。 */
function poolOf(texts: readonly string[]): Map<BlobId, Uint8Array> {
  return new Map(texts.map((text) => [idOf(bytesOf(text)), bytesOf(text)] as [BlobId, Uint8Array]))
}

function blobsOf(pool: ReadonlyMap<BlobId, Uint8Array>, ids: readonly BlobId[]): BlobBytes[] {
  return ids.map((id) => ({ id, bytes: pool.get(id) as Uint8Array }))
}

/** 只认这一组 id 的源。**读不在名单里的那一份当场抛**——假增量那一路会露出来。 */
function sourceOf(pool: ReadonlyMap<BlobId, Uint8Array>, ids: readonly BlobId[]): BlobSource {
  return {
    ids: async () => ids,
    read: async (id) => {
      const bytes = pool.get(id)
      if (bytes === undefined) throw new Error(`源里没有这一份 blob：${id}`)
      return bytes
    },
  }
}

/** 真源那一侧的账：这一趟读了哪些 id · 几个字节。 */
interface Counting extends BlobSource {
  readonly reads: BlobId[]
  readonly bytes: number
}

function counting(inner: BlobSource): Counting {
  const out = {
    reads: [] as BlobId[],
    bytes: 0,
    ids: () => inner.ids(),
    read: async (id: BlobId) => {
      const bytes = await inner.read(id)
      out.reads.push(id)
      out.bytes += bytes.byteLength
      return bytes
    },
  }
  return out
}

/** 两份字节逐字节相同吗。**不同就报第一处不同的位置与两边的摘要**——不是一长串数组。 */
function assertSameBytes(got: Uint8Array, want: Uint8Array, what: string): void {
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  if (a.equals(b)) return
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1
  const mark = (x: Buffer): string => createHash('sha256').update(x).digest('hex').slice(0, 16)
  assert.fail(
    `${what}：两份工件不同——${a.length} 对 ${b.length} 字节，第一处不同在第 ${at} 个；sha256 ${mark(a)} 对 ${mark(b)}`,
  )
}

/** 定种子：链上每一轮做什么可复现（不然红了没法重放）。 */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** 一份够杂的池：共享窗口 · 中文 · 空文件 · 恰好三个单元 · 互不相同的尾巴。 */
const TEXTS = [
  'alpha beta gamma\n',
  'beta gamma delta\n',
  'gamma delta epsilon\n',
  'trigram postings 索引\n',
  '',
  'ab',
  'abc',
  'delta epsilon zeta 中文注释\n',
  'zzz yyy xxx\n',
  '同一个键控 blob id\n',
  'shared window abc\n',
  'shared window abcd\n',
]

// ── ① 穷举等价 ─────────────────────────────────────────────────────────────

test('① 穷举等价：5 份 blob 的 32×32 组配对，合并与全量重建逐字节相同', () => {
  // 这份语料**故意让几份 blob 共享窗口**，还带一个空文件与一个短于三个单元的：不共享的话，
  // "两路都有这个 gram"那一支一次都走不到，而"漏掉新解那一半"正是这一条要抓的对手
  // （负对照实测抓到过这一格空转——头一版语料里 16×16 组配对没有一组共享窗口）。
  const pool = poolOf(['', 'ab', 'abc xyz', 'abc xyz more', 'xyz 中文 abc'])
  const universe = [...pool.keys()].sort()
  /** 子集 → 全量那一趟的字节（**同一份语料只算一次**，全量那一侧因此不是每条断言都重算）。 */
  const whole = new Map<string, Uint8Array>()
  /** 子集 → 它那些 gram 键（给"这一格没空转"那一条读数用）。 */
  const keys = new Map<string, Set<Trigram>>()
  const keyOf = (ids: readonly BlobId[]): string => [...ids].sort().join(',')
  const rebuilt = (ids: readonly BlobId[]): Uint8Array => {
    const key = keyOf(ids)
    const hit = whole.get(key)
    if (hit !== undefined) return hit
    const made = encodeTrigram(buildTrigram(blobsOf(pool, ids)))
    whole.set(key, made)
    return made
  }
  const keysOf = (ids: readonly BlobId[]): Set<Trigram> => {
    const key = keyOf(ids)
    const hit = keys.get(key)
    if (hit !== undefined) return hit
    const made = new Set(buildTrigram(blobsOf(pool, ids)).grams.map((one) => one.gram))
    keys.set(key, made)
    return made
  }
  const subsets: BlobId[][] = []
  for (let mask = 0; mask < 32; mask++) subsets.push(universe.filter((_, i) => (mask & (1 << i)) !== 0))

  let pairs = 0
  let shared = 0
  for (const oldIds of subsets) {
    const old = sectionsOf(rebuilt(oldIds))
    assert.notEqual(old, null, `旧组（${oldIds.length} 份）的工件该读得回来`)
    for (const newIds of subsets) {
      const had = new Set(oldIds)
      const freshIds = newIds.filter((id) => !had.has(id))
      if ([...keysOf(oldIds)].some((gram) => keysOf(freshIds).has(gram))) shared += 1
      const fresh = buildTrigram(blobsOf(pool, freshIds))
      // 名单的**顺序与重复不算差别**：每两对里有一对把名单倒过来喂。
      const keep = pairs % 2 === 0 ? newIds : [...newIds].reverse()
      const merged = encodeTrigram(mergeTrigram(old as NonNullable<typeof old>, fresh, keep))
      assertSameBytes(merged, rebuilt(newIds), `旧 ${oldIds.length} 份 → 新 ${newIds.length} 份`)
      pairs += 1
    }
  }
  assert.ok(shared > 0, '一份共享窗口都没有：两路归并那一支一次都没走到，这条断言是空转')
  console.log(
    `① 读数：${pairs} 组配对（含空组与删光那一档 · ${shared} 组两路都有同一个 gram）逐字节相同 ·` +
      ` 全量那一侧共算了 ${whole.size} 份工件`,
  )
})

// ── ② 多轮链 · 增删 · 乱序 ──────────────────────────────────────────────────

test('② 多轮链：随机增删 24 轮，每轮落盘的那一份与当步全量重建逐字节相同', async () => {
  const pool = poolOf(TEXTS)
  const universe = [...pool.keys()].sort()
  const root = tmpDir('fugue-idx-grow-')
  const dice = prng(20261004)
  let live: BlobId[] = universe.slice(0, 5)
  let previous: BlobId[] = [] // 盘上那一份说的那一组（第一轮盘上什么都没有）
  let increments = 0
  let fulls = 0

  for (let round = 1; round <= 24; round++) {
    const counts = counting(sourceOf(pool, live))
    const outcome = await openOrRebuild(root, counts)
    if (!outcome.ready) throw new Error(`第 ${round} 轮该建得出来，报的是 ${outcome.over}`)
    assertSameBytes(readFileSync(idxFileOf(root)), (await buildFrom(sourceOf(pool, live))).bytes, `第 ${round} 轮`)
    if (previous.length === 0) {
      // 盘上什么都没有那一轮：走的是全量，整组都读。
      assert.equal(counts.reads.length, live.length, `第 ${round} 轮该走全量`)
      fulls += 1
    } else {
      const had = new Set(previous)
      // **这一条抓假增量**：读的必须是当步新进来的那些，一份不多一份不少。
      assert.deepEqual(counts.reads, live.filter((id) => !had.has(id)), `第 ${round} 轮读的真源不是"新进来的那些"（假增量？）`)
      increments += 1
    }
    previous = live

    // 下一轮要变的那些：加一份 / 删一份，两个方向都可能落在 id 序的中段。
    const missing = universe.filter((id) => !live.includes(id))
    if (missing.length > 0 && (live.length <= 1 || dice() < 0.5)) {
      live = [...live, missing[Math.floor(dice() * missing.length)]].sort()
      continue
    }
    const pick = live[Math.floor(dice() * live.length)]
    live = live.filter((id) => id !== pick)
  }
  console.log(
    `② 读数：24 轮（${fulls} 轮全量 + ${increments} 轮增量）· 每轮落盘的工件逐字节等于当步全量重建 ·` +
      ` 每轮读的真源恰好是"新进来的那些"`,
  )
})

// ── ③ 只碰新 blob（读数断言）────────────────────────────────────────────────

test('③ 只碰新 blob：加一份只读那一份 · 删一份一个字节都不读 · 换一份只读新那一份', async () => {
  const pool = poolOf(TEXTS)
  const universe = [...pool.keys()].sort()
  const root = tmpDir('fugue-idx-grow-')
  const start = universe.slice(0, 3)
  const added = universe[3]
  const swapped = universe[4]
  await rebuildIndex(root, sourceOf(pool, start))

  // 加一份：只该读新进来的那一份。
  const plus = counting(sourceOf(pool, [...start, added]))
  const one = await openOrRebuild(root, plus)
  assert.equal(one.ready, true)
  assert.deepEqual(plus.reads, [added], '加一份那一趟只该读新进来的那一份')
  assert.equal(plus.bytes, (pool.get(added) as Uint8Array).byteLength)
  assertSameBytes(readFileSync(idxFileOf(root)), (await buildFrom(sourceOf(pool, [...start, added]))).bytes, '加一份')

  // 删一份：一个字节的真源都不该读（旧工件里那些字节已经在工件里了）。
  const minus = counting(sourceOf(pool, [start[0], start[2], added]))
  const two = await openOrRebuild(root, minus)
  assert.equal(two.ready, true)
  assert.deepEqual(minus.reads, [], '删一份那一趟一个字节的真源都不该读')
  assertSameBytes(readFileSync(idxFileOf(root)), (await buildFrom(sourceOf(pool, [start[0], start[2], added]))).bytes, '删一份')

  // 换一份：删掉一份、加进另一份，只该读新进来的那一个 id。
  const swap = counting(sourceOf(pool, [start[0], added, swapped]))
  const three = await openOrRebuild(root, swap)
  assert.equal(three.ready, true)
  assert.deepEqual(swap.reads, [swapped], '换一份那一趟只该读新进来的那一份')
  assertSameBytes(readFileSync(idxFileOf(root)), (await buildFrom(sourceOf(pool, [start[0], added, swapped]))).bytes, '换一份')
  console.log(
    `③ 读数：加一份读 ${plus.reads.length} 份 / ${plus.bytes} 字节 · 删一份读 ${minus.reads.length} 份 · 换一份读 ${swap.reads.length} 份`,
  )
})

// ── ④ 增删分账 ─────────────────────────────────────────────────────────────

test('④ 增删分账：fresh · reused · dropped 三个读数逐档对上', async () => {
  const pool = poolOf(TEXTS)
  const universe = [...pool.keys()].sort()
  const root = tmpDir('fugue-idx-grow-')
  const start = universe.slice(0, 4)
  await rebuildIndex(root, sourceOf(pool, start))

  const grown = await growIndex(root, sourceOf(pool, [...start, universe[4], universe[5]]))
  assert.notEqual(grown, null)
  assert.deepEqual(
    [grown?.build.freshBlobs, grown?.build.reusedBlobs, grown?.build.droppedBlobs],
    [2, 4, 0],
    '加两份：新读 2 · 接着用 4 · 丢掉 0',
  )
  assert.equal(grown?.build.blobCount, 6)

  const shrunk = await growIndex(root, sourceOf(pool, start))
  assert.deepEqual(
    [shrunk?.build.freshBlobs, shrunk?.build.reusedBlobs, shrunk?.build.droppedBlobs],
    [0, 4, 2],
    '删两份：新读 0 · 接着用 4 · 丢掉 2',
  )
  // 同一组再走一趟：**命中那一态不走构建**（`rebuilt: false`），读数一个字节都不动。
  const again = await openOrRebuild(root, sourceOf(pool, start))
  assert.equal(again.rebuilt, false)
  // 而"盘上什么都没有"那一档：`growIndex` 走不通（给 `null`），调用方回全量。
  assert.equal(await growIndex(tmpDir('fugue-idx-grow-empty-'), sourceOf(pool, start)), null)
  console.log(
    `④ 读数：加两份 [${grown?.build.freshBlobs} / ${grown?.build.reusedBlobs} / ${grown?.build.droppedBlobs}]` +
      ` · 删两份 [${shrunk?.build.freshBlobs} / ${shrunk?.build.reusedBlobs} / ${shrunk?.build.droppedBlobs}]（新读 / 接着用 / 丢掉）`,
  )
})

// ── ⑤ 四条上限 ─────────────────────────────────────────────────────────────

test('⑤ 四条上限在增量路上各报得出那一条，且盘上那一份不动', async () => {
  // 专用池：**每一份都非空**——真源字节那一档要有一条"这一趟读的那一份自己就超了"的输入。
  const pool = poolOf(['aaa bbb ccc\n', 'ddd eee fff\n', 'ggg hhh iii\n', 'jjj kkk lll\n'])
  const universe = [...pool.keys()].sort()
  const root = tmpDir('fugue-idx-grow-')
  const base = universe.slice(0, 3)
  const grown = universe.slice(0, 4)
  await rebuildIndex(root, sourceOf(pool, base))
  const before = readFileSync(idxFileOf(root))

  const over = async (limits: IndexBudgetLimits, what: string): Promise<void> => {
    const outcome = await openOrRebuild(root, sourceOf(pool, grown), limits)
    if (outcome.ready) throw new Error(`${what}那一档该给 ready:false`)
    assert.equal(outcome.over, what)
    assert.equal(readFileSync(idxFileOf(root)).equals(before), true, `${what}越限之后盘上那一份被动了`)
  }
  await over({ ...INDEX_LIMITS, blobs: 3 }, 'blobs')
  await over({ ...INDEX_LIMITS, grams: 1 }, 'grams')
  await over({ ...INDEX_LIMITS, sourceBytes: 1 }, 'source-bytes')
  // 工件字节那一档：旧那一份正好装得下（`before` 就是它的长度），合起来装不下。
  await over({ ...INDEX_LIMITS, artifactBytes: before.byteLength }, 'artifact-bytes')
  // 全量那一趟在同一组输入上给同一条（增量路的越限不是另一套语义）。
  const full = await openOrRebuild(tmpDir('fugue-idx-grow-'), sourceOf(pool, grown), { ...INDEX_LIMITS, blobs: 3 })
  assert.equal(full.ready ? 'ready' : full.over, 'blobs')
  console.log(`⑤ 读数：四条上限各一次（blobs · grams · source-bytes · artifact-bytes），四条都报出那一条且盘上那一份没动`)
})

// ── ⑥ 退化档 ───────────────────────────────────────────────────────────────

test('⑥ 退化档：旧工件读不动 → 回全量重建（整组重读），结果与全量相同', async () => {
  const pool = poolOf(TEXTS)
  const universe = [...pool.keys()].sort()
  const root = tmpDir('fugue-idx-grow-')
  const base = universe.slice(0, 3)
  const grown = universe.slice(0, 5)
  await rebuildIndex(root, sourceOf(pool, base))
  const good = readFileSync(idxFileOf(root))
  const want = (await buildFrom(sourceOf(pool, grown))).bytes

  const bends: [string, (bytes: Buffer) => Buffer][] = [
    ['中间改一个字节', (bytes) => {
      const bent = Buffer.from(bytes)
      bent[Math.floor(bent.length / 2)] ^= 0xff
      return bent
    }],
    ['截掉一半', (bytes) => bytes.subarray(0, Math.floor(bytes.length / 2))],
    ['整份写成零', (bytes) => Buffer.alloc(bytes.length)],
    ['版本跳一个字节', (bytes) => {
      const bent = Buffer.from(bytes)
      bent[8] = 0x7f
      return bent
    }],
  ]
  for (const [what, bend] of bends) {
    writeFileSync(idxFileOf(root), bend(good))
    const counts = counting(sourceOf(pool, grown))
    const outcome = await openOrRebuild(root, counts)
    assert.equal(outcome.ready, true, `${what}之后该重建得出来`)
    assert.equal(outcome.rebuilt, true)
    // **地板是整组重读**：回全量那一趟读的是这一组的每一份，不是"新进来的那些"。
    assert.equal(counts.reads.length, grown.length, `${what}之后该走全量（整组都读）`)
    assertSameBytes(readFileSync(idxFileOf(root)), want, what)
    writeFileSync(idxFileOf(root), good)
  }
  // 盘上干脆没有那一份：同样回全量（`readIndex` 给 null，调用方照旧回扫描或重建）。
  rmSync(idxFileOf(root), { force: true })
  const absent = counting(sourceOf(pool, grown))
  const outcome = await openOrRebuild(root, absent)
  assert.equal(outcome.rebuilt, true)
  assert.equal(absent.reads.length, grown.length)
  assertSameBytes(readFileSync(idxFileOf(root)), want, '工件缺席')
  console.log(`⑥ 读数：四种坏法 + 缺席，五趟都回全量重建（每趟读 ${grown.length} 份真源）· 结果与全量那一趟逐字节相同`)
})

// ── ⑦ 真链：真 git 仓 · 真视图 · 真真源 ─────────────────────────────────────

test('⑦ 真链：加一份文件只读那一份，工件与全量重建逐字节相同', async () => {
  const root = tmpDir('fugue-idx-grow-git-')
  execFileSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV })
  const corpus: Record<string, string> = {
    'a.ts': 'export function alpha(x) {\n  return x + 1\n}\n',
    'b.ts': 'const postings = buildTrigram(blobs)\n',
    'src/c.ts': '导出 索引 落盘 格式 —— trigram postings 键控 blob id\n',
    'src/notes.md': 'postings delta varint dictionary fixed width sorted by gram\n',
  }
  const commit = async (files: Record<string, string>): Promise<CommitId> => {
    const write = openTruth(root)
    const entries = []
    for (const [name, text] of Object.entries(files)) {
      entries.push({ name, mode: 0o100644, id: await write.putBlob(bytesOf(text)) })
    }
    const made = (await write.commit(await write.putTree(entries), [], 'corpus')) as CommitId
    await write.close()
    return made
  }
  const base = await commit(corpus)
  const next = await commit({ ...corpus, 'src/new.ts': 'export function added(y) {\n  return y * 3\n}\n' })

  // 三个句柄一起开、一起收（两个 writer 的锁各是各的）。**收在 `finally` 里**：真源那一层挂着一个
  // 常驻的批量子进程，断言抛在半途而不收句柄的话，这一份文件会挂到 `node --test` 的超时——
  // 报出来的是"Interrupted while running"，不是那条断言（`unwired.test.ts` 记过同一种病）。
  const truth = openTruth(root)
  const logA = openLog(root, { write: AGENT, sync: 'never' })
  const logB = openLog(root, { write: 'agent-2' as AgentId, sync: 'never' })
  try {
    // 第一趟：视图 A（旧提交）→ 全量建一份。
    const viewA = await loadView(logA, AGENT, { lower: lowerAt(truth, base) })
    await rebuildIndex(root, await sourceOfView(viewA, truth))

    // 第二趟：视图 B（新提交）→ 只该读新加的那一份。
    const viewB = await loadView(logB, 'agent-2' as AgentId, { lower: lowerAt(truth, next) })
    const source = await sourceOfView(viewB, truth)
    const counts = counting(source)
    const outcome = await openOrRebuild(root, counts)
    assert.equal(outcome.ready, true)
    assert.equal(counts.reads.length, 1, `加一份文件该只读那一份，读的是 ${counts.reads.length} 份`)
    const onDisk = readFileSync(idxFileOf(root))
    assertSameBytes(onDisk, (await buildFrom(source)).bytes, '真链：加一份文件')
    assert.equal((await source.ids()).length, 5, '这一棵树该有 5 份文件（4 份旧的 + 1 份新的）')
    console.log(
      `⑦ 读数：真视图 5 份文件（${(await source.ids()).length} 个 id）· 增量那一趟只读 ${counts.reads.length} 份 / ${counts.bytes} 字节 ·` +
        ` 工件 ${onDisk.length} 字节与全量重建逐字节相同`,
    )
  } finally {
    await logB.close().catch(() => undefined)
    await logA.close().catch(() => undefined)
    await truth.close().catch(() => undefined)
  }
})

// ── ⑧ 摘要重算过、形状坏掉的旧工件 ─────────────────────────────────────────

test('⑧ 形状坏了但每节摘要都对得上：读的一侧当损坏，增量那一趟走不通（回全量）', async () => {
  // 这一格的对手是**"摘要对得上就是好工件"**：⑥ 那四种坏法挡的是字节被改，挡不住一份
  // **自相矛盾的载荷**——今天的写者造不出它，而"照读不误"的合并会照它合出一份**错的**工件，
  // 错的工件不会自己报错。这里用编码器自己重编（每节摘要由它重算），造出这种工件。
  const pool = poolOf(['abc xyz', 'abc xyz more', 'xyz 中文 abc', 'more 中文 abc'])
  const universe = [...pool.keys()].sort()
  const root = tmpDir('fugue-idx-grow-')
  const base = universe.slice(0, 3)
  await rebuildIndex(root, sourceOf(pool, base))
  const good = new Uint8Array(readFileSync(idxFileOf(root)))
  const want = (await buildFrom(sourceOf(pool, universe))).bytes

  const sections = sectionsOf(good)
  assert.notEqual(sections, null, '这一份基准工件该读得回来')
  const whole = {
    blobs: Uint8Array.prototype.slice.call((sections as NonNullable<typeof sections>).blobs),
    dict: Uint8Array.prototype.slice.call((sections as NonNullable<typeof sections>).dict),
    postings: Uint8Array.prototype.slice.call((sections as NonNullable<typeof sections>).postings),
  }
  /** 换掉一段载荷再重编：**每节摘要由 `encodeIndex` 重算**，坏的是形状不是字节。 */
  const mended = (bodies: typeof whole): Uint8Array =>
    encodeIndex({
      sections: [
        { kind: SECTION.blobs, codec: CODEC.raw, body: bodies.blobs },
        { kind: SECTION.dict, codec: CODEC.raw, body: bodies.dict },
        { kind: SECTION.postings, codec: CODEC.raw, body: bodies.postings },
      ],
    })

  // 一 · 字典长度不是 18 的整数倍：**粗检那一关就当损坏**（`sectionsOf` 给 null）。
  const cut = { ...whole, dict: whole.dict.subarray(0, whole.dict.byteLength - 1) }
  // 二 · 字典不按键升序：把前两条 18 字节记录对调（长度不变、粗检过得去）。
  const swapped = { ...whole, dict: Uint8Array.prototype.slice.call(whole.dict) }
  const first = swapped.dict.slice(0, GRAM_RECORD_BYTES)
  swapped.dict.set(swapped.dict.subarray(GRAM_RECORD_BYTES, 2 * GRAM_RECORD_BYTES), 0)
  swapped.dict.set(first, GRAM_RECORD_BYTES)
  // 三 · 顺序号越出 blob 表：第一条 gram 的顺序号写成 127（这一组只有 4 份 blob）。
  const far = { ...whole, postings: Uint8Array.prototype.slice.call(whole.postings) }
  far.postings[0] = 0x7f

  const bends: [string, typeof whole, boolean][] = [
    ['字典长度不是 18 的整数倍', cut, true],
    ['字典不按键升序', swapped, false],
    ['顺序号越出 blob 表', far, false],
  ]
  for (const [what, bodies, unreadable] of bends) {
    const bent = mended(bodies)
    writeFileSync(idxFileOf(root), bent)
    // 一 · 读的一侧：粗检过不去的那一档整份当损坏；过得去的两档留给合并那一趟认。
    assert.equal(sectionsOf(bent) === null, unreadable, `${what}：sectionsOf 的答案与预期不符`)
    if (!unreadable) {
      const old = sectionsOf(bent) as NonNullable<ReturnType<typeof sectionsOf>>
      const had = new Set(base)
      const fresh = buildTrigram(blobsOf(pool, universe.filter((id) => !had.has(id))))
      assert.throws(
        () => mergeTrigram(old, fresh, universe),
        ArtifactShapeError,
        `${what}：合并那一趟该当场认出形状不对，不许静默合出一份错的`,
      )
    }
    // 二 · 增量那一趟：形状读不出语义 = 走不通（给 null），不是抛出去、更不是照读不误。
    assert.equal(await growIndex(root, sourceOf(pool, universe)), null, `${what}：增量那一趟该给"走不通"`)
    // 三 · 地板走通了：调用方回全量重建，结果与全量那一趟逐字节相同。
    const outcome = await openOrRebuild(root, sourceOf(pool, universe))
    assert.equal(outcome.ready, true)
    assert.equal(outcome.rebuilt, true, `${what}之后该走重建`)
    assertSameBytes(readFileSync(idxFileOf(root)), want, what)
  }
  console.log(`⑧ 读数：三种形状坏法（字典长度 · 字典倒序 · 顺序号越界，摘要都由编码器重算过）· 读的一侧与合并那一趟各自认出 · 三趟都回全量重建且逐字节等于全量`)
})
