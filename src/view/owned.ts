import type { Delta } from '../delta.ts'

const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!

/** Own the intrinsic visible bytes and backing buffer; preserve Buffer/plain Uint8Array representation. */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  const window = new Uint8Array(bufferOf.call(bytes), offsetOf.call(bytes), lengthOf.call(bytes))
  const owned = new Uint8Array(window)
  return Buffer.isBuffer(bytes) ? Buffer.from(owned.buffer, owned.byteOffset, owned.byteLength) : owned
}

/** Capture primitive labels and content before handing a delta across an await. */
export function cloneDelta(d: Delta): Delta {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return { ...d, bytes: copyBytes(d.bytes) }
    default:
      return { ...d }
  }
}
