// S5 的判据：**逃逸用例集**（架构 § 8.4 的验证性质 · § 20 的 S5 交付物 · PLAN § 5.5 的 Y1 行）。
//
// 一条用例 = **一条路 · 期望 · 读法**。判据先立（§ 2.3 点名的"每站的第一个单元"）：这张表是
// 这一站每一处机制共同的尺子——Y3 的可达集 · Y5 的网络 · Y6 的第二层，各自的"被拒"都要用
// 同一句话说得出来。没有它，四条验证各说各话。
//
// 三件东西各就各位：
//   · `ESCAPE_CASES` —— **表**。数据，不是回调：能打印、能逐条引用出处、能被测试点着名字找。
//   · `runEscapeTable()` —— **跑器**。照 `confine()` 的 argv 起一次，收退出码 · stdout 与最后
//     那句文案，按这条用例的读法算出一个读数。
//   · `applySetups()` —— **摆形状**。物化之前把表里那几条路摆出来（软链 · 硬链接 · 目录）。
//
// ## 表里的坐标是记号，不是路径
//
// `@work` 是**子进程眼里的树根** · `@real` 是**树在宿主上的路径** · `@cache` 是它的家 ·
// `@outside` 是工作区之外、那个人自己写得动的一处 · `@home` 是宿主那个家（不是本 agent 的
// 缓存）。**同一张表两个坐标面**（Y3 落的）：argv 那一侧按 `fx.coords` 翻——沙箱档的 `work`
// 是挂载点 `/work`；**读数**那一侧按 `fx.host` 翻——读文件的是跑器自己，它在宿主上，读不到
// `/work`。表一个字节没动，改的只是跑器里那两张表。
//
// 今天 `@work` 与 `@real` 落在两条不同的路径上，可它们问的仍不是同一件事：前者问"树里的东西
// 读得到吗"（该通），后者问"宿主上那条路径够得着吗"（该拒）。Y3 之前它们是同一棵树，那两条
// 读数因此也都是"通"——正是这一站要关掉的那件事。
//
// ## 今天读到什么（Y3 之后：`confine()` 落的是清单，不是整个宿主）
//
//   甲 该通      树内读 · 树内读（相对 cwd）· 声明目录写 · 本 agent 的家          四条全"通"
//   乙 树内该拒  原地改源文件 · 树内新建 · 删除源文件                              三条全"拒"（内核 EROFS）
//   丙 树外该拒  写工作区外 · 绝对路径读宿主 · `..` 穿越读宿主 · 软链指向树外 ·
//                经 /proc 的另一条坐标 · shell 里 cd / 再读                          **六条全"拒"**
//   丁 宿主该拒  工作区配置 · 工作区日志 · 真源工作树（宿主路径）·
//                别家的物化树（宿主路径）· 宿主那个家 · 挂进来的宿主盘               **六条全"拒"**
//
// **十九条里十九条**：该通的四条通着，该拒的十五条拒着。Y1 立表那天这里写的是九条"该拒而
// 今天通"（`f9ff1b7` 的逐条复现），Y3 把它们逐条翻了过来——那正是 Y3 的断言 ①。
//
// ## 量过、但没进这张表的一条（硬链接别名）
//
// 架构 § 8.4 的逃逸用例集里列了"硬链接别名"。**在物理侧它不是一条路**，两半各量了一次：
// 读它（`<树>/hard-alias.txt` 与工作区外那条文件共享 inode）读得到内容——可那条路径就在树
// 里，走的每一步都在工作区内，够到的不是"工作区之外"；写它，工作区外那条**一个字节没变**
// （overlayfs 的 copy-up 把 inode 断开了，实测：退化档里退 0，而树外那份还是原样）。
// 于是它既没有"该拒"的读数，也给不出一句指路（§ 8.4 纪律 2 要求拒绝必须指路）。它真正的
// 归处是物化的档（§ 8.5 的 `copy` 一档断得开）与合并前的检测（§ 8.14），不是 `M7`。
// **这一条进请示**（PLAN § 5.5 尾那三处之外的第四处），不由这一单元悄悄定下来。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { confine, degradedArgv } from './confine.ts'
import type { ConfinedArgv } from '../execute/contract.ts'
import type { Roots } from '../roots/contract.ts'
import type { AgentId, RelPath } from '../terms.ts'
import type { Policy } from './policy.ts'

