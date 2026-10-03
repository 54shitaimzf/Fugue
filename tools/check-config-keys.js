#!/usr/bin/env node
// 配置键文档校验：拿代码仓里那两份给使用者的文档（`README.md` · `AGENTS.md`），
// 把里面教过的配置键与「config 有几条子命令」对着实现数一遍。
//
//   一 · **键域**：凡以 `fugue config set|get <点分键>` 出现过的键，**顶层段**必须在
//        `src/config.ts` 的 `TOP_LEVEL_KEYS` 里。那一份是唯一真源，这里 import 它，
//        不抄第二份清单——抄的那一份漂了不报错，这一份漂了当场红。
//        为什么值得一道闸：拼错的顶层键会被读面**静默当成「没配」**（那比报错危险），
//        文档里教错一个，照着敲的人正好落在那一档上。
//   二 · **条数**：文档里数了「`config` 有 N 条子命令」的地方，N 要与实现认的 verb 数相符。
//        verb 集从 `src/cli/cmd/config.ts` 取，两处：声明 `CONFIG_VERBS` 与分发里那一串
//        `verb === '…'`——**两者不一致也当场红**（那是声明与实现之间那道缝）。
//   三 · **提示，不挡**：键域里有、这两份文档一字没教的顶层键，印一行说出来。文档只教常用
//        的那几个，全貌由 `fugue config ls` 给。
//
// 口径：扫的是**示例命令行**（`fugue config set` / `fugue config get` 后面那个键），不是
// "正文里出现的任何点分串"——宽了会把 `~/.fugue/models.json` 这类**文件路径**与说明文字
// 一起误收。`CHANGELOG.md` 不在扫描范围（历史不回头）。二级结构不查：键域今天只闭到顶层，
// 二级没有可对的那一份——另造一份就是新立一处真源。
//
// 用法：node tools/check-config-keys.js [文档…]   不给就是仓库里的 README.md 与 AGENTS.md
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOP_LEVEL_KEYS } from '../src/config.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_DOCS = ['README.md', 'AGENTS.md']
const KEYS_SRC = join(REPO, 'src', 'config.ts')
const CMD_SRC = join(REPO, 'src', 'cli', 'cmd', 'config.ts')

const fail = []
const ok = (m) => console.log('  ok   ' + m)
const bad = (m) => { fail.push(m); console.log('  FAIL ' + m) }
const info = (m) => console.log('  info ' + m)

for (const p of [KEYS_SRC, CMD_SRC]) {
  if (!existsSync(p)) {
    console.log(`  FAIL 找不到 ${p}——实现那一侧不在就是仓库坏了`)
    process.exit(1)
  }
}

const asked = process.argv.slice(2)
const docs = []
for (const p of asked.length > 0 ? asked : DEFAULT_DOCS.map((f) => join(REPO, f))) {
  if (!existsSync(p)) {
    console.log(`  FAIL 文档读不到：${p}`)
    process.exit(1)
  }
  docs.push({ path: p, text: readFileSync(p, 'utf8') })
}

