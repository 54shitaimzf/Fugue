// 第五单元。出处：PLAN § 5 的 U5 行 · 架构 § 9.2 的布局 · § 15.3.a · D16 · § 24 纪律 13。
//
// 两条断言都是**结构性质**，所以都在真 CLI 上、跨进程地验：
//
//   ① 配置改动后重放结果不变     ← 日志是可重放历史，唯一的编排级持久状态（§ 9.1）
//   ② 视图内没有一条路到得了 `.fugue/`  ← "模型是被配置者"是位置带来的（D16）
//
// 第 ② 条要读准：`.fugue/` 这个名字在架构里指三个目录（§ 9.10 的末段），视图里那个是**保留
// 前缀**，可提交、被 `M13` 跳过。这一条断言说的不是"视图里不能有这个名字"，而是**视图那一面
// 没有任何一条路到达真实工作树里的那个** —— 也就是配置·日志·快照住的那一个。
//
// 两条都带负对照：配置真的变了（不然 ⓐ 是空的），而 `config` 真的读得到那个文件（不然 ⓑ 是
// 空的——一个谁都够不到的文件，和一条谁都够不到的路，看着一样）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../test/helpers/tmp.ts'
import { configFileOf, getConfig, readConfig, readWorkspaceConfig } from './config.ts'
import { saveFacts } from './materialize/capability.ts'

const CLI = fileURLToPath(new URL('./cli/fugue.ts', import.meta.url))

interface Run {
  code: number
  stdout: string
  stderr: string
}

// 这一份测试**自己钉死系统根**（P2a）：缺省指到空目录——CLI 的读数不取决于这台机器上有没有
// 人配过系统级；两级的用例把 `SYS_DIR` 换成自己准备的那一份，用完还回来（try/finally）。
const EMPTY_SYS = tmpDir('fugue-sys-none-')
let SYS_DIR = EMPTY_SYS

