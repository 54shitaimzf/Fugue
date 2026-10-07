// 黄金帧的**掩码**（0.4.2 站）：把一份输出里「非常数的来源」换成稳定的记号。
//
// 帧是特征测试——锁今天的行为。可行为里有一部分**本来就不该逐字节锁**：临时目录的路径 · 读帧
// 那一刻的钟 · 这台机器的文件系统档。这一份把那些位置换成记号，于是同一条命令在任何一天 ·
// 任何一台一等档主机上，规范化之后的字节相同。
//
// **只换得出处，不换形状**：出现的换记号，不出现的照旧不出现——`--no-clock` 那一档与给钟那一
// 档的差别因此还看得见（前者一个记号都没有）。这与 § 9.2「缺栏 = 未量到」同一条口径。
//
// 规则分三层：整棵树的路径 · 明文里的钟与标识 · JSON 叶子上的易变数（时钟三栏 · 历时 · 档）。
// **JSON 那一层按结构走**，所以 `"ts":1759…` 里的数字被换掉，而正文里的数字一个不动——不靠
// 正则去猜哪个数是时刻。
import { homedir, tmpdir } from 'node:os'

/** 时钟三栏（架构 § 9.2 的信封）——值换记号。 */
const CLOCK_KEYS = new Set(['ts', 'boot', 'inc', 'clock'])
/** 历时的栏：任何一条命令读出来都跟着「读的那一刻」走。 */
const ELAPSED_KEYS = new Set([
  'elapsedMs',
  'elapsed',
  'uptimeMs',
  'ageMs',
  'sinceMs',
  'startedAt',
  'ms',
  'durationMs',
  'tookMs',
])
/** 读帧那一刻的钟进来的别处：档（峰谷）· 绝对时刻。 */
const WALL_KEYS = new Set(['phase', 'now', 'at', 'when'])
/** 产品版本：**每一版都跳**（与钟同一档——读出来的东西跟着这一份安装走，不是这条命令要说的事）。 */
const VERSION_KEYS = new Set(['version'])

/** 明文里要被换掉的那几类。**只换「读的那一刻」与「这台机器」进来的数**：历时的毫秒 · 状态
 * 迁移的那几个计数 · 环境那一档的版本号与路径。**内容里的数一个不动**（token 数 · 字节数 ·
 * 修订号 · 条目数——它们是这条命令要说的事）。 */
const PLAIN_RULES = [
  // ISO 时刻（`2026-10-07T12:34:56.789Z`）
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TS>'],
  // epoch 毫秒（13 位）
  [/\b1\d{12}\b/g, '<TS>'],
  // 锁文件里那条记录里印出来的 pid（人读那一面会 `cat` 它）
  [/\bpid (\d+)/g, 'pid <PID>'],
  // 产品版本：人读面那一行 `fugue <号>`（`--version`）
  [/\bfugue \d+\.\d+\.\d+\b/g, 'fugue <VERSION>'],
  // 历时：`3 ms` · `5 ms`（这条命令花了多久）
  [/\b\d+(\.\d+)? ?ms\b/g, '<MS>'],
  // `run` 的结果行：`<退出码>\t<历时毫秒>\t<enforcement>`——只换中间那一栏（第 1 与第 3
  // 栏是这条命令要说的事：成没成 · 围栏关到哪一档）
  [/^(\d+)\t\d+\t(full|partial)$/gm, '$1\t<MS>\t$2'],
  // 状态迁移的那几个读数：`rev 0 → 3 · 落地 2 条 · 原样 0 条`
  [/rev \d+ → \d+ · 落地 \d+ 条 · 原样 \d+ 条/g, 'rev <N> → <N> · 落地 <N> 条 · 原样 <N> 条'],
  // 种子那一段的上限与份数：跟着这一台机器的模型目录走
  [/上限 \d+ token\t逐份 \d+\t在钉住的底上取到 \d+ 份内容/g, '上限 <N> token\t逐份 <N>\t在钉住的底上取到 <N> 份内容'],
  // 环境那一档认出来的版本（这台机器上装的是什么）
  [/bubblewrap \d+(\.\d+)*/g, 'bubblewrap <N>'],
  [/v\d+\.\d+\.\d+（engines 要/g, 'v<N>（engines 要'],
  [/PATH 里有 git（[^）]*）/g, 'PATH 里有 git（<PATH>）'],
  // 落点那一档认出来的文件系统名（`ext2/3/4` · `9p` · `drvfs`——一等档主机之外都换掉）
  [/· (ext2\/3\/4|ext4|9p|drvfs|overlayfs|tmpfs|btrfs|fuseblk) · (native|9p|drvfs|network|unknown)\b/g, '· <FS> · <CLASS>'],
  // `doctor` 那几行与环境绑着的那一半：自检函数的一个回显 · 包装器铺在哪 · git 在 PATH 的哪儿
  [/crc32\(\\*"[^"\\]*\\*"\) = [0-9a-f]+/g, 'crc32("<TEXT>") = <CRC>'],
  [/（<ROOT>\/\.fugue\/bin\/[^）]*）/g, '（<ROOT>/.fugue/bin/<WRAPPER>）'],
  [/PATH 里有 git（[^）]*）/g, 'PATH 里有 git（<PATH>）'],
  [/ · \/usr\/bin\/git/g, ' · <PATH>'],
]

/**
 * 规范化一段文本。
 *
 * `paths` 是这棵树里**每一种指向临时工作区的写法**（绝对 · 软链那一侧）：先换长的，免得
 * `/tmp/fugue-x` 先把 `/tmp/fugue-x/sub` 吃掉一半。
 */
export function normalizeText(text, paths = []) {
  const out = maskText(String(text), paths)
  // **一行一整份 JSON 的那一档**（`--json` 面的回执就是它）：按结构再走一层——点上名的叶子
  // （`ts` · `ms` · `phase` 那一族）换成记号，**正文里的数字一个不动**。
  const trimmed = out.trim()
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed)
      const normal = normalizeValue(parsed, paths)
      return JSON.stringify(normal) + (out.endsWith('\n') ? '\n' : '')
    } catch {
      /* 不是一整份 JSON：照明文那一档走 */
    }
  }
  return out
}

