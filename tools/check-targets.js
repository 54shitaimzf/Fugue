#!/usr/bin/env node
// 跨文档引用校验：架构篇与目标篇里出现的每个 T# 都必须在目标篇的「目标总表」里有对应行。
//
// 两篇都住在本仓库 `design/`（2026-10-01 从文档工作区搬入）——所以这里没有候选路径那一套：
// 路径由本文件自己推，在哪儿跑都一样。
// 用法：cd ~/fugue && node tools/check-targets.js
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ARCH_NAME = 'design/ARCHITECTURE.md'
const TGT_NAME = 'design/TARGETS.md'
const arch = readFileSync(join(REPO, ARCH_NAME), 'utf8')
const tgt = readFileSync(join(REPO, TGT_NAME), 'utf8')

const fail = []
const ok = (m) => console.log('  ok   ' + m)
const bad = (m) => { fail.push(m); console.log('  FAIL ' + m) }

// 总表里的 T# 定义：表格行首列 `| **T1** |`
const defined = new Set()
for (const m of tgt.matchAll(/^\|\s*\*\*(T\d+)\*\*\s*\|/gm)) defined.add(m[1])

// 两篇里出现的所有 T#
const used = new Map()
for (const [name, src] of [[ARCH_NAME, arch], [TGT_NAME, tgt]]) {
  for (const m of src.matchAll(/\bT(\d+)\b/g)) {
    const id = 'T' + m[1]
    if (!used.has(id)) used.set(id, new Set())
    used.get(id).add(name)
  }
}

console.log('目标引用')
ok(`总表定义 ${defined.size} 条：${[...defined].join(' · ')}`)

const dangling = [...used.keys()].filter((id) => !defined.has(id))
if (!dangling.length) ok(`${used.size} 个被引用的 T# 全部有定义`)
else bad('没有定义的引用：' + dangling.join(' · '))

const unreferenced = [...defined].filter((id) => !used.has(id))
if (!unreferenced.length) ok('每条目标都在正文被引用')
else bad('只出现在总表里、正文未引用：' + unreferenced.join(' · '))

const inArch = [...used].filter(([, s]) => s.has(ARCH_NAME)).map(([id]) => id)
ok(`架构篇引用 ${inArch.length} 条：${inArch.join(' · ')}`)

// 架构篇首页那一句声明的编号范围是个字面量，总表一增就会漂——所以对着总表核一遍
const nums = [...defined].map((id) => Number(id.slice(1))).sort((a, b) => a - b)
const lo = nums[0]
const hi = nums[nums.length - 1]
const range = arch.match(/编号\s*`T(\d+)`\s*[–—-]\s*`T(\d+)`/)
if (!range) bad('架构篇首页没有声明编号范围')
else if (Number(range[1]) === lo && Number(range[2]) === hi && hi - lo + 1 === defined.size) {
  ok(`首页声明的范围与总表一致：\`T${lo}\`–\`T${hi}\`，${defined.size} 条连续`)
} else {
  bad(`首页声明 \`T${range[1]}\`–\`T${range[2]}\`，总表是 \`T${lo}\`–\`T${hi}\`（${defined.size} 条）`)
}

console.log(fail.length ? `\n${fail.length} 项未通过` : '\n全部通过')
process.exit(fail.length ? 1 : 0)
