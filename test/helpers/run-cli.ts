// 测试用的进程内 CLI 跑手（U9 抽出，`json-error.test.ts` 里同一形状的注释也写着为什么）：
// 换 `process.stdout` / `process.stderr` 这两个**对象**（不是给 `write` 打补丁——那会把
// `node --test` 子进程的报告一起吞掉），调 `main()` 收两股与返回码，调完还原。
//
// **0.4.2 加了一栏 `stdin`**：值层里那几条要 stdin 的命令（`write --stdin`）在套件里跑起来时，
// 真 stdin 是**测试进程自己的**（`node --test` 底下它是一个不能读的管道）——`readStdin()` 在
// 那上面会直接抛 `ERR_INVALID_ARG_TYPE`。所以这一栏让调用方把 `process.stdin` 换成一个能读的
// 对象（`asyncIterableOf`），调完还原。
import { main } from '../../src/cli/fugue.ts'

export interface CliFace {
  code: number
  stdout: string
  stderr: string
}

/** 一个能当 `process.stdin` 用的替身：`for await` 那一圈读得到那几段字节。 */
export function stdinOf(text: string): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8')
    },
  }
}

export async function runCli(argv: readonly string[], stdin?: AsyncIterable<Buffer>): Promise<CliFace> {
  const realOut = process.stdout
  const realErr = process.stderr
  const realIn = process.stdin
  const out: string[] = []
  const err: string[] = []
  const sink = (sink_: string[]): { write: (c: unknown) => boolean } => ({
    write: (c) => {
      sink_.push(String(c))
      return true
    },
  })
  Object.defineProperty(process, 'stdout', { value: sink(out), configurable: true })
  Object.defineProperty(process, 'stderr', { value: sink(err), configurable: true })
  if (stdin !== undefined) Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  try {
    const code = await main([...argv])
    return { code, stdout: out.join(''), stderr: err.join('') }
  } finally {
    Object.defineProperty(process, 'stdout', { value: realOut, configurable: true })
    Object.defineProperty(process, 'stderr', { value: realErr, configurable: true })
    if (stdin !== undefined) Object.defineProperty(process, 'stdin', { value: realIn, configurable: true })
  }
}
