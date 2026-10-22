// 写作输入：**模型在生成时看得见的东西**（交接单 § 1.2 的"写作上下文"· § 2.5）。
//
// 三区与三段一一对应，**区的分界是装配的结论**：
//
//   · **A 区 = 这一批的公共事实**（提交 C 的版本、文件数、顶层目录与完整树索引）。它对这一批的
//     **所有调用逐字节相同**——取证两趟与写作那一趟发的是同一份字节，缓存前缀就落在这里。
//     它原先住在 B 区，于是每页每趟各贴一遍索引（约 19k 字符），一趟都命中不了。
//   · **B 区 = 这一趟的合同 + 这一页的材料**：写作那一趟是写作合同 + 视觉语言 + 定义 + 同批 +
//     来源 + 摘录 + 本轮变化；取证两趟各是取证合同 + 这一页（与来源 / 摘录预览）。
//   · **C 区 = 这一次要它做的事**（那一句话）。
//
// **取证是两趟**：第一趟只要一份"要读哪几份文件"的清单；第二趟只问"被截断的那几份要后面哪
// 几行"。写作那一趟拿到的摘录因此是"开头一段 + 补读的行段"，并且逐段标出行号范围——于是
// "关键实现藏在文件后半部"取得着，正文也能把结论指到 `path:行段`。
//
// **这一份是纯函数**：给同样的输入，出同样的字节。宿主的指纹与 `docs prompt` 都靠它。
import type { Excerpt } from './facts.ts'
import type { FileRange } from './contract.ts'
import type { TreeFacts } from './contract.ts'
import type { PageDef, DocsPlan, Materials } from './contract.ts'
import type { ThemeSpec } from './theme.ts'

/** 一份摘录的**开头一段**（字符）。它写进 B 区的那句说明里：模型要知道自己看到的是不是全文。 */
export const EXCERPT_LIMIT = 24_000

/** 一页所有摘录加起来的上界（字符）。**超了就不再多贴**：取证有预算，不是把仓库贴进来。 */
export const EXCERPT_BUDGET = 120_000

/** 一页最多点名几份文件（防"把整个仓库贴进来"）。 */
export const EVIDENCE_MAX = 12

/** 第二趟取证最多收几段补读（行段）。 */
export const RANGE_MAX = 8

/** 第二趟取证给模型看的开头预览（字符）：它得看见一点内容，才说得出要后面哪几行。 */
export const RANGE_PREVIEW = 3_000

/** 本轮会话进写作输入的上界（字符）：超了只贴最后这一段，并在材料说明里写清楚。 */
export const SESSION_LIMIT = 12_000

/**
 * 公共写作合同（B 区开头）。**它只在两个地方出现：这里与测试的期望值**——不抄进主题，
 * 也不抄进每一页的定义。
 *
 * 语法的每一行都由渲染器兑现（`markdown.ts`）：写了不认的语法会被转义成字面文本，而
 * 那正是"无法兑现的表达保留完整可读内容"的退化档。
 */
