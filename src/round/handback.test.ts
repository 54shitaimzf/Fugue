// U18 甲案的机制层断言：**固定尺（三档 · 两类进人）· 一次裁断（不积累上下文）· 判决 · 退化路全转发**。
//
// 出处：架构 § 23 的 U18 那一格 · 路线图 0.2.7 行 ② 的验收列（"设计预期类问题被转发 + 契约内问题
// 被选定且落账，各要能红"）· 交接单 § 四 的 U2 行。
//
// 这一份量的是**机制**（尺 · 裁断 · 判决 · 事件形状），不是接线：接线那一条（谁在什么时候叫它）
// 在驱动那一层的断言里。两条各能红，缺一条这一站不算数。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Contract } from '../contract/types.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { ModelEvent } from '../model/contract.ts'
import { wireNamed } from '../model/wire/registry.ts'
import type { CallModel, RuntimeRequest } from '../runtime/step.ts'
import type { AskItem } from '../tools/execute.ts'
import type { AgentId, ContractId, WriterId } from '../terms.ts'
import {
  ASK_RULER,
  ASK_RULER_TEXT,
  ASK_RULER_VERSION,
  adjudicateAsk,
  askPromptOf,
  forwardAll,
  humanTiers,
  raisedEventOf,
  rulingEventOf,
  selfTiers,
  takeAsks,
  unansweredAsks,
  verdictOf,
} from './handback.ts'

const ADAPTER = wireNamed('anthropic-messages')
const TARGET = {
  providerId: '',
  host: 'example.invalid',
  path: '/v1/messages',
  model: 'fixture-model',
  wire: ADAPTER,
  from: 'fixture' as const,
  headers: {},
}
const AGENT = 'r1/1' as AgentId
const CONTRACT = { id: 'r1.implement.1', kind: 'implement', goal: '把分换算成元' } as unknown as Contract
const TASK = {
  goal: '把分换算成元',
  question: '分与元的边界在哪一处',
  deliverables: ['src/format.ts'],
  evidenceRequired: [],
  assertions: ['npm test'],
  ownedPaths: ['src/format.ts'],
}
const ASKS: readonly AskItem[] = [
  { question: '这条路径归我还是归另一格？', header: '地界', options: [{ label: '归我' }, { label: '归它', description: '另一格写着' }] },
]

/** 一个会说话的假模型，**并把收到的请求留下**（"不积累上下文"那一条要量它）。 */
function recordingModel(scripts: readonly (readonly ModelEvent[])[], seen: RuntimeRequest[]): CallModel {
  let at = 0
  return (request) => {
    seen.push(request)
    const events = scripts[Math.min(at, scripts.length - 1)] ?? []
    at += 1
    return {
      events: (async function* (): AsyncGenerator<ModelEvent> {
        for (const e of events) yield e
      })(),
      ledger: () => ({ call: null, failure: null, attempts: [200] }),
    }
  }
}

