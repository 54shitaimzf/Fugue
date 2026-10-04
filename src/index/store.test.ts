// 索引在盘上的那一层：全量构建走得通 · 损坏即重建 · 退化档不抛 · 开销账 · 派生体的边界。
// 出处：ROADMAP § 4 的「索引落盘格式」那一行与 § 9 的「索引与真源解耦」那一格；退化档那几条。跑法：
//   cd ~/fugue && node --test src/index/store.test.ts
//
//   ① 全量构建走通：真 git 仓 · 真视图 · 真真源 → `.fugue/idx/trigram.idx`，候选集对照真源全扫
//   ② **损坏一份分片 → 重建后查询等价**（本站验收句）：四种坏法各来一次
//      对手：一个"读到坏字节照用"的读者（`readIndex` 会给出一份错的索引，而不是 `null`）
//   ③ 版本认不出当损坏：跳一个字节，读的一侧给 `null`，重建之后照旧等价
//   ④ 缺席 → `null` → 重建；`.fugue/idx` 落不下去时照样能用（地板 = 变慢，不是跑不起来）
//   ⑤ 开销账：开一份索引只读头部与节表 · 拿选择性只再读字典那一节 · 候选才读全
//      对手：一个"打开就整份读进来"的读者——固定开销瘦身那条路会被它堵死
//   ⑥ 派生体的边界：不进视图 · 不进日志 · 不进工作树（`git check-ignore` 那一格管"不进提交"）
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog } from '../log/log.ts'
import { createRoots } from '../roots/roots.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import { lowerAt } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import { snapshotOf } from '../view/snapshot.ts'
import type { View } from '../view/contract.ts'
import { HEADER_BYTES, SECTION, SECTION_ENTRY_BYTES, decodeIndexHeader, sectionRefOf } from './format.ts'
import {
  IDX_FILE_NAME,
  buildFrom,
  idxFileOf,
  indexExists,
  openIndexAt,
  openOrRebuild,
  readIndex,
  rebuildIndex,
  sourceOfView,
  writeIndex,
} from './store.ts'
import type { BlobSource } from './store.ts'
import { decodeTrigram } from './trigram.ts'
import type { Trigram, TrigramIndex } from './trigram.ts'
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

const asBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

/** 一份语料：几个真源文件（含一份空文件、一份恰好三个字节的、一份中文的）。 */
const CORPUS: Record<string, string> = {
  'a.ts': 'export function openIndexAt(path) {\n  // 三字组 postings\n}\n',
  'b.ts': 'const postings = buildTrigram(blobs)\nconst bytes = encodeTrigram(parts)\n',
  'src/c.ts': '导出 索引 落盘 格式 —— trigram postings 键控 blob id\n',
  'src/empty.txt': '',
  'src/abc.txt': 'abc',
  'src/notes.md': 'postings delta varint dictionary fixed width sorted by gram\n',
}

interface Fixture {
  readonly root: string
  readonly view: View
  readonly truth: TruthHandle
  readonly base: CommitId
  readonly blobs: ReadonlyMap<BlobId, Uint8Array>
  readonly source: BlobSource
  readonly close: () => Promise<void>
}

/** 真 git 仓 + 真视图 + 真真源：三条链都走产品那一条路。 */
async function fixture(files: Record<string, string> = CORPUS): Promise<Fixture> {
  const root = tmpDir('fugue-idx-')
  execFileSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV })
  const build = openTruth(root)
  const entries = []
  const blobs = new Map<BlobId, Uint8Array>()
  for (const [name, text] of Object.entries(files)) {
    const bytes = asBytes(text)
    const id = (await build.putBlob(bytes)) as BlobId
    blobs.set(id, bytes)
    entries.push({ name, mode: 0o100644, id })
  }
  const base = (await build.commit(await build.putTree(entries), [], 'corpus')) as CommitId
  await build.close()

  const truth = openTruth(root)
  const log = openLog(root, { write: AGENT, sync: 'never' })
  const view = await loadView(log, AGENT, { lower: lowerAt(truth, base) })
  return {
    root,
    view,
    truth,
    base,
    blobs,
    source: await sourceOfView(view, truth),
    close: async () => {
      await log.close()
      await truth.close()
    },
  }
}