/** 通 · 拒。**只有一个含义**：那条路走通了没有（够到了 · 做成了）。 */
export type Verdict = 'pass' | 'deny'

/** 这条用例按架构该是"通"还是"拒"。 */
export type Want = 'pass' | 'deny'

/**
 * 四组。**组名是判据的一部分**：第四条验证（Y3）的负对照按最后一组点名——那六条今天全"通"。
 */
export const GROUPS = {
  ok: '甲 · 该通',
  inside: '乙 · 树内该拒',
  outside: '丙 · 树外该拒',
  leak: '丁 · 宿主那一侧该拒',
} as const
export type Group = (typeof GROUPS)[keyof typeof GROUPS]

/**
 * 表里的五个坐标记号。**它们不是路径**：同一条用例在两个档上问的是同一件事，落到哪个宿主
 * 路径由这一次的档与这一处口径决定（架构 § 8.6 那张表的头三行 · Y3 的第三处待批）。
 */
export type Coord = 'work' | 'real' | 'cache' | 'outside' | 'home'

/**
 * 读法：那个事实从哪儿取，以及**它等于什么的时候算"通"**。
 *
 * 五样里三样是**事后的宿主事实**（落点在不在 · 字节变没变），只有 `exit` 听子进程的：因为
 * "读不到"与"没读"在文件系统上不留痕迹，退出码是那条路唯一的证据。凡写得动的，一律看落点
 * ——子进程报成功而盘上没变，那也是一种读数，而且是要紧的那一种。
 */
export type Reading =
  | { readonly how: 'exit' }
  | { readonly how: 'exists'; readonly at: string; readonly passWhen: 'present' | 'absent' }
  | {
      readonly how: 'anyOf'
      /** 每一处带一个名字：读数要说得清落在了哪一侧，而不是只报一个数。 */
      readonly at: readonly { readonly where: string; readonly path: string }[]
      readonly passWhen: 'present' | 'absent'
    }
  | { readonly how: 'bytes'; readonly at: string; readonly passWhen: 'differs' | 'same' }
  | { readonly how: 'stdout'; readonly has: string }

/**
 * 宿主侧的准备。**三种封死**：这一站要摆的形状就这三种（软链 · 硬链接 · 空目录）——多一种
 * 就得在这里多一个分支，而不是在表里多写一句自由文本。
 *
 * `at` 一律写 `@real/…`：**摆形状发生在物化之前**，那时 `@work` 还没有（树还没挂）。
 */
export type Setup =
  | { readonly do: 'symlink'; readonly at: string; readonly to: string }
  | { readonly do: 'hardlink'; readonly at: string; readonly to: string }
  | { readonly do: 'mkdir'; readonly at: string }

interface CaseBase {
  /** 表里唯一的名字。报读数、点着名字找一条用例（Y3 的负对照）都靠它。 */
  readonly name: string
  readonly group: Group
  /** 子进程要跑的那个命令行。坐标写记号，由跑器翻成这一次的真路径。 */
  readonly argv: readonly string[]
  /** 视图内的相对路径：子进程从哪儿起步（`''` 是视图的根，§ 8.4 的"子进程继承 cwd"）。 */
  readonly cwd: RelPath
  readonly read: Reading
  readonly setup?: readonly Setup[]
  /** 出处：架构的哪一句把这条放进了这一份。 */
  readonly cites: string
  /** 这一条今天读出来是什么、为什么。给读表的人看，也是提交信息里那份读数的底稿。 */
  readonly note: string
}

/** 该通的那几条：仪器可证伪的那一半——一台只会说"拒"的仪器在这里当场露馅。 */
export interface PassingCase extends CaseBase {
  readonly want: 'pass'
}

/**
 * 该拒的那几条。**`remedy` 是必填的**（架构 § 8.4 纪律 2：拒绝文案指路，不筑墙）——少一条
 * 指路，这一条用例就编不过去，而不是留到评审时靠人眼看。
 *
 * 它存的是那句文案里**必须出现的那一段**，不是整句：措辞归 Y3（物理侧那句话由它落），
 * 这一栏只管"有没有把人指向替代能力"。
 */
