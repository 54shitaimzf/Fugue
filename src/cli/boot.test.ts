// 编译缓存的四条断言。出处：发布窗维护批的交接单 § 三 2（每个子进程重复付同一份翻译税）· 工作区约定
// § 五·一（任何单元都不许让地板变低）· 路线图 § 1（两杆 = 墙钟 + 子进程 CPU 秒；**不断言快慢**，
// 快慢那两杆是读数，落在提交信息与 CHANGELOG 里）。
//
// 四条，各自会红的样子写在各条里：
//
//   ① **次序**：入口模块体里 `armCompileCache()` 那一句排在第一条 `await import(` 之前。
//      改坏的样子：把它挪到动态装载下面——ESM 整张图求值前就编译完了，那一批模块的编译结果
//      就一次也缓存不上（这一条是静态抓的，不靠读数）。
//   ② **地板**：缓存目录建不出来时，同一条命令的 stdout / stderr / 退出码与"关掉缓存"那一档
//      **逐字节相同**。真跑一次。
//      改坏的样子：把 `enableCompileCache` 的失败当致命——进程起不来，或者 stderr 多一行
//      （`stderr` 一个字节都不许多：黄金帧比的就有它）。
//   ③ **可弃派生体**：缓存目录里真落了条目；**把它整个删掉重来，读出来的字节逐字节相同**。
//      改坏的样子：把缓存目录当成了真源（比如还往里写别的东西、或者依赖它存在）。
//   ④ **这一档真的开着**：可写时 `enabled === true` · `FUGUE_COMPILE_CACHE=off` 时 `false`。
//      改坏的样子：把开关接反、或者 `armCompileCache` 恒返回一个好看的读数。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../test/helpers/tmp.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, 'fugue.ts')
const BOOT = join(HERE, 'boot.ts')

interface Face {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * 子进程的环境：`env` 叠在 `process.env` 上，但**外层那一份 `NODE_COMPILE_CACHE` 先摘掉**。
 *
 * 为什么：`tools/test-entry.js` 会把缓存落点递进整棵测试树，于是这一份指定的落点不生效
 * （`enableCompileCache` 返回 ALREADY_ENABLED、生效的是外层那一处），断言就会红得没有道理。
 * `FUGUE_COMPILE_CACHE` 同理：整档拿它跑 A/B 对照时，它会把这个文件里那些"该开"的断言一起关掉
 * （实测：`FUGUE_COMPILE_CACHE=off` 那一趟，这一份的 ③ 当场红）。
 * 两个都摘掉，这一份自己说了算：它要么给 `XDG_CACHE_HOME`、要么明写 `FUGUE_COMPILE_CACHE=off`。
 */
function childEnv(env: Record<string, string>): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env }
  delete e.NODE_COMPILE_CACHE
  delete e.FUGUE_COMPILE_CACHE
  return { ...e, ...env }
}

/** 跑一条命令，要它的三个面。 */
function run(argv: readonly string[], env: Record<string, string>): Face {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: childEnv(env) })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 同一个解释器里直接问一次 `armCompileCache()`（不起命令行，隔离得干净）。 */
function armIn(env: Record<string, string>): { enabled: boolean; dir: string | null; why: string | null } {
  const code = `const m = await import(${JSON.stringify(BOOT)}); console.log(JSON.stringify(m.armCompileCache()))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: childEnv(env),
  })
  assert.equal(r.status, 0, `问不动 armCompileCache：${r.stderr}`)
  return JSON.parse((r.stdout ?? '').trim()) as { enabled: boolean; dir: string | null; why: string | null }
}

test('① 入口模块体里 armCompileCache() 排在第一条动态装载之前', () => {
  const entry = readFileSync(CLI, 'utf8')
  const callAt = entry.search(/\narmCompileCache\(\)\n/)
  const loadAt = entry.indexOf('await import(')
  assert.ok(callAt > 0, '入口里找不到那一句独立的 `armCompileCache()`')
  assert.ok(loadAt > 0, '入口里找不到动态装载')
  assert.ok(
    callAt < loadAt,
    'armCompileCache() 排在动态装载之后：ESM 整张静态图在求值之前就编译完了，那一批模块的编译结果一次也缓存不上',
  )
})

test('② 地板：缓存目录建不出来时，字节与"关掉缓存"那一档逐字节相同', () => {
  // 这一格放一个**文件**，于是 `<base>/fugue/compile-cache` 这个目录建不出来——用 `chmod` 挡的
  // 话，以 root 跑的机器上挡不住，这一条就成了看运气的断言。
  const base = tmpDir('fugue-cc-block-')
  writeFileSync(join(base, 'fugue'), 'x')
  const blocked: Record<string, string> = { XDG_CACHE_HOME: base }
  const off: Record<string, string> = { FUGUE_COMPILE_CACHE: 'off' }
  for (const argv of [['--version'], ['--help']] as const) {
    const a = run(argv, blocked)
    const b = run(argv, off)
    assert.equal(a.code, 0, `缓存建不出来时 ${argv.join(' ')} 该照常成功：${a.stderr}`)
    assert.equal(a.stderr, '', '缓存建不出来时 stderr 一个字节都不许多（黄金帧比的就有它）')
    assert.deepEqual(a, b, `缓存建不出来那一档与关掉缓存那一档的字节不同（${argv.join(' ')}）`)
  }
})

test('③ 可弃派生体：缓存落了条目；删掉整个目录重来，读出的字节逐字节相同', () => {
  const base = tmpDir('fugue-cc-drop-')
  const env: Record<string, string> = { XDG_CACHE_HOME: base }
  const cacheDir = join(base, 'fugue', 'compile-cache')
  const first = run(['--version'], env)
  assert.equal(first.code, 0, first.stderr)
  assert.ok(existsSync(cacheDir), `缓存目录没建出来：${cacheDir}`)
  const entries = readdirSync(cacheDir)
  assert.ok(entries.length > 0, '缓存目录是空的——这一档没真开，下面那两条量的是空气')
  const warm = run(['--version'], env)
  assert.deepEqual(warm, first, '温缓存那一趟的字节与第一趟不同')
  rmSync(cacheDir, { recursive: true, force: true })
  assert.ok(!existsSync(cacheDir), '删不掉')
  const cold = run(['--version'], env)
  assert.deepEqual(cold, first, '删掉缓存重来读出的字节与第一趟不同')
  console.log(`③ 读数：缓存目录 ${entries.length} 个条目 · 删掉重来那一趟与第一趟逐字节相同`)
})

test('④ 这一档真的开着：可写 → true · FUGUE_COMPILE_CACHE=off → false', () => {
  const base = tmpDir('fugue-cc-arm-')
  const on = armIn({ XDG_CACHE_HOME: base, FUGUE_COMPILE_CACHE: '' })
  assert.equal(on.enabled, true, `该开的时候没开：${JSON.stringify(on)}`)
  assert.ok(on.dir !== null && on.dir.startsWith(base), `报出来的落点不在 ${base} 底下：${JSON.stringify(on)}`)
  const off = armIn({ FUGUE_COMPILE_CACHE: 'off' })
  assert.equal(off.enabled, false, `关掉那一档没关住：${JSON.stringify(off)}`)
  assert.equal(off.dir, null)
  console.log(`④ 读数：可写时 enabled=true · dir=${on.dir} · off 时 why=${off.why}`)
})
