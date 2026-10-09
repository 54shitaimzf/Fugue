// 命令行的**出口那一层**：用法表 · 两列发射 · 那两档失败。本幕从 `cli/shared.ts` 搬出来。
//
// 为什么单独一份：**界面那一侧要 `emitLine` 与 `usageFail`，但不要 `cli/shared.ts` 那一串**
// （`shared.ts` import 了 `log/log.ts`、`truth/truth.ts`、`view/` 那一族——开视图那一套）。
// 本幕那条「界面读账只经事件通道」的静态断言按 import 闭包走，字符串那一层与账本那一层
// 因此得分开住：这一份只 import 一个 `ui/keymap.ts`（用法表里要印缺省键位那一行）。
//
// `cli/shared.ts` 原样再导出这一份的五个出口，所以三十来处 `import { emitLine } from '../shared.ts'`
// 一处不改、字节一个不动。
import { KEYMAP, hintLimitOf, hintLineOf } from '../ui/keymap.ts'

export const USAGE = `用法: fugue [--root <dir>] [--agent <id>] [--json] <command> [args]

fugue 是住在终端里的编码 agent：给它一句目标，它自己拆活、自己干、自己验，全部
通过才动你的文件。这张表只列命令；完整的上手走法在仓库的 README。

命令
  先看它在干什么（四条 · 全是只读）
  status --once              看这一刻的整体情况：轮次走到哪一步、每个任务干到哪儿、花了
                             多少 token。--metrics 多一组质量指标 · --report 多一组打回统计
  watch [--follow]           跟着看新事件。不给 --follow 就把现有的读完退出；给了就一直
                             等新的（Ctrl-C 停）。--interval <毫秒> 调轮询间隔（缺省 200）
  tui [--once] [--follow] [--full] [--tail <n>] [--no-style]
                             交互界面：底部一块面板显示情况，输出照常往上滚，翻历史 ·
                             搜索 · 复制都还是终端自己的。它只看不写，随时开随时关：
                             g 放行门口那批 · ? 重印按键提示 · q 退出
                             ${hintLineOf(KEYMAP, hintLimitOf(60))}
                             （上面是缺省键位 · fugue config set ui.keys.<动作> '<键串>' 可改）
                             --metrics / --report 与 status 同义；真终端上默认就跟着新事件走
                             --once 印一遍旧事件就退（管道 · CI 里自动是这一档，不写 ANSI）
                             --tail <n> 开始时只看最后 n 条旧事件（旧账很长时的入口）
                             --full 用整块屏幕（默认不用：那一档退出后滚动历史就没了）
                             默认带一点样式（框线与脚注暗一档 · 弹层加粗，不用颜色）；
                             --no-style 或环境变量 NO_COLOR 非空时全关
  log [--agent <id>]         把账原样列出来：一行一条事件，不做任何加工
  serve                      换一种进程角色：stdio 上一行一调用（JSON-RPC 2.0），给客户端连着问
                             用（仓库 tools/sample-client.mjs 是最小样例）。命绑客户端：stdin 一断它
                             就走收尾；没人问它 30 秒自己走——不引守护进程。参数只有 --root <dir>

  动文件与提交（动的是 fugue 眼里的那份视图，不直接是你的工作树）
  read <path>                读一个文件
  list [dir]                 列一个目录
  stat <path>                看一个路径的信息
  write <path> [--from <f>|--stdin]   写一个文件
  remove <path>              删（目录连同里面的）
  rename <from> <to>         改名
  chmod <path> <mode>        改权限：<mode> 是八进制（如 755）；只认「带不带执行位」两档，
                             没有变化就说一声，不进账
  diff [--since <rev>]       看改了哪些文件（相对某个修订点）
  commit -m <msg>            把当前内容定格成一个提交
  revs                       列出全部修订点（从早到晚）
  replay [--to <rev>]        从账重建内容；--verify 顺带校验两条重建路径算得一致
  branch <base>              把分支头定到 <base>（fork 之前的那一步；已经在这儿就不动）

  铺工作区（agent 干活的地方，随时能收走）
  fork <base> [--strategy <s>] [--ro <p1,p2>] [--no-preserve-mtime]
                             把 <base> 那棵树铺成一个独立工作区。--strategy 选
                             overlayfs / hardlink-ro / copy，不给就自动挑能用的
  ensure [--to <rev>]        把该落的改动落到铺出来的工作区
  diff-stat [<dir>] [--baseline <f>] [--save <f>]
                             全树快照对比（大小与哈希），看有没有意外改动
  run <action> [-- k=v…]     在隔离环境里跑一条配置里声明过的动作，比如
                             fugue config set actions.build '{"argv":["make"],"cache":["dist"]}'
                             「-- k=v」给它加环境变量。--mode read-only（默认）或
                             workspace-write 选隔离档。声明过的产物（cache · outputs）跑完
                             自动收回来；没声明的写入会被拦。退出码：0 成功 · 1 没成功
  verify-mat                 核对铺出来的工作区与账对不对得上（只报不修）
  dispose                    把铺出来的工作区收走（本来没有也成功）
  policy [<action>]          看隔离策略：能写哪里 · 能不能联网

  轮次（一句话 → 拆活 → 干 → 验 → 落地）
  round plan <目标> [--live] [--judge] [--max-steps <n>]
                             让它自己读项目、出计划：拆成几份活，停下来等你点头——这一步
                             不碰你的任何文件。--live 接真模型（要凭据 · 花钱）；--judge
                             不跑模型，直接拿手里那份计划给你判
  round go [--materialize]   点头放行：按计划每份活开一条分支开干。放行过再按会直接
                             拒绝、一个字节不落（不会重复发）
  round run <目标> [--live] [--max-steps <n>] [--retry <n>] [--report] [--metrics] [--materialize]
                             一趟跑完整个轮次：拆 → 干 → 验 → 合并。默认不联网不花钱
                             （打桩）；--live 才接真模型。验收断言从配置读：
                             fugue config set round.assertions '[…]'
                             全过才写提交；没过，你的文件一个都不会动。
                             合并之前它会把各份活要动的文件先对一遍：撞上了缺省只报
                             出来、不拦（要拦就给 --strict-merge-gate）
                             --max-steps <n> 每个任务最多几步（不给就是不设上界；第一次
                             联网建议给个位数）
                             另有几个走查开关（--fail · --deny · --poke · --dump-wire ·
                             --no-handoff），日常用不到
  round work [--live] [--max-steps <n>] [--retry <n>] [--report] [--metrics]
                             接着跑：把放行出去的那批任务跑完（round go 之后用）
  round new <目标> [--materialize]
                             按你配置里的草案（round.split）直接开一个轮次
  say <一句话> [--live] [--max-steps <n>]
                             跟它聊一句：说你的要求或限制，它记下来并照着调计划。
                             默认接真模型（花钱）

  装配
  assemble <protocol> [--agent <id>] [--against <protocol>]
                             把要发给模型的前缀拼出来核对（协议名 subagent 或 holder）：
                             三区哈希 · 每区字节数 · 四条约束
  环境与配置
  doctor                     环境自检：node · git · bwrap … 一项项报给你（只读；「缺」算
                             读数不算失败）
  config show                看全部配置
  config ls                  只列顶层键域（合法键有哪些），不读配置
  config get <key>           看一条（点分路径，如 round.id）
  config set <key> <value>   改一条（值能按 JSON 解析就当 JSON，否则当字符串）

选项
  --root <dir>    工作区根，默认当前目录；账在 <root>/.fugue/，配置在 <root>/.fugue/config。
                  要放在原生本地文件系统上（ext4 一类）；Windows 挂进来的盘（NTFS / 9p）
                  上拒绝启动
  --agent <id>    看哪个任务分支；默认 round（主线）
  --json          输出 JSON（给脚本用）
  --version       显示安装版本后退出（不用进工作区；可配 --json）
  --help          这张表

退出码：0 成了 · 1 没做成 · 2 命令敲错了。
写命令（write · remove · rename · chmod · commit · fork · ensure · run · dispose）同一个
agent 同时只许一条在跑，撞上了会报出是谁拿着；读命令从不加锁。
`

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
