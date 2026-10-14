// **全量装载那一档（地板）。** `cli/load.ts` 的退化档：短名不在表里（映射丢了）、或者那一份
// 装不上（路径错了）——两种都落到这里，把**整个命令族的模块一次装齐**，入口那一段分发照旧从
// 这份并集里取符号。判据是工作区约定那条：那个机制死掉的时候，系统是**变慢**，不是**跑不起来**。
// `src/cli/load.test.ts` ② 真走一遍这一档（拿一个表里没有的短名）。
//
// **这一份只做再导出。** 它没有第二份分发、没有第二张命令表、一个字节的语义都没有——地板要是
// 自己长出一份判断，它就成了第二处真相。
//
// 为什么 `export *` 可以（以及它凭什么不会漏）：这一族模块的导出名实测互不重名。重名的名字在
// `export *` 下会被**静默丢掉**——那等于地板自己漏一个符号，而且是静默的。所以
// `src/cli/load.test.ts` ③ 逐份核一遍：每一份的每一个导出，在这一份并集里都取得到。
export * from '../ui/console.ts'
export * from './cmd/serve.ts'
export * from './cmd/view.ts'
export * from './cmd/config.ts'
export * from './cmd/doctor.ts'
export * from './cmd/materialize.ts'
export * from './cmd/execute.ts'
export * from './cmd/assemble.ts'
export * from './cmd/round.ts'
export * from '../value/cli.ts'
export * from '../value/shell.ts'
export * from '../roots/host.ts'
export * from '../log/log.ts'
export * from '../log/hold.ts'
export * from './flags.ts'
export * from '../value/types.ts'
