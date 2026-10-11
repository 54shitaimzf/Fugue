// 一趟可取消的请求的登记簿。**它不是第二个读源**：它不管读的是什么，只管这些请求什么时候
// 算数、收尾的时候怎么收干净。`commit-source.ts` 与 `image-source.ts` 各有一段逐字相同的
// "先拒新的、再掐旧的、再等它们落地"，收在这里一处。
//
// 三件事：
//   一 · 门关了就一律回 `null`——收尾之后再进来的请求不落地（也就不留一个没人收的子进程，
//        或者一个还在写终端的 worker）；
//   二 · 调用方那个 `signal` 掐过来时把这一趟掐掉。`run` 拿到的是**这一趟自己的**控制器，
//        与外层那个是两回事：这一趟还可能被门关、被它自己的超时掐，所以别把外层那个往下传；
//   三 · `close()` 把在飞的全部掐掉、再等它们各自收干净。**不等就是漏**——退出时那几毫秒里
//        还在写终端的子进程会把已经交还给宿主的那块屏再动一次。
//
// 清点时机（§ 四 的"关闭后清点子进程这条判据不再数早"）：登记在 `run` 返回之后、`run` 里面
// 那个同步段跑完之后——`jobs` 里那一条一定对应一个真开出来的东西，不会先记一条再开。
export interface JobRegistry<T> {
  /** 记一趟：门已关、或调用方已掐，就直接回 `null` 且**不调** `run`。 */
  readonly add: (signal: AbortSignal | undefined, run: (inner: AbortController) => Promise<T | null>) => Promise<T | null>
  /** 收尾：先拒新的，再掐在飞的，再等它们落地。幂等。 */
  readonly close: () => Promise<void>
}

/** 开一本登记簿。`T` 是这一趟读出来的东西（提交改动 / 一张图）。 */
export function openJobs<T>(): JobRegistry<T> {
  const jobs = new Map<AbortController, Promise<T | null>>()
  let closed = false
  return {
    add(signal, run) {
      if (closed || signal?.aborted) return Promise.resolve(null)
      const inner = new AbortController()
      const cancel = (): void => inner.abort()
      signal?.addEventListener('abort', cancel, { once: true })
      const done = run(inner).finally(() => {
        signal?.removeEventListener('abort', cancel)
        jobs.delete(inner)
      })
      jobs.set(inner, done)
      return done
    },
    async close(): Promise<void> {
      closed = true
      for (const inner of jobs.keys()) inner.abort()
      await Promise.allSettled(jobs.values())
    },
  }
}