/**
 * 与 `trigram.ts` 同一套算术，这里独立写一遍：**解码之后的文本**里每一个三单元窗口。
 *
 * 不按字节找子串——口径五是"键与匹配器同空间"，这一句就是那条口径在全扫那一侧的对照物。
 */
function textWindows(bytes: Uint8Array): Set<Trigram> {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
  const out = new Set<Trigram>()
  for (let at = 0; at + 3 <= text.length; at++) {
    out.add(text.charCodeAt(at) * 0x1_0000_0000 + text.charCodeAt(at + 1) * 0x1_0000 + text.charCodeAt(at + 2))
  }
  return out
}

const gramOf = (s: string): Trigram =>
  s.charCodeAt(0) * 0x1_0000_0000 + s.charCodeAt(1) * 0x1_0000 + s.charCodeAt(2)

/** 全扫那一侧：这个三字组真正出现在哪些 blob 里。 */
function bruteSet(blobs: ReadonlyMap<BlobId, Uint8Array>, gram: Trigram): string[] {
  return [...blobs]
    .filter(([, bytes]) => textWindows(bytes).has(gram))
    .map(([id]) => id)
    .sort()
}

/** 语料里出现过的三字组，取前 `limit` 个（升序，量的就是同一批）。 */
function gramsOf(blobs: ReadonlyMap<BlobId, Uint8Array>, limit = 60): Trigram[] {
  const all = new Set<Trigram>()
  for (const bytes of blobs.values()) for (const gram of textWindows(bytes)) all.add(gram)
  return [...all].sort((a, b) => a - b).slice(0, limit)
}

/** 一份索引在给定这一批三字组上的全部答案（逐字节可比的形状）。 */
function answerTable(index: TrigramIndex, grams: readonly Trigram[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const g of grams) out[String(g)] = [...index.candidatesOf(g)]
  return out
}

/** 日志目录里有什么、各自多少字节（**名字与字节一起照**：少一件与多一件都算动了）。 */
function logSnapshot(root: string): [string, string][] {
  const dir = join(root, '.fugue', 'log')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.sort().map((n) => [n, readFileSync(join(dir, n)).toString('base64')] as [string, string])
}

/** 工作树里除了 `.git` 之外的东西（相对路径，升序）。 */
function treeUnder(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map((p) => String(p).replace(/\\/g, '/'))
    .filter((p) => p !== '.git' && !p.startsWith('.git/'))
    .sort()
}

// ── ① 全量构建走通 ─────────────────────────────────────────────────────────

test('① 全量构建走通：工件落在 .fugue/idx/，候选集对照真源全扫', async () => {
  const f = await fixture()
  try {
    const build = await buildFrom(f.source)
    assert.equal(await writeIndex(f.root, build.bytes), true)
    assert.equal(await indexExists(f.root), true)
    const index = await readIndex(f.root)
    assert.notEqual(index, null)
    const grams = gramsOf(f.blobs)
    for (const g of grams) assert.deepEqual(index!.candidatesOf(g), bruteSet(f.blobs, g))
    // blob 表就是这一棵树里的全部 blob（含空文件与那份恰好三个字节的）。
    assert.equal(index!.blobIds.length, new Set(await f.source.ids()).size)
    assert.equal(index!.blobIds.length, f.blobs.size)
    console.log(
      `① 读数：语料 ${build.sourceBytes} 字节 / ${build.blobCount} 份 blob → 工件 ${build.artifactBytes} 字节` +
        `（字典 ${build.dictBytes} · postings ${build.postingsBytes}）· ${build.gramCount} 个三字组 ·` +
        ` 三字组量的是 ${build.textUnits} 个单元`,
    )
  } finally {
    await f.close()
  }
})

