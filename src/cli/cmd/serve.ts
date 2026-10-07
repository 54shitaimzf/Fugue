// serve 入口。**它不是一个新动词**：它是「这份东西怎么跑」——与 `tui` 同一类。
// 出处：架构 § 9.11 那一节 · § 9.6 那张表的入口行（「入口说的是这份东西怎么跑，**不出方法名**」）。
//
// 命令行骨架就是这一份：stdio 上一行一调用 · 生命周期绑客户端 · 闲时自退。语义全在
// `serve/connect.ts`（协议与派发）与 `value/`（值层）里；这一份只做三件事：认那几个开关 ·
// 接上真的 stdin/stdout · 决定退出码。
//
// **serve 按根一个**（已批：协议里不加 root 维度）：`--root` 就是这一趟服务的那一个工作区；
// 多工作区就是多个 serve 进程，客户端自己托管（1.6.0 那一面）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IDLE_MS, serveConnection } from '../../serve/connect.ts'
import { UsageError } from '../shared.ts'

/** 这一条的用法说明（`--help` 那张表里的那一行就是它）。 */
export const SERVE_USAGE_LINE =
  '  serve                      换一种进程角色：stdio 上一行一调用（JSON-RPC 2.0）。给客户端\n' +
  '                             连着问用（样例客户端在仓库 tools/sample-client.mjs）；命绑客户端 ·\n' +
  `                             闲时 ${IDLE_MS / 1000} 秒自退，不引守护进程。参数：--root <dir>`

/** 安装版本（`--version --json` 那一栏的来源与它同一处）。 */
function productVersion(): string {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    return String(version)
  } catch {
    return ''
  }
}

/** `--idle-ms <毫秒>`：闲时自退的阈值（走查与测试要一个短的；不给就是 `IDLE_MS`）。 */
function idleMsOf(flags: Map<string, string | true>): number {
  const raw = flags.get('idle-ms')
  if (raw === undefined) return IDLE_MS
  if (typeof raw !== 'string') throw new UsageError('--idle-ms 要一个数：--idle-ms 200')
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`--idle-ms 要一个非负整数（毫秒），拿到 ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * 跑一趟 serve。
 *
 * `input` 一断（干净断开）就返回 0——**这就是「命绑客户端」**：没人连着，它就没了。闲时那一档
 * 也走同一条出口（`onClose` 把读口收掉）。
 */
export async function serveCmd(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  void json
  const idleMs = idleMsOf(flags)
  const input = process.stdin
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    // 闲时自退与读口结束都走到这里：把读口收掉，让 `for await` 那一圈结束、进程退出。
    try {
      const d = (input as unknown as { destroy?: () => void }).destroy
      if (typeof d === 'function') d.call(input)
    } catch {
      /* 收不掉就靠 stdio 自己的那一头 */
    }
  }
  // **子进程顶班那一条路要一个能跑的命令**：与这一份同一个入口（`fugue.ts` 自己）。
  const cli = resolve(process.argv[1] ?? fileURLToPath(new URL('../fugue.ts', import.meta.url)))
  await serveConnection({
    input,
    output: process.stdout,
    cli,
    root,
    idleMs,
    product: productVersion(),
    onClose: close,
  })
  return 0
}
