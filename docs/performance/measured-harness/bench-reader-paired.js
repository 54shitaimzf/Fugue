#!/usr/bin/env node
// Developer-only generated corpus; compare exact reader results without product edits.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync, appendFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argument = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] }
const before = resolve(argument('--before', resolve(import.meta.dirname, '..')))
const after = resolve(argument('--after', before))
const runs = Number(argument('--runs', '3')), writers = Number(argument('--writers', '8')), perWriter = Number(argument('--rows', '3000'))
assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 10)
assert.ok(Number.isSafeInteger(writers) && writers >= 1 && writers <= 32)
assert.ok(Number.isSafeInteger(perWriter) && perWriter >= 1 && perWriter <= 20000)
const work = mkdtempSync(join(resolve(argument('--temp-parent', resolve(import.meta.dirname, '..'))), '.reader-bench-'))
const counters = { fileReads: 0, fileReadBytes: 0, chunkReads: 0, chunkReadBytes: 0, stats: 0, opens: 0 }
const original = { readFile: fsp.readFile, stat: fsp.stat, open: fsp.open }
fsp.readFile = async (...args) => { const result = await original.readFile(...args); counters.fileReads++; counters.fileReadBytes += Buffer.byteLength(result); return result }
fsp.stat = async (...args) => { counters.stats++; return original.stat(...args) }
fsp.open = async (...args) => { const handle = await original.open(...args); counters.opens++; const stat = handle.stat.bind(handle), read = handle.read.bind(handle); handle.stat = async (...input) => { counters.stats++; return stat(...input) }; handle.read = async (...input) => { const result = await read(...input); counters.chunkReads++; counters.chunkReadBytes += result.bytesRead; return result }; return handle }
syncBuiltinESMExports()
const load = (root, path) => import(pathToFileURL(join(root, path)).href)
const { openLog, LogCorruptError } = await load(before, 'src/log/log.ts')
const { readLogSnapshot, STREAM_LOG_LIMITS } = await load(after, 'src/log/stream.ts')
const { encodeEvent } = await load(before, 'src/log/envelope.ts')
const { readCallLedger, callLedgerOf } = await load(before, 'src/probe/call-ledger.ts')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = root => ({ commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), hashes: Object.fromEntries(['src/log/log.ts', 'src/log/envelope.ts', 'src/probe/call-ledger.ts', ...(root === after ? ['src/log/stream.ts'] : [])].map(path => [path, hash(readFileSync(join(root, path)))])) })
const event = (writer, seq) => seq % 37 === 0 ? { t: 'llm/call', agent: writer, step: String(seq), model: 'generated', wire: 'openai-chat', thinking: null, toolCount: 7, invocations: seq % 3, status: null, headers: null, rawStop: 'stop', stop: 'end-turn', usage: { inputTokens: seq, cacheReadTokens: 0, cacheWriteTokens: null, outputTokens: 2, reasoningTokens: null } } : { t: 'agent/handoff', agent: writer, successor: 'next', contract: 'generated', digest: 'generated', body: `row${seq} 变量😀e\u0301 ` + 'generated-only '.repeat(110) }
let bytes = 0, maxRowBytes = 0
const corpusHash = createHash('sha256'), reference = []
const logDir = join(work, '.fugue', 'log')
try {
  mkdirSync(logDir, { recursive: true })
  for (let at = 0; at < writers; at++) {
    const writer = `w${String(at).padStart(2, '0')}`, fd = openSync(join(logDir, `${writer}.jsonl`), 'wx')
    corpusHash.update(writer + '\0')
    try { for (let seq = 1; seq <= perWriter; seq++) { const e = event(writer, seq), row = Buffer.from(encodeEvent(seq, writer, e) + '\n'); maxRowBytes = Math.max(maxRowBytes, row.length - 1); bytes += row.length; corpusHash.update(row); let wrote = 0; while (wrote < row.length) wrote += writeSync(fd, row, wrote); reference.push({ pos: { writer, seq }, e }) } }
    finally { closeSync(fd) }
  }
  reference.sort((a, b) => a.pos.seq - b.pos.seq || a.pos.writer.localeCompare(b.pos.writer))
  const expectedHash = hash(JSON.stringify(reference)), expectedLedger = callLedgerOf(reference, 5)
  const reset = () => Object.keys(counters).forEach(key => { counters[key] = 0 })
  async function measure(mode, log, fromSeq = 0) {
    reset(); const cpu = process.cpuUsage(), started = performance.now(); let firstYieldMs = null, rows = 0
    const digest = createHash('sha256')
    // Fold the same complete result into a digest, never retain an extra result list in timing runs.
    const iter = mode === 'cached' ? log.readMerged(fromSeq) : readLogSnapshot(work, fromSeq)
    const ledger = await readCallLedger((async function* () { for await (const row of iter) { if (firstYieldMs === null) firstYieldMs = performance.now() - started; digest.update(JSON.stringify(row)); digest.update('\n'); rows++; yield row } })(), 5)
    const used = process.cpuUsage(cpu)
    return { mode, fromSeq, firstYieldMs, totalMs: performance.now() - started, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, rows, resultHash: digest.digest('hex'), ledger, io: { ...counters } }
  }
  // Full deep equality is untimed. Hashes in paired timing runs are supplemental receipts.
  const referenceLog = openLog(work)
  let actual
  try { actual = []; for await (const row of referenceLog.readMerged()) actual.push(row); assert.deepEqual(actual, reference); actual = []; for await (const row of readLogSnapshot(work)) actual.push(row); assert.deepEqual(actual, reference) }
  finally { await referenceLog.close() }
  const trials = []
  for (let run = 0; run < runs; run++) {
    const log = openLog(work), phases = {}
    try {
      for (const mode of run % 2 === 0 ? ['cached', 'stream'] : ['stream', 'cached']) phases[mode] = await measure(mode, log)
      for (const mode of run % 2 === 0 ? ['stream', 'cached'] : ['cached', 'stream']) phases[mode + 'Repeat'] = await measure(mode, log)
      assert.equal(phases.cached.resultHash, phases.stream.resultHash); assert.equal(phases.cachedRepeat.resultHash, phases.streamRepeat.resultHash)
      for (const phase of Object.values(phases)) assert.deepEqual(phase.ledger, expectedLedger)
      trials.push({ run, firstOrder: run % 2 === 0 ? ['cached', 'stream'] : ['stream', 'cached'], phases })
    } finally { await log.close() }
  }
  const fromSeq = perWriter - 41, log = openLog(work)
  let suffix
  try { suffix = { cached: await measure('cached', log, fromSeq), stream: await measure('stream', log, fromSeq) }; assert.equal(suffix.cached.resultHash, suffix.stream.resultHash) } finally { await log.close() }
  const corruptWriter = `w${String(writers - 1).padStart(2, '0')}`
  appendFileSync(join(logDir, corruptWriter + '.jsonl'), '{"late":"corruption"}\n')
  const negative = {}
  for (const mode of ['cached', 'stream']) {
    const log = mode === 'cached' ? openLog(work) : null; let yielded = 0, error
    try { for await (const _ of log ? log.readMerged() : readLogSnapshot(work)) yielded++ } catch (e) { error = { name: e.name, writer: e.writer, line: e.line, reason: e.reason } } finally { await log?.close() }
    assert.equal(yielded, 0); assert.equal(error?.name, 'LogCorruptError'); assert.equal(error?.writer, corruptWriter); assert.equal(error?.line, perWriter + 1); negative[mode] = { yielded, error }
  }
  console.log(JSON.stringify({ schema: 1, node: process.version, platform: process.platform, before: source(before), after: source(after), scriptSha256: hash(readFileSync(import.meta.filename)), generated: { writers, rows: reference.length, bytes, maxRowBytes, corpusSha256: corpusHash.digest('hex'), fullDeepEquality: true, referenceJsonSha256: expectedHash }, trials, suffix, negative,
    logicalRetention: { kind: 'source-derived algorithmic counts, not measured RSS or heap', cached: { retainedParsedRows: reference.length, mergeRowReferences: reference.length, wholeFileUtf8DecodeMaxInputBytes: Math.ceil(bytes / writers) }, stream: { maxMergeHeads: writers, maxActiveChunksBytes: writers * 65536, corpusLineFragmentBoundBytes: writers * maxRowBytes, allowedLineFragmentBoundBytes: writers * STREAM_LOG_LIMITS.maxRowBytes, ledgerRows: 5, note: 'Also bounded decode/concatenation temporaries and one validation row. Parts own copied bytes; paused iterators retain a 64KiB chunk per writer. Source counts do not describe GC, string layout, native allocator or RSS.' } },
    boundary: 'Generated immutable multiauthor corpus in workspace filesystem, not tmpfs. Same Node process, alternating first/repeat order, fresh cached handle per trial. OS page cache is not dropped; untimed equality warms it. Source original readers, developer-only I/O wrappers. Snapshot validates all complete rows before first yield and reads/decodes twice; cached repeat retains all parsed rows and does no source read. No latency/RSS conclusion inferred from logical retention.' }, null, 2))
} finally { fsp.readFile = original.readFile; fsp.stat = original.stat; fsp.open = original.open; syncBuiltinESMExports(); rmSync(work, { recursive: true, force: true }) }
