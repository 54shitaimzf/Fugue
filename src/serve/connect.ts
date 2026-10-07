// serve 的**连接**：stdio 上一行一调用，读到断开为止。出处：架构 § 9.11 全节。
//
// 这一份是三件东西的收口：
//
//   · **方法面**——`params._protocol` 的版本协商（不认得的版本明确拒 + `data.supported`）· 方法名
//     ⇄ § 9.6 那张表的对应（从 `FLAGS_OF` 派生，`registry.ts` 的 `methodOf`）· 参数就是那条命令
//     认的开关；
//   · **派发**——迁到值层的命令**进程内**跑（与 CLI 同一个值层入口）；没迁的走**退化档**：子进程
//     `fugue <cmd> --json` 顶班，它的 stdout 原样当 `result.stdout`，两个面因此逐字节相同；
//   · **生命周期**——stdio 底下一进程对一个客户端：stdin 一断（干净断开）走收尾 · 闲时自退
//     （阈值是 `IDLE_MS`，取值与依据落停点报告）· `kill -9` 什么都不清理（锁留盘，下一条命令按
//     § 9.2 既有判据接管）。
//
// **serve 不持有跨越命令的写句柄**（§ 9.11）：读命令不取栅栏，写命令按请求开、按请求关——与 CLI
// 一模一样，因为跑的是同一个值层入口。
import { spawn } from 'node:child_process'
import { PROTOCOL_VERSION } from '../protocol.ts'
import { FLAGS_OF } from '../cli/flags.ts'
import { commandErrorOf } from '../value/invoke.ts'
import { isSpecial, migrated, valueResultOf } from '../value/cli.ts'
import { watchValue } from '../value/observe.ts'
import { createRootTail } from './tail.ts'
import type { RootTail } from './tail.ts'
import { keyOfMethod, methodOf, verbKeys } from '../value/registry.ts'
import { faceOf } from '../value/shell.ts'
import type { ValueArgs, ValueResult } from '../value/types.ts'
import { PROTOCOL_PARAM, commandFailure, encodeError, encodeResult, parseLine, versionRefused } from './wire.ts'
import type { RpcId, RpcRequest } from './wire.ts'

/**
 * 闲时自退的阈值（毫秒）。**依据**：CLI 一次启动的基线是 21.6 ms（0.2.9 读数），而 serve 的存在
 * 意义是「同一个客户端连着问好几次」——30 秒够一次问答的间隔（人看一眼 · 敲一条命令），短到不
 * 会把一个死掉的客户端留在盘上一整夜。**「不引守护进程」由这一条兑现**：没人问它就自己走，
 * 命绑客户端。
 *
 * 改主意的条件：真实客户端出现「问一次 · 想一会儿 · 再问一次」的间隔常态超过它——那时把阈值
 * 抬到那个间隔的两倍。
 */
export const IDLE_MS = 30_000

/** 一次调用的结果（`result` 那一栏）。**`stdout` 是那条命令 `--json` 面的字节**——于是
 * 「同一条命令经 CLI 与经 serve 的 result 逐字节相同」这句话量的是真的字节。 */
export interface ServeResult {
  /** § 9.8 的四档退出码（0 成功 · 1 失败 · 2 用法错 · 3 被拒绝）。 */
  readonly code: number
  /** `--json` 那一面的正文（**含**末尾换行——它就是 CLI 写出去的那一串字节）。 */
  readonly stdout: string
  /** 命令写在 stderr 上的那几行（值层的 `notes`）。 */
  readonly notes: readonly string[]
  /** 这条命令是进程内跑的（`value`）还是子进程顶班的（`subprocess`）——**退化档要看得见**。 */
  readonly via: 'value' | 'subprocess'
  /**
   * 结构化那一份（**事件通道要它**）：§ 9.11「响应里带这一趟读到的事件与下一趟要用的
   * 游标」——`stdout` 是 NDJSON（与 CLI 逐字节相同），游标在这一栏里（`resume`，串形与
   * `--resume` 那个一样）。其余命令不带这一栏。
   */
  readonly result?: unknown
  /** 失败时那两栏（§ 9.8 的错误形状）：值层给了就照原样往 `error.data` 里放。 */
  readonly hint?: string
  readonly subject?: string
}

