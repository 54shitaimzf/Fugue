// 登记簿自己那一条契约。两个消费者各有自己的真子进程级断言（`commit-source.test.ts` ·
// `image-source.test.ts`），这一份只钉它们共同依赖、而两边**都抓不住**的那一条：
// "`close()` 回来的时候，在飞的那一趟已经落地"——实测把 `close()` 里那句
// `await Promise.allSettled(...)` 去掉，两边仍然全绿。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openJobs } from './jobs.ts'

/** 一趟自己说了算的活：没人掐它就不落地。`abortedAtSettle` 记的是它落地那一刻这一趟有没有被掐。 */
function slowJob(): {
  readonly run: (inner: AbortController) => Promise<number | null>
  readonly settled: () => boolean
  readonly abortedAtSettle: () => boolean
} {
  let settled = false, aborted = false
  return {
    settled: () => settled,
    abortedAtSettle: () => aborted,
    run: inner => new Promise<number | null>(resolve => {
      const finish = (): void => { aborted = inner.signal.aborted; settled = true; resolve(null) }
      // **掐掉之后不立刻落地**：真东西要等子进程的 `close` 事件、要等 worker 的 `exit`，
      // 都在这一个事件循环之后。同步落地的话"`close()` 到底等了没有"就看不出来了
      // （实测：那样连"去掉 `await Promise.allSettled(...)`"都抓不住）。
      const later = (): void => { setImmediate(finish) }
      if (inner.signal.aborted) { later(); return }
      inner.signal.addEventListener('abort', later, { once: true })
    }),
  }
}

test('登记簿 · 门关了就不再接新的：`close()` 之后进来的请求回 `null`，且不调 `run`', async () => {
  const jobs = openJobs<number>()
  await jobs.close()
  let ran = 0
  assert.equal(await jobs.add(undefined, () => { ran += 1; return Promise.resolve(1) }), null)
  assert.equal(ran, 0)
  await jobs.close()
})

test('登记簿 · 调用方那个信号已经掐了就回 `null`，不调 `run`', async () => {
  const jobs = openJobs<number>()
  const outer = new AbortController()
  outer.abort()
  let ran = 0
  assert.equal(await jobs.add(outer.signal, () => { ran += 1; return Promise.resolve(1) }), null)
  assert.equal(ran, 0)
})

test('登记簿 · 调用方掐过来时这一趟被掐掉：`run` 拿到的是这一趟自己的控制器', async () => {
  const jobs = openJobs<number>()
  const outer = new AbortController()
  const job = slowJob()
  const done = jobs.add(outer.signal, job.run)
  assert.equal(job.settled(), false)
  outer.abort()
  assert.equal(await done, null)
  assert.equal(job.abortedAtSettle(), true, '外层那个信号掐过来时，这一趟必须已经被掐')
})

test('登记簿 · `close()` 先掐在飞的那些，再等它们落地才回来', async () => {
  const jobs = openJobs<number>()
  const job = slowJob()
  const done = jobs.add(undefined, job.run)
  assert.equal(job.settled(), false)
  await jobs.close()
  assert.equal(job.settled(), true, '`close()` 回来的时候，在飞的那一趟必须已经落地')
  assert.equal(job.abortedAtSettle(), true, '而且是被 `close()` 掐掉的，不是自己走完的')
  assert.equal(await done, null)
})

test('登记簿 · `run` 在 `add` 里同步起头：登记的那一条一定对应一个真开出来的东西', async () => {
  const jobs = openJobs<number>()
  let started = false
  const done = jobs.add(undefined, inner => {
    started = true
    return new Promise<number | null>(resolve => inner.signal.addEventListener('abort', () => resolve(null), { once: true }))
  })
  assert.equal(started, true, '`add` 回来的时候 `run` 里那个同步段必须已经跑过')
  await jobs.close()
  assert.equal(await done, null)
})

test('登记簿 · 一趟落地之后把调用方那个信号上的监听摘掉（长命信号上不攒一份一份的账）', async () => {
  let attached = 0
  const outer = {
    aborted: false,
    addEventListener: (): void => { attached += 1 },
    removeEventListener: (): void => { attached -= 1 },
  } as unknown as AbortSignal
  const jobs = openJobs<number>()
  assert.equal(await jobs.add(outer, () => Promise.resolve(1)), 1)
  assert.equal(attached, 0, '落地之后那一份监听必须已经摘掉')
  await jobs.close()
})
