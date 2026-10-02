// tier: real —— existing CI runner diagnostic; Git and synthetic 16MiB, no timing gate.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { arch, cpus, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { openTruth } from '../src/truth/truth.ts'
import { openLog } from '../src/log/log.ts'
import { loadView } from '../src/view/view.ts'
import { lowerAt } from '../src/view/lower.ts'
import { refHeadOf } from '../src/round/head.ts'
import { createRoots } from '../src/roots/roots.ts'
import { createToolHost } from '../src/tools/host.ts'
import { faceOf } from '../src/tools/execute.ts'
import { grepVerificationStats } from '../src/tools/grep-verifier.ts'
import { createCohortIndexStore } from '../src/search/cohort-store.ts'
import { createViewCohortLookup } from '../src/search/view-cohort.ts'
import type { AgentId, CommitId, WriterId } from '../src/terms.ts'
import type { ToolContext } from '../src/tools/execute.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = 512, FILE_BYTES = 32768, LINE_BYTES = 128, LAPS = 2
const grep = faceOf('grep')!
type Closeable = { close(): Promise<void> }

function sha(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 }).trim()
}
async function closeAll(resources: Closeable[]): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const resource of resources.splice(0).reverse()) {
    try { await resource.close() } catch (error) { errors.push(error) }
  }
  return errors
}

/** Fingerprint immutable checkout blobs AND the actual production files imported here. */
function sourceSnapshot() {
  const head = git(['rev-parse', 'HEAD'], ROOT), tree = git(['rev-parse', 'HEAD^{tree}'], ROOT)
  const format = git(['rev-parse', '--show-object-format'], ROOT)
  assert.ok(format === 'sha1' || format === 'sha256')
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--', 'src'], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
  })
  const modules: Record<string, string> = {}
  for (const row of listing.split('\0').filter(Boolean)) {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(row)
    assert.ok(match)
    const [, mode, blob, path] = match
    if (!/\.(?:ts|js|mjs)$/.test(path!) || /\.test\.(?:ts|js|mjs)$/.test(path!)) continue
    assert.ok(mode === '100644' || mode === '100755', `ordinary source: ${path}`)
    assert.ok(lstatSync(join(ROOT, path!)).isFile(), path)
    const bytes = readFileSync(join(ROOT, path!))
    const actualBlob = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    assert.equal(actualBlob, blob, `imported source matches immutable checkout: ${path}`)
    modules[path!] = sha(bytes)
  }
  assert.ok(Object.keys(modules).length > 50)
  return { head, tree, format, modules }
}

function filesystem(path: string) {
  const magic = statfsSync(path).type
  let mountType: string | null = null
  try {
    mountType = execFileSync('findmnt', ['-no', 'FSTYPE', '-T', path], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    }).trim() || null
  } catch { /* unavailable mount metadata remains explicitly unknown */ }
  return { magic: '0x' + magic.toString(16), mountType, ext4: magic === 0xef53 && mountType === 'ext4' }
}

function prHead(): string | null {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'pull_request') return null
  const path = process.env.GITHUB_EVENT_PATH
  if (!path) return null
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.size > 1024 * 1024) return null
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))?.pull_request?.head?.sha
    return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null
  } catch { return null }
}

function corpusFile(at: number): Buffer {
  // Byte-identical approved code512 recipe used by profile-prepared-cold.js.
  const bytes = Buffer.alloc(FILE_BYTES)
  for (let line = 0; line < FILE_BYTES / LINE_BYTES; line++) {
    const offset = line * LINE_BYTES
    bytes.fill(0x78, offset, offset + LINE_BYTES - 1)
    const marker = Buffer.from(`dense_hit f${String(at).padStart(3, '0')} l${String(line).padStart(3, '0')} const value = 42; `)
    marker.copy(bytes, offset); bytes[offset + LINE_BYTES - 1] = 10
  }
  if (at === FILES - 1) Buffer.from(' rare_hit ').copy(bytes, bytes.length - 11)
  assert.equal(bytes.length, FILE_BYTES)
  return bytes
}

