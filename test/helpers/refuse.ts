// 「拒了之后什么都没动」的统一口径。出处：PR15 审查件 § 5 教训 2（"Rust 那一侧几乎每个负面对照
// 都成对断言：**操作失败** + **状态与操作前逐字节相同**"）· 路线图 0.2.6 行。
//
// 为什么要提成一处：我方已经有多处 before/after 比对，但它**不是处处都有**。这条口径便宜
// （多存一份快照、多一行比对），而它抓的正是"拒了，但顺手改了一半"这一类最难查的错。
//
// **必含账文件字节**：`.fugue/log/**/*.jsonl` 收的是**原始字节**（base64 存的），不是哈希——
// 账是权威来源，它动了没有要一眼看得见（报错时会把两边的前一段原文解出来给人看）。
//
// 其余那几面（各条读数怎么记）见下面 `snapshotOf` 的说明。**跳过的路径只作用于树那一面**：
// 账那一面是无条件收的，"必含账文件字节"不能靠调用点记得给。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface Surface {
  /** 账：`.fugue/log` 下每一份 `.jsonl` 的**原始字节**（base64）。键是 `<第几个根>|<相对路径>`。 */
  readonly logs: Readonly<Record<string, string>>
  /** 树那一面：相对路径 → 一行读数（形状 · 模式 · 大小 · inode · mtime · 内容哈希）。 */
  readonly files: Readonly<Record<string, string>>
}

export interface SurfaceOptions {
  /** 树那一面要跳过的路径前缀（相对每个根）。挂载点那一类"读它没意义"的地方给它。 */
  readonly skip?: readonly string[]
}

const sha256Of = (abs: string): string => createHash('sha256').update(readFileSync(abs)).digest('hex')

/**
 * 一棵树走一遍，逐条记一行读数。**记 inode 与 mtime**（不只是内容）：
 * "拒了之后什么都没动"里那个"动"包括就地 `chmod`、`touch`、以及先写临时名再换回去这一路——
 * 内容一样而 inode 或时间戳变了，也是动了（`land.ts` 的承重性质量的就是这几样）。
 *
 * 白障（字符设备 0:0）单记一档：它在 `overlayfs` 档里是"这儿没有了"的凭据，不是普通条目。
 */
function walk(root: string, rel: string, out: Record<string, string>, skip: readonly string[]): void {
  let names: string[]
  try {
    names = readdirSync(rel === '' ? root : join(root, rel))
  } catch {
    return
  }
  for (const name of names.sort()) {
    const child = rel === '' ? name : `${rel}/${name}`
    if (skip.some((s) => child === s || child.startsWith(s + '/'))) continue
    const abs = join(root, child)
    const st = lstatSync(abs, { bigint: true, throwIfNoEntry: false })
    if (st === undefined || st === null) continue
    if (st.isDirectory()) {
      out[child] = `d ${st.mode.toString(8)} ${st.ino} ${st.mtimeNs}`
      walk(root, child, out, skip)
    } else if (st.isSymbolicLink()) {
      out[child] = `l ${readlinkSync(abs)} ${st.mtimeNs}`
    } else if (st.isCharacterDevice() && st.rdev === 0n) {
      out[child] = `w ${st.mtimeNs}`
    } else if (st.isFile()) {
      out[child] = `f ${st.mode.toString(8)} ${st.size} ${st.ino} ${st.mtimeNs} ${sha256Of(abs)}`
    } else {
      out[child] = `o ${st.mode.toString(8)} ${st.mtimeNs}`
    }
  }
}

