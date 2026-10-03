#!/usr/bin/env node
// 决策证据，不接产品：源=生成Git+M0 View，rg只读明确收费的私有快照。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openTruth } from '../src/truth/truth.ts'
import { openLog } from '../src/log/log.ts'
import { loadView } from '../src/view/view.ts'
import { lowerAt } from '../src/view/lower.ts'
import { snapshotForSidecar } from '../src/search/sidecar-snapshot.ts'
import { removeGeneratedDirectories } from './rg-decision-cleanup.js'
const approvedBinary = 'e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849'
const rg = realpathSync(process.env.RG_BINARY ?? '/usr/local/bin/rg')
assert.equal(createHash('sha256').update(readFileSync(rg)).digest('hex'), approvedBinary, 'rg must match the verified official15.2.0 executable')
const version = execFileSync(rg, ['--version'], { encoding: 'utf8' }).trim()
const root = mkdtempSync(join(tmpdir(), 'fugue-rg-decision-')), snapshots = []
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
let truth, log
const scan = (rows, pattern) => { const regex = new RegExp(pattern); return rows.filter(row => row.bytes.toString('utf8').split('\n').some(line => regex.test(line))).map(row => row.path).sort() }
function rgFiles(snapshot, pattern) {
  const start = performance.now()
  const result = spawnSync(rg, ['--no-config', '--text', '--files-with-matches', '--no-ignore', '--hidden', '--color', 'never', '--regexp', pattern, '--', snapshot], { encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 30000 })
  if (result.error) throw result.error
  return { ms: performance.now() - start, status: result.status, files: (result.stdout.trim() ? result.stdout.trim().split('\n') : []).map(path => relative(snapshot, path)).sort(), stderr: result.stderr.trim(), spawns: 1 }
}
async function capture(view, paths) {
  const snapshot = mkdtempSync(join(tmpdir(), 'fugue-rg-snapshot-')); snapshots.push(snapshot)
  const before = truth.stats(), start = performance.now()
  const got = await snapshotForSidecar(view, paths, snapshot)
  const rows = paths.map(path => ({ path, bytes: readFileSync(join(snapshot, path)) }))
  const after = truth.stats()
  return { snapshot, rows, ...got, ms: performance.now() - start, gitRequests: after.gitRequests - before.gitRequests, gitSpawns: after.gitSpawns - before.gitSpawns }
}
try {
  execFileSync('git', ['init', '-q', root], { env })
  truth = openTruth(root); log = openLog(root, { write: 'bench', sync: 'never' })
  const entries = [], paths = []
  for (let file = 0; file < 512; file++) {
    const path = `corpus/file-${String(file).padStart(3, '0')}`, body = Buffer.from(Array.from({ length: 256 }, (_, line) => `dense_hit file${file} line${line} ${'x'.repeat(96)}${file === 511 && line === 255 ? ' rare_hit' : ''}`).join('\n') + '\n')
    paths.push(path); entries.push({ name: path, mode: 0o100644, id: await truth.putBlob(body) })
  }
  const base = await truth.commit(await truth.putTree(entries), [], 'rg decision generated fixture')
  const view = await loadView(log, 'bench', { lower: lowerAt(truth, base) })
  const virtual = Buffer.from('virtual_only\n'), blob = await truth.putBlob(virtual), rev = view.rev + 1
  await log.append('bench', { t: 'view/write', agent: 'bench', path: paths[0], rev, blob, mode: 0o100644 }); await view.write(paths[0], virtual)
  mkdirSync(join(root, 'corpus')); writeFileSync(join(root, paths[0]), 'physical_only\n')
  const captured = await capture(view, paths), readings = []
  for (const pattern of ['dense_hit', 'rare_hit', 'absent_needle', 'virtual_only', 'physical_only']) {
    const start = performance.now(), expected = scan(captured.rows, pattern), jsMs = performance.now() - start, native = rgFiles(captured.snapshot, pattern)
    assert.ok(native.status === 0 || native.status === 1); assert.deepEqual(native.files, expected)
    readings.push({ pattern, jsMemoryMs: jsMs, rgSnapshotMs: native.ms, sourceSnapshotPlusRgMs: captured.ms + native.ms, hitFiles: expected.length, spawns: native.spawns })
  }
  assert.equal(rgFiles(captured.snapshot, 'physical_only').files.length, 0)
  writeFileSync(join(root, paths[0]), 'physical_mutated\n')
  assert.deepEqual(rgFiles(captured.snapshot, 'virtual_only').files, [paths[0]])
  const changed = Buffer.from('after_view_mutation\n'), changedBlob = await truth.putBlob(changed), changedRev = view.rev + 1
  await log.append('bench', { t: 'view/write', agent: 'bench', path: paths[0], rev: changedRev, blob: changedBlob, mode: 0o100644 }); await view.write(paths[0], changed)
  assert.notEqual(view.rev, captured.rev, 'old snapshot cannot be accepted as current after mutation')
  const replacement = await capture(view, paths)
  assert.deepEqual(rgFiles(replacement.snapshot, 'after_view_mutation').files, [paths[0]])
  const compatibilityRoot = mkdtempSync(join(tmpdir(), 'fugue-rg-compat-')); snapshots.push(compatibilityRoot)
  const cases = []
  for (const [name, bytes, pattern] of [['utf16-dot', Buffer.from('😀\n'), '^.$'], ['backreference', Buffer.from('aa\n'), '(a)\\1'], ['invalid-utf8', Buffer.from([0xff, 10]), '\ufffd'], ['nul', Buffer.from([97, 0, 98, 10]), '\\x00']]) {
    const path = join(compatibilityRoot, name); writeFileSync(path, bytes)
    const expected = new RegExp(pattern).test(bytes.toString('utf8').split('\n')[0]), native = rgFiles(compatibilityRoot, pattern)
    cases.push({ name, pattern, jsMatch: expected, rgStatus: native.status, rgMatch: native.files.includes(name), error: native.stderr })
  }
  assert.notEqual(cases[0].jsMatch, cases[0].rgMatch, 'UTF16-vs-codepoint compatibility counterexample required')
  assert.equal(cases[1].rgStatus, 2, 'default rg backreference rejection required')
  assert.notEqual(cases[2].jsMatch, cases[2].rgMatch, 'invalid UTF8 compatibility counterexample required')
  assert.equal(cases[3].jsMatch, cases[3].rgMatch, 'explicit text NUL control must agree')
  const measuredModules = ['tools/bench-rg-decision.js', 'tools/rg-decision-cleanup.js', 'src/search/sidecar-snapshot.ts']
  const sourceHashes = Object.fromEntries(measuredModules.map(path => [
    path, createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex'),
  ]))
  console.log(JSON.stringify({
    version,
    executableSha256: approvedBinary,
    sourceHashes,
    fixtureFiles: paths.length,
    fixtureBytes: captured.bytes,
    snapshot: {
      ms: captured.ms, gitRequests: captured.gitRequests, gitSpawns: captured.gitSpawns,
      base: captured.base, rev: captured.rev,
    },
    replacementSnapshot: {
      ms: replacement.ms, gitRequests: replacement.gitRequests,
      gitSpawns: replacement.gitSpawns, rev: replacement.rev,
    },
    readings,
    compatibility: cases,
    mutationIsolation: true,
    boundary: 'Generated View→private snapshot only, never physical worktree. Snapshot preparation and subprocess spawn counted; JS memory and rg filesystem timings are different stages. Semantic mismatches prohibit transparent integration; overlay readings do not activate0.4.',
  }, null, 2))
} finally {
  try { try { await log?.close() } finally { await truth?.close() } }
  finally {
    removeGeneratedDirectories([...snapshots, root])
  }
}
