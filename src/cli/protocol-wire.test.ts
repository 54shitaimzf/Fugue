// ①e CLI 真驱动那一档：给子 agent 的句柄拿的是**子 agent 那一份协议**，「我的任务」进得了 B 区。
//
// 为什么单开这一条：这一处原先写死 `HOLDER_PROTOCOL`（持轮者那一份），而持轮者的 B 区里没有
// 「我的任务」那一段（架构 § 8.11 第一张表）——于是 `--live` 那一趟里模型只看到总目标一句，
// 「交付物 · 要交的证据 · 断言」一个字都不进前缀，而**没有任何一处报错**：B 区只是短了 147 字节。
//
// 断言分两层：句柄那一栏是那一份协议（机制），装出来的 B 区里有契约那几行（后果）；再加一条
// 负对照——同一份状态换成持轮者那一份，那几行就不在了（差量是**那一段**，不是别的东西）。
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
  for (const line of ['总目标：写一份 README.md', '交付物：README.md', '断言：文件存在']) {
    assert.ok(b.includes(line), `B 区里没有这一行：${line}\nB 区是：${JSON.stringify(b)}`)
  }
  // **`implement` 那一档末尾没有"产物路径"那一行**（第 5 批 · 之六）：它的落点由契约自己声明
  // （`ownedPaths` / `deliverables`，就是上面"交付物"那一行），而"产物路径"那一栏是**只读型契约**
  // 那一档的（架构 § 8.12 的 `Evidence` 注释 · § 22 的 D15：只读型的产物由构造器按位置定名）。
  // 这一处原先无条件给 `deliver/agent-1/`，而验收跑的是契约声明的路径——**模型照那一行走**，
  // 于是它把对的字节写到了错的地方（实测：`--live` 那一趟写出 `deliver/agent/r1/1/notes.md`，
  // 而验收跑 `test -f notes.md`）。
  assert.equal(
    b.includes('产物路径：'),
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
  assert.ok(new TextDecoder().decode(mine.zoneB).includes('交付物：'), '子 agent 那份里应当有「我的任务」')
  assert.equal(
    new TextDecoder().decode(holder.zoneB).includes('交付物：'),
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