export interface DeniedCase extends CaseBase {
  readonly want: 'deny'
  readonly remedy: string
}

export type EscapeCase = PassingCase | DeniedCase

/**
 * 本 agent 与另一个 agent 的名字。**由这里一处给**：fixture 按它物化，表按它问路——两处
 * 漂移的话，读数会变成"路径不存在"，而那不是边界拦的（一个假的"拒"）。
 */
export const AGENT: AgentId = 'agent/r1/1'
export const OTHER_AGENT: AgentId = 'agent/r1/2'

/** 表里点到的那两条树内路径。同上：一处给，两处用。 */
export const PROBE_FILES = { a: 'src/a.c', b: 'src/b.ts' } as const

/** 树里那条软链的名字（指向工作区之外）。 */
export const OUT_LINK = 'out-link'

/**
 * 这一档声明的目录（架构 § 8.6 第 1 步：声明目录绑到本 agent 的缓存上）。跑器按它挂，
 * fixture 按它建：`@work/<它>` 与 `@cache/<它>` 两边都要先是一个存在的目录。
 */
export const DECLARED: readonly RelPath[] = ['dist']

/**
 * 那句指路（架构 § 8.4 纪律 2 的原句，与 `roots/fence.ts` 的 `APPLY` 同一句）。
 *
 * **一处措辞，两处强制点**：虚拟空间围栏与 OS 沙箱对人说的是同一条路——那边走申请。措辞
 * 漂移一次，读的人就得学两遍。物理侧那句话由 Y3 落：它可能比虚拟侧多说一句"哪条清单没
 * 有它"，但少不掉这一句指路。
 */
const APPLY = '走申请（§ 15.3.b）'

/** 树内那条写该拒时的指路：这一档树是只读的，那要写就声明它（§ 8.6 第 2 步 · § 8.7）。 */
const DECLARE_IT = '把它声明进这个动作（cache / outputs）'

/** env 那一条该拒时的指路：要一个键进沙箱，在策略那一份里显式给，不是从宿主继承。 */
const INJECT_IT = '要它进沙箱：boundary.env.set 里给'

/** 四十级 `..`：**一定到得了根**（到了根之后再 `..` 还是根），所以不必知道 fixture 有几层。 */
const UP = '../'.repeat(40)

/**
 * 逃逸用例集。顺序照组排，组内照"先该通的、再该拒的"——打印出来就是一份读得下来的表。
 *
 * 加一条的口径：**它得是一条能问出来的路**（有一条 argv），**能被一次读数判决**（通 / 拒），
 * **说得出出处**。三样缺一条，它就不该在这张表里（AGENTS § 四 那个抓手）。
 */
