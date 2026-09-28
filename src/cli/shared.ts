// cli 的共用那一半（U4a，2026-09 评审计划）：用法说明 · 参数解析 · 两列发射 · 围栏 · 命令上下文。
// 自 `fugue.ts` 抽出——那一文件自此只剩分发与各命令组（`cmd/`），这一份是它们共用的地基；
// **内容逐字未动**，只补了 `export`。语义出处仍是架构 § 9.6：单次进程 + 每次重建。
import { resolve } from 'node:path'
import { openLog } from '../log/log.ts'
import type { LogHandle, SyncLevel } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import type { Roots } from '../roots/contract.ts'
import { createRoots } from '../roots/roots.ts'
import type { View } from '../view/contract.ts'
import { lowerFor } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import { readSnapshot } from '../view/snapshot.ts'
import type { PolicyMode, RelPath, ViewRev, WriterId } from '../terms.ts'
import { keysHintOf } from '../ui/keys.ts'

/** 用法错（旗子少一个值 · 互斥的两档一起给）：`run()` 那一层把它收成退出码 2。 */
export class UsageError extends Error {}

export const USAGE = `用法: fugue [--root <dir>] [--agent <id>] [--json] <command> [args]

命令
  log [--agent <id>]         按 (seq, writer) 全序列出日志事件
  status --once              把**这一刻的处境**印出来：轮次状态（从 round/state 链重放，用的是
                             状态机那一份图）· 每一格走到哪儿（调用 · 步数 · 工具调用 · 动作 ·
                             拒与被挡 · 停因）· 用量与条数（从日志重算，不采集）。**纯读**：
                             不开账本、不取锁、不新增事件——所以它落在哪一趟之后都不会让那一趟
                             取的基线作废（PLAN § 5.18）。今天只有 --once 这一档：跟随是下面那一条。
                             加 --metrics 印八元指标 · 加 --report 印打回三数——两栏与 round run
                             那两栏同一个来源、同一个渲染（序 32）
  watch [--follow]           顺着 NDJSON 账读：不给 --follow 就把账上有的念一遍就停，给了就一直
                             跟着（--interval <毫秒>，缺省 200；Ctrl-C 停，退出码 0）。**每个
                             writer 一个游标**——晚出现的那个 agent 的日志口第一条就是 seq=1，
                             "从 N 接着读"会把它整段永久漏掉。次序是**到达序**（实时），
                             一趟之内仍是 (seq, writer) 的全序
  tui [--once] [--follow]    同一读面的第二档渲染：底部一块恒定 K 行的面板（处境 + 读数）擦掉重画，
                             永久行（轮次转移 · 契约 · 每一格干完没有 · 边界拦下什么）按到达序追加进
                             本终端的历史。**可附着**：自己不起轮次、不取锁、自己的账一个字节都不写
                             ——门槛上按 g 起的是**一条命令**（fugue round go 那个子进程写账）。
                             TTY 那一档不给 --follow 也是跟着；退出收走面板（码 0：人喊停不是失败）。
                             加 --metrics / --report 与 status 那两栏同名同义。
                             按键（只在 TTY 那一档）：${keysHintOf()}
                             --once 印一遍永久行就退；不是 TTY（管道 · CI）也是这一档，**一个字节的
                             ANSI 都不写**；$TERM 是 dumb 或认不出来同样退到这一档
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
  round plan <目标> [--live|--wire-in <目录>] [--judge] [--max-steps <n>]
                             **预备态那一趟**：持轮者自己读 · 自己设计 · 自己拆，停在门口等人批。
                             一个契约都不发 · 一条分支都不起 · 真实工作树一个字节不动；草案写在视图
                             里（.fugue/plan/<轮次>.md），正文进日志（holder/distill）——盘上不落
                             第三处。**收工三档一个判据**：模型说完了（exit_plan_mode）· Harness
                             判它结束了（end-turn · 步数到顶）· 人喊停（--judge：这一趟不跑模型，
                             拿手里那一份直接判）。判的是键域完整与否：完整就停在门口，不完整就
                             退回并报出缺哪一节哪个键。每一格的预估占用（三区 + 工具目录 + seed
                             与上限的差额）一并印出来——规模由模型定，架构只把数说出来。
                             --live / --wire-in / --max-steps / --credential / --dump-wire 与
                             round run 同义。
  round go [--materialize]    **放行**：把门上那一批契约发出去（架构 § 15.1.a 四步里的"派"）。
                              放行的是**日志里那一份草案**在**这一轮钉住的底**上重算出来的那一批
                              （同一个身份分配器 · 同一段判据），所以人批的那一批与发出去的这一批
                              是同一批。落一条 round/approve（批号 + 那几份契约）→ 逐条
                              contract/issue → N 条 refs/heads/<agent> 定在同一个底上 →
                              Planning → Delegated → Working。物化缺省不做（与 round new 同一条：
                              给 --materialize 才铺 N 棵树）。
                              再跑一次不重复触发：这一批已经发过了就当场拒 · **一个字节都不落**
                              （不是静默成功，也不发第二条契约）。**新的一批一律重停**——下一个
                              轮次拆出来的那一批哪怕与这一批同号（批号只是拆分的形状，见 round
                              plan 印的那一行）也照样停在门口等人点头。
  round run <目标> [--live] [--report] [--metrics] [--fail <n>] [--deny <n>] [--retry <n>] [--materialize]
                             跑一个完整的轮次（架构 § 20 S7 的可用性那一句）：
                             起头（钉底 · 造契约 · Planning 预检 · 发契约 · 起分支）→ 每个 agent
                             干一格（**缺省是打桩那一档**：--live 走真网络 · --wire-in 走录下来
                             的响应，两档同一个驱动、同一份判据）→ 合并前兜底预检（缺省只报
                             不拒：判决印在报告那一行，严档走 --strict-merge-gate）→
                             漂移检 → 逐路折叠（撞上冲突就物化冲突树、交给解决者、重折）→
                             验收（跑在**物化出来的那棵树上**）
                             → 通过才定格 + 推进（没过则真实工作树一个字节不动）。
                             断言从工作区配置里读：round.assertions 那一栏
                               fugue config set round.assertions '[{"name":"测试全过","argv":["/bin/sh","-c","true"]}]'
                             每一条断言在**合并之后那棵树上**跑：argv 起真进程，退出码等于
                             expect（缺省 0）算过。"命令不在 / 退出码 127"那一类判成**跑不起来**
                             ——它不进打回计数，单独成一栏（架构 § 8.12 末段）。
                             --fail <n>   让第 n 个 agent 交一个"必然失败"的提交（走查要撞红）
                             --deny <n>   第 n 个 agent 的格子里多跑一条必然被拒的动作
                             --retry <n>  Verifying → Working 那条回边允许走几次（缺省 1：没通过自动回一次；0 = 一遍都不重来）
                             --report     印打回那三个数与逐趟账（从日志重算，不采集）
                             ·            逐趟账 = 每一条 llm/call 一行 + 合计（含思考与费用）
                             --metrics    印八元指标（**每个指标的分子与分母一起印**，从日志重算）
                             --materialize 起头时把 N 棵树也铺出来（缺省不铺）
                             --live        接真驱动：每一步发一次真调用（要凭据），不再是打桩那一档。
                             整条链与打桩那一档是同一条，判据也只有一个（验收）——差的是"模型那一侧"
                             由谁答。凭据按提供方声明里那份表取；--credential <路径> 是命令行覆盖。
                             缺省不出网、不花钱；要喂**录下来的响应**是 --wire-in <目录>（内部档）。
                             --max-steps <n>  **这一格最多走几步**。**不给就是不设上界**——上界是你的
                             决策，不是我们的兜底：不设时这一格一直走到它自己收工或你喊停，而
                             --live 下每一步都落一条 llm/call（花了多少一条条看得见）。
                             第一次联网把它压到个位数。
                             --no-handoff   到了预算触发点**不交接**（用完就停那一档）：
                             B6 的缺省是"先停"（写交接提示词 · 换一个 agent 接着干），
                             而地板那一档要能把它关掉。
                             --dump-wire <目录>  **把每一次调用发出去与收回来的字节原样落盘**
                             （call-0001/request.json · response.sse · meta.json · 两条
                             sha256）。默认不落——不给这个开关时那一层根本不存在，一个字节
                             都不写、请求体也一个字节不变。**目录必须在工作区之外**：落进
                             <root> 会被下一轮的 fork 当成漂移（§ 8.14）。看完就删。
                             --strict-merge-gate 合并前那一档预检恢复"报出即拒"（缺省只报
                             不拒：相交那对数印在报告那一行，折叠照做——真冲突由折叠当场
                             报出、走冲突环，折干净而合起来坏的由验收在推进之前拦住）
                             --poke <路径>  **在折叠之后、物化之前手改一条路径**（模拟轮次中
                             用户的手，用来量漂移那一档）；缺省什么都不做
                             --poke-exact <路径> 同上，但抄的是这一趟目标树里那条路径的
                             字节（量"两边逐字节相同 → 照合并"那一档）
  round work [--live|--wire-in <目录>] [--max-steps <n>] [--retry <n>] [--report] [--metrics]
                             **接着跑**：把这一轮**已经发出去的那一批契约**跑完——放行（round go）
                             之后那一环。契约与底**从日志里读回**（contract/issue 的正文 ·
                             round/intent 的底），一句配置都不看、一份契约都不重算：人批的是哪一批，
                             跑的就是哪一批。处境必须是 Working（放行走完 · 格还没跑）；别的处境当场
                             拒并指一条路。**已经交过卷的格不重跑**——那条分支已经不是底了，就取回它
                             那个提交复用（重跑不重复烧真调用）。
                             断言从**契约里**来，命令行从配置里绑好的动作来（actions.<名字>）：契约
                             只带动作名（架构 § 8.12），argv 归工作区配置。
                             --live / --wire-in / --max-steps / --credential / --dump-wire / --report
                             / --metrics / --retry 与 round run 同义。
  say <一句话> [--live|--wire-in <目录>] [--max-steps <n>]
                             **答完接着走**：那句话进这一趟的尾端（C 区第一条），并且立刻带着它
                             跑一趟持轮者——**停下来的那一处没有"等"这种状态**（命令返回时那一趟
                             已经跑完了）。两个状态的产物不同：**讨论态**（Idle）那句话落进会话
                             记录（.fugue/session/<轮次>.jsonl），这一趟落下修正后的理解
                             （holder/distill），而处境不动（讨论不落地）；**预备态**（Planning）
                             那一趟改的是那份草案（.fugue/plan/<轮次>.md），改完重判，仍然停在
                             门口——**原话不另存**，工作区里找不到第二份。进它视野的是这场对话
                             的投影：凝聚理解 · 最近 3 条原文。
                             --live / --wire-in / --max-steps / --credential / --dump-wire 与
                             round run 同义（这一趟缺省就走真模型：持轮者那一格没有打桩档）。
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
  doctor                     环境自检（纯读，不落盘）：node · zlib.crc32 · bwrap · landlock ·
                             git · 落点档位，一行一项。**读得出就退 0——「缺」是读数不是失败**；
                             statfs 问不出落点（自检跑不了）才退 1
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
export type { Parsed }

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
  // `--interval <毫秒>`（`watch --follow` 的轮询间隔）：同一条纪律。
  'interval',
  // `--wire-in <目录>`：**回放档**（PLAN § 5.12 序 1）。它也取一个值，同一条纪律；而它是**内部档**
  // ——不进用法说明：它要的是"录下来的那一趟"，只有取证与走查用得上。
  'wire-in',
])
export { VALUED }

export function parseArgv(argv: readonly string[]): Parsed {
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
export function modeOf(flags: Map<string, string | true>): PolicyMode | null {
  const raw = flags.get('mode')
  if (raw === undefined) return 'read-only'
  return raw === 'read-only' || raw === 'workspace-write' ? raw : null
}

export function emitJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v) + '\n')
}

export function emitLine(s: string): void {
  process.stdout.write(s + '\n')
}

/** 「做不成」（1）：§ 9.8 退出码行。`json` 面一行 `{code:1, message}`（U7 全量接线）。 */
export function fail(msg: string, json = false): number {
  return emitFail({ code: 1, message: msg }, json)
}

/** 「敲错了」（2）：整张 USAGE 只进人面。`json` 面一行 `{code:2, message, hint}`（U7 全量接线）。 */
export function usageFail(msg: string, json = false): number {
  return emitFail({ code: 2, message: msg, hint: '跑 fugue --help 看整张表' }, json)
}

/**
 * § 9.8 契约表「错误」行（U6）：`{ code, message, hint, subject }`——`--json` 那一面
 * stderr 写**一行 JSON**，`hint` 指向正确的替代能力（§ 24 纪律 5）。
 *
 * **人读那一面逐字照旧**：message 走 stderr；用法错（code 2）把整张 USAGE 跟在后面——
 * 与 `usageFail` 印的字节相同。**USAGE 全文不进 JSON**——机器要的是 `code` 与 `hint`，
 * 不是一张表，所以用法错的 `hint` 给「跑 fugue --help」；`subject` 是这句错说到的那个
 * 东西（一条开关 · 一条路径），没说到就不出现。stdout 一个字节不写（stdout 纪律那一行），
 * 退出码就是 `code`（0/1/2/3 四档不动）。
 */
export function emitFail(
  o: { code: number; message: string; hint?: string; subject?: string },
  json: boolean,
): number {
  if (json) {
    process.stderr.write(
      JSON.stringify({
        code: o.code,
        message: o.message,
        ...(o.hint === undefined ? {} : { hint: o.hint }),
        ...(o.subject === undefined ? {} : { subject: o.subject }),
      }) + '\n',
    )
    return o.code
  }
  process.stderr.write(o.code === 2 ? `${o.message}\n\n${USAGE}` : `${o.message}\n`)
  return o.code
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
export type Fenced = { readonly ok: true; readonly rel: RelPath } | { readonly ok: false; readonly message: string }

export function fence(roots: Roots, raw: string): Fenced {
  const r = roots.resolveVirtual(raw, '')
  return r.ok ? { ok: true, rel: r.value } : { ok: false, message: r.error.message }
}

/**
 * `--agent` 决定操作哪个视图，等价于选择一份日志（§ 9.6）。未指定时取主线：`round` 是
 * 持轮者这个位置的名字，它在 git 侧的落点是 `refs/heads/main`（§ 4）——所以不带参数读到
 * 的视图，与 git 侧的主干是同一段历史。
 */
export function writerOf(flags: Map<string, string | true>): WriterId {
  const a = flags.get('agent')
  return (typeof a === 'string' ? a : 'round') as WriterId
}

export interface Ctx {
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

export interface OpenOptions {
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
export async function openCtx(
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

export async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Uint8Array))
  return Buffer.concat(chunks)
}

/**
 * **认不得的开关当场拒**（退 2），不静默收下（§ 9.8「认得的开关才收」）。
 *
 * 为什么这一族要拒：写错的开关被咽下去之后，人看到的是"命令跑了、什么都没变"——那与"这个开关
 * 今天没用"在读数上分不开（`log --grep x` 找不到东西，与"日志里没有匹配"也是同一张脸）。用法
 * 错是 2，做不成是 1，两者不许混（架构 § 9.8）：收下一个不认识的开关属于**命令行不成立**。
 *
 * 报的话里把**这一条命令认的那几个**印出来：拒一条命令时，人要知道的是"那该怎么办"。
 */
export function unknownFlagsOf(
  cmd: string,
  flags: Map<string, string | true>,
  allowed: readonly string[],
): string | null {
  const bad = [...flags.keys()].filter((k) => !allowed.includes(k))
  if (bad.length === 0) return null
  return (
    `${cmd} 不认这几个开关：${bad.map((k) => '--' + k).join(' · ')}——这一条命令认的是 ` +
    allowed.map((k) => '--' + k).join(' · ')
  )
}

export function parseOctal(raw: string): number {
  const text = raw.trim().replace(/^0o?/, '')
  if (!/^[0-7]{3,4}$/.test(text)) throw new UsageError(`模式要八进制三位或四位：${raw}`)
  return parseInt(text, 8)
}
