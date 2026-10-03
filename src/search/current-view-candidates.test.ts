// 不缓存 path→blob；每批当前 View 元数据相交，变代/不确定就退回原批。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_INDEX_REQUIREMENTS, filterCurrentViewCandidates } from './current-view-candidates.ts'
import type { CandidateIndexLookup, CandidateView } from './current-view-candidates.ts'
import type { BlobId, CommitId, RelPath, ViewRev } from '../terms.ts'
import type { EntryMeta } from '../entries.ts'

const old = '1'.repeat(40)
const hit = '2'.repeat(40)
function viewOf(initial: Record<string, string>) {
  const ids = new Map(Object.entries(initial))
  const view = {
    base: 'a'.repeat(40) as CommitId,
    rev: 0 as ViewRev,
    stat: async (path: RelPath): Promise<EntryMeta | null> => ids.has(path) ? { kind: 'file', id: ids.get(path)! as BlobId, mode: 0o100644, size: 10 } : null,
  } satisfies CandidateView
  const change = () => { view.rev = (Number(view.rev) + 1) as ViewRev }
  return { view, ids, change }
}
const lookup: CandidateIndexLookup = async blob => blob === hit
const required = ['hit']

test('only validated exclusions of current file BlobIds prune candidates in stable input order', async () => {
  const b = viewOf({ a: old, b: hit, c: old, d: hit })
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['a', 'b', 'c', 'd'], required, lookup), ['b', 'd'])
})

test('view modifications and two independent hosts never reuse path-to-blob decisions', async () => {
  const a = viewOf({ file: old })
  const b = viewOf({ file: hit })
  assert.deepEqual(await filterCurrentViewCandidates(a.view, ['file'], required, lookup), [])
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['file'], required, lookup), ['file'])
  a.ids.set('file', hit); a.change()
  assert.deepEqual(await filterCurrentViewCandidates(a.view, ['file'], required, lookup), ['file'])
  a.ids.delete('file'); a.change()
  assert.deepEqual(await filterCurrentViewCandidates(a.view, ['file'], required, lookup), ['file'], 'missing metadata must fall back, not claim an indexed exclusion')
  a.ids.set('file', old); a.change()
  assert.deepEqual(await filterCurrentViewCandidates(a.view, ['file'], required, lookup), [])
})

test('generation or base changes during index work revert the whole batch, including prior negatives', async () => {
  for (const field of ['rev', 'base']) {
    const b = viewOf({ first: old, second: old })
    let calls = 0
    const racing: CandidateIndexLookup = async () => {
      calls++
      if (calls === 2) {
        b.ids.set('first', hit)
        if (field === 'rev') b.change()
        else b.view.base = 'b'.repeat(40) as CommitId
      }
      return false
    }
    assert.deepEqual(await filterCurrentViewCandidates(b.view, ['first', 'second'], required, racing), ['first', 'second'])
  }
})

test('null, exceptions, invalid metadata and non-boolean decisions cannot exclude a path', async () => {
  const b = viewOf({ a: old, b: hit, invalid: 'not-an-object-id' })
  const uncertain = async () => null
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['a', 'b'], required, uncertain), ['a', 'b'])
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['a'], required, async () => { throw new Error('index unavailable') }), ['a'])
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['a'], required, async () => 0 as never), ['a'])
  let queried = 0
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['invalid'], required, async () => { queried++; return false }), ['invalid'])
  assert.equal(queried, 0)
})

test('empty/invalid requirements stay on the scan path without index work', async () => {
  const b = viewOf({ a: old })
  let calls = 0
  let metadataReads = 0
  const stat = b.view.stat
  b.view.stat = async path => { metadataReads++; return stat(path) }
  const noCall: CandidateIndexLookup = async () => { calls++; return false }
  for (const grams of [[], ['ab'], ['abcd'], new Array<string>(1), Array(MAX_INDEX_REQUIREMENTS + 1).fill('hit')]) {
    assert.deepEqual(await filterCurrentViewCandidates(b.view, ['a'], grams, noCall), ['a'])
  }
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['a'], Array(MAX_INDEX_REQUIREMENTS).fill('hit'), noCall), [])
  assert.equal(calls, 1, 'exactly the requirement ceiling still queries the index')
  assert.equal(metadataReads, 1)
})

