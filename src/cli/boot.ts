// **编译缓存。** V8 每起一个进程，都要把同一批源码重新编译一遍（转成字节码），而两次命令之间这份
// 源码一个字节都没变——`node:module` 的 `enableCompileCache(dir)` 把编译结果落成一份**可弃派生
// 体**，下一次同一份源码直接取来用。出处：本批施工单 § 三 2（每个子进程重复付同一份翻译税）。
//
// **为什么这件事住在这里、而且必须是入口模块体的第一句**：ESM 整张静态图在**求值之前**就编译完
// 了，所以在入口里 `import` 什么都救不回来——要缓存的东西只能是在 `armCompileCache()` **之后**才
// 被编译的那些。入口的静态闭包因此只剩 `node:` 内建与 `./load.ts`（`src/cli/load.test.ts` ⑤ 与
// ⑥ 盯着这一条），解析那一层 · 出口那一层 · 各命令组全走动态装载。
//
// **地板**（工作区约定 § 五·一）：缓存目录建不出来——只读的家目录 · 没权限的 `XDG_CACHE_HOME` ·
// 磁盘满——时 Node 只把状态报成 `FAILED`，进程照跑：**只是没有缓存，慢一点**。真走过一次，读数在
// 提交信息里。**可弃派生体**：删掉整个缓存目录重来，同一条命令读出来的字节逐字节相同（V8 按源码
// 校验缓存，对不上就重编），所以它不在"一处真相"那份账上，也不该进任何提交。
//
// 落点：`$XDG_CACHE_HOME/fugue/compile-cache`，没设就是 `~/.cache/fugue/compile-cache`。
// **关掉那一档**：`FUGUE_COMPILE_CACHE=off`——A/B 取证、以及不想留派生物的场合用它。
import { constants, enableCompileCache, getCompileCacheDir } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 关掉那一档的几个写法。 */
const OFF: ReadonlySet<string> = new Set(['off', '0', 'no', 'false', 'none'])

/** 缓存落点。**只有这一处算它**——命令行与测试入口读的是同一个值。 */
export function compileCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME
  const cache = base !== undefined && base !== '' ? base : join(homedir(), '.cache')
  return join(cache, 'fugue', 'compile-cache')
}

/** 这一档关没关。 */
export function compileCacheOff(): boolean {
  const asked = process.env.FUGUE_COMPILE_CACHE
  return asked !== undefined && OFF.has(asked.trim().toLowerCase())
}

/**
 * 把编译缓存那一栏接到一份环境上。
 *
 * 测试入口（`tools/test-entry.js`）把它递给 `node --test`：那一棵树的每个子进程（每个测试文件、
 * 以及它们起的命令行）都因此吃得到同一份缓存。**环境里已经指了一处（`NODE_COMPILE_CACHE`）就听
 * 它的**：那是调用方明确选的，这一份不覆盖。
 */
export function withCompileCache(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (compileCacheOff()) return env
  if (env.NODE_COMPILE_CACHE !== undefined && env.NODE_COMPILE_CACHE !== '') return env
  return { ...env, NODE_COMPILE_CACHE: compileCacheDir() }
}

/** 这一趟的结果：开了没有 · 落在哪 · 没开是为什么（读数，不是错误）。 */
export interface CompileCache {
  readonly enabled: boolean
  readonly dir: string | null
  readonly why: string | null
}

let armed: CompileCache | null = null

/**
 * 打开编译缓存。**入口模块体的第一句**——它之前只许有 `node:` 内建与 `./load.ts` 那一条静态
 * import（`src/cli/boot.test.ts` ① 静态盯着这个次序）。重复调用返回第一次的结果。
 */
export function armCompileCache(): CompileCache {
  if (armed !== null) return armed
  if (compileCacheOff()) {
    armed = { enabled: false, dir: null, why: 'FUGUE_COMPILE_CACHE 把它关了' }
    return armed
  }
  const asked = compileCacheDir()
  let status = constants.compileCacheStatus.FAILED
  let message: string | undefined
  try {
    const r = enableCompileCache(asked)
    status = r.status
    message = r.message
  } catch (err) {
    // 连"报个状态"都没做到：照样是地板那一档——不抛。
    armed = { enabled: false, dir: null, why: err instanceof Error ? err.message : String(err) }
    return armed
  }
  const enabled =
    status === constants.compileCacheStatus.ENABLED || status === constants.compileCacheStatus.ALREADY_ENABLED
  armed = {
    enabled,
    // 环境里另指了一处时，真正生效的是它——报出来的是实际那一处（`getCompileCacheDir`）。
    dir: enabled ? (getCompileCacheDir() ?? asked) : null,
    why: enabled ? null : (message ?? `状态 ${status}`),
  }
  return armed
}
