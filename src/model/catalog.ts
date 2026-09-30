// 模型目录：**一份数据，两个来处**（PLAN § 5.20 的 P2d · 架构 § 15.3.a 的 models.json 段）。
//
// **接一个模型从此是一个数据改动。** `~/.fugue/models.json` 在 → 它就是**整份目录**，不与内置
// 合并——合并出来的那份"半内置半文件"没有一处说得清自己；不在 → 内置档（`contract.ts` 的
// `PROVIDERS` · `MODEL_DECLS` 与 `price.ts` 的 `PRICE_BOOK`）原样顶上。目录因此与配置同一个
// 家（系统根，`FUGUE_SYSTEM_DIR` 可换）：它说的是"这台机器用哪几个模型"，是机器的那一半。
//
// **schema 一张表**（顶层 = 提供方映射直接铺，提供方内嵌模型与价目）：
//
//   { "<providerId>": { "host": "…",
//       "wireOverrides": { "<wire>": "/path" },        ← P2e 消费（形状在 d 冻结）
//       "retries": { "count": 2, "on": [429, 503], "timeout": true },   ← P2f 消费
//       "models": { "<id>": { "wire": …, "model": …, "protocol": …, "systemPromptUpdate": …,
//                             "contextLimit": …, "budget": { "handoffMargin": …, "trigger": 可省 },
//                             "call": { "thinking": …, "maxTokens": … } } },
//       "prices": [ { "model": …, "aliases": […], "peak": {…}, "offPeak": {…} } ] } }
//
//   · 模型的 `provider` 不写在模型上——它由所在那一层带出来（嵌套即声明）。
//   · `budget.trigger` 可省：缺省由 `triggerAt(contextLimit)` 算——人不该手抄派生数。
//   · **明确不加的**：版本字段（改坏了对不上就该拒，不是静默迁移）· 迁移逻辑 · auth 槽
//     （凭据只住配置的 `credentials.<id>` 键，P2c 定下的界）· 提供方键重名检测——`JSON.parse`
//     对同一对象里的重复键静默去重，为它换一个解析器不值得（口径：跨提供方的重名倒是检得了，
//     拍平那一趟就撞上）。
//
// **载入核对只做这几条**（把"静默失效"那一类挡在载入时，其余不设卡）：线协议 ∈ `WIRE_NAMES` ·
// 每个模型的名字在价目里命中（`priceOf` 口径）· 协议名与更新方式真的存在（自 `contract.ts`
// 平移，内置档照旧载入时核一遍）。**目录是人的文件，不是不可信输入**——逐字段形状卡一遍
// 防不了写错地方的人，倒把"哪一条拒了"埋进一堆形状报错里。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultSystemDir } from '../config.ts'
import { protocolNames } from '../assemble/protocol.ts'
import { MODEL_DECLS, PROVIDERS, ModelDeclError, WIRE_NAMES, prefixDeclOf, triggerAt } from './contract.ts'
import type { ModelDecl, ModelId, PrefixModelDecl, ProviderDecl, WireName } from './contract.ts'
import { PRICE_BOOK, priceOf } from './price.ts'
import type { PriceRow } from './price.ts'

/** 一份模型目录：提供方 · 模型（键是我们这边的 id）· 价目。**查表全收它**，别处不再各持一张。 */
export interface Catalog {
  readonly providers: Readonly<Record<string, ProviderDecl>>
  readonly models: Readonly<Record<string, ModelDecl>>
  readonly prices: readonly PriceRow[]
}

/** 内置档：`models.json` 不在时顶上的那一份（与 `contract.ts` / `price.ts` 的常量同源）。 */
export const BUILTIN_CATALOG: Catalog = { providers: PROVIDERS, models: MODEL_DECLS, prices: PRICE_BOOK }

/** 文件里一个提供方那一层。模型那层少 `id`（键就是）与 `provider`（嵌套就是）。 */
interface ProviderEntry {
  readonly host: string
  readonly wireOverrides?: Readonly<Partial<Record<WireName, string>>>
  readonly retries?: ProviderDecl['retries']
  readonly models?: Readonly<Record<string, ModelEntry>>
  readonly prices?: readonly PriceRow[]
}
interface ModelEntry {
  readonly protocol: string
  readonly wire: string
  readonly model: string
  readonly systemPromptUpdate: string
  readonly contextLimit: number
  /** `trigger` 可省（由 `triggerAt` 算）；`handoffMargin` 没有缺省，缺了就在载入那一行响。 */
  readonly budget: { readonly handoffMargin: number; readonly trigger?: number }
  readonly call?: ModelDecl['call']
}

/**
 * 一份目录的载入核对（内置档在模块载入时也走这一遍）。
 *
 * 每一条封的都是**静默失效**：写错线协议名，请求发到别的路上；价目缺一行，钱那一栏悄悄变成
 * "算不出来"；协议名写错，装配出来的前缀是别人的那一份。报的话一条一行，全报完再拒——只报
 * 第一条的话，改一处还有一处。
 */
