// 四条约束的**常驻**测试：用这个仓库自己那一刻的方针字节走产品装配，期望 0 违反。出处：路线图
// 维护批那一行 ①（真状态走产品装配喂 `checkConstraints`，期望 0 违反；改动约束或约束住的那几份
// 真实文件时，当次 CI 变红。**不接发送路径**：这是门后的哨，不是门前的闸）。
//
// 与 `constraints.test.ts` 的分工：那一份量的是"把坏值放进去会怎样"（四类各报一处 · 正负对照），
// 这一份量的是**真值放进去不会怎样**——方针那一段是仓库里 `AGENTS.md` 的**原字节**（拷进一个临时
// 仓，走真 `readConfig` · 真 `openTruth` · 真 `stateWithState`，两步由真 `Runtime.step` 跑），
// 所以谁往那份文件里写进一条绝对路径（`/home/...` 那种），这一份里以真方针为底的那几条就当次
// 一起变红。
//
// 三处口径写在下面，都不是随手挑的：
//
//   · **基线的 0 违例取受控 facts**（`hostname: ''` · `pid: 0`）。检查器的环境那一档自带开关语义
//     （空宿主名不查 · pid > 0 才查），所以这两个数是**按契约不查**，不是碰巧不报。真 facts 下会
//     怎样：实测探针那一次 `process.pid` 落在 16，正撞上方针里「`§ 16`–`§ 18`」那一段，于是真
//     facts 下真方针会报一条 env——那一条按契约不是违例（`16` 是节号，不是环境标识）。所以基线
//     不用它，也不为它加白名单；③ 那一行读数每次都打印，看得出来它随 pid 走。
//   · **期望值从方针字节里推**：注入用的那几条绝对路径由 `import.meta.url` 算出的仓库根拼出来，
//     一个字面量都不抄（这一批的目的正是把那些路径清零，抄字面量等于自己埋一颗雷）。
//   · **非静默那一档是定性读数，不进 0 期望**（⑤）：整段 C 前缀这条口径下，真跑一步（有一句
//     话说给模型的轮次）恰好报一条 append-only。它量的是这条口径此刻的形状，不是"这一步违规"
//     ——口径一改（比如改成只比积累的那一段），那一条就红，改的人必须回来看这里。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readConfig } from '../config.ts'
import { openLog } from '../log/log.ts'
import type { ModelEvent } from '../model/contract.ts'
import { BUILTIN_CATALOG, defaultModelOf } from '../model/catalog.ts'
import { wireNamed } from '../model/wire/registry.ts'
import type { AgentHandle } from '../runtime/step.ts'
import { createRuntime, recordingExecutor, scriptedModel } from '../runtime/step.ts'
import type { AgentId, BlobId, BranchId, ContractId, RefName } from '../terms.ts'
import { openTruth } from '../truth/truth.ts'
import { assemble } from './assemble.ts'
import type { EnvFacts } from './constraints.ts'
import { checkConstraints, envFacts, formatViolation, sharedPrefixLen } from './constraints.ts'
import type { Prefix, SegmentId, SegmentValue } from './contract.ts'
import { SUBAGENT_PROTOCOL } from './protocol.ts'
import { render, stableStringify } from './render.ts'
import type { AgentCoord, AssembleState } from './sources.ts'
import { emptyState, sourcesFor } from './sources.ts'
import { stateWithState } from './sources-state.ts'

const DEFAULT_MODEL = defaultModelOf(BUILTIN_CATALOG)
/** 仓库根，由这一份文件的位置算出来（**不抄绝对路径**——这一批清的正是那些字面量）。 */
const REPO = fileURLToPath(new URL('../../', import.meta.url))

const WHO: AgentCoord = { id: 'agent-2', branch: 'refs/heads/agent-2', outputPaths: ['deliver/agent-2/report.md'] }
const AGENT = WHO.id as AgentId

/**
 * 受控 facts：环境标识那一档**按契约不查**（空宿主名不查 · `pid > 0` 才查 pid），所以基线那 0 条
 * 是确定的。
 */
const CONTROLLED: EnvFacts = { hostname: '', pid: 0 }