// ── 一 · 文档教过的键，顶层段要在键域里 ────────────────────────────────────────
// `--system` 可以夹在 `set` 与键之间（README 就是这么写的）；键允许点分，但不吃引号与空白，
// 于是 `<key>` 这类占位符不会被当成一个键收进来。
const KEY_RE = /fugue\s+config\s+(?:set|get)\s+(?:--[a-z-]+\s+)*([A-Za-z][A-Za-z0-9_-]*(?:\.[^\s'"]+)*)/g

const taught = new Map()
let sites = 0
for (const { path, text } of docs) {
  for (const [i, line] of text.split('\n').entries()) {
    for (const m of line.matchAll(KEY_RE)) {
      sites++
      const key = m[1]
      const top = key.split('.')[0]
      if (!taught.has(top)) taught.set(top, [])
      taught.get(top).push({ where: `${path}:${i + 1}`, key })
    }
  }
}

console.log('配置键（文档 → 键域）')
ok(`文档 ${docs.length} 份 · 教过 ${sites} 处键，落在 ${taught.size} 个顶层段上：${[...taught.keys()].sort().join(' · ')}`)
const unknown = [...taught].filter(([top]) => !TOP_LEVEL_KEYS.includes(top))
if (unknown.length === 0) {
  ok(`这 ${taught.size} 个顶层段都在键域里（键域 ${TOP_LEVEL_KEYS.length} 个）`)
} else {
  for (const [top, where] of unknown) {
    bad(
      `文档教了一个键域里没有的顶层键 ${top}：` +
        where.map((w) => `${w.where} 的 \`${w.key}\``).join(' · ') +
        ` —— 顶层只认 ${TOP_LEVEL_KEYS.join(' · ')}（架构 § 15.3.a）`,
    )
  }
}

const untaught = TOP_LEVEL_KEYS.filter((k) => !taught.has(k))
if (untaught.length > 0) {
  info(`键域里文档没教过的 ${untaught.length} 个：${untaught.join(' · ')}（只提示不挡——全貌由 \`fugue config ls\` 给）`)
}

// ── 二 · 「config 有 N 条子命令」对实现 ────────────────────────────────────────
// 声明那一份与分发那一串都要在；只找到一处就当场说，不猜。
const cmdSrc = readFileSync(CMD_SRC, 'utf8')
const decl = cmdSrc.match(/CONFIG_VERBS[^=]*=\s*\[([^\]]*)\]/)
const declaredVerbs = decl === null ? [] : [...decl[1].matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1])
const branchVerbs = [...new Set([...cmdSrc.matchAll(/verb === '([a-z][a-z0-9-]*)'/g)].map((m) => m[1]))]
const same = (a, b) => [...a].sort().join('|') === [...b].sort().join('|')

console.log('子命令条数（文档 → 实现）')
if (decl === null) bad(`\`${CMD_SRC}\` 里找不到 \`CONFIG_VERBS = [...]\`——形状变了就当场说，不猜`)
else if (branchVerbs.length === 0) bad(`\`${CMD_SRC}\` 里找不到 \`verb === '…'\` 那一串——形状变了就当场说，不猜`)
else if (!same(declaredVerbs, branchVerbs)) {
  bad(
    `CONFIG_VERBS（${declaredVerbs.join(' · ')}）与分发实际认的 verb（${branchVerbs.join(' · ')}）不一致` +
      ` —— 声明与实现之间那道缝漏了`,
  )
} else ok(`CONFIG_VERBS 与分发认的 verb 逐条相符：${declaredVerbs.join(' · ')}`)

const COUNT_RE = /`?config`?\s*有\s*(\d+)\s*条/g
let counted = 0
for (const { path, text } of docs) {
  for (const [i, line] of text.split('\n').entries()) {
    for (const m of line.matchAll(COUNT_RE)) {
      counted++
      const n = Number(m[1])
      if (n === declaredVerbs.length) {
        ok(`${path}:${i + 1} 数的「config 有 ${n} 条」与实现的 ${declaredVerbs.length} 个 verb 相符`)
      } else {
        bad(
          `${path}:${i + 1} 数成「config 有 ${n} 条」，实现认的是 ${declaredVerbs.length} 个：` +
            `${declaredVerbs.join(' · ')}`,
        )
      }
    }
  }
}
// 一处都不数 = 这道闸落空了。文档不写这个数，就得改这份校验器的口径——两条路都要有人点一次头。
if (counted === 0) {
  bad(`这两份文档里一处都没数「config 有 N 条子命令」——这一格没有对账对象了（要么把数写回文档，要么改这份校验器的口径）`)
}

console.log(fail.length ? `\n${fail.length} 项未通过` : '\n全部通过')
process.exit(fail.length ? 1 : 0)
