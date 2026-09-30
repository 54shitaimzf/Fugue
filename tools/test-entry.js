#!/usr/bin/env node
// 测试入口：枚举发现范围内的测试文件，交给 node --test。
//
// 这一层守的是"漏了不报错"：`node --test` 在发现 0 个测试时输出
// tests 0 / pass 0 / fail 0 并以退出码 0 结束（实测）——发现模式一旦失效，
// 整套测试会静默"通过"。入口把"发现数"变成一条会失败的断言。
//
// **分档（0.2.1）**：`node tools/test-entry.js [all|fast|real]`，缺省 all（与分档之前同行为）。
// 真档文件在首行声明 `// tier: real —— …`（点出依赖种类），没声明的都是快档；判据是
// **依赖性质**（真进程 bwrap·cc · 真端口 · 真挂载），不是文件位置——声明随文件走，没有中央清单。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOTS = ['src', 'test']
const PATTERN = /\.test\.ts$/

const REAL = /^\/\/\s*tier:\s*real\b/
const LANES = ['all', 'fast', 'real']

/** 发现范围内的全部测试文件。 */
export function discover(root = process.cwd()) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (PATTERN.test(name)) out.push(p)
    }
  }
  for (const r of ROOTS) walk(join(root, r))
  return out.sort()
}

/** 按首行声明拆档：fast ∪ real 恒等于全集、交空——没有文件被漏掉或数两次。 */
export function splitLanes(files) {
  const fast = []
  const real = []
  for (const f of files) {
    const first = readFileSync(f, 'utf8').split('\n', 1)[0] ?? ''
    if (REAL.test(first)) real.push(f)
    else fast.push(f)
  }
  return { fast, real }
}

// 真依赖的闭合调用形状：快档文件出现任一形状即红。这不是穷尽的依赖分析——只认
// **字面**调用形状（经变量的间接调用、帮助模块里的调用、整串 shell 里的 bwrap/cc 都看不见），
// 口径是「抓字面、零仪式」：没有白名单、没有豁免注释；哪个形状抓不到的，记口径，不打补丁。
// 「快档不依赖真依赖」的直接证伪通道是 PATH 探针（读数归档在提交序列），审计只是绊线。
const REAL_CALL_SHAPES = [
  "spawnSync('bwrap'",
  "spawn('bwrap'",
  "['bwrap'",
  "spawnSync('unshare'",
  "spawn('unshare'",
  "execFileSync('cc'",
  "spawnSync('cc'",
  "['cc'",
  '.listen(',
  'mountOverlay(',
  'unmountOverlay(',
]

/** 快档审计：fast 文件里出现的真依赖调用形状（常开、纯文本、瞬时）。 */
export function auditFast(fast) {
  const hits = []
  for (const f of fast) {
    const text = readFileSync(f, 'utf8')
    for (const shape of REAL_CALL_SHAPES) {
      if (text.includes(shape)) hits.push({ file: f, shape })
    }
  }
  return hits
}

// 直接运行时才执行；被测试 import 时不执行。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = discover(process.cwd())
  if (files.length === 0) {
    const where = ROOTS.map((r) => r + '/').join(' 与 ')
    console.error('发现 0 个测试文件（' + where + '下的 *.test.ts）——拒绝以"通过"结束')
    process.exit(1)
  }
  const lane = process.argv[2] ?? 'all'
  if (!LANES.includes(lane)) {
    console.error('未知档「' + lane + '」——只有 ' + LANES.join(' · ') + '（缺省 all）')
    process.exit(2)
  }
  const { fast, real } = splitLanes(files)
  if (fast.length + real.length !== files.length) {
    console.error('分档漏了文件：快 ' + fast.length + ' + 真 ' + real.length + ' ≠ 全量 ' + files.length)
    process.exit(1)
  }
  const violations = auditFast(fast)
  if (violations.length > 0) {
    for (const v of violations) {
      console.error('快档含真依赖形状：' + v.file + ' ← ' + v.shape)
    }
    console.error('快档不碰真依赖（bwrap · cc · 真端口 · 真挂载）——该文件要么改断言，要么首行声明 // tier: real')
    process.exit(1)
  }
  const chosen = lane === 'fast' ? fast : lane === 'real' ? real : files
  if (chosen.length === 0) {
    console.error('「' + lane + '」档 0 个文件——拒绝以"通过"结束')
    process.exit(1)
  }
  console.error(
    '档 ' + lane + '：' + chosen.length + ' 个文件（快 ' + fast.length + ' · 真 ' + real.length + ' · 全量 ' + files.length + '）'
  )
  // **一次仍只跑一批**：W8 那次两批丢测试（实测 `tests 325` 而非 `332`、退出码 0）的病根不在
  // "名单分两份"，在**静默丢**——名单现在分快/真两份，但并集==发现集是硬断言（上面那行），
  // 丢文件当场红。分档也不复现当年那个环（W8 已把 `shellArgv` 搬到无依赖的 `tools/argv.ts`，
  // 模块图是树；这里每档一个独立进程）。
  //
  // **系统级配置指到空目录**（P2a 的测试隔离）：readConfig 缺省会叠 `~/.fugue/config`——
  // 测试读数不该取决于这台机器上有没有人配过系统级。要碰系统级的测试自己用
  // `FUGUE_SYSTEM_DIR`（或 readConfig 的 systemDir 参数）指到它准备的目录。
  const sys = mkdtempSync(join(tmpdir(), 'fugue-test-sys-'))
  process.env.FUGUE_SYSTEM_DIR = sys
  // `--` 之后都是文件名——以 `-` 开头的测试文件名不会被 node 吃成选项。
  const r = spawnSync(process.execPath, ['--test', '--', ...chosen], { stdio: 'inherit' })
  // 跑完就删：这个目录是入口自己建的（P2a 的隔离），不删就每跑一趟漏一个进 /tmp。
  rmSync(sys, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}
