// 第一幕 ②-1：`--header` 那一行列头（施工单 § 五 ②「列头 · 缺省关——TSV 消费者不受扰」）。
//
// 两件事分开量：
//   · **加了一行**——给了 `--header`，头一行恰好是 `EMIT_HEADER`，后面每一行仍是那几列；而且
//     列名与行**同源**（`EMIT_COLUMNS`）：列头跟它下面那些行对不上，比不印更坏。
//   · **只加一行**——不给它时输出与从前逐字节相同（把列头那一行摘掉之后，带与不带相等）。
//     这一条钉的正是"缺省关"四个字：TSV 消费者（`awk` · `cut`）不会多出一行来。
//
// 三条命令各走一遍：`log`（一次读完）· `watch`（不给 --follow）· `watch --follow`（实时那一
// 档的行随读随印，列头只能由壳先印掉——这一档最容易漏）。
//
// 负对照（红得起来才是断言；五处各注入过一次，下面是实测结果）：
//   ① 把值层那两处的 `head ? [EMIT_HEADER, …]` 去掉 → ①② 当场红；
//   ② 把列头那一行**手写**成另一个顺序（列名与行各写各的）→ ①③ 当场红（`assertTied` 抓的）；
//   ③ 把 `EMIT_COLUMNS` 换序（列名与行**同源**，一起换）→ 这一份照旧绿，而黄金帧
//      `log-人面` 当场红——两处合起来才是"一处真相"的完整对手：同源的那一半归黄金帧管；
//   ④ 去掉 `headerWanted` 里那道 `--json` 的门 → ④ 当场红（列头混进 NDJSON 那条流）；
//   ⑤ 跟随时壳不印列头 → ③ 当场红。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { EMIT_COLUMNS, EMIT_HEADER } from '../value/observe.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))

function run(root: string, input: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 24 })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

/** 一份有小账的工作区：两条 `write` 就是两条事件。 */
function fixture(): string {
  const root = tmpDir('fugue-header-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  assert.equal(run(root, '甲\n', 'write', 'a.txt', '--stdin').code, 0, '造现场：write a.txt')
  assert.equal(run(root, '乙\n', 'write', 'b.txt', '--stdin').code, 0, '造现场：write b.txt')
  return root
}

/**
 * 起一条 `watch --follow`，**等它真印出 `want` 行之后**再按 Ctrl-C，收回 stdout。
 * 等输出到齐的理由与 `value/watch-face.test.ts` 那一处同：`SIGINT` 的处理器是进程起来之后才挂的，
 * 固定睡一会儿会赶在它挂上之前杀到（全量那一趟机器忙）。
 */
function follow(
  root: string,
  want: number,
  ...args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, '--root', root, 'watch', '--follow', '--interval', '50', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let sent = false
    const send = (): void => {
      if (sent) return
      sent = true
      p.kill('SIGINT')
    }
    const fallback = setTimeout(send, 2500)
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      out += d
      if (out.split('\n').filter((l) => l !== '').length >= want) setTimeout(send, 50)
    })
    p.stderr.on('data', (d: string) => { err += d })
    p.on('close', (code) => {
      clearTimeout(fallback)
      resolve({ code, stdout: out, stderr: err })
    })
  })
}

const rowsOf = (out: string): string[] => out.split('\n').filter((l) => l !== '')

/** 列头那一行必须与它下面那些行**同列数**，且列名逐格是 `EMIT_COLUMNS`。 */
function assertShape(lines: readonly string[], where: string): void {
  assert.ok(lines.length >= 2, `${where}：至少列头 + 一条数据，拿到 ${lines.length} 行`)
  assert.equal(lines[0], EMIT_HEADER, `${where}：头一行是列头`)
  assert.deepEqual(lines[0]!.split('\t'), [...EMIT_COLUMNS], `${where}：列名与 EMIT_COLUMNS 逐格相同`)
  for (const [i, line] of lines.slice(1).entries()) {
    assert.equal(line.split('\t').length, EMIT_COLUMNS.length, `${where}：第 ${i + 1} 行是 ${EMIT_COLUMNS.length} 列——${line}`)
  }
}

test('① `log --header`：头一行是列头，后面每一行都是它那几列（列名与行同源）', () => {
  const root = fixture()
  const withHead = run(root, '', 'log', '--header')
  assert.equal(withHead.code, 0, withHead.stderr)
  const lines = rowsOf(withHead.stdout)
  assertShape(lines, 'log')
  console.log(`① 读数：列头 ${EMIT_COLUMNS.join(' | ')}；${lines.length - 1} 行数据，每行 ${EMIT_COLUMNS.length} 列`)
})

test('② 缺省关：`log` 与 `watch` 不给 `--header` 时，输出与从前逐字节相同', () => {
  const root = fixture()
  for (const cmd of ['log', 'watch'] as const) {
    const plain = run(root, '', cmd)
    const withHead = run(root, '', cmd, '--header')
    assert.equal(plain.code, 0, plain.stderr)
    assert.equal(withHead.code, 0, withHead.stderr)
    assert.ok(!plain.stdout.includes(EMIT_HEADER), `${cmd}：不给 --header 时列头一个字都不出现`)
    assert.equal(withHead.stdout, `${EMIT_HEADER}\n${plain.stdout}`, `${cmd}：给与不给只差列头那一行，其余逐字节相同`)
  }
})

test('③ 跟随那一档也认：列头落在第一行，后面每一条事件跟着出现', async () => {
  const root = fixture()
  const got = await follow(root, 3, '--header')
  assert.equal(got.code, 0, `Ctrl-C 退出码 0：${got.code}\n${got.stderr}`)
  const lines = rowsOf(got.stdout)
  assertShape(lines, 'watch --follow')
  assert.equal(lines.length, 3, `列头 + 2 条事件 = 3 行：拿到 ${lines.length}`)
  console.log(`③ 读数：跟随那一档 stdout ${lines.length} 行（列头在最前）`)
})

test('④ 负对照：`--header` 与 `--json` 说不到一起——退 2，列头不进机器读的那条流', () => {
  const root = fixture()
  for (const args of [['--json', 'log', '--header'], ['--json', 'watch', '--header']] as const) {
    const bad = run(root, '', ...args)
    assert.equal(bad.code, 2, `${args.join(' ')} 该退 2：${bad.stdout}${bad.stderr}`)
    assert.equal(bad.stdout, '', `${args.join(' ')}：stdout 一个字节不写`)
    const line = JSON.parse(bad.stderr.trim()) as { code: number; message: string }
    assert.equal(line.code, 2, '报文里的 code')
    assert.ok(line.message.includes('没有列'), `报文说得出为什么：${line.message}`)
  }
  // 反面：不给 --header 时 `--json log` 照旧一行一个对象，一个字节没动。
  const ok = run(root, '', '--json', 'log')
  assert.equal(ok.code, 0, ok.stderr)
  for (const l of rowsOf(ok.stdout)) JSON.parse(l)
})
