// 地址身份：旧标题 → 新标题（交接单 § 2.1 末段）。
//
// **只认同一性，不认人维护的映射表**：同一个 id、折掉分隔符的 id、同一个版本号、同一段文字、
// 前缀包含、相似度、上一批的对照链——七档按顺序试，第一档命中就停。
// 合并的那一节（“0.3.4 到 0.3.1”）与通配族（“0.2.x”）各有一条规则，写在这里，不在编排里。
//
// 这一份不知道清单、页面、渲染：输入是“上一批的地址”与“这一版的标题”，输出是“旧地址去哪”。

export interface Headed {
  readonly id: string
  readonly text: string
}

/** 上一批里参与地址判定的那一份：只要有标题、别名与被删地址。 */
export interface PriorPage {
  readonly id: string
  readonly headings: readonly Headed[]
  readonly anchors?: Record<string, string>
  readonly dropped?: readonly string[]
}

export interface PriorAddresses {
  readonly pages: readonly PriorPage[]
}

/** 两个标题的相似度（汉字按二字组，英文按词）：改名那一类题目的最后一档兜底。 */
export function similarity(a: string, b: string): number {
  const norm = (s: string): string[] => {
    const clean = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const words = clean.split(' ').filter(Boolean)
    const grams: string[] = []
    for (const w of words) {
      if (w.length <= 2) grams.push(w)
      else for (let i = 0; i < w.length - 1; i++) grams.push(w.slice(i, i + 2))
    }
    return grams
  }
  const A = norm(a)
  const B = norm(b)
  if (A.length === 0 || B.length === 0) return 0
  const count = new Map<string, number>()
  for (const g of A) count.set(g, (count.get(g) ?? 0) + 1)
  let hit = 0
  for (const g of B) {
    const n = count.get(g) ?? 0
    if (n > 0) {
      hit += 1
      count.set(g, n - 1)
    }
  }
  return (2 * hit) / (A.length + B.length)
}

/** 地址身份键：折掉分隔符与大小写。`v1-2-3` · `v1.2.3` · `v123` 是同一个键。 */
export function identityKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 版本号键：`v1-2-3` · `1.2.3` · `v123` 都折成 `v123`。不是版本号就是 `null`。 */
export function versionKeyOfId(id: string): string | null {
  const t = id.trim().toLowerCase().replace(/^v/, '')
  const m = /^(\d+)[.\-_ ]?(\d+)[.\-_ ]?(\d+)$/.exec(t)
  if (m === null) return null
  return `v${m[1]}${m[2]}${m[3]}`
}

export function versionKeyOfText(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m === null ? null : `v${m[1]}${m[2]}${m[3]}`
}

/** 一段标题文字里提到的**所有**版本号（“0.3.4 到 0.3.1”是两个）：合并的那一节靠它接旧地址。 */
export function versionKeysOfText(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(\d+)\.(\d+)\.(\d+)/g)) out.push(`v${m[1]}${m[2]}${m[3]}`)
  return out
}

/** 标题里写成通配的那一族（“0.2.x”）：它接过这一族里任何一个具体版本号的旧地址。 */
export function versionFamilyOfText(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(?:x|\*)/i.exec(text)
  return m === null ? null : `${m[1]}.${m[2]}.`
}

/** 一个 id 的版本族（“v0-2-1” → `0.2.`）；不是版本号就是 `null`。 */
export function versionFamilyOfId(id: string): string | null {
  const m = /^v?(\d+)[.\-_]?(\d+)[.\-_]?(\d+)$/.exec(id.trim().toLowerCase())
  return m === null ? null : `${m[1]}.${m[2]}.`
}

export interface AliasPlan {
  readonly aliases: Record<string, string[]>
  readonly anchors: Record<string, string>
  readonly dropped: string[]
}

/**
 * 旧标题 → 新标题：**同一主题换了标题**时，旧深链接仍到达内容（交接单 § 2.1 末段）。
 *
 * 身份按**同一性**判，而不只按字面相似度：
 *   一 · 同一个 id · 分隔符折掉之后同一个 id（`v0-5-2` = `v052`）· 同一个版本号
 *   二 · 标题文字的同一性（折掉标点与大小写）· 前缀包含（"1.2.3" ⊂ "1.2.3 —— …"）
 *   三 · 相似度（≥ 0.75 且明显高于第二名）：真题里"安装 Fugue → 装好 Fugue"走这一档
 *   四 · 上一批的对照链（A→B，这一版 B→C）：**沿线跟到终点**，三版之后 A 仍到 C
 *
 * **继承不等于照旧**：如果旧 id 与它继承到的目标各带一个版本号而两者不同，那条继承是错的
 * （真题：`v0-5-1` 被接到 `0.1.0` 那一节），按旧 id 自己的身份重新找。
 */
