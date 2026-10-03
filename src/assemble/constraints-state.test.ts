// tier: real —— generated Git repository, real Truth reads and M0 runtime writes; no provider traffic
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readConfig } from '../config.ts'
import { openLog } from '../log/log.ts'
import { BUILTIN_CATALOG, defaultModelOf } from '../model/catalog.ts'
import type { ModelEvent } from '../model/contract.ts'
import { wireNamed } from '../model/wire/registry.ts'
import { createRuntime, recordingExecutor, scriptedModel } from '../runtime/step.ts'
import type { AgentHandle } from '../runtime/step.ts'
import type { AgentId, BranchId, ContractId, RefName, RelPath } from '../terms.ts'
import { openTruth } from '../truth/truth.ts'
import { assemble } from './assemble.ts'
import { checkConstraints, constraintWitness, envFacts, formatViolation } from './constraints.ts'
import type { Protocol } from './contract.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from './protocol.ts'
import { emptyState, sourcesFor } from './sources.ts'
import type { AgentCoord, AssembleState } from './sources.ts'
import { stateWithState } from './sources-state.ts'

const POLICY = fileURLToPath(new URL('../../AGENTS.md', import.meta.url))
const MODEL = defaultModelOf(BUILTIN_CATALOG)
const AGENT = 'constraint-witness' as AgentId
const WHO: AgentCoord = { id: AGENT, branch: 'refs/heads/main', outputPaths: ['deliver/result.md'] }

/** Read the actual accepted developer policy; real environment collisions remain separately characterized. */
function policyViolations(protocol: Protocol, state: AssembleState) {
  const { segments, prefix } = assembled(protocol, state)
  const facts = envFacts()
  const violations = checkConstraints(protocol, segments, prefix, 'unchanged state', facts, prefix)
  assert.deepEqual(violations.filter(v => v.kind === 'materialized'), [], 'accepted main cleared the real developer-policy paths')
  // Small process IDs can also collide with the policy's section/example numbers.
  assert.ok(violations.every(v => v.kind === 'env'), violations.map(formatViolation).join('\n'))
  for (const violation of violations.filter(v => v.kind === 'env')) {
    assert.equal(violation.where, '项目方针', 'real projected sources must not introduce environment identities')
    const lead = 'A 区那一段里有环境标识：'
    assert.ok(violation.detail.startsWith(lead))
    const hit = violation.detail.slice(lead.length)
    assert.ok(state.policy.includes(hit), 'the admitted environment collision must occur in the actual policy')
    assert.ok((facts.hostname !== '' && hit === facts.hostname) || new RegExp(`^(?:[^0-9])?${facts.pid}$`).test(hit),
      'the admitted policy collision must identify the current hostname or pid')
  }
  return violations
}

/** The policy is the repository's current bytes, never a sanitized test constant. */
async function withState(fn: (root: string, state: AssembleState) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'fugue-constraints-state-'))
  const root = join(home, 'project')
  let truth: ReturnType<typeof openTruth> | undefined
  try {
    mkdirSync(root)
    mkdirSync(join(root, '.fugue'))
    writeFileSync(join(root, 'AGENTS.md'), readFileSync(POLICY))
    writeFileSync(join(root, 'source.ts'), 'export const answer = 42\n')
    writeFileSync(join(root, '.fugue/config'), JSON.stringify({
      workspace: 'constraint-project', platform: 'linux', config: { net: 'none' },
      actions: { test: { argv: ['node', 'source.ts'], env: { PRIVATE_CONTEXT: home } } },
    }))
    const env = {
      PATH: process.env.PATH, HOME: home, LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Constraint witness', GIT_AUTHOR_EMAIL: 'witness@example.invalid',
      GIT_COMMITTER_NAME: 'Constraint witness', GIT_COMMITTER_EMAIL: 'witness@example.invalid',
    }
    for (const args of [['init', '-q', '--initial-branch=main'], ['add', 'source.ts'], ['commit', '-qm', 'source seed']]) {
      const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    truth = openTruth(root)
    const head = await truth.resolve('refs/heads/main' as RefName)
    const entries = await truth.listAt(head, '' as RelPath)
    const bytes = await truth.readAt(head, 'source.ts' as RelPath)
    assert.ok(bytes !== null)
    const config = await readConfig(root, join(home, 'system'))
    const state = stateWithState({
      ...emptyState(), codeTree: entries.map(entry => entry.name),
      files: [{ path: 'source.ts', text: new TextDecoder().decode(bytes) }],
      commits: [`${head} source seed`], goal: 'Verify the four assembly constraints',
      runtime: 'Read the source and report the result.',
      task: { goal: 'Read source.ts', question: '', deliverables: ['deliver/result.md'], evidenceRequired: [], assertions: [] },
    }, config, root)
    assert.equal(state.policy, readFileSync(POLICY, 'utf8'))
    assert.ok(!JSON.stringify(state.system).includes(home), 'action environment escaped the product projection')
    await fn(root, state)
  } finally {
    try { truth?.close() } finally { rmSync(home, { recursive: true, force: true }) }
  }
}

function assembled(protocol: Protocol, state: AssembleState) {
  const segments = sourcesFor(protocol, state, protocol === HOLDER_PROTOCOL ? null : WHO)
  const prefix = assemble({ protocol, model: MODEL.id, segments })
  return { segments, prefix }
}

for (const protocol of [SUBAGENT_PROTOCOL, HOLDER_PROTOCOL]) {
  test(`${protocol === HOLDER_PROTOCOL ? 'holder' : 'subagent'}: actual accepted policy has no developer-path leakage`, async () => {
    await withState(async (_root, state) => {
      const { prefix } = assembled(protocol, state)
      policyViolations(protocol, state)
      assert.ok(prefix.zoneA.length > 0 && prefix.zoneB.length > 0 && prefix.zoneC.length > 0)
    })
  })
}

