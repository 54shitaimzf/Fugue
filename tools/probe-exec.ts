// 探针：**执行这一维**（S4 前检查）。取证用，不是产品的一部分。
//
// 五问，每一问都真起进程、真挂载、真写盘：
//
//   零 · 平台：bwrap · 非特权 userns · Landlock ABI · 物化树是不是 overlayfs · /dev 那一处
//   一 · 只读绑定 + 声明目录：树内四项写不写得动 · 声明目录写不写得动 · 产物落在哪一侧
//   二 · 沙箱骨架：一次真构建要哪几样绑定（/dev · 按 agent 的 temp · 声明目录）
//   三 · 越界写入的可观察面：子进程拿到哪个 errno · 父进程手里剩下什么（`run/end.denied` 怎么算）
//   四 · 「逐字节一致」的口径：同一棵树两趟 · 两棵不同的树 · 带调试信息的二进制 · tsc 的元数据
//   五 · N 路并发：四个沙箱同时跑、各绑各自的缓存，互不看见、跑完不留东西
//
// 跑法（ext4 上 · 仓库根）：node tools/probe-exec.ts
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/+$/, '')
const FUGUE = join(REPO, 'src/cli/fugue.ts')
const HOME = process.env.HOME ?? tmpdir()
const TSC = '/opt/node-v24.21.0-linux-x64/bin/tsc'
const AGENT = 'a1'

const WORK = mkdtempSync(join(HOME, 'probe-exec-'))
const OUT = mkdtempSync(join(HOME, 'probe-exec-out-'))
for (const d of ['home', 'tmp', 'xdg', 'out']) mkdirSync(join(OUT, d), { recursive: true })

const say = (s = '') => console.log(s)
const head = (t: string) => say('\n══ ' + t + ' ══')
const reading = (k: string, v: string) => say('  ' + k + '：' + v)

interface R { status: number; out: string; err: string }
function run(argv: string[], cwd?: string): R {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status ?? -1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}
const bash = (line: string, cwd?: string) => run(['bash', '-c', line], cwd)
function fugue(args: string[], cwd = WORK): R { return run(['node', FUGUE, '--root', WORK, ...args], cwd) }
function fugueJson(args: string[]): Record<string, unknown> {
  const r = fugue(['--json', ...args])
  if (r.status !== 0) throw new Error('fugue ' + args.join(' ') + ' → ' + r.status + '：' + r.err)
  return JSON.parse(r.out) as Record<string, unknown>
}
const one = (s: string) => s.trim().split('\n')[0] ?? ''
const count = (dir: string, what = '-type f') => one(bash('find ' + dir + ' ' + what + ' | wc -l').out)
const why = (r: R) => 'rc=' + r.status + ' · ' + (one(r.err) || one(r.out) || '（无输出）')

function treeMap(dir: string): Map<string, string> {
  const m = new Map<string, string>()
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(p, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) m.set(abs.slice(dir.length + 1), createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16))
      else m.set(abs.slice(dir.length + 1), 'other')
    }
  }
  if (existsSync(dir)) walk(dir)
  return m
}
const diffMaps = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort()

function fixture(dir: string): void {
  for (const d of ['src', 'include', 'dist', 'ts/src']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'dist/.keep'), '')
  writeFileSync(join(dir, 'include/h.h'), 'int a(void); int b(void);\n')
  writeFileSync(join(dir, 'src/a.c'), '#include "h.h"\nint a(void) { return 1; }\n')
  writeFileSync(join(dir, 'src/b.c'), '#include "h.h"\nint b(void) { return 2; }\n')
  writeFileSync(join(dir, 'src/main.c'), '#include <stdio.h>\n#include "h.h"\nint main(void) { printf("%d\\n", a() + b()); return 0; }\n')
  writeFileSync(join(dir, 'Makefile'), [
    '.RECIPEPREFIX = >', 'CC ?= cc', 'CFLAGS ?= -Iinclude', 'O ?= build',
    'SRC := $(sort $(wildcard src/*.c))', 'OBJ := $(patsubst %.c,$(O)/%.o,$(SRC))',
    'all: $(O)/app', '$(O)/%.o: %.c include/h.h', '> @mkdir -p $(dir $@)',
    '> $(CC) $(CFLAGS) -c -o $@ $<', '$(O)/app: $(OBJ)', '> $(CC) -o $@ $(OBJ)', '',
  ].join('\n'))
  writeFileSync(join(dir, 'ts/tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true,
      rootDir: './src', incremental: true, tsBuildInfoFile: './.tsbuildinfo',
      outDir: './dist', skipLibCheck: true,
    }, include: ['src'],
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'ts/src/x.ts'), 'export const x: number = 1\n')
  writeFileSync(join(dir, 'ts/src/y.ts'), 'export const y: number = 2\n')
}

