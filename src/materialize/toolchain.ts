// 工具链声明与探测（P3a）：`toolchain.<名字>` 各配一条探测命令，读数缓存进工作区配置，
// P3b2 起随系统状态投影进前缀——「环境有什么」从试错里挪进一栏。
//
// **为什么缓存——硬理由是前缀稳定，不是探针贵。** 读数进 A 区之后每次现探，等于让 A 区
// 字节跟着探针输出漂，三区的缓存命中整个作废。capability.ts 那份「贵探针缓存」的理由在这条
// 面前是弱的：便宜探针因此明说不缓存（boundary/confine.ts 的 bwrap），而这里恰恰因为要进
// 前缀，再便宜也得缓存。
//
// **缓存与失效住同一格**：`reading = { probe, value }`——probe 记的是产生这份读数的那条
// 命令；声明换了命令，缓存里的 probe 对不上，自然重探。**失败写 `null` 但永不命中**（与
// overlayfs 的 null 同一条纪律，capability.ts 头注）：失败常常是暂时的，记成肯定读数就把
// 一次性的失败变成永久的谎；记 null 让前缀如实缺席、下一次照探。没声明 → 一个字节都不碰。
//
// 键不走点分寻址（名字里带 `.` 会歧义）：整棵 `toolchain` 直接对象导航；读合并、写单级
// （P2a 的防抄底，与 `saveFacts` 同一条路）。
import { ConfigError, readConfig, readWorkspaceConfig, writeConfig } from '../config.ts'
import { runArgv } from './mount.ts'

/** 一条声明（配置里那一层）：探测命令必填，`doc` 是给模型看的一句话（P3b2 投影）。 */
interface ToolchainDecl {
  readonly probe: readonly string[]
  readonly doc?: string
}

/** 一份缓存读数。`value` 是探针 stdout 的首行；`null` = 探过、没有肯定读数（失败或空输出）。 */
export interface ToolchainReading {
  readonly probe: readonly string[]
  readonly value: string | null
}

/** 读声明那一层。形状不对当场拒（载入核对的口径）：拼错的 probe 比缺席危险。 */
function declaredOf(doc: Record<string, unknown>): Map<string, ToolchainDecl> {
  const raw = doc['toolchain']
  if (raw === undefined) return new Map()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('配置里的 toolchain 要是一个对象（名字 → { probe, doc? }）')
  }
  const out = new Map<string, ToolchainDecl>()
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`工具链 ${name} 要是一个对象（probe 必填 · doc 可选）`)
    }
    const e = entry as Record<string, unknown>
    const probe = e['probe']
    if (!Array.isArray(probe) || probe.length === 0 || !probe.every((s) => typeof s === 'string')) {
      throw new ConfigError(`工具链 ${name} 的 probe 要是非空字符串数组（配置的 toolchain.${name}.probe）`)
    }
    if (e['doc'] !== undefined && typeof e['doc'] !== 'string') {
      throw new ConfigError(`工具链 ${name} 的 doc 要是一句话字符串（配置的 toolchain.${name}.doc）`)
    }
    out.set(name, e['doc'] === undefined ? { probe } : { probe, doc: e['doc'] })
  }
  return out
}

/**
 * 投影那一行（系统状态的 `toolchain` 栏，P3b2）：声明照抄，读数只在**出自当前这条 probe**
 * 时带上——probe 对不上的缓存是另一条命令的读数，带出去就是谎。`null` 照带（探过、没有肯定
 * 读数：前缀如实缺席，物化那一边的下一次起跑会重探）。名字排序：数组次序稳定序列化保不住，
 * 排序才是逐字节稳定的。键不在 → `undefined`（那一栏整个不出现）。
 */
export interface ToolchainLine {
  readonly name: string
  readonly probe: readonly string[]
  readonly doc?: string
  readonly reading?: string | null
}

/** 声明与读数 → 那一栏（纯函数，不跑探针——前缀那一步不起子进程）。 */
export function projectToolchain(doc: Record<string, unknown>): readonly ToolchainLine[] | undefined {
  if (doc['toolchain'] === undefined) return undefined
  const declared = declaredOf(doc)
  const table = doc['toolchain'] as Record<string, unknown>
  const out: ToolchainLine[] = []
  for (const name of [...declared.keys()].sort()) {
    const d = declared.get(name) as ToolchainDecl
    const entry = table[name]
    const raw = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)['reading']
      : undefined
    let reading: string | null | undefined
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>
      const p = r['probe']
      if (Array.isArray(p) && p.length === d.probe.length && p.every((s, i) => s === d.probe[i])) {
        const v = r['value']
        reading = typeof v === 'string' ? v : v === null ? null : undefined
      }
    }
    out.push({
      name,
      probe: d.probe,
      ...(d.doc === undefined ? {} : { doc: d.doc }),
      ...(reading === undefined ? {} : { reading }),
    })
  }
  return out
}

/** 缓存命中 = 读数在 · 出自同一条命令 · 且是肯定的（null 永不命中）。 */
function hit(reading: unknown, probe: readonly string[]): boolean {
  if (typeof reading !== 'object' || reading === null) return false
  const r = reading as Record<string, unknown>
  if (typeof r['value'] !== 'string') return false
  const p = r['probe']
  return Array.isArray(p) && p.length === probe.length && p.every((s, i) => s === probe[i])
}

/**
 * 跑一次——经 materialize 层那一个子进程跑手（mount.ts 的 `runArgv`：挂载与探针共用，
 * 不走 shell）。整条 `probe` 来自 `.fugue/config`：那份文件只有人写得进（写路径唯一是
 * `fugue config set`，模型没有对应的工具，config.ts 头注的 D16）——**声明者与运行者是
 * 同一个人**，这里不存在「模型拼出来的命令」。声明了一条会挂住的命令，挂住的是自己的
 * 物化起跑：与 mount 本身同款的信任，不给探针单开一层闸。
 */
function probeOnce(probe: readonly string[]): ToolchainReading {
  const r = runArgv(probe)
  if (r.status !== 0) return { probe, value: null }
  const line = r.stdout.split('\n')[0].trim()
  return { probe, value: line === '' ? null : line }
}

/**
 * 把每条声明的读数落到工作区配置。物化起跑时在 `ensureFacts` 旁调（`ensure` · `fork` 两个
 * 入口）；投影（sources-state）只读缓存、从不见探针——前缀那一步不跑子进程。全部命中时
 * 一个字节都不写：同一工作区反复起跑，配置与前缀都不漂。
 */
export async function ensureToolchain(root: string): Promise<void> {
  const doc = await readConfig(root)
  const declared = declaredOf(doc)
  const fresh: { name: string; reading: ToolchainReading }[] = []
  if (declared.size > 0) {
    const table = doc['toolchain'] as Record<string, unknown>
    for (const [name, d] of declared) {
      const entry = table[name]
      const reading = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['reading'] : undefined
      if (hit(reading, d.probe)) continue
      fresh.push({ name, reading: probeOnce(d.probe) })
    }
  }
  if (fresh.length === 0) return
  const ws = await readWorkspaceConfig(root)
  let table = ws['toolchain']
  if (typeof table !== 'object' || table === null) {
    table = {}
    ws['toolchain'] = table
  }
  for (const f of fresh) {
    const entries = table as Record<string, unknown>
    let entry = entries[f.name]
    if (typeof entry !== 'object' || entry === null) {
      entry = {}
      entries[f.name] = entry
    }
    ;(entry as Record<string, unknown>)['reading'] = { probe: [...f.reading.probe], value: f.reading.value }
  }
  await writeConfig(root, ws)
}
