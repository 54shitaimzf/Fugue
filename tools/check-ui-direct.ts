// **界面读账只经事件通道**——这条性质的静态断言。出处：路线图 § 5 的 0.4.3 行（「客户端化之后
// TUI 零直连……那条 lint 式断言的覆盖面要含人说的话那一条读源」）· 架构 § 9.7（观察不得影响状态）
// · § 9.11（事件通道：一趟调用回一趟事）。
//
// 两条判据，都按 **import 闭包**走（闭包空着就什么也判不出来，所以下面另有一条"真有东西"的对照）：
//
//   一 · **账的直连模块一份都不许进来**。那些模块是开账本口、顺着账本口扫的那两条：
//        `log/log.ts` 与 `probe/watch.ts`。界面这一侧的读源只有 `serve/source.ts`
//        （事件通道那一趟），账本由 serve 那一头按请求开、按请求关。
//   二 · **不许碰宿主私有的那两个前缀**：`.fugue/log`（账本）与 `.fugue/session`（人说的话
//        那一条遗留直读）。第二样恰好有一处点名——见 `LEGACY_READERS`。
//
// 用法：node tools/check-ui-direct.ts（快档里由 `src/ui/direct.test.ts` 跑同一份判据）
//
// **界面那一侧的定义**：`src/ui/` 下每一个非测试模块，加它们的闭包。`ui/console.ts` 是
// `fugue tui` 的接线（0.4.3 从 `cli/cmd/observe.ts` 搬出来）——那个文件里另外三条命令
// （`log` · `status` · `watch`）开账本口是对的，所以它不当这个断言的一个根。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** 界面那一侧住哪儿。 */
const UI_DIR = 'src/ui'

/** **账的直连模块**：开账本口、或者顺着账本口扫的那两条。界面这一侧的闭包里一份都不许有。 */
export const LEDGER_DIRECT: readonly { readonly path: string; readonly why: string }[] = [
  { path: 'src/log/log.ts', why: '开账本口（readMerged · readByWriter · append）' },
  { path: 'src/probe/watch.ts', why: '顺着账本口扫（readNew · follow）' },
]

/**
 * **不许碰的宿主私有前缀**：账本与人说的话。两样都不是视图里的东西——界面要什么，从事件通道走。
 */
export const PRIVATE_PREFIXES: readonly { readonly prefix: string; readonly what: string }[] = [
  { prefix: '.fugue/log', what: '账本本身' },
  { prefix: '.fugue/session', what: '人说的话那一条读源（视图里的保留前缀）' },
]

/**
 * **唯一点名的遗留直读**：`.fugue/session` 那一条。
 *
 * 架构 § 9.10 把 `session` 列进视图的四个保留前缀；路线图 § 5 的 **0.5.0** 那一行说它
 * **进 serve 的读口**，随那一站落——「那条读源进 serve 的读口随 0.5.0，本站不另开一条直连」。
 * 0.4.3 因此不新开它：这张表今天**空着**，判据已经是"一处都不许"。
 * **等 0.5.0 把它收进读口，这张表就是那个删点名的位置**——那时这一份一个字都不用改，
 * 加严照样成立；反过来，谁要新开一条直连，就得在这里点名，点名是一次看得见的改动。
 */
export const LEGACY_READERS: readonly string[] = []

export interface Mod {
  readonly path: string
  readonly text: string
}

/** 一条 `import`：目标说明符与"是不是只借类型"（`import type` 那一档运行时不留痕）。 */
export interface Spec {
  readonly spec: string
  readonly typeOnly: boolean
}

/**
 * 一个模块里的相对 `import`。**只认静态的 `from '…'`**——动态 `import()` 与 `require` 在这一份
 * 代码里一处都没有（`src/` 全扫过），真出现了也走不通那条路：这一份是 lint，不是打包器。
 */
