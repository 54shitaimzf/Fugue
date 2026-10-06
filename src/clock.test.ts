// 信封钟的三条断言（决策材料 1.5 末那三条），各配负对照。出处：架构 § 9.2 的信封表（`ts` · `boot` ·
// `inc`）· ROADMAP § 5 的 serve 协议那一行验收格：**不给钟 = 逐字节同形 · 回拨读得出来且重放不变 ·
// 无钟源不静默造值（缺栏是「未量到」，不是 0）**。
//
// 三条住一份里，是因为它们量的是同一件事：钟只在信封层、只在给钟时出现、只在读得出来的时候报。
// 断言贴着实现住（`clock.ts` 与 `log/envelope.ts` 都在这儿）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'
import { clockOf, rollbackLine, rollbacksOf } from './clock.ts'
import type { Clock } from './clock.ts'
import { canonicalJson, decodeLine, encodeEvent } from './log/envelope.ts'
import type { LogEvent } from './log/events.ts'
import { logDir, openLog } from './log/log.ts'
import type { AgentId } from './terms.ts'

const A = (s: string): AgentId => s as AgentId
const REPO = join(import.meta.dirname, '..')
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')
const EV: LogEvent = {
  t: 'view/write',
  agent: A('agent/r1/1'),
  path: 'src/a.ts',
  rev: 7,
  blob: 'b1',
  mode: 420,
}
/** 一条给死了的钟：三栏都是读数，测试里不取真的。 */
const CLK: Clock = { ts: 1780000000123, boot: 'b-1', inc: 912345678 }
const crcHex = (t: string): string => crc32(Buffer.from(t, 'utf8')).toString(16).padStart(8, '0')

// ────────────────────────────────── ① 不给钟 = 逐字节同形

test('信封钟 ① 不给钟：编出来的行与这三栏之前逐字节相同（地板）', () => {
  // 这一串是**加这三栏之前那一版的输出**，写死在这里——地板是一个字面，不是一个转述。
  const FROZEN =
    '{"seq":17,"writer":"agent/r1/1","crc":"0aafc97b","t":"view/write","agent":"agent/r1/1",' +
    '"path":"src/a.ts","rev":7,"blob":"b1","mode":420}'
  assert.equal(encodeEvent(17, A('agent/r1/1'), EV), FROZEN)
  assert.equal(encodeEvent(17, A('agent/r1/1'), EV, null), FROZEN)

  // **负对照**（免得上面那条是空话）：同一个事件给了钟就与它不同，而且三栏真的都在。
  const stamped = encodeEvent(17, A('agent/r1/1'), EV, CLK)
  assert.notEqual(stamped, FROZEN, '给了钟还是同一串字节——那三栏根本没写出去')
  const o = JSON.parse(stamped) as Record<string, unknown>
  assert.deepEqual([o.ts, o.boot, o.inc], [CLK.ts, CLK.boot, CLK.inc])
})

