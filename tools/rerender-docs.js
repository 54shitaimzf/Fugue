#!/usr/bin/env node
// **只重渲染**：拿产物里已有的 `content/*.md` 重走一遍宿主那一半（markdown → 页面 → 清单 → 保存）。
//
// 用法：`node tools/rerender-docs.js [--root <dir>] [--at <ref>] [--theme <id>]`
//
// 它**不调模型、不出网、不花一分钱**，也不改清单语义与指纹口径：提交 · 定义 · 来源 · 模型声明
// 照旧参与指纹，取证事实从上一批原样搬过来（那是这些正文当时依据的材料）。它只做一件事：
// 渲染器变了之后，把同一份正文重新呈现一遍。
//
// 为什么需要它：渲染器的修正（丢字、查找、地址）不改变模型写下的正文，重跑一次真实生成要花
// 十几万 token 且会换掉正文；这一条路只换"宿主那一半"。
//
// 它**不写** `last.json`：那不是一次模型生成，"最近一次生成"应当仍指向真正的那一次。
import { readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { readConfig } from '../src/config.ts'
import { parseDocs } from '../src/docs/config.ts'
import { RENDERER_VERSION, docsRootOf } from '../src/docs/contract.ts'
import { buildDocs } from '../src/docs/build.ts'
import { readManifest } from '../src/docs/publish.ts'
import { callerOf } from '../src/docs/writer.ts'
import { openTruth } from '../src/truth/truth.ts'

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) {
    console.error(`--${name} 需要一个值`)
    process.exit(2)
  }
  return v
}

const args = process.argv.slice(2)
const root = resolvePath(flag(args, 'root', process.cwd()))
const at = flag(args, 'at', 'HEAD')
const theme = flag(args, 'theme', undefined)

const config = await readConfig(root)
const plan = parseDocs(config)
if (plan === null) {
  console.error('这个工作区没有 docs 配置：没有可重渲染的文档计划')
  process.exit(1)
}
const prev = await readManifest(root)
if (prev === null) {
  console.error(`没有现成产物可重渲染：${docsRootOf(root)} 下还没有清单（先跑一次 fugue docs build）`)
  process.exit(1)
}

const dir = docsRootOf(root)
const markdown = new Map()
const evidence = new Map()
const notes = new Map()
for (const p of plan.pages) {
  const before = prev.pages.find((x) => x.id === p.id)
  if (before === undefined) {
    console.error(`上一批里没有文档 ${p.id} 的正文：content/${p.id}.md`)
    process.exit(1)
  }
  markdown.set(p.id, readFileSync(join(dir, before.content), 'utf8'))
  evidence.set(p.id, before.evidence)
  notes.set(p.id, before.notes)
}

const materials = {
  kind: 'manual',
  note: `按已有正文重渲染（渲染器 ${RENDERER_VERSION}）：内容与取证来自上一批 content/，这一趟没有调用模型`,
}

const truth = openTruth(root)
try {
  const caller = callerOf({ config })
  const out = await buildDocs({
    root,
    config,
    truth,
    caller,
    materials,
    at,
    ...(theme === undefined ? {} : { theme }),
    reuse: { markdown, evidence, notes },
    record: false,
  })
  if (!out.ok) {
    console.error(`重渲染失败（${out.at_stage}）：${out.reason}`)
    process.exit(1)
  }
  console.log(`重渲染完成：${out.pages.length} 页 · 提交 ${out.commitShort} · 渲染器 ${RENDERER_VERSION}`)
  console.log(`  指纹 ${out.fingerprint}`)
  console.log(`  入口 ${out.docsDir}/index.html`)
  if (out.notes.length > 0) {
    console.log(`  待复核：${out.notes.length} 处（见 manifest.json 的 pages[].notes）`)
  }
} finally {
  truth.close()
}