// ── ② 损坏一份分片 → 重建后查询等价 ────────────────────────────────────────

test('② 损坏一份分片 → 重建后查询等价：四种坏法各来一次', async () => {
  const f = await fixture()
  try {
    const fresh = await rebuildIndex(f.root, f.source)
    assert.equal(fresh.wrote, true)
    const grams = gramsOf(f.blobs)
    const before = answerTable(fresh.index, grams)
    const file = idxFileOf(f.root)
    const good = readFileSync(file)

    const bends: [string, () => void][] = [
      ['中间改一个字节', () => {
        const bent = Uint8Array.prototype.slice.call(good)
        bent[Math.floor(bent.byteLength / 2)] ^= 0xff
        writeFileSync(file, bent)
      }],
      ['截掉一半', () => writeFileSync(file, good.subarray(0, Math.floor(good.byteLength / 2)))],
      ['整份写成零', () => writeFileSync(file, Buffer.alloc(good.byteLength))],
      ['头部版本跳一个字节', () => {
        const bent = Uint8Array.prototype.slice.call(good)
        bent[8] = 0x7f
        writeFileSync(file, bent)
      }],
    ]

    for (const [what, bend] of bends) {
      bend()
      // 一 · 认不出来就是损坏：读的一侧给 null，不硬读。
      assert.equal(await readIndex(f.root), null, `${what}之后 readIndex 该给 null`)
      // 二 · 重建之后**查询等价**：同一批三字组给同一批候选。
      const again = await openOrRebuild(f.root, f.source)
      assert.equal(again.rebuilt, true, `${what}之后该走重建`)
      assert.deepEqual(answerTable(again.index, grams), before, `${what}之后重建的答案与坏之前不同`)
      // 三 · 盘上那一份也真换了：再读一次不再 null。
      assert.notEqual(await readIndex(f.root), null, `${what}之后重建的那一份该读得回来`)
    }
    console.log(`② 读数：四种坏法（改字节 · 截一半 · 写零 · 跳版本）各一次，都在 ${grams.length} 个三字组上逐字节等价`)
  } finally {
    await f.close()
  }
})

// ── ③ 版本认不出 ───────────────────────────────────────────────────────────

test('③ 认不出的版本当损坏：给 null，不是"照今天的布局硬读"', async () => {
  const f = await fixture()
  try {
    await rebuildIndex(f.root, f.source)
    const file = idxFileOf(f.root)
    const bent = Uint8Array.prototype.slice.call(readFileSync(file))
    // 版本那一栏整片换成另一个数（四个字节都改）。
    new DataView(bent.buffer).setUint32(8, 2, true)
    writeFileSync(file, bent)
    assert.equal(await readIndex(f.root), null)
    const again = await openOrRebuild(f.root, f.source)
    assert.equal(again.rebuilt, true)
    const after = Uint8Array.prototype.slice.call(readFileSync(file))
    assert.equal(new DataView(after.buffer).getUint32(8, true), 1, '重建出来的那一份该是今天的版本')
  } finally {
    await f.close()
  }
})

// ── ④ 缺席与落不下去 ───────────────────────────────────────────────────────

test('④ 缺席 → null → 重建；`.fugue/idx` 落不下去时照样能用', async () => {
  const f = await fixture()
  try {
    assert.equal(await indexExists(f.root), false)
    assert.equal(await readIndex(f.root), null)
    const first = await openOrRebuild(f.root, f.source)
    assert.equal(first.rebuilt, true)
    // 第二次读得到，就不该再重建。
    const second = await openOrRebuild(f.root, f.source)
    assert.equal(second.rebuilt, false)
    const sizeOfFirst = first.index.blobIds.length

    // 把 `.fugue/idx` 换成一个普通文件：`mkdir` 落不下去，于是落盘失败——**那是变慢，不是跑不起来**。
    unlinkSync(idxFileOf(f.root))
    rmSync(join(f.root, '.fugue', 'idx'), { recursive: true, force: true })
    writeFileSync(join(f.root, '.fugue', 'idx'), 'not a directory\n')
    const offline = await rebuildIndex(f.root, f.source)
    assert.equal(offline.wrote, false, '落不下去要走 wrote: false，不是抛')
    assert.equal(offline.index.blobIds.length, offline.build.blobCount, '落不下去时内存里那一份照旧能用')
    console.log(
      `④ 读数：缺席 → 重建（${sizeOfFirst} 份 blob）· 落盘失败仍答得出 ${offline.index.gramCount} 个三字组 ·` +
        ` 工件 ${offline.build.artifactBytes} 字节`,
    )
  } finally {
    await f.close()
  }
})

