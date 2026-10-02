// overlayfs 的挂 · 卸 · 查。**三件事，一处实现。**
//
// 出处：架构 § 8.5 的两条机制约束与"挂载的生命周期"。`fork` 挂上、`ensure` 先卸再挂回、
// `dispose` 卸载并删除——三处都要这三个动作，所以它们住在这里，不住在任何一个调用点里。
//
// **"谁挂的"不记在任何地方。** 卸载先试自己卸，卸不动再借 sudo——于是没有一份要跟着
// 物化目录一起维护的挂载记录，也就不存在"记录与事实不一致"这种状态。
//
// **怎么挂的是一门探出来的事实，不是猜的**（`capability.ts` 探、`fork` 用）：
//
//   `direct` —— 当前进程在 mount namespace 里有 CAP_SYS_ADMIN：以 root 跑，或者整个会话在
//               一个非特权 userns 里（§ 15.7 的 E3 说的正是这一档）。
//   `sudo`   —— 借 `sudo -n`（不交互，要密码就当场失败，不吊在半路）。
//
// **为什么不是"起个 userns 自己挂"**：那门 mount namespace 随进程退出一起消失，于是
// 下一条命令、以及站在目录里的人，谁都看不到那棵树。挂载要能被**别的进程**看见，就只能挂在
// 调用者自己那一门命名空间里。这条是实测出来的（V2 的探针记录）。
//
// 失败一律**带 argv 与 stderr 抛**：挂不上的原因（缺 lowerdir / workdir 不空 / userns 里
// 没有 overlay 支持）只有内核那句话说清楚，转述会丢掉它。
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AbsPath } from '../terms.ts'

export type MountMode = 'direct' | 'sudo'

export interface OverlaySpec {
  /** 底：真实工作树（§ 8.4——`fork` 不复制、不搬运）。 */
  readonly lower: AbsPath
  /** delta 落点，同时也是 overlay 的 `upperdir`。 */
  readonly upper: AbsPath
  /** overlay 自己的 `workdir`，**要在同一个文件系统上**，且每次挂载前是空的。 */
  readonly work: AbsPath
  /** 挂载点：执行看到的那个坐标（§ 8.4）。 */
  readonly merged: AbsPath
}

export class MountError extends Error {
  readonly argv: readonly string[]
  readonly status: number
  readonly stderr: string

  constructor(what: string, argv: readonly string[], status: number, stderr: string) {
    super(`${what}：${argv.join(' ')} 退出码 ${status}${stderr === '' ? '' : '：' + stderr}`)
    this.name = 'MountError'
    this.argv = argv
    this.status = status
    this.stderr = stderr
  }
}

export interface Ran {
  status: number
  stderr: string
  /** 工具链探针（P3a，toolchain.ts）带进来的需求：读数就是 stdout 的首行。 */
  stdout: string
}

/**
 * 起一个进程，原样收它的退出码与 stderr（还有 stdout——探针要的那一份）。
 * **不走 shell**：路径里有什么字符都不该被解释。这一层的子进程跑手就这一个：
 * 挂载 · sudo 探测 · 工具链探针（P3a，toolchain.ts）共用它。
 *
 * **0.2.9 ④ 到这里看过，结论是这两个"非 0"撤不得——它们是地板，不是兜底造值。**
 * `spawnSync` 起不动一个命令时给 `error`（`status` 是 `null`），被信号杀掉时也是 `status === null`；
 * 两种都由这里翻成一个非 0 的数 + 那句原话。两个消费者靠的正是这个宽容：
 *   · `sudoAvailable()` 见非 0 就答"不通"——`capability.ts` 据此把 overlayfs 与 whiteout 判成
 *     `null`，`fork`/`ensure` 于是沿 `hardlink-ro` → `copy` 往下退（这是"变慢"，不是"跑不起来"）；
 *   · `probeOnce()` 见非 0 就写一条 `null` 读数（工具链探针那一档的地板）。
 * 把这两种情形改成 throw，掀掉的就是那两级地板。**什么条件下改主意**：`Ran` 长出"没跑成"与
 * "跑成了、退出码是几"两栏，调用点各自按栏读——那时这里才谈得上分类。
 */
