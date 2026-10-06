// 本站构建触发器那一半的断言：**缺省档下这一问建不建 · 建哪一档 · 为什么没建**。
// 跑法：cd ~/fugue && node --test src/search/trigger.test.ts
//
// 语料与 plan.test.ts 同一套写法（纯内存 · 真内容哈希），工件落在真临时根上——这一份量的是触发器的
// 判决与它的账，不掺真真源的 I/O。产品那一条装配（`host.ts` 把触发器接上）与两态等价在
// `query.test.ts` 的缺省翻转那一格；触发器**不接线**时"整体关回今天的形态"在 ⑧。
//
// 每条都点出它的对手；"该建没建"与"不该建建了"这一对在这里各占一半：
//
//   ① 该建：缺席 + 稀疏问 → 建、落盘、同一问改走索引（对手：漏建——查询走了全扫）
//   ② 不该建：短查询（取不出必含三字组）——那一问在触发器之前就回扫描了（对手：白建一份用不上的）
//   ③ 不该建：视图源字节过闸 → 不建，账说得出为什么；同一份清单再问也不重试（对手：首查替人付）
//   ④ 不该建：四条上限里有一条越了 → 不建、指得出哪一条，记过之后不再读（对手：每问重来一次）
//   ⑤ 不用建：盘上那份就是这一组 → 不写盘、不读真源；同一对"清单 + 工件"第三次直接记过
//   ⑥ 该增量：视图多一份 → 只爬新进来的那一份（对手：该增量却全量重建——白读整份真源）
//   ⑦ 该重建：工件截短当损坏 → 全量重建（对手：拿读不回来的一份当命中）
//   ⑧ 地板：不接触发器 = 今天的形态（盘上没有工件就回扫描，一个字节都不往盘上写）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { statSync, truncateSync } from 'node:fs'
import { test } from 'node:test'
import { createPlanner } from './plan.ts'
import type { PlanAsk, SearchPlan, ViewRows } from './plan.ts'
import { TRIGGER_MAX_SOURCE_BYTES, createTrigger } from './trigger.ts'
import { idxFileOf, indexExists } from '../index/store.ts'
import { INDEX_LIMITS } from '../index/budget.ts'
import type { IndexBudgetLimits } from '../index/budget.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { BlobId } from '../terms.ts'

/** 一份纯内存的语料：路径 · 文本 · id（真内容哈希——同一份内容在几条路径上共一个 id）。 */
interface Doc {
  readonly path: string
  readonly text: string
  readonly id: string
}

const hashOf = (text: string): string => createHash('sha1').update(text, 'utf8').digest('hex')
const doc = (path: string, text: string): Doc => ({ path, text, id: hashOf(text) })

/**
 * 窄字母表：8 个符号来回排（三字组种类有上限，工件于是很小、两道闸放得过去），**每份开头一段自己的
 * 编号**（内容各不相同 → 一份 blob 一个 id），末尾再按 `marker` 加一段标记。
 */
function narrow(n: number, size: number, marker: (i: number) => string | null): Doc[] {
  const alphabet = 'abcdefgh'
  const out: Doc[] = []
  for (let i = 0; i < n; i++) {
    let text = `#${i}\n`
    for (let at = 0; at < size; at++) text += alphabet[at % alphabet.length] as string
    const mark = marker(i)
    if (mark !== null) text += mark
    out.push(doc(`f${String(i).padStart(3, '0')}.txt`, text))
  }
  return out
}

/** 大块窄字母表：给"过闸"那一格用（一次 `repeat` 成型，建起来够快；那一格本来也不建）。 */
function bulk(n: number, size: number): Doc[] {
  const body = 'abcdefgh'.repeat(Math.ceil(size / 8)).slice(0, size)
  const out: Doc[] = []
  for (let i = 0; i < n; i++) out.push(doc(`bulk/f${String(i).padStart(3, '0')}.txt`, `blob-${i}\n${body}\n`))
  return out
}