export const ESCAPE_CASES: readonly EscapeCase[] = [
  // ── 甲 · 该通：正对照。合法可达的那几条，仪器必须读得出"通" ──────────────────
  {
    name: '树内读',
    group: GROUPS.ok,
    want: 'pass',
    argv: ['cat', `@work/${PROBE_FILES.a}`],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4 消费者表：执行看到 <merged>/<rel>',
    note: '读得到（退 0）。树在这一档是只读的，不是不可读的——该通的一条读不出通，仪器就是坏的。',
  },
  {
    name: '树内读（相对 cwd）',
    group: GROUPS.ok,
    want: 'pass',
    argv: ['cat', PROBE_FILES.a],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4 逃逸用例集里的"子进程继承 cwd"：cwd 落在树里，相对路径就在树里',
    note: '退 0：子进程的 cwd 是视图的根（这一档由 --chdir 落，退化档由 spawn 的 cwd 落）。',
  },
  {
    name: '声明目录写',
    group: GROUPS.ok,
    want: 'pass',
    argv: ['sh', '-c', `echo app > @work/${DECLARED[0]}/app`],
    cwd: '',
    read: {
      how: 'anyOf',
      at: [
        { where: '绑定那一侧（缓存）', path: `@cache/${DECLARED[0]}/app` },
        { where: '树那一侧（upper）', path: `@work/${DECLARED[0]}/app` },
      ],
      passWhen: 'present',
    },
    cites: '§ 8.6 第 2 步（声明目录绑到本 agent 的缓存）· § 8.8 实测基线的"声明路径可写"',
    note:
      '退 0。产物落在哪一侧随档走：全档里它落在**绑定那一侧**（缓存里，`@cache/dist/app`，'
      + '宿主上看 `<merged>/dist/app` 是看不见的——那一条绑定只存在于沙箱那一门挂载表里），'
      + '退化档里没有绑定，它落在**树自己那一侧**（`upper/dist/app`）。所以读法取"两处任意一处"'
      + '（`anyOf`）：两个档问的仍是同一件事——写成了没有——而不是被落点带着走（X4 ① 的同一件事）。',
  },
  {
    name: '本 agent 的家',
    group: GROUPS.ok,
    want: 'pass',
    argv: ['sh', '-c', 'echo h > "$HOME/home.txt"'],
    cwd: '',
    read: { how: 'exists', at: '@cache/home.txt', passWhen: 'present' },
    cites: '§ 8.6 那张表：HOME 落在 cacheRoot(a)',
    note: '退 0：孩子眼里的家是本 agent 的缓存，不是宿主那个家。',
  },

  // ── 乙 · 树内该拒：§ 8.8 实测基线的三项（写 /etc 那一项换了，见下面 丙 的"写工作区外"）──
  {
    name: '原地改源文件',
    group: GROUPS.inside,
    want: 'deny',
    remedy: DECLARE_IT,
    argv: ['sh', '-c', `echo x >> @work/${PROBE_FILES.a}`],
    cwd: '',
    read: { how: 'bytes', at: `@work/${PROBE_FILES.a}`, passWhen: 'differs' },
    cites: '§ 8.8 实测基线：只读绑定下原地改源文件被拒',
    note: '退 2（`Read-only file system`），字节没变、`upper` 里也没有它。读法取字节：子进程退非零不等于树没被动过。',
  },
  {
    name: '树内新建',
    group: GROUPS.inside,
    want: 'deny',
    remedy: DECLARE_IT,
    argv: ['sh', '-c', 'echo x > @work/new.txt'],
    cwd: '',
    read: { how: 'exists', at: '@work/new.txt', passWhen: 'present' },
    cites: '§ 8.8 实测基线：在树内新建被拒（§ 8.6：未声明的写入由内核拒）',
    note: '退 2，落点不在。退化档里这一条变"通"（真写进 upper）——它就是断言 ① 的负对照。',
  },
  {
    name: '删除源文件',
    group: GROUPS.inside,
    want: 'deny',
    remedy: DECLARE_IT,
    argv: ['rm', `@work/${PROBE_FILES.b}`],
    cwd: '',
    read: { how: 'exists', at: `@work/${PROBE_FILES.b}`, passWhen: 'absent' },
    cites: '§ 8.8 实测基线：只读绑定下删除被拒',
    note: '退 1，那条文件还在。读法取"落点不在才叫通"：这一条的通是**删掉**，不是留住。',
  },

  // ── 丙 · 树外该拒：§ 8.4 那七类路在物理侧的样子（今天五条全通）────────────────
  {
    name: '写工作区外',
    group: GROUPS.outside,
    want: 'deny',
    remedy: APPLY,
    argv: ['sh', '-c', 'echo x > @outside/escaped.txt'],
    cwd: '',
    read: { how: 'exists', at: '@outside/escaped.txt', passWhen: 'present' },
    cites: '§ 8.8 实测基线的第四项（写 /etc）——**换了靶子**，见 note',
    note:
      '退 2（EROFS），树外那条没写下去。§ 8.8 那一项原文是"写 /etc"：那一条今天**不是沙箱的读数**' +
      '——uid 1000 本来就写不动 /etc（root 755），拆掉沙箱它照样被拒（实测）。所以这里换成"写工作区' +
      '外一处这个人自己写得动的目录"：同一条路，退化档里它真写下去（断言 ① 的负对照之一）。',
  },
  {
    name: '绝对路径读宿主',
    group: GROUPS.outside,
    want: 'deny',
    remedy: APPLY,
    argv: ['cat', '/etc/passwd'],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4 逃逸用例集：绝对路径（物理侧那一半：宿主就在 `--ro-bind / /` 底下）',
    note: '**今天通**（退 0，读到 root:…）：不是"日志读得到"，是整个宿主读得到——U13 的答案是"在"。',
  },
  {
    name: '.. 穿越读宿主',
    group: GROUPS.outside,
    want: 'deny',
    remedy: APPLY,
    argv: ['sh', '-c', `cat @work/${UP}etc/passwd`],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4 逃逸用例集：`..` 穿越',
    note: '**今天通**：四十级 `..` 到得了根，而今天的根就是宿主。Y3 之后沙箱的根是清单那一份 tmpfs。',
  },
  {
    name: '软链指向树外',
    group: GROUPS.outside,
    want: 'deny',
    remedy: APPLY,
    argv: ['cat', `@work/${OUT_LINK}`],
    cwd: '',
    read: { how: 'exit' },
    setup: [{ do: 'symlink', at: `@real/${OUT_LINK}`, to: '/etc/passwd' }],
    cites: '§ 8.4 逃逸用例集：单/链式/悬空 symlink（物理侧：内核在沙箱里解析它）',
    note: '**今天通**：链子在树里，靶子按沙箱的根解析，而今天的根是宿主。',
  },
  {
    name: '经 /proc 的另一条坐标',
    group: GROUPS.outside,
    want: 'deny',
    remedy: APPLY,
    argv: ['cat', '/proc/self/root/etc/passwd'],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4 逃逸用例集：TOCTOU 那一类"换一条坐标再说"（§ 8.8：/proc 是挂进来的）',
    note: '**今天通**：`/proc/self/root` 是这一门命名空间的根，今天它还是宿主。',
  },
  {
    name: 'shell 里 cd / 再读',
    group: GROUPS.outside,
    want: 'deny',
    remedy: APPLY,
    argv: ['sh', '-c', 'cd / && cat etc/passwd'],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4 逃逸用例集：shell 内 `cd`',
    note: '**今天通**：`cd /` 落在宿主根上。与上面那条的区别是这条路不经过绝对路径——它靠 cwd 换坐标。',
  },

  // ── 丁 · 物理侧今天够得着的六条（Y3 的负对照，按组点名）──────────────────────
  {
    name: '工作区配置',
    group: GROUPS.leak,
    want: 'deny',
    remedy: APPLY,
    argv: ['cat', '@work/.fugue/config'],
    cwd: '',
    read: { how: 'exit' },
    cites: '架构 § 23 U13：沙箱的物理可达集里有没有 <realRoot>/.fugue/',
    note:
      '**今天通**。坐标写 `@work`（不是 `@real`）：配置就在树里，换坐标之后它照旧在树里——' +
      '所以 Y3 要关的不是"宿主那条路"，是"树里这一支"（把 `.fugue/` 从孩子的可达集里挖掉，' +
      '或者认下它）。这一条把 U13 问到了根上。',
  },
  {
    name: '工作区日志',
    group: GROUPS.leak,
    want: 'deny',
    remedy: APPLY,
    argv: ['sh', '-c', 'cat @work/.fugue/log/agent/r1/*.jsonl'],
    cwd: '',
    read: { how: 'exit' },
    cites: '架构 § 23 U13（同上）· § 9.2 的日志布局',
    note: '**今天通**（打印出 JSONL 的正文）。与上一条同一个问题：`log/` 也在树里。',
  },
  {
    name: '真源工作树（宿主路径）',
    group: GROUPS.leak,
    want: 'deny',
    remedy: APPLY,
    argv: ['cat', `@real/${PROBE_FILES.a}`],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4：底就是真实工作树那一份（`fork` 不复制）——所以"宿主上那条路径"是另一条坐标',
    note: '**今天通**。它问的不是"树读得到吗"（那是甲组那条），是"宿主上那条路径够得着吗"。',
  },
  {
    name: '别家的物化树（宿主路径）',
    group: GROUPS.leak,
    want: 'deny',
    remedy: APPLY,
    argv: ['cat', `@real/.fugue/mat/${OTHER_AGENT}/merged/${PROBE_FILES.a}`],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4：mat/<agent>/ 跟着工作区走——于是别家的物化树也在"宿主那一条坐标"上',
    note:
      '**今天通**（按宿主路径）。按 `@work/.fugue/mat/<别家>/merged/…` 问是退 1 ENOENT：嵌套的 ' +
      'overlay 挂载在下层里看不见——挡住它的是 overlay 自己，不是边界（这一条也量过，记在提交信息里）。',
  },
  {
    name: '宿主那个家',
    group: GROUPS.leak,
    want: 'deny',
    remedy: APPLY,
    argv: ['cat', '@home/.bashrc'],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.6：孩子的家是本 agent 的缓存（`HOME` 那一栏）——宿主那个家不该够得着',
    note:
      '**今天通**（读到 ~/.bashrc 的正文）。换一台机器若没有它，这条会退化成"拒"——那时看 `message`：' +
      'ENOENT 与一句边界文案是两句不同的话。',
  },
  {
    name: '挂进来的宿主盘',
    group: GROUPS.leak,
    want: 'deny',
    remedy: APPLY,
    argv: ['cat', '/mnt/c/Windows/win.ini'],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 8.4：平台专属的路径形状不进这一份，但**挂进来的宿主盘**是一条路',
    note: '**今天通**。同"宿主那个家"：没有 /mnt/c 的机器上会退化成"拒"，由 `message` 分辨。',
  },
  {
    name: '宿主的环境变量',
    group: GROUPS.leak,
    want: 'deny',
    remedy: INJECT_IT,
    argv: ['sh', '-c', 'test -n "$DEEPSEEK_API_KEY"'],
    cwd: '',
    read: { how: 'exit' },
    cites: '§ 14.4 的 envRealize 挂账（计划 § 5.20 的 P1a）：宿主环境整份进沙箱，凭据那一类键跟着进',
    note:
      '**今天通**（`envFor` 整份照抄 process.env——测试进程往宿主环境里放了这一个键，沙箱里读得到）。' +
      'P1a 起基线是 core 档，这一条翻成拒；真要它进沙箱的在 `boundary.env.set` 里给。',
  },
]