export function validateCatalog(cat: Catalog): void {
  const bad: string[] = []
  for (const [name, m] of Object.entries(cat.models)) {
    if (!WIRE_NAMES.includes(m.wire)) bad.push(`${name} 的线协议没有这一条：${m.wire}（有的是 ${WIRE_NAMES.join(' · ')}）`)
    if (cat.providers[m.provider] === undefined) bad.push(`${name} 指的提供方没有声明：${m.provider}`)
    if (!protocolNames().includes(m.protocol)) {
      bad.push(`${name} 指的协议没有这一份：${m.protocol}（有的是 ${protocolNames().join(' · ')}）`)
    }
    if (m.systemPromptUpdate !== 'in-history' && m.systemPromptUpdate !== 'rewrite-head') {
      bad.push(`${name} 的系统提示词更新方式没有这一档：${String(m.systemPromptUpdate)}`)
    }
    if (priceOf(m.id, cat) === null) bad.push(`${name} 的价目缺一行：发出去的名字 ${m.model} 在价目表里查不到`)
  }
  if (bad.length > 0) {
    throw new ModelDeclError(`目录核对不过（${Object.keys(cat.models).length} 条模型 · ${Object.keys(cat.providers).length} 家提供方）：\n  ${bad.join('\n  ')}`)
  }
}
validateCatalog(BUILTIN_CATALOG)

/**
 * 读一份目录。**不在 → 内置档顶上（同一个对象，不是合出来的另一份）**；在了它就是整份目录。
 *
 * 与配置同一条纪律：**读不动或解析不了就拒，不当成"没有"**——把一份坏目录读成内置档，等于
 * 让这台机器静默地跑在另一个模型上，而三区哈希与价目全都对不上人以为的那一份。
 */
export function readCatalog(systemDir: string = defaultSystemDir()): Catalog {
  const file = join(systemDir, 'models.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return BUILTIN_CATALOG
    throw new ModelDeclError(`目录读不出来：${file} —— ${(err as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ModelDeclError(`目录不是一份完整的 JSON：${file} —— ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ModelDeclError(`目录的顶层要是一个对象（提供方映射）：${file}`)
  }
  const providers: Record<string, ProviderDecl> = {}
  const models: Record<string, ModelDecl> = {}
  const prices: PriceRow[] = []
  for (const [pid, entry] of Object.entries(raw as Record<string, unknown>)) {
    const p = entry as ProviderEntry
    providers[pid] = {
      id: pid,
      host: p.host,
      ...(p.wireOverrides === undefined ? {} : { wireOverrides: p.wireOverrides }),
      ...(p.retries === undefined ? {} : { retries: p.retries }),
    }
    for (const [mid, m] of Object.entries(p.models ?? {})) {
      const e = m as ModelEntry
      if (models[mid] !== undefined) {
        throw new ModelDeclError(`模型 ${mid} 在两个提供方底下各出现了一次（${models[mid].provider} 与 ${pid}）——两处的 host 与价目会静默分家`)
      }
      models[mid] = {
        id: mid as ModelId,
        protocol: e.protocol,
        provider: pid,
        wire: e.wire as WireName,
        model: e.model,
        systemPromptUpdate: e.systemPromptUpdate as ModelDecl['systemPromptUpdate'],
        contextLimit: e.contextLimit,
        budget: {
          trigger: e.budget.trigger ?? triggerAt(e.contextLimit),
          handoffMargin: e.budget.handoffMargin,
        },
        call: e.call ?? {},
      }
    }
    if (Array.isArray(p.prices)) prices.push(...p.prices)
  }
  const cat: Catalog = { providers, models, prices }
  validateCatalog(cat)
  return cat
}

/** 缺省模型 = 目录的第一条（按文件的次序）。**不是一条写在别处的常量（写两处就会漂）。 */
export function defaultModelOf(cat: Catalog): ModelDecl {
  const first = Object.values(cat.models)[0]
  if (first === undefined) throw new ModelDeclError('目录里一条模型都没有——models.json 的 models 是空的')
  return first
}

/**
 * 按名字取一个声明。**查不到就拒，不替它挑一个**——"没写 model"与"写了一个没有的 model"是
 * 两件事：前者走缺省，后者是打错了一个字，静默替他选一个会让命令行那次装配的读数指着另一个
 * 模型。与 `--agent` 拒未知名字是同一条口径（PLAN § 5.6 的 Z4）。
 */
export function modelDeclOf(id: string | undefined, cat: Catalog): ModelDecl {
  if (id === undefined || id === '') return defaultModelOf(cat)
  const m = cat.models[id]
  if (m === undefined) {
    throw new ModelDeclError(`没有这个模型：${id}（目录里只有 ${Object.keys(cat.models).join(' · ')}）`)
  }
  return m
}

/** 按名字取一个提供方。同上：查不到就拒。 */
export function providerOf(id: string, cat: Catalog): ProviderDecl {
  const p = cat.providers[id]
  if (p === undefined) {
    throw new ModelDeclError(`没有这个提供方：${id}（目录里只有 ${Object.keys(cat.providers).join(' · ')}）`)
  }
  return p
}

/** 前缀那一侧的表：按目录现折的投影（`prefixDeclOf`），不是第二张表。 */
export function prefixModelsOf(cat: Catalog): Readonly<Record<string, PrefixModelDecl>> {
  return Object.fromEntries(Object.entries(cat.models).map(([name, m]) => [name, prefixDeclOf(m)]))
}

/** 一个名字是不是目录里那个。**判据是目录，不是形状**（形状对了但没声明过的名字仍然拒）。 */
export function isModelRef(id: string, cat: Catalog): boolean {
  return cat.models[id] !== undefined
}
