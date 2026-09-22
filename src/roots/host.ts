// 落点探测：这台机器把工作区放在了哪种文件系统上。出处：架构 § 15.7 的 E1「落点必须探」·
// § 15.8 的三档。
//
// **探针读环境、返回一份报告，不改状态、不写日志**（§ 15.7）。所以这里没有缓存、没有文件：
// 每次调用一次 `statfs`，答案从内核来。判据表是这一档唯一的一份知识。
//
// **E1 是硬要求，所以它是 fail-closed 的**（§ 15.7 的结论分档）：认得出是跨边界的一律拒绝
// 启动；认不出来的也拒绝——因为"认不出来"不等于"它是原生的"，而这一档的失败模式是**静默**的
// （git 调用预算从 700–1000 次/轮掉到 13–40，文件操作慢 22–282×）。拒绝文案指路，不筑墙：
// 它写出是哪一号、以及要改的是哪一处表。
//
// 这一份探的是**落点**，不是全部能力：`overlayfs` 能不能挂 · `reflink` 在不在 · `bwrap` ·
// `Landlock` 是 E2–E5，它们各自的消费者（M4 · M7）在用到时探，facts 落进工作区配置
// （§ 8.5 · § 15.7）。这里只回答"这个坐标能不能承载真源"。
import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AbsPath } from '../terms.ts'

/** 落点这一档怎么算。**判据是"有没有跨出一道边界"，不是快慢**（§ 15.7 · § 15.8）。 */
export type FsClass = 'native' | 'cross-boundary' | 'unknown'

export interface HostFacts {
  /** 声明的那一个根。判定与文案用它。 */
  readonly root: AbsPath
  /** 实际 `statfs` 的那一个——根还不存在时，是它最近的、存在的祖先。 */
  readonly probed: AbsPath
  /** `statfs` 报的 `f_type`。 */
  readonly magic: number
  /** 认得就给名字，认不得给 `0x…`。 */
  readonly fs: string
  readonly class: FsClass
}

interface FsRow {
  readonly magic: number
  readonly name: string
  readonly class: 'native' | 'cross-boundary'
}

/**
 * 判据表。**认得的都在这里，认不出的按"认不得"处理。**
 *
 * `native` 那一组是本地内核直接实现的文件系统：E1 要的是"原生的本地文件系统"，这一组是它
 * 的判据。`cross-boundary` 那一组是跨内核或用户态转发的：它们不是慢一点，是每一次访问都在
 * 做一次 RPC（§ 15.7 末句），而代价落在调用预算上——所以 E1 把它们挡在外面。
 */
const FS_TABLE: readonly FsRow[] = [
  { magic: 0xef53, name: 'ext2/3/4', class: 'native' },
  { magic: 0x58465342, name: 'xfs', class: 'native' },
  { magic: 0x9123683e, name: 'btrfs', class: 'native' },
  { magic: 0xca451a4e, name: 'bcachefs', class: 'native' },
  { magic: 0xf2f52010, name: 'f2fs', class: 'native' },
  { magic: 0x3153464a, name: 'jfs', class: 'native' },
  { magic: 0x52654973, name: 'reiserfs', class: 'native' },
  { magic: 0x2fc12fc1, name: 'zfs', class: 'native' },
  { magic: 0x5346544e, name: 'ntfs3', class: 'native' },
  { magic: 0x01021994, name: 'tmpfs', class: 'native' },
  { magic: 0x794c7630, name: 'overlayfs', class: 'native' },
  { magic: 0x01021997, name: '9p / drvfs', class: 'cross-boundary' },
  { magic: 0x65735546, name: 'fuse（含 virtiofs）', class: 'cross-boundary' },
  { magic: 0xff534d42, name: 'cifs', class: 'cross-boundary' },
  { magic: 0xfe534d42, name: 'smb2', class: 'cross-boundary' },
  { magic: 0x6969, name: 'nfs', class: 'cross-boundary' },
  { magic: 0x517b, name: 'smbfs', class: 'cross-boundary' },
]

/**
 * 探一个根落在哪一档上。**不存在的根探它最近的、存在的祖先**——一条 `--root <还不存在的
 * 目录>` 的命令不该因为目录还没建就绕过这一关，而它显然落在父目录那个文件系统上。
 * 一路都探不动（相对路径 + 不存在的 cwd 之类）就给 `null`：那种情况下没有落点可谈。
 */
export function probeHost(root: AbsPath): HostFacts | null {
  let at = root
  for (;;) {
    try {
      const magic = statfsSync(at).type
      const row = FS_TABLE.find((r) => r.magic === magic)
      return {
        root,
        probed: at,
        magic,
        fs: row === undefined ? `0x${magic.toString(16)}` : row.name,
        class: row === undefined ? 'unknown' : row.class,
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      const up = dirname(at)
      if (up === at) return null
      at = up
    }
  }
}

/** 这一份事实要不要拒绝启动。`null` = 放行。**纯判定**，所以表里的每一档都测得到。 */
export function hostRefusal(facts: HostFacts): string | null {
  if (facts.class === 'native') return null
  const magic = `0x${facts.magic.toString(16)}`
  const where =
    facts.probed === facts.root ? facts.probed : `${facts.probed}（${facts.root} 还不存在，探的是它最近的祖先）`
  if (facts.class === 'cross-boundary') {
    return [
      `[host: 工作区落在 ${facts.fs} 上]  ${where}`,
      '  架构 § 15.7 的 E1 是硬要求：原生的本地文件系统承载 realRoot。这一档是跨内核 / 用户态',
      `  转发的那一类（statfs 报 ${magic}），失败模式是静默的——git 调用预算从 700–1000 次/轮掉到`,
      '  13–40，文件操作慢 22–282×（§ 15.7 的实测）。',
      '  把工作区移到 ext4 / xfs / btrfs 上再启动；工具链要与它落在同一侧（§ 15.7 的推论）。',
    ].join('\n')
  }
  return [
    `[host: 认不得的文件系统]  ${where}`,
    `  statfs 报 ${magic}，判据表里没有这一号。E1 是硬要求，认不出来的东西不能按"它是原生的"`,
    '  放行——那正是这一档要防的静默退化（§ 15.7）。',
    '  确认它是本地的原生文件系统之后，把它加进 src/roots/host.ts 的判据表（一处表，没有',
    '  第二个地方要改）；否则把工作区移到 ext4 上。',
  ].join('\n')
}

/** 拒绝启动。**带事实**：调用点要能报出是哪一号、探的是哪个坐标。 */
export class HostError extends Error {
  readonly facts: HostFacts
  constructor(message: string, facts: HostFacts) {
    super(message)
    this.name = 'HostError'
    this.facts = facts
  }
}

/** 探 + 判 + 抛。根探不动（`null`）时放行：那种情形由命令自己报"工作区根不存在"。 */
export function assertHost(root: AbsPath): HostFacts | null {
  const facts = probeHost(root)
  if (facts === null) return null
  const why = hostRefusal(facts)
  if (why !== null) throw new HostError(why, facts)
  return facts
}
