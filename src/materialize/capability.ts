// 档位怎么定：探平台事实、把它们落进工作区配置、按事实与声明选一档。
//
// 出处：架构 § 8.5 的 fork 策略表与那句"**探针 + 缓存，非 if-else 链**"——
// "某一档探下来不可用，就退到下一档并如实报出用了哪一档，不静默换档。探测报出的事实……
// 按平台事实落进工作区配置（§ 15.7 · § 15.3.a），`fork` 读它选档"。
//
// 三件事住在这里，因为它们共用同一个问题："这一档现在能不能用"：
//
//   一 · **探针**（`probePlatform`）：读环境、返回一份报告。**纯的**——不改状态、不写日志
//        （§ 15.7）。它真挂一次再卸掉：能不能挂这件事只有挂一次才知道，读 `/proc/filesystems`
//        只能说明内核编了这个文件系统，说明不了这一门命名空间里挂不挂得动。
//   二 · **缓存**：事实落进 `<realRoot>/.fugue/config` 的 `platform` 键（§ 15.3.a 说平台事实
//        按寿命分给系统级，而"落地只有一级，先落工作区级那一份"）。
//   三 · **选档**（`chooseStrategy`）：沿 `overlayfs → hardlink-ro → copy` 取第一档可用的，
//       并把**跳过了哪几档、各为什么**一起报出来。`preferredStrategy` 是**偏好**不是命令——
//       字段名就是这么写的：先试它，不可用照样沿表退，只是退的时候要如实说清。
//
// **只缓存肯定的事实。** 探到挂得动就记住；探到挂不动不记——因为"挂不动"常常只是这一门
// mount namespace 的事（会话换一门、装上了 sudo、进了 userns），把它记下来就把一次性的
// 失败变成永久降级。代价是降级档每次多一次失败的挂载尝试，那是常数，不是判断。
import { linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readConfig, setConfig, writeConfig } from '../config.ts'
import { probeHost } from '../roots/host.ts'
import type { AbsPath, ForkStrategy, RelPath } from '../terms.ts'
import type { MaterializeOptions } from './contract.ts'
import { MountError, mountOverlay, removeTree, sudoAvailable, unmountOverlay } from './mount.ts'
import type { MountMode, OverlaySpec } from './mount.ts'

/** 这份报告就是"这台机器现在允许哪几档"。它进配置，也进 `fugue fork` 的 `--json`。 */
export interface PlatformFacts {
  /** `realRoot` 落在哪个文件系统上（§ 15.7 的 E1 表给的编号）。 */
  readonly fs: string
  /** overlayfs 用哪一门挂得上；`null` = 现在挂不动。 */
  readonly overlayfs: MountMode | null
  /** 挂得动 / 挂不动的一句话由头——给人看的，也是退档时要报出来的那一句。 */
  readonly overlayfsNote: string
  /** 硬链接在这个文件系统上可用吗（§ 8.5 硬链接纪律的物理前提：源与落点同盘）。 */
  readonly hardlink: boolean
}

/** 退档的次序（§ 8.5 的策略表）。`reflink` 不在里面：本平台不存在（§ 15.7）。 */
export const LADDER: readonly ForkStrategy[] = ['overlayfs', 'hardlink-ro', 'copy']

/** 配置里存平台事实的那个键。 */
export const FACTS_KEY = 'platform'

