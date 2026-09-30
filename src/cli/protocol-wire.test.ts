// ①e CLI 真驱动那一档：给子 agent 的句柄拿的是**子 agent 那一份协议**，「我的任务」进得了 B 区。
//
// 为什么单开这一条：这一处原先写死 `HOLDER_PROTOCOL`（持轮者那一份），而持轮者的 B 区里没有
// 「我的任务」那一段（架构 § 8.11 第一张表）——于是 `--live` 那一趟里模型只看到总目标一句，
// 「交付物 · 要交的证据 · 断言」一个字都不进前缀，而**没有任何一处报错**：B 区只是短了 147 字节。
//
// 断言分两层：句柄那一栏是那一份协议（机制），装出来的 B 区里有契约那几行（后果）；再加一条
// 负对照——同一份状态换成持轮者那一份，那几行就不在了（差量是**那一段**，不是别的东西）。
//
// ①f 量的是这一段的另一半（W11 那一轮真档照出来的那三句收工口径）：`--max-steps` 真的写进
// 「我的任务」，而**不给就是不设上界**——那一句不写，状态里也没有那一栏。发给模型的那个数与
// 驱动停下来用的那个数同源：都来自命令面，不由我们兜底。
import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { assemble } from '../assemble/assemble.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { sourcesFor } from '../assemble/sources.ts'
import { readConfig } from '../config.ts'
import type { Contract } from '../contract/types.ts'
import { driverSupport } from './fugue.ts'

/**
 * 一个**假**的凭据：`driverSupport` 在拼目标那一栏时会读它（`targetOf` 是取值的地方）。
 *
 * 为什么必须给：这一份要给的是"句柄里那一栏是哪份协议"，而句柄住在真驱动那一档的口袋里
 * （打桩那一档一个字段都不读）。值从哪里来与本条断言无关，所以给一个占位串——**它不出网**，
 * 这个文件里没有任何一次 `fetch`。真凭据那两条路（环境变量 · 工作区外的文件）由
 * `chain.test.ts` 的守卫那条量与 `fugue run --live` 那一档管。
 */
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? 'test-placeholder-not-a-credential'

/** 一份子 agent 那一格要的契约（干一格的形状，架构 § 8.12）。 */
function contractOf(): Contract {
  return {
    id: 'r1.implement.1',
    kind: 'implement',
    goal: '写一份 README.md',
    ownedPaths: ['README.md'],
    deliverables: [{ path: 'README.md', form: '一份文件' }],
    assertions: [{ name: '文件存在' }],
  } as unknown as Contract
}

async function supportOf() {
  const root = tmpDir('fugue-driver-support-')
  const doc = await readConfig(root)
  return { root, support: driverSupport({ root, doc, credential: '这一档不出网' }) }
}

test('①e 真驱动那一档：子 agent 的句柄拿子 agent 那份协议，B 区里有契约那几行', async () => {
  const { support } = await supportOf()
  const contract = contractOf()
  const handle = support.handle('agent-1' as never, contract)
  assert.equal(
    handle.protocol,
    SUBAGENT_PROTOCOL,
    '句柄拿的不是子 agent 那一份协议——B 区会少「我的任务」那一段，而这只表现为字节变短',
  )
  const prefix = assemble({
    protocol: handle.protocol,
    model: handle.model,
    // 段值从状态走一遍源——与真跑时同一条路（`assemble` 收的是段值，不是状态）。
    segments: sourcesFor(handle.protocol, support.state('agent-1' as never, contract), handle.coord),
  })
  const b = new TextDecoder().decode(prefix.zoneB)
  for (const line of ['Goal: 写一份 README.md', 'Deliverables: README.md', 'Assertions: 文件存在']) {
    assert.ok(b.includes(line), `B 区里没有这一行：${line}\nB 区是：${JSON.stringify(b)}`)
  }
  // **`implement` 那一档末尾没有"产物路径"那一行**（第 5 批 · 之六）：它的落点由契约自己声明
  // （`ownedPaths` / `deliverables`，就是上面"交付物"那一行），而"产物路径"那一栏是**只读型契约**
  // 那一档的（架构 § 8.12 的 `Evidence` 注释 · § 22 的 D15：只读型的产物由构造器按位置定名）。
  // 这一处原先无条件给 `deliver/agent-1/`，而验收跑的是契约声明的路径——**模型照那一行走**，
  // 于是它把对的字节写到了错的地方（实测：`--live` 那一趟写出 `deliver/agent/r1/1/notes.md`，
  // 而验收跑 `test -f notes.md`）。
  assert.equal(
    b.includes('Output paths:'),
    false,
    `implement 那一档的 B 区末尾不该有"产物路径"那一行（落点由契约声明）：${JSON.stringify(b)}`,
  )
  console.log(
    `①e 读数：句柄协议 = 子 agent 那一份 · B 区 ${prefix.zoneB.length} 字节 · A 区 ${prefix.zoneA.length} · C 区 ${prefix.zoneC.length} · 末尾没有"产物路径"那一行`,
  )
})

