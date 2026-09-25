#!/usr/bin/env node
// fugue —— 环境的操作面。出处：架构 § 9.6。
//
// **单次进程 + 每次重建**：不需要守护进程、不需要常驻状态、崩溃恢复就是"下一条命令照常
// 加载"。§ 9.6 那张表里属于 S1 的每一行都在这里：读 · 写 · 检视 · 提交 · 重放 · 配置。
//
// 这一层只做三件事：解析参数 · 把结构化结果排成两列（人读的与 `--json` 的）· 决定退出码。
// **语义不在这里**：一次变更的顺序与校验住在 `src/view/edit.ts`，提交住在
// `src/checkpoint.ts`——两个都是跨层接线（§ 7），这里只是它们的一个人侧入口。
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkMountPoints, checkReach } from '../boundary/check.ts'
import { PolicyError, probeLayers, resolvePolicy } from '../boundary/policy.ts'
import type { Policy } from '../boundary/policy.ts'
import { BranchRefused, branchAt, forkBaseRefusal } from '../branch.ts'
import { checkpoint } from '../checkpoint.ts'
import {
  ConfigError,
  configFileOf,
  getConfig,
  parseConfigValue,
  readConfig,
  setConfig,
  writeConfig,
} from '../config.ts'
import type { ConfigDoc } from '../config.ts'
import {
  BindingError,
  declaredDirs,
  envFor,
  parseInjections,
  portRangeOf,
  readBinding,
} from '../execute/binding.ts'
import type { ActionBinding } from '../execute/binding.ts'
import { cacheLayoutOf, confine, degradedArgv } from '../boundary/confine.ts'
import { createExecutor } from '../execute/exec.ts'
import { ReclaimRefused, createReclaim } from '../execute/reclaim.ts'
import type { DeclaredSet, Reclaim } from '../execute/reclaim.ts'
import { agentFor, refFor } from '../identity.ts'
import type { Delta } from '../delta.ts'
import type { TreeEntry } from '../entries.ts'
import type { LogEvent } from '../log/events.ts'
import { LogHeldError, holdWriter } from '../log/hold.ts'
import { LogCorruptError, logDir, mergedFace, openLog } from '../log/log.ts'
import type { LogHandle, SyncLevel } from '../log/log.ts'
import type { ChangeStatus, TreeStat } from '../materialize/diffstat.ts'
import { TreeStatError, WORKSPACE_STATE, diffStat, loadTreeStat, scanTree, storeTreeStat } from '../materialize/diffstat.ts'
import { DEFAULT_MATERIALIZE } from '../materialize/contract.ts'
import { dispose } from '../materialize/dispose.ts'
import { EnsureRefused, ensure } from '../materialize/ensure.ts'
import type { EnsureResult } from '../materialize/ensure.ts'
import { ForkRefused, fork } from '../materialize/fork.ts'
import { LandError } from '../materialize/land.ts'
import { LayError } from '../materialize/lay.ts'
import { matState } from '../materialize/manifest.ts'
import type { MatState } from '../materialize/manifest.ts'
import { MountError, unmountOverlay } from '../materialize/mount.ts'
import { VerifyRefused, verifyMat } from '../materialize/verify.ts'
import type { Denied, Result, Roots } from '../roots/contract.ts'
import { HostError, assertHost } from '../roots/host.ts'
import { createRoots } from '../roots/roots.ts'
import type { AgentId, BranchId, CommitId, ContractId, ForkStrategy, LogPos, PolicyMode, RelPath, StepId, ViewRev, WriterId } from '../terms.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import type { View } from '../view/contract.ts'
import { applyEdit } from '../view/edit.ts'
import { baseFor, lowerAt, lowerFor } from '../view/lower.ts'
import { readSnapshot, saveSnapshot, snapshotOf } from '../view/snapshot.ts'
import { assemble, firstDivergence, hashOf } from '../assemble/assemble.ts'
import type { Prefix, SegmentId, SegmentValue } from '../assemble/contract.ts'
import { DEFAULT_MODEL } from '../assemble/models.ts'
import { PROTOCOLS, protocolFor, protocolNamed } from '../assemble/protocol.ts'
import { checkConstraints, formatViolation } from '../assemble/constraints.ts'
import { emptyState, HOLDER, SourceError, sourcesFor } from '../assemble/sources.ts'
import type { AssembleState } from '../assemble/sources.ts'
import type { AgentCoord } from '../assemble/sources.ts'
import { stateWithState } from '../assemble/sources-state.ts'
import { loadView } from '../view/view.ts'
import type { SplitAssignment } from '../contract/build.ts'
import { RoundStartError, startRound } from '../round/start.ts'
import { RoundRunError, materializeCommit, runRound } from '../round/execute.ts'
import type { DriverSupport, Stub } from '../round/execute.ts'
import { realDriver, stubDriver } from '../round/driver.ts'
import { wireCall } from '../runtime/step.ts'
import { makeDumpCall } from '../model/http.ts'
import type { AgentHandle } from '../runtime/step.ts'
import { targetOf } from '../model/http.ts'
import { modelDeclOf } from '../model/contract.ts'
import { wireHeader } from '../model/wire/headers.ts'
import { implementedNames, publishedTools } from '../tools/execute.ts'
import { CATALOG_STATES, TOOL_NAMES, catalog } from '../tools/catalog.ts'
import type { Contract } from '../contract/types.ts'
import type { AssertionRunSpec } from '../merge/accept.ts'
import { entriesOf } from '../merge/accept.ts'
import type { Assertion } from '../contract/types.ts'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { computeAll, reportOf } from '../probe/round.ts'
import { computeAllMetrics, lineOf } from '../probe/metrics.ts'

const USAGE = `用法: fugue [--root <dir>] [--agent <id>] [--json] <command> [args]

命令
  log [--agent <id>]         按 (seq, writer) 全序列出日志事件
  read <path>                读一个路径；默认吐原始字节
  list [dir]                 列一个目录
  stat <path>                一个路径的形状
  write <path> [--from <f>|--stdin]   写一个文件
  remove <path>              删一个路径（目录连同它下面）
  rename <from> <to>         改名
  chmod <path> <mode>        改模式；<mode> 是八进制，如 755
                             模式只认两档：有执行位就是 100755，否则 100644。归一之后与现值
                             相同就只说一句「没有变化」（stderr），日志与 diff 里都不出现
  diff [--since <rev>]       自某个修订点以来的变更
  revs                       全部可达修订点，升序；0 是 base 本身
  commit -m <msg>            把当前视图提交成一个提交点，推进它的 ref
  branch <base>              把本 agent 的分支头定格在 <base> 上——§ 4 的那个"分出去"。
                             幂等：已经指着它就什么都不做；指着别处就拒绝并给出两条路。
                             它是视图的底与物化的底对齐的那一步：fork 之前，本 agent 的
                             分支头必须就是 <base>，否则 fork 拦在落地之前（§ 4 末段）
  replay [--to <rev>]        从日志重建视图并报出它；--verify 逐 agent 比对两条重建路径
  diff-stat [<dir>] [--baseline <f>] [--save <f>]
                             全树 (mtime,size,hash) 快照对比；不给 <dir> 时扫本 agent 的合并树，
                             基线由 --baseline 读、--save 存（三个路径都相对当前目录，不是 --root）
  fork <base> [--strategy <s>] [--ro <p1,p2>] [--no-preserve-mtime]
                             把 base 那棵树物化出来并挂上，返回合并树（本 agent 的坐标）
                             <base> 是一个提交，**必须就是本 agent 的分支头**（branch <base>
                             定的那一步）。物化的底是真实工作树，视图的底是分支头，
                             两者得是同一个提交（§ 4），所以落地之前查一次 ref——不一致就拒绝
                             并指路。**真实工作树是不是 base 的那棵树，这一层不查**（§ 8.4：
                             检测在合并之前）：不一致时物化树里本 agent 没碰过的路径给的是
                             工作树的内容而不是 base 的
                             --strategy 取 overlayfs | hardlink-ro | copy，
                             不给就按策略表探着退档，用了哪一档写在 stderr 与 --json 里；
                             --ro 声明哪几处子树只读（hardlink-ro 那一档只链它们）；
                             --no-preserve-mtime 让抄出来的那几条用当下的时间戳而不是底的时间戳
                             （§ 8.5 的 preserveMtime；它是"假失效"那半边的负对照）
  ensure [--to <rev>]
                             把这个 agent 到 <rev> 为止的改动落到物化树里（不给 --to 就是此刻），
                             返回合并树；已最新就什么都不落。一次落哪些路径由日志里的 mat/*
                             重放得来，落完追加一条 mat/sync
  run <action> [-- k=v…]     在沙箱里跑一个声明过的动作（§ 8.6）：先物化一次，再把本 agent 的
                             坐标注进环境（HOME · TMPDIR · XDG_CACHE_HOME · PORT · PORTS），
                             然后 bwrap 起进程。动作写在配置里，例如
                             fugue config set actions.build '{"argv":["make"],"cache":["dist"]}'
                             「-- k=v」注入子进程的环境变量；上面那几样盖不了（撞上就拒绝）。
                             子进程的两股输出走 stderr。跑完把声明过的产出收回视图（§ 8.7）：
                             cache 是绑到本 agent 缓存的声明目录——构建产物落那儿，**不回写**；
                             outputs 是要回写视图的产出声明：收进来的那几条 fugue diff 报得出、
                             fugue ensure 落得到盘上。一条声明若没被别的声明盖住，它自己是一条
                             目录（不存在就预建）；被盖住时它是落在缓存里的一条路径，例如
                             cache:["dist"] 配 outputs:["dist/app"] 收的就是那个可执行文件。
                             声明集外的写入：默认档由内核拒（子进程非零退出、树一个字节没变），
                             树可写那一档由回收拒并记一条 mat/reclaim。
                             --mode <read-only|workspace-write> 选哪一档（缺省 read-only）。
                             workspace-write 是 § 15.7 的 E4 退化档：树可写 + 回收兜底，不再有
                             只读树那一道围栏。bwrap 不在 PATH 上时自动降一档——Landlock 那一层
                             还在的话（Y6）它接过「写得动什么」那一维：未声明的写入当场拒，档如实
                             报 read-only；两层都不在才是树可写 + 回收兜底。两处都如实报
                             enforcement=partial，不静默降级。
                             --step <id> 是这一步的署名，不给就是「-」（轮次是 S7 的事）。
                             退出码：0 子进程成功 · 1 没成功
  round new <目标> [--materialize]
                             开一个轮次（架构 § 8.13 的 Idle → Planning → Delegated → Working）：
                             钉住真实工作树的 HEAD 当这一轮的底 · 把持轮者给的拆分草案造成契约
                             （§ 8.12）· Planning 那一档跑一次写入集相交预检 · 一份一条
                             contract/issue（契约住日志里，带正文）· N 条 refs/heads/<agent>
                             定在同一个底上。
                             拆分草案读配置里的 round.split（一份草案一笔）：
                               fugue config set round.split '[{"goal":"…","ownedPaths":["src/a.ts"],
                                 "assertions":[{"action":"test","name":"单元测试全过"}]}]'
                             一条草案至少要有 goal · ownedPaths · assertions（零条断言会让
                             「打回率低」这句话没有分母）。草案里没有 deliverables 就是没有
                             交付物——那一格可以空，不是缺省。
                             agent 名按位置发：agent/<轮次>/1 … agent/<轮次>/n——于是分支是
                             refs/heads/agent/<轮次>/<n>（架构 § 4 那张表），物化在
                             .fugue/mat/agent/<轮次>/<n>/，日志在 .fugue/log/agent/<轮次>/<n>.jsonl。
                             相交时**报出来、照发**（这一站的口径，PLAN § 5.7 的口径一）：
                             撞上了由合并那一步的冲突环接住，不静默。
                             **物化缺省不做**（架构 § 14.1 的 deferMaterialize：走按需物化）。
                             给 --materialize 就把 N 棵树也铺出来——那一步落的是 mat/fork 事件，
                             每条分支一份，落在**那个 agent 自己的日志**里。
  round run <目标> [--report] [--metrics] [--fail <n>] [--deny <n>] [--retry <n>] [--materialize]
                             跑一个完整的轮次（架构 § 20 S7 的可用性那一句）：
                             起头（钉底 · 造契约 · Planning 预检 · 发契约 · 起分支）→ 每个 agent
                             干一格（**模型这一侧今天是打桩的**，PLAN § 5.7 的"不在这一站里的"
                             第一行）→ 合并前兜底预检（报出即拒）→ 漂移检 → 逐路折叠（撞上冲突
                             就物化冲突树、交给解决者、重折）→ 验收（跑在**物化出来的那棵树上**）
                             → 通过才定格 + 推进（没过则真实工作树一个字节不动）。
                             断言从工作区配置里读：round.assertions 那一栏
                               fugue config set round.assertions '[{"name":"测试全过","argv":["/bin/sh","-c","true"]}]'
                             每一条断言在**合并之后那棵树上**跑：argv 起真进程，退出码等于
                             expect（缺省 0）算过。"命令不在 / 退出码 127"那一类判成**跑不起来**
                             ——它不进打回计数，单独成一栏（架构 § 8.12 末段）。
                             --fail <n>   让第 n 个 agent 交一个"必然失败"的提交（走查要撞红）
                             --deny <n>   第 n 个 agent 的格子里多跑一条必然被拒的动作
                             --retry <n>  Verifying → Working 那条回边允许走几次（缺省 0）
                             --report     印打回那三个数（从日志重算，不采集）
                             --metrics    印八元指标（**每个指标的分子与分母一起印**，从日志重算）
                             --materialize 起头时把 N 棵树也铺出来（缺省不铺）
                             --max-steps <n>  **这一格最多走几步**（缺省 64）。--live 下每一步
                             是一次真调用，所以这是"这一趟最多花多少"在命令面上的那道闸；
                             第一次联网把它压到个位数。
                             --no-handoff   到了预算触发点**不交接**（用完就停那一档）：
                             B6 的缺省是"先停"（写交接提示词 · 换一个 agent 接着干），
                             而地板那一档要能把它关掉。
                             --dump-wire <目录>  **把每一次调用发出去与收回来的字节原样落盘**
                             （call-0001/request.json · response.sse · meta.json · 两条
                             sha256）。默认不落——不给这个开关时那一层根本不存在，一个字节
                             都不写、请求体也一个字节不变。**目录必须在工作区之外**：落进
                             <root> 会被下一轮的 fork 当成漂移（§ 8.14）。看完就删。
                             --soft-merge-gate 合并前那一档预检的严宽拉平到 Planning 那一档
                             （缺省是报出即拒——合并不可逆）；真冲突仍由折叠当场报出，不静默
                             --poke <路径>  **在折叠之后、物化之前手改一条路径**（模拟轮次中
                             用户的手，用来量漂移那一档）；缺省什么都不做
                             --poke-exact <路径> 同上，但抄的是这一趟目标树里那条路径的
                             字节（量"两边逐字节相同 → 照合并"那一档）
  verify-mat                 核对物化：日志重放出的清单 · base 与视图之间的差异集 · 盘上落地根
                             里那几条，三者两两相等，并报 materialize-precision（§ 8.15 的比值）。
                             不等就退 1——**只报不修**（§ 8.5 的失败处理是删除重建）
  dispose                    把这个 agent 的物化删干净：先卸后删，四个坐标一起（§ 8.4）。
                             幂等——本来就没有也成功。**它是物化的退化档**：dispose 之后
                             fork + ensure 就是一次全量重铺（§ 3）
  policy [<action>]          把这一趟的策略值印出来（架构 § 8.8：一份策略值，两个强制点）：
                             哪一档 · enforcement · 在场的层 · 网络那一档 · 可达集清单 · 可写落点。
                             给了 <action> 就报那个动作那一趟的值（它有没有点名要网）。
                             fugue run 写进 run/confined 的是同一个 resolvePolicy() 的返回值——
                             两处读同一份，不是各自算一遍再对答案
  config show                工作区配置的全文
  config get <key>           配置里的一条；<key> 是点分路径，如 docs.trace.path
  config set <key> <value>   改一条；<value> 整份解析得了就当 JSON 值，否则当字符串

选项
  --root <dir>    工作区根，默认当前目录；日志在 <root>/.fugue/log/，对象库在 <root>/.git，
                  配置在 <root>/.fugue/config。工作区要落在一块原生的本地文件系统上：
                  落在 9p / drvfs 那一类跨内核的落点上时拒绝启动（架构 § 15.7 的 E1）
  --agent <id>    操作哪个视图；未指定时取 round（主线）
  --json          结构化输出
  --help          这张表

 一份日志一个写者进程：写命令（write · remove · rename · chmod · commit · fork · ensure ·
 run · dispose）取该 agent 的锁 <root>/.fugue/log/<agent>.lock，同一个 agent 的两条写命令因此
 不会同时在跑——拿不到的那一条退 1 并报出持者。读命令一律不取锁；锁按 agent 分，
 不同 agent 之间互不阻塞
`