/** 从 `params` 里认出开关与位置参数（命令面单一真源：认得的开关就是 `FLAGS_OF` 那一张表）。 */
export function argsOf(method: string, params: Record<string, unknown>, root: string): ValueArgs {
  const key = keyOfMethod(method)
  const table = FLAGS_OF[key]
  const flags = new Map<string, string | true>()
  const args: string[] = []
  const rest: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (k === PROTOCOL_PARAM) continue
    if (k === 'args') {
      for (const x of Array.isArray(v) ? v : [v]) args.push(String(x))
      continue
    }
    if (k === 'rest') {
      for (const x of Array.isArray(v) ? v : [v]) rest.push(String(x))
      continue
    }
    if (table !== undefined && !table.flags.includes(k)) {
      // **认得的开关才收**（§ 9.8）：表外的键当场拒，不静默咽下去。
      throw { kind: 'unknown-flag', flag: k, allowed: table.flags } as unknown
    }
    flags.set(k, v === true || v === null ? true : String(v))
  }
  return { root, flags, args, rest }
}

/** 把一份值层结果编成一次回答的 `result`。**`stdout` 的字节来自值层那两条脸**，serve 不另排版。 */
export function serveResultOf(r: ValueResult, json: boolean, via: ServeResult['via']): ServeResult {
  if (!r.ok) {
    return {
      code: r.code,
      stdout: '',
      notes: [],
      via,
      ...(r.hint === undefined ? {} : { hint: r.hint }),
      ...(r.subject === undefined ? {} : { subject: r.subject }),
    }
  }
  const text = faceOf(r, json)
  return {
    code: 0,
    stdout: text === '' ? '' : text + '\n',
    notes: r.notes ?? [],
    via,
  }
}

/** 退化档：子进程 `fugue <cmd> --json` 顶班，stdout 原样交回来。 */
export async function runSubprocess(
  cli: string,
  method: string,
  params: Record<string, unknown>,
  root: string,
): Promise<ServeResult> {
  const key = keyOfMethod(method)
  const argv = [cli, '--root', root, '--json', ...key.split(' ')]
  for (const [k, v] of Object.entries(params)) {
    if (k === PROTOCOL_PARAM || k === 'args' || k === 'rest') continue
    if (v === true) argv.push(`--${k}`)
    else if (v !== null && v !== undefined) argv.push(`--${k}=${String(v)}`)
  }
  for (const [k, v] of Object.entries(params)) {
    if (k === 'args') for (const x of Array.isArray(v) ? v : [v]) argv.push(String(x))
  }
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, argv, { cwd: root })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.on('close', (code) => done({ code: code ?? 1, stdout: out, stderr: err }))
  })
  return { code: r.code, stdout: r.stdout, notes: r.stderr.split('\n').filter((l) => l !== ''), via: 'subprocess' }
}

/** 一条命令在两面上的对账：`FLAGS_OF` 里每一条动词的键 ⇄ 它的方法名。 */
export function methodSurface(): readonly { key: string; method: string; migrated: boolean }[] {
  return verbKeys().map((key) => ({ key, method: methodOf(key), migrated: migrated(key) }))
}

/** 连接要的那几样（测试给替身，产品给真 stdio）。 */
export interface ConnIo {
  readonly input: NodeJS.ReadableStream
  readonly output: { write(s: string): unknown }
  readonly cli: string
  readonly root: string
  readonly idleMs?: number
  /** 收尾那一下（闲时自退要用它把进程收掉；干净断开也走这里）。 */
  readonly onClose?: () => void
  /** 安装版本——`initialize` 的回执里报出来（客户端拿它核自己是哪一版接上的）。 */
  readonly product?: string
  /**
   * 按根建那一份尾部索引时套一层（**断言用**：数一遍全量走了几遍）。**产品路径上永远不给**
   * ——不给就是 `createRootTail(root)` 那一句。
   */
  readonly tailFactory?: (root: string) => RootTail
}

