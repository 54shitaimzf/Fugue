// tier: real —— 真实准备后的 View：必需 literal 分组过滤、完整回执与当前 BlobId。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { truthViewFixture } from '../../test/helpers/truth-view.ts'
import { createToolHost } from './host.ts'
import { createCohortIndexStore } from '../search/cohort-store.ts'
import { createViewCohortLookup } from '../search/view-cohort.ts'
import { faceOf } from './execute.ts'
import type { ToolContext } from './execute.ts'
import { grepVerificationStats } from './grep-verifier.ts'
import type { AgentId } from '../terms.ts'

const grep = faceOf('grep')!, modes = ['content', 'count', 'files_with_matches']

test('prepared actual grouped literals reduce cold source work with exact all-mode receipts and fail-open mutation', async () => {
  const files = { ...Object.fromEntries(Array.from({ length: 16 }, (_, at) => [`miss${at}`, `quiet unique ${at}\n`])),
    'dir/hit': 'rare_hit\nrare_hit twice\n', optional: '_hit only\n', alternate: 'other_hit only\n' }
  const f = await truthViewFixture(files)
  try {
    const t = await f.target('prepared-groups'), reads: string[] = [], read = t.view.read.bind(t.view)
    t.view.read = async path => { reads.push(path); return read(path) }
    const store = f.own(createCohortIndexStore(f.root))
    const index = f.own(createViewCohortLookup(t.view, () => t.plain.walk(), store))
    assert.equal(await index.prepare(blob => f.truth.getBlob(blob)), true)
    const ctx: ToolContext = { agent: t.writer as AgentId, step: 0, cwd: '', holder: false }
    async function exact(pattern: string, output_mode: string) {
      // Fresh factory hosts have no completed regex records: only the prepared cohort can save source work.
      const host = createToolHost(t.view, f.roots, { cohortIndex: index })
      assert.equal(grepVerificationStats(host)!.entries, 0)
      reads.length = 0
      const result = await grep({ pattern, output_mode }, host, ctx), sources = [...reads]
      assert.equal(grepVerificationStats(host)!.sourceReads, sources.length)
      const expected = await grep({ pattern, output_mode }, { ...t.plain }, ctx)
      assert.deepEqual(result, expected, `${pattern}/${output_mode}: complete FaceResult matches the authoritative scanner`)
      return { result, sources }
    }
    for (const output_mode of modes) {
      const plain = await exact('rare_hit', output_mode)
      assert.deepEqual(plain.sources, ['dir/hit'])
      for (const pattern of ['(rare)(_hit)', 'rare(?:_hit)', '(ra(?:re_))hit']) {
        const grouped = await exact(pattern, output_mode)
        assert.deepEqual(grouped.result, plain.result)
        assert.deepEqual(grouped.sources, ['dir/hit'], 'mandatory groups use prepared negatives, not a warm regex cache')
      }
      const optional = await exact('(rare)?_hit', output_mode)
      assert.deepEqual(optional.sources, ['alternate', 'dir/hit', 'optional'], 'only the suffix remains mandatory across an optional prefix')
      assert.match(optional.result.output, /optional/)
      for (const pattern of ['rare(_hit){1}', '(rare|other)_hit']) {
        const fallback = await exact(pattern, output_mode)
        assert.equal(fallback.sources.length, Object.keys(files).length, 'unsupported syntax keeps whole-pattern full scanning')
        assert.ok(fallback.sources.includes('optional')); assert.ok(fallback.sources.includes('alternate'))
        if (pattern === '(rare|other)_hit') assert.match(fallback.result.output, /alternate/)
      }
    }
    await t.change({ kind: 'modify', path: 'miss0', bytes: Buffer.from('rare_hit current\n'), mode: 0o100644 })
    const changed = await exact('rare(?:_hit)', 'count')
    assert.match(changed.result.output, /miss0:1/)
    assert.equal(changed.sources.length, Object.keys(files).length, 'stale exact-set artifact fails open after a current-ID edit')
    assert.equal(await index.prepare(blob => f.truth.getBlob(blob)), true)
    for (const output_mode of modes) {
      const prepared = await exact('(rare)(_hit)', output_mode)
      assert.deepEqual(prepared.sources, ['dir/hit', 'miss0'])
      assert.match(prepared.result.output, /miss0/)
    }
    await t.change({ kind: 'rename', from: 'dir/hit', to: 'dir/renamed' })
    await t.change({ kind: 'chmod', path: 'dir/renamed', mode: 0o100755 })
    const renamed = await exact('rare(?:_hit)', 'count')
    assert.deepEqual(renamed.sources, ['dir/renamed', 'miss0']); assert.match(renamed.result.output, /dir\/renamed:2/)
    await t.change({ kind: 'delete', path: 'dir' })
    const deleted = await exact('(rare)(_hit)', 'count')
    assert.doesNotMatch(deleted.result.output, /dir\//); assert.match(deleted.result.output, /miss0:1/)
    await t.change({ kind: 'add', path: 'dir/reborn', bytes: Buffer.from(files['dir/hit']), mode: 0o100644 })
    const reborn = await exact('(ra(?:re_))hit', 'count')
    assert.deepEqual(reborn.sources, ['dir/reborn', 'miss0']); assert.match(reborn.result.output, /dir\/reborn:2/)
  } finally { await f.close() }
})

test('prepared actual optional spans and dot barriers keep omitted/gap matches without false bridge grams', async () => {
  const files = { ...Object.fromEntries(Array.from({ length: 16 }, (_, at) => [`miss${at}`, `quiet unique ${at}\n`])),
    'dir/plain': 'rare\n', 'dir/suffix': 'rare_hit\n', 'dir/gap': 'rare long variable hit\n',
    bridge: 'abde\n', bridgeWith: 'abcde\n', nested: 'markerfinish\n', nestedWith: 'markerrare zz hitfinish\n' }
  const f = await truthViewFixture(files)
  try {
    const t = await f.target('prepared-runs'), reads: string[] = [], read = t.view.read.bind(t.view)
    t.view.read = async path => { reads.push(path); return read(path) }
    const store = f.own(createCohortIndexStore(f.root))
    const index = f.own(createViewCohortLookup(t.view, () => t.plain.walk(), store))
    assert.equal(await index.prepare(blob => f.truth.getBlob(blob)), true)
    const ctx: ToolContext = { agent: t.writer as AgentId, step: 0, cwd: '', holder: false }
    async function exact(pattern: string, output_mode: string) {
      const host = createToolHost(t.view, f.roots, { cohortIndex: index })
      assert.equal(grepVerificationStats(host)!.entries, 0, 'fresh optional host prevents warm-cache attribution')
      reads.length = 0
      const result = await grep({ pattern, output_mode }, host, ctx), sources = [...reads]
      assert.equal(grepVerificationStats(host)!.sourceReads, sources.length)
      assert.deepEqual(result, await grep({ pattern, output_mode }, { ...t.plain }, ctx), `${pattern}/${output_mode}: full FaceResult`)
      return { result, sources }
    }
    for (const output_mode of modes) {
      const optional = await exact('rare(_hit)?', output_mode)
      assert.deepEqual(optional.sources, ['dir/gap', 'dir/plain', 'dir/suffix', 'nestedWith'])
      assert.match(optional.result.output, /dir\/plain/, 'missing optional suffix is still a true match')
      const gap = await exact('rare.*hit', output_mode)
      assert.deepEqual(gap.sources, ['dir/gap', 'dir/suffix', 'nestedWith'])
      assert.match(gap.result.output, /dir\/gap/, 'variable gap cannot become a contiguous rarehit condition')
      const bridge = await exact('ab(c)?de', output_mode)
      assert.equal(bridge.sources.length, Object.keys(files).length, 'short neighbors provide no gram and never join across optional c')
      assert.match(bridge.result.output, output_mode === 'count' ? /bridge:1/ : /bridge/)
      assert.match(bridge.result.output, output_mode === 'count' ? /bridgeWith:1/ : /bridgeWith/)
      const nested = await exact('marker((rare.*hit)?)?finish', output_mode)
      assert.deepEqual(nested.sources, ['nested', 'nestedWith'], 'omitted and populated optional children own separate immutable blobs')
      assert.match(nested.result.output, output_mode === 'count' ? /nested:1/ : /nested/)
      assert.match(nested.result.output, output_mode === 'count' ? /nestedWith:1/ : /nestedWith/)
      if (output_mode === 'content') assert.match(nested.result.output, /nested:1:markerfinish/)
    }
    await t.change({ kind: 'modify', path: 'miss0', bytes: Buffer.from('rare new gap hit\n'), mode: 0o100644 })
    for (const pattern of ['rare(_hit)?', 'rare.*hit']) {
      const stale = await exact(pattern, 'count')
      assert.match(stale.result.output, /miss0:1/)
      assert.equal(stale.sources.length, Object.keys(files).length, 'new current ID makes the old exact-set proof fail open')
    }
    assert.equal(await index.prepare(blob => f.truth.getBlob(blob)), true)
    for (const output_mode of modes) {
      const optional = await exact('rare(_hit)?', output_mode)
      assert.deepEqual(optional.sources, ['dir/gap', 'dir/plain', 'dir/suffix', 'miss0', 'nestedWith'])
      assert.match(optional.result.output, /miss0/)
      const gap = await exact('rare.*hit', output_mode)
      assert.deepEqual(gap.sources, ['dir/gap', 'dir/suffix', 'miss0', 'nestedWith'])
      assert.match(gap.result.output, /miss0/)
    }
  } finally { await f.close() }
})
