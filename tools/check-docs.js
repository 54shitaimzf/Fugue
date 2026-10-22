#!/usr/bin/env node
// 文档产物的**形状检查**：看一份已经生成好的文档目录，逐条核它能被谁读、哪里兑不掉。
//
// 用法：node tools/check-docs.js [目录]（缺省 `<root>/.fugue/docs`）
//
// 它不生成、不联网、不读配置：只认产物本身。判据分四组（交接单 § 6.1 的形状那一半）：
//
//   一 · 清单：`manifest.json` 可解析 · 版本与指针齐 · 指纹形状对
//   二 · 批次：清单里每一份文件都在、字节数与 sha 都对得上；目录里的 HTML 全在清单里
//   三 · 地址：每页有 H1 · id 不重复 · 内部链接（页 + 锚点）全部可达
//   四 · 自足：查找索引可解析且锚点都真 · 主题与清单一致 · 页脚带完整提交与指纹 · 无脚本退路在
//
// **它与 `build` 里的校验不是同一处。** 生成时那一道决定"这一批要不要落盘"；这一份在落盘之后
// 再看一遍——手改、半截拷贝、旧批次拼新页面，都只有在这一层看得见。检查脚本属于取证工具
// （仓库约定 § 七），默认不参与产品路径；测试里对着临时产物跑它（`test/check-docs.test.ts`）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.cwd(), '.fugue', 'docs')
const fail = []
const ok = (m) => console.log('  ok   ' + m)
const bad = (m) => {
  fail.push(m)
  console.log('  FAIL ' + m)
}

/**
 * 产物目录可能是**指向当前批次的符号链接**（新的整批替换形态）：清单与文件都在批次目录里。
 * 显式点名一个普通目录时（比如留档副本）就按它自己读。
 */
let base = dir
let entryKind = 'dir'
try {
  entryKind = fs.lstatSync(dir).isSymbolicLink() ? 'link' : 'dir'
  if (entryKind === 'link') base = fs.realpathSync(dir)
} catch {
  entryKind = 'missing'
}

function read(rel) {
  return fs.readFileSync(path.join(base, rel))
}

function listHtml(rel = '') {
  const out = []
  for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
    const p = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...listHtml(p))
    else if (e.name.endsWith('.html')) out.push(p)
  }
  return out
}

console.log(`目录：${dir}${entryKind === 'link' ? `（指向批次 ${base}）` : ''}`)
if (!fs.existsSync(dir)) {
  // **显式点名的目录不在，是路径写错了，不是“还没生成”**：默认位置缺了才是后者。
  if (process.argv[2] !== undefined) {
    console.log(`  FAIL 目录不存在：${dir}`)
    process.exit(2)
  }
  console.log('  info 没有这个目录：还没生成过（先跑 fugue docs build）')
  process.exit(0)
}