// ── ⑤ 开销账 ───────────────────────────────────────────────────────────────

test('⑤ 开销账：打开只读头部与节表 · 选择性只再读字典 · 候选才读全', async () => {
  const f = await fixture()
  try {
    await rebuildIndex(f.root, f.source)
    const file = idxFileOf(f.root)
    const artifact = readFileSync(file)
    const header = decodeIndexHeader(artifact)
    assert.notEqual(header, null)
    const dictBytes = sectionRefOf(header!, SECTION.dict)!.length
    const headBytes = HEADER_BYTES + header!.sections.length * SECTION_ENTRY_BYTES
    const gram = gramsOf(f.blobs, 1)[0]

    const handle = await openIndexAt(file)
    assert.notEqual(handle, null)
    // 一 · 开的时候只读了头部与节表。
    assert.ok(handle!.bytesRead <= headBytes, `打开读了 ${handle!.bytesRead} 字节，头部加节表只有 ${headBytes}`)
    assert.ok(handle!.bytesRead < artifact.byteLength)
    // 二 · 拿选择性只再读字典那一节——postings 与 blob 表一个字节都没碰。
    assert.equal(await handle!.countOf(gram), bruteSet(f.blobs, gram).length)
    assert.equal(handle!.bytesRead, headBytes + dictBytes, '选择性那一问该只多读字典那一节')
    assert.ok(handle!.bytesRead < artifact.byteLength, '拿选择性不该读完整个工件')
    // 三 · 候选才要 postings 那一节；blob 表在改名时才要。
    await handle!.candidatesOf(gram)
    const afterCandidates = handle!.bytesRead
    assert.ok(afterCandidates <= artifact.byteLength)
    await handle!.blobIds()
    assert.equal(handle!.bytesRead, artifact.byteLength, '三节都取过之后就是整份工件')
    await handle!.close()
    console.log(
      `⑤ 读数：工件 ${artifact.byteLength} 字节（头部+节表 ${headBytes} · 字典 ${dictBytes}）·` +
        ` 打开 ${headBytes} · 拿选择性 ${headBytes + dictBytes} · 全取回来 ${artifact.byteLength}`,
    )
  } finally {
    await f.close()
  }
})

test('⑤ 按需读遇到坏节会抛，不会把坏字节当好字节答出去', async () => {
  const f = await fixture()
  try {
    await rebuildIndex(f.root, f.source)
    const file = idxFileOf(f.root)
    const header = decodeIndexHeader(readFileSync(file))!
    const dict = sectionRefOf(header, SECTION.dict)!
    const bent = Uint8Array.prototype.slice.call(readFileSync(file))
    bent[dict.offset + 1] ^= 0xff
    writeFileSync(file, bent)
    const handle = await openIndexAt(file)
    assert.notEqual(handle, null, '头部与节表还在，开得成')
    await assert.rejects(async () => await handle!.countOf(gramsOf(f.blobs, 1)[0]), /摘要对不上/)
    await handle!.close()
    // 同一份文件走"读一份、关掉"那条路：给 null，不抛。
    assert.equal(await readIndex(f.root), null)
  } finally {
    await f.close()
  }
})

// ── ⑥ 派生体的边界 ─────────────────────────────────────────────────────────

