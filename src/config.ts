// 配置：工作区级 `<realRoot>/.fugue/config` 叠系统级 `~/.fugue/config`（架构 § 9.2 · § 15.3.a）。
//
// **它是人写的一份文件，在真实工作树里，但不在视图里。** 模型的工具只认视图内的相对路径，
// 所以"模型是被配置者，不是配置者"在这里由**位置**保证，不是一条禁令（D16 · § 24 纪律 13）。
// 反过来：这个文件只有一条写路径——`fugue config set`，而它是 § 9.6 那张表里唯一一条模型
// 没有对应工具的写操作。因此这份文件**不需要逐条论证"不许谁写"**。
//
// **两级，写单级、读合并。** 系统级给这台机器的默认，工作区级覆盖它；叠放次序 CLI > 工作区 >
// 系统 > 内置。合并是**深合并**：对象递归合并，数组与标量整份覆盖。**写永远落在目标那一级**
// （`config set` 写工作区、`config set --system` 写系统），合并只发生在读——所以系统级的键
// 不会被一次工作区写抄底固化进工作区文件（写方走 `readWorkspaceConfig` 单级读，为的就是这个）。
//
// **顶层键域是闭的**（`TOP_LEVEL_KEYS`）：配置是边界的来源，一个拼错的顶层键会被静默读成
// "没配"，那比报错危险——所以未知顶层键**拒绝并指路**，两级各自核。新的顶层键先进这张表
// 再进代码（P3a 的 `toolchain` 就是这么进的）。
//
// **格式是整份 JSON，不是逐行键值。** 配置的内容天然是两三层（动作绑定带 `outputs`、
// 文档定义是一串 `{path, prompt}`），写成 JSON 就不必再造一套嵌套语法，也不必写第二份
// 序列化器。命令行这一面用点分键寻址（`docs.trace.path`），代价是键里带 `.` 的写法不可
// 寻址——这是这个格式唯一的代价，换掉的是一整层语法。
//
// **解析不了就拒绝加载，不当成空配置。** 与日志中段损坏是同一条纪律（§ 9.3）：把一份坏
// 文件读成"什么都没配"，等于让系统静默地跑在一套与写下时不同的规则上——而配置是边界的
// 来源。**文件不在与文件是空的都是 `{}`**：那是"还没配过"，与"配坏了"分得开。
//
// 配置不是工作区的状态，是它的**输入**（§ 15.3.a 末段）。所以这个模块既不认识视图，也不
// 认识 git：`fugue config` 那三条命令在一个还没有对象库的目录里照常可用，也因此它们不经过
// 重放——**配置改动改变不了重放结果**，重放结果只由日志决定（PLAN § 5 的 U5 断言一）。
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 一份配置文档。值就是 JSON 的那几种，没有别的类型要照顾。 */
export interface ConfigDoc {
  [key: string]: unknown
}

/** 这一层自己的失败：坏文件 · 坏键 · 写不进去。 */
export class ConfigError extends Error {}

/** 顶层键域（§ 15.3.a）：这份配置认得的所有顶层键。新的顶层键先进这张表，再进代码。
 * `workspace` 是 Z6 装配的 A 区系统状态那一栏之一（sources-state 的 projectConfig）——计划 § 5.20
 * 冻结清单漏了它，全量一跑被这张表拒出来（这正是这张表要抓的那类事），据实补进。
 * `credentials` 是凭据的引用表（P2c）：值是引用不是凭据，取值只在真出网那一步。
 * `toolchain` 是工具链的声明与探测读数（P3a）：声明两级可配，读数只写工作区级（materialize/toolchain.ts）。
 * `ui` 是界面那一节（清障批 ⑧）：现在只有 `ui.keys` 一格——按键表的动作覆盖。形状在这份文件
 * 里核；动作名与键名认不认得，由写那面（`config set` 过 `keymapOf`）与 TUI 读那面（`keymapOf`
 * 逐格照缺省走并印出为什么）各自把关——语义不进这份文件。 */
export const TOP_LEVEL_KEYS: readonly string[] = [
  'actions',
  'ports',
  'boundary',
  'platform',
  'round',
  'config',
  'docs',
  'workspace',
  'credentials',
  'toolchain',
  'ui',
]