/** 沙箱骨架。**每一项都可以关掉**——量的就是"少了哪一项会怎样"。 */
interface Skeleton { dev: boolean; temp: boolean; decl: boolean; writableTree: boolean }
function sandbox(merged: string, bindOut: string, sk: Partial<Skeleton> = {}): string[] {
  const s: Skeleton = { dev: true, temp: true, decl: true, writableTree: false, ...sk }
  const argv = ['bwrap', '--ro-bind', '/', '/', '--die-with-parent']
  if (s.dev) argv.push('--dev', '/dev')
  if (s.temp) argv.push('--bind', join(OUT, 'tmp'), join(OUT, 'tmp'))
  argv.push(
    '--setenv', 'HOME', join(OUT, 'home'),
    '--setenv', 'TMPDIR', s.temp ? join(OUT, 'tmp') : '/tmp',
    '--setenv', 'XDG_CACHE_HOME', join(OUT, 'xdg'),
    s.writableTree ? '--bind' : '--ro-bind', merged, merged,
  )
  if (s.decl) argv.push('--bind', bindOut, join(merged, 'dist'))
  argv.push('--chdir', merged)
  return argv
}
const inTree = (argv: string[], cmd: string) => run([...argv, 'bash', '-c', cmd])
const mk = (dir: string) => { mkdirSync(dir, { recursive: true }); return dir }

say('探针 · 执行这一维（S4 前检查）· 工作区 ' + WORK)
say('日期 ' + new Date().toISOString().slice(0, 10) + ' · 内核 ' + one(bash('uname -r').out) + ' · ' + one(bash('node -v').out) + ' · ' + one(bash('bwrap --version').out))

// ── 零 · 平台 ────────────────────────────────────────────────────────────────
head('零 · 平台')
reading('bwrap', one(bash('bwrap --version').out) + ' · 最小调用 ' + why(run(['bwrap', '--ro-bind', '/', '/', '/bin/true'])))
reading('非特权 userns', 'unshare -Ur true → ' + why(bash('unshare -Ur true')))
reading('当前用户', 'uid=' + one(bash('id -u').out) + ' · sudo -n ' + (bash('sudo -n true').status === 0 ? '通' : '不通'))
const llc = join(OUT, 'll.c')
writeFileSync(llc, '#include <stdio.h>\n#include <unistd.h>\n#include <sys/syscall.h>\nint main(void){ long v = syscall(444, 0, 0, 1U<<0); printf("%ld\\n", v); return 0; }\n')
if (run(['gcc', '-o', join(OUT, 'll'), llc]).status === 0) reading('Landlock ABI', one(run([join(OUT, 'll')]).out) + '（syscall 444 探测，不读 securityfs）')
else reading('Landlock ABI', '探针编译不过')

