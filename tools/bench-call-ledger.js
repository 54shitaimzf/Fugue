#!/usr/bin/env node
// Generated-only evidence: capped-heap snapshot ledger versus unchanged cached M0 reader.
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
const sourceAt = process.argv.indexOf('--source')
const repo = resolve(process.argv[2] === '--child' ? process.argv[5] : sourceAt < 0 ? resolve(import.meta.dirname, '..') : process.argv[sourceAt + 1])
const load = path => import(pathToFileURL(join(repo, path)).href)
const { openLog } = await load('src/log/log.ts')
const { readLogSnapshot } = await load('src/log/stream.ts')
const { encodeEvent } = await load('src/log/envelope.ts')
const { readCallLedger } = await load('src/probe/call-ledger.ts')

const call = { t: 'llm/call', agent: 'a', step: '0', model: 'generated', wire: 'openai-chat', thinking: null,
  toolCount: 12, invocations: 0, status: null, headers: null, rawStop: 'stop', stop: 'end-turn',
  usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: null, outputTokens: 2, reasoningTokens: null } }

if (process.argv[2] === '--child') {
  const [, , , root, mode] = process.argv
  const log = mode === 'cached' ? openLog(root) : null
  try {
    const started = performance.now()
    const ledger = await readCallLedger(log === null ? readLogSnapshot(root) : log.readMerged(), 5)
    console.log(JSON.stringify({ ms: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS, ledger }))
  } finally { await log?.close() }
} else {
  const hashes = Object.fromEntries(['src/log/stream.ts', 'src/log/log.ts', 'src/log/envelope.ts', 'src/probe/call-ledger.ts']
    .map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')]))
  const root = mkdtempSync(join(resolve(import.meta.dirname, '..'), '.fugue-ledger-memory-'))
  try {
    mkdirSync(join(root, '.fugue', 'log'), { recursive: true })
    const fd = openSync(join(root, '.fugue', 'log', 'a.jsonl'), 'wx')
    const rows = 24_000, every = 80, body = 'generated-only '.repeat(300)
    let bytes = 0, calls = 0
    try {
      for (let seq = 1; seq <= rows; seq++) {
        const event = seq % every === 0 ? { ...call, step: String(++calls) } :
          { t: 'agent/handoff', agent: 'a', successor: 'b', contract: 'c', digest: 'd', body }
        const row = Buffer.from(encodeEvent(seq, 'a', event) + '\n')
        bytes += row.length
        let written = 0
        while (written < row.length) written += writeSync(fd, row, written)
      }
    } finally { closeSync(fd) }
    const results = {}
    for (const mode of ['cached', 'stream']) {
      // Disable crash-core creation only for this generated owned benchmark process.
      const child = spawnSync('bash', ['-c', 'ulimit -c 0; exec "$@"', 'owned-ledger', process.execPath,
        '--max-old-space-size=32', import.meta.filename, '--child', root, mode, repo], {
        encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024,
        env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8' },
      })
      let value = null
      if (child.status === 0) value = JSON.parse(child.stdout)
      results[mode] = { status: child.status, signal: child.signal, error: child.error?.message ?? null,
        heapLimitMiB: 32, value, failureStderr: child.status === 0 ? null : child.stderr }
      if (value !== null && (value.ledger.totalCalls !== calls || value.ledger.calls.length !== 5 || !value.ledger.truncated ||
          value.ledger.calls.some((entry, at) => entry.source.seq !== (at + 1) * every))) {
        throw new Error(`${mode}: generated full-corpus ledger reference mismatch`)
      }
    }
    if (results.stream.status !== 0) throw new Error(`stream benchmark failed: ${JSON.stringify(results.stream)}`)
    console.log(JSON.stringify({ schema: 1, node: process.version, sourceHashes: hashes, scriptSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'), generated: { rows, bytes, totalCalls: calls, retainedCalls: 5 },
      boundary: 'Distinct processes, generated corpus in workspace filesystem, capped V8 heap; RSS includes native memory. Cached-first OS cache order, no latency conclusion.', results }, null, 2))
  } finally { rmSync(root, { recursive: true, force: true }) }
}