test('candidate lists longer than one index batch are still filtered, not silently passed through', async () => {
  const ids: Record<string, string> = {}
  for (let at = 0; at < 300; at++) ids[`f${at}`] = at % 2 ? hit : old
  const b = viewOf(ids)
  const paths = Object.keys(ids)
  let calls = 0
  const counted: CandidateIndexLookup = async blob => { calls++; return blob === hit }
  const kept = await filterCurrentViewCandidates(b.view, paths, required, counted)
  assert.equal(calls, 300, 'walk() hands over up to MAX_ROWS paths; none of them may skip the index')
  assert.deepEqual(kept, paths.filter((_, at) => at % 2 === 1))
})

test('a generation change in a later part of a long list still reverts the earlier negatives', async () => {
  const ids: Record<string, string> = {}
  for (let at = 0; at < 300; at++) ids[`f${at}`] = old
  const b = viewOf(ids)
  const paths = Object.keys(ids)
  let calls = 0
  const racing: CandidateIndexLookup = async () => { if (++calls === 200) b.change(); return false }
  assert.deepEqual(await filterCurrentViewCandidates(b.view, paths, required, racing), paths)
})

test('rename, mode-only generation changes and tombstone recreation use the newly supplied view set', async () => {
  const b = viewOf({ 'dir/file': hit })
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['dir/file'], required, lookup), ['dir/file'])
  b.ids.delete('dir/file'); b.ids.set('renamed', hit); b.change()
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['renamed'], required, lookup), ['renamed'])
  b.change() // chmod increments generation but retains immutable content ID.
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['renamed'], required, lookup), ['renamed'])
  b.ids.delete('renamed'); b.change()
  assert.deepEqual(await filterCurrentViewCandidates(b.view, [], required, lookup), [])
  b.ids.set('dir/new', hit); b.change()
  assert.deepEqual(await filterCurrentViewCandidates(b.view, ['dir/new'], required, lookup), ['dir/new'])
})

test('non-file or broken metadata remains on the ordinary scan path without following links', async () => {
  let calls = 0
  const noQuery: CandidateIndexLookup = async () => { calls++; return false }
  for (const kind of ['dir', 'symlink', 'gitlink']) {
    const b = viewOf({ a: old })
    b.view.stat = async () => ({ kind, id: old, mode: 0o120000, size: 10 }) as never
    assert.deepEqual(await filterCurrentViewCandidates(b.view, ['a'], required, noQuery), ['a'])
  }
  const broken = viewOf({ a: old })
  broken.view.stat = async () => { throw new Error('view unavailable') }
  assert.deepEqual(await filterCurrentViewCandidates(broken.view, ['a'], required, noQuery), ['a'])
  assert.equal(calls, 0)
})

test('caller mutations of path/requirement arrays cannot change an in-flight batch', async () => {
  const b = viewOf({ a: old, b: hit })
  const paths = ['a', 'b']
  const grams = ['hit']
  const seen: string[][] = []
  const mutate: CandidateIndexLookup = async (blob, required) => {
    seen.push([...required])
    paths.length = 0
    grams[0] = 'bad'
    return blob === hit
  }
  assert.deepEqual(await filterCurrentViewCandidates(b.view, paths, grams, mutate), ['b'])
  assert.deepEqual(seen, [['hit'], ['hit']])
})

test('candidate lookups run with four bounded lanes and preserve order after out-of-order completion', async () => {
  const b = viewOf(Object.fromEntries(Array.from({ length: 12 }, (_, at) => [`file-${at}`, (at + 1).toString(16).padStart(40, '0')])))
  const releases: (() => void)[] = []
  let blocking = true
  let active = 0
  let peak = 0
  let calls = 0
  const probe: CandidateIndexLookup = async blob => {
    calls++; active++; peak = Math.max(peak, active)
    if (calls <= 4 && blocking) await new Promise<void>(done => { releases.push(done) })
    active--
    return Number.parseInt(blob.slice(-2), 16) % 2 === 0
  }
  const paths = [...b.ids.keys()]
  const pending = filterCurrentViewCandidates(b.view, paths, required, probe)
  try {
    await new Promise<void>(done => setImmediate(done))
    assert.equal(calls, 4, 'only the four active lanes may enter a blocked optional provider')
    assert.equal(peak, 4)
  } finally { blocking = false; for (const release of releases.reverse()) release() }
  assert.deepEqual(await pending, paths.filter((_, at) => at % 2 === 1))
  assert.equal(calls, 12)
  assert.equal(peak, 4)
  assert.equal(active, 0)
})