export function aliasPlan(
  prev: PriorAddresses | null,
  fresh: ReadonlyMap<string, readonly Headed[]>,
  revive?: ReadonlyMap<string, readonly string[]>,
): Map<string, AliasPlan> {
  const out = new Map<string, AliasPlan>()
  const SIM = 0.75
  for (const [pageId, headings] of fresh) {
    const ids = new Set(headings.map((h) => h.id))
    const byIdentity = new Map<string, string>()
    const byVersion = new Map<string, string>()
    for (const h of headings) {
      const ik = identityKey(h.id)
      if (ik !== '' && !byIdentity.has(ik)) byIdentity.set(ik, h.id)
      const vk = versionKeyOfId(h.id) ?? versionKeyOfText(h.text)
      if (vk !== null && !byVersion.has(vk)) byVersion.set(vk, h.id)
    }
    const prior = prev?.pages.find((p) => p.id === pageId)
    /** 旧 id（可带旧标题文字）→ 这一版里它的去向；`null` = 找不到。 */
    const direct = new Map<string, string | null>()
    const tryDirect = (oldId: string, oldText: string | null): string | null => {
      if (ids.has(oldId)) return oldId
      const ik = identityKey(oldId)
      if (ik !== '' && byIdentity.has(ik)) return byIdentity.get(ik)!
      const vk = versionKeyOfId(oldId) ?? (oldText === null ? null : versionKeyOfText(oldText))
      if (vk !== null && byVersion.has(vk)) return byVersion.get(vk)!
      // **合并那一节**：“0.3.4 到 0.3.1” 这一节同时接过两个版本号的旧地址。
      if (vk !== null) {
        const mentioned = headings.filter((h) => versionKeysOfText(h.text).includes(vk))
        if (mentioned.length === 1) return mentioned[0]!.id
      }
      // 通配的一族（“0.2.x”）接过族里任何一个具体版本号。
      const family = versionFamilyOfId(oldId)
      if (family !== null) {
        const same = headings.filter((h) => versionFamilyOfText(h.text) === family)
        if (same.length === 1) return same[0]!.id
      }
      if (oldText === null) return null
      const tk = identityKey(oldText)
      if (tk !== '') {
        const same = headings.find((h) => identityKey(h.text) === tk)
        if (same !== undefined) return same.id
        const inside = headings.filter((h) => {
          const hk = identityKey(h.text)
          return hk.length >= 3 && (hk.includes(tk) || tk.includes(hk))
        })
        if (inside.length === 1) return inside[0]!.id
      }
      let best: Headed | null = null
      let bestScore = 0
      let second = 0
      for (const h of headings) {
        if (direct.get(h.id) === oldId) continue
        const s = similarity(oldText, h.text)
        if (s > bestScore + 1e-9) {
          second = bestScore
          bestScore = s
          best = h
        } else if (s > second) second = s
      }
      if (best !== null && bestScore >= SIM && bestScore - second >= 0.15) return best.id
      return null
    }

    if (prior !== undefined) {
      for (const h of prior.headings) direct.set(h.id, tryDirect(h.id, h.text))
      // 上一批的别名链：**沿线跟到终点**（A→B 之后 B→C，A 也要到 C）。
      for (const [old, target] of Object.entries(prior.anchors ?? {})) {
        let cur = target
        const seen = new Set<string>()
        let landed: string | null = null
        while (!seen.has(cur)) {
          seen.add(cur)
          if (direct.has(cur)) {
            landed = direct.get(cur) ?? null
            break
          }
          if (ids.has(cur)) {
            landed = cur
            break
          }
          const next = prior.anchors?.[cur]
          if (next === undefined) break
          cur = next
        }
        // 版本号不同的"继承"是错的：按旧 id 自己的身份重找。
        const ov = versionKeyOfId(old)
        const tv = landed === null ? null : versionKeyOfId(landed)
        if (landed !== null && ov !== null && tv !== null && ov !== tv) landed = null
        const own = tryDirect(old, null)
        direct.set(old, own ?? landed)
      }
      // **上一批判过“没有后继”的旧地址**（`pages[].dropped` + 迁移时从旧记录取回来的那几条）：
      // 一个地址被删过一次，不等于永远不能复活——这一版里出现了与它同一身份的标题，就该重新接上。
      for (const old of [...(prior.dropped ?? []), ...(revive?.get(pageId) ?? [])]) {
        if (direct.has(old) || ids.has(old)) continue
        const own = tryDirect(old, null)
        if (own !== null) direct.set(old, own)
      }
    }

    const anchors: Record<string, string> = {}
    const aliases: Record<string, string[]> = {}
    for (const [old, target] of direct) {
      if (target === null || target === old || ids.has(old)) continue
      anchors[old] = target
      const list = aliases[target] ?? []
      if (!list.includes(old)) list.push(old)
      aliases[target] = list
    }
    const priorIds = new Set<string>()
    if (prior !== undefined) {
      for (const h of prior.headings) priorIds.add(h.id)
      for (const old of Object.keys(prior.anchors ?? {})) priorIds.add(old)
      for (const old of prior.dropped ?? []) priorIds.add(old)
    }
    for (const old of revive?.get(pageId) ?? []) priorIds.add(old)
    const dropped = [...priorIds].filter((old) => !ids.has(old) && anchors[old] === undefined)
    out.set(pageId, { aliases, anchors, dropped })
  }
  return out
}