// ── 一 · 清单 ────────────────────────────────────────────────────────────────
console.log('清单')
let manifest = null
try {
  manifest = JSON.parse(read('manifest.json').toString('utf8'))
  ok(`manifest.json 可解析（第 ${manifest.version} 版 · ${manifest.pages.length} 页）`)
} catch (err) {
  bad(`manifest.json 读不动：${err.message}`)
}
const HEX40 = /^[0-9a-f]{40}$/
const FP = /^sha256:[0-9a-f]{64}$/
if (manifest !== null) {
  if (typeof manifest.commit === 'string' && HEX40.test(manifest.commit)) ok(`提交是 40 位十六进制：${manifest.commit.slice(0, 12)}…`)
  else bad(`提交不是 40 位十六进制：${JSON.stringify(manifest.commit)}`)
  if (typeof manifest.fingerprint === 'string' && FP.test(manifest.fingerprint)) ok('指纹形状对（sha256: + 64 位）')
  else bad(`指纹形状不对：${JSON.stringify(manifest.fingerprint)}`)
  if (typeof manifest.generatedAt === 'string' && !Number.isNaN(Date.parse(manifest.generatedAt))) ok(`生成时间：${manifest.generatedAt}`)
  else bad('生成时间不在清单里（或不是时间）')
  if (Array.isArray(manifest.pages) && manifest.pages.length > 0) ok(`页面清单 ${manifest.pages.length} 份`)
  else bad('页面清单是空的')
  // **旧地址的去向要能完整枚举**（复审 R6：原先只有六条示例与一个总数）。
  const dropped = manifest.pages.filter((p) => Array.isArray(p.dropped)).reduce((n, p) => n + p.dropped.length, 0)
  const missingDropped = manifest.pages.filter((p) => !Array.isArray(p.dropped))
  if (missingDropped.length > 0) bad(`有 ${missingDropped.length} 页没写 dropped（旧地址的去向列不全）`)
  else ok(`旧地址枚举齐全（${manifest.pages.length} 页 · 无后继 ${dropped} 条）`)
  // **截断范围进清单**（复审 R3）：取证被截断的那些要说得出来。
  const noTrunc = manifest.pages.filter((p) => p.evidence === undefined || !Array.isArray(p.evidence.ranges))
  if (noTrunc.length > 0) bad(`有 ${noTrunc.length} 页的 evidence 没记取证行段`)
  else ok('每页的取证行段（含截断）都在清单里')
}

// ── 二 · 批次 ────────────────────────────────────────────────────────────────
console.log('批次')
const files = manifest === null || !Array.isArray(manifest.files) ? [] : manifest.files
let bytesOk = 0
for (const f of files) {
  try {
    const bytes = read(f.path)
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    if (bytes.length === f.bytes && sha === f.sha) bytesOk += 1
    else bad(`${f.path} 与清单对不上（字节 ${bytes.length} vs ${f.bytes} · sha ${sha.slice(0, 12)} vs ${String(f.sha).slice(0, 12)}）`)
  } catch (err) {
    bad(`${f.path} 不在产物里：${err.message}`)
  }
}
if (files.length > 0) ok(`清单里的 ${files.length} 份文件，${bytesOk} 份逐字节对得上`)
const allHtml = listHtml()
const listed = new Set(files.map((f) => f.path))
const stray = allHtml.filter((h) => !listed.has(h))
if (stray.length === 0) ok(`目录里的 ${allHtml.length} 个 HTML 全在清单里`)
else bad(`目录里有清单没写的 HTML：${stray.join(' · ')}`)

