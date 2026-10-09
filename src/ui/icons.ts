// 图标那一档（第二幕 ⑨ 的前一半）：**专有字体的字形只由配置开关点名**——字体在不在场探测不了
// （终端不回这个话），所以这一档与字形档同一个姿势：两档都备 · 缺省关 · 关着与"根本没有这一档"
// 逐字节相同。ASCII 那一档是它的同义退化（`R` `>` `x`）：断了专有字体也读得下去。
//
// 表里三个概念，就是主面那几行真用得着的三个：轮次头 · 在飞的格 · 停下来的格。要加概念就往这张表
// 里添一行——表一处（这一份），站点一处（`ui/frame.ts` 的 `iconPrefixOf`）。
//
// **`nerd` 那几个码位**取 FontAwesome 那一段（`\uf024` 旗 · `\uf04b` 播放 · `\uf04d` 方块）：那是
// Nerd Fonts 那一份字体里最稳的一段（v2 与 v3 都在）。它们落在私有区（`Co`），汉字那一类量宽的
// 规则管不到，所以一颗图标算一列——`widthOf` 量出来是一列，列位不会走岔。
//
// **刻度是"一列 + 一个空格"**（见 `iconPrefixOf`），所以开与不开差的是两列，行宽与折行点由
// `frameOf` 那一层照样算（框宽恒等于终端列数这一点不受影响）。
export const ICON_TIERS = ['off', 'ascii', 'nerd'] as const

/** 哪一档。 */
export type IconTier = (typeof ICON_TIERS)[number]

/** 缺省那一档：**关**（增强档不许改变缺省的字节流）。 */
export const DEFAULT_ICON_TIER: IconTier = 'off'

/** 表里那几个概念（站点只能点这几个名字）。 */
export type IconName = 'round' | 'moving' | 'halted'

/** 一个概念那两格（ASCII 与 `nerd`），外加"它是什么意思"（追溯用，与词表那一列同一个用处）。 */
export interface IconSet {
  /** ASCII 那一格。**一个字符**（列位好算）。 */
  readonly ascii: string
  /** `nerd` 那一格：私有区里那一个码位。 */
  readonly nerd: string
  /** 这一颗图标是什么意思。 */
  readonly arch: string
}

export const ICONS: Readonly<Record<IconName, IconSet>> = {
  round: { ascii: 'R', nerd: '\uf024', arch: '轮次（`round/state` 那一链的头一行）' },
  moving: { ascii: '>', nerd: '\uf04b', arch: '在飞的格（`agents[].stopped === null`）' },
  halted: { ascii: 'x', nerd: '\uf04d', arch: '停下来的格（`agent/stop` 到了）' },
}

/** 表里那几个名字（**从表推**，与 `ui/views.ts` 的 `VIEW_KEYS` 同一手）。 */
export const ICON_NAMES: readonly IconName[] = Object.keys(ICONS) as IconName[]

/**
 * **当前这一档**。它是一份**进程级的显示设置**（与 `ui/glyph.ts` 那一档同一条道理）：这一次运行里
 * 档不会变，而每一帧都要问它一次——把它当参数一路递下去要穿过四五个模块。产品路径只调一次
 * （`ui/console.ts` 按开关定档）；断言里各档各设一次、用完还原。
 */
let CURRENT: IconTier = DEFAULT_ICON_TIER

/** 定档，把上一档还回去（断言里拿它还原）。 */
export function setIconTier(tier: IconTier): IconTier {
  const was = CURRENT
  CURRENT = tier
  return was
}

/** 当前那一档。 */
export function iconTier(): IconTier {
  return CURRENT
}

/**
 * 一颗图标。**档关着给空串**（不是空格——那两列一个字节都不占，"关着"于是与"根本没有这一档"
 * 逐字节相同）。名字认不出来也给空串（它到不了：名字是 `IconName` 那个联合里的一员）。
 */
export function iconOf(name: IconName): string {
  if (CURRENT === 'off') return ''
  const set = ICONS[name]
  if (set === undefined) return ''
  return CURRENT === 'nerd' ? set.nerd : set.ascii
}