function run(argv: readonly string[]): Ran {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
  if (r.error !== undefined) {
    return { status: 127, stderr: `这个命令没起来：${String((r.error as Error).message)}`, stdout: '' }
  }
  return { status: r.status ?? 127, stderr: (r.stderr ?? '').trim(), stdout: r.stdout ?? '' }
}

/** 出口名带上语境：这一层里叫 `run` 太裸，外面要的是「按 argv 起、收三样」。 */
export { run as runArgv }

/** `sudo -n` 走得通吗。**`-n` 是这一条的全部**：要密码就当场失败，绝不吊在那里等人敲。 */
export function sudoAvailable(): boolean {
  return run(['sudo', '-n', 'true']).status === 0
}

function mountArgv(spec: OverlaySpec, mode: MountMode): string[] {
  const opts = `lowerdir=${spec.lower},upperdir=${spec.upper},workdir=${spec.work}`
  const tail = ['mount', '-t', 'overlay', 'overlay', '-o', opts, spec.merged]
  return mode === 'sudo' ? ['sudo', '-n', ...tail] : tail
}

/** 挂上。挂不上抛 `MountError`——**不降级、不重试**：退档是 `fork` 的判断，不是这里。 */
export function mountOverlay(spec: OverlaySpec, mode: MountMode): void {
  const argv = mountArgv(spec, mode)
  const r = run(argv)
  if (r.status !== 0) throw new MountError('overlay 挂不上', argv, r.status, r.stderr)
}

/**
 * 挂上前把 `work` 备好。overlay 要求 `workdir` 存在、与 `upperdir` 同盘、且是空的。
 *
 * **它是内核的草稿本，不是我们的东西**：一次没卸干净的挂载会在这里留下残渣，而残渣会让下一次
 * 挂载报"workdir not empty"。所以清它不是宽容，是那道要求的另一半。
 */
export function mountOverlayReady(spec: OverlaySpec, mode: MountMode): void {
  mkdirSync(spec.work, { recursive: true })
  for (const name of readdirSync(spec.work)) removeTree(join(spec.work, name))
  mountOverlay(spec, mode)
}

/**
 * 造一条 whiteout：字符设备 0:0。**它是 overlayfs 眼里的"这儿没有"**——`upper` 里没有这条时，
 * 那个路径上的内容由下层给；有这条时，它被挡掉（§ 8.5 的 `delete` 那一情形）。
 *
 * 实测（内核 6.18 · WSL2）：非特权 `mknod <p> c 0 0` 成功，而同一条路上的 `c 1 3` 与 `b 8 0`
 * 都是 EPERM——内核对 0:0 留了豁免，所以这一件事不要任何特权。没有那条豁免的内核上借
 * `sudo -n`，两档都不通由 `capability.ts` 探出来并据此判 overlayfs 那一档不可用。
 *
 * **`mknod` 是外部程序**：Node 的 `fs` 里没有这个调用（设备号是内核那一侧的入参）。
 */
export function makeWhiteout(abs: AbsPath, mode: MountMode): void {
  const tail = ['mknod', abs, 'c', '0', '0']
  const argv = mode === 'sudo' ? ['sudo', '-n', ...tail] : tail
  const r = run(argv)
  if (r.status !== 0) throw new MountError('whiteout 造不出来', argv, r.status, r.stderr)
}

/**
 * 卸下 `merged`。没挂着给 `null`；挂着就返回**实际用了哪一门**。
 *
 * 先试自己卸：以 root 跑、或在会话自己的 userns 里时它就成了，不必多起一个进程。
 */
export function unmountOverlay(merged: AbsPath): MountMode | null {
  if (!isMounted(merged)) return null
  const direct = ['umount', merged]
  const r = run(direct)
  if (r.status === 0) return 'direct'
  const viaSudo = ['sudo', '-n', 'umount', merged]
  const s = run(viaSudo)
  if (s.status === 0) return 'sudo'
  throw new MountError('overlay 卸不下来', viaSudo, s.status, s.stderr)
}

/**
 * `p` 此刻是不是一个挂载点。**读 `/proc/self/mountinfo`，不调 `mountpoint`**：少一个进程，
 * 而且答案就是内核此刻的那张表，不是某个工具对它的转述。
 *
 * 一个直接后果要记住：表是**本进程这一门 mount namespace 的**。别人命名空间里的挂载在这里
 * 看不见——这正是"挂载要挂在自己这一门里"那句话的另一面。
 */
