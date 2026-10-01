// 一个受控原blob一次；宿主有限池复用Worker，不改权威状态。
import { parentPort, workerData } from 'node:worker_threads'
import { createBlobIndexStore } from './index-store.ts'
import { encodeBlobIndex } from './index-format.ts'

const store = createBlobIndexStore(workerData.root)
let active = false
parentPort?.on('message', async (message: unknown) => {
  // `parentPort` 是本线程唯一的外部输入面，形状一律不信。写成参数解构会出事：
  // async 函数的参数解构失败产生的是一个没人消费的 rejected promise（EventEmitter
  // 不看回调的返回值），默认 unhandledRejection 模式下当场把线程打死——代价正好是
  // 一个已经预热好的可复用 Worker，也就是这一笔的全部收益。回执方向
  // （index-worker-reply.ts）本来就逐字段查过跨边界的形状，这一侧要对称。
  const row = message !== null && typeof message === 'object' ? message as Record<string, unknown> : {}
  const blob = typeof row.blob === 'string' ? row.blob : undefined
  const bytes = row.bytes instanceof Uint8Array ? row.bytes : undefined
  const temporaryId = typeof row.temporaryId === 'string' ? row.temporaryId : undefined
  if (blob === undefined || bytes === undefined || temporaryId === undefined) {
    parentPort?.postMessage({ ok: false, temporaryId })
    return
  }
  if (active) { parentPort?.postMessage({ ok: false, temporaryId }); return }
  active = true
  try {
    const result = await store.rebuild(blob, bytes, temporaryId)
    if (result.index === null) parentPort?.postMessage({ ok: false, temporaryId })
    else {
      const keys = Float64Array.from(result.index.tables.trigrams, (gram) =>
        gram.charCodeAt(0) * 0x1_0000_0000 + gram.charCodeAt(1) * 0x1_0000 + gram.charCodeAt(2))
      parentPort?.postMessage({ ok: true, temporaryId, stored: result.stored,
        serializedBytes: encodeBlobIndex(result.index).byteLength, keys }, [keys.buffer])
    }
  } catch { parentPort?.postMessage({ ok: false, temporaryId }) }
  finally { active = false }
})