/** 一个临时工作区：真 git 仓 · 真配置 · 一份提交，方针那份字节从仓库里拷。 */
interface Live {
  readonly root: string
  /** 一份临时家目录：塞进动作绑定的 env 里，量"投影不是原文"。 */
  readonly home: string
  readonly state: AssembleState
  readonly segments: Record<SegmentId, SegmentValue>
  readonly prefix: Prefix
  readonly close: () => Promise<void>
}

async function realWorkspace(tag: string): Promise<Live> {
  const root = mkdtempSync(join(tmpdir(), `fugue-live-${tag}-`))
  const home = join(root, '临时家目录')
  mkdirSync(home, { recursive: true })
  // **方针 = 仓库里那份文件的字节**（一字不改地拷进去）。
  writeFileSync(join(root, 'AGENTS.md'), readFileSync(join(REPO, 'AGENTS.md'), 'utf8'))
  mkdirSync(join(root, '.fugue'), { recursive: true })
  writeFileSync(
    join(root, '.fugue', 'config'),
    JSON.stringify({
      platform: 'linux',
      workspace: 'fugue',
      config: { net: 'none' },
      actions: {
        build: { argv: ['make', 'build'], doc: '构建', outputs: ['dist/'], env: { PRIVATE_CONTEXT: home } },
      },
    }),
  )
  run('git', ['init', '-q', '.'], root)
  const truth = openTruth(root)
  // 一个真提交：`files` · `codeTree` · `commits` 三处的值从它读（不是手搭的常量）。
  const body = Buffer.from('export const x = 1\n')
  const blob = (await truth.putBlob(body)) as BlobId
  const tree = await truth.putTree([{ name: 'src/index.ts', mode: 0o100644, id: blob }])
  const commit = await truth.commit(tree, [], '起点')
  await truth.advance('refs/heads/main' as RefName, commit, null)
  const back = (await truth.readAt(commit, 'src/index.ts')) ?? body

  // 系统级配置指到一个空目录：**读数不取决于这台机器上有没有人配过系统级**（与测试入口同一条口径）。
  const systemDir = join(root, '系统级')
  mkdirSync(systemDir, { recursive: true })
  const state: AssembleState = {
    ...stateWithState(
      { ...emptyState(), goal: '把这一站做完。', runtime: '读一遍 src/index.ts，把结果报出来。' },
      await readConfig(root, systemDir),
      root,
    ),
    codeTree: ['src/index.ts'],
    files: [{ path: 'src/index.ts', text: Buffer.from(back).toString('utf8') }],
    commits: [`${commit.slice(0, 7)} 起点`],
  }
  const segments = sourcesFor(SUBAGENT_PROTOCOL, state, WHO)
  const prefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments })
  return {
    root,
    home,
    state,
    segments,
    prefix,
    close: async () => {
      await truth.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 这一格的句柄（`Runtime.step` 要的那一份）。目标那几栏用不上：脚本模型不看它。 */
function handleOf(state: AssembleState): AgentHandle {
  const adapter = wireNamed('anthropic-messages')
  return {
    agent: AGENT,
    coord: WHO,
    branch: WHO.branch as BranchId,
    contract: 'constraint-live' as ContractId,
    protocol: SUBAGENT_PROTOCOL,
    model: DEFAULT_MODEL.id,
    wireModel: DEFAULT_MODEL.id,
    adapter,
    target: { providerId: '', host: '', path: '', model: DEFAULT_MODEL.id, wire: adapter, from: 'fixture', headers: {} },
    state,
  }
}

/** 一份段值再装配一次（真状态那几条都走它，量的是产品那两个函数）。 */
function assembled(state: AssembleState): { segments: Record<SegmentId, SegmentValue>; prefix: Prefix } {
  const segments = sourcesFor(SUBAGENT_PROTOCOL, state, WHO)
  return { segments, prefix: assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments }) }
}

/**
 * ① 那一半：**真方针装出来的前缀里，四条约束一处都不报**。
 *
 * 抓住的变异：往仓库那份 `AGENTS.md` 里写进一条绝对路径（这一批清掉的那七处任意一处回潮）。
 * 检查器每段只报第一条（`findIn` 单发），所以判据是"整段清零"而不是"报出来的那条清掉"——
 * ② 那一路注入量的就是它。
 */