export function isMounted(p: AbsPath): boolean {
  let text: string
  try {
    text = readFileSync('/proc/self/mountinfo', 'utf8')
  } catch {
    return false
  }
  for (const line of text.split('\n')) {
    if (line === '') continue
    const f = line.split(' ')
    // 第 5 个字段是挂载点（1 起数）。空格与反斜杠在那一栏里是八进制转义的。
    if (f.length < 5) continue
    if (unescapeMountField(f[4]) === p) return true
  }
  return false
}

/** mountinfo 的转义：空格 · 制表 · 换行 · 反斜杠写成 `\040` 这样的三位八进制。 */
export function unescapeMountField(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

/**
 * 卸干净再删掉：`dispose`（V5）与"重来一次"的 `fork` 都要它。**删掉的是整份物化**
 * （`upper` · `merged` · `tmp` · `cache` 四个坐标，§ 8.4），目录由调用点重建。
 *
 * **先卸后删是硬顺序。** 挂着的时候删挂载点，删的其实是底下那棵树——overlay 把底摊在挂载点
 * 上，于是"删掉派生物"那一步会变成"删掉真源"。§ 8.5 的失败处理说的是"删除重建"，那句里
 * 的删除只对**没挂着**的物化目录成立，所以这个顺序不能由调用点各自记着。
 */
export function clearMaterialization(merged: AbsPath, parts: readonly AbsPath[]): void {
  unmountOverlay(merged)
  for (const p of parts) removeTree(p)
}

/**
 * 删一棵树。**`rmdir` 先试，`readdir` 才往下走。**
 *
 * 这一句不是优化，是 `overlayfs` 那一门留下的一个事实：内核自己在 `work/` 里建的
 * `work/work` 是 `root:root 000`，谁都读不了它。`fs.rmSync(recursive)` 会先 `readdir` 每个
 * 目录，于是在它上面吃 `EACCES`——而那个目录是**空的**，`rmdir` 一步就完。实测：`rm -rf`
 * 删得掉、`fs.rmSync` 删不掉，差别就在这一步的顺序。
 *
 * 软链只删它自己，不跟进去（跟进去删的是别人家的树）。
 */
/**
 * 删一棵树。**两步：先自己删，删不动再请 `sudo -n`。**
 *
 * `rmdir` 先试、`readdir` 才往下走：这一句不是优化，是 `overlayfs` 那一门留下的一个事实——
 * 内核自己在 `work/` 里建的 `work/work` 是 `root:root 000`，谁都读不了它；而那个目录是**空的**，
 * `rmdir` 一步就完。实测：`rm -rf` 删得掉、`fs.rmSync` 删不掉，差别就在这一步的顺序。
 *
 * **而 `rmdir` 也不一定够。** `sudo` 那一档里挂载是请 root 做的，于是那些残渣属于 root
 * 而上层目录不可写：实测 `work/work` 是 `uid 0` 而 `work` 是 `uid 1000`，于是 `rmdirSync` 报 `EPERM` 而
 * `readdirSync` 报 `EACCES`——**同一格里第二次 `bash` 当场卡在 `mountOverlayReady` 上**（本地
 * 实测读到的就是这一条）。所以这里多一步：自己删不动就把同一条命令交给 `sudo -n`
 * ——**与挂载那一条同一门**（`mountArgv` 也是这样），而 `-n` 保证不会吊在那里等人敲。
 *
 * 软链只删它自己，不跟进去（跟进去删的是别人家的树）。
 */
export function removeTree(p: AbsPath): void {
  try {
    removeTreeDirect(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // 只在**权限不够**时才请人：其他的失败是别的毛病，请 root 也治不了。
    if (code !== 'EACCES' && code !== 'EPERM') throw err
    const r = run(['sudo', '-n', 'rm', '-rf', p])
    if (r.status !== 0) throw err
  }
}

function removeTreeDirect(p: AbsPath): void {
  let st
  try {
    st = lstatSync(p, { throwIfNoEntry: false })
  } catch {
    return
  }
  if (st === undefined || st === null) return
  if (!st.isDirectory()) {
    unlinkSync(p)
    return
  }
  try {
    rmdirSync(p)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err
  }
  for (const name of readdirSync(p)) removeTree(join(p, name))
  rmdirSync(p)
}