/** 视图那一份名单的两栏（真路径上取自 `view.list` 的行，这里按语料给）。 */
function rowsOfDocs(docs: readonly Doc[]): ViewRows {
  const ids = new Map<string, BlobId>()
  const sizes = new Map<string, number>()
  for (const d of docs) {
    ids.set(d.path, d.id as BlobId)
    sizes.set(d.path, Buffer.byteLength(d.text, 'utf8'))
  }
  return { ids, sizes }
}

/**
 * 一份台子：一个真临时根 + 一份**读了就数**的真源口。
 *
 * `open(now)` 每次都起一套新装配（新 planner · 新的那一笔触发器记账）——所以跨 `open` 的那些格
 * 量的都是触发器自己的判决，不是进程内那笔记账。真实装配里清单是同一个引用（`walk-cache.ts`
 * 硬性三），于是同一代连发的几问共用一笔账：⑧ 与 ⑤ 量的就是那件事。
 */
function bench(docs: readonly Doc[], limits?: IndexBudgetLimits) {
  const root = tmpDir('fugue-trigger-')
  const bodies = new Map<string, Uint8Array>()
  for (const d of docs) bodies.set(d.id, new Uint8Array(Buffer.from(d.text, 'utf8')))
  let reads = 0
  const readBlob = async (id: BlobId): Promise<Uint8Array> => {
    reads += 1
    return bodies.get(id) as Uint8Array
  }
  return {
    root,
    bodies,
    reads: () => reads,
    open(now: readonly Doc[]) {
      const rows = rowsOfDocs(now)
      const walked = now.map((d) => d.path)
      const planner = createPlanner({
        root,
        rowsOf: () => rows,
        ensureIndex: createTrigger({ root, readBlob, limits }),
      })
      return {
        walked,
        plan: (pattern: string): Promise<SearchPlan> => planner(askOf(pattern, walked)),
      }
    },
  }
}

function askOf(pattern: string, walked: readonly string[]): PlanAsk {
  return { pattern, flags: '', walked, targets: walked, earlyStop: true }
}

function pathsOf(plan: SearchPlan): string[] {
  return [...(plan.paths ?? new Set<string>())].sort()
}

const SPARSE = (i: number): string | null => (i === 3 || i === 17 ? 'zzz' : null)

// ── ① 该建 ──────────────────────────────────────────────────────────────────

test('① 缺席 + 稀疏问：建出工件并落盘，同一问改走索引', async () => {
  const docs = narrow(40, 8 * 1024, SPARSE)
  const b = bench(docs)
  assert.equal(await indexExists(b.root), false, '这一格的起点该是"盘上没有工件"')

  const plan = await b.open(docs).plan('zzz')
  // **该建没建**那一半：建了却没走索引（或者压根没建）在这一条上就红。
  assert.equal(plan.why, 'candidates', '建过了却没按索引派发——触发器的账与派发对不上')
  assert.equal(plan.reading.build.kind, 'rebuilt')
  assert.equal(plan.reading.build.freshBlobs, docs.length, '全量重建该把视图里每一份都读一遍')
  assert.ok(plan.reading.build.sourceBytes > 0)
  assert.equal(plan.reading.build.over, null)
  assert.equal(await indexExists(b.root), true, '建了却没落盘')
  assert.deepEqual(pathsOf(plan), ['f003.txt', 'f017.txt'])
  console.log(
    `① 读数：缺席 → 建 ${plan.reading.build.artifactBytes} 字节（读真源 ${plan.reading.build.freshBlobs} 份 / ` +
      `${plan.reading.build.sourceBytes} 字节）→ 同一问 candidates · 路径 ${pathsOf(plan).length} 条`,
  )
})

// ── ②③④ 不该建 ──────────────────────────────────────────────────────────────

