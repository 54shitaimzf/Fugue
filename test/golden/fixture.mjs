// 黄金帧的**现场**（0.4.2 站）：录制器与那条断言读的就是这一份。
//
// 一份现场 = 一次性工作区（git 仓）· 一串把状态摆到位的命令（`PRELUDE`）· 那份钉住的 git 环境。
// **两处共用同一份**是为了让录制与它的断言不可能各写一遍：录制时怎么摆，重放时就怎么摆。
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = join(HERE, '..', '..')
export const CLI = join(REPO, 'src', 'cli', 'fugue.ts')
export const FRAMES = join(HERE, 'frames')

/** 这一份环境是**现场的一部分**：钟 · 语言 · git 的身份与日期（不读这台机器的全局配置）。 */
export const BASE_ENV = {
  TZ: 'UTC',
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'golden',
  GIT_AUTHOR_EMAIL: 'golden@example.invalid',
  GIT_COMMITTER_NAME: 'golden',
  GIT_COMMITTER_EMAIL: 'golden@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-07T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-07T00:00:00Z',
}

/** 固定现场：每一条探针都从这一份的副本起（不共享、不叠加）。 */
export const PRELUDE = [
  { argv: ['write', 'a.txt', '--stdin'], stdin: 'alpha\n' },
  { argv: ['write', 'b.txt', '--stdin'], stdin: 'beta\n' },
  { argv: ['commit', '-m', '第一版'] },
  { argv: ['write', 'a.txt', '--stdin'], stdin: 'alpha 第二版\n' },
]

/** 把 `{{名字}}` 换成那一步取出来的值（`C1` = 现场那一份的提交号）。取不到就当场报。 */
export function substitute(argv, vars) {
  return argv.map((a) =>
    String(a).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_m, name) => {
      const v = vars[name]
      if (v === undefined) throw new Error(`探针引了一个没取到的名字：{{${name}}}`)
      return v
    }),
  )
}

/**
 * 跑一步。`code` 给 `null` = 到点被收走（`watch --follow` 那一档）。
 *
 * `--stdin` 显式带上名字这一档（`--stdin=1`）：开关解析器对取值选项是贪心的，而录制这一串
 * 会把它摆在中间——正文照旧从 stdin 来。
 */
export function runStep(root, sys, step, vars) {
  const argv0 = substitute(step.argv, vars)
  const argv = step.stdin === undefined ? argv0 : argv0.map((a) => (a === '--stdin' ? '--stdin=1' : a))
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...argv], {
    cwd: root,
    input: step.stdin ?? '',
    encoding: 'utf8',
    timeout: step.timeoutMs ?? 180_000,
    env: { ...process.env, ...BASE_ENV, FUGUE_SYSTEM_DIR: sys, ...(step.env ?? {}) },
    maxBuffer: 1 << 26,
  })
  return { code: r.status === null ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 造一份现场快照。调用方收尾时 `rmSync(seed.root)`。 */
export function seedSnapshot() {
  const root = mkdtempSync(join(tmpdir(), 'fugue-golden-seed-'))
  const sys = join(root, '.syshome')
  mkdirSync(sys, { recursive: true })
  const git = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`git init 失败：${git.stderr}`)
  for (const step of PRELUDE) {
    const r = runStep(root, sys, step, {})
    if (r.code !== 0) throw new Error(`现场那一步失败（${step.argv.join(' ')}）：${r.stderr}`)
  }
  // 探针里 `{{C1}}` 指的那一个：现场那一份自己的提交号。**实算，不写死**。
  const c = runStep(root, sys, { argv: ['--json', 'commit', '-m', '第二版'] }, {})
  if (c.code !== 0) throw new Error(`现场那次提交失败：${c.stderr}`)
  return { root, sys, c1: JSON.parse(c.stdout).commit }
}

/** 把快照复制成一条探针的工作区。调用方收尾时删掉它。 */
export function cloneSeed(seed, prefix = 'fugue-golden-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cpSync(seed.root, root, { recursive: true })
  return { root, sys: join(root, '.syshome') }
}

export { rmSync }
