// Developer documentation coverage, not a configuration schema or runtime validator.
import { TOP_LEVEL_KEYS } from '../src/config.ts'
import { ENV_KEY, PORTS_KEY } from '../src/boundary/binding.ts'
import { ENFORCEMENT_KEY } from '../src/boundary/policy.ts'
import { REACH_KEY } from '../src/boundary/reach.ts'
import { FLAGS_OF } from '../src/cli/flags.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Repository source discovery is deterministic and does not follow symlinks or scan tests. */
export function sourceConfigKeys(root: string): string[] {
  const sources: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name) && !/\.test\.(?:ts|js|mjs)$/.test(entry.name)) sources.push(readFileSync(path, 'utf8'))
    }
  }
  visit(join(root, 'src'))
  return literalConfigKeys(sources)
}

/** The CLI delegates its file-based config coverage to this same entry, including newly added source files. */
export function configDocsProblems(root: string): string[] {
  return checkConfigKeyDocs(readFileSync(join(root, 'docs/configuration.md'), 'utf8'), sourceConfigKeys(root))
}

/** Known literal getConfig calls only; dynamic provider/action/document names are documented as families. */
export function literalConfigKeys(sources: readonly string[]): string[] {
  const keys = new Set([ENV_KEY, PORTS_KEY, ENFORCEMENT_KEY, REACH_KEY])
  for (const source of sources) {
    for (const match of source.matchAll(/\bgetConfig\([^\n]*?,\s*(['"])([a-zA-Z][\w.-]*)\1\s*\)/g)) keys.add(match[2]!)
  }
  return [...keys].sort()
}

export function checkConfigKeyDocs(doc: string, consumed: readonly string[]): string[] {
  const problems: string[] = []
  const domains = [...doc.matchAll(/^\| `([a-z]+)` \|/gm)].map(match => match[1]!)
  const seen = new Set<string>()
  for (const domain of domains) {
    if (seen.has(domain)) problems.push(`配置域文档重名：${domain}`)
    else if (!TOP_LEVEL_KEYS.includes(domain)) problems.push(`配置域文档不在当前顶层键域：${domain}`)
    seen.add(domain)
  }
  for (const domain of TOP_LEVEL_KEYS) if (!seen.has(domain)) problems.push(`配置域缺文档：${domain}`)
  const code = new Set([...doc.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!))
  for (const key of consumed) if (!code.has(key)) problems.push(`实际配置读取键缺文档：${key}`)
  return problems
}

/** Compare independent help rows to the accepted flag table; no command-count literal. */
export function checkCliHelp(usage: string): string[] {
  const listed = new Set<string>()
  for (const match of usage.matchAll(/^ {2}([a-z][\w-]*)(?: ([a-z]+))?\b/gm)) {
    const combined = `${match[1]} ${match[2]}`
    listed.add(match[2] !== undefined && Object.hasOwn(FLAGS_OF, combined) ? combined : match[1]!)
  }
  return [
    ...Object.keys(FLAGS_OF).filter(name => !listed.has(name)).map(name => `命令帮助漏旗标表入口：${name}`),
    ...[...listed].filter(name => !Object.hasOwn(FLAGS_OF, name)).map(name => `命令帮助列出未知入口：${name}`),
  ]
}