interface Parsed {
  flags: Map<string, string | true>
  positional: string[]
  /** `--` 之后那几段的原文。**只有 `run` 收它**（`-- k=v…` 的注入，§ 9.6 的执行行）。 */
  rest: string[]
}

/**
 * 取值的选项。其余 `--x` 一律是开关——因为 § 9.6 的规范形是
 * `fugue [--root <dir>] [--agent <id>] [--json] <command>`，开关排在命令**前面**，
 * 一个贪心的解析器会把命令当成开关的值吃掉。
 */
const VALUED: ReadonlySet<string> = new Set([
  'root', 'agent', 'm', 'from', 'since', 'to', 'baseline', 'save', 'strategy', 'ro', 'step', 'mode', 'against',
  'split', 'fail', 'retry', 'poke', 'poke-exact',
  // `--dump-wire <目录>`：**它取一个值**。不列在这里的话 `--dump-wire /tmp/x` 里的 `/tmp/x`
  // 会被当成位置参数，而开关本身成了 `true`——于是要么误报用法错，要么把目录名当成轮次目标。
  'dump-wire', 'credential',
  // `--max-steps <n>`：同一条纪律——它取一个值，不列在这里那个数会被当成位置参数。
  'max-steps',
])

function parseArgv(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // `--` 之后一律是原文：`k=v` 的值里可能有 `-`、有 `=`，再解析下去就是替人猜。
    if (a === '--') {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (!a.startsWith('-') || a === '-') {
      positional.push(a)
      continue
    }
    const long = a.startsWith('--')
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags.set(a.slice(long ? 2 : 1, eq), a.slice(eq + 1))
      continue
    }
    const key = a.slice(long ? 2 : 1)
    const next = argv[i + 1]
    if (VALUED.has(key) && next !== undefined && !next.startsWith('-')) {
      flags.set(key, next)
      i++
    } else {
      flags.set(key, true)
    }
  }
  return { flags, positional, rest }
}

/**
 * 命令行上那一档（架构 § 8.8 的 `Policy.mode`）：不给就是缺省档 `read-only`。
 * **`null` 是"敲错了"**（退出码 2），与"这一趟跑不成"（1）分开。
 */
function modeOf(flags: Map<string, string | true>): PolicyMode | null {
  const raw = flags.get('mode')
  if (raw === undefined) return 'read-only'
  return raw === 'read-only' || raw === 'workspace-write' ? raw : null
}

function emitJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v) + '\n')
}

function emitLine(s: string): void {
  process.stdout.write(s + '\n')
}

function fail(msg: string): number {
  process.stderr.write(msg + '\n')
  return 1
}

function usageFail(msg: string): number {
  process.stderr.write(`${msg}\n\n${USAGE}`)
  return 2
}

/**
 * 原始输入 → 视图内的路径，或者**围栏那句给人看的话**（`Denied.message` 里带着指路）。
 *
 * **命令行的文件工具都走这里**（架构 § 8.4 硬纪律 1 的"唯一入口"）。视图那一步的路径检查（`throw
 * new Error`）拒得出这一类输入，可它的文案里没有去处；围栏里那份 `Denied` 本来就是给人看的整
 * 句，所以这里
 * 不另造一句话，只把两种结果分清楚：出来的要么是一条视图内的路径，要么是一句话。
 *
 * **它只拿 `Roots`，不拿开好的视图**：这条路要在开视图之前走完——一条用法错、或者路径走出
 * 工作区的命令，不该在磁盘上留下一个日志目录（`cli/fugue.test.ts` 里那条断言在管这个）。
 *
 * 基准目录是**工作区的根**：命令行没有"当前目录"这一维（壳让人在任何目录里敲 `fugue`），
 * 凡是相对的输入都相对根读。空串与 `.` 因此都读成根。
 */
/** 围栏那两半。**带 `ok` 分**：路径与消息都是字符串，`typeof` 分不开。 */
type Fenced = { readonly ok: true; readonly rel: RelPath } | { readonly ok: false; readonly message: string }

function fence(roots: Roots, raw: string): Fenced {
  const r = roots.resolveVirtual(raw, '')
  return r.ok ? { ok: true, rel: r.value } : { ok: false, message: r.error.message }
}

/**
 * `--agent` 决定操作哪个视图，等价于选择一份日志（§ 9.6）。未指定时取主线：`round` 是
 * 持轮者这个位置的名字，它在 git 侧的落点是 `refs/heads/main`（§ 4）——所以不带参数读到
 * 的视图，与 git 侧的主干是同一段历史。
 */
function writerOf(flags: Map<string, string | true>): WriterId {
  const a = flags.get('agent')
  return (typeof a === 'string' ? a : 'round') as WriterId
}

interface Ctx {
  root: string
  /**
   * 这一份落点。**命令行这一层要用的那一处**是 `resolveVirtual`：原始输入 → 视图内的路径，
   * 或者一条带指路的拒绝（架构 § 8.4 硬纪律 1 的"唯一入口"）。
   */
  roots: Roots
  log: LogHandle
  truth: TruthHandle
  view: View
  writer: WriterId
  close(): Promise<void>
}

interface OpenOptions {
  /**
   * 要变更序列的命令（`diff`）。**快照换掉的正是历史**，所以这些命令明说不看快照——
   * 加速项不该在任何一处改变语义，答不上来的问题就得从 0 重放。
   */
  history?: boolean
  upToRev?: ViewRev
  /**
   * 快照的上界（默认跟 `upToRev` 一样）。**它是"问哪一份快照"，与"视图载到哪儿"分开**：
   * `ensure` 既要把视图载到目标 rev，又只敢用 rev ≤ 清单那个 rev 的快照——不然
   * `diff(清单的 rev)` 会撞上"比快照早的历史不在它里面"（§ 9.4 那条结构性的限制）。
   */
  snapUpTo?: ViewRev
  /** 日志的耐久档位。提交点用 `each`（§ 9.5 把提交点与检查点列在同一档）。 */
  sync?: SyncLevel
  /**
   * 这条命令**会改状态**：于是它要取该 agent 的锁（`hold.ts`），整条命令一个写者。
   * 写组（`write` · `remove` · `rename` · `chmod` · `commit` · `fork` · `ensure` · `dispose`）
   * 给 `true`；读命令一律不给——架构 § 9.7 把加锁与预取并列，观察不得影响状态。
   */
  write?: boolean
}

/**
 * 一条命令要的三样：日志 · 真源 · 视图。
 *
 * **base 取该 agent 的 ref 现在指向的提交**：视图 = 该提交 + 这个 agent 自己写过的路径。
 * 提交把视图定格成一个新的提交点之后，base 随之前移——上层仍然带着这次 agent 写过的
 * 全部路径，所以读出不变。
 */
async function openCtx(
  root: string,
  flags: Map<string, string | true>,
  opts: OpenOptions = {},
  given?: Roots,
): Promise<Ctx> {
  const writer = writerOf(flags)
  // 这一份落点：命令行过围栏要它（`pathOrMessage`），`read` · `list` · `stat` 也顺手用它。
  // **无状态，所以可以传进来**：写命令那一支要在开视图之前先过围栏。
  const roots = given ?? createRoots(resolve(root))
  // **锁在这里取、整条命令握着**（`close()` 里放）：写命令要挡的不止「追加那一下」——
  // `ensure` 的挂载与落地那两段同样不许有第二个进程插进来（PLAN § 5.3 的疑点第一条）。
  const log = openLog(root, {
    ...(opts.sync === undefined ? {} : { sync: opts.sync }),
    ...(opts.write === true ? { write: writer } : {}),
  })
  let truth: TruthHandle | null = null
  try {
    truth = openTruth(root)
    const lower = await lowerFor(truth, writer)
    // 有快照就从快照起（§ 9.4 的第一步）：这一步只影响快慢，影响不到读出来的东西——
    // `diff` 那种要历史的命令在上面的 `history` 里被排除掉了。
    const ceiling = opts.snapUpTo ?? opts.upToRev
    const snap =
      opts.history === true
        ? null
        : await readSnapshot(root, writer, ceiling === undefined ? {} : { upToRev: ceiling })
    const view = await loadView(
      log,
      writer,
      snap === null ? { lower, upToRev: opts.upToRev } : { lower, upToRev: opts.upToRev, snap },
    )
    const t = truth
    return {
      root,
      roots,
      log,
      truth: t,
      view,
      writer,
      close: async () => {
        await log.close()
        await t.close()
      },
    }
  } catch (err) {
    await log.close()
    if (truth !== null) await truth.close()
    throw err
  }
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Uint8Array))
  return Buffer.concat(chunks)
}

function parseOctal(raw: string): number {
  const text = raw.trim().replace(/^0o?/, '')
  if (!/^[0-7]{3,4}$/.test(text)) throw new UsageError(`模式要八进制三位或四位：${raw}`)
  return parseInt(text, 8)
}

/** `--json` 的 delta 形状。**字节不进去**——它可能是二进制，`JSON.stringify` 会把它摊成下标表。 */
function deltaJson(d: Delta): Record<string, unknown> {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return { kind: d.kind, path: d.path, mode: d.mode, size: d.bytes.length }
    default:
      return { ...d }
  }
}

function deltaLine(d: Delta): string {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return `${d.kind}\t${d.path}\t${d.bytes.length} 字节\t${d.mode.toString(8)}`
    case 'delete':
      return `delete\t${d.path}`
    case 'rename':
      return `rename\t${d.from}\t→ ${d.to}`
    case 'chmod':
      return `chmod\t${d.path}\t${d.mode.toString(8)}`
    case 'symlink':
      return `symlink\t${d.path}\t→ ${d.target}`
  }
}

function emit(pos: LogPos, e: LogEvent, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ pos, e }) + '\n')
    return
  }
  const { t, ...payload } = e as { t: string } & Record<string, unknown>
  const keys = Object.keys(payload)
  const brief = keys.map((k) => `${k}=${JSON.stringify(payload[k])}`).join(' ')
  process.stdout.write(`${pos.writer}\t${pos.seq}\t${t}\t${brief}\n`)
}

async function commit(ctx: Ctx, msg: string, json: boolean): Promise<number> {
  // **条目来自视图的全量读出**（§ 8.3 的"先持久，后重建"）：U2 那个临时的日志折叠在
  // U3 落地时删除，调用点一行没改——`checkpoint` 收的本来就是条目与 rev。
  const entries: TreeEntry[] = await snapshotOf(ctx.view)
  const r = await checkpoint({
    log: ctx.log,
    truth: ctx.truth,
    writer: ctx.writer,
    entries,
    rev: ctx.view.rev,
    msg,
    // 视图铺在哪个提交上，这次提交就推在哪个提交之上（`checkpoint` 的 CAS 期望）。
    expectedOld: ctx.view.base,
  })
  // 提交点同时是快照点（§ 9.5 把提交点与检查点列在同一档）：那一行日志已经落了，把上层的
  // 折叠留在 `<root>/.fugue/snap/` 下。**写不成就当没写**——快照从不阻塞写入（§ 9.4）。
  await saveSnapshot(ctx.root, ctx.writer, ctx.view, r.seq)
  if (json) emitJson({ ...r, rev: ctx.view.rev })
  else emitLine(`${r.commit}\t${r.ref}\t${r.entries} 个条目`)
  return 0
}

/**
 * `fugue branch <base>`：把本 agent 的分支头定格在 <base> 上（§ 4 的"分出去" · § 9.6 的提交组）。
 *
 * **它不建视图、不读日志**：这个动作改的是 ref（真源那一侧），而"视图的底现在是哪个提交"是
 * 下一条命令加载时现读出来的。所以它和 `config` · `dispose` 一样，排在建视图的命令之前。
 *
 * 退出码：0 定好了（本来就指着它也算）· 1 做不成（<base> 不是一个提交 · 指着别处）· 2 用法错。
 */
async function branchCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const base = args[0]
  if (base === undefined || base === '') return usageFail('branch 需要 <base>：一个提交')
  const abs = resolve(root)
  const writer = writerOf(flags)
  const truth = openTruth(abs)
  try {
    let commit: CommitId
    try {
      commit = await truth.resolve(base)
    } catch (err) {
      return fail(`branch：${base} 不是这个工作区里一个能用的提交\n  ${(err as Error).message}`)
    }
    const res = await branchAt(truth, writer, commit)
    if (json) emitJson({ agent: agentFor(writer), ref: res.ref, base: res.base, moved: res.moved })
    else {
      // 过程走 stderr（§ 9.8 的 stdout 纪律）：stdout 上那一行是这次的坐标，与 `commit` 一致。
      process.stderr.write(
        res.moved
          ? `${res.ref} 定格在 ${res.base}\n`
          : `${res.ref} 本来就指着 ${res.base}——幂等，什么都没动\n`,
      )
      emitLine(`${res.base}\t${res.ref}`)
    }
    return 0
  } catch (err) {
    if (err instanceof BranchRefused) return fail(err.why)
    throw err
  } finally {
    await truth.close()
  }
}

/**
 * `fugue round new <目标>`：开一个轮次（架构 § 8.13 的三步转移 · § 8.14 的 C7 前半 · § 8.12 的
 * 第一次预检 · PLAN § 5.7 的 A4 行）。
 *
 * **这一层只做三件事**：读配置里的拆分草案 · 把位置发成身份（`<轮次>/<n>` 与 `agent/<轮次>/<n>`）·
 * 把 `startRound` 的产出排成两列。钉底 · 构造 · 预检 · 发契约 · 起分支全在 `src/round/start.ts`
 * 里——这一层不认识状态机，也不认识契约的形状。
 *
 * **两个写者口**：持轮者那一份（`round/state` · `round/intent` · `contract/issue`）走 `openCtx`
 * 那条句柄；物化那一档每铺一条分支开一个那个 agent 的句柄（`mat/fork` 落在它自己的日志里）。
 * 栅栏按 writer 分文件（§ 9.2），所以这是两个写者，不是一个写者写两份。
 */
