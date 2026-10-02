import { rmSync } from 'node:fs'

// 每个路径都是该探针独占的新建目录；单项失败不能跳过其余拥有的资源。
export function removeGeneratedDirectories(paths, remove = rmSync) {
  const failures = []
  for (const path of paths) {
    try { remove(path, { recursive: true, force: true }) }
    catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'generated directory cleanup failed')
}