test('② 短查询：取不出必含三字组 → 那一问在触发器之前就回扫描，盘上不留工件', async () => {
  const docs = narrow(40, 8 * 1024, SPARSE)
  for (const short of ['ze', '导']) {
    const b = bench(docs)
    const plan = await b.open(docs).plan(short)
    assert.equal(plan.why, 'no-grams')
    // **误建**那一半：把触发器挪到两条早退之前，这一条当场红（盘上会多一份永远用不上的工件）。
    assert.equal(plan.reading.build.kind, 'none', '短查询根本用不着索引，不该建')
    assert.equal(await indexExists(b.root), false, '短查询那一问往盘上写了东西')
    assert.equal(b.reads(), 0, '短查询那一问不该读真源')
  }
  console.log('② 读数：两字与单汉字各一问——no-grams · 账 kind: none · 盘上无工件 · 真源读 0 份')
})

test('③ 超闸：视图源字节过闸 → 不建，账说得出为什么；同一份清单再问也不重试', async () => {
  const docs = bulk(40, 256 * 1024)
  const bytes = docs.reduce((n, d) => n + Buffer.byteLength(d.text, 'utf8'), 0)
  assert.ok(bytes > TRIGGER_MAX_SOURCE_BYTES, `这一格的语料没到闸上（${bytes} 字节）——对照是空话`)
  const b = bench(docs)
  const p = b.open(docs)

  const first = await p.plan('zzz')
  assert.equal(first.why, 'artifact-absent')
  assert.equal(first.reading.build.kind, 'skipped')
  assert.equal(first.reading.build.why, 'over-ceiling')
  assert.equal(first.reading.build.viewBytes, bytes)
  assert.equal(await indexExists(b.root), false, '闸挡住的那一问往盘上写了东西——首查替人付了那一笔')
  assert.equal(b.reads(), 0, '闸挡住的那一问不该读真源')

  // **同一份清单配同一份工件只判一次**：这一笔记账是"越限/落不下去"那两档的刹车，也是这一档的。
  const again = await p.plan('zzz')
  assert.equal(again.reading.build.kind, 'none')
  assert.equal(await indexExists(b.root), false)
  console.log(
    `③ 读数：${bytes} 字节（闸 ${TRIGGER_MAX_SOURCE_BYTES}）→ skipped/over-ceiling · 真源读 ${b.reads()} 份；` +
      '再问一次 kind: none',
  )
})

test('④ 越限：这一组输入建不出来 → 不建、指得出哪一条上限，记过之后不再读', async () => {
  const docs = narrow(24, 4 * 1024, SPARSE)
  const b = bench(docs, { ...INDEX_LIMITS, blobs: 4 })
  const p = b.open(docs)

  const first = await p.plan('zzz')
  assert.equal(first.why, 'artifact-absent')
  assert.equal(first.reading.build.kind, 'skipped')
  assert.equal(first.reading.build.why, 'over-limits')
  assert.equal(first.reading.build.over, 'blobs', '越限要指得出是哪一条')
  assert.equal(await indexExists(b.root), false, '越限那一趟在盘上留了半成品')

  const after = b.reads()
  assert.ok(after > 0, '越限是在收真源的半路上撞上的——一份都没读说明这一格没量到东西')
  const again = await p.plan('zzz')
  assert.equal(again.reading.build.kind, 'none', '越限记过之后不该再判一次')
  assert.equal(b.reads(), after, '越限记过之后不该再读一遍真源')
  console.log(`④ 读数：blobs 上限 4 · 越限 → skipped/over-limits(blobs) · 真源读 ${after} 份；再问一次 kind: none、不再读`)
})

// ── ⑤ 不用建 ────────────────────────────────────────────────────────────────

