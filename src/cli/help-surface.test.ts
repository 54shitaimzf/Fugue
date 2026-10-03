// 速查表与命令面对账：`fugue --help` 那张表列出的命令，与 `cli/flags.ts` 的 `FLAGS_OF` 的键
// **逐条相同**——两向：命令面一格不许少（少一行 = 表上查不到一条真有的命令；`assemble` 在
// 速查表换成面向一般用户的话那一阵漏掉了，缺口登记在路线图 § 10），速查表一行不许多
// （多一行 = 表上有一条跑不起来的命令）。
//
// 判据是**数出来的行**：速查表里每一行的行首恰好两个空格、第 3 个字符起是命令名——那种行才是
// 命令行；组标题是汉字打头、选项行是 `-` 打头、续行缩进 29 列，都不算。
//
// 子命令那一层还有一处 ① 与 ② 都抓不住的：`config` 在 `FLAGS_OF` 里是**一个**键，所以速查表
// 少了 `config ls` 那一行，①（首词去重）与 ②（键逐条有行）照旧是绿的。③ 把断言挂在
// `cmd/config.ts` 的 `CONFIG_VERBS` 上——那才是 config 子命令的那一处真源。
//
// 负对照（红得起来才是断言）：从速查表里删掉 `assemble` 那一行（连它那一组的标题一起），
// ① 当场红——命令面 28 条、表上只剩 27 条。这一条量的正是登记进路线图 § 10 的那个缺口；
// 删掉 `config ls` 那一行则只有 ③ 红（①② 照旧绿）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFIG_VERBS } from './cmd/config.ts'
import { FLAGS_OF } from './flags.ts'
import { USAGE } from './shared.ts'

/** 速查表里的命令行：行首恰好两个空格，第 3 个字符起是命令名。 */
const ROWS = /^ {2}([a-z][a-z0-9-]*)(?= |$)/gm

const rowNames = (): string[] => [...USAGE.matchAll(ROWS)].map((m) => m[1]!)
const topOf = (key: string): string => key.split(' ')[0]!
const surface = (): string[] => [...new Set(Object.keys(FLAGS_OF).map(topOf))].sort()

test('① 速查表列出的命令集合与 `FLAGS_OF` 的键集合逐条相同（两向）', () => {
  const listed = [...new Set(rowNames())].sort()
  assert.deepEqual(listed, surface(), '速查表里的命令与命令面逐条相同：格一个不许少、行一个不许多')
  console.log(
    `① 读数：命令面 ${Object.keys(FLAGS_OF).length} 个键 → ${surface().length} 条命令；` +
      `速查表 ${rowNames().length} 行 → ${listed.length} 条命令（逐条相同）`,
  )
})

test('② 命令面每一个键在速查表里都有自己的行（子命令按名字算：`round plan` 那种）', () => {
  const keys = Object.keys(FLAGS_OF)
  const missing = keys.filter((k) => !new RegExp(`^ {2}${k}(?= |$)`, 'm').test(USAGE))
  assert.deepEqual(missing, [], `命令面里有、速查表里没有行的：${missing.join(' · ')}`)
  console.log(`② 读数：${keys.length} 个键，${keys.length - missing.length} 个在速查表里有自己的行`)
})

test('③ `config` 的每一条子命令在速查表里都有自己的行（`config` 在命令面是一个键，①②抓不住）', () => {
  const missing = CONFIG_VERBS.filter((v) => !new RegExp(`^ {2}config ${v}(?= |$)`, 'm').test(USAGE))
  assert.deepEqual(missing, [], `config 的子命令里，速查表没有行的：${missing.join(' · ')}`)
  console.log(`③ 读数：config ${CONFIG_VERBS.length} 条子命令，逐条有行 —— ${CONFIG_VERBS.join(' · ')}`)
})
