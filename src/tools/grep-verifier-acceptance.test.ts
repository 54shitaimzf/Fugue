// tier: real —— 真实 Git/Truth/View 的完整正则验证缓存、变更与工具回执。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { truthViewFixture } from '../../test/helpers/truth-view.ts'
import { createToolHost } from './host.ts'
import { createCohortIndexStore } from '../search/cohort-store.ts'
import { createViewCohortLookup } from '../search/view-cohort.ts'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'
import { grepVerificationStats, verifiedGrepMatches } from './grep-verifier.ts'
import { searchLines } from './search-receipt.ts'
import type { AgentId } from '../terms.ts'
import type { Delta } from '../delta.ts'

const grep = faceOf('grep')!, mode = 0o100644
const outputModes = ['content', 'count', 'files_with_matches']
type Fixture = Awaited<ReturnType<typeof truthViewFixture>>
type Target = Awaited<ReturnType<Fixture['target']>>
const context = (t: Target): ToolContext => ({ agent: t.writer as AgentId, step: 0, cwd: '', holder: false })
const stats = (host: ToolHost) => { const result = grepVerificationStats(host); assert.notEqual(result, null); return result! }
function optioned(f: Fixture, t: Target) {
  const store = f.own(createCohortIndexStore(f.root))
  const index = f.own(createViewCohortLookup(t.view, () => t.plain.walk(), store))
  return { index, host: createToolHost(t.view, f.roots, { cohortIndex: index }) }
}
function observed(t: Target) {
  const reads: string[] = [], read = t.view.read.bind(t.view)
  t.view.read = async path => { reads.push(path); return read(path) }
  return reads
}
function ready<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
async function receipt(t: Target, host: ToolHost, args: Record<string, unknown>) {
  const result = await grep(args, host, context(t))
  // A clone has no private reader binding and always uses the original lazy scan.
  assert.deepEqual(result, await grep(args, { ...t.plain }, context(t)))
  return result
}
async function allModes(t: Target, host: ToolHost, pattern = 'needle') {
  for (const output_mode of outputModes) await receipt(t, host, { pattern, output_mode })
}

test('actual immutable aliases share only complete blob/pattern verification while all FaceResults stay exact', async () => {
  const f = await truthViewFixture({ a: 'before\r\nneedle\r\nneedle\r\nafter\r\n', alias: 'before\r\nneedle\r\nneedle\r\nafter\r\n',
    miss: 'other\n', emoji: '😀xy\n', invalid: Buffer.from([0xff, 0x61, 0x62, 10]), falsePositive: 'abc bcd cde def\n', empty: '' })
  try {
    const t = await f.target('alias-pattern'), reads = observed(t), host = optioned(f, t).host
    const result = await grep({ pattern: 'needle' }, host, context(t))
    assert.equal(reads.length, 6, 'seven paths contain six distinct immutable IDs')
    assert.equal(stats(host).hits, 1, 'second alias reuses complete exact verification')
    assert.match(result.output, /a:2:needle\r/); assert.match(result.output, /alias:3:needle\r/)
    assert.deepEqual(result, await grep({ pattern: 'needle' }, { ...t.plain }, context(t)))
    for (const pattern of ['needle', '^needle\\r?$', 'nee.*le', '😀x', '�ab', 'abcdef', 'needle|other', '^$']) {
      await allModes(t, host, pattern)
      const sourceReads = stats(host).sourceReads, testedLines = stats(host).testedLines
      await allModes(t, host, pattern)
      assert.equal(stats(host).sourceReads, sourceReads, 'a completed same-pattern repeat does not read immutable source')
      assert.equal(stats(host).testedLines, testedLines, 'a completed repeat does not run regex lines again')
    }
    assert.equal(grepVerificationStats({ ...host }), null)
  } finally { await f.close() }
})