export const WRITING_CONTRACT = `你在给一个项目的文档写**一页正文**。读者是人，页面会被宿主渲染成可独立打开的 HTML。

只输出 markdown 正文：
- 不要写 H1（页标题由宿主按定义加上），章节从 ## 开始，需要更细的层次用 ###。
- 不要写页首、目录、上一页/下一页、页脚、版本号或提交号（宿主统一加，页脚带完整提交、来源与指纹）。
- 标题后可以带一个稳定 ID：## 标题 {#stable-id}。主题不变、标题以后可能会变的地方写上它，旧深链接靠它继续到达内容。
- 只输出正文本身：不要开场白、不要"以下是…"、不要代码围栏包住整页。

可用的块（每一块以单独一行 ::: 开始，以单独一行 ::: 结束）：
- ::: note 标题 / ::: tip 标题 / ::: warn 标题 / ::: danger 标题 —— 提醒、建议、注意、危险。正文里必须同时有文字说出这是什么。
- ::: details 里面是什么 —— 可展开的补充说明；主结论、前置条件与必要步骤不许藏在这里。
- ::: tabs 然后若干段 ::: tab 标签 —— 同一问题的几个选项，一次看一个；必须同时比较的内容改用表格。
  写法是一层套一层，每一层各自收尾，例如：
  ::: tabs
  ::: tab 甲
  甲的内容
  :::
  ::: tab 乙
  乙的内容
  :::
  :::
  （漏一层收尾也读得出来，但会少一层框，并记进待复核。）
- ::: steps 里面放有序列表 —— 连续操作，顺序可读。项与项之间可以有说明段与代码块。
- ::: figure 图注 —— 图解或示意；里面可以有段文字、ASCII 图或列表，图注说明它表达什么关系。

其他写法：
- 段落、无序列表（- ）、有序列表（1. ）、引用（> ）、表格（| 列 | 列 | 加一行 | --- | --- |）。
- 代码围栏用 \`\`\` 加语言名；命令原样写，不要加 $ 前缀，不要省略参数。
- 行内代码用反引号。链接：[文字](start.html#锚点) 指同批的另一页，[文字](#锚点) 指本页，外部链接写完整 http(s) 地址。
- 图片只写仓库相对路径（![说明](docs/fig.png)）；外部图片不贴，写成链接。
- 不要写 HTML 标签、脚本或样式：它们会被转义成字面文字，不会被执行。

内容要求：
- 事实取自下面的材料：本页来源、提交 C 的完整树事实、以及你点名要读的文件摘录。实现结论要能追到具体路径——写到具体文件、命令、参数或测试。
- **说"来源与实现有差异"时，指到据以判断的那一段原文**：写 \`路径:起行-止行\`（摘录的小标题给了每段的真实行号）。没有读到那一段就不要下这个结论，改写"这一版没读到对应的实现"。
- 本页来源可能落后于代码（旧参数已删、行为已变、边界已移）。以提交 C 的代码与测试为准纠正，并在正文里说明来源与实现差在哪。
- 材料不足时如实写出缺什么，不要补一个看起来合理的说法。
- 按这一页的 reader 与 role 组织：先解决读者的问题，再决定顺序、层次、例子、图解与交互；交互要有具体标签，且每个交互都应帮助读者找到、理解、比较或使用内容。
- 用中文写；术语沿用来源里的叫法；同一件事前后一个叫法。`

/** 取证第一趟的合同（B 区，另一套——每一趟各管一件事）。 */
export const EVIDENCE_CONTRACT = `你在为一页项目文档**选修辞**：列出你需要读到原文的仓库文件，宿主会把它们贴到下一步。

只输出一个 JSON 对象，形如 {"paths":["src/a.ts","test/a.test.ts"]}：
- 最多 ${EVIDENCE_MAX} 条，按重要性排序；路径必须照完整树索引里的写法逐字给，不要写目录、不要写通配符。
- 已经知道要看哪几行时，那一条写成 {"path":"src/a.ts","from":120,"to":260}（行号从 1 起）。
- 选那些能支撑这一页结论的文件：实现、接口、测试、配置、数据形状；来源文档本身不用再列。
- 只要写正文确实需要的；没有需要的就给空数组。不要在 JSON 之外写任何文字。`

/** 取证第二趟（只问被截断的那几份）。 */
export const EVIDENCE_RANGES_CONTRACT = `你在为一页项目文档**补读取证**：下面这几份文件太长，第一次只贴了开头。

只输出一个 JSON 对象，形如 {"ranges":[{"path":"src/a.ts","from":300,"to":420}]}：
- 最多 ${RANGE_MAX} 段，按重要性排序；行号从 1 起，必须落在该文件的总行数之内。
- 只点你写这一页确实要读的那几段；没有需要的就给 {"ranges":[]}。不要在 JSON 之外写任何文字。`

/** 取证两趟的 C 区。 */
export const EVIDENCE_TASK = '给出你要读的路径清单（只输出 JSON）。'
export const EVIDENCE_RANGES_TASK = '给出你要补读的行段（只输出 JSON）。'

/** 自由读每一轮最多几处点名。 */
export const LOOP_ASK = 6

/** 自由读第二轮到第 N 轮的合同（B 区）：**已经读到什么、还要读什么**。 */
export const EVIDENCE_AGAIN_CONTRACT = `你在为一页项目文档**继续取证**：下面是已经读到的文件与行段。

只输出一个 JSON 对象，形如 {"paths":["src/b.ts",{"path":"src/a.ts","from":900,"to":950}]}：
- 最多 ${LOOP_ASK} 条，按重要性排序；没读过的文件只写路径（字符串），读过的要后面的行段就写 {"path":…,"from":…,"to":…}（行号从 1 起）。
- 只要写正文确实需要的；读够了就给 {"paths":[]}。不要在 JSON 之外写任何文字。`

