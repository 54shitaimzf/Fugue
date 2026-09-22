// 工作区配置：`<realRoot>/.fugue/config`（架构 § 9.2 的布局 · § 15.3.a 的两级配置）。
//
// **它是人写的一份文件，在真实工作树里，但不在视图里。** 模型的工具只认视图内的相对路径，
// 所以"模型是被配置者，不是配置者"在这里由**位置**保证，不是一条禁令（D16 · § 24 纪律 13）。
// 反过来：这个文件只有一条写路径——`fugue config set`，而它是 § 9.6 那张表里唯一一条模型
// 没有对应工具的写操作。因此这份文件**不需要逐条论证"不许谁写"**。
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
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 一份配置文档。值就是 JSON 的那几种，没有别的类型要照顾。 */
export interface ConfigDoc {
  [key: string]: unknown
}

/** 这一层自己的失败：坏文件 · 坏键 · 写不进去。 */
export class ConfigError extends Error {}

export function configFileOf(root: string): string {
  return join(root, '.fugue', 'config')
}

/** 点分键 → 段。空段不是"没找到"，是写错了——所以它是错误，不是缺省。 */
export function keySegments(key: string): string[] {
  const segs = key.split('.')
  if (segs.some((s) => s === '')) throw new ConfigError(`点分键里有空段：${JSON.stringify(key)}`)
  return segs
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 读一份配置。**不在 = `{}`**（还没配过是常态）；**读不动或解析不了 = 拒绝**。
 * 这两种情形必须分开：混起来就是把损坏静默成"什么都没配"。
 */
export async function readConfig(root: string): Promise<ConfigDoc> {
  const file = configFileOf(root)
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
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`配置的顶层要是一个对象：${file}`)
  }
  return raw as ConfigDoc
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
 * 原子地写回去（先写临时名再改名，读者看到的要么是旧份要么是新份）。
 *
 * **失败要响**——这里与快照正好相反：快照没有独有数据，写不成就是这次没加速，没人可报；
 * 配置是边界的来源，写不成而报成功，下一条命令就会跑在旧规则上。失败也不留临时文件：
 * 留下的那一个会被范围断言抓到，但那时已经离现场很远了。
 */
export async function writeConfig(root: string, doc: ConfigDoc): Promise<void> {
  const file = configFileOf(root)
  if (!(await isDir(root))) throw new ConfigError(`工作区根不存在：${root}`)
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