/** 账那一面：`.fugue/log` 下每一份 `.jsonl` 的原始字节。**跳过清单管不到它。** */
function logsUnder(root: string, at: number, out: Record<string, string>): void {
  const base = join(root, '.fugue', 'log')
  const rec = (rel: string): void => {
    let names: string[]
    try {
      names = readdirSync(rel === '' ? base : join(base, rel))
    } catch {
      return
    }
    for (const name of names.sort()) {
      const child = rel === '' ? name : `${rel}/${name}`
      const abs = join(base, child)
      const st = lstatSync(abs, { bigint: true, throwIfNoEntry: false })
      if (st === undefined || st === null) continue
      if (st.isDirectory()) {
        rec(child)
        continue
      }
      if (child.endsWith('.jsonl')) out[`${at}|${child}`] = readFileSync(abs).toString('base64')
    }
  }
  rec('')
}

/** 几个根此刻的样子（账 + 树）。**同一件事前后各调一次**，两份比。 */
export function snapshotOf(dirs: readonly string[], o: SurfaceOptions = {}): Surface {
  const logs: Record<string, string> = {}
  const files: Record<string, string> = {}
  dirs.forEach((dir, i) => {
    logsUnder(dir, i, logs)
    const one: Record<string, string> = {}
    walk(dir, '', one, o.skip ?? [])
    for (const [k, v] of Object.entries(one)) files[`${i}|${k}`] = v
  })
  return { logs, files }
}

const sizeOf = (b64: string): number => Buffer.from(b64, 'base64').length

/** 一段原文（给人看的那一行；二进制按 `\uFFFD` 掉，无所谓——判据是 base64 那一栏）。 */
function headOf(b64: string): string {
  const text = Buffer.from(b64, 'base64').toString('utf8').split('\n')[0] ?? ''
  return JSON.stringify(text.length > 160 ? text.slice(0, 160) + '…' : text)
}

/** 两份快照逐条比。**不是比"文件个数"，是逐条读数比**——多一条、少一条、改一个字节都报出来。 */
export function assertUnchanged(before: Surface, after: Surface, what: string): void {
  const bad: string[] = []
  for (const k of [...new Set([...Object.keys(before.logs), ...Object.keys(after.logs)])].sort()) {
    const a = before.logs[k]
    const b = after.logs[k]
    if (a === b) continue
    if (a === undefined) bad.push(`账里多出一份 ${k}（${sizeOf(b as string)} 字节）`)
    else if (b === undefined) bad.push(`账少了一份 ${k}（原 ${sizeOf(a)} 字节）`)
    else {
      bad.push(
        `账变了 ${k}（${sizeOf(a)} → ${sizeOf(b)} 字节）\n      改前 ${headOf(a)}\n      改后 ${headOf(b)}`,
      )
    }
  }
  for (const k of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const a = before.files[k]
    const b = after.files[k]
    if (a === b) continue
    if (a === undefined) bad.push(`多出一条 ${k}：${b}`)
    else if (b === undefined) bad.push(`少了一条 ${k}：${a}`)
    else bad.push(`那一条变了 ${k}\n      改前 ${a}\n      改后 ${b}`)
  }
  assert.equal(bad.length, 0, `${what}：拒了之后什么都没动——实际动了这些：\n  - ${bad.join('\n  - ')}`)
}

/**
 * **跑一件该被拒的事，然后断言它什么都没动。** 返回那个错，调用者按类型/文案判它是哪一种拒。
 *
 * 两句话分开是本条口径的要点：**"该拒"与"拒了之后是干净的"是两条断言**，少一条就退化成
 * "这条命令报错了"——而"报错了、顺手改了一半"正是它要抓的东西。
 */
export async function refusedAndUnchanged(
  op: () => Promise<unknown> | unknown,
  dirs: readonly string[],
  what: string,
  o: SurfaceOptions = {},
): Promise<unknown> {
  const before = snapshotOf(dirs, o)
  let rejected = false
  let err: unknown = null
  try {
    await op()
  } catch (e) {
    rejected = true
    err = e
  }
  assert.equal(rejected, true, `${what}：这一趟该被拒，却没有`)
  assertUnchanged(before, snapshotOf(dirs, o), what)
  return err
}