test('generation rollback stops future scheduling and observes every already-started probe', async () => {
  const b = viewOf(Object.fromEntries(Array.from({ length: 12 }, (_, at) => [`file-${at}`, old])))
  const releases: (() => void)[] = []
  let calls = 0
  let returned = false
  const pending = filterCurrentViewCandidates(b.view, [...b.ids.keys()], required, async () => {
    calls++
    await new Promise<void>(done => { releases.push(done) })
    return false
  }).then(result => { returned = true; return result })
  try {
    await new Promise<void>(done => setImmediate(done))
    assert.equal(calls, 4)
    b.change()
    releases[0]()
    await new Promise<void>(done => setImmediate(done))
    assert.equal(calls, 4, 'stale batch must not queue the remaining eight candidates')
    assert.equal(returned, false, 'already-started optional calls remain observed before returning')
  } finally {
    b.change() // 断言失败也阻止新排队，并释放本测试已经打开的口。
    for (const release of releases) release()
  }
  assert.deepEqual(await pending, [...b.ids.keys()])
})

test('out-of-order strict false/null/error/true probes retain exact original candidate ordering', async () => {
  const b = viewOf(Object.fromEntries(Array.from({ length: 4 }, (_, at) => [`file-${at}`, (at + 1).toString(16).padStart(40, '0')])))
  const releases: (() => void)[] = []
  const completed: number[] = []
  let blocking = true
  const pending = filterCurrentViewCandidates(b.view, [...b.ids.keys()], required, async blob => {
    if (blocking) await new Promise<void>(done => { releases.push(done) })
    const id = Number.parseInt(blob.slice(-2), 16)
    completed.push(id)
    if (id === 1) return false
    if (id === 2) return null
    if (id === 3) throw new Error('optional query failed')
    return true
  })
  try {
    await new Promise<void>(done => setImmediate(done))
    assert.equal(releases.length, 4)
  } finally {
    blocking = false
    for (const release of releases.reverse()) release()
  }
  assert.deepEqual(await pending, ['file-1', 'file-2', 'file-3'])
  assert.deepEqual(completed, [4, 3, 2, 1])
})

test('sticky stale state prevents later backend work even if a nonstandard generation reverts', async () => {
  const b = viewOf({ a: old, b: old, c: old, d: old, e: old })
  const originalRev = b.view.rev
  const stat = b.view.stat
  const releases: (() => void)[] = []
  let queries = 0
  b.view.stat = path => new Promise<EntryMeta | null>(done => {
    releases.push(() => { void stat(path).then(done) })
  })
  const pending = filterCurrentViewCandidates(b.view, [...b.ids.keys()], required, async () => { queries++; return false })
  try {
    await new Promise<void>(done => setImmediate(done))
    assert.equal(releases.length, 4)
    b.change(); releases[0]()
    await new Promise<void>(done => setImmediate(done))
    b.view.rev = originalRev // 真实 View 单调；外部适配器仍不能消掉已检测的 stale。
    for (const release of releases.slice(1)) release()
    assert.deepEqual(await pending, [...b.ids.keys()])
    assert.equal(queries, 0)
    assert.equal(releases.length, 4)
  } finally {
    b.change()
    for (const release of releases) release()
  }
})

test('the requirement cap is the extractor\'s output cap, not a second 128', async () => {
  const { MAX_REQUIRED_TRIGRAMS } = await import('./regex-literal.ts')
  assert.equal(MAX_INDEX_REQUIREMENTS, MAX_REQUIRED_TRIGRAMS, '提取器产出比过滤接受的多，条件就静默作废；反过来则是死上限')
})
