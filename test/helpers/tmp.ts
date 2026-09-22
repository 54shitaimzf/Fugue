// 测试用的临时工作区：**建的时候登记，这个文件跑完一起删**。
//
// 为什么不写成"每个用例自己收尾"：收尾要在几十个用例里各写一遍，而"有一处漏了"正是这类
// 清理最容易出的错——漏掉的攒在 `/tmp` 里，谁也不去看（实测一次全量验收之后，那里躺着
// 近两千个 `fugue-*` 目录）。登记一次、按文件收一次，漏不掉。
//
// `node --test` 给每个测试文件一个独立进程，所以这张登记表是文件级的；用 `after` 而不是
// `process.on('exit')`，是为了让它跟着测试生命周期走——用例失败也照收。
//
// 目录名前缀照旧（`fugue-cli-` 那种）：照着 `/tmp` 找现场时，还认得出来是谁留下的。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

const made: string[] = []

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  made.length = 0
})

export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