export function importsOf(text: string): readonly Spec[] {
  const out: Spec[] = []
  const re = /(^|\n)import\s+(type\s+)?([^'\n]*?)from\s+'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push({ spec: m[4] as string, typeOnly: m[2] !== undefined })
  return out
}

/** 相对说明符 → 仓内路径（补 `.ts`）；不是相对的（`node:` 那类）给回 `null`。 */
export function resolveSpec(fromPath: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const p = relative(REPO, resolve(REPO, dirname(fromPath), spec)).replace(/\\/g, '/')
  return p.endsWith('.ts') ? p : `${p}.ts`
}

/**
 * 从 `entries` 出发的 import 闭包（含 entries 自己）。
 *
 * **只走值导入**：`import type` 那一档运行时不留痕（`.ts` 直跑是 strip-only，类型那几行被削掉），
 * 所以它不是一条真实的依赖边——`probe/status.ts` 就只借了 `log/log.ts` 的一个类型，那条边不算。
 * 把类型边也算进来，"闭包里出现了谁"就与"运行时真加载了谁"对不上，断言会红得没有道理。
 */
export function closureOf(mods: readonly Mod[], entries: readonly string[]): string[] {
  const byPath = new Map(mods.map((m) => [m.path, m.text]))
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const p = queue.pop() as string
    if (seen.has(p)) continue
    const text = byPath.get(p)
    if (text === undefined) continue
    seen.add(p)
    for (const s of importsOf(text)) {
      if (s.typeOnly) continue
      const to = resolveSpec(p, s.spec)
      if (to !== null && byPath.has(to) && !seen.has(to)) queue.push(to)
    }
  }
  return [...seen].sort()
}

/** 判据整个跑一遍。**`entries` 与两张表都能注进来**——负对照靠它演示红。 */
export function problemsIn(
  mods: readonly Mod[],
  entries: readonly string[],
  o: {
    readonly ledgerDirect?: readonly { readonly path: string; readonly why: string }[]
    readonly privatePrefixes?: readonly { readonly prefix: string; readonly what: string }[]
    readonly legacyReaders?: readonly string[]
  } = {},
): string[] {
  const direct = o.ledgerDirect ?? LEDGER_DIRECT
  const prefixes = o.privatePrefixes ?? PRIVATE_PREFIXES
  const legacy = o.legacyReaders ?? LEGACY_READERS
  const closure = closureOf(mods, entries)
  const byPath = new Map(mods.map((m) => [m.path, m.text]))
  const out: string[] = []
  for (const d of direct) {
    if (closure.includes(d.path)) out.push(`直连模块进了界面的 import 闭包：${d.path}（${d.why}）`)
  }
  for (const p of closure) {
    if (legacy.includes(p)) continue
    const text = byPath.get(p) as string
    for (const { prefix, what } of prefixes) {
      if (text.includes(`'${prefix}`) || text.includes(`"${prefix}`) || text.includes(`\`${prefix}`)) {
        out.push(`${p} 里出现了宿主私有的读：${prefix}（${what}）`)
      }
    }
  }
  return out
}

/** 仓里界面的那几份：`src/ui/` 下每一个非测试模块。 */
export function uiModules(mods: readonly Mod[]): string[] {
  return mods
    .filter((m) => m.path.startsWith(`${UI_DIR}/`) && !m.path.endsWith('.test.ts'))
    .map((m) => m.path)
    .sort()
}

function walk(dir: string): readonly Mod[] {
  const out: Mod[] = []
  for (const name of readdirSync(join(REPO, dir))) {
    const p = join(REPO, dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(join(dir, name)))
    else if (name.endsWith('.ts')) out.push({ path: join(dir, name).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') })
  }
  return out
}

/** `src/` 全树（判据要在整幅图上找闭包——跨目录的相对导入得解析得动）。 */
export function readRepo(): readonly Mod[] {
  return walk('src')
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('check-ui-direct.ts')) {
  const mods = readRepo()
  const entries = uiModules(mods)
  const closure = closureOf(mods, entries)
  const bad = problemsIn(mods, entries)
  if (bad.length > 0) {
    for (const b of bad) console.error(`FAIL ${b}`)
    console.error('界面读账只经事件通道：`serve/source.ts` 那一趟（架构 § 9.11）')
    process.exit(1)
  }
  console.log(
    `ok   界面 ${entries.length} 个根 · import 闭包 ${closure.length} 份 · 账的直连模块 0 份 · ` +
      `宿主私有前缀 0 处（点名放行 ${LEGACY_READERS.length} 处）`,
  )
}