test('① 真方针走产品装配：四条约束 0 违反（受控 facts 下确定）', async () => {
  const w = await realWorkspace('baseline')
  try {
    // 方针那一段是**这一刻仓库里那份文件的字节**，不是洗过的常量（改一个字节，这里就变）。
    assert.equal(w.state.policy, readFileSync(join(REPO, 'AGENTS.md'), 'utf8'), '方针那一段不是那份文件的字节')
    assert.ok(w.state.policy.length > 1000, `方针那一份太短了（${w.state.policy.length} 字节）——夹具不像真方针`)
    const vs = checkConstraints(SUBAGENT_PROTOCOL, w.segments, null, '这一步', CONTROLLED, w.prefix)
    assert.deepEqual(vs, [], `真方针报出了违反：${vs.map(formatViolation).join(' | ')}`)
  } finally {
    await w.close()
  }
})

/**
 * ② 五路注入矩阵：每一条路各注入一处，**报出来的 `kind` 与 `where` 双命中**。
 *
 * 抓住的变异：约束 2 · 3 · 4 里任何一条被短路（把 `findIn` 那一路去掉 · 把 `SIGNAL_SHAPE` 放宽 ·
 * 把环境那一档的开关接错），对应的那一格当场翻假。末一条是负对照：同一条路注入**相对路径**，
 * 一条都不许报——不然上面那几条可能只是"什么都报"。
 */
test('② 五路注入：方针 · 文件内容 · 上一步结果 · 系统状态 · 信号摘要，各报 kind 与 where', async () => {
  const w = await realWorkspace('inject')
  try {
    // 注入用的两条绝对路径**从仓库根拼出来**（期望值从字节与环境里推，不抄字面量）。
    const ABS = join(REPO, 'src', 'index.ts')
    const ABS2 = join(REPO, 'deliver', 'out.md')
    const kws = (over: Readonly<Record<string, SegmentValue>>, facts: EnvFacts = CONTROLLED): string[] =>
      checkConstraints(SUBAGENT_PROTOCOL, { ...w.segments, ...over }, null, '这一步', facts).map(
        (v) => `${v.kind}@${v.where}`,
      )

    assert.deepEqual(kws({ 项目方针: `${w.state.policy}\n- 产物落在 ${ABS}\n` }), ['materialized@项目方针'])
    assert.deepEqual(kws({ 文件内容: [{ path: 'src/index.ts', text: `看这里 ${ABS2}\n` }] }), ['materialized@文件内容'])
    assert.deepEqual(kws({ 上一步结果: `结果在 ${ABS2}\n` }), ['materialized@上一步结果'])
    assert.deepEqual(kws({ 系统状态: { workspace: 'fugue', output: ABS } }), ['materialized@系统状态'])
    assert.deepEqual(kws({ 信号摘要: ['{"kind":"done","digest":"原文"}'] }), ['signal@信号摘要'])

    // 报出来的话里要带得动"是哪一处"——只报 kind 不够定位（这一段里可能排着好几条）。
    const one = checkConstraints(
      SUBAGENT_PROTOCOL,
      { ...w.segments, 项目方针: `${w.state.policy}\n- 产物落在 ${ABS}\n` },
      null,
      '这一步',
      CONTROLLED,
    )
    assert.match(one[0]?.detail ?? '', new RegExp(esc(ABS)), '报出来的话里没带那一条路径')

    // 环境那一档另走一条：**真 facts** 下把宿主名放进系统状态，报的是 env。
    const host = envFacts().hostname
    assert.notEqual(host, '', '宿主名是空的——这一条注入测不成')
    assert.deepEqual(kws({ 系统状态: { workspace: 'fugue', host } }, envFacts()), ['env@系统状态'])

    // 负对照：同一条路注入相对路径 → 一条都不报。
    assert.deepEqual(kws({ 上一步结果: '结果在 src/index.ts\n' }), [], '相对路径被当成绝对路径报了')
  } finally {
    await w.close()
  }
})

/**
 * ③ 环境那一档的开关语义：受控 facts 下 0 条是**按契约**的，而那一档确实活着。
 *
 * 抓住的变异：把"不查"做成"永远不查"（受控 facts + 真注入两条一起看才分得开）；或者把宿主坐标
 * 投影进别的段（真 facts 下若报 env，报的只能是项目方针那一段——那是方针字节自己撞上的节号，
 * 不是投影漏出来的标识）。
 */