fixture(WORK)
run(['git', 'init', '-q', '-b', 'main', '.'], WORK)
run(['git', '-c', 'user.email=f@l', '-c', 'user.name=f', 'add', '-A'], WORK)
run(['git', '-c', 'user.email=f@l', '-c', 'user.name=f', 'commit', '-qm', '起点'], WORK)
const BASE = one(run(['git', 'rev-parse', 'HEAD'], WORK).out)
reading('基线提交', BASE.slice(0, 12) + ' · 分支头 ' + why(fugue(['--agent', AGENT, 'branch', BASE])))
const fork = fugueJson(['--agent', AGENT, 'fork', BASE])
const MERGED = String(fork.merged)
const UPPER = join(WORK, '.fugue', 'mat', AGENT, 'upper')
reading('fork', String(fork.strategy) + ' 档 · ' + MERGED)
reading('物化树挂载', one(bash('findmnt -no FSTYPE,SOURCE --target ' + MERGED).out) || '（没挂上）')
reading('upper', count(UPPER) + ' 个文件 · ' + count(UPPER, '-mindepth 1 -type d') + ' 个目录')
/** 物化树回到干净起点：负对照会改坏盘，后面每一节都要一个干净起点。 */
function reset(): string {
  fugue(['--agent', AGENT, 'dispose'])
  return String(fugueJson(['--agent', AGENT, 'fork', BASE]).strategy)
}
const RO = sandbox(MERGED, mk(join(OUT, 'out')))
reading('/dev/null（--ro-bind / / 之下）', why(inTree(sandbox(MERGED, mk(join(OUT, 'out')), { dev: false }), 'echo x > /dev/null')))
reading('/dev/null（加了 --dev /dev）', why(inTree(RO, 'echo x > /dev/null')))

// ── 一 · 只读绑定 + 声明目录 ─────────────────────────────────────────────────
head('一 · 只读绑定 + 声明目录（树内四项 · 声明目录一项 · 负对照一项）')
for (const [what, cmd] of [
  ['改一个已有文件', 'echo x >> src/a.c'],
  ['树内新建一个文件', 'echo x > src/new.c'],
  ['树内删一个文件', 'rm -f src/a.c'],
  ['写 /etc', 'echo x > /etc/probe-exec-x'],
] as const) reading('拒 · ' + what, why(inTree(RO, cmd)))
reading('可写 · 声明目录 dist/', why(inTree(RO, 'echo hello > dist/out.txt')))
reading('  产物落在哪', existsSync(join(OUT, 'out', 'out.txt')) ? '声明目录绑定里有 out.txt（' + one(bash('wc -c < ' + join(OUT, 'out', 'out.txt')).out) + ' 字节）' : '**没有**')
reading('  upper 里的文件数', count(UPPER) + '（跑之前 0）')
reading('  物化树里那个文件', existsSync(join(MERGED, 'dist', 'out.txt')) ? '**看得见**（不该）' : '看不见（绑定只活在沙箱里）')
reading('  lower 的 dist/.keep', existsSync(join(WORK, 'dist', '.keep')) ? '还在' : '**不在了**')

head('一之补 · 声明目录不在树里时（§ 8.6 第 1 步的必要性）')
const sbNoDir = sandbox(MERGED, mk(join(OUT, 'out2')), { decl: false })
sbNoDir.splice(sbNoDir.length - 1, 0, '--bind', join(OUT, 'out2'), join(MERGED, 'nodir'))
reading('绑一个树里没有的目录', why(run([...sbNoDir, '/bin/true'])))
head('一之负对照 · 把树换成可写绑定（§ 8.6 那句负对照）')
reading('可写树里改一个文件', why(inTree(sandbox(MERGED, join(OUT, 'out'), { writableTree: true }), 'echo x >> src/a.c')))
reading('upper 增量', '0 → ' + count(UPPER) + ' 个文件（' + one(bash('find ' + UPPER + ' -type f -printf "%P " 2>/dev/null').out) + '）')
reading('lower 的 src/a.c', JSON.stringify(one(bash('tail -c 24 ' + join(WORK, 'src/a.c')).out)) + '（真源没被穿透）')