async function roundCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const verb = args[0]
  if (verb !== 'new') {
    return usageFail(`round 的子命令只有 new（这一站）：拿到的是 ${verb === undefined ? '（空）' : verb}`)
  }
  const goal = args[1]
  if (goal === undefined || goal === '') return usageFail('round new 需要 <目标>：轮级意图的那一句')

  let split: SplitAssignment[]
  let doc: ConfigDoc
  try {
    doc = await readConfig(root)
    split = readSplit(doc, flags.get('split'))
  } catch (err) {
    if (err instanceof RoundStartError) return fail(err.message)
    if (err instanceof ConfigError) return fail(err.message)
    throw err
  }
  if (split.length === 0) {
    return usageFail(
      '这一轮一份拆分草案都没有：配置里的 round.split 是空的\n' +
        `加一份：fugue --root ${root} config set round.split '[{"goal":"…","ownedPaths":["src/a.ts"],"assertions":[{"action":"test","name":"测试全过"}]}]'`,
    )
  }

  // 轮次号：配置里有就用它，否则 `r1`。**一个工作区开箱就能开一轮**，不必先配一遍。
  const rawRound = getConfig(doc, 'round.id')
  const round = typeof rawRound === 'string' && rawRound !== '' ? rawRound : 'r1'

  // **身份名就是那条 ref 的中间那一段。** `refFor(agent)` 给的是 `refs/heads/<agent>`，而架构 § 4
  // 那张表写的是 `refs/heads/agent/<round>/<n>`——所以 agent 那一栏是 `agent/<round>/<n>`，
  // 于是这一份里的每一处都从同一个名字出发：分支 ref · 物化根 `mat/<agent>/` · 日志
  // `log/<agent>.jsonl`（§ 9.2 那张布局表）。
  const agents: AgentId[] = split.map((_, i) => `agent/${round}/${i + 1}` as AgentId)
  const branchOf = (a: AgentId): BranchId => `agent/${a}` as BranchId
  const materialize = flags.has('materialize')

  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  try {
    const started = await startRound({
      roots: ctx.roots,
      truth: ctx.truth,
      log: ctx.log,
      round,
      intent: { goal },
      split,
      agents,
      branchOf,
      seedOf: () => [] as readonly RelPath[],
      // 物化那一档：每一条分支一个口，那个 agent 自己的日志。
      logForAgent: (a) => openLog(root, { write: a as WriterId, sync: 'each' }),
      materialize,
    })
    if (json) {
      emitJson({
        round: started.round,
        base: started.base,
        contracts: started.built.contracts,
        owners: started.owners,
        seedLimit: started.built.seedLimit,
        seedBytes: started.built.seedBytes,
        intersections: started.precheck.lines,
        materialized: materialize,
        branches: started.forks.map((f) => ({ agent: f.agent, base: f.base, strategy: f.strategy, merged: f.merged })),
        trail: started.trail,
      })
    } else {
      emitLine(`${started.round}\t${started.base}\t${started.built.contracts.length} 份契约\t${agents.length} 条分支`)
      for (const c of started.built.contracts) {
        emitLine(`  ${c.id}\t${c.agent}\t${c.kind}\t${writeSetLine(c)}`)
      }
      for (const f of started.forks) emitLine(`  ${f.agent}\tfork ${f.strategy}\t${f.merged}`)
      if (started.forks.length === 0) {
        process.stderr.write('物化没有铺（架构 § 14.1 的 deferMaterialize：走按需物化）；要现在铺就加 --materialize\n')
      }
      // **不交时也印这一行**：走查里第一条验证的负对照就是"同一把尺子报 0 对"——
      // 不印的话那一档与"预检压根没跑"在读数上分不开（都是没有这一行）。
      process.stderr.write(`写入集预检：${writeSetPaths(started.built.contracts).length} 条路径 · ${started.precheck.lines.length} 对相交`)
      if (started.precheck.lines.length > 0) {
        process.stderr.write('，照发：\n')
        for (const l of started.precheck.lines) process.stderr.write(`  ${l}\n`)
      } else {
        process.stderr.write('\n')
      }
    }
    return 0
  } catch (err) {
    if (err instanceof RoundStartError) return fail(err.message)
    throw err
  } finally {
    await ctx.close()
  }
}

/**
 * `fugue round run <目标>`：**一条命令跑完一个轮次**（架构 § 20 S7 的可用性 · PLAN § 5.7 的收口
 * 第一条）。这一层只做三件事：把配置读成"拆分草案 + 断言"两栏 · 给打桩一个形状 · 把读数排成两列。
 *
 * 轮次本身的顺序住在 `src/round/execute.ts`，验收住 `src/merge/accept.ts`，折叠住
 * `src/merge/merge.ts`——这一层不认识状态机、不认识契约的形状、不认识冲突。
 *
 * **模型那一侧今天是打桩的**（PLAN § 5.7 的"不在这一站里的"第一行）。打桩的形状是：每个 agent
 * 在它自己的底上造一棵树、落一个提交——一份契约一个提交。`--fail n` 让第 n 个交一棵"必然不满足
 * 断言"的树（走查要撞红那一次），`--deny n` 让第 n 个的格子里多跑一条必然被拒的动作。
 */
async function roundRun(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const goal = args[0]
  if (goal === undefined || goal === '') return usageFail('round run 需要 <目标>：轮级意图的那一句')

  let doc: ConfigDoc
  let split: SplitAssignment[]
  let assertions: AssertionSpec[]
  try {
    doc = await readConfig(root)
    split = readSplit(doc, flags.get('split'))
    assertions = readAssertions(doc)
  } catch (err) {
    if (err instanceof RoundStartError) return fail(err.message)
    if (err instanceof ConfigError) return fail(err.message)
    throw err
  }
  if (split.length === 0) return usageFail('这一轮一份拆分草案都没有：配置里的 round.split 是空的')
  if (assertions.length === 0) {
    return usageFail(
      '一条断言都没有：零条会让「打回率低」这句话没有分母（PLAN § 5.7 的地板第二档）\n' +
        `加一条：fugue --root ${root} config set round.assertions '[{"name":"测试全过","argv":["/bin/sh","-c","true"]}]'`,
    )
  }

  const rawRound = getConfig(doc, 'round.id')
  const round = typeof rawRound === 'string' && rawRound !== '' ? rawRound : 'r1'
  const agents: AgentId[] = split.map((_, i) => `agent/${round}/${i + 1}` as AgentId)
  const branchOf = (a: AgentId): BranchId => `agent/${a}` as BranchId
  // `--fail <断言名>`：把配置里**那一条**断言换成必然失败的一条。撞不上就什么都不做——这一档是
  // "走查要撞红"，不是"让这一趟注定失败"。
  const failTarget = typeof flags.get('fail') === 'string' ? (flags.get('fail') as string) : undefined
  const retriesLeft = numberOf(flags.get('retry')) ?? 0
  const deny = flags.has('deny')
  // 合并前那一档预检的严宽：**缺省报出即拒**（不可逆点，A2 的 `mergeGate`）。
  // `--soft-merge-gate` 把它拉平到 `Planning` 那一档（报出、照发）——真冲突由折叠当场报出，
  // 不静默。走查要撞出折叠里那一次冲突，就得走这一档（两份契约的写入面相交时，硬那一档先拦）。
  const softMergeGate = flags.has('soft-merge-gate')
  // `--poke <路径>`：**在漂移检之前手改一条路径**（走查要量漂移那一条）。不给就什么都不做。
  const poke = typeof flags.get('poke') === 'string' ? (flags.get('poke') as string) : undefined
  // `--poke-exact <路径>[,<路径>…]`：**把这一趟折出来的目标树里那几条路径的字节照抄到盘上**，
  // 位置与 `--poke` 相同。走查要量"两边逐字节相同 → 照合并"那一档（A10 的断言 ③）：用户手里
  // 那份**恰好就是**合并算出来的结果，于是推进不会覆盖任何人的字节。抄的是树上的字节，所以与
  // 打桩那几行无关。**逗号分隔**：参数解析器一 flag 一个值（重复给只留最后一个）。
  const pokeExact =
    typeof flags.get('poke-exact') === 'string'
      ? (flags.get('poke-exact') as string).split(',').map((x) => x.trim()).filter((x) => x !== '')
      : []

  // **`--live`：接真驱动**（`B7.5`）。不给就是打桩那一档——它一条断言都不需要凭据。
  const live = flags.has('live')
  const credentialPath = typeof flags.get('credential') === 'string' ? (flags.get('credential') as string) : CREDENTIAL_FILE
  // `--dump-wire <目录>`：**要它才落**（不给时 `dumpDir` 是 `undefined`，那一层不拼）。
  const dumpFlag = flags.get('dump-wire')
  if (dumpFlag === true) return usageFail('--dump-wire 要一个目录：--dump-wire /tmp/fugue-wire')
  // **两处守卫都在这里先过**：落点（`--dump-wire` 不许在工作区里）与凭据。顺序是有意的——
  // 落点那一条是**这一趟的入场条件**（不成立就不该开工），而凭据那一条只在真要出网时才要；
  // 原先它们挤在 deps 那个对象字面量里求值，于是"落在工作区里"会被"凭据不在"抢答（实测）。
  const dumpDir = typeof dumpFlag === 'string' ? dumpWireDir(root, resolve(dumpFlag)) : undefined
  const credential = live ? credentialAt(credentialPath) : null
  // `--max-steps`：**花钱的那道上界**。取值要是一个正整数；不认的写法当场拒（不替它猜）。
  const stepsFlag = flags.get('max-steps')
  let maxSteps: number | undefined
  if (typeof stepsFlag === 'string') {
    const n = Number(stepsFlag)
    if (!Number.isInteger(n) || n < 1) return usageFail(`--max-steps 要一个正整数，拿到 ${JSON.stringify(stepsFlag)}`)
    maxSteps = n
  } else if (stepsFlag === true) {
    return usageFail('--max-steps 要一个数：--max-steps 8')
  }
  const handoff = flags.has('no-handoff') ? false : undefined
  // **一个 agent 一个日志口、由调用方持有**（`hold.ts` 那道栅栏：同一个 writer 开第二个口就是
  // "已经有写者"）。这一份记着开过的口，轮次跑完一起关（`closeAgentLogs`）。
  const agentLogs = new Map<AgentId, LogHandle>()
  const agentLogOf = (a: AgentId): Log => {
    const hit = agentLogs.get(a)
    if (hit !== undefined) return hit
    const made = openLog(root, { write: a as WriterId, sync: 'each' })
    agentLogs.set(a, made)
    return made
  }
  const closeAgentLogs = async (): Promise<void> => {
    for (const [a, l] of agentLogs) {
      agentLogs.delete(a)
      await l.close()
    }
  }
  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  try {
    const stub: Stub = {
      run: async (agent, c, base, hint) => {
        // **解决那一格走另一条路**：把冲突路径上的内容**收敛到下一折那一路**（`hint.nextBranch`），
        // 于是下一折的逐文件比对什么都看不到——折得下去。这是"逐路折叠"这条路的真实形状。
        if (c.kind === 'resolve' && hint !== undefined) {
          const inherited = new Map((await entriesOf(ctx.truth, hint.nextBranch)).map((e) => [e.name, e]))
          return ctx.truth.commit(await ctx.truth.putTree([...inherited.values()]), [base], `（打桩·解冲突：收敛到下一折那一路）${agent}`)
        }
        // **打桩改的是"这一份契约的写入面里第一条真路径"**：写入面里有两条时第一条往往是目录、
        // 第二条是它底下的文件。这样"撞不撞车"由拆分草案决定（走查要拿它撞一次），打桩自己不猜。
        const surface: readonly string[] = c.kind === 'implement' ? c.ownedPaths : c.kind === 'resolve' ? c.conflictPaths : [`evidence-${agents.indexOf(agent) + 1}`]
        const covers = (a: string, b: string): boolean => a === b || b.startsWith(`${a}/`)
        const isPrefix = surface.some((q) => surface.some((r) => r !== q && covers(q, r)))
        const where = surface.find((q) => !isPrefix || !surface.some((r) => r !== q && covers(q, r) && r !== q)) ?? `stub-${agents.indexOf(agent) + 1}`
        // 内容带上契约的 id：**两份契约改同一条路径时，两条分支的那一条内容不同**——否则
        // "相对底改了哪些路径"算出来是空的（内容一样 = 与底一样）。
        const files: Record<string, string> = { [where]: `（打桩）${c.id} 改了 ${where}\n` }
        const entries = []
        for (const [path, text] of Object.entries(files)) {
          const id = await ctx.truth.putBlob(new TextEncoder().encode(text))
          entries.push({ name: path, mode: 0o100644, id })
        }
        // **新树 = 底那棵树 + 这一格的改动。** 这一句是承重的：折出来的那棵目标树就是第 7 步
        // 要推进工作树的那一棵，所以它必须是**底的整棵树**加上改动——只落改动那几条的话，
        // 底里其余的路径在目标树里都不存在，推进会当成"要删"（A10 把判据换成"目标树 vs 盘上"
        // 之后，走查当场量到了这一条）。打桩不删、只加改。
        const inherited = await entriesOf(ctx.truth, base)
        const merged = new Map(inherited.map((e): [string, (typeof entries)[number]] => [e.name, e]))
        for (const e of entries) merged.set(e.name, e)
        return ctx.truth.commit(await ctx.truth.putTree([...merged.values()]), [base], `（打桩）${agent}`)
      },
    }

    const specsOf = (c: Contract, agent: AgentId): readonly AssertionRunSpec[] => {
      void c
      void agent
      return assertions.map((a) => {
        const fail = failTarget !== undefined && a.name === failTarget
        return {
          assertion: { action: a.name, name: a.name, expect: a.expect } as Assertion,
          argv: fail ? ['/bin/sh', '-c', 'exit 1'] : a.argv,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
        }
      })
    }

    const started = await runRound({
      roots: ctx.roots,
      truth: ctx.truth,
      log: ctx.log,
      logOf: agentLogOf,
      closeAgentLogs,
      round,
      intent: { goal },
      split,
      agents,
      branchOf,
      seedOf: () => [] as readonly RelPath[],
      logForAgent: agentLogOf,
      materialize: flags.has('materialize'),
      // **两条路在 `runRound` 眼里没有区别**（同一个 `AgentDriver`）：打桩那一档把 `Stub` 包
      // 一层（S7 定下的那个形状不动），真驱动那一档走 `realDriver` + `DriverSupport`。凭据那一
      // 步只在这一档走（不打 `--live` 的话 `driverSupport` 一次都不被调）。
      stub: stubDriver(stub),
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(handoff === undefined ? {} : { handoff }),
      ...(live && credential !== null
        ? { driver: driverSupport({ root, doc, credential, ...(dumpDir === undefined ? {} : { dumpDir }) }) }
        : {}),
      specsOf,
      retriesLeft,
      softMergeGate,
      onDrift: (d) => {
        const covered = d.drift.colliding.length === 0 ? '（没有）' : d.drift.colliding.join(' · ')
        process.stderr.write(
          `漂移检：HEAD ${d.drift.headMoved ? '动了' : '没动'} · 这次合并动到 [${d.drift.touched.join(' · ')}] · ` +
            `盘上与目标树不同 [${d.drift.divergent.join(' · ')}] · 会被覆盖的（盘上既不是底也不是目标树）[${covered}]\n`,
        )
      },
      ...(poke === undefined
        ? {}
        : {
            beforeMerge: () => {
              const abs = join(ctx.roots.realRoot, poke)
              mkdirSync(join(abs, '..'), { recursive: true })
              const before = existsSync(abs) ? statSync(abs).size : -1
              appendFileSync(abs, `轮次中有人手改了这条：${poke}\n`)
              process.stderr.write(
                `--poke ${poke}：${abs}（${before} → ${statSync(abs).size} 字节）· realRoot=${ctx.roots.realRoot}\n`,
              )
            },
          }),
      ...(pokeExact.length === 0
        ? {}
        : {
            afterFold: async (target: CommitId) => {
              for (const p of pokeExact) {
                const abs = join(ctx.roots.realRoot, p)
                const before = existsSync(abs) ? statSync(abs).size : -1
                const bytes = await ctx.truth.readAt(target, p)
                if (bytes === null) throw new Error(`--poke-exact ${p}：目标树里没有这条路径`)
                mkdirSync(join(abs, '..'), { recursive: true })
                writeFileSync(abs, bytes)
                process.stderr.write(
                  `--poke-exact ${p}：${abs}（${before} → ${statSync(abs).size} 字节）——盘上抄的是目标树里那一份\n`,
                )
              }
            },
          }),
    })

    // `--deny`：**真让内核拒一次写**，把那一趟记成 `run/end`。三个数里第三个的来源就是这一条
    // 事件；而这一跑要给的是一个**真的**被拒，不是一个自己写的 `denied: true`。
    let deniedAction: { agent: AgentId; exit: number; denied: boolean; note: string } | null = null
    if (deny) {
      const agent = agents[0]
      if (agent === undefined) return usageFail('--deny：这一轮一个 agent 都没有')
      const r = await refuseOneWrite(ctx.truth, started.base, 'round-deny-')
      deniedAction = { agent, exit: r.exit, denied: r.denied, note: r.note }
      const agentLog = openLog(root, { write: agent as WriterId, sync: 'each' })
      try {
        await agentLog.append(agent as WriterId, {
          t: 'run/end',
          agent,
          step: 'deny',
          exit: r.exit,
          ms: 0,
          denied: r.denied,
        })
      } finally {
        await agentLog.close()
      }
    }

    // 打回那三个数：**从日志重算**（架构 § 8.15）。同一份日志算两次同值——所以 `--report` 印的
    // 就是刚才那一趟跑出来的那份日志。
    const readings = await computeAll(() => ctx.log.readMerged(), { round })
    const report = reportOf({ round }, readings)
    // 八元指标（架构 § 8.15）：**与上面那三个数同一个来源**（同一份日志 · 同样重算）。
    // 那一趟的日志就是刚才跑出来的那一份——所以 `--metrics` 印的就是这一趟。
    const metrics = flags.has('metrics') ? await computeAllMetrics(() => ctx.log.readMerged(), { round }) : null

    if (json) {
      emitJson({
        round: started.round,
        base: started.base,
        state: started.state,
        contracts: started.started.built.contracts.map((c) => ({ id: c.id, agent: c.agent, kind: c.kind })),
        precheckPlanning: started.precheckPlanning,
        precheckMerge: started.precheckMerge,
        drift: started.drift === null ? null : { ok: started.drift.ok, dirty: started.drift.dirty, colliding: started.drift.colliding },
        fold: started.fold.kind === 'folded' ? { kind: 'folded', steps: started.fold.steps } : { kind: 'conflict' },
        conflictTree: started.conflictTree,
        verify: { pass: started.report.pass, fail: started.report.fail, unrunnable: started.report.unrunnable, ok: started.report.ok },
        assertions: started.report.results,
        advanced: started.advanced === null ? null : { written: started.advanced.written, removed: started.advanced.removed, skipped: started.advanced.skipped },
        deniedAction,
        // **`--json` 与文字那一档给的是同一件事**：文字那一档 `--metrics` 印的是八元指标
        // （`lineOf`），所以这一档的 `metrics` 就是那八条；不给 `--metrics` 时是 `null`。
        // （原先这一栏放的是 `report.readings`——那是**打回**那三个数，与 `--report` 同源，
        // 而八元指标另挂在 `probe` 那一栏。两条路给的不是一件事，名字还都叫指标。）
        metrics: metrics === null ? null : [...metrics],
        report: report.readings,
      })
    } else {
      emitLine(`${started.round}\t${started.base}\t${started.state}`)
      emitLine(`  契约 ${started.started.built.contracts.length} 份：${started.started.built.contracts.map((c) => c.id).join(' · ')}`)
      emitLine(`  预检：Planning ${started.precheckPlanning} 对 · 合并前 ${started.precheckMerge.count} 对`)
      emitLine(`  折叠：${started.fold.kind === 'folded' ? `折了 ${started.fold.steps} 步` : '停在冲突上'}`)
      emitLine(`  验收：通过 ${started.report.pass} · 没通过 ${started.report.fail} · 跑不起来 ${started.report.unrunnable}`)
      if (started.advanced !== null) {
        emitLine(`  推进：写 ${started.advanced.written.length} 条 · 删 ${started.advanced.removed.length} 条 · 跳过 ${started.advanced.skipped.length} 条`)
      } else {
        emitLine('  推进：没有（验收没过——真实工作树一个字节都没动）')
      }
      if (deniedAction !== null) emitLine(`  被拒的动作：exit ${deniedAction.exit} · denied=${String(deniedAction.denied)}（${deniedAction.note}）`)
      if (flags.has('report')) {
        emitLine('打回读数（从日志重算，不采集）：')
        for (const l of report.lines) emitLine(`  ${l}`)
      }
      if (metrics !== null) {
        emitLine('八元指标（从日志重算，不采集；分子与分母一起印）：')
        for (const m of metrics) emitLine(`  ${lineOf(m)}`)
      }
      if (!started.report.ok) {
        for (const r of started.report.results.filter((x) => x.verdict !== 'pass')) {
          process.stderr.write(`${r.verdict}\t${r.assertion}\t${r.note}\n`)
        }
      }
    }
    // 没通过那一档：退出码 1（**不是用法错**：这一趟真的跑了，只是没通过）。
    return started.report.ok ? 0 : 1
  } catch (err) {
    if (err instanceof RoundRunError) return fail(`${err.at}：${err.message}`)
    if (err instanceof RoundStartError) return fail(err.message)
    throw err
  } finally {
    // **agent 那几个口由调用方关**（`runRound` 只借不还）。
    await closeAgentLogs()
    await ctx.close()
  }
}