/** 一条用例的读数。**跑器只报事实**：期望与实际不符是读表的人（与 Y3）要看的，不是这里判的。 */
export interface EscapeReading {
  readonly name: string
  readonly group: Group
  readonly want: Want
  /**
   * 通 / 拒。**`null` = 这一趟没问成**（子进程没起得来 · 沙箱自己没起来 · 读法要的路径本来
   * 就不在）——那不是"拒"，两者混起来的话，一个坏掉的跑器会把整张表读成"全拒"。
   */
  readonly verdict: Verdict | null
  /** 子进程的退出码；`null` = 没起得来。 */
  readonly code: number | null
  /** 子进程 stderr 的最后一句非空（拒绝文案通常在这儿）。 */
  readonly message: string
  /** 读法取到的那个事实，一小段原文，给人对账。 */
  readonly fact: string
  /** 这条用例给的那句指路，在不在 `message` 里。Y1 只立这一栏，成不成立由 Y3 判。 */
  readonly remedyMet: boolean
  /** 没问成时的由头；问成了就是空串。 */
  readonly note: string
}

/** 跑一次要的那些东西。fixture（工作区 · 物化 · 环境）由调用方摆好。 */
export interface EscapeFixture {
  readonly roots: Roots
  readonly agent: AgentId
  /**
   * **子进程那一侧的坐标**：argv 里那五个记号按它翻。沙箱档的 `work` 是挂载点（`/work`），
   * 退化档就是宿主上那条路径——两个档各给一份，别混。
   */
  readonly coords: Readonly<Record<Coord, string>>
  /**
   * **宿主那一侧的坐标**：**读数**按它翻——`at` 那几条路径是跑器在宿主上读的，`/work` 在
   * 宿主上不存在。`work` 是物化树在盘上的路径（与 `real` 今天可能落在同一条，但问的不是
   * 同一件事）。
   */
  readonly host: Readonly<Record<Coord, string>>
  readonly declared: readonly RelPath[]
  readonly env: Readonly<Record<string, string>>
  /** 这一趟的策略值：**跑器照它包**（Y2 起）——表里那些读数因此是在一份真策略下取的。 */
  readonly policy: Policy
}

