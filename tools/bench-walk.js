#!/usr/bin/env node
// 0.2.5：同一视图代的首次/再次 walk 与变更后的重走。只报读数，不断言时长。
// FUGUE_ROOT=<checkout> 用同一份固定语料比较另一份实现；不使用 git/模型/执行面。
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.env.FUGUE_ROOT ?? process.cwd())
const { loadView } = await import(pathToFileURL(join(root, 'src/view/view.ts')).href)
const { createToolHost } = await import(pathToFileURL(join(root, 'src/tools/host.ts')).href)
const { createRoots } = await import(pathToFileURL(join(root, 'src/roots/roots.ts')).href)
const view = await loadView({ async *readByWriter() {} }, 'round', { lower: {
  base: null,
  async readBlob() { throw new Error('empty lower has no blobs') },
  async stat() { return null },
  async read() { return null },
  async list() { return [] },
} })
for (let directory = 0; directory < 32; directory++) {
  for (let file = 0; file < 8; file++) {
    await view.write(`d${String(directory).padStart(2, '0')}/f${file}.txt`, Buffer.from('fixed corpus'))
  }
}
let listCalls = 0
const list = view.list.bind(view)
view.list = async (dir) => { listCalls++; return list(dir) }
const host = createToolHost(view, createRoots('/tmp/fugue-walk-benchmark-memory-only'))
async function measure() {
  const before = listCalls
  const start = performance.now()
  const paths = await host.walk()
  return { ms: Number((performance.now() - start).toFixed(3)), listCalls: listCalls - before, paths }
}
const cold = await measure()
const hot = await measure()
if (JSON.stringify(cold.paths) !== JSON.stringify(hot.paths)) throw new Error('cold/hot paths differ')
await view.write('new/file.txt', Buffer.from('new generation'))
const changed = await measure()
if (!changed.paths.includes('new/file.txt')) throw new Error('changed view generation was not observed')
const report = ({ paths, ...reading }) => ({ ...reading, files: paths.length })
console.log(JSON.stringify({ corpus: '256 fixed in-memory view files in 32 directories', cold: report(cold), hot: report(hot), changed: report(changed) }))
