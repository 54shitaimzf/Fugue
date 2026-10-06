// **措辞当 API**：机器要 grep 的那几句文案只有一处定义（`src/phrases.ts`）。出处：架构 § 8.6
// （子进程 `open()` 拿 errno，父进程手里只剩 stderr 那一句——**判据是那几句文案**）·
// ROADMAP § 5 的 0.4.1 行验收格：**词表同义两处定义必报**。
//
// 两条判据：
//   一 · **表外一处都不许有**：`src/` 与 `test/` 的任何文件里出现表里那一串字面，就是第二处定义。
//   二 · **表里不许同义**：两个键写成同一串字面，也是两处定义（换个键名不解决问题）。
//
// 用法：node tools/check-phrases.ts（快档里由 `test/phrases.test.ts` 跑同一份判据）
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHRASES, PHRASE_TEXTS } from '../src/phrases.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))
/** 判据只看这两棵树。 */
const ROOTS = ['src', 'test']
/** **表自己那一处**：字面就住在这儿，扫它等于扫定义本身。 */
const HOME = 'src/phrases.ts'

export interface Scanned {
  readonly path: string
  readonly text: string
}

/** 把一棵树读成"路径 + 正文"（只收 `.ts`）。 */
export function scan(root: string, out: Scanned[] = [], base = REPO): Scanned[] {
  for (const name of readdirSync(root)) {
    if (name === 'node_modules') continue
    const p = join(root, name)
    if (statSync(p).isDirectory()) scan(p, out, base)
    else if (name.endsWith('.ts')) out.push({ path: relative(base, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') })
  }
  return out
}

/** 表外出现某一串字面的地方（`路径:行号 「那一句」`）。**空数组 = 只有一处定义**。 */
export function secondDefinitions(files: readonly Scanned[], texts: readonly string[]): string[] {
  const out: string[] = []
  for (const f of files) {
    if (f.path === HOME) continue
    const lines = f.text.split('\n')
    for (const t of texts) {
      lines.forEach((line, i) => {
        if (line.includes(t)) out.push(`${f.path}:${i + 1} 「${t}」`)
      })
    }
  }
  return out
}

/** 表里同义的两格（**换个键名不解决问题**）。 */
export function synonymsIn(entries: Readonly<Record<string, string>>): string[] {
  const seen = new Map<string, string>()
  const out: string[] = []
  for (const k of Object.keys(entries).sort()) {
    const t = entries[k] as string
    const prev = seen.get(t)
    if (prev === undefined) seen.set(t, k)
    else out.push(`${prev} 与 ${k} 写成同一串：${JSON.stringify(t)}`)
  }
  return out
}

/** 判据整个跑一遍：表外重定义 + 表内同义。 */
export function problemsIn(files: readonly Scanned[]): string[] {
  return [...secondDefinitions(files, PHRASE_TEXTS), ...synonymsIn(PHRASES)]
}

export function scanRepo(): Scanned[] {
  return ROOTS.flatMap((r) => scan(join(REPO, r)))
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('check-phrases.ts')) {
  const files = scanRepo()
  const bad = problemsIn(files)
  if (bad.length > 0) {
    for (const b of bad) console.error(`FAIL ${b}`)
    console.error('同一句文案只许有一处定义：`src/phrases.ts`')
    process.exit(1)
  }
  console.log(`ok   ${PHRASE_TEXTS.length} 句文案各一处定义（扫了 ${files.length} 个 .ts）`)
}