test('信封钟 ① 走写句柄那一档：clock: false 与缺省（给钟）两者可辨，且都不改事件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-clockless-'))
  try {
    const plain = openLog(root, { sync: 'never', clock: false })
    await plain.append('round', EV)
    await plain.close()
    const line = readFileSync(join(logDir(root), 'round.jsonl'), 'utf8').trim()
    assert.equal(line.includes('"ts":'), false, '--no-clock 那一档还是写了钟栏')
    const back = decodeLine(line)
    if (!back.ok) assert.fail(back.reason)
    assert.deepEqual(back.event, EV)
    assert.equal(back.clock, null)

    const root2 = mkdtempSync(join(tmpdir(), 'fugue-clocked-'))
    try {
      const clocked = openLog(root2, { sync: 'never' })
      await clocked.append('round', EV)
      await clocked.close()
      const line2 = readFileSync(join(logDir(root2), 'round.jsonl'), 'utf8').trim()
      assert.match(line2, /"ts":\d+,"boot":"[^"]+","inc":\d+/, '缺省那一档该带三栏钟')
      const back2 = decodeLine(line2)
      if (!back2.ok) assert.fail(back2.reason)
      assert.deepEqual(back2.event, EV, '钟漏进载荷了')
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ────────────────────────────────── ② 回拨读得出来 · 重放不变

test('信封钟 ② 钟只在信封上：同一个事件带钟与不带钟解码出来的事件逐字段相同', () => {
  const withClock = decodeLine(encodeEvent(17, A('agent/r1/1'), EV, CLK))
  const without = decodeLine(encodeEvent(17, A('agent/r1/1'), EV))
  if (!withClock.ok) assert.fail(withClock.reason)
  if (!without.ok) assert.fail(without.reason)
  assert.deepEqual(withClock.event, without.event)
  assert.deepEqual(withClock.event, EV)
  // 载荷那一份的键一个都不多、一个都不少——重放读的就是它。
  assert.deepEqual(Object.keys(withClock.event).sort(), Object.keys(EV).sort())
  assert.deepEqual(withClock.clock, CLK)
  assert.equal(without.clock, null)
})

test('信封钟 ② crc 覆盖「本行出现的钟栏」：摘掉一栏而不重算 crc → 读不动', () => {
  const o = JSON.parse(encodeEvent(17, A('agent/r1/1'), EV, CLK)) as Record<string, unknown>
  delete o.ts
  const d = decodeLine(JSON.stringify(o))
  assert.equal(d.ok, false, '摘掉一栏还读得动——那 crc 没把钟栏算进去')
  if (!d.ok) assert.match(d.reason, /crc 不符/)
  // 另一半：**旧行（三栏都不在）照旧读得动**——旧日志零迁移照读。
  assert.equal(decodeLine(encodeEvent(17, A('agent/r1/1'), EV)).ok, true)
})

test('信封钟 ② 回拨读得出来：同一 writer 相邻两条 inc 递增而 ts 递减', () => {
  const rows = [
    { pos: { writer: 'round', seq: 1 }, clock: { ts: 2000, boot: 'b', inc: 10 } },
    { pos: { writer: 'round', seq: 2 }, clock: { ts: 1000, boot: 'b', inc: 20 } },
  ]
  const hit = rollbacksOf(rows)
  assert.deepEqual(hit, [
    { writer: 'round', before: { seq: 1, ts: 2000, inc: 10 }, after: { seq: 2, ts: 1000, inc: 20 } },
  ])
  // 文字面把 (seq, ts, inc) 三样都报出来——报的是事实，不是错误。
  const text = rollbackLine(hit[0] as (typeof hit)[number])
  assert.match(text, /seq 1→2/)
  assert.match(text, /ts 2000→1000/)
  assert.match(text, /inc 10→20/)
})

test('信封钟 ② 负对照：inc 也回头 · ts 照涨 · 跨 writer · 没有钟的行——一条都不报', () => {
  const at = (w: string, seq: number, ts: number, inc: number) => ({
    pos: { writer: w, seq },
    clock: { ts, boot: 'b', inc },
  })
  // inc 也回头：那不是"ts 回拨"，是单调那一杆自己也坏了——判据只认「inc 递增而 ts 递减」这一对。
  assert.deepEqual(rollbacksOf([at('round', 1, 2000, 20), at('round', 2, 1000, 10)]), [])
  // ts 照涨：正常的一对。
  assert.deepEqual(rollbacksOf([at('round', 1, 1000, 10), at('round', 2, 2000, 20)]), [])
  // 跨 writer：两个 writer 的 inc 不在同一个坐标里，不比。
  assert.deepEqual(rollbacksOf([at('a', 1, 2000, 10), at('b', 2, 1000, 20)]), [])
  // 没有钟的行跳过（缺栏是「未量到」），夹在中间也不挡前后两条的比较。
  assert.equal(
    rollbacksOf([at('round', 1, 2000, 10), { pos: { writer: 'round', seq: 2 }, clock: null }, at('round', 3, 1000, 20)])
      .length,
    1,
  )
})

test('信封钟 ② 端到端：同一份账重放两次（一次带钟栏、一次抹掉钟栏），视图与 rev 逐字段相同', () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-clock-e2e-'))
  try {
    // 真源是既有的 git 对象库（架构 § 9.1：`M1` 不建仓库），所以这一份要一个真仓库。
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    const init = spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(init.status, 0, String(init.stderr))
    const cli = (args: readonly string[], input?: string): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [CLI, '--root', root, ...args], {
        encoding: 'utf8',
        env,
        ...(input === undefined ? {} : { input }),
      })
    const wrote = cli(['write', 'a.ts', '--stdin'], 'let a = 1\n')
    assert.equal(wrote.status, 0, String(wrote.stderr))

    const at = join(logDir(root), 'round.jsonl')
    const clocked = readFileSync(at, 'utf8')
    // **这一条的前提**：这份账真的带钟。少了它，下面那条"两次重放逐字段相同"可以在没有钟的账上
    // 空转通过——而这一条要量的是"钟在场时重放不变"。
    assert.match(clocked, /"ts":\d+/)

    const first = cli(['--json', 'replay'])
    const verify1 = cli(['replay', '--verify'])
    assert.equal(first.status, 0, String(first.stderr))
    assert.equal(verify1.status, 0, String(verify1.stderr))

    // 抹掉钟栏：**按新的校验形状重算 crc**（否则那一行自己就不合格了）——这是"由脚本抹掉钟栏"那一档。
    const stripped =
      clocked
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => {
          const o = JSON.parse(l) as Record<string, unknown>
          delete o.ts
          delete o.boot
          delete o.inc
          const { crc: _old, ...rest } = o
          return JSON.stringify({ ...rest, crc: crcHex(canonicalJson(rest)) })
        })
        .join('\n') + '\n'
    writeFileSync(at, stripped)
    assert.equal(stripped.includes('"ts":'), false)

    const second = cli(['--json', 'replay'])
    const verify2 = cli(['replay', '--verify'])
    assert.equal(second.status, 0, String(second.stderr))
    assert.equal(verify2.status, 0, String(verify2.stderr))
    // **比的是视图那一份字段**：`ms` 是区间读数（这一趟花了多久），两次当然不同——它不是视图。
    const viewOf = (out: unknown): Record<string, unknown> => {
      const o = JSON.parse(String(out)) as Record<string, unknown>
      delete o.ms
      return o
    }
    const one = viewOf(first.stdout)
    assert.equal(typeof one.rev, 'number', '这一条得真的重建出一份视图')
    assert.equal((one.entries as readonly unknown[]).length, 1)
    assert.deepEqual(viewOf(second.stdout), one, '抹掉钟栏之后重建出来的视图变了')
    console.log(
      `② 读数：rev=${String(one.rev)} 条数=${String((one.entries as readonly unknown[]).length)} · ` +
        `带钟与抹掉钟栏两趟的视图逐字段相同 · 两次 replay --verify 都退 0`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ────────────────────────────────── ③ 无钟源不静默造值

test('信封钟 ③ 读不出启动标识：一栏都不给（不是 0 · 不是空串）', () => {
  assert.equal(clockOf(null), null)
  // **负对照**：读得出来时三栏齐全，而且都是整数（免得上面那条是空话）。
  const c = clockOf('b-1')
  assert.notEqual(c, null)
  if (c === null) return
  assert.equal(c.boot, 'b-1')
  assert.equal(Number.isInteger(c.ts), true)
  assert.equal(Number.isInteger(c.inc), true)
  assert.equal(c.ts > 0, true)
  assert.equal(c.inc >= 0, true)
})

test('信封钟 ③ 只出现一两栏的行照样读得进来，而读不出一个完整的钟', () => {
  const o = JSON.parse(encodeEvent(17, A('agent/r1/1'), EV, CLK)) as Record<string, unknown>
  delete o.inc
  const { crc: _old, ...rest } = o
  const half = JSON.stringify({ ...o, crc: crcHex(canonicalJson(rest)) })
  const d = decodeLine(half)
  // 校验形状管的是"crc 覆盖哪几栏"，不是"这几栏合不合法"——所以这一行**解码成功**。
  assert.equal(d.ok, true)
  if (!d.ok) return
  assert.equal(d.clock, null, '两栏凑不出一个钟')
  assert.deepEqual(d.event, EV)
})

test('信封钟 ③ 锁记录与信封读同一处钟（`boot` 与 `clockOf()` 是同一个来源）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-clock-hold-'))
  try {
    const log = openLog(root, { write: 'round', sync: 'never' })
    await log.append('round', EV)
    // 锁记录在**持锁期间**读（`close()` 会把锁放掉——那正是它的语义）。
    const rec = JSON.parse(readFileSync(join(logDir(root), 'round.lock'), 'utf8')) as {
      boot: string
      t: number
    }
    assert.equal(rec.boot, clockOf()?.boot ?? '')
    assert.equal(Number.isInteger(rec.t), true)
    await log.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
