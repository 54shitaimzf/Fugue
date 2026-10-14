// 把一份入口（`tools/test-entry.js` 一类）的**静态闭包**整个拷进夹具仓。
//
// 为什么要有这一份：`mutation-audit.test.ts` 与 `ci-timing.test.ts` 的夹具都是"把验收入口拷一份
// 进去真跑"。入口会静态 import 别的文件（`../src/cli/boot.ts` 就是这么进来的），于是原先两个夹具
// 各写一张 `cpSync` 清单——入口多一条 import，两个夹具就各红一次，而红的那句话说的是
// `ERR_MODULE_NOT_FOUND`（"夹具起不来了"），不是"入口错了"。清单跟着入口走：这里只认一件事——
// 从入口开始，静态 import 够得到的仓内相对路径，按同样的相对位置全部拷过去。
//
// **它不碰别的**：夹具的 `src/` 是变异审计扫候选的地方，多拷一份源文件就会多出候选。
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** 一条 `import` / `export … from` / 裸 `import` 的说明符（单双引号都认）。 */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

/**
 * 拷贝 `entry`（仓内绝对路径）与它静态闭包里的每一个仓内文件到 `dest`（夹具根），
 * 按同样的相对位置摆好。返回拷过去的相对路径（拷的次序）——调用方要核对就核它。
 *
 * `node:` 一类裸说明符不是文件，跳过；够不到的相对路径也跳过（那是入口自己的事，让它在夹具里
 * 照原样报错，比这里替它猜一个更清楚）。
 */
export function copyEntryClosure(entry: string, dest: string, repoRoot: string): readonly string[] {
  const seen = new Set<string>()
  const copied: string[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const abs = queue.pop() as string
    if (seen.has(abs)) continue
    seen.add(abs)
    const rel = relative(repoRoot, abs)
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(abs, target)
    copied.push(rel)
    for (const m of readFileSync(abs, 'utf8').matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2]
      if (spec === undefined || !spec.startsWith('.')) continue
      const next = resolve(dirname(abs), spec)
      if (existsSync(next)) queue.push(next)
    }
  }
  return copied
}
