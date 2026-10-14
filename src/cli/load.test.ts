// **装载按命令切分**的那一条断言。出处：架构 § 9.6（单次进程 + 每次重建）· 工作区约定 § 五·一
// （任何单元都不许让地板变低）· 发布窗维护批的交接单 § 三 1（判据：`--version` 与 `--help` 的装载闭包
// 显著小于全命令族的并集；装载失序时退化为全量装载，且退化档下全部断言仍绿）。
//
// 六条，各自会红的样子写在各条里：
//
//   ① **按命令装载**：表里每个短名都给出它承诺的那几个符号，而且**只**装那一份（不是全量）。
//      改坏的样子：把 `load` 写成恒等 `import('./all.ts')` → 见证符号在每一份里都在。
//   ② **地板（全量装载那一档）**：表里没有的短名照样给得出符号，而且比任何单份都大。
//      改坏的样子：把 `load` 的兜底删掉 → `load('表里没有的名字')` 取不到符号。
//   ③ **并集不漏**：`all.ts` 的导出名是每一份的并集。`export *` 遇到重名会**静默丢掉**那个名字
//      ——地板自己漏一个符号，而且不报错。改坏的样子：给两份模块各加一个同名导出。
//   ④ **短名拼对**：入口里每一个 `load('…')` 都在表里。改坏的样子：把 `load('round')` 写成
//      `load('rond')` → 静默落到地板上，只变慢（这条断言就是抓它的）。
//   ⑤ **入口的静态闭包**：入口的静态 import 只有 `./boot.ts` · `./load.ts` 与 `node:` 内建。
//      改坏的样子：往 `fugue.ts` 顶上再加一条 `import ... from './cmd/round.ts'`。
//   ⑥ **装载读数**（运行时那一趟，口径在 `tools/bench-startup.mjs` ——只有那一处）：`--version`
//      的闭包里没有那几份重模块，而且比 `doctor` 少——"按命令装载"这件事真的发生了。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { closureOf } from '../../tools/bench-startup.mjs'
import { LOADER_NAMES, load } from './load.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 表里每个短名**承诺**的那几个符号：短名 → 至少要取得到这些导出。 */
const PROMISED: Readonly<Record<string, readonly string[]>> = {
  console: ['tuiCmd'],
  serve: ['serveCmd'],
  view: ['replay', 'commitCmd', 'branchCmd', 'viewCmd'],
  config: ['config', 'policyCmd'],
  doctor: ['doctorCmd'],
  materialize: ['diffStatCmd', 'disposeCmd', 'ensureCmd', 'forkCmd', 'verifyMatCmd'],
  execute: ['runCmd'],
  assemble: ['assembleCmd'],
  round: ['roundCmd', 'roundGo', 'roundPlan', 'roundRun', 'roundWork', 'sayCommand'],
  value: ['isSpecial', 'migrated', 'valueResultOf', 'watchAndWrite'],
  shell: ['writeValue'],
  flags: ['FLAGS_OF'],
  host: ['HostError', 'assertHost'],
  log: ['LogCorruptError', 'logDir'],
  hold: ['LogHeldError'],
}

/**
 * 两份**见证符号**：只属于 `console` 与 `round`。一条命令装的时候，别的短名那一份的见证符号
 * 不该在——"按命令装载"与"全量装载"就是靠它俩分开的。
 */
const WITNESS: Readonly<Record<string, string>> = { console: 'tuiCmd', round: 'roundRun' }

test('① 每个短名给出它承诺的符号，且只装那一份', async () => {
  assert.deepEqual(LOADER_NAMES, Object.keys(PROMISED).sort(), '表与这份承诺清单对不上')
  for (const name of LOADER_NAMES) {
    const m = (await load(name)) as Record<string, unknown>
    for (const sym of PROMISED[name] as readonly string[]) {
      assert.ok(m[sym] !== undefined, `load('${name}') 里取不到 ${sym}`)
    }
    for (const [owner, sym] of Object.entries(WITNESS)) {
      if (name === owner) assert.ok(m[sym] !== undefined, `load('${name}') 里应该有 ${sym}`)
      else assert.ok(m[sym] === undefined, `load('${name}') 把 ${owner} 那一份也装进来了（${sym} 在）`)
    }
  }
})