/**
 * **真让内核拒一次写。** 把那棵树设成只读，再往树里一条**已经存在的文件**追加一个字节——
 * `open(O_APPEND)` 拿 EROFS / EACCES，退出码非零，stderr 上是内核那句话。
 *
 * `denied` 是**读出来的**（`exec.ts` 读 stderr 上的拒绝签名，与 `run/end` 那一栏同一个口径），
 * 所以这一处读的也是 stderr，**不自己写一个 `denied: true`**。
 */
async function refuseOneWrite(
  truth: TruthHandle,
  commit: CommitId,
  prefix: string,
): Promise<{ exit: number; denied: boolean; note: string }> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  await materializeCommit(truth, commit, dir)
  const victim = join(dir, (await entriesOf(truth, commit))[0]?.name ?? 'x')
  const readOnly = (p: string): void => {
    chmodSync(p, 0o444)
  }
  try {
    readOnly(victim)
    const r = spawnSync('/bin/sh', ['-c', `printf x >> ${JSON.stringify(victim)}`], { encoding: 'utf8' })
    const stderr = r.stderr ?? ''
    const denied = (r.status ?? 1) !== 0 && /read-only|Read-only|EROFS|Permission denied|Permission denied/i.test(stderr)
    return {
      exit: r.status ?? 1,
      denied,
      note: denied ? `内核拒了这次写（${stderr.trim().split('\n')[0] ?? ''}）` : `写入没被拒（stderr：${stderr.trim().slice(0, 80)}）`,
    }
  } finally {
    chmodSync(victim, 0o644)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 配置里的一条断言：`{ name, argv, expect?, where? }`。**它与契约的 `Assertion` 是两个形状**
 * （那一份只有动作名），所以这一步是"动作名 → 命令行"翻译的落点，而今天它读的是配置。 */
interface AssertionSpec {
  readonly name: string
  readonly argv: readonly string[]
  readonly expect: number
}

/** 读配置里的断言那一栏。**解析不了就拒**，不当成"没有断言"（那会让轮次静默地没有判据）。 */
function readAssertions(doc: ConfigDoc): AssertionSpec[] {
  const v = getConfig(doc, 'round.assertions')
  if (v === undefined) return []
  const list = typeof v === 'string' ? JSON.parse(v) : v
  if (!Array.isArray(list)) throw new RoundStartError('round.assertions 要是一个数组')
  return list.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new RoundStartError(`第 ${i + 1} 条断言要是一个对象`)
    }
    const o = raw as Record<string, unknown>
    if (typeof o.name !== 'string' || o.name === '') throw new RoundStartError(`第 ${i + 1} 条断言缺 name`)
    if (!Array.isArray(o.argv) || o.argv.length === 0 || !o.argv.every((x) => typeof x === 'string')) {
      throw new RoundStartError(`第 ${i + 1} 条断言的 argv 要是一个非空的字符串数组`)
    }
    const expect = o.expect === undefined ? 0 : o.expect
    if (typeof expect !== 'number' || !Number.isInteger(expect)) {
      throw new RoundStartError(`第 ${i + 1} 条断言的 expect 要是一个整数`)
    }
    return { name: o.name, argv: o.argv as readonly string[], expect }
  })
}

/** 这一轮几份契约一共占了多少条路径（读数的分母，与判决无关）。 */
function writeSetPaths(contracts: readonly Contract[]): string[] {
  const all = new Set<string>()
  for (const c of contracts) {
    const paths = c.kind === 'implement' ? c.ownedPaths : c.kind === 'resolve' ? c.conflictPaths : []
    for (const p of paths) all.add(p)
  }
  return [...all]
}

/** 那几面 `--fail`/`--deny`/`--retry` 的开关：不给就是 `undefined`（"没要求"），给了要是个正整数。 */
function numberOf(v: string | true | undefined): number | undefined {
  if (v === undefined || v === true) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** 把一个提交铺到一个临时目录里——`--deny` 那一档要在真盘上试一次写入。 */
async function scratchTree(truth: TruthHandle, commit: CommitId): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-round-deny-'))
  await materializeCommit(truth, commit, dir)
  return dir
}

/** 契约要写哪儿，给那一行印出来（三种来源各自那一份）。 */
function writeSetLine(c: {
  kind: string
  ownedPaths?: readonly RelPath[]
  conflictPaths?: readonly RelPath[]
  evidenceRequired?: readonly { artifact: RelPath }[]
}): string {
  if (c.kind === 'implement') return (c.ownedPaths ?? []).join(' · ')
  if (c.kind === 'resolve') return (c.conflictPaths ?? []).join(' · ')
  return (c.evidenceRequired ?? []).map((e) => e.artifact).join(' · ')
}

/**
 * 读配置里的拆分草案（`round.split`）。**给的就是一份数组，一份草案一笔**——不另造一套键名，
 * 因为草案的键就是契约的键（架构 § 15.1.a）。
 *
 * 解析不了就拒，不当成空草案：把一份坏配置读成"这一轮没有草案"，症状是"开不出轮次"而说不出为什么。
 * `--split <json>` 盖过配置——一个工作区想开两轮不同拆法的轮次时用它，不必改配置。
 */
