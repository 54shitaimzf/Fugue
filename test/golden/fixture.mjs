// 黄金帧的**现场**（0.4.2 站）：录制器与那条断言读的就是这一份。
//
// 一份现场 = 一次性工作区（git 仓）· 一串把状态摆到位的命令（`PRELUDE`）· 那份钉住的 git 环境。
// **两处共用同一份**是为了让录制与它的断言不可能各写一遍：录制时怎么摆，重放时就怎么摆。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
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
 * 钉层的那一间「无 bwrap 的 PATH」（0.4.2 收尾后的 CI 修）：`doctor` · `policy` · `run` 的
 * 回执跟着「这一趟在场的层」走，而层是**现探**的（policy.ts 的 `probeLayers`：`bwrap` 起一次
 * `--version`，Landlock 走包装器 `--probe`）——开发机上有 bwrap、GitHub runner 上没有，同一条
 * 命令两种字节，帧跟着宿主红。带 `pinLayers` 的探针走这一份 PATH：把 `bwrap` 藏起来，录制与
 * 重放就都落在「只有 Landlock 那一层」的档上，任何宿主同一字节。（不钉「一层都不在」那一档：
 * 它让 `run` 按 § 8.5 直接拒绝，成功路径就锁不到了。）软链先到先得——PATH 里排前面的目录说了算。
 */
let farm = null
export function pathWithoutBwrap() {
  if (farm !== null) return farm
  const dir = mkdtempSync(join(tmpdir(), 'fugue-golden-nobwrap-'))
  for (const d of String(process.env.PATH ?? '').split(':')) {
    if (d === '' || !existsSync(d)) continue
    let entries
    try {
      entries = readdirSync(d)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e === 'bwrap') continue
      const to = join(dir, e)
      if (existsSync(to)) continue
      const from = join(d, e)
      try {
        if (!statSync(from).isFile()) continue
        symlinkSync(from, to)
      } catch {
        /* 这一条链不上就让它缺：探针认的是「出得来出不来」，不是「每条都在」 */
      }
    }
  }
  farm = dir
  return dir
}

/** 收掉那一间软链目录（录制器与断言各在收尾叫一次；没建过就是空操作）。 */
export function disposePathFarm() {
  if (farm !== null) rmSync(farm, { recursive: true, force: true })
  farm = null
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