// ── 三 · 地址 ────────────────────────────────────────────────────────────────
console.log('地址')
const idsOf = new Map()
for (const h of allHtml) {
  const html = read(h).toString('utf8')
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
  if (dup.length > 0) bad(`${h} 里有重复 id：${[...new Set(dup)].join(' · ')}`)
  idsOf.set(h, new Set(ids))
}
let links = 0
for (const h of allHtml) {
  const html = read(h).toString('utf8')
  if (/<h1[\s>]/.test(html)) ok(`${h} 有 H1`)
  else bad(`${h} 没有 H1（读者不知道自己在读什么）`)
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1]
    if (/^(https?:|mailto:)/.test(href)) continue
    // **带 scheme 的链接单独说一句**：它也可能是 `javascript:` / `data:` 这类可执行地址，
    // 不能只报成“链到不存在的页”。
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      bad(`${h} 里有一条带 scheme 的链接：${href}`)
      continue
    }
    links += 1
    const cut = href.indexOf('#')
    const page = (cut < 0 ? href : href.slice(0, cut)) || h
    const anchor = cut < 0 ? '' : href.slice(cut + 1)
    if (!idsOf.has(page)) {
      bad(`${h} 里有一条链到不存在的页：${href}`)
      continue
    }
    if (anchor !== '' && !idsOf.get(page).has(anchor)) bad(`${h} 里有一条链到不存在的锚点：${href}`)
  }
  // 图片：只允许产物内的相对地址（`_assets/`）；外链图在生成时已印成链接。
  for (const m of html.matchAll(/\ssrc="([^"]+)"/g)) {
    const src = m[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) bad(`${h} 里有一张带 scheme 的图：${src}`)
    else if (src.startsWith('_assets/') && !fs.existsSync(path.join(base, src))) bad(`${h} 的图不在产物里：${src}`)
  }
  // 可见正文里的反引号：代码段正常会变成 <code>、围栏会变成 <pre>，落单的反引号说明那一截没被当成代码。
  // `<code>` 里面那些是作者有意写的字面反引号（模型写“形如 `\`T1\`` 的声明”那一类），不算漏。
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<pre>[\s\S]*?<\/pre>/g, '')
    .replace(/<code>[\s\S]*?<\/code>/g, '')
    .replace(/<[^>]+>/g, '')
  const ticks = (visible.match(/`/g) ?? []).length
  if (ticks > 0) bad(`${h} 的可见正文里有 ${ticks} 个反引号（代码段没配对或围栏漏进了正文）`)
}
ok(`${allHtml.length} 个页面 · ${links} 条内部链接逐条查过`)

// ── 四 · 自足 ────────────────────────────────────────────────────────────────
console.log('自足')
for (const h of allHtml) {
  const html = read(h).toString('utf8')
  const m = /<script type="application\/json" id="doc-index">([\s\S]*?)<\/script>/.exec(html)
  if (m === null) {
    bad(`${h} 里没有查找索引`)
    continue
  }
  let entries = []
  try {
    entries = JSON.parse(m[1])
  } catch (err) {
    bad(`${h} 的查找索引不是 JSON：${err.message}`)
    continue
  }
  const dead = entries.filter((e) => !idsOf.has(e.p) || (e.h !== '' && !idsOf.get(e.p).has(e.h)))
  if (dead.length > 0) bad(`${h} 的索引里有 ${dead.length} 条命中落不到正文（如 ${dead[0].p}#${dead[0].h}）`)
  // **命中落到具体内容块**，且**索引里的文字真的在渲染正文里**（复审 R1/R5：两处各一份时它们会漂）。
  const deadBlock = entries.filter((e) => e.b !== '' && !idsOf.get(e.p)?.has(e.b))
  if (deadBlock.length > 0) bad(`${h} 的索引里有 ${deadBlock.length} 条命中没有内容块（如 ${deadBlock[0].p}#${deadBlock[0].b}）`)
  const textOfPage = (page) => {
    const raw = read(page).toString('utf8')
    return raw
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
  }
  const textCache = new Map()
  const missingText = entries.filter((e) => {
    if (!idsOf.has(e.p)) return false
    if (!textCache.has(e.p)) textCache.set(e.p, textOfPage(e.p))
    return !textCache.get(e.p).includes(e.x.replace(/\s+/g, ' ').trim())
  })
  if (missingText.length > 0) bad(`${h} 的索引里有 ${missingText.length} 条片段在正文里找不到（如 ${missingText[0].p}：${missingText[0].x.slice(0, 40)}）`)
  if (deadBlock.length === 0 && missingText.length === 0) ok(`${h} 的 ${entries.length} 条命中都落到内容块，且文字都在正文里`)
  if (!html.includes('<noscript>')) bad(`${h} 没有"没有脚本也能读"的说明`)
  if (manifest !== null && manifest.theme !== undefined) {
    if (html.includes(`data-doc-theme="${manifest.theme}"`)) ok(`${h} 的主题与清单一致（${manifest.theme}）`)
    else bad(`${h} 的主题与清单不一致（清单写 ${manifest.theme}）`)
  }
  if (manifest !== null) {
    if (html.includes(`<code>${manifest.commit}</code>`) && html.includes(`<code>${manifest.fingerprint}</code>`)) {
      ok(`${h} 的页脚带完整提交与指纹`)
    } else {
      bad(`${h} 的页脚没带完整提交或指纹`)
    }
  }
}

console.log('')
if (fail.length === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`不通过：${fail.length} 处`)
process.exit(1)