function fugue(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env: { ...process.env, FUGUE_SYSTEM_DIR: SYS_DIR },
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function fugueStdin(root: string, input: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 1 << 26,
    env: { ...process.env, FUGUE_SYSTEM_DIR: SYS_DIR },
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function tmpRoot(): string {
  const root = tmpDir('fugue-config-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

/** 一条命令的产物，与过程无关的那部分：`ms` 不算。 */
function replayState(root: string): string {
  const r = fugue(root, '--json', 'replay')
  assert.equal(r.code, 0, r.stderr)
  const o = JSON.parse(r.stdout) as Record<string, unknown>
  delete o.ms
  return JSON.stringify(o)
}

function logBytes(root: string): number {
  return readFileSync(join(root, '.fugue', 'log', 'round.jsonl')).length
}

function snapNames(root: string): string[] {
  try {
    return readdirSync(join(root, '.fugue', 'snap', 'round')).sort()
  } catch {
    return []
  }
}

/** 一次提交定格的树。提交本身每次都新（父与时间不同），内容是不是同一份要看树。 */
function treeOf(root: string, commit: string): string {
  const r = spawnSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function commitOf(run: Run): string {
  assert.equal(run.code, 0, run.stderr)
  return run.stdout.split('\t')[0]
}

test('config：缺文件是空配置 · 坏文件拒绝加载 · 一次改动原子地落一个文件', () => {
  // **故意不 git init**：配置是工作区的输入，不是它的状态，所以它不需要对象库。
  const root = tmpDir('fugue-config-')
  const file = configFileOf(root)

  const empty = fugue(root, 'config', 'show')
  assert.equal(empty.code, 0, empty.stderr)
  assert.equal(empty.stdout, '{}\n', '还没配过 = 空配置，不是错误')
  assert.equal(existsSync(file), false, '读一次不该把文件或目录建出来')

  const miss = fugue(root, 'config', 'get', 'config.nope')
  assert.notEqual(miss.code, 0, '没有这条键要非零退出——"没有"与"配了个空"分得开')
  assert.equal(miss.stdout, '')

  const set = fugue(root, 'config', 'set', 'config.scratch', '5')
  assert.equal(set.code, 0, set.stderr)
  assert.equal(fugue(root, 'config', 'get', 'config.scratch').stdout, '5\n')
  assert.equal(fugue(root, '--json', 'config', 'get', 'config.scratch').stdout, '5\n', '数字过 JSON 面还是数字')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { config: { scratch: number } }
  assert.equal(saved.config.scratch, 5)
  // P2a 起 set 还落一行原值记录（与目标级 config 同目录）——清单因此是这两个文件。
  assert.deepEqual(readdirSync(join(root, '.fugue')).sort(), ['config', 'config-history'], '原子写的临时名不该留下')

  // 空文件与坏文件必须分开：前者是"还没写"，后者是"写坏了"（§ 9.3 对日志中段损坏同一条）。
  writeFileSync(file, '')
  assert.equal(fugue(root, 'config', 'show').stdout, '{}\n')
  writeFileSync(file, '{"a":')
  const bad = fugue(root, 'config', 'show')
  assert.notEqual(bad.code, 0, '解析不了要拒绝加载')
  assert.equal(bad.stdout, '', '拒绝时不许吐出半份或一份空的配置')
  assert.match(bad.stderr, /JSON/)
  const badGet = fugue(root, 'config', 'get', 'config.scratch')
  assert.notEqual(badGet.code, 0, '改不了也读不了：坏文件上没有一条路能给出一个值')

  // 根不存在：`set` 不替人建一个工作区。
  const ghost = join(root, 'nope')
  assert.notEqual(fugue(ghost, 'config', 'set', 'config.ghost', '1').code, 0)
  assert.equal(existsSync(ghost), false)
})

test('config：点分键寻址 · 值是 JSON 或字符串 · 回报改之前的老值', () => {
  const root = tmpRoot()
  for (const [k, v] of [
    ['docs.trace.path', '.fugue/docs/trace.html'],
    ['config.readOnly', 'true'],
    ['actions.build.cmd', 'make'],
    ['config.tags', '["a","b"]'],
  ] as const) {
    const r = fugue(root, 'config', 'set', k, v)
    assert.equal(r.code, 0, r.stderr)
  }

  const show = fugue(root, 'config', 'show')
  assert.equal(show.code, 0, show.stderr)
  assert.deepEqual(JSON.parse(show.stdout), {
    docs: { trace: { path: '.fugue/docs/trace.html' } },
    config: { readOnly: true, tags: ['a', 'b'] },
    actions: { build: { cmd: 'make' } },
  })

  assert.equal(fugue(root, 'config', 'get', 'config.readOnly').stdout, 'true\n', 'true 是布尔值')
  assert.equal(
    fugue(root, 'config', 'get', 'docs.trace.path').stdout,
    '.fugue/docs/trace.html\n',
    '人这一面：字符串吐原样，好接管道',
  )
  assert.equal(
    fugue(root, '--json', 'config', 'get', 'docs.trace.path').stdout,
    '".fugue/docs/trace.html"\n',
    'JSON 面一律是 JSON',
  )

  const over = JSON.parse(fugue(root, '--json', 'config', 'set', 'config.readOnly', 'false').stdout)
  assert.deepEqual(over, {
    key: 'config.readOnly',
    value: false,
    old: true,
    path: configFileOf(root),
  })
  const fresh = JSON.parse(fugue(root, '--json', 'config', 'set', 'config.later.key', '1').stdout)
  assert.equal('old' in fresh, false, '第一次写没有老值，这条字段就不出现（null 会与"存了个 null"混起来）')

  // 中途不是对象就报错，不替人做决定——而且一个字节都不动。
  const before = readFileSync(configFileOf(root), 'utf8')
  const clash = fugue(root, 'config', 'set', 'docs.trace.path.x', '1')
  assert.notEqual(clash.code, 0)
  assert.match(clash.stderr, /不是一个对象/)
  assert.notEqual(fugue(root, 'config', 'set', 'a..b', '1').code, 0, '点分键里的空段是写错了，不是缺省')
  assert.equal(readFileSync(configFileOf(root), 'utf8'), before, '报错的那两次没有落盘')
})

test('① 配置改动后重放结果不变', () => {
  const root = tmpRoot()
  assert.equal(fugueStdin(root, '第一版\n', 'write', 'a.txt', '--stdin').code, 0)
  const first = commitOf(fugue(root, 'commit', '-m', '底稿'))

  const state = replayState(root)
  const log = logBytes(root)
  const snaps = snapNames(root)
  assert.notEqual(snaps.length, 0, '提交点写过快照，下面那句"配置不动快照"才不是空话')

  // 改的都是"实现一旦偷看配置就会露出来"的那种键：能力 · 边界 · 文档定义 —— 它们全是
  // 配置该管的事（§ 15.3.a），而一件都不该改变一条既有日志重放出来的东西。
  for (const [k, v] of [
    ['actions.build.cmd', 'make'],
    ['config.readOnly', 'true'],
    ['docs.trace.path', '.fugue/docs/trace.html'],
    ['config.retries', '3'],
  ] as const) {
    assert.equal(fugue(root, 'config', 'set', k, v).code, 0)
  }
  assert.equal(fugue(root, 'config', 'get', 'config.readOnly').stdout, 'true\n', '负对照：配置真的变了')

  assert.equal(replayState(root), state, '重放结果只由日志决定——配置改动动不了它')
  assert.equal(fugue(root, 'replay', '--verify').code, 0, '两条独立的重建路径仍然一致')
  assert.equal(logBytes(root), log, '改配置不写日志')
  assert.deepEqual(snapNames(root), snaps, '改配置不动快照')

  // 提交这条路也走一遍：视图没变，定格的树就该是同一棵。
  const second = commitOf(fugue(root, 'commit', '-m', '配置改过之后再提交一次'))
  assert.equal(treeOf(root, second), treeOf(root, first), '配置改动不进提交的内容')
})

test('② 视图内没有一条路到得了 .fugue/', () => {
  const root = tmpRoot()
  const file = configFileOf(root)
  const marker = '只有-config-拿得到'
  assert.equal(fugue(root, 'config', 'set', 'config.marker', marker).code, 0)
  const real = readFileSync(file, 'utf8')
  assert.ok(real.includes(marker), `负对照：真文件里确实有这个字 —— ${file}`)
  assert.equal(fugue(root, 'config', 'get', 'config.marker').stdout, `${marker}\n`, '负对照：这条命令看得见真文件')

  // 视图那一面**每一条收路径的命令**，逐个拿这个名字去撞。判据是"吐不出真内容"，
  // 不是"退出码好看"：一条路只要拿到了真文件，这条断言就该红。
  const routes: string[][] = [
    ['read', '.fugue/config'],
    ['stat', '.fugue/config'],
    ['list', '.fugue'],
    ['read', './.fugue/config'],
    ['chmod', '.fugue/config', '755'],
    ['remove', '.fugue/config'],
    ['rename', '.fugue/config', '.fugue/other'],
  ]
  for (const args of routes) {
    const r = fugue(root, ...args)
    assert.ok(!r.stdout.includes(marker), `${args.join(' ')} 吐出了真配置`)
  }

  // 逃逸与绝对路径：**拒绝**，不是"归一化之后碰巧没找到"。这三条是视图路径空间的规矩。
  for (const bad of [
    ['read', '../.fugue/config'],
    ['read', join(root, '.fugue', 'config')],
    ['read', '.fugue//config'],
  ]) {
    const r = fugue(root, ...bad)
    assert.notEqual(r.code, 0, `${bad.join(' ')} 该被拒绝`)
    assert.ok(!r.stdout.includes(marker))
  }

  // 写同名路径：**落进视图**，而真文件一个字节都不动。视图里那个 `.fugue/` 是它自己的
  // （§ 9.10 的第三个目录：在视图里、可提交、被 M13 跳过）。
  const viewText = '视图里的同名文件\n'
  assert.equal(fugueStdin(root, viewText, 'write', '.fugue/config', '--stdin').code, 0)
  assert.equal(fugue(root, 'read', '.fugue/config').stdout, viewText, '视图里那一个是它自己的')
  assert.equal(fugue(root, 'config', 'get', 'config.marker').stdout, `${marker}\n`, '真配置没有被碰')
  assert.equal(readFileSync(file, 'utf8'), real, '真文件逐字节未变')

  for (const args of [
    ['chmod', '.fugue/config', '755'],
    ['rename', '.fugue/config', '.fugue/other'],
    ['remove', '.fugue/other'],
  ]) {
    assert.equal(fugue(root, ...args).code, 0, `${args.join(' ')} 在视图里该成功`)
  }
  assert.equal(fugue(root, 'commit', '-m', '视图里的 .fugue/').code, 0)
  assert.equal(readFileSync(file, 'utf8'), real, '视图那一面的每一条写路径都没碰到真文件')
})

test('P2a · 两级配置：系统打底工作区覆盖 · 写单级读合并 · 未知顶层键拒并指路 · 原值记录', async () => {
  const root = tmpRoot()
  const sys = tmpDir('fugue-sys-')
  const sysFile = join(sys, 'config')
  writeFileSync(
    sysFile,
    JSON.stringify({
      ports: { range: '32000-32099' },
      actions: { build: { argv: ['make'], env: { CC: 'cc' } } },
    }),
  )

  SYS_DIR = sys
  try {
    // ① 合并读（P2a 那条会红的断言）：工作区还是空的，系统级的键读得到——昨天 readConfig 只看工作区。
    const merged = await readConfig(root, sys)
    assert.equal(getConfig(merged, 'ports.range'), '32000-32099', '工作区空 → 系统级的默认顶上来')
    assert.equal(fugue(root, 'config', 'get', 'ports.range').stdout, '32000-32099\n', 'CLI 那一面也是合并读')

    // ② 工作区覆盖：只赢那一个叶子；系统文件一个字节不动；没碰的兄弟键还在（深合并不是整份替换）。
    assert.equal(fugue(root, 'config', 'set', 'ports.range', '"31000-31099"').code, 0)
    const after = await readConfig(root, sys)
    assert.equal(getConfig(after, 'ports.range'), '31000-31099', '工作区那份赢')
    assert.equal(getConfig(after, 'actions.build.env.CC'), 'cc', '没碰到的键从系统级来')
    assert.equal(
      (JSON.parse(readFileSync(sysFile, 'utf8')) as { ports: { range: string } }).ports.range,
      '32000-32099',
      '系统文件一个字节没动',
    )

    // 深合并到第三层：工作区往系统级给过的对象里加一个键，两边的键都在。
    assert.equal(fugue(root, 'config', 'set', 'actions.build.env.CFLAGS', '"-O2"').code, 0)
    assert.deepEqual(getConfig(await readConfig(root, sys), 'actions.build.env'), { CC: 'cc', CFLAGS: '-O2' })

    // ③ set --system 写系统那一级；工作区文件不掺；读那面（合并）看得见。
    assert.equal(fugue(root, 'config', 'set', '--system', 'boundary.enforcement', '"full"').code, 0)
    const sysDoc = JSON.parse(readFileSync(sysFile, 'utf8')) as Record<string, unknown>
    assert.equal((sysDoc['boundary'] as Record<string, unknown>)['enforcement'], 'full')
    const wsBefore = JSON.parse(readFileSync(configFileOf(root), 'utf8')) as Record<string, unknown>
    assert.equal('boundary' in wsBefore, false, '系统级写不落到工作区文件')
    assert.equal(fugue(root, 'config', 'get', 'boundary.enforcement').stdout, 'full\n', '读那面看得见系统级的键')

    // ④ 原值记录：两级各自跟各自的目标级；第一次写没有 old，覆盖写有。
    assert.equal(fugue(root, 'config', 'set', '--system', 'boundary.enforcement', '"partial"').code, 0)
    const sysLines = readFileSync(join(sys, 'config-history'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.equal(sysLines.length, 2, '两次系统级写各落一行')
    assert.equal(sysLines[0]?.['key'], 'boundary.enforcement')
    assert.equal('old' in (sysLines[0] ?? {}), false, '第一次写：键原本不在，old 这一栏不出现')
    assert.equal(sysLines[1]?.['old'], 'full', '覆盖写：old 是改之前那份')
    assert.ok(typeof sysLines[1]?.['at'] === 'string', '每行带时间')
    const wsLines = readFileSync(join(root, '.fugue', 'config-history'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.equal(wsLines.length, 2, '工作区那两次 set 落工作区的账，没进系统的')
    assert.equal(wsLines[0]?.['key'], 'ports.range')

    // ⑤ 防抄底：saveFacts 单级读——系统级有 boundary，落完事实工作区文件里没有它（没被吸进来）。
    await saveFacts(root, {
      fs: 'ext4',
      overlayfs: 'direct',
      overlayfsNote: 'probe',
      hardlink: true,
      whiteout: 'direct',
      whiteoutNote: 'probe',
    })
    const wsDoc = JSON.parse(readFileSync(configFileOf(root), 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(wsDoc).sort(), ['actions', 'platform', 'ports'], '系统级的键没被抄底固化进来')

    // ⑥ 退化档：系统根指空目录 → 合并读与单级读是同一份。
    const emptySys = tmpDir('fugue-sys-empty-')
    assert.deepEqual(await readConfig(root, emptySys), await readWorkspaceConfig(root), '没有系统级那一份时，读合并 === 单级读')

    // ⑦ 顶层键域：读那面拒绝加载并指路；写那面先拦（不然一次 set 就把文件写成之后每次读都拒的样子）。
    writeFileSync(sysFile, JSON.stringify({ ...sysDoc, modelz: {} }))
    const badShow = fugue(root, 'config', 'show')
    assert.notEqual(badShow.code, 0, '未知顶层键要拒绝加载')
    assert.match(badShow.stderr, /顶层只认/, '拒绝时指路：说出认得哪些')
    const badSet = fugue(root, 'config', 'set', 'who.what', '1')
    assert.notEqual(badSet.code, 0, '写那面也拦')
    assert.ok(badSet.stderr.includes('顶层'), `写那面的拒绝也指路：${badSet.stderr}`)
  } finally {
    SYS_DIR = EMPTY_SYS
  }
})
