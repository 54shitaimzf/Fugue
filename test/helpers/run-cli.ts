// 测试用的进程内 CLI 跑手（U9 抽出，`json-error.test.ts` 里同一形状的注释也写着为什么）：
// 换 `process.stdout` / `process.stderr` 这两个**对象**（不是给 `write` 打补丁——那会把
// `node --test` 子进程的报告一起吞掉），调 `main()` 收两股与返回码，调完还原。
import { main } from '../../src/cli/fugue.ts'

export interface CliFace {
  code: number
  stdout: string
  stderr: string
}

export async function runCli(argv: readonly string[]): Promise<CliFace> {
  const realOut = process.stdout
  const realErr = process.stderr
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
  try {
    const code = await main([...argv])
    return { code, stdout: out.join(''), stderr: err.join('') }
  } finally {
    Object.defineProperty(process, 'stdout', { value: realOut, configurable: true })
    Object.defineProperty(process, 'stderr', { value: realErr, configurable: true })
  }
}