test('⑤ 盘上那份就是这一组：不写盘、不读真源；同一对"清单 + 工件"第三次直接记过', async () => {
  const docs = narrow(40, 8 * 1024, SPARSE)
  const b = bench(docs)
  const p = b.open(docs)
  assert.equal((await p.plan('zzz')).reading.build.kind, 'rebuilt')

  const before = statSync(idxFileOf(b.root))
  const reads = b.reads()
  const second = await p.plan('zzz')
  assert.equal(second.why, 'candidates')
  // **不用建**：核身份那一趟读的是工件，不是真源；盘上那份的字节与 mtime 都不许动。
  assert.equal(second.reading.build.kind, 'hit')
  assert.equal(b.reads(), reads, '命中那一趟不该读真源')
  const after = statSync(idxFileOf(b.root))
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs, '命中那一趟把工件重写了一遍')

  const third = await p.plan('zzz')
  assert.equal(third.reading.build.kind, 'none', '同一代清单 + 同一份工件该直接记过')
  console.log(`⑤ 读数：三问依次 rebuilt → hit → none（工件 ${before.size} 字节没动 · 真源读 ${reads} 份）`)
})

// ── ⑥⑦ 该增量 / 该重建 ──────────────────────────────────────────────────────

test('⑥ 视图动过：走增量——只爬新进来的那一份，旧的一个字节不读', async () => {
  const docs = narrow(40, 8 * 1024, SPARSE)
  const b = bench(docs)
  await b.open(docs).plan('zzz')
  const afterBuild = b.reads()

  const extra = doc('f040.txt', `${'abcdefgh'.repeat(1024)}\nzzz newcomer\n`)
  b.bodies.set(extra.id, new Uint8Array(Buffer.from(extra.text, 'utf8')))
  const plan = await b.open(docs.concat([extra])).plan('zzz')

  // **该增量却全量重建**那一半：全量那一趟会把 41 份都读一遍，这一条当场红。
  assert.equal(plan.reading.build.kind, 'grown')
  assert.equal(plan.reading.build.freshBlobs, 1)
  assert.equal(b.reads() - afterBuild, 1, '增量只许读新进来的那一份')
  assert.equal(plan.why, 'candidates')
  assert.ok(pathsOf(plan).includes('f040.txt'), '新进来的那一份没进候选——增量出来的那份没罩住视图')
  console.log(
    `⑥ 读数：视图 40 → 41 份 · grown 读真源 ${plan.reading.build.freshBlobs} 份 / ${plan.reading.build.sourceBytes} 字节` +
      `（旧 40 份一个字节没读）· 候选含新进来的那一份`,
  )
})

test('⑦ 工件坏了：截短当损坏 → 全量重建', async () => {
  const docs = narrow(40, 8 * 1024, SPARSE)
  const b = bench(docs)
  await b.open(docs).plan('zzz')
  truncateSync(idxFileOf(b.root), 30)
  const after = b.reads()

  const plan = await b.open(docs).plan('zzz')
  assert.equal(plan.reading.build.kind, 'rebuilt')
  assert.equal(plan.reading.build.freshBlobs, docs.length)
  assert.equal(b.reads() - after, docs.length, '损坏那一趟该走全量重建（每份都读）')
  assert.equal(plan.why, 'candidates')
  console.log(`⑦ 读数：工件截短到 30 字节 → rebuilt（读真源 ${plan.reading.build.freshBlobs} 份）→ candidates`)
})

// ── ⑧ 地板 ──────────────────────────────────────────────────────────────────

test('⑧ 地板：不接触发器就是今天的形态——回扫描，一个字节都不往盘上写', async () => {
  const docs = narrow(40, 8 * 1024, SPARSE)
  const root = tmpDir('fugue-trigger-plain-')
  const rows = rowsOfDocs(docs)
  const walked = docs.map((d) => d.path)
  // 今天的装配形状：只有 root 与 rowsOf（`plan.test.ts` 里每一格都是它）。
  const planner = createPlanner({ root, rowsOf: () => rows })

  const plan = await planner(askOf('zzz', walked))
  assert.equal(plan.why, 'artifact-absent')
  assert.equal(plan.reading.build.kind, 'none')
  assert.equal(plan.paths, null)
  assert.equal(await indexExists(root), false, '没接触发器却往盘上写了东西')
  console.log('⑧ 读数：不接触发器 → artifact-absent · 账 kind: none · 盘上无工件（= 今天的形态）')
})