export const EVIDENCE_AGAIN_TASK = '给出下一批要读的路径或行段（只输出 JSON）；读够了就给空数组。'

/** 第三趟那一句话（C 区）。 */
export const CONTENT_TASK = `现在写这一页的正文。按上面的定义、来源、事实、摘录与本轮上下文组织内容，只输出 markdown 正文。`

/**
 * 一页正文的下界（字符）。**它不是质量线，是"这一页没写出来"的判据**：模型给一段空话或
 * 一个标题就收工，比报错更坏——读者拿到的是一页看起来成功的空页。质量由人按读者任务复核。
 */
export const CONTENT_MIN_CHARS = 400

/** 写作那一趟 B 区的开头：写作合同 + 这一套主题的视觉语言（换主题只动这一段）。 */
function writingContractOf(theme: ThemeSpec): string {
  return `${WRITING_CONTRACT}\n\n这一批文档的视觉语言（${theme.name}，出自 ${theme.basis}）：\n${theme.guidance}\n`
}

/** 定义那一块：每份文档都有、人维护的那六栏（交接单 § 2.3）。 */
function definitionBlock(page: PageDef): string {
  return [
    `文档 id：${page.id}`,
    `标题：${page.title}`,
    `来源：${page.source}`,
    `给谁看（audience）：${page.audience}`,
    `负责什么（role）：${page.role}`,
    `这一份的写法与重点（prompt）：${page.prompt}`,
  ].join('\n')
}

/** 同批的其它页（跨页引用要用它们的文件名）。 */
function siblingsBlock(plan: DocsPlan, page: PageDef): string {
  const others = plan.pages.filter((p) => p.id !== page.id)
  if (others.length === 0) return ''
  return ['同批文档（跨页链接写这些文件名）：', ...others.map((p) => `- ${p.out} · ${p.title}（给 ${p.audience}）`)].join('\n')
}

/**
 * A 区：这一批的公共事实。**只放所有调用都一样的字节**。
 *
 * 任何逐页的东西（id · 标题 · 来源）落进来，缓存前缀就散了——`prompt.test.ts` 的共享前缀
 * 那一条会红。索引与事实原先住在 B 区：7 页 × 2 趟各贴一遍，一次都命中不了。
 */
export function sharedOf(facts: TreeFacts): string {
  const dirs = facts.topDirs.map((d) => `${d.name}（${d.files}）`).join(' · ')
  return [
    '下面是这一批文档共用的提交事实与完整树索引；这一页要写的范围在后面的材料里。',
    `提交 C：${facts.commit}（短 ${facts.commitShort}）`,
    `版本：${facts.version ?? '（提交里没有可读的 package.json 版本号）'}`,
    `完整树文件数：${facts.files}`,
    `顶层目录（文件数）：${dirs === '' ? '（没有子目录）' : dirs}`,
    `完整树路径索引（共 ${facts.paths.length} 条）：`,
    facts.paths.join('\n'),
  ].join('\n')
}

/** 本轮变化那一块（自动收口才有真材料；手动重建如实说没有）。 */
function materialsBlock(m: Materials): string {
  const head = `写作上下文的来源：${m.note}`
  if (m.kind === 'manual') return head
  const lines = [head]
  if (m.round !== undefined) lines.push(`轮次：${m.round}`)
  if (m.contracts !== undefined && m.contracts.length > 0) {
    lines.push('这一轮归并的契约：')
    for (const c of m.contracts) {
      lines.push(`- ${c.id}（${c.agent} · ${c.commit}）${c.paths.length === 0 ? '' : `：${c.paths.join(' · ')}`}`)
    }
  }
  if (m.verify !== undefined) {
    lines.push(`验收：${m.verify.ok ? '通过' : '未通过'}（过 ${m.verify.passed} · 未过 ${m.verify.failed}）`)
  }
  if (m.session !== undefined) {
    lines.push('', `本轮会话（${m.session.path} · ${m.session.records} 条 · 共 ${m.session.chars} 字符；下面是进写作输入的那一段）：`)
    lines.push(m.session.text === '' ? '（这一轮没有会话记录）' : m.session.text)
  }
  return lines.join('\n')
}