// ── 二 · 沙箱骨架：一次真构建要哪几样 ────────────────────────────────────────
head('二 · 沙箱骨架：一次真构建（make + gcc）要哪几样')
const build = (dir: string, out: string, flags = '') => run(['make', '-C', dir, 'O=' + out, 'CFLAGS=-Iinclude ' + flags])
reading('重置（负对照改坏的盘）', reset() + ' 档')
reading('裸跑（沙箱外）', why(build(MERGED, mk(join(OUT, 'bare')))))
const bOut = mk(join(OUT, 'out', 'build'))
reading('沙箱内 · 产物落声明目录', why(inTree(RO, 'make O=' + join(MERGED, 'dist', 'build'))))
reading('  产物在哪', existsSync(join(bOut, 'app')) ? '声明目录绑定里' : '（没有 app）')
reading('  upper 里的文件数', count(UPPER) + ' · 物化树里 app ' + (existsSync(join(MERGED, 'dist', 'build', 'app')) ? '看得见' : '看不见'))
reset()
reading('负对照 · 不绑按 agent 的 temp', why(inTree(sandbox(MERGED, join(OUT, 'out'), { temp: false }), 'make O=' + join(MERGED, 'dist', 'build2'))))
reading('负对照 · 不给 --dev /dev', why(inTree(sandbox(MERGED, join(OUT, 'out'), { dev: false }), 'make O=' + join(MERGED, 'dist', 'build3'))))

// ── 三 · 越界写入的可观察面 ──────────────────────────────────────────────────
head('三 · 越界写入：子进程拿到什么 · 父进程剩下什么')
const errnoC = join(OUT, 'errno.c')
writeFileSync(errnoC, [
  '#include <stdio.h>', '#include <errno.h>', '#include <string.h>',
  '#include <fcntl.h>', '#include <unistd.h>',
  'int main(int argc, char **argv) {',
  '  int fd = open(argv[1], O_WRONLY | O_CREAT | O_APPEND, 0644);',
  '  printf("open → fd=%d errno=%d (%s)\\n", fd, errno, strerror(errno));',
  '  return fd < 0 ? 1 : 0;',
  '}', '',
].join('\n'))
run(['gcc', '-o', join(OUT, 'errno'), errnoC])
reading('C 里的 open()', one(inTree(RO, join(OUT, 'errno') + ' ' + join(MERGED, 'src/a.c')).out))
reading('bash 那一层的退出码', JSON.stringify(one(inTree(RO, 'echo x > src/new.c; echo rc=$?').out)))
const denied = inTree(RO, 'echo x > src/new.c')
reading('父进程能拿到的三样', 'exit=' + denied.status + ' · stderr=' + JSON.stringify(one(denied.err)) + ' · stdout=' + JSON.stringify(denied.out))
const rd = inTree(RO, 'cat ' + join(WORK, '.fugue', 'config') + '; echo rc=$?')
reading('整盘只读之下读真源', 'cat <realRoot>/.fugue/config → ' + JSON.stringify(one(rd.out)) + '（这一维是 S5 的 U13，不是 S4 的围栏）')
reading('收拾', why(fugue(['--agent', AGENT, 'dispose'])))

