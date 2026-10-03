// Pure development-only capability checks shared by the full CLI net and focused tests.
import { CAPABILITY_TABLE } from '../src/capability/table.ts'
import type { CapabilityRow, Layer } from '../src/capability/table.ts'
import { TOOL_ENTRIES } from '../src/tools/catalog.ts'
import type { ToolEntry } from '../src/tools/catalog.ts'

/** 层的允许域来自架构 § 8.9；名字域从实际目录读，不再抄一份工具名。 */
const LAYERS: readonly Layer[] = ['view', 'execute', 'truth', 'log']

export function checkCapabilityInvariants(
  entries: readonly ToolEntry[] = TOOL_ENTRIES,
  table: Readonly<Record<string, CapabilityRow>> = CAPABILITY_TABLE,
): string[] {
  const bad: string[] = []
  const names = new Set<string>()
  for (const entry of entries) {
    if (names.has(entry.name)) bad.push(`工具目录重名：${entry.name}`)
    names.add(entry.name)
    if (!Object.hasOwn(table, entry.name)) bad.push(`目录里有这个工具，能力表里没有它：${entry.name}`)
  }
  const capabilities = new Map<string, string>()
  for (const [name, row] of Object.entries(table)) {
    if (!names.has(name)) bad.push(`能力表里有这个工具，目录里没有它：${name}`)
    if (!LAYERS.includes(row.layer)) bad.push(`能力表里的层未声明：${name} → ${row.layer}`)
    const prior = capabilities.get(row.capability)
    if (prior !== undefined) bad.push(`能力标识重名：${row.capability}（${prior} · ${name}）`)
    else capabilities.set(row.capability, name)
    if (row.capability !== name) bad.push(`能力标识不是这一格的工具名：${name} → ${row.capability}`)
    if (typeof row.decl !== 'boolean') bad.push(`声明集标记不是布尔值：${name}`)
    else if (row.decl && row.layer !== 'execute') bad.push(`只有执行层能有声明集：${name}`)
  }
  return bad
}