test('edits, rename/chmod, directory whiteout/recreation and independent Views use current immutable IDs', async () => {
  const f = await truthViewFixture({ 'dir/a': 'needle original\n', keep: 'quiet\n' })
  try {
    const t = await f.target('mutating'), other = await f.target('independent'), host = optioned(f, t).host
    const foreign = optioned(f, other).host
    await allModes(t, host)
    assert.equal(stats(foreign).entries, 0, 'a distinct concrete host starts with no inherited proof')
    const original = await receipt(other, foreign, { pattern: 'needle' })
    for (const [delta, expectedSources] of [
      [{ kind: 'rename', from: 'dir/a', to: 'renamed' }, 0],
      [{ kind: 'chmod', path: 'renamed', mode: 0o100755 }, 0],
      [{ kind: 'modify', path: 'keep', bytes: Buffer.from('needle edited\n'), mode }, 1],
      [{ kind: 'delete', path: 'renamed' }, 0],
      [{ kind: 'add', path: 'dir/new', bytes: Buffer.from('needle reborn\n'), mode }, 1],
      [{ kind: 'delete', path: 'dir' }, 0],
      [{ kind: 'add', path: 'dir/new', bytes: Buffer.from('quiet recreated\n'), mode }, 1],
    ] as [Delta, number][]) {
      await t.change(delta)
      const before = stats(host).sourceReads
      await allModes(t, host)
      assert.equal(stats(host).sourceReads - before, expectedSources, `${delta.kind}: unchanged IDs remain immutable proof, new IDs verify once`)
      assert.deepEqual(await receipt(other, foreign, { pattern: 'needle' }), original)
    }
    const result = await receipt(t, host, { pattern: 'needle' })
    assert.match(result.output, /keep:1:needle edited/); assert.doesNotMatch(result.output, /dir\/a|renamed|dir\/new/)
  } finally { await f.close() }
})

test('files early stop and receipt shortening never install partial rows; complete count can warm them later', async () => {
  const f = await truthViewFixture({ dense: 'needle\n'.repeat(1200), long: `needle ${'😀'.repeat(2000)}\nneedle tail\n`, later: 'needle later\n' })
  try {
    const t = await f.target('partial'), host = optioned(f, t).host
    for (const path of ['dense', 'long']) {
      const initialEntries = stats(host).entries, before = stats(host).sourceReads
      await receipt(t, host, { pattern: 'needle', path, output_mode: 'files_with_matches' })
      assert.equal(stats(host).entries, initialEntries)
      const partial = await receipt(t, host, { pattern: 'needle', path })
      assert.match(partial.output, /Search stopped at the receipt budget/)
      if (path === 'long') assert.match(partial.output, /Last result line shortened/)
      assert.equal(stats(host).entries, initialEntries, 'receipt interruption cannot claim complete per-blob regex proof')
      assert.equal(stats(host).sourceReads - before, 2)
      const count = await receipt(t, host, { pattern: 'needle', path, output_mode: 'count' })
      assert.match(count.output, path === 'dense' ? /dense:1200/ : /long:2/)
      assert.equal(stats(host).entries, initialEntries + 1)
      const warmed = stats(host).sourceReads
      for (const output_mode of outputModes) await receipt(t, host, { pattern: 'needle', path, output_mode })
      assert.equal(stats(host).sourceReads, warmed, 'complete count proof can serve every bounded receipt mode')
    }
    const limited = optioned(f, t).host, walk = limited.walkDetailed!
    limited.walkDetailed = async () => ({ paths: ['later'], truncated: true, limits: ['rows'] })
    const args = { pattern: 'needle', output_mode: 'count' }
    const partial = await grep(args, limited, context(t))
    assert.deepEqual(partial, await grep(args, { ...limited }, context(t)))
    assert.match(partial.output, /Enumeration incomplete/)
    assert.equal(stats(limited).entries, 1, 'only the fully scanned visited blob gains proof; no query-wide completeness is invented')
    limited.walkDetailed = walk
    await allModes(t, limited)
  } finally { await f.close() }
})

