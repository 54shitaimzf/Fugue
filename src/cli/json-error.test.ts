// U6 · § 9.8 契约表「错误」行：`--json` 下的错误是 **stderr 的一行 JSON**
// `{ code, message, hint, subject }`——stdout 一个字节不写，退出码四档（0/1/2/3）不动。
//
// 盯三条：
//   ① 用法错（退 2）在 `--json` 下也是一行可 `JSON.parse` 的字，`code` 就是退出码，
//      `hint` 指向替代能力（§ 24 纪律 5——用法错的 hint 给「跑 fugue --help」）；
//   ② **人读那一面逐字照旧**：不给 `--json` 时用法错仍是「一句错 + 整张 USAGE」（退 2）；
//   ③ stdout 纪律：错误一个字节都不落 stdout——机器可读输出与错误分道（§ 9.8 那张表）。
//
// **进程内调 `main()`**（`fugue.ts` 导出的那一个），不开子进程：断的是**发射面**——
// 返回的码与写下的字节；「返回码 → 进程退出码」那一层映射是既有代码，`fugue.test.ts`
// 的真进程用例已经在管。捕获靠把两股 `write` 短暂换成收集器，调完还原。
//
// 负对照的牙在形状本身：把 `emitFail` 的 json 分支去掉（恒走人面），下面的
// `JSON.parse` 当场炸——这份测试存在的意义就是那一炸。
import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { main } from './fugue.ts'

interface Face {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一条命令，收下它写出的两股与返回的码。
 *
 * **换的是 `process.stdout` / `process.stderr` 这两个对象，不是它们的 `write`**：
 * `node --test` 的子进程在引导期就拿住了真流的引用（事件走它们），给 `write` 打补丁会
 * 连 runner 的报告一起吞——实测 `--test` 下只剩末两条被计入。CLI 的 `emitFail` 是调用期
 * 才查 `process.stderr`，所以只有它看得见替身；调完还原。
 */
async function run(root: string, ...args: string[]): Promise<Face> {
  const realOut = process.stdout
  const realErr = process.stderr
  const out: string[] = []
  const err: string[] = []
  const sink = (sink_: string[]): { write: (c: unknown) => boolean } => ({
    write: (c) => {
      sink_.push(String(c))
      return true
    },
  })
  Object.defineProperty(process, 'stdout', { value: sink(out), configurable: true })
  Object.defineProperty(process, 'stderr', { value: sink(err), configurable: true })
  try {
    const code = await main(['--root', root, ...args])
    return { code, stdout: out.join(''), stderr: err.join('') }
  } finally {
    Object.defineProperty(process, 'stdout', { value: realOut, configurable: true })
    Object.defineProperty(process, 'stderr', { value: realErr, configurable: true })
  }
}

/** `--json` 下的一条错误读数：一行 · 可解析 · code 即退出码 · hint 在场。 */
async function jsonErrorOf(root: string, ...args: string[]): Promise<{ parsed: { code: number; message: string; hint?: string }; run: Face }> {
  const r = await run(root, '--json', ...args)
  const lines = r.stderr.split('\n')
  assert.equal(lines.length, 2, `stderr 该恰好一行（末尾换行）：拿到 ${lines.length} 行\n${r.stderr}`)
  assert.equal(lines[1], '', 'stderr 该以换行收尾，没有第二行')
  const parsed = JSON.parse(lines[0]) as { code: number; message: string; hint?: string }
  return { parsed, run: r }
}

test('① log：--json 下的用法错是一行 JSON（code=2 · hint 指路 · stdout 空）', async () => {
  const root = tmpDir('fugue-json-err-')
  const { parsed, run: r } = await jsonErrorOf(root, 'log', '--nope')
  assert.equal(r.code, 2, `退出码该是 2（用法错），拿到 ${r.code}`)
  assert.equal(parsed.code, 2, 'JSON 里的 code 就是退出码')
  assert.ok(parsed.message.includes('--nope'), `message 要说到那个认不得的开关：${parsed.message}`)
  assert.equal(typeof parsed.hint, 'string', 'hint 在场（§ 24 纪律 5：指向替代能力）')
  assert.ok(parsed.hint!.includes('--help'), `用法错的 hint 给「跑 fugue --help」：${parsed.hint}`)
  assert.equal(r.stdout, '', 'stdout 纪律：错误一个字节不落 stdout')
})

test('② status 与 watch：同一张脸（开关表拒 · interval 不是数，都是一行 JSON 退 2）', async () => {
  const root = tmpDir('fugue-json-err-')
  const s = await jsonErrorOf(root, 'status', '--nope')
  assert.equal(s.run.code, 2)
  assert.equal(s.parsed.code, 2)
  assert.ok(s.parsed.message.includes('status'), `message 要说到是哪条命令：${s.parsed.message}`)
  assert.ok(s.parsed.hint!.includes('--help'))

  const w = await jsonErrorOf(root, 'watch', '--interval', 'abc')
  assert.equal(w.run.code, 2)
  assert.equal(w.parsed.code, 2)
  assert.ok(w.parsed.message.includes('--interval'), `message 要说到那个开关：${w.parsed.message}`)
  assert.ok(w.parsed.hint!.includes('--help'))
  assert.equal(w.run.stdout, '')
})

test('③ tui：--json 不在它的开关表里，但错误那一面照样认它（一行 JSON 退 2）', async () => {
  const root = tmpDir('fugue-json-err-')
  const { parsed, run: r } = await jsonErrorOf(root, 'tui')
  assert.equal(r.code, 2, 'tui 不认 --json 这个开关：用法错退 2')
  assert.equal(parsed.code, 2)
  assert.ok(parsed.message.includes('--json') || parsed.message.includes('tui'), `message 说到认不得的开关：${parsed.message}`)
  assert.equal(r.stdout, '')
})

test('④ 人读那一面逐字照旧：不给 --json，用法错仍是一句错 + 整张 USAGE', async () => {
  const root = tmpDir('fugue-json-err-')
  const r = await run(root, 'log', '--nope')
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('--nope'), '第一行说到那个认不得的开关')
  assert.ok(r.stderr.includes('\n\n用法: fugue'), '整张 USAGE 跟在后面（与原先 usageFail 的字节相同）')
  assert.equal(r.stdout, '', 'stdout 纪律对人面同样成立')
  // 人面的 stderr 里不能混进一行 JSON——两种脸不许出现在同一面。
  assert.ok(!r.stderr.includes('{"code"'), '人读那一面不该出现 JSON 行')
})

