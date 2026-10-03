// Real Git/View fixture ownership shared by composed discovery acceptance.
import { execFileSync } from 'node:child_process'
import { tmpDir } from './tmp.ts'
import { openTruth } from '../../src/truth/truth.ts'
import { openLog } from '../../src/log/log.ts'
import { loadView } from '../../src/view/view.ts'
import { lowerAt } from '../../src/view/lower.ts'
import { applyEdit } from '../../src/view/edit.ts'
import { createRoots } from '../../src/roots/roots.ts'
import { createToolHost } from '../../src/tools/host.ts'
import type { WriterId } from '../../src/terms.ts'
import type { Delta } from '../../src/delta.ts'

const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

export async function truthViewFixture(files: Record<string, string | Uint8Array>) {
  const root = tmpDir('fugue-cohort-view-acceptance-')
  execFileSync('git', ['init', '-q', '--object-format=sha1', root], { env })
  const owned: { close(): Promise<void> }[] = []
  function own<T extends { close(): Promise<void> }>(resource: T): T { owned.push(resource); return resource }
  async function close() {
    const errors: unknown[] = []
    for (const resource of owned.splice(0).reverse()) {
      try { await resource.close() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'acceptance fixture cleanup failed')
  }
  const truth = own(openTruth(root))
  try {
    const entries = []
    for (const [name, content] of Object.entries(files)) {
      entries.push({ name, mode: 0o100644, id: await truth.putBlob(typeof content === 'string' ? Buffer.from(content) : content) })
    }
    const base = await truth.commit(await truth.putTree(entries), [], 'cohort View acceptance fixture')
    const roots = createRoots(root)
    async function target(name: string) {
      const writer = name as WriterId, log = own(openLog(root, { write: writer, sync: 'never' }))
      const view = await loadView(log, writer, { lower: lowerAt(truth, base) })
      const plain = createToolHost(view, roots)
      return { writer, log, view, plain,
        change: (delta: Delta) => applyEdit({ view, truth, log, writer }, delta) }
    }
    return { root, truth, roots, base, own, target, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'fixture setup and cleanup failed') }
    throw error
  }
}