test('⑥ 边界：不进视图 · 不进日志 · 不进工作树 · 不进提交', async () => {
  const f = await fixture()
  try {
    const before = treeUnder(f.root)
    const rev = f.view.rev
    const snapshotBefore = JSON.stringify(await snapshotOf(f.view))
    const logBefore = logSnapshot(f.root)

    await rebuildIndex(f.root, f.source)

    assert.equal(f.view.rev, rev, '建索引不该动视图的代')
    assert.equal(JSON.stringify(await snapshotOf(f.view)), snapshotBefore, '建索引不该动视图的内容')
    assert.deepEqual(logSnapshot(f.root), logBefore, '建索引不该往日志里写一个字节')
    // 工作树里只多出 `.fugue/idx/` 这一件。
    assert.deepEqual(treeUnder(f.root).filter((p) => !before.includes(p)), ['.fugue/idx', `.fugue/idx/${IDX_FILE_NAME}`])
    // 进不了提交：本仓 `.gitignore` 挡住 `.fugue/`（少这一句，工件就会出现在 `git status` 里）。
    const ignored = spawnSync('git', ['check-ignore', '-q', `.fugue/idx/${IDX_FILE_NAME}`], { env: GIT_ENV })
    assert.equal(ignored.status, 0, '`.fugue/idx/` 没被 `.gitignore` 挡住')
    console.log(`⑥ 读数：视图代不动 · 日志 ${logBefore.length} 件不动 · 工作树只多 .fugue/idx/${IDX_FILE_NAME}`)
  } finally {
    await f.close()
  }
})

// ── ⑦ blob 那一侧不自己存原文：读的一侧永远回真源 ──────────────────────────

test('⑦ 真源是 blob：工件里没有原文，删掉真源读不回来', async () => {
  const f = await fixture({ 'only.txt': '唯一的一份内容 unique content' })
  try {
    const build = await buildFrom(f.source)
    // 工件里不含原文那一段：索引存的是三字组与顺序号，不是文本。
    assert.equal(Buffer.from(build.bytes).includes(Buffer.from('unique content')), false)
    const index = decodeTrigram(build.bytes)!
    assert.equal(index.blobIds.length, 1)
    // 顺序号回 id 那一步走的是 blob 表——**没有一处从索引里读原文**。
    assert.deepEqual(index.candidatesOf(gramOf('uni')), [index.blobIds[0]])
  } finally {
    await f.close()
  }
})

test('⑦ sourceOfView 收 file 与 symlink 两类，不收 dir 与 gitlink', async () => {
  const f = await fixture()
  try {
    // 一份文件 · 一份软链（它那个 blob 是目标路径那串文本）· 一条 gitlink（它指的是一个提交）。
    const file = await f.truth.putBlob(asBytes('file content\n'))
    const link = await f.truth.putBlob(asBytes('a.ts'))
    const tree = await f.truth.putTree([
      { name: 'a.ts', mode: 0o100644, id: file },
      { name: 'l.ts', mode: 0o120000, id: link },
      { name: 'sub', mode: 0o160000, id: f.base },
      { name: 'deep/inner.ts', mode: 0o100644, id: file },
    ])
    const base = await f.truth.commit(tree, [f.base], 'symlink and gitlink')
    const log = openLog(f.root, { write: 'agent-2' as AgentId, sync: 'never' })
    const view = await loadView(log, 'agent-2' as AgentId, { lower: lowerAt(f.truth, base) })
    const source = await sourceOfView(view, f.truth)
    const ids = await source.ids()
    // a.ts 与 deep/inner.ts 是同一份内容 ⇒ 同一个 blob，收两条（去重在构建那一侧做）。
    // 顺序是走树的顺序：根那一层排到 `deep` 就地下去，所以名单是 file · file · link。
    assert.deepEqual(ids, [file, file, link])
    // gitlink 那一条不在里面：把提交当 blob 交给 getBlob 会当场红。
    assert.equal(ids.includes(f.base as unknown as BlobId), false)
    await log.close()
  } finally {
    await f.close()
  }
})