test('⑤ 全量 retrofit：四组各抽一条——view(commit 缺 -m) · materialize(fork 缺 base) · config(键不在) · round(run 缺目标)', async () => {
  const root = tmpDir('fugue-json-err-')

  const v = await jsonErrorOf(root, 'commit')
  assert.equal(v.run.code, 2)
  assert.equal(v.parsed.code, 2)
  assert.ok(v.parsed.message.includes('-m'), `view 组那条说到缺的东西：${v.parsed.message}`)
  assert.ok(v.parsed.hint!.includes('--help'))

  const m = await jsonErrorOf(root, 'fork')
  assert.equal(m.run.code, 2)
  assert.equal(m.parsed.code, 2)
  assert.ok(m.parsed.message.includes('fork'), `materialize 组那条说到缺的东西：${m.parsed.message}`)

  const c = await jsonErrorOf(root, 'config', 'get', 'nope.key')
  assert.equal(c.run.code, 1, '键不在是「做不成」（1），不是「敲错了」（2）')
  assert.equal(c.parsed.code, 1)
  assert.ok(c.parsed.message.includes('nope.key'), `config 组那条说到那条键：${c.parsed.message}`)
  assert.equal(c.parsed.hint, undefined, '做不成的那一档没有 USAGE 可指——hint 不出现，不是空串')

  const r = await jsonErrorOf(root, 'round', 'run')
  assert.equal(r.run.code, 2)
  assert.equal(r.parsed.code, 2)
  assert.ok(r.parsed.message.includes('round run'), `round 组那条说到哪条命令：${r.parsed.message}`)
})

test('⑥ 深处抛的 UsageError 也走同一张脸：write 缺 <path> 从 viewCmd 抛到 main 的捕获层', async () => {
  const root = tmpDir('fugue-json-err-')
  const { parsed, run: r } = await jsonErrorOf(root, 'write')
  assert.equal(r.code, 2, '深处抛的用法错在 main 捕获层翻成 2')
  assert.equal(parsed.code, 2)
  assert.ok(parsed.message.includes('write'), `message 说到那条命令：${parsed.message}`)
  assert.ok(parsed.hint!.includes('--help'))
  assert.equal(r.stdout, '')
})
