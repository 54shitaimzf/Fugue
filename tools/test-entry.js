#!/usr/bin/env node
// 测试入口：枚举发现范围内的测试文件，交给 node --test。
//
// 这一层守的是"漏了不报错"：`node --test` 在发现 0 个测试时输出
// tests 0 / pass 0 / fail 0 并以退出码 0 结束（实测）——发现模式一旦失效，
// 整套测试会静默"通过"。入口把"发现数"变成一条会失败的断言。
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
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
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