test('③ 环境那一档：受控 facts 的 0 条是按契约，而那一档在真 facts 下照报', async () => {
  const w = await realWorkspace('facts')
  try {
    const injected = { ...w.segments, 系统状态: { workspace: 'fugue', host: envFacts().hostname } }
    assert.deepEqual(
      checkConstraints(SUBAGENT_PROTOCOL, injected, null, '这一步', CONTROLLED).map((v) => v.kind),
      [],
      '空宿主名的受控 facts 下不该报环境标识（这一档的契约就是"不查"）',
    )
    assert.deepEqual(
      checkConstraints(SUBAGENT_PROTOCOL, injected, null, '这一步', envFacts()).map((v) => `${v.kind}@${v.where}`),
      ['env@系统状态'],
      '真 facts 下注入的宿主名没报出来——那一档死了',
    )
    assert.deepEqual(checkConstraints(SUBAGENT_PROTOCOL, w.segments, null, '这一步', CONTROLLED), [])
    // 读数（**不断言条数**）：真 facts 下真方针会报几条、报的是什么——它随这台机器的 pid 走。
    const real = checkConstraints(SUBAGENT_PROTOCOL, w.segments, null, '这一步', envFacts())
    for (const v of real.filter((x) => x.kind === 'env')) {
      assert.equal(v.where, '项目方针', `投影出来的段带上了环境标识：${v.where} —— ${v.detail}`)
    }
    console.log(
      `③ 读数：真 facts（宿主名 ${envFacts().hostname} · pid ${process.pid}）下真方针报 ${real.length} 条：${
        real.map((v) => `${v.kind}/${v.detail.trim()}`).join(' · ') || '（0 条）'
      }`,
    )
  } finally {
    await w.close()
  }
})

/**
 * ④ quiet 档（**0 违例的基线取这里**）：两处，都不新增违例。
 *
 *   甲 · 只动 B 区（换一个目标词）：C 区逐字节不变 —— 抓的变异是"把只追加做成任何一区变了就算改写"。
 *   乙 · **真跑一步**（`Runtime.step`，脚本里只有一句"说完了"）：这一步的轮次是空的，C 区只在
 *        **尾巴**上长，不是插进中部 —— 抓的变异是"把这一档当成违规报出来"，或者反过来把它
 *        放行成"检查没跑"（甲那一条顶不住这一档）。
 */
test('④ quiet 档：只动 B 区 · 真跑一步空轮次，两处都 0 违例', async () => {
  const w = await realWorkspace('quiet')
  const log = openLog(w.root, { write: AGENT })
  try {
    // 甲 · 只动 B 区。
    const next = sourcesFor(SUBAGENT_PROTOCOL, { ...w.state, goal: '换一句话，C 区一个字都不动。' }, WHO)
    const after = assemble({ protocol: SUBAGENT_PROTOCOL, model: DEFAULT_MODEL.id, segments: next })
    assert.notDeepEqual(after.zoneB, w.prefix.zoneB, '这一步其实没动 B 区——那一档就是空的')
    assert.deepEqual(after.zoneC, w.prefix.zoneC, '这一步动了 C 区——quiet 那一档的前提不成立')
    assert.deepEqual(
      checkConstraints(SUBAGENT_PROTOCOL, next, w.prefix, '这一步', CONTROLLED, after),
      [],
      '只动 B 区那一步报了违反',
    )

    // 乙 · 真跑一步：没有话说、没有伸手（`end-turn`）。
    const runtime = createRuntime({
      logOf: () => log,
      call: scriptedModel([[{ t: 'stop', reason: 'end-turn', raw: 'end_turn' }]]),
      execute: recordingExecutor(() => {
        throw new Error('quiet 那一步不该伸手')
      }),
    })
    const step = await runtime.step(handleOf(w.state), new AbortController().signal)
    assert.equal(step.outcome.kind, 'done', '这一步没停在"说完了"上')
    assert.equal(step.next.step, w.state.step + 1)
    const ran = assembled(step.next)
    const vs = checkConstraints(SUBAGENT_PROTOCOL, ran.segments, w.prefix, 'quiet 那一步', CONTROLLED, ran.prefix)
    assert.deepEqual(vs, [], `真跑的那一步报了违反：${vs.map(formatViolation).join(' | ')}`)
  } finally {
    await log.close()
    await w.close()
  }
})