/** 一段行印成 `第 12–40 行`。 */
function rangeText(r: FileRange): string {
  return r.from === r.to ? `第 ${r.from} 行` : `第 ${r.from}–${r.to} 行`
}

/** 写作那一趟的 B 区：合同与视觉语言 + 定义 + 同批 + 来源 + 摘录 + 本轮变化。 */
function writingPageOf(o: {
  readonly page: PageDef
  readonly plan: DocsPlan
  readonly theme: ThemeSpec
  readonly source: string
  readonly materials: Materials
  readonly excerpts: readonly Excerpt[]
  readonly evidenceMissing?: readonly string[]
}): string {
  const parts = [
    writingContractOf(o.theme),
    '',
    definitionBlock(o.page),
    '',
    siblingsBlock(o.plan, o.page),
    '',
    `本页来源 ${o.page.source} 的正文（原样，可能落后于代码）：`,
    '-----',
    o.source,
    '-----',
  ]
  if (o.excerpts.length > 0) {
    parts.push('', '你点名要读的文件（提交 C 里的原文；小标题给出贴出来的行段与总行数）：')
    for (const x of o.excerpts) {
      const shown = x.shown.map(rangeText).join(' · ')
      const tail = x.truncated ? `；还有内容没读（共 ${x.lines} 行）` : '；全文'
      parts.push(`\n### ${x.path}（${shown}${tail}）\n\`\`\`\n${x.text}\n\`\`\``)
    }
  }
  if (o.evidenceMissing !== undefined && o.evidenceMissing.length > 0) {
    parts.push('', `你点名但这些路径在提交里不存在（正文不要引用它们）：${o.evidenceMissing.join(' · ')}`)
  }
  parts.push('', materialsBlock(o.materials))
  return parts.join('\n')
}

/** 取证第一趟的 B 区：合同 + 定义 + 同批 + 来源（索引在 A 区）。 */
function evidencePageOf(o: { readonly page: PageDef; readonly plan: DocsPlan; readonly source: string }): string {
  return [
    EVIDENCE_CONTRACT,
    '',
    definitionBlock(o.page),
    '',
    siblingsBlock(o.plan, o.page),
    '',
    `本页来源 ${o.page.source} 的正文（原样，可能落后于代码）：`,
    '-----',
    o.source,
    '-----',
    '',
    `请给出最多 ${EVIDENCE_MAX} 条要读的路径（JSON）。`,
  ].join('\n')
}

/** 取证第二趟的 B 区：合同 + 被截断的那几份的路径、总行数与开头一小段。 */
function evidenceRangesPageOf(o: { readonly page: PageDef; readonly excerpts: readonly Excerpt[] }): string {
  const parts = [
    EVIDENCE_RANGES_CONTRACT,
    '',
    `这一页：${o.page.id}（${o.page.title} · 给 ${o.page.audience}）`,
    '',
    `下面这几份文件太长，第一次只贴了开头。请按行段点名你要补读的部分（行号从 1 起；每份总共多少行已给出）。`,
  ]
  for (const x of o.excerpts) {
    parts.push('', `### ${x.path}（共 ${x.lines} 行 · ${x.chars} 字符；下面只是开头）`, '```', x.text.slice(0, RANGE_PREVIEW), '```')
  }
  return parts.join('\n')
}

/** 自由读第二轮到第 N 轮的 B 区：定义 + 来源 + 已经读到的清单。 */
function againPageOf(o: {
  readonly page: PageDef
  readonly plan: DocsPlan
  readonly source: string
  readonly excerpts: readonly Excerpt[]
  readonly round: number
}): string {
  const read =
    o.excerpts.length === 0
      ? ['（还什么都没读到）']
      : o.excerpts.map((x) => {
          const shown = x.shown.map(rangeText).join(' · ')
          const tail = x.truncated ? `还有内容没读（共 ${x.lines} 行）` : '全文'
          return `- ${x.path}（${shown}；${tail}）`
        })
  return [
    EVIDENCE_AGAIN_CONTRACT,
    '',
    definitionBlock(o.page),
    '',
    siblingsBlock(o.plan, o.page),
    '',
    `本页来源 ${o.page.source} 的正文（原样，可能落后于代码）：`,
    '-----',
    o.source,
    '-----',
    '',
    `已经读到（第 ${o.round} 轮之前）：`,
    ...read,
  ].join('\n')
}

