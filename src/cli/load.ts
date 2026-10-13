// **按命令装载那一份模块。** 入口（`cli/fugue.ts`）从前把整个命令族十四条静态 import 装齐，
// 于是**每条命令都在为"全命令族的并集"付装载钱**：`fugue --version` 与 `fugue round run` 装的是
// 同一棵 349 份模块的树（实测 183 ms）。这一份把"走到哪一条命令才装哪一份"收成一处：短名 → 那一份。
//
// **这一张表不认识任何命令。** 命令名与它要的短名都只在入口那一段分发里出现一次；表里只有模块的
// 短名。所以不存在第二份"命令 → 模块"的清单可以漂移——那一类清单正是这个仓最想避免的东西
// （`cli/flags.ts` 的注释也写着同一件事：命令面的单一真源）。
//
// **地板**：短名不在表里，或者那一份装不上——两种都落到 `./all.ts`，也就是**全量装载那一档**
// （整个命令族一次装齐）。判据是工作区约定那条：那个机制死掉的时候，系统是**变慢**，不是
// **跑不起来**。`src/cli/load.test.ts` ② 拿一个表里没有的短名真走一遍。
//
// 说明符**一律字面**写在下面：`tools/mutation-audit.js` 的 import 图靠正则认边，算出来的路径它
// 一个字都看不见——那会让 `src/cli/cmd/*` 从覆盖审计里**静默**掉出去（不报错，只是不再被审计）。
const LOADERS = {
  console: () => import('../ui/console.ts'),
  serve: () => import('./cmd/serve.ts'),
  view: () => import('./cmd/view.ts'),
  config: () => import('./cmd/config.ts'),
  doctor: () => import('./cmd/doctor.ts'),
  materialize: () => import('./cmd/materialize.ts'),
  execute: () => import('./cmd/execute.ts'),
  assemble: () => import('./cmd/assemble.ts'),
  round: () => import('./cmd/round.ts'),
  value: () => import('../value/cli.ts'),
  shell: () => import('../value/shell.ts'),
  flags: () => import('./flags.ts'),
  host: () => import('../roots/host.ts'),
  log: () => import('../log/log.ts'),
  hold: () => import('../log/hold.ts'),
} as const

/** 表里有哪几个短名。断言拿它核入口里每一个 `load('…')`——写错一个字母会**静默**落到地板上。 */
export const LOADER_NAMES: readonly string[] = Object.keys(LOADERS).sort()

/**
 * 取到的那一份模块。类型取 `./all.ts` 那一份**并集**：按命令装的那一份只提供其中几个名字，
 * 调用点只碰它自己那几个（这台机器上 Node 直跑 `.ts` 不做类型检查，这一行是给读的人看的）。
 */
export type Mods = typeof import('./all.ts')

/**
 * 取某一份模块。**按命令装载**：短名在表里就只装那一份。
 *
 * **地板**：短名不在表里（映射丢了），或者那一份装不上（路径错了）——两种都落到 `./all.ts`。
 * 系统是变慢，不是跑不起来。**不在这里报错**：真正装不上的东西 `all.ts` 里照样会抛，那时候的
 * 错误才是真的；这一档只是"那一格没装上"。
 */
export async function load(name: string): Promise<Mods> {
  const loader = (LOADERS as Readonly<Record<string, undefined | (() => Promise<unknown>)>>)[name]
  if (loader !== undefined) {
    try {
      return (await loader()) as Mods
    } catch {
      // 落到地板：下面那一句全量装载。
    }
  }
  return await import('./all.ts')
}