test('native pattern source/flags separate proof; stateful regex and wrapped/replaced readers preserve generic scanning', async () => {
  const f = await truthViewFixture({ a: 'needle\nNEEDLE\nneedle\n', b: 'quiet\n' })
  try {
    const t = await f.target('native-flags'), host = optioned(f, t).host
    for (const [pattern, flags] of [['needle', ''], ['needle', 'i'], ['NEEDLE', ''], ['^needle$', 'm'], ['needle', 'd'], ['needle', 'u'], ['needle', 'v'], ['needle', 's']]) {
      const re = new RegExp(pattern, flags)
      const got = await verifiedGrepMatches(host, 'a', re)
      assert.notEqual(got, undefined); assert.notEqual(got, null)
      const expected = [...searchLines(Buffer.from((await t.view.read('a'))!).toString('utf8'))].filter(line => new RegExp(pattern, flags).test(line.line))
      assert.deepEqual([...got!.matches], expected)
      const sourceReads = stats(host).sourceReads
      assert.deepEqual([...(await verifiedGrepMatches(host, 'a', new RegExp(pattern, flags)))!.matches], expected)
      assert.equal(stats(host).sourceReads, sourceReads)
    }
    assert.equal(stats(host).entries, 8, 'exact pattern source plus native flags form separate keys')
    for (const flags of ['g', 'y', 'gi']) {
      const re = new RegExp('needle', flags); re.lastIndex = 2
      const before = stats(host)
      assert.equal(await verifiedGrepMatches(host, 'a', re), undefined)
      assert.equal(re.lastIndex, 2, 'refused stateful regex retains caller native state')
      assert.deepEqual(stats(host), before)
      const text = Buffer.from((await host.readBytes('a'))!.bytes).toString('utf8')
      const reference = new RegExp('needle', flags); reference.lastIndex = 2
      assert.deepEqual([...searchLines(text)].filter(line => re.test(line.line)), [...searchLines(text)].filter(line => reference.test(line.line)))
      assert.equal(re.lastIndex, reference.lastIndex)
    }
    const original = host.readBytes, before = stats(host)
    host.readBytes = async () => ({ bytes: Buffer.from('needle replacement\n'), mode })
    assert.equal(await verifiedGrepMatches(host, 'a', /needle/), undefined)
    const replacement = await grep({ pattern: 'needle', path: 'a' }, host, context(t))
    assert.match(replacement.output, /needle replacement/)
    assert.deepEqual(replacement, await grep({ pattern: 'needle', path: 'a' }, { ...host }, context(t)))
    assert.deepEqual(stats(host), before)
    host.readBytes = original
    await allModes(t, { ...host })
    assert.deepEqual(stats(host), before, 'a reader-preserving clone has no authority to access concrete-host proof')
  } finally { await f.close() }
})

test('bytes that disagree with the actual View identity never seed a later cached result', async () => {
  const f = await truthViewFixture({ a: 'quiet\n' })
  try {
    const t = await f.target('source-binding'), host = optioned(f, t).host, read = t.view.read.bind(t.view)
    t.view.read = async () => Buffer.from('needle unbound bytes\n')
    const unbound = await receipt(t, host, { pattern: 'needle' })
    assert.match(unbound.output, /needle unbound bytes/)
    assert.equal(stats(host).entries, 0); assert.equal(stats(host).rejectedSources, 1)
    await receipt(t, host, { pattern: 'needle' })
    assert.equal(stats(host).entries, 0); assert.equal(stats(host).rejectedSources, 2)
    t.view.read = read
    const real = await receipt(t, host, { pattern: 'needle' })
    assert.equal(real.output, 'no line matches needle.')
    assert.equal(stats(host).entries, 1); assert.equal(stats(host).verifiedSources, 1)
  } finally { await f.close() }
})