/** 一次调用的三区。**`shared` 一定是同一个 `PromptChain` 给的那一份**（缓存前缀靠这一点）。 */
export interface Assembled {
  readonly shared: string
  readonly page: string
  readonly task: string
}

export interface WritingInput {
  readonly page: PageDef
  readonly plan: DocsPlan
  readonly theme: ThemeSpec
  readonly source: string
  readonly materials: Materials
  readonly excerpts: readonly Excerpt[]
  readonly evidenceMissing?: readonly string[]
}

export interface EvidenceInput {
  readonly page: PageDef
  readonly plan: DocsPlan
  readonly source: string
}

export interface RangesInput {
  readonly page: PageDef
  readonly excerpts: readonly Excerpt[]
}

export interface AgainInput {
  readonly page: PageDef
  readonly plan: DocsPlan
  readonly source: string
  readonly excerpts: readonly Excerpt[]
  /** 这是第几轮（从 1 起）。 */
  readonly round: number
}

/**
 * 这一批的提示词链：**A 区装一次，所有调用共用这一份字节**。
 *
 * 新能力换的是链上的另一条路（取证怎么读 · 写作走几趟），不是再拼一遍 A 区——那正是缓存
 * 前缀能不能命中的分界。
 */
export interface PromptChain {
  /** A 区：这一批的公共事实（提交 C）。同一批里所有调用逐字节相同。 */
  readonly shared: string
  /** 写作那一趟。 */
  writing(o: WritingInput): Assembled
  /** 取证第一趟（要读哪几份文件）。 */
  evidence(o: EvidenceInput): Assembled
  /** 取证第二趟（被截断的那几份要后面哪几行）。 */
  ranges(o: RangesInput): Assembled
  /** 自由读的下一轮：已经读到什么、还需要什么。 */
  again(o: AgainInput): Assembled
}

/** 按这一批的事实装配提示词链。`shared` 只在这里算一次。 */
export function chainOf(facts: TreeFacts): PromptChain {
  const shared = sharedOf(facts)
  return {
    shared,
    writing: (o) => ({ shared, page: writingPageOf(o), task: CONTENT_TASK }),
    evidence: (o) => ({ shared, page: evidencePageOf(o), task: EVIDENCE_TASK }),
    ranges: (o) => ({ shared, page: evidenceRangesPageOf(o), task: EVIDENCE_RANGES_TASK }),
    again: (o) => ({ shared, page: againPageOf(o), task: EVIDENCE_AGAIN_TASK }),
  }
}

/**
 * `fugue docs prompt <id>` 打出来的那一份：**定义、来源摘录、本次事实与输出约定**。
 *
 * 它不调模型、不写盘：把这次生成会交给模型的三段原样打出来，供人检查或交给别的模型
 * （交接单 § 2.3）。所以它必须与真生成那一趟同源——同一个 `chainOf` / 同一个任务常量。
 * 摘录那一栏在这里是空的：它要模型先点名，而这一条命令不调模型（话里说清楚）。
 */
export function promptTextOf(o: {
  readonly page: PageDef
  readonly plan: DocsPlan
  readonly facts: TreeFacts
  readonly source: string
  readonly theme: ThemeSpec
  readonly materials: Materials
}): string {
  const words = chainOf(o.facts).writing({ ...o, excerpts: [] })
  return [
    '# A 区 · 这一批的公共事实（同一批里所有调用逐字节相同；缓存前缀落在这里）',
    words.shared,
    '# B 区 · 这一趟的合同与这一页的定义、来源、材料',
    words.page,
    '',
    '# C 区 · 这一次要做的事',
    words.task,
    '',
    '# 说明',
    '真生成时宿主会先用取证合同问一次"要读哪几份文件"，把那些文件在提交 C 里的原文补进 B 区（长的再问一次"要后面哪几行"），再走一次上面这三段。这一条命令不调模型，所以摘录那一栏是空的。',
  ].join('\n')
}
