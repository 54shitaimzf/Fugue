#!/usr/bin/env node
// 范围断言：PLAN § 4.3 要的第二条命令——行为断言证明"东西对了"，这条证明"只有这个东西"。
//
// 四条，机械可核对：
//   1. 该提交没有碰声明之外的路径（`--allow` 给的路径及其子树）
//   2. 没有引入运行时依赖（package.json 没有 dependencies · 没有 node_modules）
//   3. 没有多出常驻进程（跑完一条命令，没有还挂在这个工作区的 git 目录上的进程）
//   4. 没有出现声明之外的持久化位置（临时工作区里只有 .git 与 .fugue/log/，且没有索引）
//
// 用法：
//   node tools/scope-check.js <rev> --allow <path> [--allow <path> …]
//
// 负对照（它必须非零退出）——把声明收窄到实际碰过的一部分：
//   node tools/scope-check.js <rev> --allow src/view/
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli', 'fugue.ts')

function git(args, cwd = ROOT) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 })
}

let failed = 0
function ok(msg) {
  process.stdout.write(`  ok   ${msg}\n`)
}
function bad(msg) {
  failed++
  process.stdout.write(`  FAIL ${msg}\n`)
}

/** 1 · 路径白名单。 */
function checkPaths(rev, allow) {
  const r = git(['diff-tree', '--no-commit-id', '--name-only', '-r', rev])
  if (r.status !== 0) {
    bad(`读不到 ${rev} 的改动：${r.stderr.trim()}`)
    return
  }
  const changed = r.stdout.split('\n').filter((l) => l !== '')
  const outside = changed.filter((p) => !allow.some((a) => p === a || p.startsWith(a.replace(/\/$/, '') + '/')))
  if (outside.length === 0) ok(`${changed.length} 个改动路径全在声明之内`)
  else bad(`越出声明：${outside.join(' · ')}`)
}

/** 2 · 运行时依赖。 */
function checkDeps() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  if (deps.length === 0) ok('package.json 没有 dependencies')
  else bad(`引入了运行时依赖：${deps.join(' · ')}`)
  if (!existsSync(join(ROOT, 'node_modules'))) ok('没有 node_modules')
  else bad('有 node_modules——依赖树进了工作区')
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 3 · 常驻进程 + 4 · 持久化位置。都用同一个临时工作区跑一遍真命令。 */
function checkRun() {
  const tmp = mkdtempSync(join(tmpdir(), 'fugue-scope-'))
  try {
    const init = spawnSync('git', ['init', '-q', '.'], { cwd: tmp, encoding: 'utf8' })
    if (init.status !== 0) {
      bad(`临时工作区建不起来：${init.stderr.trim()}`)
      return
    }
    const runs = [
      spawnSync(process.execPath, [CLI, '--root', tmp, 'write', 'a.txt', '--stdin'], {
        input: '范围断言\n',
        encoding: 'utf8',
      }),
      spawnSync(process.execPath, [CLI, '--root', tmp, 'read', 'a.txt'], { encoding: 'utf8' }),
      spawnSync(process.execPath, [CLI, '--root', tmp, 'commit', '-m', '范围断言'], { encoding: 'utf8' }),
    ]
    const broke = runs.findIndex((r) => r.status !== 0)
    if (broke === -1) ok('write · read · commit 三条命令都退 0')
    else bad(`第 ${broke + 1} 条命令退 ${runs[broke].status}：${runs[broke].stderr.trim()}`)

    // 4 · 持久化位置：临时工作区里除了 .git 与 .fugue/ 不该有别的。
    const outside = walk(tmp)
      .map((p) => relative(tmp, p))
      .filter((p) => !p.startsWith('.git/') && !p.startsWith('.fugue/'))
    if (outside.length === 0) ok('工作区里没有多出文件（上层只在日志与对象库里）')
    else bad(`多出了文件：${outside.join(' · ')}`)
    if (!existsSync(join(tmp, '.git', 'index'))) ok('没有落索引（§ 8.2 硬约束 1 的第二种形态）')
    else bad('落下了 .git/index')

    // 3 · 常驻进程：命令都退出了，不该还有进程挂在这个工作区的 git 目录上。
    const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
    const lingering = ps.stdout
      .split('\n')
      .filter((l) => l.includes(join(tmp, '.git')) && !l.includes('ps -eo'))
    if (lingering.length === 0) ok('没有常驻进程（每条命令退出后不留 git 子进程）')
    else bad(`还有进程挂在上面：${lingering.join(' | ')}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const rev = argv.find((a) => !a.startsWith('-'))
const allow = argv.flatMap((a, i) => (a === '--allow' && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
  .concat(argv.filter((a) => a.startsWith('--allow=')).map((a) => a.slice('--allow='.length)))

if (rev === undefined || allow.length === 0) {
  process.stderr.write('用法：node tools/scope-check.js <rev> --allow <path> [--allow <path> …]\n')
  process.exit(2)
}

process.stdout.write(`范围断言 · ${rev}\n`)
process.stdout.write('一 · 声明的路径\n')
checkPaths(rev, allow)
process.stdout.write('二 · 运行时依赖\n')
checkDeps()
process.stdout.write('三 · 常驻进程 · 四 · 持久化位置\n')
checkRun()

process.stdout.write(failed === 0 ? '全部通过\n' : `${failed} 项不通过\n`)
process.exit(failed === 0 ? 0 : 1)