/** Every sample owns new Truth/Log/View/host; optional additionally owns store/index. */
async function handles(root: string, base: CommitId, optional: boolean, resources: Closeable[]) {
  const truth = openTruth(root); resources.push(truth)
  const writer = 'cold-diagnostic' as WriterId
  const log = openLog(root, { write: writer, sync: 'never' }); resources.push(log)
  const view = await loadView(log, writer, { lower: lowerAt(truth, base) })
  const roots = createRoots(root), head = await refHeadOf(log, writer, base)
  assert.equal(head.value, base)
  assert.equal(head.seq, 0)
  assert.equal(typeof head.refresh, 'function')
  const actions = { writer, truth, log, head }
  const plain = createToolHost(view, roots, { actions })
  const store = optional ? createCohortIndexStore(root) : null
  if (store) resources.push(store)
  const index = store ? createViewCohortLookup(view, () => plain.walk(), store) : null
  if (index) resources.push(index)
  const host = index ? createToolHost(view, roots, { actions, cohortIndex: index }) : plain
  const ctx: ToolContext = { agent: writer as AgentId, step: 0, cwd: '', holder: false }
  return { truth, log, view, host, ctx, store, index }
}

test('current prepared-cold synthetic query diagnostic preserves full default receipts', { timeout: 180000 }, async () => {
  // All source/admission checks precede allocation. Generated data stays on checkout filesystem.
  const source = sourceSnapshot(), checkoutFs = filesystem(ROOT), started = performance.now()
  let directory: string | undefined, primary: unknown, failed = false
  const resources: Closeable[] = []
  try {
    directory = mkdtempSync(join(ROOT, '.cold-benchmark-'))
    const root = join(directory, 'repo'), home = join(directory, 'home')
    mkdirSync(root); mkdirSync(home)
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home,
      LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
    const seedStart = performance.now()
    git(['init', '-q', '--object-format=sha1'], root, env)
    const truth = openTruth(root); resources.push(truth)
    const entries = [], corpus = createHash('sha256')
    for (let at = 0; at < FILES; at++) {
      const name = `corpus/file-${at.toString().padStart(3, '0')}`, bytes = corpusFile(at)
      corpus.update(name + '\0').update(bytes)
      entries.push({ name, mode: 0o100644, id: await truth.putBlob(bytes) })
    }
    const base = await truth.commit(await truth.putTree(entries), [], 'synthetic current-cold diagnostic')
    const seedWallMs = performance.now() - seedStart, corpusHash = corpus.digest('hex')
    await truth.close(); resources.pop()
    const prepStart = performance.now(), prep = await handles(root, base, true, resources)
    assert.ok(prep.index)
    assert.equal(await prep.index.prepare(blob => prep.truth.getBlob(blob), { prefetchBlobs: blobs => prep.truth.prefetchBlobs(blobs) }), true)
    const preparation = { wallMs: performance.now() - prepStart, truth: prep.truth.stats(),
      store: prep.store!.stats(), index: prep.index.stats() }
    const prepErrors = await closeAll(resources)
    if (prepErrors.length) throw new AggregateError(prepErrors, 'preparation cleanup failed')
    const cohortDir = join(root, '.fugue', 'idx', 'v1', 'cohorts')
    const leaves = readdirSync(cohortDir).filter(name => /^[0-9a-f]{64}\.bin$/.test(name))
    assert.equal(leaves.length, 1)
    const artifact = join(cohortDir, leaves[0]!), artifactHash = sha(readFileSync(artifact))
    const fs = { checkout: checkoutFs, fixture: filesystem(root), gitObjects: filesystem(join(root, '.git', 'objects')),
      artifact: filesystem(artifact) }
    const samples = [], receipts = new Map<string, unknown>()
    for (let lap = 0; lap < LAPS; lap++) {
      for (const [name, pattern] of [['sparse', 'rare(_hit)+'], ['dense', 'dense_hit.+']] as const) {
        for (const optional of lap === 0 ? [false, true] : [true, false]) {
          const setupStart = performance.now(), h = await handles(root, base, optional, resources)
          const setupWallMs = performance.now() - setupStart
          const before = { truth: h.truth.stats(), store: h.store?.stats() ?? null,
            index: h.index?.stats() ?? null, verifier: grepVerificationStats(h.host) }
          const cpu = process.cpuUsage(), start = performance.now()
          const result = await grep({ pattern, output_mode: 'content' }, h.host, h.ctx)
          const wallMs = performance.now() - start, nodeCpuMicros = process.cpuUsage(cpu)
          assert.equal(result.ok, true)
          if (receipts.has(name)) assert.deepEqual(result, receipts.get(name), `${name}: complete FaceResult parity`)
          else receipts.set(name, result)
          const after = { truth: h.truth.stats(), store: h.store?.stats() ?? null,
            index: h.index?.stats() ?? null, verifier: grepVerificationStats(h.host) }
          assert.equal(before.truth.infoMisses, 0, 'fresh metadata state')
          assert.equal(after.truth.infoMisses, FILES, 'all eager source info checks remain')
          assert.ok(after.truth.gitRequests > 0 && after.truth.blobHits > 0, 'real Truth prefetch remains')
          if (h.index) {
            assert.equal(after.index!.sourceReads, 0); assert.equal(after.index!.builds, 0)
            assert.equal(after.index!.diskReads, 1); assert.equal(after.index!.fallbacks, 0)
            assert.equal(after.store!.reads, 1)
            assert.equal(after.verifier!.sourceReads, 1, 'prepared filtering/early-stop mechanism, no silent full scan')
            assert.equal(after.verifier!.installed, name === 'sparse' ? 1 : 0, 'sparse EOF versus incomplete dense prefix')
          }
          samples.push({ lap, name, backend: optional ? 'prepared-optional' : 'plain-default', setupWallMs,
            wallMs, nodeCpuMicros, receiptHash: sha(JSON.stringify(result)), receiptBytes: Buffer.byteLength(result.output), before, after })
          const errors = await closeAll(resources)
          if (errors.length) throw new AggregateError(errors, 'sample cleanup failed')
        }
      }
    }
    assert.deepEqual(sourceSnapshot(), source, 'immutable checkout and actual production bytes remain unchanged')
    const report = { schema: 'fugue-current-cold-diagnostic-1', source, prHead: prHead(),
      testHash: sha(readFileSync(fileURLToPath(import.meta.url))), corpus: { files: FILES, fileBytes: FILE_BYTES,
        totalBytes: FILES * FILE_BYTES, sha256: corpusHash, artifactSha256: artifactHash }, fs,
      machine: { platform: platform(), arch: arch(), kernel: release(), cpus: cpus().length,
        node: process.version, git: git(['--version'], root, env), runner: process.env.RUNNER_NAME ?? null,
        image: process.env.ImageOS ?? null },
      ci: { run: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        event: process.env.GITHUB_EVENT_NAME ?? null, sha: process.env.GITHUB_SHA ?? null },
      boundary: 'Fresh Truth/Log/View/store/index/host/verifier per sample in one Node process; OS cache warmed by seed/preparation; no cache drop. Hosted-runner diagnostic only, no timing gate/default acceptance.',
      seedWallMs, preparation, diagnosticWallMs: performance.now() - started, samples }
    const json = JSON.stringify(report)
    assert.ok(Buffer.byteLength(json) <= 65536, 'bounded diagnostic line')
    console.log('FUGUE_COLD_DIAGNOSTIC ' + json)
  } catch (error) { failed = true; primary = error; throw error }
  finally {
    const errors = await closeAll(resources)
    if (directory) { try { rmSync(directory, { recursive: true, force: true }) } catch (error) { errors.push(error) } }
    if (errors.length) {
      if (failed) throw new AggregateError([primary, ...errors], 'diagnostic and cleanup failed')
      throw new AggregateError(errors, 'diagnostic cleanup failed')
    }
  }
})
