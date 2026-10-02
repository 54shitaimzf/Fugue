import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'

const ctx: ToolContext = { agent: 'reader', step: 0, cwd: '', holder: false }
const grep = faceOf('grep')!
function fixture(covered: number | void | ((paths: readonly string[]) => number), filtered = false) {
  const paths = ['a', 'b', 'c', 'd', 'e'], reads: string[] = []
  const host = {
    walk: async () => paths,
    walkDetailed: async () => ({ paths, truncated: false, limits: [] }),
    prefetch: async (batch: readonly string[]) => typeof covered === 'function' ? covered(batch) : covered,
    filterCandidates: filtered ? async (batch: readonly string[]) => batch.filter(path => path !== 'b') : undefined,
    readBytes: async (path: string) => { reads.push(path); return { bytes: Buffer.from(path === 'c' ? 'hit\nhit' : 'none'), mode: 0o100644 } },
  } as ToolHost
  return { host, reads }
}

test('fractional prefetch coverage cannot skip a middle match or falsely claim complete no matches', async () => {
  for (const output_mode of ['content', 'count', 'files_with_matches']) {
    const reference = fixture(undefined), malformed = fixture(1.5)
    assert.deepEqual(await grep({ pattern: 'hit', output_mode }, malformed.host, ctx),
      await grep({ pattern: 'hit', output_mode }, reference.host, ctx))
    assert.deepEqual(malformed.reads, reference.reads)
  }
})


test('invalid prefix counts preserve full candidates and order, including index-filtered holes', async () => {
  const invalid = [NaN, Infinity, -Infinity, -1, -0.5, 0.5, 1.5, 2.5, 5, 6, Number.MAX_SAFE_INTEGER + 1]
  for (const filtered of [false, true]) {
    for (const covered of invalid) {
      const malformed = fixture(covered, filtered), reference = fixture(undefined, filtered)
      assert.deepEqual(await grep({ pattern: 'hit' }, malformed.host, ctx), await grep({ pattern: 'hit' }, reference.host, ctx), String(covered))
      assert.deepEqual(malformed.reads, reference.reads, String(covered))
    }
  }
})

test('valid zero, one and full prefix counts visit every retained candidate exactly once', async () => {
  for (const filtered of [false, true]) {
    for (const covered of [0, 1, 2, (batch: readonly string[]) => batch.length]) {
      const bounded = fixture(covered, filtered), reference = fixture(undefined, filtered)
      assert.deepEqual(await grep({ pattern: 'hit' }, bounded.host, ctx), await grep({ pattern: 'hit' }, reference.host, ctx))
      assert.deepEqual(bounded.reads, reference.reads)
    }
  }
})
