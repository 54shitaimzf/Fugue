// 每趟预览独有的短命解码 worker；不接终端、不读文件，发回结果即退出。
import { parentPort, workerData } from 'node:worker_threads'
import { decodePng } from './png.ts'
const image = decodePng(workerData as Uint8Array)
if (image === null) parentPort?.postMessage(null)
else parentPort?.postMessage(image, [image.rgba.buffer])