export interface EscapeRunOptions {
  /** `false` = **把沙箱那一层拆掉**（X4 的退化档）：命令行就是它自己。断言 ① 的负对照用它。 */
  readonly sandbox?: boolean
}

/** 表里那五个记号 → 这一次的真路径。 */
function expand(text: string, coords: Readonly<Record<Coord, string>>): string {
  return text.replace(/@(work|real|cache|outside|home)/g, (_, k: Coord) => coords[k])
}

function shaOf(abs: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex')
  } catch {
    return null
  }
}

/** stderr 的最后一句非空——拒绝文案通常落在那一句上。 */
function lastLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines.length === 0 ? '' : lines[lines.length - 1].trim()
}

/**
 * 把表里那几条路的形状摆出来（物化之前 · 一次 fixture 摆一次）。
 *
 * 已经在那儿的形状不重摆：`mkdir` 幂等，软链与硬链接撞上已存在的条目就当它摆好了——这一条
 * 让"同一个 fixture 多跑一趟表"不至于当场抛（读数要重跑，形状不用）。
 */
export function applySetups(
  cases: readonly EscapeCase[],
  coords: Readonly<Record<Coord, string>>,
): string[] {
  const done: string[] = []
  for (const c of cases) {
    for (const s of c.setup ?? []) {
      const at = expand(s.at, coords)
      if (s.do === 'mkdir') {
        mkdirSync(at, { recursive: true })
        done.push(`mkdir ${at}`)
        continue
      }
      mkdirSync(dirname(at), { recursive: true })
      if (existsSync(at)) {
        done.push(`${s.do} ${at}（已经在）`)
        continue
      }
      if (s.do === 'symlink') symlinkSync(expand(s.to, coords), at)
      else linkSync(expand(s.to, coords), at)
      done.push(`${s.do} ${at} -> ${expand(s.to, coords)}`)
    }
  }
  return done
}

