// 第一幕 ②-2：数字排版收一处的断言（施工单 § 五 ②「人面千分位 · 大数换单位；`--json`
// 面裸值不动——排版只发生在渲染上」）。
//
// 三件事分开量：
//   · **排版那一处**：`humanNumber` 三档各在什么地方换（小的原样 · 四位起千分位 · 一万起换
//     单位），边界值点名（9999 / 10000 / 1e8）；
//   · **真的走上去了**：`status` 的人读面（`linesOf` 那一处）上，一个五位数的用量印出来是
//     `1.2万`——不是只在单元里成立、命令面没接线；
//   · **机器面一个字节不动**：值层（`statusOf`）给的是**裸数**（`12345`，数不是串），
//     `--json` 那一面因此一个字节没变。
//
// 负对照（红得起来才是断言；三处各注入过一次，下面是实测结果）：
//   ① 把 `humanNumber` 那两条 `if` 删掉（只剩千分位）→ ①② 当场红（① 的 10000/1e8 两档）；
//   ② 把 `one()` 那两处的 `humanNumber(...)` 去掉（`用量` 每一格的排版处）→ ② 当场红。
//      **注在别处不算**：第一版注在 `调用 N` 那一格上，而它是 1——改了看不出，那一版照旧绿；
//   ③ 把排版接到 `totalOf` 那一侧（值层）→ **黄金帧 `status-json面` 当场红**（机器面脏了）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../test/helpers/tmp.ts'
import { grouped, humanNumber } from './human.ts'
import { readCatalog } from './model/catalog.ts'
import { linesOf, statusOf } from './probe/status.ts'
import type { StatusRow } from './probe/status.ts'

const CLI = fileURLToPath(new URL('./cli/fugue.ts', import.meta.url))

test('① 三档与边界：小的原样 · 四位起千分位 · 一万起换单位（千分位不用 toLocaleString）', () => {
  assert.equal(grouped(1234), '1,234')
  assert.equal(grouped(1234567), '1,234,567')
  assert.equal(humanNumber(0), '0')
  assert.equal(humanNumber(999), '999')
  assert.equal(humanNumber(1000), '1,000')
  assert.equal(humanNumber(9999), '9,999', '四位还是千分位')
  assert.equal(humanNumber(10000), '1万', '一万那一档换单位（整数不留 .0）')
  assert.equal(humanNumber(12345), '1.2万')
  assert.equal(humanNumber(1234567), '123.5万')
  assert.equal(humanNumber(99999999), '10000万', '不到一亿就还在万那一档')
  assert.equal(humanNumber(100000000), '1亿')
  assert.equal(humanNumber(250000000), '2.5亿')
  assert.equal(humanNumber(-12345), '-1.2万', '负号留着（跳步那一栏印得出负数）')
  console.log(
    `① 读数：1234 → ${humanNumber(1234)} · 9999 → ${humanNumber(9999)} · 12345 → ${humanNumber(12345)} · ` +
      `1234567 → ${humanNumber(1234567)} · 1e8 → ${humanNumber(100000000)}`,
  )
})

/** 一份账：一次 `llm/call`，用量给三个够走遍三档的数。 */
function bigRows(): StatusRow[] {
  return [
    {
      pos: { writer: 'round', seq: 1 },
      e: {
        t: 'llm/call',
        agent: 'round',
        step: 1,
        model: 'm',
        stop: 'end-turn',
        rawStop: 'end_turn',
        thinking: null,
        usage: {
          inputTokens: 12345,
          cacheReadTokens: 1234567,
          cacheWriteTokens: 0,
          outputTokens: 999,
          reasoningTokens: null,
        },
      },
    } as unknown as StatusRow,
  ]
}

test('② 人面真的走上去了：`linesOf` 那一行的用量是排过版的（命令面接线在场）', () => {
  const s = statusOf(bigRows())
  assert.equal(s.usage.inputTokens.total, 12345, '折出来的还是裸数（值层不动）')
  const line = linesOf(s, { cat: readCatalog() }).find((l) => l.startsWith('用量 '))
  assert.ok(line !== undefined, '快照里该有一行用量')
  assert.ok(line.includes('input 1.2万'), `input 那一格是 1.2万：${line}`)
  assert.ok(line.includes('cacheRead 123.5万'), `cacheRead 那一格是 123.5万：${line}`)
  assert.ok(line.includes('output 999'), `三位数原样：${line}`)
  assert.ok(!line.includes('12345') && !line.includes('1234567'), `人面上不该再出现裸数：${line}`)
  console.log(`② 读数：${line}`)
})

test('③ 机器面裸值不动：值层给的是数，不是排过版的字符串', () => {
  const s = statusOf(bigRows())
  assert.equal(typeof s.usage.inputTokens.total, 'number', '机器面拿到的是数')
  assert.equal(JSON.stringify(s.usage.inputTokens.total), '12345')
  assert.equal(JSON.stringify(s.usage.cacheReadTokens.total), '1234567')
  // 跨进程那一档：`--json status` 出来的是能解析的对象，取到的那一格仍是数。
  const root = tmpDir('fugue-human-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const r = spawnSync(process.execPath, [CLI, '--root', root, '--json', 'status'], { encoding: 'utf8', maxBuffer: 1 << 24 })
  assert.equal(r.status, 0, r.stderr)
  const doc = JSON.parse(r.stdout) as { snapshot: { usage: { inputTokens: { total: number } } } }
  assert.equal(typeof doc.snapshot.usage.inputTokens.total, 'number')
})