test('real project policy and source injections identify each byte-leak constraint', async () => {
  await withState(async (root, state) => {
    const facts = envFacts()
    const cases: [AssembleState, string, string][] = [
      [{ ...state, policy: `${root}/materialized\n` + state.policy }, 'materialized', '项目方针'],
      [{ ...state, files: [{ path: 'source.ts', text: `root: ${root}/materialized` }] }, 'materialized', '文件内容'],
      [{ ...state, lastStep: `root: ${root}/materialized` }, 'materialized', '上一步结果'],
      [{ ...state, system: { ...state.system as object, host: facts.hostname, pid: facts.pid } }, 'env', '系统状态'],
      [{ ...state, signals: ['{"kind":"done","digest":"raw-signal"}'] }, 'signal', '信号摘要'],
    ]
    for (const [broken, kind, where] of cases) {
      const { segments, prefix } = assembled(SUBAGENT_PROTOCOL, broken)
      const violations = checkConstraints(SUBAGENT_PROTOCOL, segments, null, 'injected state', facts, prefix)
      assert.ok(violations.some(v => v.kind === kind && v.where === where &&
        (kind !== 'materialized' || v.detail.includes(`${root}/materialized`))), `${kind} in ${where} was not detected`)
    }
  })
})

function handle(state: AssembleState): AgentHandle {
  const adapter = wireNamed('anthropic-messages')
  return {
    agent: AGENT, coord: WHO, branch: WHO.branch as BranchId, contract: 'constraint-contract' as ContractId,
    protocol: SUBAGENT_PROTOCOL, model: MODEL.id, wireModel: MODEL.id, adapter,
    target: { host: '', path: '', model: MODEL.id, wire: adapter, from: 'fixture', headers: {} }, state,
  }
}

test('a real quiet runtime transition checks previous and current product prefixes', async () => {
  await withState(async (root, state) => {
    const log = openLog(root, { write: AGENT })
    try {
      const runtime = createRuntime({
        logOf: () => log,
        call: scriptedModel([[{ t: 'stop', reason: 'end-turn', raw: 'end_turn' }]]),
        execute: recordingExecutor(() => { throw new Error('quiet step must not invoke a tool') }),
      })
      const before = assembled(SUBAGENT_PROTOCOL, state)
      const result = await runtime.step(handle(state), new AbortController().signal)
      assert.equal(result.next.step, state.step + 1)
      assert.equal(result.outcome.kind, 'done')
      const after = assembled(SUBAGENT_PROTOCOL, result.next)
      const violations = checkConstraints(SUBAGENT_PROTOCOL, after.segments, before.prefix, 'quiet runtime step', envFacts(), after.prefix)
      assert.deepEqual(violations, policyViolations(SUBAGENT_PROTOCOL, state), 'quiet step adds no new violations; current policy is still not clean')
      const rewritten = assembled(SUBAGENT_PROTOCOL, { ...result.next, runtime: 'rewritten ' + state.runtime })
      assert.ok(checkConstraints(SUBAGENT_PROTOCOL, rewritten.segments, before.prefix, 'rewrite', envFacts(), rewritten.prefix)
        .some(v => v.kind === 'append-only'))
    } finally { await log.close() }
  })
})

test('a nonquiet product transition accepts named accumulation while retaining the bare whole-C boundary', async () => {
  await withState(async (root, state) => {
    const log = openLog(root, { write: AGENT })
    try {
      const events: ModelEvent[] = [{ t: 'delta', text: 'The source contains answer 42.' }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }]
      const runtime = createRuntime({ logOf: () => log, call: scriptedModel([events]), execute: recordingExecutor(() => ({ ok: true, output: '' })) })
      const before = assembled(SUBAGENT_PROTOCOL, state)
      const result = await runtime.step(handle(state), new AbortController().signal)
      assert.equal(result.next.turns?.length, 1)
      assert.deepEqual(result.next.turns?.slice(0, state.turns?.length ?? 0), state.turns ?? [])
      const after = assembled(SUBAGENT_PROTOCOL, result.next)
      assert.deepEqual(after.prefix.zoneA, before.prefix.zoneA)
      assert.deepEqual(after.prefix.zoneB, before.prefix.zoneB)
      const violations = checkConstraints(SUBAGENT_PROTOCOL, after.segments, before.prefix, 'nonquiet runtime step', envFacts(), after.prefix)
      const baseline = policyViolations(SUBAGENT_PROTOCOL, state)
      assert.deepEqual(violations.filter(v => v.kind !== 'append-only'), baseline)
      assert.equal(violations.filter(v => v.kind === 'append-only').length, 1,
        'whole C includes replaced suffixes; this is not a zero-violation acceptance claim')
      const witness = constraintWitness(SUBAGENT_PROTOCOL, before.segments, before.prefix)
      assert.ok(witness !== null)
      assert.deepEqual(checkConstraints(SUBAGENT_PROTOCOL, after.segments, before.prefix,
        'named nonquiet runtime step', envFacts(), after.prefix, witness), baseline)
      for (const runtimeText of ['rewritten ' + state.runtime, '']) {
        const broken = assembled(SUBAGENT_PROTOCOL, { ...result.next, runtime: runtimeText })
        const faults = checkConstraints(SUBAGENT_PROTOCOL, broken.segments, before.prefix,
          'changed accumulating input', envFacts(), broken.prefix, witness)
        assert.deepEqual(faults.filter(v => v.kind !== 'append-only'), baseline)
        assert.deepEqual(faults.filter(v => v.kind === 'append-only').map(v => v.where), ['运行时上下文'])
      }
    } finally { await log.close() }
  })
})