/**
 * 跑一条连接：读到断开为止。
 *
 * 三档死法各有形状（§ 9.11）：**干净断开**走收尾（读口一结束就返回）· **超时/`shutdown`** 只停止
 * 接受新请求（之后来的调用回 `-32600`，**不伪造成功**）· **`kill -9`** 什么都不做（这一份连钩子
 * 都没有——锁留盘，下一条命令按 § 9.2 的既有判据接管）。
 */
export async function serveConnection(io: ConnIo): Promise<void> {
  const idleMs = io.idleMs ?? IDLE_MS
  /**
   * **按根一份尾部索引**（§ 9.11「服务端可以记住派生物」）：事件通道那一趟的扫描按根做一次 ·
   * N 个客户端共用；游标仍住客户端（每一次把它自己那一份带进来）。**惰性建**——不问事件通道
   * 的连接一份都不建（不白开一个账本口）。**可弃**：收尾那一下 `dispose()`，重建之后同一个
   * 游标读出来的字节逐字节相同。
   */
  let tail: RootTail | null = null
  const tailOf = (): RootTail => {
    if (tail === null) tail = (io.tailFactory ?? createRootTail)(io.root)
    return tail
  }
  let idle: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let busy: Promise<void> = Promise.resolve()
  const clearIdle = (): void => {
    if (idle !== null) {
      clearTimeout(idle)
      idle = null
    }
  }
  const stop = (): void => {
    closed = true
    clearIdle()
  }
  const arm = (): void => {
    clearIdle()
    if (closed || idleMs <= 0) return
    idle = setTimeout(() => {
      // 闲时自退：没人问就走。**不是守护进程**——stdio 底下客户端一走，这条连接也该收。
      stop()
      io.onClose?.()
    }, idleMs)
    // **不 `unref`**：一个「等着人再问一句」的服务端要能吊住自己——`unref` 过之后，安静下来
    // 的那一刻事件循环上什么都不剩，定时器根本不会到点。
  }
  arm()

  /**
   * 答一次。**通知不答**（`id` 缺就是通知，基范：服务端 MUST NOT 回）；`force` 那一档给
   * 解析错用——「这一行不是一个合法报文」与「这是一条通知」是两件事，基范对前者的要求是
   * 回一条 `id: null` 的错误。
   */
  const answer = (id: RpcId, body: string, force = false): void => {
    if (id !== null || force) io.output.write(body)
  }
  /** 一次调用的错误翻成回执那一栏（值层抛出来的与壳那一层认得的，都在这一处）。 */
  const failed = (id: RpcId, err: unknown): void => {
    const known = commandErrorOf(err, io.root)
    answer(
      id,
      encodeError(
        id,
        known !== null && !known.ok
          ? commandFailure(1, known.message)
          : { code: -32000, message: (err as Error).message },
      ),
    )
  }

  const handle = async (req: RpcRequest): Promise<void> => {
    const params = { ...req.params }
    // **版本住在每一次调用上**（§ 9.11），不认得的版本明确拒 + 报出支持的列表。
    const got = params[PROTOCOL_PARAM]
    if (got !== PROTOCOL_VERSION) {
      answer(req.id, encodeError(req.id, versionRefused(got, [PROTOCOL_VERSION])))
      return
    }
    delete params[PROTOCOL_PARAM]
    if (req.method === 'initialize') {
      answer(
        req.id,
        encodeResult(req.id, {
          protocol: PROTOCOL_VERSION,
          product: io.product ?? '',
          idleMs,
          // 方法面就在回执里：客户端拿一次就知道这一代服务端对得上哪几条命令。
          methods: methodSurface().map((m) => m.method),
        }),
      )
      return
    }
    if (req.method === 'shutdown') {
      // 超时那一档：**只停止接受新请求**，在途的写到它能写的边界——不伪造成功。
      stop()
      answer(req.id, encodeResult(req.id, { stopping: true }))
      return
    }
    if (closed) {
      answer(req.id, encodeError(req.id, { code: -32600, message: '这一条连接已经收尾：不再接受新请求' }))
      return
    }
    const key = keyOfMethod(req.method)
    if (FLAGS_OF[key] === undefined || !verbKeys().includes(key)) {
      answer(req.id, encodeError(req.id, { code: -32601, message: `没有这个方法：${req.method}` }))
      return
    }
    let valueArgs: ValueArgs
    try {
      valueArgs = argsOf(req.method, params, io.root)
    } catch (err) {
      const e = err as { kind?: string; flag?: string; allowed?: readonly string[] }
      if (e.kind === 'unknown-flag') {
        answer(
          req.id,
          encodeError(req.id, {
            code: -32602,
            message: `${req.method} 不认这个参数：${e.flag}——这一条命令认的是 ${(e.allowed ?? [])
              .map((f) => `--${f}`)
              .join(' · ')}`,
            data: { hint: '参数名就是那条命令的开关名（§ 9.6 那张表）' },
          }),
        )
        return
      }
      throw err
    }
    let result: ServeResult
    if (isSpecial(key)) {
      const { result: r, value } = await watchValue(valueArgs, { tail: tailOf() })
      result = { ...serveResultOf(r, true, 'value'), result: value }
    } else if (migrated(key)) {
      result = serveResultOf(await valueResultOf(key, valueArgs), true, 'value')
    } else {
      result = await runSubprocess(io.cli, req.method, params, io.root)
    }
    if (result.code !== 0) {
      const message = result.notes.join('\n')
      answer(
        req.id,
        encodeError(
          req.id,
          commandFailure(
            result.code === 3 ? 3 : result.code === 2 ? 2 : 1,
            message === '' ? `命令没成（退出码 ${result.code}）` : message,
            result.hint,
            result.subject,
          ),
        ),
      )
      return
    }
    answer(req.id, encodeResult(req.id, result))
  }

  // **一行一调用**：读进来的那一股按 `\n` 切，最后一段留到下一次（半行不算一行）。
  let buf = ''
  // **收尾的时候读口是被壳收掉的**（闲时自退那一档）：`for await` 会抛一个「提前关闭」——
  // 那是收尾的信号，不是这一趟的失败（不接住它，进程以 1 退出）。别的错照旧往上抛。
  const chunks: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const c of io.input) yield c
      } catch (err) {
        if ((err as { code?: string }).code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err
      }
    },
  }
  for await (const chunk of chunks) {
    buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const raw of parts) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.trim() === '') continue
      arm()
      const parsed = parseLine(line)
      if (!parsed.ok) {
        answer(parsed.id, encodeError(parsed.id, parsed.err), true)
        continue
      }
      // **一次一条 · 一条命令一个寿命**：串进 `busy`，后来的等它——**回执因此按调用序归位**
      // （批准过的那一句）。纯读也不叠着走：叠着走能省下同一 tick 里的重复扫描，但回执
      // 会按完成序出去，越过了那一句。省下的那一趟是**模块级**的性质——`tail.ts` 的
      // `advance()` 本来就把并发调用合并在同一次在飞的扫描上，`tail.test.ts` ① 直接量它。
      busy = busy.then(() => handle(parsed.req)).catch((err: unknown) => failed(parsed.req.id, err))
      await busy
    }
  }
  await busy
  stop()
  // **可弃**：连接收尾把那一份按根的索引扔掉（关句柄、散掉读过的行）。
  if (tail !== null) await tail.dispose()
  io.onClose?.()
}


/** 方法面上那些**动词**的键（给测试与文档对账用）。 */
export const METHOD_KEYS: readonly string[] = verbKeys()

/** 值层里有、方法面上也有的那几条（`tui` 是入口，两边都不出方法名）。 */
export const MIGRATED_METHODS: readonly string[] = Object.keys(FLAGS_OF)
  .filter((k) => migrated(k))
  .map(methodOf)
