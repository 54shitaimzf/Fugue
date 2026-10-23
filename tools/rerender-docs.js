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
import { excerptAt } from '../src/docs/facts.ts'
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
/** 迁移用：旧地址的去向按这一份清单算（比如上一版真实清单里那句“没有后继”）。 */
const prevPath = flag(args, 'prev', undefined)

const config = await readConfig(root)
const plan = parseDocs(config)
if (plan === null) {
  console.error('这个工作区没有 docs 配置：没有可重渲染的文档计划')
  process.exit(1)
}
const prev = prevPath === undefined ? await readManifest(root) : JSON.parse(readFileSync(resolvePath(prevPath), 'utf8'))
if (prev === null) {
  console.error(`没有现成产物可重渲染：${docsRootOf(root)} 下还没有清单（先跑一次 fugue docs build）`)
  process.exit(1)
}

/**
 * 上一批只剩一句说明、没有机器记录时，把“没有后继”的旧地址取回来再认一遍。
 *
 * 0.5.1 时代的标题 id（如 `v0-5-2`）在 0.5.2 的第一版生成里被当作“没有后继”丢掉了，清单里
 * 只留下那句说明；而 `v052` 就在同一页。这一次迁移从说明里把它们取回来，按 id 自己的身份重认；
 * 之后每一批都有 `pages[].dropped` 这份机器记录，不再需要解析文字。
 */
function revivedOf(manifest) {
  const out = new Map()
  for (const p of manifest.pages) {
    const ids = [...(p.dropped ?? [])]
    for (const note of p.notes ?? []) {
      const hit = /旧深链接没有后继（这一版没有对应内容）：(.*)$/.exec(note)
      if (hit !== null) {
        for (const part of hit[1].split('·')) {
          // 旧说明末尾有“…共 N 条”：它是个计数，不是一个旧地址。
          const id = part.replace(/…共\s*\d+\s*条.*$/, '').trim()
          if (id === '' || id.includes('…')) continue
          ids.push(id)
        }
      }
    }
    if (ids.length > 0) out.set(p.id, [...new Set(ids)])
  }
  return out
}

const dir = docsRootOf(root)
const markdown = new Map()
const evidence = new Map()
const notes = new Map()
const truth = openTruth(root)
try {
  const commit = await truth.resolve(at)
  for (const p of plan.pages) {
    const before = prev.pages.find((x) => x.id === p.id)
    if (before === undefined) {
      console.error(`上一批里没有文档 ${p.id} 的正文：content/${p.id}.md`)
      process.exit(1)
    }
    markdown.set(p.id, readFileSync(join(dir, before.content), 'utf8'))
    notes.set(p.id, before.notes)
    // **截断范围补进清单**：上一批没有记行段（那时清单只有 requested/found/missing）。
    // 用当时那道上界（12000 字符）按同一份提交重算一遍：它说的是“这些正文当时看到的是哪一段”。
    const ranges = []
    for (const path of before.evidence?.found ?? []) {
      const x = await excerptAt(truth, commit, path, { limit: 12_000 })
      if (x === null) continue
      ranges.push({ path, lines: x.lines, chars: x.chars, shown: x.shown, truncated: x.truncated })
    }
    evidence.set(p.id, {
      mode: before.evidence?.mode ?? 'skipped',
      requested: before.evidence?.requested ?? [],
      found: before.evidence?.found ?? [],
      missing: before.evidence?.missing ?? [],
      ranges,
    })
  }

  const materials = {
    kind: 'manual',
    note: `按已有正文重渲染（渲染器 ${RENDERER_VERSION}）：内容与取证事实来自上一批 content/，这一趟没有调用模型（取证行段按上一版的上界 12000 字符重算，不是当时落下的原始读数）`,
  }

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
    revive: revivedOf(prev),
    prev,
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
