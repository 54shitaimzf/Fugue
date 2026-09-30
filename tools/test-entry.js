#!/usr/bin/env node
// 测试入口：枚举发现范围内的测试文件，交给 node --test。
//
// 这一层守的是"漏了不报错"：`node --test` 在发现 0 个测试时输出
// tests 0 / pass 0 / fail 0 并以退出码 0 结束（实测）——发现模式一旦失效，
// 整套测试会静默"通过"。入口把"发现数"变成一条会失败的断言。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOTS = ['src', 'test']
const PATTERN = /\.test\.ts$/

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

// 直接运行时才执行；被测试 import 时不执行。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = discover(process.cwd())
  if (files.length === 0) {
    const where = ROOTS.map((r) => r + '/').join(' 与 ')
    console.error('发现 0 个测试文件（' + where + '下的 *.test.ts）——拒绝以"通过"结束')
    process.exit(1)
  }
  // **一批跑**（W8 起那个两批的口子已经堵上）：环在 `tools/host.ts → capability/dispatch.ts`
  // （为了 `shellArgv` 那一个值引用），W8 把它搬到没有依赖的 `tools/argv.ts` 之后，模块图又是一
  // 棵树了。之所以要堵它而不是留着分两批：分两批跑会**静默丢掉几条**（实测 `tests 325` 而不是
  // `332`，而退出码照样是 0）——一个不报错的漏，正是这个入口要守的那一类。
  //
  // **系统级配置指到空目录**（P2a 的测试隔离）：readConfig 缺省会叠 `~/.fugue/config`——
  // 测试读数不该取决于这台机器上有没有人配过系统级。要碰系统级的测试自己用
  // `FUGUE_SYSTEM_DIR`（或 readConfig 的 systemDir 参数）指到它准备的目录。
  process.env.FUGUE_SYSTEM_DIR = mkdtempSync(join(tmpdir(), 'fugue-test-sys-'))
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
