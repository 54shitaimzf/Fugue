#!/usr/bin/env node
// 范围断言：PLAN § 4.3 要的第二条命令——行为断言证明"东西对了"，这条证明"只有这个东西"。
//
// 四条，机械可核对：
//   1. 该提交没有碰声明之外的路径（`--allow` 给的路径及其子树）
//   2. 没有引入运行时依赖（package.json 没有 dependencies · 没有 node_modules）
//   3. 没有多出常驻进程（跑完一条命令，没有还挂在这个工作区的 git 目录上的进程）
//   4. 没有出现声明之外的持久化位置（临时工作区里只有 § 9.2 列出的那几处，且没有索引）
//
// 第 4 条那份清单在 V2 里多了一处：`.fugue/mat/`——物化的根（§ 8.4）；Y6 又多了 `.fugue/bin/`
// ——第二层（Landlock）那个包装器的源码与编译产物（架构 § 8.8 · PLAN § 5.5 的 Y6 行）。两处都是
// **派生**：可弃、可重生成，`dispose` 不管它们。白名单与那一跑是成对的：加了位置就要有一条真跑过
// 它的命令，否则白名单是白加的。**V3 的 `ensure` 也要跑**：
// 它往同一个根里落 delta、往 `log/` 里追加 `mat/sync`；**V5 的 `dispose`** 把那一组收尾，
// 验的是"删干净之后也不在声明之外留下东西"。
//
// 用法：
//   node tools/scope-check.js <rev> --allow <path> [--allow <path> …]
//
// 负对照（它必须非零退出）——把声明收窄到实际碰过的一部分：
//   node tools/scope-check.js <rev> --allow src/view/
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    // 真源里先放一份**真的落在盘上**的文件：`fugue write` 写的是视图，不碰工作树，
    // 所以没有这一份的话，物化那一跑铺出来的是一棵空树——跑了等于没跑。
    writeFileSync(join(tmp, 'real.txt'), '真源里的一份\n')
    const runs = [
      spawnSync(process.execPath, [CLI, '--root', tmp, 'write', 'a.txt', '--stdin'], {
        input: '范围断言\n',
        encoding: 'utf8',
      }),
      spawnSync(process.execPath, [CLI, '--root', tmp, 'read', 'a.txt'], { encoding: 'utf8' }),
      spawnSync(process.execPath, [CLI, '--root', tmp, 'commit', '-m', '范围断言'], { encoding: 'utf8' }),
      // 配置也跑一条：它是第四个声明过的持久化位置，不跑一遍就等于把 `config` 白加进白名单，
      // 而"原子写留下的临时名"恰好只有跑过才看得见。**键用 `round.id`**（README 教过的那一个）：
      // 探针拿的必须是现役可写键——写成键域里没有的名字，第 4 条会以"命令退非零"的样子红，
      // 而红的原因与持久化位置毫无关系（2026-10-04 之前用的 `policy.readOnly` 就是这样）。
      // 这一跑同时落下 `config` 与它的**原值记录** `config-history`（§ 15.3.a 的 P2a：每次改动
      // 一行 JSONL，与目标级 config 同目录）——两处都在下面那张白名单里。
      spawnSync(process.execPath, [CLI, '--root', tmp, 'config', 'set', 'round.id', 'scope-check'], {
        encoding: 'utf8',
      }),
      spawnSync(process.execPath, [CLI, '--root', tmp, 'config', 'get', 'round.id'], {
        encoding: 'utf8',
      }),
    ]
    // 物化也跑一条（`copy` 那一档：不挂载、不要权限，任何机器上都跑得动）。它落下的
    // `.fugue/mat/` 是 § 9.2 布局里声明过的第五个位置——不跑一遍就等于把那个目录白加进
    // 白名单，而"多出一个没声明过的位置"恰好是下面第 4 条要抓的东西。
    const committed = (runs[2].stdout ?? '').split('\t')[0]
    runs.push(
      spawnSync(process.execPath, [CLI, '--root', tmp, 'fork', committed, '--strategy', 'copy'], {
        encoding: 'utf8',
      }),
    )
    // 再写一条、再 `ensure` 一次：delta 落地的那条路（V3）也要真跑过，否则 `.fugue/mat/`
    // 那一处白名单挡住的正是"命令把东西落到别处"这一类，而没跑过的命令挡不住它。
    runs.push(
      spawnSync(process.execPath, [CLI, '--root', tmp, 'write', 'b.txt', '--stdin'], {
        input: '增量\n',
        encoding: 'utf8',
      }),
    )
    runs.push(spawnSync(process.execPath, [CLI, '--root', tmp, 'ensure'], { encoding: 'utf8' }))
    // **Y6 起多一条 `policy`**：它现探那两层，而第二层要 `cc` 编一份包装器落在 `.fugue/bin/`
    // ——那是第六个声明过的位置。不跑一遍就等于把它白加进白名单（这一条与上一条同一个道理）。
    // **2026-10-04 复核：`policy` 是现役命令**（`src/cli/fugue.ts` 的分发里有它）· 退 0 · 真落
    // `.fugue/bin/landlock-exec` 与它的源码——这一条留着，不是过期探针。
    runs.push(spawnSync(process.execPath, [CLI, '--root', tmp, 'policy'], { encoding: 'utf8' }))
    // 物化那一组收尾：`dispose` 把四个坐标删干净（它不新增位置，但它**删**位置——留在白名单
    // 底下的一堆空目录也是"跑过之后留下的东西"）。
    runs.push(spawnSync(process.execPath, [CLI, '--root', tmp, 'dispose'], { encoding: 'utf8' }))
    const broke = runs.findIndex((r) => r.status !== 0)
    if (broke === -1) {
      ok('write · read · commit · config set · config get · fork · write · ensure · policy · dispose 十条命令都退 0')
    }
    else bad(`第 ${broke + 1} 条命令退 ${runs[broke].status}：${runs[broke].stderr.trim()}`)

    // 4 · 持久化位置：临时工作区里只该有**声明过的那几处**——§ 9.1 的状态表与 § 9.2 的
    // 布局就是这份声明：对象库 · 事件日志 · 视图快照 · 工作区配置。宽到整个 `.fugue/`
    // 等于没声明：一个走错地方的临时文件会静静住进去，而"没有声明之外的持久化位置"要拦的
    // 正是它。**目录按前缀比对，文件按全名比对**——否则 `config` 的临时名会挂在 `config`
    // 底下一起被放行，而"写坏了留下一个临时文件"恰好是这条要抓的东西。
    // 那一份真源里本来就有的文件是这一跑的**输入**，不是命令落下的位置——量位置之前先把它
    // 拿走，否则"只有声明过的几处"会被一份跟持久化无关的项目文件撞出假阳性。
    rmSync(join(tmp, 'real.txt'), { force: true })
    const ALLOWED = [
      '.git/',
      '.fugue/log/',
      '.fugue/snap/',
      '.fugue/config',
      // 原值记录（§ 15.3.a 的 P2a）：与目标级 `config` 同目录，`config set` 每改一次写一行。
      '.fugue/config-history',
      '.fugue/mat/',
      // Y6：第二层那个包装器（§ 8.8 · PLAN § 5.5 的 Y6 行）——派生，可弃、可重生成。
      '.fugue/bin/',
    ]
    const declared = (p) => ALLOWED.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a))
    const outside = walk(tmp)
      .map((p) => relative(tmp, p))
      .filter((p) => !declared(p))
    if (outside.length === 0) ok(`持久化位置只有声明过的 ${ALLOWED.length} 处：${ALLOWED.join(' · ')}`)
    else bad(`出现了声明之外的持久化位置：${outside.join(' · ')}`)
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
