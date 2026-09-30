// 计时 artifact 的形状是 0.2.2 的冻结面之一（路线图 §9 的 0.2.2 行）。冻结面要一条会红的断言：
// 键集多一个少一个、红了就不落读数、退出码不跟着那一档走——这里当场红。
//
// 真跑那一趟在**夹具仓**里跑：把验收入口与计时器各拷一份进去，真调用 · 真落盘 · 真退出码，
// 一秒内跑完，又不会在快档测试里递归跑整套快档（那是 `node tools/test-entry.js fast` 自己的活）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { SCHEMA, timeLane, timingRecord, writeRecord } from '../tools/ci-timing.js'
import { tmpDir } from './helpers/tmp.ts'

const REPO = join(import.meta.dirname, '..')
const KEYS = ['exitCode', 'files', 'finishedAt', 'lane', 'run', 'runner', 'schema', 'startedAt', 'wallMs']

/** 一个真能跑的夹具仓：入口 + 计时器两份拷贝，一个快档文件、一个真档文件。 */
function fixture(fastBody: string): string {
  const dir = tmpDir('fugue-ci-timing-')
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  cpSync(join(REPO, 'tools', 'test-entry.js'), join(dir, 'tools', 'test-entry.js'))
  cpSync(join(REPO, 'tools', 'ci-timing.js'), join(dir, 'tools', 'ci-timing.js'))
  writeFileSync(join(dir, 'src', 'a.test.ts'), fastBody)
  writeFileSync(join(dir, 'src', 'b.test.ts'), '// tier: real —— 夹具不碰真依赖，只为分档读数在场\n')
  return dir
}

// 夹具的测试体**先落一个记号文件再断言**：记号在，才证明那一档真的跑了。这不是多余的——
// 第一版这里就中过一次招：`node --test` 认 `NODE_TEST_CONTEXT`，被测试递归调起时**静默跳过所有
// 文件并退 0**，夹具于是"绿"得毫无内容（计时器那边已经把那一段记进注释）。
const MARK = (cond: string) =>
  'import { appendFileSync } from "node:fs"\n' +
  'import { test } from "node:test"\n' +
  'import assert from "node:assert/strict"\n' +
  `test("夹具", () => { appendFileSync(new URL("./ran.txt", import.meta.url), "ran\\n"); assert.equal(1, ${cond}) })\n`
const PASS = MARK('1')
const FAIL = MARK('2')

test('形状：键集一个不多一个不少（冻结面）', () => {
  const rec = timingRecord({
    lane: 'fast',
    wallMs: 1,
    exitCode: 0,
    startedAt: 'a',
    finishedAt: 'b',
    files: { fast: 1, real: 2, all: 3 },
    runner: {},
    run: {},
  })
  assert.equal(rec.schema, SCHEMA, '形状版本不对')
  assert.deepEqual(Object.keys(rec).sort(), KEYS, '键集变了就是改形状——改了要跳 SCHEMA 并改这一行')
})

test('量法：跑器与钟可换——墙钟与退出码原样进读数', () => {
  let t = 0
  const { record, status } = timeLane('fast', { root: REPO, run: () => ({ status: 3 }), now: () => (t += 250) })
  assert.equal(status, 3)
  assert.equal(record.exitCode, 3)
  assert.equal(record.wallMs, 250)
  assert.equal(record.lane, 'fast')
  assert.equal(record.files.all, record.files.fast + record.files.real, '发现数必须等于两档之和（分档器给的）')
  assert.ok(record.files.fast > 0 && record.files.real > 0)
  assert.equal(record.runner.os, process.platform)
  assert.equal(record.runner.node, process.version)
})

test('真跑一趟（夹具仓）：落盘 · 形状 · 退出码跟着那一档走', () => {
  const dir = fixture(PASS)
  const out = join(dir, 'ci-timing-fast.json')
  const r = spawnSync(process.execPath, [join(dir, 'tools', 'ci-timing.js'), 'fast', '--out', out], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `夹具那一档应当绿：${r.stderr}`)
  assert.equal(readFileSync(join(dir, 'src', 'ran.txt'), 'utf8'), 'ran\n', '那一档没真跑——记号文件不在')
  const rec = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(Object.keys(rec).sort(), KEYS)
  assert.equal(rec.lane, 'fast')
  assert.equal(rec.exitCode, 0)
  assert.ok(Number.isInteger(rec.wallMs) && rec.wallMs >= 0, `墙钟要是整数毫秒，实得 ${rec.wallMs}`)
  assert.deepEqual(rec.files, { fast: 1, real: 1, all: 2 })
  assert.match(r.stdout, /档 fast 墙钟 \d+ms 退出码 0 → /)
  console.log(`计时读数（夹具）：档 ${rec.lane} 墙钟 ${rec.wallMs}ms 文件 ${JSON.stringify(rec.files)}`)
})

test('负对照：那一档红了，读数照落（artifact 要的是"红了也看得见墙钟"）', () => {
  const dir = fixture(FAIL)
  const out = join(dir, 'ci-timing-fast.json')
  const r = spawnSync(process.execPath, [join(dir, 'tools', 'ci-timing.js'), 'fast', '--out', out], {
    encoding: 'utf8',
  })
  assert.notEqual(
    r.status,
    0,
    `夹具那一档是红的，计时器不该把它洗成 0（status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}）`,
  )
  assert.equal(readFileSync(join(dir, 'src', 'ran.txt'), 'utf8'), 'ran\n', '那一档没真跑——记号文件不在')
  const rec = JSON.parse(readFileSync(out, 'utf8'))
  assert.notEqual(rec.exitCode, 0, '读数里的退出码要如实是红的那个')
  assert.deepEqual(Object.keys(rec).sort(), KEYS)
})

test('负对照：档名拼错 → 退出码 2（不静默当 all 跑）', () => {
  const dir = fixture(PASS)
  const r = spawnSync(process.execPath, [join(dir, 'tools', 'ci-timing.js'), 'quick'], { encoding: 'utf8' })
  assert.equal(r.status, 2, `拼错档名应当退 2，实得 ${r.status}`)
  assert.match(r.stderr, /用法/)
})

test('落盘是幂等的：同一份读数写两次一个字节不差', () => {
  const dir = tmpDir('fugue-ci-timing-')
  const path = join(dir, 'x.json')
  const rec = timingRecord({ lane: 'real', wallMs: 5, exitCode: 1, startedAt: 'a', finishedAt: 'b', files: {}, runner: {}, run: {} })
  writeRecord(path, rec)
  const once = readFileSync(path, 'utf8')
  writeRecord(path, rec)
  assert.equal(readFileSync(path, 'utf8'), once)
  assert.ok(once.endsWith('\n'), '落盘要带行尾换行')
})
