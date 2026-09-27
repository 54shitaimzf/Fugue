// V0 · 物化的落点与虚拟路径围栏。出处：PLAN § 5.2 的 V0 行 · 架构 § 8.4 · § 15.7 的 E1。
//
// 三条断言，各对着一条会失效的机制：
//
//   ① 往返与前缀守恒      ← 落点算术只有一处实现；错一处就会造出一串树外的物理路径
//   ② 三类拒绝            ← 虚拟空间可达集 == 物理空间可达集（§ 8.4 的验证性质）
//   ③ 9p / drvfs 拒绝启动 ← E1 是硬要求，而它的失败模式是静默的（§ 15.7 · § 15.8）
//
// 两条负对照在下面各自的位置上：② 的那条逃逸路在真实树上**确实**通到 `/etc/passwd`
// （`readFileSync` 证明得到，所以拒绝它不是"那条路本来就不存在"）；③ 里原生落点上的命令
// 照常退 0（所以拒绝不是一律拒）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { AgentId } from '../terms.ts'
import type { Denied } from './contract.ts'
import type { HostFacts } from './host.ts'
import { HostError, assertHost, hostRefusal, probeHost } from './host.ts'
import { createRoots } from './roots.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const A = 'round' as AgentId

function fugue(root: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

/** 一张判据表上的事实，不进文件系统。 */
function facts(magic: number, fs: string, cls: HostFacts['class']): HostFacts {
  return { root: '/x', probed: '/x', magic, fs, class: cls }
}

test('① 落点：往返 · 前缀守恒 · 非法 RelPath 与非法身份当场抛', () => {
  const root = tmpDir('fugue-roots-')
  const roots = createRoots(root)
  assert.equal(roots.realRoot, root)

  // 四个根的形状逐字对架构 § 8.4：`<realRoot>/.fugue/mat/<agent>/{upper, merged, tmp, cache}`
  assert.equal(roots.scratchRoot(A), join(root, '.fugue', 'mat', 'round', 'upper'))
  assert.equal(roots.mergedRoot(A), join(root, '.fugue', 'mat', 'round', 'merged'))
  assert.equal(roots.tempRoot(A), join(root, '.fugue', 'mat', 'round', 'tmp'))
  assert.equal(roots.cacheRoot(A), join(root, '.fugue', 'mat', 'round', 'cache'))
  const four = [roots.scratchRoot(A), roots.mergedRoot(A), roots.tempRoot(A), roots.cacheRoot(A)]
  assert.equal(new Set(four).size, 4, '四个根是四个坐标')

  const inside = (abs: string, base: string): boolean => abs === base || abs.startsWith(base + '/')
  const rels = ['', 'a.txt', 'src/deep/b.txt', '带 空格/文件.txt', 'dir.with.dots/x', "q'uote", 'a/b/c/d/e']

  for (const rel of rels) {
    // 往返：拆开拼回去还是原来那一串
    assert.equal(roots.fromScratch(A, roots.toScratch(A, rel)), rel, `往返：${rel}`)
    // 前缀守恒：两个 to* 的输出恒在声明的两个根之内，且拼出来的一串里不带 ..
    for (const [abs, base] of [
      [roots.toScratch(A, rel), roots.scratchRoot(A)],
      [roots.toMerged(A, rel), roots.mergedRoot(A)],
      [roots.toReal(rel), roots.realRoot],
    ] as const) {
      assert.ok(inside(abs, base), `${abs} 该在 ${base} 之内`)
      assert.equal(abs.includes('..'), false, `${abs} 里不该有 ..`)
    }
  }

  // 负对照：`toReal` 出来的坐标不在物化根下面——所以"在不在根下面"这句判断不是恒真的
  const away = roots.fromScratch(A, roots.toReal('src/deep/b.txt'))
  assert.equal(typeof away === 'string' ? 'rel' : away.outside, true, '真实树里的坐标不在 scratchRoot 下面')
  // 拆出来不是一条视图内的路径（多一个结尾 /）时也是 Outside，而不是一条带斜杠的 RelPath
  const odd = roots.fromScratch(A, roots.scratchRoot(A) + '/a/../b')
  assert.equal(typeof odd === 'string' ? 'rel' : odd.outside, true)

  // 非法 RelPath 当场抛——拼物理路径这一侧不接受没解析过的字符串
  for (const bad of ['../x', 'a/../../b', '/abs', 'a//b', 'a/./b', 'a\\b']) {
    assert.throws(() => roots.toScratch(A, bad), `${JSON.stringify(bad)} 该抛`)
    assert.throws(() => roots.toReal(bad), `${JSON.stringify(bad)} 该抛`)
  }

  // 身份名同时是一条路径（W3 起按段展开），所以每一段都得是一个能当目录名的段
  for (const bad of ['..', '', 'a//b', '.hidden', 'a\\b', 'a/./b', '/a']) {
    assert.throws(() => roots.scratchRoot(bad as AgentId), `${JSON.stringify(bad)} 该抛`)
  }
  // **带 `/` 的名字是合法的**（架构 § 4 的 `agent/<round>/<n>`）：它按段展开，不是被拒
  assert.equal(
    roots.scratchRoot('agent/r1/1' as AgentId),
    join(root, '.fugue', 'mat', 'agent', 'r1', '1', 'upper'),
    '带 / 的名字按段展开',
  )
  // 落点要绝对且规整：`.` 与结尾带 / 的都当场抛，而不是拼出一串相对坐标
  assert.throws(() => createRoots('.'))
  assert.throws(() => createRoots(root + '/'))
})

test('② 围栏：.. 穿越 · 绝对路径 · 逃逸软链 → Denied（lstat 在解析之前）', () => {
  const root = tmpDir('fugue-fence-')
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.txt'), 'a\n')
  writeFileSync(join(root, 'src', 'deep', 'b.txt'), 'b\n')
  symlinkSync('/etc', join(root, 'esc')) // 指着工作区外
  symlinkSync('src', join(root, 'link-inside')) // 指着工作区里
  symlinkSync('link-inside', join(root, 'chain')) // 链式
  symlinkSync('nowhere', join(root, 'dangling')) // 悬空
  const roots = createRoots(root)

  function ok(raw: string, cwd = ''): string {
    const r = roots.resolveVirtual(raw, cwd)
    assert.equal(r.ok, true, `${raw} 该放行：${r.ok ? '' : r.error.message}`)
    return r.ok ? r.value : ''
  }
  function denied(raw: string, cwd = ''): Denied {
    const r = roots.resolveVirtual(raw, cwd)
    assert.equal(r.ok, false, `${raw} 该被拒`)
    return r.ok ? (null as unknown as Denied) : r.error
  }

  // 放行的：视图内的路径 · shell 式的两种写法 · 不越界的 .. · 空串与 . 读成 cwd
  assert.equal(ok('src/a.txt'), 'src/a.txt')
  assert.equal(ok('./src/a.txt'), 'src/a.txt')
  assert.equal(ok('src/a.txt/'), 'src/a.txt')
  assert.equal(ok('src/deep/../a.txt'), 'src/a.txt')
  assert.equal(ok('a.txt', 'src'), 'src/a.txt')
  assert.equal(ok('.', 'src/deep'), 'src/deep')
  assert.equal(ok('', 'src'), 'src')
  // 最后一段允许是软链：删它 · 改名 · 看形状都是对那个条目本身的操作
  assert.equal(ok('esc'), 'esc')
  assert.equal(ok('../esc', 'src'), 'esc', '从 src 往上走到 esc：最后一段是软链，本身不构成穿越')
  // 真实树上还不存在的路径照常放行——写新文件走的就是它
  assert.equal(ok('nope/deep/new.txt'), 'nope/deep/new.txt')

  // 越界 · 绝对路径 · 写错了的写法
  assert.equal(denied('..').kind, 'escape')
  assert.equal(denied('../../etc/passwd', 'src').kind, 'escape')
  assert.equal(denied('/etc/passwd').kind, 'absolute')
  assert.equal(denied('a//b').kind, 'not-a-path')
  assert.equal(denied('a\\b').kind, 'not-a-path')

  // 逃逸软链：**负对照在前**——那条路在真实树上真的通到 /etc/passwd
  const leak = readFileSync(join(root, 'esc', 'passwd'), 'utf8')
  assert.ok(leak.includes('root'), '负对照：物理上确实穿过 esc 读到了 /etc/passwd')
  assert.equal(denied('esc/passwd').kind, 'through-symlink')
  // 指着工作区里面的软链一样拒：判据是可达集相等，不是"目标在不在工作区里"
  assert.equal(denied('link-inside/a.txt').kind, 'through-symlink')
  assert.equal(denied('chain/x').kind, 'through-symlink')
  assert.equal(denied('dangling/x').kind, 'through-symlink')
  // 软链那一条指出挡在哪一段
  assert.equal(denied('link-inside/a.txt').at, 'link-inside')

  // 拒绝文案指路，不筑墙（§ 8.4 纪律 2）
  const out = denied('/etc/passwd')
  assert.match(out.message, /outside the workspace|paths inside the view are relative/)
  assert.match(out.message, /goes through an application \(§ 15\.3\.b\)/)
  assert.equal(out.raw, '/etc/passwd')
  assert.match(denied('esc/passwd').message, /symlink/)
})

test('③ 落点探测：9p / drvfs 拒绝启动并说出原因（E1 是硬要求）', (t) => {
  // 一 · 判据表：原生放行 · 跨边界拒 · 认不得拒（fail-closed）
  assert.equal(hostRefusal(facts(0xef53, 'ext2/3/4', 'native')), null)
  assert.equal(hostRefusal(facts(0x01021994, 'tmpfs', 'native')), null)
  for (const [magic, fs] of [
    [0x01021997, '9p / drvfs'],
    [0x65735546, 'fuse（含 virtiofs）'],
    [0x6969, 'nfs'],
  ] as const) {
    const why = hostRefusal(facts(magic, fs, 'cross-boundary'))
    assert.ok(why !== null, `${fs} 该被拒`)
    assert.ok(why.includes(fs), `文案要点名是哪一档：${why}`)
    assert.match(why, /E1/)
    assert.match(why, /13–40|700–1000/, '文案要给出可观测的代价，不是一句"不支持"')
    assert.match(why, /ext4/, '拒绝要指路')
  }
  const unknown = hostRefusal(facts(0x1234, '0x1234', 'unknown'))
  assert.ok(unknown !== null, '认不得的不放行：E1 的失败模式是静默的')
  assert.match(unknown, /认不得/)

  // 二 · 真落点：测试临时目录所在的那一档必须是原生的，且命令照常退 0（负对照：不是一律拒）
  const mine = tmpDir('fugue-host-')
  const here = probeHost(mine)
  assert.ok(here !== null, `探不动 ${mine}`)
  assert.equal(here.class, 'native', `测试临时目录落在 ${here.fs} 上`)
  assert.equal(assertHost(mine)?.class, 'native')
  const fine = fugue(mine, 'config', 'show')
  assert.equal(fine.code, 0, fine.stderr)
  assert.equal(fine.stdout, '{}\n')
  // 根还不存在：探它最近的祖先，一样不误拒（命令自己报"工作区根不存在"或给出空配置）
  assert.equal(fugue(join(mine, 'ghost'), 'config', 'show').code, 0)

  // 三 · 跨边界的真落点：本机有 /usr/lib/wsl/drivers 与 /mnt/c 两个 9p 落点。有就端到端跑一次
  const cross = crossBoundaryMounts()
  if (cross.length === 0) {
    t.diagnostic('这台机器上没有一个跨边界的落点，第三条只走到判据表')
    return
  }
  const at = cross[0]
  const probed = probeHost(at)
  assert.ok(probed !== null && probed.class === 'cross-boundary', `${at} 该探成跨边界：${probed?.fs}`)
  assert.throws(() => assertHost(at), HostError)
  // 端到端：命令行拒绝启动，而不是某一条命令自己拒
  for (const args of [
    ['config', 'show'],
    ['read', 'x'],
  ]) {
    const r = fugue(at, ...args)
    assert.notEqual(r.code, 0, `--root ${at} ${args.join(' ')} 该被拒`)
    assert.match(r.stderr, /\[host: /)
    assert.ok(r.stderr.includes(probed.fs), `文案要点名 ${probed.fs}：${r.stderr}`)
    assert.equal(r.stdout, '', '拒绝时不吐半份输出')
  }
})

/** `/proc/self/mounts` 里的跨边界落点（fstype 认得出的那几种），按出现顺序。 */
function crossBoundaryMounts(): string[] {
  const CROSS = ['9p', 'virtiofs', 'cifs', 'smb3', 'smbfs', 'nfs', 'nfs4']
  let text: string
  try {
    text = readFileSync('/proc/self/mounts', 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  for (const line of text.split('\n')) {
    const cols = line.split(' ')
    if (cols.length < 3) continue
    const type = cols[2]
    if (!CROSS.includes(type) && !type.startsWith('fuse')) continue
    const at = cols[1].replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)))
    if (!existsSync(at)) continue
    out.push(at)
  }
  return out
}
