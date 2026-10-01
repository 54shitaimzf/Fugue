// 一个受控原blob一次；宿主有限池复用Worker，不改权威状态。
import { parentPort, workerData } from 'node:worker_threads'
import { createBlobIndexStore } from './index-store.ts'
import { encodeBlobIndex } from './index-format.ts'

const store = createBlobIndexStore(workerData.root)
let active = false
parentPort?.on('message', async ({ blob, bytes, temporaryId }) => {
  if (active) { parentPort?.postMessage({ ok: false, temporaryId }); return }
  active = true
  try {
    const result = await store.rebuild(blob, bytes, temporaryId)
    if (result.index === null) parentPort?.postMessage({ ok: false, temporaryId, unindexable: result.unindexable === true })
    else {
      const keys = Float64Array.from(result.index.tables.trigrams, (gram) =>
        gram.charCodeAt(0) * 0x1_0000_0000 + gram.charCodeAt(1) * 0x1_0000 + gram.charCodeAt(2))
      parentPort?.postMessage({ ok: true, temporaryId, stored: result.stored,
        serializedBytes: encodeBlobIndex(result.index).byteLength, keys }, [keys.buffer])
    }
  } catch { parentPort?.postMessage({ ok: false, temporaryId }) }
  finally { active = false }
})
