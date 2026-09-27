// 虚拟空间的唯一入口（架构 § 8.4 硬纪律 1）。**两道关，顺序不能反。**
//
//   一 · 语法关：把原始输入按 `cwd` 解析成视图内的路径，走出去就拒（绝对路径 · `..` 越界 ·
//        空段 · 反斜杠）。这一关是纯算术，在 `paths.ts`。
//   二 · 物理关：**用 `lstat` 逐段看真实落点**，凡有一个前缀是软链就拒。
//
// 第二关用 `lstat` 而不是 `stat`：`stat` 会跟着软链走，而那正是要拦的那一步——边界检查必须
// 发生在解析**之前**。这里也不"解析一次再判一次"：**视图里的路径不穿过软链**，哪怕那个软链
// 指着工作区里面。判据是"虚拟空间可达集 == 物理空间可达集"（§ 8.4 的验证性质），而视图里
// `link/x` 根本不是一条路径——`link` 是一个软链条目，不是目录；跟着走就把物理上多出来的
// 那些坐标放进了虚拟空间。
//
// **最后一段允许是软链**：删它 · 改名 · 看它的形状都是对那个条目本身的操作，不构成穿越。
// 一条路径因此有两个判据，而不是一个——这是"前缀"与"整条"的区别，不是宽松。
//
// 真实树上还不存在的路径照常放行：写新文件走的就是它（下面没有软链可穿）。
import { lstatSync } from 'node:fs'
import type { AbsPath, RelPath } from '../terms.ts'
import type { Denied, DenyKind, Result } from './contract.ts'
import { resolveRaw, toPhysical } from './paths.ts'

/** 拒绝文案里那句指路（架构 § 8.4 纪律 2 的原句）。**文案是形状的一部分**：拒绝要给出去处。 */
const APPLY = 'reaching outside the workspace goes through an application (architecture § 15.3.b).'

function refusal(
  kind: DenyKind,
  raw: string,
  at: string,
  detail: string,
  message: string,
): Denied {
  return { denied: true, kind, raw, at, detail, message }
}

/**
 * 造一条拒绝。四种由头各自成句，`at` 指出挡在哪儿。
 *
 * **每个分支各自返回**：将来多一种由头而这里忘了写文案，编译就过不去，而不是落一句空话。
 */
export function deny(kind: DenyKind, raw: string, at: string, detail: string): Denied {
  switch (kind) {
    case 'absolute':
      return refusal(
        kind,
        raw,
        at,
        detail,
        `[boundary: paths inside the view are relative]  ${raw} — ${detail}. Use read inside the workspace; ${APPLY}`,
      )
    case 'escape':
      return refusal(
        kind,
        raw,
        at,
        detail,
        `[boundary: path is outside the workspace]  ${raw} — ${detail}. Use read inside the workspace; ${APPLY}`,
      )
    case 'through-symlink':
      return refusal(
        kind,
        raw,
        at,
        detail,
        `[boundary: path crosses a symlink]  ${raw} — ${at} is a symlink, and paths in the view do not follow symlinks.` +
          ' To look at what it points to, bring that thing into the workspace first (the merge in § 8.14).',
      )
    case 'not-a-path':
      return refusal(
        kind,
        raw,
        at,
        detail,
        `[boundary: not a path inside the view]  ${raw} — ${detail}.` +
          ' Paths inside the view are /-separated: no empty segment, no . segment, no backslash.',
      )
  }
}

/**
 * 一条原始路径 → 视图内的路径，或者一条带指路的拒绝。
 *
 * **它是唯一入口这件事在读法上要落准**：凡是要把"一串输入"变成"视图里的一个位置"的地方
 * 都走这里，包括文件工具 · 发现工具 · 执行的 `cwd`。物理落点由 `Roots.to*` 拼——那三个
 * 函数只接受已经解析过的 `RelPath`，所以"没解析过就拼物理路径"这条错路在类型上就走不通。
 */
export function resolveVirtual(
  realRoot: AbsPath,
  raw: string,
  cwd: RelPath,
): Result<RelPath, Denied> {
  // **`cwd` 先按同一个解析器过一遍**：它可能是模型给的那一串原文（`bash` 的参数里就是），
  // 而这一层是"一串输入 → 视图里一个位置"的唯一入口——`./a` 与 `b/../c` 在这里被消掉，
  // 而不是在下面每一处各消一次。空串与 `.` 都读成根（与 `resolveRaw` 同一条规矩）。
  const base = resolveRaw(cwd, '')
  if (!base.ok) return { ok: false, error: deny(base.kind, cwd, cwd, base.detail) }
  const parsed = resolveRaw(raw, base.rel)
  if (!parsed.ok) return { ok: false, error: deny(parsed.kind, raw, raw, parsed.detail) }
  const rel = parsed.rel
  const segs = rel === '' ? [] : rel.split('/')
  for (let i = 1; i < segs.length; i++) {
    const prefix = segs.slice(0, i).join('/')
    let isLink: boolean
    try {
      isLink = lstatSync(toPhysical(realRoot, prefix)).isSymbolicLink()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // 这一段在真实树上还不存在（或它下面是文件、走不过去）——底下没有软链可穿，放行。
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, value: rel }
      // 看不出来是什么就不放行：这一关是"可达集相等"的凭据，凭据不齐时不发。
      return { ok: false, error: deny('not-a-path', raw, prefix, `lstat failed (${code ?? 'unknown'})`) }
    }
    if (isLink) {
      return {
        ok: false,
        error: deny('through-symlink', raw, prefix, `${prefix} is a symlink`),
      }
    }
  }
  return { ok: true, value: rel }
}