export function configFileOf(root: string): string {
  return join(root, '.fugue', 'config')
}

/**
 * 系统根：机器级那一层（`~/.fugue`）。测试用 `FUGUE_SYSTEM_DIR` 指到临时目录换掉它——
 * 不然测试读数取决于这台机器上有没有人配过系统级。
 */
export function defaultSystemDir(): string {
  const v = process.env.FUGUE_SYSTEM_DIR
  if (v !== undefined && v !== '') return v
  return join(homedir(), '.fugue')
}

export function systemConfigFileOf(systemDir: string): string {
  return join(systemDir, 'config')
}

/** 点分键 → 段。空段不是"没找到"，是写错了——所以它是错误，不是缺省。 */
export function keySegments(key: string): string[] {
  const segs = key.split('.')
  if (segs.some((s) => s === '')) throw new ConfigError(`点分键里有空段：${JSON.stringify(key)}`)
  return segs
}

function isPlainObject(v: unknown): v is ConfigDoc {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 深合并（两级配置的叠放语义）：两边都是对象就递归合并，否则**右边那份整份赢**——数组与
 * 标量没有"合并"这个动作，一半来自系统一半来自工作区的数组比拼错的键更难查。
 * 不改任何一边的入参。
 */
function deepMerge(system: ConfigDoc, workspace: ConfigDoc): ConfigDoc {
  const out: ConfigDoc = { ...system }
  for (const [k, v] of Object.entries(workspace)) {
    const prev = out[k]
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v
  }
  return out
}

/** 顶层键域核对：拼错的顶层键拒绝加载，指给这张表（两级读时各自核自己那一份）。 */
function assertTopLevel(doc: ConfigDoc, file: string): void {
  for (const k of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.includes(k)) {
      throw new ConfigError(
        `配置里有不认识的顶层键 ${JSON.stringify(k)}：${file} —— 顶层只认 ` +
          `${TOP_LEVEL_KEYS.join(' · ')}；要加新的顶层键，先把键域定下来（架构 § 15.3.a）`,
      )
    }
  }
}

/** `ui` 那一节的形状：`ui.keys` 若在，必须是「动作 → 键串」的对象。只挡"根本不是键位表"的
 * 坏形状（与"没配过"分开）；动作名与键名认不认得是两级语义，各自在写那面与 TUI 读那面把关。 */
function assertUiShape(doc: ConfigDoc, file: string): void {
  const ui = doc.ui
  if (ui === undefined) return
  if (!isPlainObject(ui)) throw new ConfigError(`配置里的 ui 要是一个对象：${file}`)
  const keys = ui.keys
  if (keys === undefined) return
  if (!isPlainObject(keys)) {
    throw new ConfigError(`配置里的 ui.keys 要是一个「动作 → 键串」的对象：${file}`)
  }
  for (const [action, key] of Object.entries(keys)) {
    if (typeof key !== 'string') {
      throw new ConfigError(`配置里的 ui.keys.${action} 的值要是键串：${file} —— 收到 ${JSON.stringify(key)}`)
    }
  }
}

/**
 * 读一份配置文件。**不在 = `{}`**（还没配过是常态）；**读不动或解析不了 = 拒绝**。
 * 这两种情形必须分开：混起来就是把损坏静默成"什么都没配"。
 */
async function readConfigFile(file: string): Promise<ConfigDoc> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConfigError(`配置读不出来：${file} —— ${(err as Error).message}`)
  }
  if (text.trim() === '') return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ConfigError(`配置不是一份完整的 JSON：${file} —— ${(err as Error).message}`)
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError(`配置的顶层要是一个对象：${file}`)
  }
  assertTopLevel(raw, file)
  assertUiShape(raw, file)
  return raw
}

/** 工作区那一级，单级读——**写方专用**（`config set` 与 `saveFacts`）：合并读会把系统级的键
 * 抄底固化进工作区文件，写方因此只看自己这一级。读消费方一律走 `readConfig`（合并）。 */
export async function readWorkspaceConfig(root: string): Promise<ConfigDoc> {
  return readConfigFile(configFileOf(root))
}

/** 系统那一级，单级读（`config set --system` 的写方用）。 */
export async function readSystemConfig(systemDir: string): Promise<ConfigDoc> {
  return readConfigFile(systemConfigFileOf(systemDir))
}

