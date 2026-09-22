// M4 的契约。出处：架构 § 8.5——`ForkStrategy` · `MaterializeOptions` · `Materializer` ·
// `MatManifest` 四个名字逐字照抄。
//
// **这一份只有类型。** 三档怎么探在 `capability.ts`、底怎么铺在 `lay.ts`、挂载怎么管在
// `mount.ts`，把 `fork` 编排起来的是 `fork.ts`。消费者 import 的是 `Materializer` 与
// `MaterializeOptions`，不是那几份：换实现不动调用点。
//
// **V2 只兑现 `fork`。** `ensure`（V3）· `manifest`（V4）· `dispose`（V5）三个成员在这里
// 已经冻结——接口形状先定下来，后面三个单元往里填，不各自长一套。
//
// **`readOnlyPaths` 不在 § 8.5 的字段表里，它是 S2 的临时落点。** 硬链接纪律说
// `hardlink-ro` "仅用于沙箱保证只读的路径"（§ 8.5），而"哪些路径只读"的持有者是 `M7` 的
// 策略（S5）。S5 之前没有策略层，这一档就没人喂它——所以 V2 让人在调用点声明（CLI 的
// `--ro`）。`M7` 落地时这个字段要么由 `Policy` 填，要么整个删掉、搬到策略那一侧：**它在这里
// 是暂居，不是设计。**
import type { AbsPath, AgentId, CommitId, ForkStrategy, RelPath, ViewRev } from '../terms.ts'

export interface MaterializeOptions {
  preserveMtime: boolean
  changeDetector: 'content-hash' | 'mtime-size'
  detectRenames: boolean
  pruneEmptyDirs: boolean
  preferredStrategy?: ForkStrategy
  /** 见文件头：S2 的临时落点，S5 起由 `M7` 的策略填。 */
  readOnlyPaths?: readonly RelPath[]
}

export interface MatManifest {
  rev: ViewRev
  paths: RelPath[]
  hashes: string[]
}

export interface Materializer {
  fork(a: AgentId, base: CommitId, opt?: MaterializeOptions): Promise<AbsPath>
  ensure(a: AgentId, upTo: ViewRev): Promise<AbsPath>
  manifest(a: AgentId): MatManifest
  dispose(a: AgentId): Promise<void>
}

/**
 * § 8.5 明写的两个默认值（`preserveMtime` · `pruneEmptyDirs` 为 true，`detectRenames` 为
 * false），加上一个没明写的：`changeDetector` 取 `content-hash`。
 *
 * **它只在 copy 与 hardlink 两档上生效**（`overlayfs` 靠枚举 `upper`，§ 8.5）。默认取内容
 * 哈希而不是 `mtime-size`，是因为后者在 NTFS 上不安全——连续两次写可以拿到完全相同的
 * mtime（§ 15.7）。虽然 E1 已把这类落点挡在门外，默认值不该依赖另一处的检查才成立。
 */
export const DEFAULT_MATERIALIZE: MaterializeOptions = {
  preserveMtime: true,
  changeDetector: 'content-hash',
  detectRenames: false,
  pruneEmptyDirs: true,
}