/**
 * 跑整张表。**一次一条用例一次进程**：合起来跑的话，一条用例留下的痕迹会变成下一条的读数。
 *
 * 两档之间只差一件事：命令行前面有没有那层沙箱（`confine()` 与 `degradedArgv()`）。表 · 读法 ·
 * 读的地方一个字都不变——所以两档的读数可以直接对着看，这也是断言 ① 的负对照成立的原因。
 */
export function runEscapeTable(
  cases: readonly EscapeCase[],
  fx: EscapeFixture,
  opts: EscapeRunOptions = {},
): EscapeReading[] {
  const sandbox = opts.sandbox !== false
  return cases.map((c) => runOne(c, fx, sandbox))
}

function runOne(c: EscapeCase, fx: EscapeFixture, sandbox: boolean): EscapeReading {
  // **argv 翻成子进程的坐标，读数翻成宿主的坐标**（Y3）：一个问"孩子够得着什么"，一个问
  // "盘上变成了什么样"。两处各一份，混了的话沙箱档的读数会去读 `/work`——那条路径在宿主上
  // 不存在，读出来的是"没变"，而那是假的。
  const argv = c.argv.map((s) => expand(s, fx.coords))
  const merged = fx.roots.mergedRoot(fx.agent)
  const ats = atsOf(c.read, fx.host)
  const at = ats[0] ?? ''
  // 读法的"改之前"：**在起进程之前取**，否则读的是自己写的那一份。
  const before = c.read.how === 'bytes' ? shaOf(at) : null

  const packed: ConfinedArgv = sandbox
    ? confine({
        roots: fx.roots,
        agent: fx.agent,
        argv,
        cwd: c.cwd,
        declared: fx.declared,
        env: fx.env,
        policy: fx.policy,
      })
    : degradedArgv(argv)

  const r = spawnSync(packed.argv[0], packed.argv.slice(1), {
    cwd: join(merged, c.cwd),
    env: fx.env,
    encoding: 'utf8',
    maxBuffer: 1 << 24,
    timeout: 60_000,
  })

  const code = r.status
  const stderr = r.stderr ?? ''
  const stdout = r.stdout ?? ''
  const message = lastLine(stderr)
  const remedyMet = c.want === 'deny' && message.includes(c.remedy)

  /** 没问成：三种情形各自留一句话，绝不混进"拒"。 */
  const failed = (why: string): EscapeReading => ({
    name: c.name,
    group: c.group,
    want: c.want,
    verdict: null,
    code,
    message,
    fact: '（没问成）',
    remedyMet: false,
    note: why,
  })

  if (r.error !== undefined && r.error !== null) return failed(`起不来：${r.error.message}`)
  // 沙箱自己没起来（挂载源不在 · 命名空间建不出来）：bwrap 的话落在 stderr 头一行上。
  // 这一条必须与"被拒"分开：那时孩子根本没跑，任何"落点没变"的读数都是假的。
  if (/^bwrap: /m.test(stderr.trim())) return failed(`沙箱没起来：${stderr.trim().split('\n')[0]}`)
  if (code === null) return failed('没等到退出码（信号或超时）')
  if (c.read.how === 'bytes' && before === null) return failed(`读法要的那条路径本来就不在：${at}`)

  const wheres = c.read.how === 'anyOf' ? c.read.at.map((a) => a.where) : []
  const verdict = verdictOf(c.read, { code, stdout, ats, wheres, before })
  const fact = factOf(c.read, { code, stdout, ats, wheres, before })
  return {
    name: c.name,
    group: c.group,
    want: c.want,
    verdict,
    code,
    message,
    fact,
    remedyMet,
    note: '',
  }
}