// ── 四 · 「逐字节一致」的口径 ────────────────────────────────────────────────
head('四 · 逐字节一致：同一棵树两趟 · 两棵不同的树 · -g · tsc 元数据')
const A = mk(join(OUT, 'same-a')); const B = mk(join(OUT, 'same-b'))
fixture(A); fixture(B)
const b1 = mk(join(OUT, 'ba1')); const b2 = mk(join(OUT, 'ba2')); const b3 = mk(join(OUT, 'bb1'))
reading('同一棵树两趟（make/gcc）', '两次都 ' + why(build(A, b1)) + ' / ' + why(build(A, b2)) + ' → ' + diffMaps(treeMap(b1), treeMap(b2)).length + ' 条不同')
reading('两棵不同的树（同一份源码）', why(build(B, b3)) + ' → ' + JSON.stringify(diffMaps(treeMap(b1), treeMap(b3))))
const g1 = mk(join(OUT, 'ga1')); const g2 = mk(join(OUT, 'gb1'))
build(A, g1, '-g'); build(B, g2, '-g')
reading('两棵不同的树 · -g', JSON.stringify(diffMaps(treeMap(g1), treeMap(g2))) + '（' + count(g1) + ' 个文件）')
reading('-g 两份 app 的字节', one(bash('cmp -s ' + join(g1, 'app') + ' ' + join(g2, 'app') + ' && echo 相同 || echo 不同').out) + ' · 大小 ' + one(bash('stat -c %s ' + join(g1, 'app')).out) + ' vs ' + one(bash('stat -c %s ' + join(g2, 'app')).out))
if (existsSync(TSC)) {
  const tsc = (dir: string) => run([TSC, '-p', dir])
  reading('tsc 第一趟', why(tsc(join(A, 'ts'))))
  const d1 = treeMap(join(A, 'ts', 'dist')); const i1 = readFileSync(join(A, 'ts', '.tsbuildinfo'), 'utf8')
  reading('tsc 同一棵树第二趟', why(tsc(join(A, 'ts'))) + ' → dist/ ' + diffMaps(d1, treeMap(join(A, 'ts', 'dist'))).length + ' 条不同')
  tsc(join(B, 'ts'))
  reading('tsc 两棵不同的树 · dist/', JSON.stringify(diffMaps(d1, treeMap(join(B, 'ts', 'dist')))))
  const i2 = readFileSync(join(B, 'ts', '.tsbuildinfo'), 'utf8')
  const leaked = i1.match(/\/home\/[^"]*/g) ?? []
  reading('tsc 两棵不同的树 · .tsbuildinfo', (i1 === i2 ? '相同' : '**不同**') + '（' + i1.length + ' vs ' + i2.length + ' 字节）· 里面 /home/ 开头的绝对路径 ' + leaked.length + ' 处' + (leaked[0] ? '，例如 ' + leaked[0] : ''))
} else reading('tsc', '不在 ' + TSC)

// ── 五 · N 路并发 ────────────────────────────────────────────────────────────
head('五 · 四个沙箱同时跑（各绑各自的缓存）')
fugueJson(['--agent', AGENT, 'fork', BASE])
const jobs = [1, 2, 3, 4].map((n) => new Promise<R>((res) => {
  const out = mk(join(OUT, 'par' + n))
  const p = spawn(sandbox(MERGED, out)[0], [...sandbox(MERGED, out).slice(1), 'bash', '-c', 'echo ' + n + ' > dist/n.txt; sleep 0.2; cat dist/n.txt'], { encoding: 'utf8' } as never)
  let so = ''; let se = ''
  p.stdout?.on('data', (d) => { so += d }); p.stderr?.on('data', (d) => { se += d })
  p.on('close', (code) => res({ status: code ?? -1, out: so, err: se }))
}))
const rs = await Promise.all(jobs)
reading('四路结果', rs.map((r, i) => '#' + (i + 1) + ' rc=' + r.status + ' 读到 ' + JSON.stringify(r.out.trim())).join(' · '))
reading('四份产物', [1, 2, 3, 4].map((n) => (existsSync(join(OUT, 'par' + n, 'n.txt')) ? '有' : '**没有**')).join(' '))
reading('upper 里的文件数', count(UPPER) + ' · 残留进程 ' + one(bash('pgrep -c bwrap 2>/dev/null || echo 0').out) + ' 个 bwrap · 物化树挂载 ' + one(bash('findmnt -rno TARGET | grep -c ' + MERGED + ' || echo 0').out) + ' 条')
reading('收拾', why(fugue(['--agent', AGENT, 'dispose'])) + ' → 挂载 ' + one(bash('findmnt -rno TARGET | grep -c ' + MERGED + ' || echo 0').out) + ' 条 · 四个坐标 ' + (existsSync(join(WORK, '.fugue', 'mat', AGENT)) ? '**还在**' : '一个不剩'))
say('\n收尾 · 工作区 ' + WORK + ' · 产物 ' + OUT + '（KEEP=1 才留）')
if (process.env.KEEP !== '1') bash('rm -rf ' + WORK + ' ' + OUT)
