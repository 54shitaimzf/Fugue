// 正文的形状核对：**宿主只判可机械核对的那几条**（内容取舍留给复核）。
//
// 从 build.ts 搬出来时补的断言：搬之前 ./check.ts 不存在。四条会红的判据各有一个案例，
// 另有“H1 与 ## 同现只记 note、不拒”的那一档（交接单 § 2.1 正文完整；复审 R1/R3 的反面）。
import type { PageDef, TreeFacts } from './contract.ts'
import { DocsError } from './contract.ts'
import { CONTENT_MIN_CHARS } from './prompt.ts'

/** 正文的形状核对：**宿主只判可机械核对的那几条**（内容取舍留给复核）。返回兑不掉的 note。 */
export function checkContent(def: PageDef, md: string): string[] {
  const notes: string[] = []
  const text = md.trim()
  if (text === '') throw new DocsError('render', `第 ${def.id} 页（${def.title}）的正文是空的`)
  if (text.length < CONTENT_MIN_CHARS) {
    throw new DocsError('render', `第 ${def.id} 页（${def.title}）的正文只有 ${text.length} 个字符，短于 ${CONTENT_MIN_CHARS}：这一页没写出来`)
  }
  const hasH1 = /^\s*#\s+/m.test(text)
  const hasH2 = /^\s*#{2,}\s+/m.test(text)
  // **只写 H1 时先说清这一条**：它同时满足“没有 ##”，但真正该改的是“从 ## 起”。
  if (hasH1 && !hasH2) {
    throw new DocsError('render', `第 ${def.id} 页（${def.title}）只写了 H1：页标题由宿主加，正文要从 ## 起`)
  }
  if (!/^\s*#{2,6}\s+/m.test(text)) {
    throw new DocsError('render', `第 ${def.id} 页（${def.title}）的正文里一个章节标题都没有（## 起）：读者无法按节读`)
  }
  // **H1 与 ## 同时出现时不拒**（那一段仍有完整可读内容），但要如实记下来：它会被宿主按 H2 呈现。
  if (hasH1) notes.push('正文里写了 H1（页标题由宿主按定义加）：这一行按 H2 呈现')
  return notes
}
/** 正文里引用的路径（清单里的"取证依据"）：行内代码里出现的、提交里真有的那些。 */
export function citedOf(markdown: string, facts: TreeFacts): string[] {
  const known = new Set(facts.paths)
  const found = new Set<string>()
  const re = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const p = m[1]!
    if (known.has(p)) found.add(p)
  }
  return [...found].sort()
}
