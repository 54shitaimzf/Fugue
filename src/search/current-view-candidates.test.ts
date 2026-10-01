// 不缓存 path→blob；每批当前 View 元数据相交，变代/不确定就退回原批。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterCurrentViewCandidates, MAX_INDEX_CANDIDATE_BATCH, MAX_INDEX_REQUIREMENTS } from './current-view-candidates.ts'
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

test('empty/invalid requirements and overlarge batches stay on the scan path without index work', async () => {
  const b = viewOf({ a: old })
  let calls = 0
  let metadataReads = 0
  const stat = b.view.stat
  b.view.stat = async path => { metadataReads++; return stat(path) }
  const noCall: CandidateIndexLookup = async () => { calls++; return false }
  for (const grams of [[], ['ab'], ['abcd'], new Array<string>(1), Array(129).fill('hit')]) {
    assert.deepEqual(await filterCurrentViewCandidates(b.view, ['a'], grams, noCall), ['a'])
  }
  const paths = Array.from({ length: 129 }, (_, index) => `file-${index}`)
  assert.deepEqual(await filterCurrentViewCandidates(b.view, paths, required, noCall), paths)
  assert.equal(calls, 0)
  assert.equal(metadataReads, 0)
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

test('the 128s that must agree do agree: grep batch ≤ filter batch, extractor output ≤ filter requirements', async () => {
  const { SEARCH_PREFETCH_MAX_ROWS } = await import('../tools/search-receipt.ts')
  const { MAX_REQUIRED_TRIGRAMS } = await import('./regex-literal.ts')
  assert.ok(SEARCH_PREFETCH_MAX_ROWS <= MAX_INDEX_CANDIDATE_BATCH, '批比过滤上限大，整批就静默回扫描')
  assert.ok(MAX_REQUIRED_TRIGRAMS <= MAX_INDEX_REQUIREMENTS, '提取器产出比过滤接受的多，条件就静默作废')
})
