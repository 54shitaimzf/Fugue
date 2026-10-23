// 视觉语言：**项目级可插拔的那一层**（交接单 § 2.2 · 架构 § 9.9）。
//
// 一份主题 = 一组按用途命名的视觉变量 + 少量结构规则 + 一段写给模型的组织指导。
// 三者一起才是"一套视觉语言"，缺一样就退回"换颜色"：
//
//   · `css`      —— 呈现（字体 · 色彩 · 间距 · 版式 · 组件外观）。条目在 `[data-doc-theme]` 上，
//                   公共交互的 CSS 只认变量，所以整套换掉时操作含义一个字节都不动。
//   · `guidance` —— 写作（这套规范的层级与组织空间）。它进**A 区**：同一主题下所有页面逐字节
//                   相同，缓存命中，而模型据此在规范内自由组织。
//   · `sources`  —— 依据（官方原则的直链）。参考来源与本项目适配分开标：`basis` 是出处，
//                   这一段是"本项目怎么用它"。
//
// **依赖为零。** 字体只用系统栈，图形用字符与 CSS 画，离线双击可读（交接单 § 2.2 末段）。
//
// **主题的校验在 `config.ts` 那一处**：配置里写了一个没有的主题名，当场拒并列出有哪几套。
// 这一份只提供"有哪几套"的答案，不读配置、不认识工作区。
import { carbonTheme } from './themes/carbon.ts'
import { govukTheme } from './themes/govuk.ts'
import { material3Theme } from './themes/material3.ts'
import { primerTheme } from './themes/primer.ts'

/** 一套视觉语言包（skill 的代码形态）：呈现 · 指导 · 依据。 */
export interface ThemeSpec {
  /** 配置里写的那个名字（稳定标识，换主题不改内容）。 */
  readonly id: string
  /** 人读的名字。 */
  readonly name: string
  /** 这套规范出自哪儿（一句话）。 */
  readonly basis: string
  /** 官方依据的直链（"参考来源"那一半）。 */
  readonly sources: readonly string[]
  /**
   * 写进 A 区的组织指导：层级怎么用、哪些表达适合这类读者、退化档怎么读。
   * **它不许重新定义按钮 · 链接 · 键盘的操作含义**（交接单 § 2.2）——那是公共层的事。
   */
  readonly guidance: string
  /** 覆盖视觉变量与少量结构规则的那一段 CSS。 */
  readonly css: string
  /**
   * 这一份主题的"版本"：改了 `css` 或 `guidance` 就加一。
   *
   * 它进状态指纹——主题改过而正文没变，产物仍然过期（交接单 § 1.2 的"定义（含主题）"）。
   */
  readonly version: number
}

/** 随交付的四套。**至少三套**（交接单 § 2.2 末段），这里四套材料都给了成品。 */
const THEMES: Readonly<Record<string, ThemeSpec>> = {
  [primerTheme.id]: primerTheme,
  [carbonTheme.id]: carbonTheme,
  [material3Theme.id]: material3Theme,
  [govukTheme.id]: govukTheme,
}

/** 目录次序（`fugue docs status` 与报错话里列它，按这个次序）。 */
export const THEME_IDS: readonly string[] = [primerTheme.id, carbonTheme.id, material3Theme.id, govukTheme.id]

/** 取一套。**没有就是 `null`**——拼一个缺省主题会把"写错名字"静默成"用了另一套"。 */
export function themeOf(id: string): ThemeSpec | null {
  return Object.hasOwn(THEMES, id) ? (THEMES[id] ?? null) : null
}

/** 缺省主题：材料最齐、中文长文适配最细的那一套。 */
export const DEFAULT_THEME = primerTheme.id
