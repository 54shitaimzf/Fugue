// TUI 收尾那一组钩子（0.2.8 U4）：**它必须在第一帧之前挂上**。
//
// 为什么这是这一份的性质、不是调用点的风格问题：`ui/term.ts` 的 `close()` 是每一条退出路径都要走到
// 的那一下（raw mode 还原 · 出 alt screen · 面板收走）。四路里正常退与 `Ctrl-C` 由调用方自己走完，
// `SIGTERM` / `SIGHUP` 与"崩了"（`exit` 那一钩）由这一份挂。**挂晚了就是一个真 bug**：首帧之前收到
// `SIGTERM`，进程走缺省的杀进程路径，那台终端被留在另一块屏上（`--full`）或 raw mode 里，得人
// `reset`——而首帧之前那一下恰恰是最容易发生的（面板刚起来、人正在切窗口）。
//
// 顺序因此**在源码里量**（`exit-hooks.test.ts` ② 拿 `observe.ts` 两个符号的行号钉着它）：主进程上
// 那几条真信号要开一个真终端才量得到，而那是路线图 0.2.8 行说的"视觉验收归实现者"那一档。
//
// 这一份只做三件事：挂 `SIGTERM` · 挂 `SIGHUP` · 挂 `exit`；`close()` 把前两条摘掉（`exit` 是
// `once`，本来只来一次，不摘）。**不碰 `process` 之外的任何东西**——还原终端那一下是调用方递进来的
// 闭包（它才知道 `keys` 与 `term` 是谁）。

/** 挂钩子的那一头（`process` 就是它）。**只要这三样**：测试里给一个假的就能把顺序与幂等量完。 */
export interface HookHost {
  on(ev: 'SIGTERM' | 'SIGHUP', f: () => void): unknown
  once(ev: 'exit', f: () => void): unknown
  removeListener(ev: 'SIGTERM' | 'SIGHUP', f: () => void): unknown
}

/** 收尾要接的两条路：一路递给在途那一趟（`abort`），一路把终端还原回去（`close`）。 */
export interface ExitHooks {
  /** 挂上的信号。**唯一一处**（`observe.ts` 不再自己列一遍）。 */
  readonly signals: readonly string[]
  /** 摘掉信号那两个。**幂等**——收尾那一路正常退与 `finally` 都会走到它。 */
  close(): void
}

/** 收尾要接的信号。 */
export const EXIT_SIGNALS: readonly string[] = ['SIGTERM', 'SIGHUP']

/**
 * 挂上收尾钩子。进来就挂（`on` × 2 + `once('exit')` × 1），还回一只 `close()`。
 * **调用点必须让这一句排在开终端与开首帧之前**——那是这一份存在的理由。
 */
export function openExitHooks(
  host: HookHost,
  o: { readonly onSignal: () => void; readonly onExit: () => void },
): ExitHooks {
  const onSignal = (): void => o.onSignal()
  for (const sig of EXIT_SIGNALS) host.on(sig as 'SIGTERM' | 'SIGHUP', onSignal)
  host.once('exit', o.onExit)
  let open = true
  return {
    signals: EXIT_SIGNALS,
    close(): void {
      // 幂等：第二遍一个字节都不动（正常退那一路与 `finally` 都会调它）。
      if (!open) return
      open = false
      for (const sig of EXIT_SIGNALS) host.removeListener(sig as 'SIGTERM' | 'SIGHUP', onSignal)
    },
  }
}