test('② 地板：表里没有的短名照样给得出整个命令族的符号', async () => {
  const floor = (await load('这个短名表里没有')) as Record<string, unknown>
  assert.ok(floor.roundRun !== undefined && floor.tuiCmd !== undefined, '地板给不出命令族的符号')
  const biggest = Math.max(
    ...(await Promise.all(LOADER_NAMES.map(async (n) => Object.keys(await load(n)).length))),
  )
  assert.ok(
    Object.keys(floor).length > biggest,
    `地板（${Object.keys(floor).length} 个导出）没有比单独一份（最多 ${biggest} 个）大——兜底没走全量那一档`,
  )
})

test('③ 并集不漏：每一份的每一个导出，在全量那一份里都取得到', async () => {
  const floor = (await load('这个短名表里也没有')) as Record<string, unknown>
  for (const name of LOADER_NAMES) {
    const m = (await load(name)) as Record<string, unknown>
    for (const sym of Object.keys(m)) {
      assert.ok(sym in floor, `load('${name}') 的导出 ${sym} 不在 all.ts 那一份里——export * 遇到重名会静默丢掉`)
    }
  }
})

test('④ 入口里每一个 load(…) 的短名都在表里', () => {
  const entry = readFileSync(join(HERE, 'fugue.ts'), 'utf8')
  const used = [...entry.matchAll(/\bload\('([^']+)'\)/g)].map((m) => m[1] as string)
  assert.ok(used.length >= 10, `入口里只扫到 ${used.length} 处 load('…')——正则失效了，这条断言就白绿了`)
  for (const n of used) {
    assert.ok(LOADER_NAMES.includes(n), `入口里的短名 '${n}' 不在表里：它会静默落到地板（只变慢），这条断言是抓它的`)
  }
})

test('⑤ 入口的静态 import 只有 ./boot.ts · ./load.ts 与 node: 内建', () => {
  const entry = readFileSync(join(HERE, 'fugue.ts'), 'utf8')
  const allowed = ['./boot.ts', './load.ts']
  const specs: string[] = []
  for (const m of entry.matchAll(/(^|\n)import\s+(?:type\s+)?[^'\n]*?from\s+'([^']+)'/g)) specs.push(m[2] as string)
  for (const m of entry.matchAll(/(^|\n)import\s+'([^']+)'/g)) specs.push(m[2] as string)
  assert.ok(specs.length > 0, '一条静态 import 都没扫到——正则失效了')
  for (const s of specs) {
    assert.ok(
      s.startsWith('node:') || allowed.includes(s),
      `入口的静态闭包里出现了 ${s}：那一条会让每条命令都重新为它付装载钱（按命令装载走 ./load.ts）`,
    )
  }
})

test('⑥ 读数：--version 的装载闭包里没有重模块，而且比 doctor 少', () => {
  const version = closureOf(['--version'])
  assert.ok(version.modules > 3, `--version 只量到 ${version.modules} 份——探针失效了（NODE_DEBUG 那一行的形状变了？）`)
  for (const heavy of ['src/cli/cmd/round.ts', 'src/ui/console.ts', 'src/value/registry.ts', 'src/log/log.ts']) {
    assert.ok(!version.files.includes(heavy), `--version 的装载闭包里出现了 ${heavy}`)
  }
  const doctor = closureOf(['doctor'])
  assert.ok(
    doctor.modules > version.modules,
    `--version ${version.modules} 份 / doctor ${doctor.modules} 份——按命令装载没有生效`,
  )
})
