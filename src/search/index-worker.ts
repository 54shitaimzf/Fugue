// 只计算/持久化一个受控原 blob；不用宿主环境、不启动工具、不改权威状态。
import { parentPort, workerData } from 'node:worker_threads'
import { createBlobIndexStore } from './index-store.ts'
import { encodeBlobIndex } from './index-format.ts'

const { root, blob, bytes, temporaryId } = workerData
try {
  const result = await createBlobIndexStore(root).rebuild(blob, bytes, temporaryId)
  if (result.index === null) parentPort?.postMessage({ ok: false, unindexable: result.unindexable === true })
  else {
    const keys = Float64Array.from(result.index.tables.trigrams, (gram) =>
      gram.charCodeAt(0) * 0x1_0000_0000 + gram.charCodeAt(1) * 0x1_0000 + gram.charCodeAt(2))
    parentPort?.postMessage({ ok: true, stored: result.stored,
      serializedBytes: encodeBlobIndex(result.index).byteLength, keys }, [keys.buffer])
  }
} catch { parentPort?.postMessage({ ok: false }) }
finally { parentPort?.close() }