/**
 * ⑤ 非静默档（**定性读数，不进 0 期望**）：真跑一步——这一趟模型说了一句话——报**恰好一条**
 * append-only，位置就在新轮次插进来的那个字节上。
 *
 * 这条口径（整段 C 前缀）为什么值得钉住：只看仿真，"只追加"真正承重的只有积累的那一段（运行时
 * 上下文），而 C 区里排在它后面的两段是逐步重写的；整段比的话，一句普通的话也会被报成"中部被
 * 改写"。抓住的变异：把约束 1 放行成恒真（条数变 0）· 把比较面从整段 C 换成别的东西（位置或条数
 * 变）· 把这一条挪出 C 区（`where` 变）。
 */
test('⑤ 非静默档（定性）：真跑一步恰好一条 append-only，位置在新轮次那个字节上', async () => {
  const w = await realWorkspace('step')
  const log = openLog(w.root, { write: AGENT })
  try {
    const events: ModelEvent[] = [
      { t: 'delta', text: '看完了：src/index.ts 里是 export const x = 1。' },
      { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
    ]
    const runtime = createRuntime({
      logOf: () => log,
      call: scriptedModel([events]),
      execute: recordingExecutor(() => ({ ok: true, output: '' })),
    })
    const step = await runtime.step(handleOf(w.state), new AbortController().signal)
    assert.equal(step.outcome.kind, 'done')
    assert.equal(step.next.turns?.length, 1, '这一步没有留下轮次——那一档就不是非静默的')
    assert.deepEqual(step.next.turns?.slice(0, w.state.turns?.length ?? 0), w.state.turns ?? [], '旧轮次不在了')

    const ran = assembled(step.next)
    const vs = checkConstraints(SUBAGENT_PROTOCOL, ran.segments, w.prefix, '这一步', CONTROLLED, ran.prefix)
    assert.equal(vs.length, 1, `除了那一条，别的约束也在报：${vs.map(formatViolation).join(' | ')}`)
    const v = vs[0]
    assert.equal(v?.kind, 'append-only', `报出来的是 ${String(v?.kind)}，不是只追加那一条`)
    assert.equal(v?.where, 'C 区')
    // 位置 = C 区第一段（运行时上下文）在**上一步**里的字节数：新轮次就是从那里插进去的。
    const first = render(SUBAGENT_PROTOCOL.renderers['运行时上下文'], w.segments['运行时上下文'])
    assert.equal(
      sharedPrefixLen(w.prefix.zoneC, ran.prefix.zoneC),
      first.length,
      '第一处不同的位置不在新轮次那一刀上——这一条定性读数变了',
    )
    assert.match(v?.detail ?? '', new RegExp(`前 ${first.length} 个字节相同`), '报出来的话里没有那个位置')
  } finally {
    await log.close()
    await w.close()
  }
})

/**
 * ⑥ 投影不泄漏：动作绑定里的 `env` 值不进系统状态，也不进 A 区的字节。
 *
 * 抓住的变异：把绑定的 `env` 整份投影进 `actions` 那一栏（凭据与环境值就同时进了前缀与夹具）；
 * 或者把段值改成"从宿主路径生成"（A 区里会带上那个临时家目录）。
 */
test('⑥ 投影不泄漏：绑定里的 env 值不进系统状态，也不进 A 区', async () => {
  const w = await realWorkspace('projection')
  try {
    const sys = stableStringify(w.state.system)
    assert.ok(!sys.includes(w.home), `绑定的 env 值进了系统状态投影：${sys}`)
    assert.ok(!sys.includes('PRIVATE_CONTEXT'), '绑定的 env 键名进了系统状态投影')
    const zoneA = new TextDecoder().decode(w.prefix.zoneA)
    assert.ok(!zoneA.includes(w.home), 'A 区的字节里带着那个临时家目录')
    // 正对照：这一栏真的在（动作清单进投影），否则上面两条是空的。
    assert.match(sys, /"name":"build"/, '动作清单根本没进投影——上面那两条负对照是空的')
  } finally {
    await w.close()
  }
})

/** 正则里要用的一段原文：转义特殊字符（注入的路径里可能有 `.` 与 `-`）。 */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 跑一条外部命令（夹具建仓用）。 */
function run(cmd: string, args: readonly string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')} 没跑成：${r.stderr}`)
}