/** 一段回复（模型面：英文键的那两行 + 收尾）。 */
function reply(text: string): ModelEvent[] {
  return [
    { t: 'delta', text },
    { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
  ]
}

// ── ① 固定尺：三档 · 两类进人 · 版本化常量 ────────────────────────────────────

test('① 固定尺：三档 · 两类进人 · 版本在正文里', async () => {
  assert.equal(ASK_RULER.length, 3, `尺该是三档，实得 ${ASK_RULER.length}`)
  assert.deepEqual(
    ASK_RULER.map((r) => r.tier),
    ['contract', 'design', 'user'],
  )
  // **两类进人**：自决一档 · 进人两档——判据从 `who` 那一栏推，不另抄一份名单。
  assert.deepEqual(selfTiers(), ['contract'])
  assert.deepEqual(humanTiers(), ['design', 'user'])
  assert.equal(ASK_RULER.filter((r) => r.who === 'human').length, 2, '进人的档数不是两档')
  // 尺是**版本化常量**：正文里带着版本号，而且与那一栏同源。
  assert.ok(ASK_RULER_TEXT.includes(ASK_RULER_VERSION), '尺的正文里没有版本号')
  assert.equal(ASK_RULER_VERSION, 'ask-ruler-2')
  console.log(`① 读数：三档 ${ASK_RULER.map((r) => `${r.tier}(${r.who})`).join(' · ')} · 尺的版本 ${ASK_RULER_VERSION}`)
})

// ── ② 判决那一档：三档各判一次，判不出来走退化路 ─────────────────────────────

test('② 判决：自决那一档不进人 · 进人那两档进人 · 判不出来全转发', async () => {
  const settle = verdictOf('tier: contract\nruling: 这条路径归你，按最小改动落 src/format.ts。')
  assert.deepEqual({ tier: settle.tier, forwarded: settle.forwarded }, { tier: 'contract', forwarded: false })
  assert.match(settle.ruling, /最小改动/)

  const design = verdictOf('tier: design\nruling: 要不要把「分」这个单位从契约里去掉，得人定。')
  assert.deepEqual({ tier: design.tier, forwarded: design.forwarded }, { tier: 'design', forwarded: true })

  const user = verdictOf('tier: user\nruling: 输入行要不要变色，是人看得见的行为，得人定。')
  assert.deepEqual({ tier: user.tier, forwarded: user.forwarded }, { tier: 'user', forwarded: true })

  // **判不出来那一档：全转发**（不是猜一档，也不是当成功）。三条各一条。
  const empty = verdictOf('')
  assert.equal(empty.tier, null)
  assert.equal(empty.forwarded, true)
  assert.match(empty.ruling, /原样转给该进的人/)
  const noTier = verdictOf('ruling: 我判不了。')
  assert.equal(noTier.tier, null)
  const chatty = verdictOf('我看了一下，这条大概算 contract 吧，你们自己定。')
  assert.equal(chatty.tier, null, '没按那两行的形状回，就不许当判出来了')
  assert.match(chatty.why ?? '', /读不出/)
  console.log(`② 读数：contract/design/user 三条 · 判不出来三条（${empty.why ?? ''}）`)
})

// ── ③ 一次裁断：上下文一次性（复用 A 区 · 契约 · 问题 · 尺），C 区是空的 ────────

test('③ 一次裁断：请求里只有那四样 · C 区是空的 · 工具一个都不公布', async () => {
  const aZone = new TextEncoder().encode('# policy\n真方针的字节\n')
  const seen: RuntimeRequest[] = []
  const model = recordingModel([reply('tier: contract\nruling: 按最干净的那条走。')], seen)
  const verdict = await adjudicateAsk(
    { aZone, contract: CONTRACT, task: TASK, asks: ASKS },
    { call: model, target: TARGET, adapter: ADAPTER, model: 'fixture-model' },
  )
  assert.equal(verdict.tier, 'contract')
  assert.equal(seen.length, 1, `一次裁断只该发一次调用，实发 ${seen.length}`)
  const req = seen[0] as RuntimeRequest
  // **A 区原样复用**：逐字节相同（不重排、不加壳）。
  assert.deepEqual(new Uint8Array(req.prefix.zoneA), aZone, 'A 区不是原样那一段')
  // **C 区是空的**：那一格走过的步 · 上一步结果 · 它自己说过的话，一个字都不进这次调用。
  assert.equal(req.prefix.zoneC.length, 0, 'C 区不是空的——推敲进了别人的历史')
  assert.equal(req.turns, undefined, '请求里带了已经走过的轮次')
  assert.equal(req.cHead, undefined, '请求里带了 C 区那一段的头')
  assert.equal(req.tools.length, 0, '裁断那一次不该公布工具')
  // 一次性的那四样都在 B 区里：契约 · 尺（带版本）· 问题原文——**问题排在最后**（近因）。
  const body = new TextDecoder().decode(req.prefix.zoneB)
  assert.ok(body.includes(CONTRACT.id), 'B 区里没有契约')
  assert.ok(body.includes(ASK_RULER_VERSION), 'B 区里没有尺（或没有版本号）')
  assert.ok(body.includes(ASKS[0]?.question ?? ''), 'B 区里没有问题原文')
  const lines = body.split('\n')
  const lastQuestion = lines.findIndex((l) => l.includes(ASKS[0]?.question ?? ''))
  assert.ok(lastQuestion > lines.findIndex((l) => l.includes(ASK_RULER_VERSION)), '问题没有排在尺之后')
  assert.ok(lastQuestion > lines.findIndex((l) => l.includes(CONTRACT.id)), '问题没有排在契约之后')
  console.log(`③ 读数：一次调用 · A 区 ${aZone.length} 字节原样 · B 区 ${req.prefix.zoneB.length} 字节 · C 区 0 字节 · 工具 0 条`)
})

// ── ④ 退化路全转发：回复读不出 · 调用抛了 · 调用没走完，三条同一档 ──────────────

test('④ 退化路全转发：三条都进人 · 问题原样 · 由头写得出', async () => {
  const aZone = new Uint8Array(0)
  const input = { aZone, contract: CONTRACT, task: TASK, asks: ASKS }
  const deps = { target: TARGET, adapter: ADAPTER, model: 'fixture-model' }

  // 甲 · 回复读不出那两行。
  const a = await adjudicateAsk(input, { ...deps, call: recordingModel([reply('嗯，我看着办吧。')], []) })
  assert.equal(a.tier, null)
  assert.equal(a.forwarded, true)
  assert.match(a.ruling, /原样转给该进的人/)

  // 乙 · 调用抛了。
  const boom: CallModel = () => {
    throw new Error('线断了')
  }
  const b = await adjudicateAsk(input, { ...deps, call: boom })
  assert.equal(b.tier, null)
  assert.equal(b.forwarded, true)
  assert.match(b.why ?? '', /抛了/)
  assert.match(b.why ?? '', /线断了/)

  // 丙 · 调用没走完（有 `failure`）。
  const cut: CallModel = () => ({
    events: (async function* (): AsyncGenerator<ModelEvent> {})(),
    ledger: () => ({ call: null, failure: '这一条流没走完', attempts: [200] }),
  })
  const c = await adjudicateAsk(input, { ...deps, call: cut })
  assert.equal(c.tier, null)
  assert.equal(c.forwarded, true)
  assert.match(c.why ?? '', /没走完/)
  // **三条的判词都点得出它是什么**（不是一句"失败"了事）。
  console.log(`④ 读数：读不出 → ${a.why ?? ''}｜抛了 → ${b.why ?? ''}｜没走完 → ${c.why ?? ''}`)
})

// ── ⑤ 事件的两个形状：问题被接住 · 判决落事件（只带结论） ─────────────────────

test('⑤ 事件：接住那一条带问题原文 · 判决那一条只带结论且指得回它', async () => {
  const raised = raisedEventOf(AGENT, CONTRACT.id as ContractId, ASKS)
  assert.equal(raised.t, 'ask/raised')
  assert.ok(raised.t === 'ask/raised')
  assert.equal(raised.agent, AGENT)
  assert.equal(raised.contract, CONTRACT.id)
  assert.match(raised.body, /归我还是归另一格/)
  assert.ok(raised.digest.length > 0)

  const verdict = verdictOf('tier: design\nruling: 这要推翻架构的一句话，人定。')
  const ruling = rulingEventOf(AGENT, raised.digest, verdict)
  assert.equal(ruling.t, 'ask/ruling')
  assert.ok(ruling.t === 'ask/ruling')
  // 判决那一条**只带结论**：档 · 进不进人 · 尺的版本——推敲不在这里（也没有第二个字段装它）。
  assert.equal(ruling.tier, 'design')
  assert.equal(ruling.forwarded, true)
  assert.equal(ruling.ruler, ASK_RULER_VERSION)
  assert.equal(ruling.asked, raised.digest, '判决没指回被接住的那一问')
  assert.deepEqual(Object.keys(ruling).sort(), ['agent', 'asked', 'body', 'digest', 'forwarded', 'ruler', 't', 'tier'])

  // `unansweredAsks`：没判过的在单子上，判过的落下去（同一问不裁第二回）。
  assert.deepEqual(
    unansweredAsks([raised]).map((a) => a.digest),
    [raised.digest],
  )
  assert.deepEqual(unansweredAsks([raised, ruling]), [])
  console.log(`⑤ 读数：接住 ${raised.digest} · 判决字段 ${Object.keys(ruling).sort().join(' · ')}`)
})

// ── ⑥ 判词那一栏读得出来（退化路那句话也是判词的一部分） ─────────────────────

test('⑥ 判词：三档各自的判词都落在判决里 · 退化路那句如实说它判不了', async () => {
  for (const tier of ['contract', 'design', 'user'] as const) {
    const v = verdictOf(`tier: ${tier}\nruling: 这是 ${tier} 那一档的判词。`)
    assert.equal(v.tier, tier)
    assert.match(v.ruling, new RegExp(tier))
  }
  const gone = forwardAll('那一次调用抛了：线断了')
  assert.deepEqual(Object.keys(gone).sort(), ['forwarded', 'ruler', 'ruling', 'tier', 'why'])
  assert.equal(gone.tier, null)
  assert.equal(gone.forwarded, true)
  console.log('⑥ 读数：三档判词各一条 · 退化路那条带 why')
})

// ── ⑦ 落在日志里的那一趟：接住 · 判决 · 进人那一档才敲门 ──────────────────────

/**
 * 这一条量的是**落账那一趟**（`takeAsks`）：接住那一条 · 判决那一条都进日志，进人那一档
 * 才多敲一下门，转出去的正文与接住的**逐字节相同**，而进 C 区的那一句只带判词。
 * 接线（谁在什么时候叫它）在驱动那一层；这一层在 fast 档里守着，改这一处当场红。
 */
test('⑦ 落账：接住 + 判决两条都进日志 · 自决那一档不敲门 · 进人那一档原样转出去', async () => {
  const aZone = new TextEncoder().encode('# policy\n真方针的字节\n')
  const run = async (tier: 'contract' | 'design'): Promise<LogEvent[]> => {
    const root = mkdtempSync(join(tmpdir(), 'fugue-ask-'))
    try {
      const log = openLog(root, { sync: 'never' })
      const r = await takeAsks({
        log,
        writer: 'w1' as WriterId,
        agent: AGENT,
        contract: CONTRACT,
        task: TASK,
        asks: ASKS,
        aZone,
        call: recordingModel([reply(`tier: ${tier}\nruling: ${tier} 那一档的判词。`)], []),
        target: TARGET,
        adapter: ADAPTER,
        model: 'fixture-model',
      })
      assert.equal(r.verdict.tier, tier)
      // 进那一格下一步 C 区的那一句**只带结论**：`tier:` 那两行是推敲，一个字都不许进去。
      assert.ok(!r.note.includes('tier:'), '进 C 区那一句带上了推敲')
      const out: LogEvent[] = []
      for await (const { e } of log.readMerged()) out.push(e)
      const raised = out.find((e) => e.t === 'ask/raised')
      const ruling = out.find((e) => e.t === 'ask/ruling')
      assert.ok(raised !== undefined && raised.t === 'ask/raised', '日志里没有被接住的那一条')
      assert.ok(ruling !== undefined && ruling.t === 'ask/ruling', '日志里没有判决那一条')
      // 判决指得回被接住的那一问：同一问只裁一次。
      assert.equal(ruling.asked, raised.digest)
      assert.equal(r.asked, raised.digest)
      return out
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // 契约自己那一档：**自决**——两条落账，人的门口一条不发。
  const settled = await run('contract')
  assert.deepEqual(
    settled.map((e) => e.t),
    ['ask/raised', 'ask/ruling'],
  )
  const ruler = settled.find((e) => e.t === 'ask/ruling')
  assert.ok(ruler !== undefined && ruler.t === 'ask/ruling')
  assert.equal(ruler.forwarded, false)
  assert.equal(ruler.ruler, ASK_RULER_VERSION)

  // 设计预期那一档：**进人**——多一条 `holder/ask`，正文与接住的逐字节相同。
  const carried = await run('design')
  assert.deepEqual(
    carried.map((e) => e.t),
    ['ask/raised', 'ask/ruling', 'holder/ask'],
  )
  const a = carried.find((e) => e.t === 'ask/raised')
  const b = carried.find((e) => e.t === 'holder/ask')
  assert.ok(a !== undefined && a.t === 'ask/raised')
  assert.ok(b !== undefined && b.t === 'holder/ask')
  assert.equal(b.body, a.body, '转出去的正文与接住的那一条不是逐字节相同')
  assert.equal(b.digest, a.digest)
  console.log(
    `⑦ 读数：contract → ${settled.map((e) => e.t).join(' · ')}｜design → ${carried.map((e) => e.t).join(' · ')} · 转出去的正文 ${b.body.length} 字节逐字节相同`,
  )
})
