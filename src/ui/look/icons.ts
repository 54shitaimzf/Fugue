// 外观草稿（**素材，未接线**）· 小图标：两套字形，一张表。
//
// 出处：ROADMAP § 5 的 0.4.3 行 ⑤「小图标取 Nerd Font 一类专有字体的字形（字体在场与否探测不了：
// 配置开关 + 同义 ASCII 退化，两档都备）」。
//
// **两档同形**是这张表唯一的硬约束：同一个图标的两套字形**列宽相同**（都是一列，后面跟一个空格
// ——Nerd Font 非 Mono 变体的字形会溢进右边那一格，空格就是给它溢的）。于是开关开与关，变的只有
// 那几格的字，一行的宽 · 折行点 · 行数一个不变：开关关着的输出与「没有图标这一档」逐字节同形，
// 开着的输出把图标换回 ASCII 也逐字节相同（`look.test.ts` ⑤）。
//
// **ASCII 那一套是地板，所以它要自己说得清**：颜色在黑白档里没有，图标在 ASCII 档里只剩一个
// 字符——`+` 过 · `x` 没过 · `*` 在跑 · `?` 等你 · `!` 被挡，人不看颜色也读得出来。
//
// Nerd Font 的码位全取 BMP 私用区里 v2 与 v3 都没挪过的那几格（Font Awesome `F0xx`–`F2xx` ·
// Octicons 的两格 git 字形）；v3 挪到 `F0001` 以后的 Material 那一族不用——装 v2 的人会看到豆腐块。
import type { Span } from './paint.ts'
import type { Slot } from './palette.ts'
import type { IconTier } from './tier.ts'

/** 一个图标：两套字形 + 它落在哪一格色位 + 它说的是什么。 */
export interface Icon {
  readonly nerd: string
  readonly ascii: string
  readonly slot: Slot
  readonly says: string
}

/**
 * 那一张表。**状态五个**（色位跟着状态走：成功 · 拒绝/错误 · 等待/运行中）**+ 物件七个**（弱化：
 * 它们是标签，不是读数）。
 */
export const ICONS = {
  ok: { nerd: '', ascii: '+', slot: 'ok', says: '过了 · 成了 · 停在收敛上' },
  fail: { nerd: '', ascii: 'x', slot: 'bad', says: '没过 · 错了 · 中止' },
  deny: { nerd: '', ascii: '!', slot: 'bad', says: '边界拦下' },
  run: { nerd: '', ascii: '*', slot: 'wait', says: '在跑' },
  gate: { nerd: '', ascii: '?', slot: 'wait', says: '门口等你点头' },
  queue: { nerd: '', ascii: '=', slot: 'wait', says: '排着队' },
  line: { nerd: '', ascii: '#', slot: 'muted', says: '主线（持轮者那一份账）' },
  agent: { nerd: '', ascii: '@', slot: 'muted', says: '一格 agent' },
  contract: { nerd: '', ascii: '&', slot: 'muted', says: '契约' },
  merge: { nerd: '', ascii: 'Y', slot: 'muted', says: '合并' },
  file: { nerd: '', ascii: '-', slot: 'muted', says: '文件' },
  dir: { nerd: '', ascii: '/', slot: 'muted', says: '目录' },
  image: { nerd: '', ascii: '%', slot: 'muted', says: '图片' },
} as const satisfies Readonly<Record<string, Icon>>

export type IconName = keyof typeof ICONS

/** 一个图标那一片（字形按档取，色位按表取）。 */
export function iconOf(name: IconName, tier: IconTier): Span {
  const i: Icon = ICONS[name]
  return { text: tier === 'nerd' ? i.nerd : i.ascii, slot: i.slot }
}
