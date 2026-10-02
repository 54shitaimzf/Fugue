// Pure test/developer blob storage for Lower fixtures; no Git process or filesystem.
import { createHash } from 'node:crypto'
import type { BlobId } from '../../src/terms.ts'

export function memoryBlobs(algorithm: 'sha1' | 'sha256' = 'sha1') {
  const blobs = new Map<BlobId, Uint8Array>()
  return {
    async putBlob(input: Uint8Array): Promise<BlobId> {
      const bytes = new Uint8Array(input)
      const id = createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
      blobs.set(id, bytes)
      return id
    },
    async readBlob(id: BlobId): Promise<Uint8Array> {
      const bytes = blobs.get(id)
      if (bytes === undefined) throw new Error(`unknown memory blob: ${id}`)
      return new Uint8Array(bytes)
    },
  }
}