/** 挂一次试试，试完卸掉——**探针的全部**。 */
function probeOverlay(scratch: AbsPath): { mode: MountMode | null; note: string } {
  const base = join(scratch, 'overlay')
  const spec: OverlaySpec = {
    lower: join(base, 'lower'),
    upper: join(base, 'upper'),
    work: join(base, 'work'),
    merged: join(base, 'merged'),
  }
  for (const d of [spec.lower, spec.upper, spec.work, spec.merged]) mkdirSync(d, { recursive: true })
  let mounted: MountMode | null = null
  try {
    try {
      mountOverlay(spec, 'direct')
      mounted = 'direct'
    } catch (direct) {
      const why = direct instanceof MountError ? direct.stderr : String(direct)
      if (!sudoAvailable()) return { mode: null, note: `当前命名空间里挂不动（${why}），sudo -n 也不通` }
      try {
        mountOverlay(spec, 'sudo')
        mounted = 'sudo'
      } catch (viaSudo) {
        const why2 = viaSudo instanceof MountError ? viaSudo.stderr : String(viaSudo)
        return { mode: null, note: `直接挂不动（${why}），借 sudo 也挂不动（${why2}）` }
      }
    }
    return {
      mode: mounted,
      note:
        mounted === 'direct'
          ? '当前命名空间里有 CAP_SYS_ADMIN（root，或整个会话在一个非特权 userns 里）'
          : '借 sudo -n 挂在当前命名空间里',
    }
  } finally {
    if (mounted !== null) unmountOverlay(spec.merged)
    removeTree(base)
  }
}

/** 同一个文件系统上链得动吗。**真链一次**：`statfs` 的编号答不了这个问题（反向 9p 报的和本地一样是 9p）。 */
function probeHardlink(scratch: AbsPath): boolean {
  const dir = join(scratch, 'hardlink')
  mkdirSync(dir, { recursive: true })
  const a = join(dir, 'a')
  const b = join(dir, 'b')
  try {
    writeFileSync(a, 'x\n')
    linkSync(a, b)
    return statSync(a).ino === statSync(b).ino
  } catch {
    return false
  } finally {
    for (const p of [a, b]) {
      try {
        unlinkSync(p)
      } catch {
        // 没建成就没得删
      }
    }
    removeTree(dir)
  }
}

/**
 * 探一份平台事实。**纯函数**：改动只落在 `scratch` 里，用完即删，不留痕、不写日志。
 * `scratch` 由调用点给（物化自己的 `tmp`），因为 § 8.4 的纪律 12 要求派生也不落在工作区之外。
 */
export function probePlatform(realRoot: AbsPath, scratch: AbsPath): PlatformFacts {
  mkdirSync(scratch, { recursive: true })
  try {
    const host = probeHost(realRoot)
    const overlay = probeOverlay(scratch)
    return {
      fs: host === null ? '探不到' : host.fs,
      overlayfs: overlay.mode,
      overlayfsNote: overlay.note,
      hardlink: probeHardlink(scratch),
    }
  } finally {
    removeTree(scratch)
  }
}

/** 缓存里那份事实。**形状不对就当没有**：它是派生的加速项，不是要拒绝加载的声明。 */
export async function loadFacts(root: string): Promise<PlatformFacts | null> {
  const doc = await readConfig(root)
  const v = doc[FACTS_KEY]
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const mode = o['overlayfs']
  if (mode !== null && mode !== 'direct' && mode !== 'sudo') return null
  if (typeof o['fs'] !== 'string') return null
  if (typeof o['overlayfsNote'] !== 'string') return null
  if (typeof o['hardlink'] !== 'boolean') return null
  return { fs: o['fs'], overlayfs: mode, overlayfsNote: o['overlayfsNote'], hardlink: o['hardlink'] }
}

/** 把事实落进工作区配置（§ 8.5 的"探针 + 缓存"）。**不碰别的键**。 */
export async function saveFacts(root: string, facts: PlatformFacts): Promise<void> {
  const doc = await readConfig(root)
  setConfig(doc, FACTS_KEY, { ...facts })
  await writeConfig(root, doc)
}

/**
 * 要选档时拿到的那份事实：先读缓存，缓存里没有**肯定**的答案就探一次并写回去。
 * `refresh` 供"缓存说挂得动、真挂却失败了"那一步用——那时缓存是错的，重探。
 */