function readSplit(doc: ConfigDoc, override: string | true | undefined): SplitAssignment[] {
  const raw = override === true ? undefined : override
  let text: string
  if (raw !== undefined) {
    text = raw
  } else {
    const v = getConfig(doc, 'round.split')
    if (v === undefined) return []
    text = typeof v === 'string' ? v : JSON.stringify(v)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new RoundStartError(`round.split 不是一份完整的 JSON：${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) throw new RoundStartError('round.split 要是一个数组：一份草案一笔')
  return parsed.map((one, i) => splitOf(one, i + 1))
}

/** 一份草案：`goal` · `ownedPaths` · `assertions` 三样必给，`deliverables` 可空。 */
function splitOf(raw: unknown, n: number): SplitAssignment {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RoundStartError(`第 ${n} 份草案要是一个对象`)
  }
  const o = raw as Record<string, unknown>
  const goal = o.goal
  if (typeof goal !== 'string' || goal === '') throw new RoundStartError(`第 ${n} 份草案缺 goal`)
  const ownedPaths = o.ownedPaths
  if (!Array.isArray(ownedPaths) || ownedPaths.length === 0 || !ownedPaths.every((x) => typeof x === 'string')) {
    throw new RoundStartError(`第 ${n} 份草案的 ownedPaths 要是一个非空的字符串数组`)
  }
  const assertions = o.assertions
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new RoundStartError(`第 ${n} 份草案没有断言：零条断言会让「打回率低」这句话没有分母`)
  }
  const deliverables = o.deliverables === undefined ? [] : o.deliverables
  if (!Array.isArray(deliverables)) throw new RoundStartError(`第 ${n} 份草案的 deliverables 要是一个数组`)
  return {
    goal,
    ownedPaths: ownedPaths as readonly string[],
    assertions: assertions as SplitAssignment['assertions'],
    deliverables: deliverables as SplitAssignment['deliverables'],
  }
}

/**
 * `fugue config show|get|set`（§ 9.6 的配置组 · § 15.3.a 的工作区级配置）。
 *
 * 三条命令都**不建视图、不读日志**——配置是工作区的输入，不是它的状态。所以它们在一个还
 * 没有对象库的目录里照常可用；反过来说，重放这条链上没有任何一处读配置（PLAN § 5 的 U5
 * 断言一：配置改动后重放结果不变）。
 *
 * 三个动词各报自己那件事：`show` 报全文 · `get` 报一条值 · `set` 报这次改动（含老值——
 * § 15.3.a 要"每次改动记原值"，人这一面先做到"改一次就报一次"，留档与逆操作是 T5）。
 */
async function config(root: string, args: string[], json: boolean): Promise<number> {
  const verb = args[0]
  try {
    if (verb === 'show') {
      const doc = await readConfig(root)
      emitLine(json ? JSON.stringify(doc) : JSON.stringify(doc, null, 2))
      return 0
    }
    if (verb === 'get') {
      const key = args[1]
      if (key === undefined) return usageFail('config get 需要 <key>')
      const value = getConfig(await readConfig(root), key)
      if (value === undefined) return fail(`config get：没有这条键 —— ${key}`)
      // 人这一面：字符串吐原样（好接管道），别的吐 JSON。`--json` 那一面一律是 JSON。
      if (json) emitJson(value)
      else emitLine(typeof value === 'string' ? value : JSON.stringify(value))
      return 0
    }
    if (verb === 'set') {
      const key = args[1]
      const raw = args[2]
      if (key === undefined || raw === undefined) return usageFail('config set 需要 <key> <value>')
      const doc = await readConfig(root)
      const old = getConfig(doc, key)
      const value = parseConfigValue(raw)
      setConfig(doc, key, value)
      await writeConfig(root, doc)
      const out: Record<string, unknown> = { key, value, path: configFileOf(root) }
      // **老值只在原本有这条键时出现**：凭空多一个 `old: null` 会与"存了个 null"混起来。
      if (old !== undefined) out.old = old
      if (json) emitJson(out)
      else {
        emitLine(`${key}	${old === undefined ? '(没有)' : JSON.stringify(old)}	→	${JSON.stringify(value)}`)
      }
      return 0
    }
    return usageFail(`config 需要 show|get|set，收到：${verb ?? '(空)'}`)
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message)
    throw err
  }
}

/**
 * `fugue policy [<action>]`——把这一趟的策略值印出来（架构 § 8.8 · § 9.6 的边界那一行）。
 *
 * **两处读同一份**：这里印的与 `fugue run` 写进 `run/confined` 的，是同一个 `resolvePolicy()`
 * 的返回值——不是两处各算一遍再对答案。所以它不需要视图、不需要日志：策略值的输入是配置与
 * 探针，不是工作区的状态（与 `config` 同一条道理）。
 *
 * 给了 `<action>` 就报**那个动作那一趟**的值：动作是唯一能点名要网的地方（`net` 那一栏）。
 */
async function policyCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const mode = modeOf(flags)
  if (mode === null) {
    return usageFail(`--mode 取 read-only 或 workspace-write：${JSON.stringify(flags.get('mode'))}`)
  }
  const abs = resolve(root)
  const agent = agentFor(writerOf(flags))
  const name = args[0]
  try {
    const doc = await readConfig(abs)
    const binding = name === undefined || name === '' ? undefined : readBinding(doc, name)
    const roots = createRoots(abs)
    const probed = probeLayers(roots)
    const policy = resolvePolicy({ roots, agent, doc, mode, binding, probed })
    if (json) {
      emitJson({ agent, action: name ?? null, ...policy, note: probed.note })
    } else {
      const layers = policy.layers.length === 0 ? '没有（§ 15.7 的 E4 退化档）' : policy.layers.join(' + ')
      process.stdout.write(
        `档 ${policy.mode} · enforcement ${policy.enforcement} · 在场的层 ${layers}\n` +
          `网络 ${policy.net}${policy.net === 'none' ? '（--unshare-net 把网切掉；回环照旧）' : '（动作点名要的）'}\n` +
          `可达集 ${policy.reach.roRoots.length} 条只读根 · ${policy.reach.symlinks.length} 条软链 · ` +
          `${policy.reach.devices.length} 处设备与进程 · 树里挖掉 ${policy.reach.mask.join(' · ')}\n` +
          `  只读根 ${policy.reach.roRoots.join(' · ')}\n` +
          `可写落点 ${policy.writableRoots.join(' · ')}\n` +
          `${probed.note}\n`,
      )
    }
    return 0
  } catch (err) {
    if (err instanceof ConfigError || err instanceof BindingError || err instanceof PolicyError) {
      return fail(err.message)
    }
    throw err
  }
}

/**
 * `fugue diff-stat [<dir>] [--baseline <file>] [--save <file>]`（§ 9.6 的物化行 · § 9.8）。
 *
 * 它是**尺子**，不是物化的一步：只读——不动物化树、不动挂载态（§ 8.5 把 `diff-stat` 与
 * `verify-mat` 并列写成只读）。所以它既不建视图也不读日志：树在盘上什么样，它就报什么样。
 *
 * 不给 `<dir>` 时扫的是这个 agent 的合并树（§ 8.4 的 `merged`）。树还没铺就**拒绝并指路
 * `fork`**——不当成"空树，0 条变化"：那是尺子最坏的一种错法，量出来的 0 会被读成"树没变"。
 * 基线由 `--baseline` 给、`--save` 存，它自己不占持久化位置（PLAN § 5.2 的 V1 行）。
 *
 * **变化条数不进退出码**：退出 0 就是"扫完了、比完了"。§ 9.8 里 `1` 是"这件事没做成"，
 * 而"树变了"不是没做成。
 */
function diffStatCmd(root: string, flags: Map<string, string | true>, args: string[], json: boolean): number {
  const where = args[0]
  let dir: string
  try {
    dir = where === undefined ? createRoots(resolve(root)).mergedRoot(agentFor(writerOf(flags))) : resolve(where)
  } catch (err) {
    return fail((err as Error).message)
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    if (where !== undefined) return fail(`不是一棵能扫的树：${dir}`)
    return fail(`物化的合并树还没铺：${dir}\n先 fugue fork <base> 铺一棵（§ 8.5）。`)
  }

  const baseFlag = flags.get('baseline')
  const saveFlag = flags.get('save')
  if (baseFlag === true || saveFlag === true) return usageFail('--baseline 与 --save 都要一个文件名')
  const baseFile = typeof baseFlag === 'string' ? resolve(baseFlag) : undefined
  const saveFile = typeof saveFlag === 'string' ? resolve(saveFlag) : undefined
  // **别把尺子放进树里**：基线自己也是一份新文件，留在被扫的树里，下一轮它会被报成
  // "多了一条"——量树的人亲手污染读数。拦住比事后解释便宜。
  for (const [what, file] of [
    ['--baseline', baseFile],
    ['--save', saveFile],
  ] as const) {
    if (file !== undefined && insideTree(dir, file)) {
      return fail(`${what} 指向被扫的树里：${file}\n基线是尺子，不是树的一部分——把它挪到 ${dir} 之外。`)
    }
  }

  let before: TreeStat | undefined
  let now: TreeStat
  try {
    // 基线**先读**：读不动就拒绝，绝不当成"什么都没变"（与配置同一条纪律）。
    if (baseFile !== undefined) before = loadTreeStat(baseFile)
    now = scanTree(dir, { skip: WORKSPACE_STATE })
    if (saveFile !== undefined) storeTreeStat(saveFile, now)
  } catch (err) {
    if (err instanceof TreeStatError) return fail(err.message)
    return fail(`扫不动 ${dir}：${(err as Error).message}`)
  }
  // 过程走 stderr（§ 9.8 的 stdout 纪律）。
  if (saveFile !== undefined) process.stderr.write(`快照存到 ${saveFile}\n`)

  const paths = now.leaves.length
  // 没给基线：这是一次"拍快照"，报的是树自己。
  if (before === undefined) {
    if (json) emitJson({ root: now.root, paths, leaves: now.leaves })
    else emitLine(`${paths} 个叶子\t${now.root}`)
    // 指路：裸敲这一次拿到的是快照，不是对比。"要对比该给什么"不能靠人去猜（§ 24 纪律 5）。
    process.stderr.write('没有给 --baseline：这是一张快照，不是对比——--save <f> 存下来，下一次 --baseline <f> 读它\n')
    return 0
  }

  const changes = diffStat(before, now)
  if (json) emitJson({ root: now.root, baseline: baseFile, paths, count: changes.length, changes })
  else {
    for (const c of changes) emitLine(`${STATUS_MARK[c.status]}\t${c.path}\t${c.columns.join(',')}`)
    process.stderr.write(
      changes.length === 0
        ? `没有变化\t${paths} 个叶子\t基线 ${baseFile}\n`
        : `${changes.length} 条变化\t${paths} 个叶子\t基线 ${baseFile}\n`,
    )
  }
  return 0
}

/** 人读那一面的记号：增 · 删 · 改。`--json` 那一面给的是 `status` 这个字本身。 */
const STATUS_MARK: Record<ChangeStatus, string> = { added: '+', removed: '-', changed: '~' }

/** 策略名——给用法错与 `--json` 用；次序就是 § 8.5 策略表里的那三档（`reflink` 不在列）。 */
const STRATEGIES: readonly ForkStrategy[] = ['overlayfs', 'hardlink-ro', 'copy']

/**
 * `fugue assemble <protocol> [--agent <id>] [--against <protocol>] [--json]`（架构 § 9.6 的装配行 ·
 * § 20 S6 的交付物）。
 *
 * **它是结账口**：三区哈希 · 每区的字节数 · 第一处不同（给了 `--against` 时）· 四条约束的检查
 * 结果，一次全印出来。命令行这一层只做三件事——解析参数 · 把结构化结果排成两列 · 决定退出码；
 * 段值从哪来住在 `sources.ts`，装配住在 `assemble.ts`，四条约束住在 `constraints.ts`。
 *
 * **两个面共用一个形状**（架构 § 9.6：「CLI 的输出就是 `M9` 工具的返回形状」）：`zones` 那三栏
 * 就是 `assemble()` 的三个区按同一套哈希口径读出来的——`--json` 那一份与程序里那次装配逐字节
 * 对得上（`constraints.test.ts` 的 ② 量这一条）。
 *
 * **拒的三处**：协议名不认得（`protocolNamed`）· `--agent` 指了一个不存在的 agent（`resolverFor`，
 * 不给就是持轮者那条路）· `--against` 指的协议不认得。三处都是退出码 1，都报出那个名字。
 */
async function assembleCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const abs = resolve(root)
  const name = args[0]
  if (name === undefined || name === '') {
    return usageFail(`assemble 需要 <protocol>：${Object.keys(PROTOCOLS).join(' 或 ')}`)
  }
  const who = flags.get('agent')
  const against = flags.get('against')
  try {
    const doc = await readConfig(abs)
    const protocol = protocolNamed(name)
    const coord = await agentCoord(abs, typeof who === 'string' ? who : null, doc)
    const segments = sourcesFor(protocol, coord.state, coord.who)
    const prefix = assemble({ protocol, model: DEFAULT_MODEL.id, segments })
    const violations = checkConstraints(protocol, segments, null, '这一步', undefined, prefix)

    const zoneLine = (z: 'A' | 'B' | 'C'): { hash: string; bytes: number } => {
      const bytes = z === 'A' ? prefix.zoneA : z === 'B' ? prefix.zoneB : prefix.zoneC
      return { hash: hashOf(bytes), bytes: bytes.length }
    }
    const zones = { A: zoneLine('A'), B: zoneLine('B'), C: zoneLine('C') }

    let divergence: { against: string; at: number; note: string } | null = null
    if (typeof against === 'string' && against !== '') {
      const other = protocolNamed(against)
      const otherCoord = await agentCoord(abs, typeof who === 'string' ? who : null, doc)
      const otherSegments = sourcesFor(other, otherCoord.state, otherCoord.who)
      const otherPrefix = assemble({ protocol: other, model: DEFAULT_MODEL.id, segments: otherSegments })
      const a = firstDivergence(prefix.zoneA, otherPrefix.zoneA)
      const at = a >= 0 ? a : prefix.zoneA.length + firstDivergenceOrEnd(prefix.zoneB, otherPrefix.zoneB)
      divergence = {
        against,
        at,
        note:
          a >= 0
            ? `A 区第 ${a} 个字节起不同`
            : `共同部分（A + B 相同的 ${at} 个字节）之后是这两份声明各自的地方`,
      }
    }

    if (json) {
      emitJson({
        protocol: name,
        version: protocol.version,
        agent: typeof who === 'string' ? who : null,
        segments: protocol.segmentOrder.length,
        toolCatalog: protocol.toolCatalog.length,
        zones,
        firstDivergence: divergence,
        violations,
      })
    } else {
      emitLine(`协议 ${name} · 版本 ${protocol.version} · ${typeof who === 'string' ? `agent ${who}` : '持轮者那条路'}`)
      emitLine(`段 ${protocol.segmentOrder.length} 段 · 工具目录 ${protocol.toolCatalog.length} 个`)
      for (const z of ['A', 'B', 'C'] as const) {
        emitLine(`${z} 区 ${zones[z].bytes} 字节 · ${zones[z].hash}`)
      }
      if (divergence !== null) emitLine(`与 ${divergence.against} 的第一处不同：第 ${divergence.at} 个字节（${divergence.note}）`)
      emitLine(
        violations.length === 0
          ? '四条约束：一处都不报'
          : `四条约束：报了 ${violations.length} 处\n  ${violations.map(formatViolation).join('\n  ')}`,
      )
    }
    return violations.length === 0 ? 0 : 1
  } catch (err) {
    if (err instanceof SourceError || err instanceof ConfigError || err instanceof Error) {
      return fail(err.message)
    }
    throw err
  }
}

/** 两个字节串从头起相同的长度（`firstDivergence` 在 A 区相同时给 -1，这里要的是那个位置）。 */
function firstDivergenceOrEnd(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

/**
 * 这一次装配用的是谁：不给 `--agent` 就是持轮者那条路（`HOLDER`），给了就去日志里查它的分支头
 * ——查不到当场拒（退出码 1，报出那个名字），**不给主线当默认**（PLAN § 5.6 的 Z4 行那句）。
 *
 * 坐标那两栏的当下取值：`branch` 是日志里那条 ref，`outputPaths` 是契约要求的产物路径（架构
 * § 8.12）——契约值的读取与逐 `kind` 的裁剪落在 S7，所以这一份今天给的是"这个 agent 的产物
 * 目录"这一条机械的取值。
 */
async function agentCoord(
  root: string,
  who: string | null,
  doc: ConfigDoc,
): Promise<{ state: ReturnType<typeof stateWithState>; who: AgentCoord | null }> {
  const state = stateWithState(emptyState(), doc, root)
  if (who === null) return { state, who: HOLDER }
  const truth = openTruth(root)
  try {
    // --agent 收的那一串就是日志里那条 ref 的名字（与 writerOf 同一条口径）。
    const ref = refFor(who)
    const head = await truth.resolve(ref).catch(() => null)
    if (head === null) {
      throw new SourceError(
        `没有这个 agent：${who}——日志里没有 ${ref}。不给 --agent 走的是持轮者那条路，两者不是一回事（架构 § 8.11）。`,
      )
    }
    return { state, who: { id: who, branch: ref, outputPaths: [`deliver/${who}/`] } }
  } finally {
    truth.close()
  }
}

/**
 * **凭据落在工作区外的那个路径**（架构 § 14.4 那份"沙箱里看得见的环境"仍是闭的）。
 *
 * 它是一条**路径**，不是值：值由 harness 进程在真要出网那一刻读一次，不落进事件、不进夹具、
 * 不进沙箱环境（PLAN § 5.8 的口径一）。`ProviderDecl.auth` 那一栏是声明；这一份是壳。
 */
const CREDENTIAL_FILE = '/home/ubuntu/.fugue/credentials/deepseek.key'

/** 公布给模型的那一份目录：**目录 ∩ 实现表**（`B5` 的纪律：只公布能兑现的）。 */
function publishedCatalog(): ReturnType<typeof catalog> {
  return publishedTools(implementedNames(TOOL_NAMES), catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number]))
}

/**
 * 凭据的值：**环境变量优先，其次那个文件**。
 *
 * 两条都是"工作区外的一个声明路径"（`ProviderDecl.auth` 的两种取法），而这里只是**把来源收窄
 * 到一处**：值取来交给 `wireHeader`，别处一个字节都不碰它。读不到时报的话要把两条路都写出来
 * ——只说"读不到文件"会让人以为环境变量那条路不存在。
 */
function credentialAt(path: string): string {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new SourceError(
      `凭据不在：环境变量 DEEPSEEK_API_KEY 没有设，也读不到 ${path}（${(err as NodeJS.ErrnoException).code ?? '未知原因'}）。\n` +
        `  放一份进去：mkdir -p ${dirname(path)} && printf '%s' '<key>' > ${path}\n` +
        '  或者不接驱动：不给 --live 就是打桩那一档（PLAN § 5.8 的口径一：它一条断言都不需要凭据）。',
    )
  }
  const v = text.trim()
  if (v === '') throw new SourceError(`凭据文件是空的：${path}`)
  return v
}

/**
 * 真驱动那一档要的那几样（`DriverSupport`）。**打桩那一档一个都不读**——所以这一份只在
 * `--live` 下拼，凭据那一步也就只在真要出网时才走（PLAN § 5.8 的口径一）。
 *
 * **一个 agent 一份状态、一个句柄**：`sourcesFor(protocol, state, who)` 的输入里有坐标
 * （分支 · 产物路径），而每一条分支的坐标各是各的。所以这一份按 agent 记忆，不是"整轮一份"。
 *
 * **导出它是为了让它能被单独断言**：句柄里"这个 agent 读哪一份协议"这一栏原先写死过
 * `HOLDER_PROTOCOL`，而那一处错了只表现为前缀短了一截（没有别的报错）——所以它要有一条
 * 直接量它的断言（`protocol-wire.test.ts` 的 ①e），而不是靠走到真调用才看得见。
 *
 * 目标那一栏（`Target`）**是唯一碰凭据的地方**，而它在这里就拼好（不是每一步现取）：一次轮次
 * 一个目标，出网那一刻用的就是它。头的名字按**这一条线协议**给（`wireHeader`）——两条线各一套
 * 头，那一栏的差别不是这里的分岔。
 */
export function driverSupport(o: {
  readonly root: string
  readonly doc: ConfigDoc
  readonly credential: string
  /** `--dump-wire` 那一档的落点（**已经在工作区之外**——守卫在 `dumpWireDir`）。不给就不落。 */
  readonly dumpDir?: string
}): DriverSupport {
  const decl = modelDeclOf(DEFAULT_MODEL.id)
  const tools = publishedCatalog()
  const states = new Map<string, AssembleState>()
  const handles = new Map<string, AgentHandle>()
  const target = { ...targetOf(decl.id), headers: wireHeader(decl.wire, o.credential) }

  /**
   * 这个 agent 的第一步那一份状态：**契约值就是它的任务**（B 区那几段照契约填）。
   *
   * 记忆按 agent：同一个 agent 只干一格（一份契约），而记忆是为了让 `state` 与 `handle` 两次问
   * 拿到**同一份对象**（`handle.state` 与 `ask.state` 是同一个值——驱动两边都读）。
   */
  const stateFor = (agent: string, c: Contract): AssembleState => {
    const hit = states.get(agent)
    if (hit !== undefined) return hit
    const base = stateWithState(emptyState(), o.doc, o.root)
    const made: AssembleState = {
      ...base,
      ...(c.kind === 'implement' ? { goal: c.goal, files: c.ownedPaths.map((path) => ({ path, text: '' })) } : {}),
      task: {
        goal: c.kind === 'implement' ? c.goal : c.kind === 'investigate' ? c.question : base.task.goal,
        question: c.kind === 'investigate' ? c.question : '',
        deliverables: c.kind === 'resolve' ? [...c.conflictPaths] : c.deliverables.map((d) => d.path),
        evidenceRequired: c.assertions.map((a) => a.name),
        assertions: c.assertions.map((a) => a.name),
      },
    }
    states.set(agent, made)
    return made
  }

  const handleFor = (agent: string, c: Contract): AgentHandle => {
    const hit = handles.get(agent)
    if (hit !== undefined) return hit
    const made: AgentHandle = {
      agent: agent as AgentId,
      coord: { id: agent, branch: `refs/heads/agent/${agent}`, outputPaths: [`deliver/${agent}/`] },
      branch: `refs/heads/agent/${agent}` as BranchId,
      contract: (c?.id ?? '') as ContractId,
      protocol: protocolFor(decl),
      model: decl.id,
      wireModel: decl.model,
      target,
      adapter: { name: decl.wire },
      state: stateFor(agent, c),
    }
    handles.set(agent, made)
    return made
  }

  return {
    state: (a, c) => stateFor(String(a), c),
    handle: (a, c) => handleFor(String(a), c),
    decl,
    // **要它才包这一层**：不给 `--dump-wire` 时交出去的就是 `wireCall` 本身——多一层包装也许多
    // 一次调用开销，而"用户不用 debug 就不为它付成本"这条要落到结构上，不是靠自觉。
    call: o.dumpDir === undefined ? wireCall : makeDumpCall(wireCall, o.dumpDir),
    tools,
  }
}

/**
 * `--dump-wire` 那个目录的守卫：**必须在工作区之外**。
 *
 * 为什么不是"随便落"：物化的底是**真实工作树**（§ 8.4），落进 `<root>` 里的字节会被下一轮的
 * `fork` 当成漂移（`A10` 那三方比法的第一条线），于是一趟排障会把轮次本身弄脏——而那时候人正
 * 在查别的问题。所以这一条按"失败要指路"给两条出路（约定 § 四 · 架构 § 24 纪律 5）。
 */
function dumpWireDir(root: string, dir: string): string {
  const inRoot = relative(resolve(root), dir)
  const inside = inRoot === '' || (!inRoot.startsWith('..') && !isAbsolute(inRoot))
  if (inside) {
    throw new RoundRunError(
      '--dump-wire',
      `不许落在工作区里：${dir}\n` +
        `  这一份落在 <root>（${resolve(root)}）里面，而物化的底就是真实工作树——` +
        `下一轮的 fork 会把它当成漂移。\n` +
        `  两条路：换个工作区之外的目录（例如 /tmp/fugue-wire），或者这一趟不给 --dump-wire。`,
    )
  }
  return dir
}

/**
 * `fugue fork <base>`：把 base 那棵树物化出来，返回合并树（§ 8.5 · § 9.6）。
 *
 * **它不建视图、不读日志的历史**：物化的底是**真实工作树**，`fork` 只是把它挂上来（§ 8.4）。
 * `base` 在这里只做两件事——解析成一个真提交（免得把一串敲错的字符当成标签记进日志），
 * 以及进 `mat/fork` 事件。**不拿它跟真实工作树比对**：那一步 § 8.4 说得明白，不做检测。
 *
 * 退出码：0 物化好了（**用了哪一档由 stderr 那一行说，也由 `--json` 的 `strategy` 说**）·
 * 1 做不成（底不在 · 挂不上 · 铺不动）· 2 命令行本身不成立。
 */
async function forkCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const base = args[0]
  if (base === undefined || base === '') return usageFail('fork 需要 <base>：一个提交')
  const want = flags.get('strategy')
  if (typeof want === 'string' && !(STRATEGIES as readonly string[]).includes(want)) {
    return usageFail(`--strategy 只认 ${STRATEGIES.join(' · ')}；不给就按策略表探着退档`)
  }
  const roRaw = flags.get('ro')
  const readOnly =
    typeof roRaw === 'string' ? roRaw.split(',').map((s) => s.trim()).filter((s) => s !== '') : undefined

  const abs = resolve(root)
  const writer = writerOf(flags)
  const agent = agentFor(writer)
  // `fork` 既要追加一条 `mat/fork`，又要挂载——同样整条命令一个写者。
  const log = openLog(abs, { write: writer })
  let truth: TruthHandle | null = null
  try {
    truth = openTruth(abs)
    let commit: CommitId
    try {
      commit = await truth.resolve(base)
    } catch (err) {
      return fail(
        `fork：${base} 不是这个工作区里一个能用的提交——<base> 要指向一棵树\n  ${(err as Error).message}`,
      )
    }
    // **视图的底与物化的底必须是同一个提交**（§ 4）：物化的底是真实工作树，视图的底是本 agent
    // 的分支头。不一致时症状是静默的，所以拦在落地之前——这一趟只读了 ref，盘上还什么都没动。
    const disagree = forkBaseRefusal(writer, commit, await baseFor(truth, writer))
    if (disagree !== null) return fail(disagree)

    const res = await fork({ roots: createRoots(abs), log, root: abs }, agent, commit, {
      ...DEFAULT_MATERIALIZE,
      // `preserveMtime` 只在铺底的两档上有意义（overlayfs 档什么都不铺，§ 8.5）。它默认开着，
      // 关掉是**负对照**用的：关掉之后未变文件的时间戳不是底的那一个，按 mtime 判定新旧的
      // 工具链于是全量重建（V6 的读数）。
      preserveMtime: !flags.has('no-preserve-mtime'),
      ...(typeof want === 'string' ? { preferredStrategy: want as ForkStrategy } : {}),
      ...(readOnly === undefined ? {} : { readOnlyPaths: readOnly }),
    })
    if (json) {
      emitJson({
        agent,
        base: res.base,
        strategy: res.strategy,
        mount: res.mount,
        merged: res.merged,
        laid: res.laid,
        ms: res.ms,
        why: res.why,
        platform: res.facts,
      })
    } else {
      // 用了哪一档是**读数**，不是进度条：它在 stderr 上，与 stdout 那条坐标分得开（§ 9.8）。
      // `why` 自己开头就写着是哪一档（"overlayfs 档：…"或者"跳过 …；copy 档：…"），不再另起一句。
      process.stderr.write(res.why + '\n')
      emitLine(res.merged)
    }
    return 0
  } catch (err) {
    if (err instanceof ForkRefused) return fail(err.why)
    if (err instanceof MountError || err instanceof LayError) return fail(err.message)
    throw err
  } finally {
    await log.close()
    if (truth !== null) await truth.close()
  }
}

/**
 * `fugue ensure [--to <rev>]`：把这个 agent 的改动落到物化树里（§ 8.5 · § 9.6 的物化行）。
 *
 * **它是物化那一组里唯一要建视图的命令**：`fork` 铺的是真实工作树（§ 8.4），不读日志；而
 * `ensure` 落的是"这个 agent 自己写过的那些路径"，那份东西只存在于日志里。
 *
 * `--to` 不给就是视图此刻的修订点。**它必须是一个修订点**：这个号要进 `mat/sync`，落一个不存在
 * 的号进去，"清单落到哪儿了"从此说不准——下一句 `--since` 也对不上。
 *
 * 退出码：0 落好了（用了哪一档由 `--json` 的 `strategy` 说）· 1 做不成（没 fork 过 · 挂不动 ·
 * 落不下）· 2 命令行本身不成立。
 */
async function ensureCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const toRaw = flags.get('to')
  let want: ViewRev | undefined
  if (typeof toRaw === 'string') {
    const n = Number(toRaw)
    if (!Number.isInteger(n) || n < 0) return usageFail('--to 要一个非负整数修订号')
    want = n
  }
  const abs = resolve(root)
  const agent = agentFor(writerOf(flags))
  // **先问清单要两样：落到哪个 rev · base 是哪个提交。** 前者定快照的上界，后者是清单的口径
  // 那一侧的读口（`land.ts` 文件头第六条）。这一趟只读日志、不开视图。
  const peek = openLog(abs)
  let st
  try {
    st = await matState(peek, agent)
  } finally {
    await peek.close()
  }
  // 视图要载到 `want`；而快照只敢用 rev ≤ 清单那个 rev 的那一份——`diff(st.rev)` 要算得出来
  // （§ 9.4：快照换掉的是历史）。没有快照就是全量重放，慢一点，答案一样。
  const ctx = await openCtx(abs, flags, { upToRev: want, snapUpTo: st.rev, write: true })
  try {
    const upTo = want ?? ctx.view.rev
    if (!ctx.view.revs.includes(upTo)) {
      return fail(
        `ensure：rev ${upTo} 不是一个修订点\n可用的有 ${ctx.view.revs.join(' · ')}（fugue revs 列的就是它们）`,
      )
    }
    const res = await landOnce(ctx, abs, agent, st, upTo)
    if (json) {
      emitJson({
        agent: res.agent,
        from: res.from,
        to: res.to,
        strategy: res.strategy,
        merged: res.merged,
        upper: res.upper,
        landed: res.landed,
        untouched: res.untouched,
        whiteouts: res.whiteouts,
        pruned: res.pruned,
        touched: res.touched,
        noop: res.noop,
        ms: res.ms,
        platform: res.facts,
      })
    } else {
      // 过程走 stderr（§ 9.8 的 stdout 纪律）：stdout 上那一行是合并树的坐标，与 `fork` 一致。
      process.stderr.write(
        res.noop
          ? `rev ${res.to} 已是最新：没有 delta 要落\n`
          : `rev ${res.from} → ${res.to} · 落地 ${res.landed.length} 条` +
            `${res.whiteouts === 0 ? '' : `（${res.whiteouts} 条 whiteout）`} · 原样 ${res.untouched.length} 条` +
            `${res.pruned === 0 ? '' : ` · 清掉空目录 ${res.pruned} 个`} · ${res.ms} ms · ${res.strategy} 档\n`,
      )
      emitLine(res.merged)
    }
    return 0
  } catch (err) {
    if (err instanceof EnsureRefused) return fail(err.why)
    if (err instanceof MountError || err instanceof LandError) return fail(err.message)
    throw err
  } finally {
    await ctx.close()
  }
}

/**
 * `ensure` 那一趟的装配。**两条命令共用它**：`fugue ensure` 与 `fugue run`——后者在执行前
 * 隐式兑现一次物化（D3 的"先物化"），并把自己的声明目录递给它（`declared`，架构 § 8.6
 * 第 1 步：挂载点要在卸载态预建）。
 *
 * 上面那一趟已经读过的清单从这里递进去：不为了同一个答案再全量重放一次（§ 9.4 的重放代价）。
 */
async function landOnce(
  ctx: Ctx,
  abs: string,
  agent: ReturnType<typeof agentFor>,
  st: MatState,
  upTo: ViewRev,
  declared?: readonly string[],
): Promise<EnsureResult> {
  return await ensure(
    {
      roots: createRoots(abs),
      log: ctx.log,
      root: abs,
      opt: DEFAULT_MATERIALIZE,
      // 视图那一侧的读口：M4 不 import M2，所以由这里接上（§ 8.3：两者只共享 `Delta`）。
      view: {
        stat: (p) => ctx.view.stat(p),
        read: (p) => ctx.view.read(p),
        rev: ctx.view.rev,
        deltasSince: (from) => ctx.view.diff(from),
        // 墓碑只给"一条 whiteout 打不开"那一支用：视图删过一个目录，而底里它还在。
        tombstones: () =>
          ctx.view
            .state()
            .upper.filter((e) => e.kind === 'tombstone')
            .map((e) => e.path),
      },
      base: lowerAt(ctx.truth, st.base),
      state: st,
      ...(declared === undefined ? {} : { declared }),
    },
    agent,
    upTo,
  )
}

/**
 * `fugue run <action> [-- k=v…]`：在一个动作自己的物化环境里跑它（架构 § 8.6 · § 9.6 的执行行）。
 *
 * 一趟五件事：**先物化**（`ensure`——D3 的"执行前隐式兑现"）→ 建本 agent 的缓存与声明目录的
 * 挂载点（`cache` 不在 `fork` 的四个坐标里：它是 M5 的，架构 § 8.6）→ 包命令行（`confine`）→
 * 起进程，并把三件事记进日志（`run/start` · `run/confined` · `run/end`）→ **回收**（架构 § 8.7
 * 的反向通道）：声明集内的产出进视图、声明集外的改动记一条 `mat/reclaim`。
 *
 * **它也是写命令**：那三条事件与回收都是写，所以整条命令握着该 agent 的锁（与 write · ensure
 * 同一道栅栏）——同一个 agent 的另一个写者拿不到，不同 agent 之间照旧零协调。
 *
 * 退出码：0 子进程成功 · 1 子进程没成功或这一趟做不成（含配置里没有这个动作）· 2 用法错。
 * **子进程真实的退出码在 `run/end` 与 `--json` 里**——§ 9.8 的退出码只有三个数。
 *
 * 输出：子进程的 stdout 与 stderr 都走我们的 **stderr**（那是过程，§ 9.8 的 stdout 纪律）；
 * stdout 上那一行是结果——默认 `退出码\t毫秒\t档`，`--json` 一个对象。
 */
async function runCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  rest: readonly string[],
  json: boolean,
): Promise<number> {
  const name = args[0]
  if (name === undefined || name === '') return usageFail('run 需要 <action>')
  const stepRaw = flags.get('step')
  // 这一站没有轮次（S7 才有）：默认 `-`，读日志时一眼看得出"这不是某一轮里的那一步"。
  const step: StepId = typeof stepRaw === 'string' ? stepRaw : '-'

  // 命令行上那一档（架构 § 8.8 的 `Policy.mode`）：**敲错了是 2**，与"这一趟跑不成"（1）分开。
  const mode = modeOf(flags)
  if (mode === null) {
    return usageFail(`--mode 取 read-only 或 workspace-write：${JSON.stringify(flags.get('mode'))}`)
  }

  const abs = resolve(root)
  let doc: ConfigDoc
  let binding: ActionBinding
  let injections: Record<string, string>
  let range: string
  try {
    doc = await readConfig(abs)
    binding = readBinding(doc, name)
    injections = parseInjections(rest)
    range = portRangeOf(doc)
  } catch (err) {
    // 配置错是「做不成」（1），不是「敲错了」（2）：命令行的形状是对的，缺的是工作区那一份。
    if (err instanceof ConfigError || err instanceof BindingError) return fail(err.message)
    throw err
  }

  const agent = agentFor(writerOf(flags))
  const peek = openLog(abs)
  let st: MatState
  try {
    st = await matState(peek, agent)
  } finally {
    await peek.close()
  }

  // `bind` 是绑进树里、让子进程写得动的那些目录（§ 8.6 第 1 步）；`declared` 是要收回视图的
  // 产出（§ 8.7），两件事两处。回收那份装配排在**物化之后**：它的减数是"落地之后"的清单。
  const roots = createRoots(abs)
  const bind = declaredDirs(binding)
  // **一处解析**（架构 § 8.8）：这一趟的档 · 网络 · 可达集都在这一份值里——`fugue policy` 读的是
  // 同一份。层现探一次（§ 15.7 的 E4）：值本身与"为什么不在"那句话都从这一次探来。
  const probed = probeLayers(roots)
  let policy: Policy
  try {
    policy = resolvePolicy({ roots, agent, doc, mode, binding, probed })
  } catch (err) {
    if (err instanceof PolicyError) return fail(err.message)
    throw err
  }

  // **启动前的一致性检查**（Y4 · 架构 § 8.8 的 fail-closed）：声明的目录落不到视图里 · 清单里
  // 那一条在宿主上不成立 · 软链指不到清单里——都在这里拒。**它排在物化之前**：这一层报的是
  // "哪一栏写错了"，而再往后报的是 bwrap 的话（"源找不到"），指向的是错的地方。
  const checked = checkReach({ roots, policy, declared: bind })
  if (!checked.ok) return fail(checked.error.message)

  const ctx = await openCtx(abs, flags, { snapUpTo: st.rev, write: true })
  try {
    // 端口那一片按"日志里 writer 的次序"切：同一个工作区里不同的 agent 拿到不同的片，而同一批
    // agent 的两次跑（X3 的并行一趟与串行一趟）拿到同一片——逐字节可比的前提就是这个。
    const writers = (await ctx.log.writers()).slice().sort()
    const at = writers.indexOf(ctx.writer)
    const portIndex = at < 0 ? writers.length : at

    const cache = cacheLayoutOf(roots, agent)
    // 缓存是 M5 的（`fork` 不建它）：三个落点先建出来，绑定才挂得上。
    mkdirSync(cache.home, { recursive: true })
    mkdirSync(cache.xdgCache, { recursive: true })
    for (const rel of bind) mkdirSync(cache.bound(rel), { recursive: true })

    const landed = await landOnce(ctx, abs, agent, st, ctx.view.rev, bind)
    const mounts = checkMountPoints(landed.merged, bind)
    if (!mounts.ok) return fail(mounts.error.message)
    // **这一趟走哪一档**由上面那一份策略值说了算（架构 § 8.8）：在场的层里有挂载层 `bwrap` 就是
    // 沙箱档；只有第二层（Landlock）时它接过"写得动什么"那一维（Y6）；两层都不在才是 § 15.7 的
    // E4 退化档——树可写、回收兜底。**这条读数现探**（`probeLayers`），不从
    // `<realRoot>/.fugue/config` 的 `platform` 键里读——那份缓存的寿命是给"挂一次试试"那类贵
    // 探针定的，E4 · E5 的答案会随机器变。
    const sandboxed = policy.layers.includes('bwrap')
    // 第二层一个人撑着的那一档：没有挂载围栏，可是边界还在（未声明的写入当场拒）。
    const bareLandlock = !sandboxed && policy.layers.includes('landlock')
    // **树敞不敞开**看档：`workspace-write` 是**有人点名**要树可写（挂载层不挂、第二层把整棵树
    // 开出来）；其余档里树是只读的，未声明的写入由内核当场拒，树里没有可查的东西。
    const treeOpen = policy.mode === 'workspace-write'
    const sandboxNote = sandboxed
      ? ''
      : mode === 'workspace-write'
        ? '命令行上点名要树可写那一档（--mode workspace-write）'
        : probed.note
    // 减数是**这一趟落地之后**的清单：上面那一下已经把视图里没落地的 delta 落进了 `upper`。
    // 产出落在哪一侧由**机制**定（有没有挂载层），不由档定：没有挂载层就没有绑定。
    const reclaim = createReclaim({
      roots,
      strategy: st.strategy,
      manifest: landed.manifest,
      landing: sandboxed ? 'cache' : 'tree',
      treeOpen,
    })
    let declared: DeclaredSet
    try {
      declared = reclaim.declare(agent, binding.outputs)
    } catch (err) {
      if (err instanceof ReclaimRefused) return fail(err.message)
      throw err
    }
    const env = envFor({ agent, binding, injections, portIndex, range, policy })
    const confined = sandboxed
      ? confine({
          roots,
          agent,
          argv: binding.argv,
          cwd: binding.cwd,
          declared: bind,
          env,
          policy,
        })
      : degradedArgv(binding.argv, { roots, policy })

    await ctx.log.append(ctx.writer, {
      t: 'run/start',
      agent,
      step,
      action: name,
      argv0: binding.argv[0],
      // **完整 argv 与 cwd**：这一栏是绕行率的数据源（`METRIC_HOW` 里那张模式表按 `argv` 判），
      // 而工具面那一侧（`B5`）已经这么填了。两处填的记录的东西一致（都是"真要 spawn 的那一条
      // 命令行"），读数才有同一把尺——差别只在这边是 `binding.argv`，那边是 `["/bin/sh","-c",…]`。
      argv: policy.degraded ? degradedArgv(binding.argv, { roots, policy }) : binding.argv,
      cwd: roots.merged,
    })
    // 这一条事件记的是**上面那一份策略值**（要求），不是包出来的那条命令行自己算的：两处读同一份，
    // `fugue policy` 印的与它逐字相等（PLAN § 5.5 的 Y2 断言 ①）。
    await ctx.log.append(ctx.writer, {
      t: 'run/confined',
      agent,
      mode: policy.mode,
      enforcement: policy.enforcement,
      net: policy.net,
      layers: [...policy.layers],
      reach: [...policy.reach.roRoots],
    })
    // 中止信号这一站不给：Ctrl-C 由 `--die-with-parent` 把子进程带走（那正是那个开关的用处）。
    // 代价写在疑点里——那一下 `run/end` 不会落下，日志上留一条没合上的 `run/start`。
    const res = await createExecutor({
      onChunk: (_which, chunk) => process.stderr.write(chunk),
      // `RunSpec.cwd` 翻成物理路径归 `M5`（架构 § 8.6 那一栏的注）：沙箱那一档它同时进
      // `--chdir`，**退化档里它是唯一的那一处**——没有沙箱可 chdir，子进程就在这棵树里跑。
      cwdOf: (a, rel) => join(roots.mergedRoot(a), rel),
    }).run(agent, { action: name, confined, cwd: binding.cwd, env }, new AbortController().signal)
    await ctx.log.append(ctx.writer, {
      t: 'run/end',
      agent,
      step,
      exit: res.exit,
      ms: res.ms,
      denied: res.denied,
    })

    // ── 反向通道：产出收进视图、越了声明的地方记下来（架构 § 8.7 · PLAN § 5.4 的 X2）
    const gate = await reclaimRun(ctx, roots, agent, st, bind, declared, reclaim)

    if (json) {
      emitJson({
        agent,
        action: name,
        step,
        exit: res.exit,
        ms: res.ms,
        denied: res.denied,
        mode: policy.mode,
        enforcement: policy.enforcement,
        mechanism: confined.mechanism,
        net: policy.net,
        layers: [...policy.layers],
        reach: [...policy.reach.roRoots],
        argv0: binding.argv[0],
        cwd: binding.cwd,
        declared: [...bind],
        outputs: [...declared.paths],
        sandbox: sandboxed,
        sandboxNote,
        reclaimed: gate.wrote,
        missing: gate.missing,
        undeclared: gate.undeclared,
        prepared: landed.prepared,
        merged: landed.merged,
        tree: policy.coords.tree,
        home: env.HOME,
        tmp: env.TMPDIR,
        xdgCache: env.XDG_CACHE_HOME,
        port: Number(env.PORT),
        ports: env.PORTS,
      })
    } else {
      process.stderr.write(
        `退出码 ${res.exit} · ${res.ms} ms · ${policy.mode} · ${policy.enforcement} 档` +
          `${sandboxed ? '' : ` · 没有沙箱（${sandboxNote}）`}` +
          `${bareLandlock ? ' · landlock 那一层还在：未声明的写入当场拒' : ''}` +
          `${treeOpen ? '——树可写，回收兜底' : ''}` +
          `${res.denied ? ' · 有被拒的写入' : ''}` +
          `${landed.prepared.length === 0 ? '' : ` · 预建挂载点 ${landed.prepared.length} 个`}` +
          `${gate.wrote.length === 0 ? '' : ` · 回收 ${gate.wrote.length} 条进视图`}` +
          `${gate.missing.length === 0 ? '' : ` · 声明了没产出 ${gate.missing.length} 条`}` +
          `${gate.undeclared.length === 0 ? '' : ` · 声明集外 ${gate.undeclared.length} 条（mat/reclaim）`}` +
          `\n`,
      )
      emitLine(`${res.exit}\t${res.ms}\t${policy.enforcement}`)
    }
    return res.exit === 0 ? 0 : 1
  } catch (err) {
    if (err instanceof EnsureRefused) return fail(err.why)
    if (err instanceof MountError || err instanceof LandError) return fail(err.message)
    if (err instanceof BindingError || err instanceof ReclaimRefused) return fail(err.message)
    throw err
  } finally {
    await ctx.close()
  }
}

interface ReclaimOutcome {
  /** 收进视图的那些路径（一次回写一条事件，rev 按这个次序往前推）。 */
  readonly wrote: readonly RelPath[]
  /** 声明了、这一趟却一条产出都没收到的那些。 */
  readonly missing: readonly RelPath[]
  /** 声明集**外**被改动的路径——有它就记了一条 `mat/reclaim`。 */
  readonly undeclared: readonly RelPath[]
}

/**
 * `fugue run` 的最后一步：把这一趟的产出收回视图、把越了声明的地方记下来（架构 § 8.7）。
 *
 * **次序是硬的：卸 → 收 → 记 → 挂回。** 枚举 `upper` 必须在卸载之后（§ 8.7 与 § 8.5 的第一条
 * 机制约束），而挂回排在 `finally` 里——中途抛错也留不下一棵卸着的树。挂回给的是**清单那个
 * rev**，于是它只补挂载态、不落 delta：回写视图的是 `collect` 的产出，落盘由下一条 `ensure`
 * 负责（§ 9.6：执行前隐式兑现，执行后不追着落）。
 */
async function reclaimRun(
  ctx: Ctx,
  roots: ReturnType<typeof createRoots>,
  agent: ReturnType<typeof agentFor>,
  st: MatState,
  bind: readonly string[],
  declared: DeclaredSet,
  reclaim: Reclaim,
): Promise<ReclaimOutcome> {
  const cache = cacheLayoutOf(roots, agent)
  unmountOverlay(roots.mergedRoot(agent))
  let deltas: Delta[]
  let outside: RelPath[]
  try {
    deltas = await reclaim.collect(agent, declared)
    outside = await reclaim.undeclared(agent, declared)
  } finally {
    await landOnce(ctx, ctx.root, agent, st, st.rev, bind)
  }
  // 越了声明的地方先记：它是这一趟的判决；回写进去的是判决之后放行的那几条。
  if (outside.length > 0) {
    await ctx.log.append(ctx.writer, {
      t: 'mat/reclaim',
      agent,
      declared: [...declared.paths],
      changed: [...outside],
    })
  }
  const wrote: RelPath[] = []
  for (const d of deltas) {
    await applyEdit(ctx, d)
    wrote.push(d.kind === 'rename' ? d.to : d.path)
  }
  const got = new Set(wrote)
  return {
    wrote,
    missing: topDeclared(declared.paths).filter(
      (p) => !got.has(p) && !wrote.some((w) => w.startsWith(`${p}/`)),
    ),
    undeclared: outside,
  }
}

/** 声明表里没被别的声明盖住的那些（排过序，所以祖先一定在后代前面）。`collect` 的收法同此。 */
function topDeclared(paths: readonly RelPath[]): RelPath[] {
  const out: RelPath[] = []
  for (const p of paths) {
    if (out.some((q) => p.startsWith(`${q}/`))) continue
    out.push(p)
  }
  return out
}

/**
 * `fugue verify-mat`：清单 == 差异集（§ 8.5 的第二条验证性质 · § 9.6 物化行的出账）。
 *
 * **它建视图，而且载到清单那个 rev 为止**：物化树对应的是那一刻的清单。视图再往后写的那些
 * 还没有落地，拿它们来核等于拿未来核现在。
 *
 * 底下那三样各有各的来源（日志 · 真源 · 文件系统，见 `verify.ts` 的文件头），所以"相等"不是
 * 自己跟自己比。**不等就退 1，只报不修**：§ 8.5 的失败处理是删除重建，修不是这条命令的事。
 */
async function verifyMatCmd(root: string, flags: Map<string, string | true>, json: boolean): Promise<number> {
  const abs = resolve(root)
  const agent = agentFor(writerOf(flags))
  // 先问清单要一个 rev——视图得载到那儿为止。这一趟只读日志，不开视图。
  const peek = openLog(abs)
  let st
  try {
    st = await matState(peek, agent)
  } finally {
    await peek.close()
  }
  // **不要 history**：这条命令要的是"视图在 st.rev 那一刻长什么样"，不是变更序列——所以
  // 快照能用（§ 9.4 的第一步），代价从"重放整份日志"降到"重放快照之后的那些"。
  const ctx = await openCtx(abs, flags, { upToRev: st.rev })
  try {
    const res = await verifyMat(
      {
        roots: createRoots(abs),
        log: ctx.log,
        // 底那一侧是 `mat/fork` 记的那个提交；`base` 为 null 时 `lowerAt` 给的就是一层空的下层。
        base: lowerAt(ctx.truth, st.base),
        view: {
          stat: (p) => ctx.view.stat(p),
          read: (p) => ctx.view.read(p),
          upper: () => ctx.view.state().upper,
        },
        state: st,
      },
      agent,
    )
    if (json) emitJson(res)
    else {
      const ratio = res.precision === null ? '（差异集为空）' : res.precision.toFixed(3)
      emitLine(
        `${res.ok ? 'ok' : '不等'}\t清单 ${res.manifest.paths.length} 条\t差异集 ${res.diff.paths.length} 条\t` +
          `落地 ${res.landed.paths.length} 条\tmaterialize-precision ${ratio}`,
      )
      for (const [what, list] of [
        ['只有清单有', res.onlyManifest],
        ['只有差异集有', res.onlyDiff],
        ['只有落地有（上层里多出来的）', res.onlyLanded],
        ['清单有而落地没有', res.missing],
        ['两边都有而内容对不上', res.mismatch],
      ] as const) {
        if (list.length > 0) emitLine(`${what}\t${list.join(' · ')}`)
      }
    }
    return res.ok ? 0 : 1
  } catch (err) {
    if (err instanceof VerifyRefused) return fail(err.why)
    throw err
  } finally {
    await ctx.close()
  }
}

/**
 * `fugue dispose`：删掉这个 agent 的整份物化（§ 8.5 的失败处理 · § 9.6 的物化行）。
 *
 * **它不建视图、不读日志**：`dispose` 是删除，不是一次状态迁移——它要的只是四个坐标（§ 8.4），
 * 而那四个由 `--root` 与 `--agent` 就定得下来。于是"物化目录损坏，删掉重来"这条路上，没有
 * 任何一处要先信任日志或视图。
 *
 * 退出码：0 删干净了（本来就没有也算）· 1 删不动（卸不下来）。
 */
async function disposeCmd(root: string, flags: Map<string, string | true>, json: boolean): Promise<number> {
  const abs = resolve(root)
  const writer = writerOf(flags)
  const agent = agentFor(writer)
  // **`dispose` 不改日志，却拿同一道锁**：它改的是物化，而物化与日志是同一条命令序列的
  // 两半——一条 `ensure` 正落着的时候四个坐标被删掉，与两个写者抢一个序号是同一类事。
  const hold = holdWriter(abs, writer)
  try {
    const res = await dispose({ roots: createRoots(abs) }, agent)
    if (json) emitJson(res)
    else {
      // 过程走 stderr（§ 9.8 的 stdout 纪律）；stdout 上那一行是这次动过的坐标。
      process.stderr.write(
        res.existed
          ? `卸下并删掉 ${res.mat}：四个坐标${res.left.length === 0 ? '一个不剩' : `还剩 ${res.left.join(' · ')}`} · ${res.ms} ms\n`
          : `${res.mat} 下本来就没有物化树——幂等，照常成功\n`,
      )
      emitLine(res.mat)
    }
    return res.left.length === 0 ? 0 : 1
  } catch (err) {
    if (err instanceof MountError) return fail(err.message)
    throw err
  } finally {
    hold.release()
  }
}

/** `p` 是不是在 `dir` 这棵树里。两边都已经 `resolve` 过；`dir` 自己不算"在树里"。 */
function insideTree(dir: string, p: string): boolean {
  const rel = relative(dir, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 最外面那一层只做一件事：**把用法错翻成退出码 2**（§ 9.8 的退出码行）。
 *
 * 判据是"这条命令行本身就不成立"。它与"做不成"（1）分开是有用的：脚本要能一眼分出
 * "我敲错了"与"我敲对了，只是这件事没成"。
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv)
  } catch (err) {
    if (err instanceof UsageError) return usageFail(err.message)
    // 同一个 agent 的另一个写者正写着：这是「做不成」（1），不是「敲错了」（2）。
    if (err instanceof LogHeldError) return fail(err.message)
    throw err
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const { flags, positional, rest } = parseArgv(argv)
  const json = flags.has('json')
  const rootFlag = flags.get('root')
  const root = typeof rootFlag === 'string' ? rootFlag : process.cwd()
  const cmd = positional[0]

  // `--help` 是一条成功的命令；什么都不给是用法错——两者的退出码不一样。
  if (flags.has('help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (cmd === undefined) return usageFail('需要一个命令')
  // `--` 只对执行那一行有意义（`fugue run <action> -- k=v…`）。别的命令收到它就说不清，
  // 所以拒绝，而不是把后面那几段悄悄咽下去。
  if (rest.length > 0 && cmd !== 'run') {
    return usageFail(`\`--\` 之后的东西只有 run 收（这次给的是 ${cmd}）：只有 run 往子进程里注入 k=v`)
  }

  // 落点先探（架构 § 15.7 的 E1）。**E1 是硬要求，所以这里是拒绝启动，不是降级运行**：
  // 落在 9p / drvfs 那一类跨内核的落点上时，失败模式是静默的（§ 15.8 的"不成立"档）。
  // 根还不存在时探它最近的祖先（`host.ts`），所以这条检查不依赖"目录已经建好"；
  // `--help` 在上面，不受影响。
  try {
    assertHost(root)
  } catch (err) {
    if (err instanceof HostError) return fail(err.message)
    throw err
  }

  if (cmd === 'log') {
    const only = flags.get('agent')
    const log = openLog(root)
    try {
      for await (const { pos, e } of log.readMerged()) {
        if (typeof only === 'string' && pos.writer !== (only as WriterId)) continue
        emit(pos, e, json)
      }
    } finally {
      await log.close()
    }
    return 0
  }

  if (cmd === 'replay') return await replay(root, flags, json)

  if (cmd === 'commit') {
    const msg = flags.get('m')
    if (typeof msg !== 'string' || msg === '') return usageFail('commit 需要 -m <msg>')
    const ctx = await openCtx(root, flags, { sync: 'each', write: true })
    try {
      return await commit(ctx, msg, json)
    } finally {
      await ctx.close()
    }
  }

  // 分出去改的是 ref（真源那一侧），不建视图、不读日志——所以它排在建视图的命令之前。
  if (cmd === 'branch') return await branchCmd(root, flags, positional.slice(1), json)

  // 轮次那一组自己开上下文（它要 truth 与 log 两个句柄、还要写日志），排在通用视图之前：
  // 它的参数与其他命令不共用。
  if (cmd === 'round') {
    const sub = positional[1]
    if (sub === 'run') return await roundRun(root, flags, positional.slice(2), json)
    return await roundCmd(root, flags, positional.slice(1), json)
  }

  // 配置不建视图、不读日志：它是工作区的输入，不是它的状态（§ 15.3.a 末段）。
  if (cmd === 'config') return await config(root, positional.slice(1), json)

  // 策略值读的也是配置与探针，不是工作区的状态——所以它也排在视图之前（架构 § 8.8）。
  if (cmd === 'policy') return await policyCmd(root, flags, positional.slice(1), json)

  // 尺子只读，也不进那份"状态"——所以它排在视图之前（§ 8.5 把 diff-stat 与 verify-mat 并列只读）。
  if (cmd === 'diff-stat') return diffStatCmd(root, flags, positional.slice(1), json)
  if (cmd === 'fork') return await forkCmd(root, flags, positional.slice(1), json)
  if (cmd === 'ensure') return await ensureCmd(root, flags, positional.slice(1), json)
  // 执行排在物化那一组之后：它先兑现一次 `ensure`（D3），再起进程。
  if (cmd === 'run') return await runCmd(root, flags, positional.slice(1), rest, json)
  if (cmd === 'verify-mat') return await verifyMatCmd(root, flags, json)
  if (cmd === 'dispose') return await disposeCmd(root, flags, json)
  if (cmd === 'assemble') return await assembleCmd(root, flags, positional.slice(1), json)

  const args = positional.slice(1)
  const need = (n: number): boolean => args.length >= n && !args.slice(0, n).some((a) => a === '')

  switch (cmd) {
    case 'read': {
      if (!need(1)) return usageFail('read 需要 <path>')
      const ctx = await openCtx(root, flags)
      try {
        const fenced = fence(ctx.roots, args[0])
        if (!fenced.ok) return fail(fenced.message)
        const rel = fenced.rel
        const bytes = await ctx.view.read(rel)
        if (bytes === null) return fail(`read：${args[0]} 不是可读的路径（目录 · gitlink · 或者不存在）`)
        if (json) {
          const meta = await ctx.view.stat(rel)
          emitJson({ path: args[0], size: bytes.length, ...meta })
        } else {
          process.stdout.write(Buffer.from(bytes))
        }
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'list': {
      const ctx = await openCtx(root, flags)
      try {
        const fenced = fence(ctx.roots, args[0] ?? '')
        if (!fenced.ok) return fail(fenced.message)
        const rel = fenced.rel
        const rows = await ctx.view.list(rel)
        if (json) emitJson(rows)
        else for (const r of rows) emitLine(`${r.kind}\t${r.mode.toString(8)}\t${r.size}\t${r.name}`)
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'stat': {
      if (!need(1)) return usageFail('stat 需要 <path>')
      const ctx = await openCtx(root, flags)
      try {
        const fenced = fence(ctx.roots, args[0])
        if (!fenced.ok) return fail(fenced.message)
        const rel = fenced.rel
        const meta = await ctx.view.stat(rel)
        if (meta === null) return fail(`stat：${args[0]} 不存在`)
        if (json) emitJson({ path: args[0], ...meta })
        else emitLine(`${meta.kind}\t${meta.mode.toString(8)}\t${meta.size}\t${meta.id}`)
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'diff': {
      const sinceRaw = flags.get('since')
      let since: ViewRev | undefined
      if (typeof sinceRaw === 'string') {
        since = Number(sinceRaw)
        if (!Number.isInteger(since) || since < 0) return usageFail('--since 要一个非负整数修订号')
      }
      const ctx = await openCtx(root, flags, { history: true })
      try {
        const deltas = ctx.view.diff(since)
        if (json) emitJson(deltas.map(deltaJson))
        else for (const d of deltas) emitLine(deltaLine(d))
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'revs': {
      // 检视组的一条（§ 9.6）：输出就是 `View.revs` 这个字段（§ 8.3）。**不看历史**——
      // 修订点跟着状态走，快照带着它，所以从快照起的视图答得一样全，这也是
      // `replay --verify` 把 `revs` 列进比对项的原因。
      const ctx = await openCtx(root, flags)
      try {
        const revs = ctx.view.revs
        if (json) emitJson(revs)
        else for (const r of revs) emitLine(String(r))
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'write':
    case 'remove':
    case 'rename':
    case 'chmod': {
      // 参数先收齐（含"这几条路径能不能落地"那一步过围栏），**再开视图**：一条用法错的命令
      // 不该在磁盘上留下任何东西，而围栏要的只是落点，不必等日志与快照建起来——围栏拿的是
      // 一份无状态的 `Roots`，`openCtx` 收同一份（第四个数），所以那两处说的是同一个根。
      const roots = createRoots(resolve(root))
      const delta = await deltaFrom(roots, cmd, args, flags)
      if (typeof delta === 'string') return fail(delta)
      const ctx = await openCtx(root, flags, { write: true }, roots)
      try {
        const res = await applyEdit(
          { log: ctx.log, truth: ctx.truth, view: ctx.view, writer: ctx.writer },
          delta,
        )
        if (json) emitJson({ rev: res.rev, agent: ctx.writer })
        else emitLine(`${res.rev}\t${ctx.writer}`)
        // 「没有变化」不是失败（§ 8.3 的模式两档）：**stdout 的形状与别的写命令一样**——
        // 给的是视图此刻的 rev，它没有动；那句话去 stderr，报的是判过的那个现值。
        if (!res.changed && delta.kind === 'chmod') {
          process.stderr.write(`没有变化：${delta.path} 已经是 ${res.mode.toString(8)}\n`)
        }
        return 0
      } finally {
        await ctx.close()
      }
    }

    default:
      return usageFail(`未知命令：${cmd}`)
  }
}

/**
 * `fugue replay [--to <rev>]` / `fugue replay --verify`（§ 9.6 的重放组）。
 *
 * **只读。** 它同时是 S1 的验收脚本与崩溃恢复实验的探针：一个写者被杀之后，第一条要跑的
 * 就是它——所以它不能在坏现场上再写什么。
 */
async function replay(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const toRaw = flags.get('to')
  let upToRev: ViewRev | undefined
  if (typeof toRaw === 'string') {
    const n = Number(toRaw)
    if (!Number.isInteger(n) || n < 0) return usageFail('--to 要一个非负整数修订号')
    upToRev = n
  }
  const only = flags.get('agent')
  const log = openLog(root)
  let truth: TruthHandle | null = null
  const t0 = Date.now()
  try {
    truth = openTruth(root)
    if (flags.has('verify')) {
      const writers = typeof only === 'string' ? [only as WriterId] : await log.writers()
      if (writers.length === 0) {
        if (json) emitJson({ ok: true, agents: [] })
        else emitLine('还没有任何 writer 写过日志：没有可重放的视图')
        return 0
      }
      return await verify(root, log, truth, writers, upToRev, json)
    }
    const writer = writerOf(flags)
    const lower = await lowerFor(truth, writer)
    const snap = await readSnapshot(root, writer, upToRev === undefined ? {} : { upToRev })
    const view = await loadView(
      log,
      writer,
      snap === null ? { lower, upToRev } : { lower, upToRev, snap },
    )
    const entries = await snapshotOf(view)
    const ms = Date.now() - t0
    const from =
      snap === null ? { kind: 'genesis' } : { kind: 'snapshot', seq: snap.seq, rev: snap.state.rev }
    if (json) emitJson({ agent: writer, rev: view.rev, base: view.base, from, entries, ms })
    else {
      const where =
        snap === null ? '从 0 全量重放' : `从快照 seq ${snap.seq}（rev ${snap.state.rev}）起`
      emitLine(`${view.rev}\t${view.base ?? '(没有提交)'}\t${entries.length} 个条目\t${where}`)
    }
    return 0
  } finally {
    await log.close()
    if (truth !== null) await truth.close()
  }
}

/** 条目表压成一行可比对的字：走目录的顺序不该参与判定。 */
function entryKey(rows: TreeEntry[]): string {
  return rows
    .map((r) => `${r.mode.toString(8)} ${r.id} ${r.name}`)
    .sort()
    .join('\n')
}

/** 变更压成一行可比对的字。**`add` 与 `modify` 要分开**——它由日志前缀决定，不是细节。 */
function deltaKey(d: Delta): string {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return `${d.kind} ${d.path} ${d.mode.toString(8)} ${d.bytes.length} ${createHash('sha1').update(d.bytes).digest('hex')}`
    case 'symlink':
      return `symlink ${d.path} → ${d.target}`
    case 'delete':
      return `delete ${d.path}`
    case 'rename':
      return `rename ${d.from} → ${d.to}`
    case 'chmod':
      return `chmod ${d.path} ${d.mode.toString(8)}`
  }
}

/**
 * 两份视图是不是同一份：`rev` · `base` · `revs` · 全量读出 · 变更序列（从 `since` 起）。
 *
 * `since` 是给从快照起的视图留的：它答不了比快照更早的变更序列，所以两边都从快照那个
 * 修订点比起——**这正是"快照换掉的是历史，不是状态"的可测形式**。
 */
function sameView(
  a: View,
  aRows: TreeEntry[],
  b: View,
  bRows: TreeEntry[],
  since: ViewRev,
): boolean {
  if (a.rev !== b.rev || a.base !== b.base) return false
  if (JSON.stringify(a.revs) !== JSON.stringify(b.revs)) return false
  if (entryKey(aRows) !== entryKey(bRows)) return false
  const x = a.diff(since).map(deltaKey)
  const y = b.diff(since).map(deltaKey)
  return x.length === y.length && x.every((k, i) => k === y[i])
}

/**
 * `--verify`：逐 agent 重建视图，比对 `rev` · 全量读出 · `diff()` · `revs`（§ 9.6）。
 *
 * **两条独立的重建路径对着同一条日志，各走一遍**：
 *
 *   1. 按 writer 读（`readByWriter`） 与 按交错全序读再筛（`mergedFace`）
 *   2. 从 0 全量重放 与 从快照起再重放尾部
 *
 * 第 2 条就是"快照是纯加速项"的验收——它把快照删掉只是慢，不会不一样；第 1 条是"重建结果
 * 只由自己的操作决定"的验收——交错序里夹着别人的事件，读出来的还是自己那份。
 */
async function verify(
  root: string,
  log: LogHandle,
  truth: TruthHandle,
  writers: WriterId[],
  upToRev: ViewRev | undefined,
  json: boolean,
): Promise<number> {
  const reports: Record<string, unknown>[] = []
  let bad = 0
  for (const writer of writers) {
    const checks: { what: string; ok: boolean; detail?: string }[] = []
    let rev = 0
    let count = 0
    let snapInfo: Record<string, unknown> | null = null
    try {
      const lower = await lowerFor(truth, writer)
      const full = await loadView(log, writer, { lower, upToRev })
      const want = await snapshotOf(full)
      rev = full.rev
      count = want.length

      const inter = await loadView(mergedFace(log, writer), writer, { lower, upToRev })
      checks.push({
        what: '交错读 == 按 writer 读',
        ok: sameView(full, want, inter, await snapshotOf(inter), 0),
      })

      const snap = await readSnapshot(root, writer, upToRev === undefined ? {} : { upToRev })
      if (snap === null) {
        checks.push({
          what: '从快照起 == 从 0 起',
          ok: true,
          detail: '没有快照：这一路只跑了全量重放',
        })
      } else {
        snapInfo = { seq: snap.seq, rev: snap.state.rev }
        const fast = await loadView(log, writer, { lower, upToRev, snap })
        checks.push({
          what: `从快照 seq ${snap.seq}（rev ${snap.state.rev}）起 == 从 0 起`,
          ok: sameView(full, want, fast, await snapshotOf(fast), snap.state.rev),
        })
      }
    } catch (err) {
      checks.push({
        what: '重建',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
    const ok = checks.every((c) => c.ok)
    if (!ok) bad++
    reports.push({ writer, ok, rev, entries: count, snapshot: snapInfo, checks })
    if (!json) {
      emitLine(`${ok ? 'ok  ' : 'FAIL'}\t${writer}\trev ${rev}\t${count} 个条目`)
      for (const c of checks) {
        const mark = c.ok ? '·' : '×'
        const detail = c.detail === undefined ? '' : `（${c.detail}）`
        if (!c.ok || c.detail !== undefined) emitLine(`      ${mark} ${c.what}${detail}`)
      }
    }
  }
  if (json) emitJson({ ok: bad === 0, agents: reports })
  else if (bad === 0) emitLine(`${writers.length} 个视图全部一致`)
  if (bad !== 0) return fail(`${bad} 个视图没有通过重放比对`)
  return 0
}

/**
 * 用法错：**这条命令行本身就不成立**——参数缺了 · 模式不是八进制 · 动词不认识。§ 9.8 给了它
 * 自己的退出码（2），与"做不成"（1）分开是有用的：`read` 一个不存在的路径是一次成立的请求
 * 得到的一个结果，而 `write` 少一个来源根本不是一次请求。
 */
class UsageError extends Error {}

/**
 * 把命令行收成一个 delta。**这一步不开视图、不读日志**——参数不对的命令不该在磁盘上留下
 * 任何东西，而"先建再检查"会让一条用法错的命令也留下一个日志目录。
 *
 * **每一条路径都过围栏**（`fence`）：`write ../x` 这一类输入在这里就变成一条带指路
 * 的拒绝（退出码 1），而不是等视图那一步的路径检查来 `throw`——那是两个不同的话（一个是
 * "这条请求不成立"，一个是"这条请求做不成"），拒绝时该说的是后一句。基准目录是工作区的根。
 *
 * 四条写命令共用它；与模型侧共用的是更下面那次 `applyEdit`——这里只做参数那一半。
 */
async function deltaFrom(
  roots: Roots,
  cmd: string,
  args: string[],
  flags: Map<string, string | true>,
): Promise<Delta | string> {
  switch (cmd) {
    case 'write': {
      if (args[0] === undefined) throw new UsageError('write 需要 <path>')
      const fenced = fence(roots, args[0])
      if (!fenced.ok) return fenced.message
      const p = fenced.rel
      const from = flags.get('from')
      let bytes: Uint8Array
      if (typeof from === 'string') bytes = readFileSync(from)
      else if (flags.has('stdin')) bytes = await readStdin()
      else throw new UsageError('write 需要 --from <file> 或 --stdin')
      // 默认 644；要可执行就再敲一条 chmod——两条命令各说一件事，不从写里猜。
      return { kind: 'add', path: p, bytes, mode: 0o100644 }
    }
    case 'remove': {
      if (args[0] === undefined) throw new UsageError('remove 需要 <path>')
      const fenced = fence(roots, args[0])
      if (!fenced.ok) return fenced.message
      const p = fenced.rel
      return { kind: 'delete', path: p }
    }
    case 'rename': {
      const [rawFrom, rawTo] = args
      if (rawFrom === undefined || rawTo === undefined) throw new UsageError('rename 需要 <from> <to>')
      const a = fence(roots, rawFrom)
      if (!a.ok) return a.message
      const b = fence(roots, rawTo)
      if (!b.ok) return b.message
      const from = a.rel
      const to = b.rel
      return { kind: 'rename', from, to }
    }
    default: {
      const p = args[0]
      const mode = args[1]
      if (p === undefined || mode === undefined) throw new UsageError('chmod 需要 <path> <mode>')
      const fenced = fence(roots, p)
      if (!fenced.ok) return fenced.message
      return { kind: 'chmod', path: fenced.rel, mode: parseOctal(mode) }
    }
  }
}

/**
 * 只有直接运行才执行。**这个守卫不能用 `import.meta.main`**：它是 Node 24.2 才有的，
 * 而 `package.json` 声明的 engines 是 ≥22.6——在那个版本上它会静默什么都不做。
 * 与 `tools/test-entry.js` 用同一个写法，所以本模块**可以被 import 而不产生副作用**。
 */
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof LogCorruptError) {
        // 日志在哪，由 `--root` 说了算——壳让人在任何目录里敲这条命令，而"我在哪"与
        // "它的日志在哪"是两件事。默认值仍是 cwd（`run` 里那一句）。
        const asked = parseArgv(process.argv.slice(2)).flags.get('root')
        process.stderr.write(`日志损坏，拒绝加载 —— ${err.message}\n`)
        process.stderr.write(`日志目录：${logDir(typeof asked === 'string' ? asked : process.cwd())}\n`)
      } else {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      }
      process.exit(1)
    })
}