test('①e 负对照：同一份状态换持轮者那份协议，「我的任务」那一段就不在了', async () => {
  const { support } = await supportOf()
  const contract = contractOf()
  const handle = support.handle('agent-1' as never, contract)
  const state = support.state('agent-1' as never, contract)
  const mine = assemble({ protocol: SUBAGENT_PROTOCOL, model: 'x' as never, segments: sourcesFor(SUBAGENT_PROTOCOL, state, handle.coord) })
  const holder = assemble({ protocol: HOLDER_PROTOCOL, model: 'x' as never, segments: sourcesFor(HOLDER_PROTOCOL, state, handle.coord) })
  assert.ok(new TextDecoder().decode(mine.zoneB).includes('Deliverables:'), '子 agent 那份里应当有「我的任务」')
  assert.equal(
    new TextDecoder().decode(holder.zoneB).includes('Deliverables:'),
    false,
    '持轮者那份里不该有「我的任务」——它那份 B 区多两段、少这一段',
  )
  // A 区与 C 区两份协议逐字节相同：差别只在 B 区（架构 § 8.11 第一张表）。
  assert.deepEqual([...mine.zoneA], [...holder.zoneA], 'A 区两份应当逐字节相同')
  assert.deepEqual([...mine.zoneC], [...holder.zoneC], 'C 区两份应当逐字节相同')
  console.log(
    `①e 负对照读数：子 agent 那份 B 区 ${mine.zoneB.length} 字节 · 持轮者那份 ${holder.zoneB.length} 字节（差 ${mine.zoneB.length - holder.zoneB.length}）`,
  )
})

test('P2b · round.model 选模型：配置点另一条声明，句柄的模型与线协议就是那一条', async () => {
  const root = tmpDir('fugue-driver-support-')
  const doc = await readConfig(root)
  // **配置那一档**：`round.model` 点了 openai 那条声明 → decl 就是它（缺省是 anthropic 那条）。
  const byConfig = driverSupport({
    root,
    doc: { ...doc, round: { model: 'deepseek-flash/openai' } },
    credential: '这一档不出网',
  })
  assert.equal(
    byConfig.decl.id,
    'deepseek-flash/openai',
    `配置点 openai 那条，decl 就该是它，拿到的是 ${byConfig.decl.id}`,
  )
  assert.equal(byConfig.decl.wire, 'openai-chat', `线协议跟着声明走，拿到的是 ${byConfig.decl.wire}`)
  const handle = byConfig.handle('agent-1' as never, contractOf())
  assert.equal(handle.adapter.name, 'openai-chat', `句柄的适配器也换到那一条线，拿到的是 ${handle.adapter.name}`)
  // **旗标盖过配置**（CLI > 工作区）：两边同时给，听旗标的。
  const byFlag = driverSupport({
    root,
    doc: { ...doc, round: { model: 'deepseek-flash/openai' } },
    model: 'deepseek-flash/anthropic',
    credential: '这一档不出网',
  })
  assert.equal(byFlag.decl.wire, 'anthropic-messages', '旗标与配置同时给，听旗标的（CLI > 工作区）')
  // **未知即拒、列出可用的**：话里要有目录里真正的那两个名字。
  assert.throws(
    () => driverSupport({ root, doc, model: 'nope', credential: '这一档不出网' }),
    /deepseek-flash\/anthropic/,
    '未知模型拒的时候要列出目录里有的',
  )
  console.log(
    `P2b 读数：round.model → decl ${byConfig.decl.id}（wire ${byConfig.decl.wire}）· 旗标盖过配置 · 未知即拒并列目录`,
  )
})