export async function ensureFacts(
  root: string,
  realRoot: AbsPath,
  scratch: AbsPath,
  refresh = false,
): Promise<PlatformFacts> {
  if (!refresh) {
    const cached = await loadFacts(root)
    if (cached !== null && cached.overlayfs !== null) return cached
  }
  const facts = probePlatform(realRoot, scratch)
  await saveFacts(root, facts)
  return facts
}

export interface Choice {
  readonly strategy: ForkStrategy
  readonly mount: MountMode | null
  /** 为什么是它——退档时把跳过的几档也写进来，这一句就是要报给人看的那一句。 */
  readonly why: string
}

export type Chosen = { readonly ok: true; readonly choice: Choice } | { readonly ok: false; readonly why: string }

type Availability = { readonly ok: true; readonly mount: MountMode | null; readonly why: string } | { readonly ok: false; readonly why: string }

/** 单看一档：现在能不能用，为什么。**每一句 why 都要说得出出处**，因为退档时要原样报出去。 */
function available(facts: PlatformFacts, opt: MaterializeOptions, s: ForkStrategy): Availability {
  if (s === 'overlayfs') {
    if (facts.overlayfs === null) return { ok: false, why: `overlayfs 挂不动（${facts.overlayfsNote}）` }
    return {
      ok: true,
      mount: facts.overlayfs,
      why: 'overlayfs 挂得上——fork 与仓库规模无关，upper 恰好是本次的全部改动（§ 8.5）',
    }
  }
  if (s === 'hardlink-ro') {
    const ro = opt.readOnlyPaths ?? []
    if (!facts.hardlink) return { ok: false, why: `硬链接铺不动（落点 ${facts.fs} 上链不起来）` }
    if (ro.length === 0) {
      return {
        ok: false,
        why: '没有声明只读子树——硬链接会被就地写穿透到真实工作树，全树用硬链接必须被拒（§ 8.5 硬链接纪律）',
      }
    }
    return { ok: true, mount: null, why: `只链声明过的 ${ro.length} 处只读子树（${ro.join(' · ')}），其余照抄` }
  }
  if (s === 'copy') {
    return { ok: true, mount: null, why: '处处可用（§ 8.5 的策略表）；代价是 N × 全树' }
  }
  return { ok: false, why: 'reflink 需要 XFS / Btrfs / APFS，本平台不存在（§ 15.7）' }
}

/**
 * 选一档。**唯一的规则**：按次序取第一档可用的，把"跳过了谁、为什么"与"选中了谁、为什么"
 * 合成一句话——那一句就是"如实报出用了哪一档"。
 *
 * `preferredStrategy` 先试，试不成照样往下退（§ 8.5：退到下一档并如实报出，不静默换档）。
 * **它不是"必须这一档"**：字段名是 `preferred`，而 § 8.5 的策略表本来就是一张"不行就退"的
 * 表——把偏好读成命令，等于给一条表外的规矩，也让一部分档在那台机器上永远无路可走。
 *
 * 次序里没有 `reflink`：它需要 XFS / Btrfs / APFS，本平台不存在（§ 15.7）。偏好要它的时候
 * 它照样被摆到第一位试一次，然后以"跳过 reflink：……"的形式出现在那句 why 里。
 */
export function chooseStrategy(facts: PlatformFacts, opt: MaterializeOptions): Chosen {
  const want = opt.preferredStrategy
  const order: readonly ForkStrategy[] =
    want === undefined ? LADDER : [want, ...LADDER.filter((s) => s !== want)]
  const skipped: string[] = []
  for (const s of order) {
    const a = available(facts, opt, s)
    if (a.ok) {
      return { ok: true, choice: { strategy: s, mount: a.mount, why: [...skipped, `${s} 档：${a.why}`].join('；') } }
    }
    skipped.push(`跳过 ${s}：${a.why}`)
  }
  return { ok: false, why: `一档都不成立：${skipped.join('；')}` }
}