interface Observed {
  readonly code: number
  readonly stdout: string
  /** 读法要看的那些落点（`anyOf` 有多个，其余一个或没有）。 */
  readonly ats: readonly string[]
  /** `anyOf` 那几处的名字，与 `ats` 一一对应——读数要说得清是**哪一侧**落下的。 */
  readonly wheres: readonly string[]
  readonly before: string | null
}

/** 读法要看的那些落点，翻成这一次的真路径。 */
function atsOf(read: Reading, coords: Readonly<Record<Coord, string>>): string[] {
  switch (read.how) {
    case 'exists':
    case 'bytes':
      return [expand(read.at, coords)]
    case 'anyOf':
      return read.at.map((p) => expand(p.path, coords))
    case 'exit':
    case 'stdout':
      return []
  }
}

function verdictOf(read: Reading, o: Observed): Verdict {
  const yes = (b: boolean): Verdict => (b ? 'pass' : 'deny')
  switch (read.how) {
    case 'exit':
      return yes(o.code === 0)
    case 'exists':
      return yes(existsSync(o.ats[0] ?? '') === (read.passWhen === 'present'))
    case 'anyOf':
      return yes(o.ats.some((p) => existsSync(p)) === (read.passWhen === 'present'))
    case 'bytes':
      return yes((shaOf(o.ats[0] ?? '') !== o.before) === (read.passWhen === 'differs'))
    case 'stdout':
      return yes(o.stdout.includes(read.has))
  }
}

function factOf(read: Reading, o: Observed): string {
  switch (read.how) {
    case 'exit':
      return `退${o.code}`
    case 'exists':
      return existsSync(o.ats[0] ?? '') ? '落点在' : '落点不在'
    case 'anyOf': {
      // 先配对再筛：`filter` 之后的下标已经不是原来的下标了（第一版就栽在这儿——
      // 退化档里落在树那一侧，报出来的却是"绑定那一侧"）。
      const hit = o.ats
        .map((p, i) => ({ p, w: o.wheres[i] ?? p }))
        .filter((x) => existsSync(x.p))
        .map((x) => x.w)
      return hit.length === 0 ? '落点一处都不在' : `落点在：${hit.join(' 与 ')}`
    }
    case 'bytes':
      return shaOf(o.ats[0] ?? '') === o.before ? '字节没变' : '字节变了'
    case 'stdout':
      return o.stdout.includes(read.has) ? '打印里有那一段' : '打印里没有那一段'
  }
}

/** 一条读数印成一行（给走查与提交信息用）。**期望与实得并排**：差在哪儿，一眼看得出。 */
export function formatReading(r: EscapeReading): string {
  const got = r.verdict === null ? '没问成' : r.verdict === 'pass' ? '通' : '拒'
  const want = r.want === 'pass' ? '通' : '拒'
  const head = `${r.group} | ${r.name} | 期望${want} 实得${got} | ${r.fact}`
  if (r.verdict === null) return `${head} | ${r.note}`
  const tail = r.message === '' ? '' : ` | ${r.message.slice(0, 72)}`
  return `${head}${tail}`
}
