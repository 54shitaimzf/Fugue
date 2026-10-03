// tier: real —— 准备后的实际 View：至少一次子表达式的必需 runs 与不跨重复边界的完整回执。
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

test('prepared actual minimum-one children retain mandatory facts without false bridges or stale-ID exclusions', async () => {
  const files = { ...Object.fromEntries(Array.from({ length: 16 }, (_, at) => [`miss${at}`, `quiet unique ${at}\n`])),
    suffix: 'rare_hit\nrare_hit_hit\n', bare: 'rare\n', variable: 'rare gap hit\nrare repeated hit gap hit\n',
    short: 'needleabccde\n', shortOne: 'needleabcde\n' }
  const f = await truthViewFixture(files)
  try {
    const t = await f.target('prepared-min-one'), reads: string[] = [], read = t.view.read.bind(t.view)
    t.view.read = async path => { reads.push(path); return read(path) }
    const store = f.own(createCohortIndexStore(f.root))
    const index = f.own(createViewCohortLookup(t.view, () => t.plain.walk(), store))
    assert.equal(await index.prepare(blob => f.truth.getBlob(blob)), true)
    const ctx: ToolContext = { agent: t.writer as AgentId, step: 0, cwd: '', holder: false }
    async function exact(pattern: string, output_mode: string) {
      const host = createToolHost(t.view, f.roots, { cohortIndex: index })
      assert.equal(grepVerificationStats(host)!.entries, 0, 'fresh optional host isolates cohort filtering from warmed verification')
      reads.length = 0
      const result = await grep({ pattern, output_mode }, host, ctx), sources = [...reads]
      assert.equal(grepVerificationStats(host)!.sourceReads, sources.length)
      assert.deepEqual(result, await grep({ pattern, output_mode }, { ...t.plain }, ctx), `${pattern}/${output_mode}: exact full FaceResult`)
      return { result, sources }
    }
    for (const output_mode of modes) {
      const suffix = await exact('rare(_hit)+', output_mode)
      assert.deepEqual(suffix.sources, ['suffix'], 'the repeated child still contributes its mandatory _hit facts')
      assert.doesNotMatch(suffix.result.output, /bare/)
      if (output_mode === 'content') assert.match(suffix.result.output, /suffix:2:rare_hit_hit/)
      if (output_mode === 'count') assert.match(suffix.result.output, /suffix:2/)
      const short = await exact('needleab(c)+de', output_mode)
      assert.deepEqual(short.sources, ['short', 'shortOne'])
      assert.match(short.result.output, /short/); assert.match(short.result.output, /shortOne/)
      if (output_mode === 'content') assert.match(short.result.output, /short:1:needleabccde/)
      const variable = await exact('rare(.*hit)+', output_mode)
      assert.deepEqual(variable.sources, ['suffix', 'variable'])
      assert.match(variable.result.output, /variable/)
      if (output_mode === 'content') assert.match(variable.result.output, /variable:2:rare repeated hit gap hit/)
      for (const pattern of ['ab(c)+de', 'rare(_hit)+?', 'rare(_hit){1}']) {
        const fallback = await exact(pattern, output_mode)
        assert.equal(fallback.sources.length, Object.keys(files).length, 'no useful gram, lazy quantifier and unknown braces remain full-scan fallback')
      }
    }
    await t.change({ kind: 'modify', path: 'miss0', bytes: Buffer.from('rare_hit_hit_hit\n'), mode: 0o100644 })
    const stale = await exact('rare(_hit)+', 'count')
    assert.equal(stale.sources.length, Object.keys(files).length, 'a new immutable ID invalidates the old exact-set artifact')
    assert.match(stale.result.output, /miss0:1/)
    assert.equal(await index.prepare(blob => f.truth.getBlob(blob)), true)
    for (const output_mode of modes) {
      const current = await exact('rare(_hit)+', output_mode)
      assert.deepEqual(current.sources, ['miss0', 'suffix']); assert.match(current.result.output, /miss0/)
      if (output_mode === 'content') assert.match(current.result.output, /miss0:1:rare_hit_hit_hit/)
    }
  } finally { await f.close() }
})