test('a warm negative verification survives a held metadata edit only by restoring the current real source scan', { timeout: 15_000 }, async testContext => {
  let release!: () => void, enter!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { enter = resolve })
  const f = await truthViewFixture({ a: 'quiet\n' })
  let blocking = false
  try {
    const t = await f.target('held-metadata'), host = optioned(f, t).host, stat = t.view.stat.bind(t.view)
    await receipt(t, host, { pattern: 'needle' })
    assert.equal(stats(host).entries, 1)
    t.view.stat = async path => {
      const meta = await stat(path)
      if (blocking && path === 'a') { blocking = false; enter(); await gate }
      return meta
    }
    blocking = true
    const pending = grep({ pattern: 'needle' }, host, context(t))
    try {
      await ready(entered, testContext.signal)
      await t.change({ kind: 'modify', path: 'a', bytes: Buffer.from('needle current\n'), mode })
    } finally { blocking = false; release() }
    const result = await pending
    assert.deepEqual(result, await grep({ pattern: 'needle' }, { ...t.plain }, context(t)))
    assert.match(result.output, /a:1:needle current/)
    assert.equal(stats(host).hits, 0, 'held stale metadata cannot admit the formerly negative immutable proof')
    await allModes(t, host)
  } finally { blocking = false; release(); await f.close() }
})

test('plain default hosts remain unbound and retain exactly their original stat/read path', async () => {
  const f = await truthViewFixture({ a: 'needle\n', alias: 'needle\n' })
  try {
    const t = await f.target('default-scan'), reads = observed(t), host = createToolHost(t.view, f.roots)
    let calls = 0
    const stat = t.view.stat.bind(t.view)
    t.view.stat = async path => { calls++; return stat(path) }
    assert.equal(grepVerificationStats(host), null); assert.equal(grepVerificationStats(t.plain), null)
    assert.equal(await verifiedGrepMatches(host, 'a', /needle/), undefined)
    assert.equal(calls, 0); assert.equal(reads.length, 0, 'an unbound verifier adds no metadata or source work')
    for (const output_mode of outputModes) {
      const args = { pattern: 'needle', output_mode }
      for (let repeat = 0; repeat < 2; repeat++) {
        const before = calls, at = reads.length
        const result = await grep(args, host, context(t))
        assert.equal(calls - before, 2, 'only the original readBytes stat runs once for each alias path')
        assert.deepEqual(reads.slice(at), ['a', 'alias'], 'default repeated aliases still use the original scanner')
        assert.deepEqual(result, await grep(args, { ...t.plain }, context(t)))
        assert.equal(grepVerificationStats(host), null)
      }
    }
  } finally { await f.close() }
})

test('actual prepared cohort candidates and complete verification jointly preserve full tool receipts', async () => {
  const f = await truthViewFixture({ hit: 'needle\nneedle\n', alias: 'needle\nneedle\n', miss: 'quiet\n', falsePositive: 'abc bcd cde def\n' })
  try {
    const t = await f.target('prepared-pipeline'), reads = observed(t), { index, host } = optioned(f, t)
    assert.equal(await index.prepare(blob => f.truth.getBlob(blob)), true)
    const first = await grep({ pattern: 'needle' }, host, context(t))
    assert.deepEqual(reads, ['alias'], 'prepared negatives avoid source reads and shared surviving aliases verify once')
    assert.deepEqual(first, await grep({ pattern: 'needle' }, { ...t.plain }, context(t)))
    assert.equal(stats(host).sourceReads, 1, 'only the first surviving alias verifies its shared immutable blob')
    assert.equal(stats(host).hits, 1)
    const sourceReads = stats(host).sourceReads, testedLines = stats(host).testedLines
    await allModes(t, host)
    assert.equal(stats(host).sourceReads, sourceReads); assert.equal(stats(host).testedLines, testedLines)
    await allModes(t, host, 'abcdef')
    assert.equal((await receipt(t, host, { pattern: 'abcdef' })).output, 'no line matches abcdef.')
    assert.equal(index.stats().fallbacks, 0)
    assert.equal(index.stats().builds, 1)
    assert.equal(stats(host).entries, 2, 'the cohort false positive receives a complete negative regex proof')
  } finally { await f.close() }
})