/**
 * 明文那一层：只换「读的那一刻」与「这台机器」进来的那几个位置。**内容里的数一个不动**
 * （token 数 · 字节数 · 修订号 · 条目数——它们是这条命令要说的事）。
 */
function maskText(text, paths = []) {
  let out = text
  const wanted = [...new Set(paths.filter((p) => typeof p === 'string' && p !== ''))].sort(
    (a, b) => b.length - a.length,
  )
  for (const p of wanted) out = out.split(p).join('<ROOT>')
  // 路径前缀还在时也换掉
  out = out.replaceAll(tmpdir(), '<TMP>')
  const home = homedir()
  if (home && home !== '/') out = out.replaceAll(home, '<HOME>')
  for (const [re, to] of PLAIN_RULES) out = out.replace(re, to)
  return out
}

/** JSON 那一层：只换点名的叶子，正文里的数字一个不动。 */
export function normalizeValue(v, paths = []) {
  if (typeof v === 'string') return normalizeText(v, paths)
  if (Array.isArray(v)) return v.map((x) => normalizeValue(x, paths))
  if (v !== null && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (CLOCK_KEYS.has(k) && x !== null && x !== undefined) out[k] = '<CLOCK>'
      // **只认点分三段那个形状**： 的回执里也有一栏叫 `version`，那是协议版本(`s6-1`)，不是产品版本
      // **只认点分三段那个形状**：`assemble` 的回执里也有一栏叫 `version`，那是协议版本（`s6-1`），
      // 不是产品版本——那一栏照旧逐字节锁住。
      else if (VERSION_KEYS.has(k) && typeof x === 'string' && /^\d+\.\d+\.\d+$/.test(x)) out[k] = '<VERSION>'
      else if ((ELAPSED_KEYS.has(k) || WALL_KEYS.has(k)) && x !== null && x !== undefined) out[k] = '<NOW>'
      else out[k] = normalizeValue(x, paths)
    }
    return out
  }
  if (typeof v === 'number') {
    // 顶格的 epoch 毫秒/秒：任何一条命令都可能把「读的那一刻」原样印出来
    if (Number.isInteger(v) && v > 1_600_000_000 && v < 4_000_000_000) return '<TS>'
    if (Number.isInteger(v) && v >= 1_600_000_000_000 && v < 4_000_000_000_000) return '<TS>'
    return v
  }
  return v
}

/** 一帧的两股输出（stdout 逐字节 · stderr 逐字节）。 */
export function normalizeFace(face, paths = []) {
  return {
    code: face.code,
    stdout: normalizeText(face.stdout, paths),
    stderr: normalizeText(face.stderr, paths),
  }
}
