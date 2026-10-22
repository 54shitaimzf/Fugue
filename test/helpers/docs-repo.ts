// 文档那一族测试共用的临时仓库：**一个真 git 仓库 + 一条提交**。
//
// 为什么要真 git：`docs` 的事实一律从提交里读（`Truth.readAt` / `statAt` / `listAt`），
// 用一份内存桩来验"读的是哪一版"等于把被测的那一层换成自己写的替身——那样"事实跟着提交走"
// 这条断言就退化成"桩按我的意思返回"。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { openTruth } from '../../src/truth/truth.ts'
import type { TreeEntry } from '../../src/entries.ts'
import type { CommitId, RelPath } from '../../src/terms.ts'
import { tmpDir } from './tmp.ts'

/** git 不读这台机器上的全局配置：测试读数不该取决于谁配过 `init.defaultBranch`。 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'fugue-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

/** 建一个空的 git 仓库，返回它的根。 */
export function tmpRepo(prefix = 'fugue-docs-'): string {
  const root = tmpDir(prefix)
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

/** 用真源那一层落一条提交（blob → tree → commit），返回提交号。 */
export async function commitFiles(
  root: string,
  files: Readonly<Record<string, string>>,
  parents: readonly CommitId[] = [],
): Promise<CommitId> {
  const truth = openTruth(root)
  try {
    const entries: TreeEntry[] = []
    for (const [path, text] of Object.entries(files)) {
      entries.push({ name: path as RelPath, mode: 0o100644, id: await truth.putBlob(new TextEncoder().encode(text)) })
    }
    const tree = await truth.putTree(entries)
    return await truth.commit(tree, [...parents], `test: ${Object.keys(files).join(', ')}`)
  } finally {
    truth.close()
  }
}

/** 仓库里一条真路径的绝对位置（测试要往盘上放东西时用）。 */
export function at(root: string, rel: string): string {
  return join(root, rel)
}
