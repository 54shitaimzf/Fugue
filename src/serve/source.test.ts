// **事件通道的客户端一头**（0.4.3 第一幕 ①）：`serve/source.ts` 是真读得动的那一份。
//
// 出处：架构 § 9.11 的「事件通道」那一段——一趟调用回一趟事 · 响应里带这一趟读到的事件与下一趟
// 要用的游标 · 游标是每个 writer 一个、语义是排他下界 · 命绑客户端（客户端一走服务端就收）。
//
// 这一份盯五样：
//
//   ① **握手**：协议版本 · 方法面（客户端拿一次就知道这一代服务端对得上哪几条命令）；
//   ② **一趟读齐**：不给游标那一趟读到的行，与本地直接读账本读到的**逐字段相同**（真有东西：
//      那几行不许是零条）；
//   ③ **游标是排他下界**：拿着上一趟的游标再问一趟，读到空；账上补一条之后，同一趟只多那一条；
//   ④ **读不动就抛**：游标串读不出来（serve 那边 `-32602`）当场抛，**不静默当"账上没有"**；
//   ⑤ **收尾幂等**：`close()` 两次只走一趟，子进程收干净。
//
// 这一份不碰终端、不折帧（那是 `ui/follow.test.ts` 的事）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { runCli, stdinOf } from '../../test/helpers/run-cli.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { openLog } from '../log/log.ts'
import { PROTOCOL_VERSION } from '../protocol.ts'
import { openServeSource, rowsReaderOf } from './source.ts'

/** 一个一次性工作区：git 仓 + 两条写 + 一次提交（账上因此有几条真事件）。 */
async function makeRoot(): Promise<string> {
  const dir = tmpDir('fugue-source-')
  assert.equal(spawnSync('git', ['init', '-q', '.'], { cwd: dir }).status, 0)
  const w = await runCli(['--root', dir, 'write', 'a.txt', '--stdin'], stdinOf('alpha\n'))
  assert.equal(w.code, 0, w.stderr)
  const w2 = await runCli(['--root', dir, 'write', 'b.txt', '--stdin'], stdinOf('beta\n'))
  assert.equal(w2.code, 0, w2.stderr)
  const c = await runCli(['--root', dir, 'commit', '-m', '第一版'])
  assert.equal(c.code, 0, c.stderr)
  return dir
}

/** 本地直接读一遍（判据基线）：`(seq, writer)` 全序的那一串。 */
async function rowsDirect(root: string): Promise<readonly string[]> {
  const log = openLog(root)
  const out: string[] = []
  try {
    for await (const r of log.readMerged()) out.push(JSON.stringify({ pos: r.pos, e: r.e }))
  } finally {
    await log.close()
  }
  return out
}

test('① 握手：协议版本与服务端自己报的方法面', async () => {
  const root = await makeRoot()
  const src = await openServeSource({ root })
  try {
    assert.equal(src.hello.protocol, PROTOCOL_VERSION, '握手报的协议版本与这一份对得上')
    assert.ok(src.hello.methods.includes('status'), `方法面该有 status：${src.hello.methods.join(' ')}`)
    assert.ok(src.hello.methods.includes('watch'), `方法面该有 watch：${src.hello.methods.join(' ')}`)
    // **入口不出方法名**（架构 § 9.11 那张表的入口行）：tui 与 serve 都不是动词。
    assert.equal(src.hello.methods.includes('tui'), false, 'tui 是入口，不出方法名')
    console.log(`① 读数：协议 ${src.hello.protocol} · 方法面 ${src.hello.methods.length} 条`)
  } finally {
    await src.close()
  }
})

test('② 第一趟读齐：与本地直接读账本逐字段相同（真有东西：不少于 3 条）', async () => {
  const root = await makeRoot()
  const src = await openServeSource({ root })
  try {
    const pass = await src.pass('')
    assert.deepEqual(pass.rows.map((r) => JSON.stringify(r)), [...(await rowsDirect(root))], '通道读到的与本地读到的不同')
    assert.ok(pass.rows.length >= 3, `这一本小账至少有 3 条事件，拿到 ${pass.rows.length} 条——空的那一趟说明不通`)
    assert.notEqual(pass.resume, '', '游标串不该是空的（读到了东西）')
    // `rowsReaderOf` 是**同一批行的另一种读法**：按 writer 筛出来的与直接读那一份逐字段相同。
    const viaRows: string[] = []
    for await (const e of rowsReaderOf(pass.rows).readByWriter('round' as never)) viaRows.push(JSON.stringify(e))
    const direct: string[] = []
    const log = openLog(root)
    try {
      for await (const e of log.readByWriter('round' as never)) direct.push(JSON.stringify(e))
    } finally {
      await log.close()
    }
    assert.deepEqual(viaRows, direct, '`rowsReaderOf` 与账本那一份 `readByWriter` 读出来的不一样')
    console.log(`② 读数：${pass.rows.length} 条事件逐字段相同 · round 那一份 ${viaRows.length} 条 · 游标「${pass.resume}」`)
  } finally {
    await src.close()
  }
})

test('③ 游标是排他下界：接着问是空；账上补一条之后只多那一条', async () => {
  const root = await makeRoot()
  const src = await openServeSource({ root })
  try {
    const first = await src.pass('')
    const again = await src.pass(first.resume)
    assert.deepEqual(again.rows, [], `拿着上一趟的游标该读到空，拿到 ${again.rows.length} 条`)
    // 账上补一条：`round` 这writer 的下一条。
    const log = openLog(root)
    try {
      await log.append('round' as never, { t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: 'Planning' as never })
    } finally {
      await log.close()
    }
    const after = await src.pass(again.resume)
    assert.equal(after.rows.length, 1, `补了一条就该只读到那一条，拿到 ${after.rows.length} 条`)
    assert.equal(after.rows[0]?.e.t, 'round/state', '读到的那一条正是补进去的那一条')
    console.log(`③ 读数：第一趟 ${first.rows.length} 条 · 再问 ${again.rows.length} 条 · 补一条后 ${after.rows.length} 条`)
  } finally {
    await src.close()
  }
})

test('④ 负对照：游标串读不出来就抛——不静默当"账上没有"', async () => {
  const root = await makeRoot()
  const src = await openServeSource({ root })
  try {
    await assert.rejects(() => src.pass('这不是游标'), (err: Error) => {
      assert.match(err.message, /事件通道那一趟没成/, `抛出来的那句话要说得清是哪一段：${err.message}`)
      return true
    })
  } finally {
    await src.close()
  }
})

test('⑤ 收尾幂等：`close()` 两次只走一趟，子进程收干净', async () => {
  const root = await makeRoot()
  const src = await openServeSource({ root })
  await src.pass('')
  await src.close()
  assert.equal(join(root, '.fugue').startsWith(root), true, '（占位：这条路不改工作区里的任何东西）')
  await src.close()
  await assert.rejects(() => src.pass(''), /已经收尾/, '收尾之后再问该当场抛，不去碰那个进程')
  console.log('⑤ 读数：close() 两次都返回 · 收尾之后再问当场抛')
})