test('①f `--max-steps` 真的写进「我的任务」：给 3 就是 3，**不给就是不设上界**（那一句不写）', async () => {
  const root = tmpDir('fugue-driver-support-')
  const doc = await readConfig(root)
  const contract = contractOf()
  const given = driverSupport({ root, doc, credential: '这一档不出网', maxSteps: 3 })
  const handle = given.handle('agent-1' as never, contract)
  const st3 = given.state('agent-1' as never, contract)
  assert.equal(st3.maxSteps, 3, '给了 `--max-steps 3`，状态里就该是 3')
  const b3 = new TextDecoder().decode(
    assemble({ protocol: SUBAGENT_PROTOCOL, model: handle.model, segments: sourcesFor(SUBAGENT_PROTOCOL, st3, handle.coord) }).zoneB,
  )
  assert.ok(b3.includes('At most 3 steps for this task.'), `「我的任务」里该写 3：${JSON.stringify(b3)}`)
  // 不给：**没有那一栏**，于是「我的任务」里也没有那一句。`step.test.ts` ⑨ 已经量过"没给预算
  // 就不写那一句"，这里量的是**上游那一栏真的缺席**——两处一起才封住"缺省偷偷补一个数"这条路
  // （原先这里补的正是 `DEFAULT_MAX_STEPS`）。
  const none = driverSupport({ root, doc, credential: '这一档不出网' })
  const stNone = none.state('agent-1' as never, contract)
  assert.equal(stNone.maxSteps, undefined, '不给 `--max-steps` 时状态里不该有那一栏')
  const bNone = new TextDecoder().decode(
    assemble({ protocol: SUBAGENT_PROTOCOL, model: handle.model, segments: sourcesFor(SUBAGENT_PROTOCOL, stNone, handle.coord) }).zoneB,
  )
  assert.equal(bNone.includes('At most '), false, `不给上界时「我的任务」里不该有那一句：${JSON.stringify(bNone)}`)
  console.log(
    `①f 读数：--max-steps 3 → 状态里 ${String(st3.maxSteps)} · 不给 → ${String(stNone.maxSteps)}（状态里那一栏缺席，前缀里那一句也不写）`,
  )
})

/**
 * 一份**调查型**契约（干一格的形状，架构 § 8.12）：它**既没有 `deliverables` 也没有 `assertions`**
 * ——那两栏是 `implement` / `resolve` 才有的（`InvestigateContract` 只有 question ·
 * evidenceRequired · seed）。它的产物由构造器按位置定名。
 */
function investigateOf(): Contract {
  return {
    id: 'r1.investigate.1',
    kind: 'investigate',
    agent: 'agent-1',
    branch: 'refs/heads/agent/agent-1',
    question: 'greet 现在怎么拼字符串？',
    evidenceRequired: [{ artifact: 'evidence/agent-1/现状', note: '现状' }],
    seed: ['src/greet.js'],
  } as unknown as Contract
}

test('①g 真驱动那一档：**调查型**契约的「我的任务」装得出来（它没有 deliverables / assertions）', async () => {
  const { support } = await supportOf()
  const contract = investigateOf()
  // 这一行原先当场炸：`stateFor` 对三种变体只写了两个分支，调查型走到了
  // `c.deliverables.map` 上（`Cannot read properties of undefined (reading 'map')`）。
  // 真档链第一趟照出来的：2 份契约（1 份调查型 + 1 份实现型）**一个格都没跑**。
  const handle = support.handle('agent-1' as never, contract)
  const state = support.state('agent-1' as never, contract)
  const b = new TextDecoder().decode(
    assemble({ protocol: handle.protocol, model: handle.model, segments: sourcesFor(handle.protocol, state, handle.coord) }).zoneB,
  )
  assert.ok(b.includes('Goal: greet 现在怎么拼字符串？'), `B 区里没有调查型那句问题：${JSON.stringify(b)}`)
  assert.ok(b.includes('Evidence required: 现状'), `B 区里没有"要交的证据"那一行：${JSON.stringify(b)}`)
  // **产物路径 = 契约写入面那几条**（`evidence/<agent 的每一段>/<备注>`，构造器按位置定名）。
  // 原先给的是 `deliver/agent-1/`——旧约定，而这一行是 B 区的最后一行（近因那一处）：模型照它走
  // 就会写到一个既不在契约写入面、验收也不看的地方。
  assert.deepEqual([...handle.coord.outputPaths], ['evidence/agent-1/现状'], '调查型的产物路径该是契约写入面那几条')
  assert.ok(b.includes('Output paths: evidence/agent-1/现状'), `B 区末尾没有那一行产物路径：${JSON.stringify(b)}`)
  // 调查型没有断言那一栏：那两行都不该出现（空着不是漏了）。
  assert.equal(b.includes('Deliverables:'), false, `调查型不该有"交付物"那一行：${JSON.stringify(b)}`)
  assert.equal(b.includes('断言：'), false, `调查型不该有"断言"那一行：${JSON.stringify(b)}`)
  console.log(
    `①g 读数：调查型 B 区 ${b.length} 字节 · 产物路径 ${handle.coord.outputPaths.join(' · ')} · 没有"交付物"与"断言"那两行`,
  )
})
