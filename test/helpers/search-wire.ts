// 为额外的合成兼容测试生成临时输入；历史真录制始终不改。
// 不是 live 重录，不碰网络/凭据/响应，也不改产品的逐字节拒绝规则。
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashOf } from '../../src/assemble/assemble.ts'
import { catalog, catalogHash, CATALOG_STATES } from '../../src/tools/catalog.ts'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export function adaptSearchWire(source: string, target: string) {
  const tools = catalog(CATALOG_STATES[0]!)
  const descriptions = new Map(
    tools.filter(tool => tool.name === 'glob' || tool.name === 'grep')
      .map(tool => [tool.name, tool.description]),
  )
  mkdirSync(join(target, 'wire'), { recursive: true })
  cpSync(join(source, 'scenario.json'), join(target, 'scenario.json'))
  const calls: Record<string, unknown>[] = []

  for (const name of readdirSync(join(source, 'wire')).sort()) {
    const from = join(source, 'wire', name)
    const to = join(target, 'wire', name)
    mkdirSync(to, { recursive: true })
    const old = readFileSync(join(from, 'request.json'))
    const response = readFileSync(join(from, 'response.sse'))
    const request = JSON.parse(old.toString('utf8'))
    for (const tool of request.tools) {
      const description = descriptions.get(tool.name)
      if (description !== undefined) tool.description = description
    }
    const body = Buffer.from(JSON.stringify(request))
    const meta = JSON.parse(readFileSync(join(from, 'meta.json'), 'utf8'))
    const provenance = {
      kind: 'offline-search-catalog-adaptation',
      source: `../wire-in/wire/${name}`,
      sourceRequestSha256: sha256(old),
      responseSha256: sha256(response),
      historicalResponseAndUsage: true,
      liveRequestSent: false,
    }
    writeFileSync(join(to, 'request.json'), body)
    writeFileSync(join(to, 'request.sha256'), `${sha256(body)}  request.json\n`)
    cpSync(join(from, 'response.sse'), join(to, 'response.sse'))
    cpSync(join(from, 'response.sha256'), join(to, 'response.sha256'))
    writeFileSync(join(to, 'meta.json'), JSON.stringify({
      ...meta, requestBytes: body.length, requestHash: hashOf(body), provenance,
    }, null, 2) + '\n')
    writeFileSync(join(to, 'README'),
      'Additional synthetic compatibility fixture. Only glob/grep request descriptions were adapted.\n' +
      'Responses, usage and timings are historical, not new live/provider/cache evidence.\n' +
      'The original wire-in recording and chain acceptance are unchanged.\n',
    )
    calls.push({
      call: name, ...provenance,
      requestSha256: sha256(body), requestHash: hashOf(body), requestBytes: body.length,
    })
  }
  const evidence = { catalogHash: catalogHash(tools), calls, liveRequestSent: false }
  writeFileSync(join(target, 'provenance.json'), JSON.stringify({
    kind: 'offline-search-catalog-adaptation', ...evidence,
  }, null, 2) + '\n')
  return evidence
}