/**
 * 合并读：系统级打底、工作区级覆盖（缺省系统根是 `~/.fugue`，`FUGUE_SYSTEM_DIR` 可换）。
 * 全部读消费方走这里——消费面不认识"级"这件事，它们只看见一份合好的配置。
 */
export async function readConfig(root: string, systemDir = defaultSystemDir()): Promise<ConfigDoc> {
  return deepMerge(await readSystemConfig(systemDir), await readWorkspaceConfig(root))
}

/**
 * 取一条。`undefined` = 这条键没有——它不可能是"存了个 `undefined`"，JSON 里没有这个值；
 * 存下的 `null` 读出来是 `null`，两者分得开。
 */
export function getConfig(doc: ConfigDoc, key: string): unknown {
  let cur: unknown = doc
  for (const seg of keySegments(key)) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * 改一条，原地改。缺的中间层建出来；**中途撞上非对象就报错，不覆盖**——`a` 现在是个字符串
 * 而去写 `a.b`，说明写的人以为那儿有一层，把字符串换成对象是替人做决定。
 */
export function setConfig(doc: ConfigDoc, key: string, value: unknown): void {
  const segs = keySegments(key)
  let cur: ConfigDoc = doc
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg]
    if (next === undefined) {
      const fresh: ConfigDoc = {}
      cur[seg] = fresh
      cur = fresh
      continue
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new ConfigError(`配置里的 ${seg} 不是一个对象，不能再往里写：${key}`)
    }
    cur = next as ConfigDoc
  }
  cur[segs[segs.length - 1]] = value
}

/** 一个命令行参数的读法：整份解析得了就当 JSON 值，否则当字符串。`5` 是数，`hello` 是字。 */
export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * 原子地写一份配置（先写临时名再改名，读者看到的要么是旧份要么是新份）。
 *
 * **失败要响**——这里与快照正好相反：快照没有独有数据，写不成就是这次没加速，没人可报；
 * 配置是边界的来源，写不成而报成功，下一条命令就会跑在旧规则上。失败也不留临时文件：
 * 留下的那一个会被范围断言抓到，但那时已经离现场很远了。
 */
async function writeDocAt(file: string, doc: ConfigDoc): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n')
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw new ConfigError(`配置写不进去：${file} —— ${(err as Error).message}`)
  }
}

/** 写工作区那一级。根不存在就拒绝——不替人建一个工作区。 */
export async function writeConfig(root: string, doc: ConfigDoc): Promise<void> {
  try {
    await stat(root)
  } catch (err) {
    throw new ConfigError(`工作区根不存在：${root} —— ${(err as Error).message}`)
  }
  await writeDocAt(configFileOf(root), doc)
}

/** 写系统那一级（系统根不在就建出来——`~/.fugue` 由第一条系统级写带出来，与工作区不同：
 * 工作区根是人的决定，系统根是这份配置自己的家）。 */
export async function writeSystemConfig(systemDir: string, doc: ConfigDoc): Promise<void> {
  await writeDocAt(systemConfigFileOf(systemDir), doc)
}

/** 原值记录那两处的落点：与目标级 config 同目录（§ 15.3.a 的"每次改动记原值"）。 */
export function configHistoryOf(root: string): string {
  return join(root, '.fugue', 'config-history')
}

export function systemConfigHistoryOf(systemDir: string): string {
  return join(systemDir, 'config-history')
}

export interface ConfigChange {
  readonly key: string
  /** 改之前那份。`undefined` = 这条键原本不存在——那一栏就不出现（null 会与"存了个 null"混起来）。 */
  readonly old?: unknown
  readonly new: unknown
}

/** 一次改动一行 JSONL。追加写：历史只增不改，坏一行不拦后面的（与日志同一条纪律）。 */
export async function appendHistory(file: string, ch: ConfigChange): Promise<void> {
  const line: Record<string, unknown> = { at: new Date().toISOString(), key: ch.key, new: ch.new }
  if (ch.old !== undefined) line.old = ch.old
  try {
    await appendFile(file, JSON.stringify(line) + '\n', 'utf8')
  } catch (err) {
    throw new ConfigError(`原值记录写不进去：${file} —— ${(err as Error).message}`)
  }
}
