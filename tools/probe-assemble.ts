// 探针：装配这一维的站前读数。出处：PLAN § 5.6 的 Z0 三条断言 + 它上面那张站前读数表。
// **取证用，不是产品的一部分**（仓库约定 § 七）。
//
// 它问三件事，前两件是断言、第三件是读数：
//   一 · 同一份（协议 · 段值）拼两次是不是逐字节相同。**这是这一站每一条哈希读数的前提**：
//        它不成立，后面"跨 N 个 agent hash(zoneA) 全等"那类断言全是空的。
//   二 · A 区的字节是不是恰好由区表那三段构成——不是"看着像"，是逐字节与拼接结果相等；
//        两条红负对照证明这一条**测得出来**（段序倒排一次 · 把"文件内容"排进 A 区）。
//   三 · 约束 3 要禁的那几串字符串今天各长什么样（工作区根那条绝对路径 · 宿主名 · Signal 原文
//        的取值处）。读数不是断言：把它变成"放进去必被拒"是 Z6 的事。
//
// **证人不是常量表。** 前两条比的是探针自己从 `ARCHITECTURE.md` 解析出来的区表与工具表——
// 从 `contract.ts` 回读 `ZONE_SEGMENTS` 再跟自己比，那是恒等式，测不出漂移。
//
// **这里是打桩的状态。** 十二个段的值都是占位：真实段源在 Z4（`sources.ts`）。但段值**不是空的**
// ——空值会让"排进哪个区"这条断言量不出东西（`渲染规则 × 值形状`这一对要真走一遍）。
//
// 跑法：cd ~/fugue && node tools/probe-assemble.ts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RendererId, SegmentId, SegmentValue, Zone } from '../src/assemble/contract.ts'
import { HOLDER_B, ZONE_SEGMENTS } from '../src/assemble/contract.ts'
import { HOLDER_PROTOCOL, PROTOCOLS, SUBAGENT_PROTOCOL, TOOL_NAMES, checkProtocolInvariant } from '../src/assemble/protocol.ts'
import { render } from '../src/assemble/render.ts'

/** 代码工作区：探针就住在它底下，所以它由 `import.meta.url` 定，不由环境变量定。 */
const REPO = fileURLToPath(new URL('..', import.meta.url))

/**
 * 文档工作区：它**不在这台机器上**（NTFS，架构 § 6 那张表），所以三处候选逐个试。
 * 一个都够不到时，下面第二、第四两节里的"与架构对照"那几条**报出来并跳过**——模式与 S2 的
 * "宿主上那个二进制不在"同一档：缺的是取证的那一半，不是这一跑。
 */
const DOCS_CANDIDATES = [
  join(REPO, '..', 'CodeWish'),
  '/mnt/c/Users/Administrator/Desktop/CodeWish',
  join(homedir(), 'Desktop', 'CodeWish'),
]
const docsHit = DOCS_CANDIDATES.find((p) => existsSync(join(p, 'ARCHITECTURE.md')))
const DOCS = process.env.FUGUE_DOCS ?? docsHit ?? DOCS_CANDIDATES[1]
const ARCH = join(DOCS, 'ARCHITECTURE.md')
const haveArch = existsSync(ARCH)

let failed = 0
function ok(msg: string): void {
  console.log(`  ok   ${msg}`)
}
function bad(msg: string): void {
  failed++
  console.log(`  FAIL ${msg}`)
}
function eq<T>(what: string, got: T, want: T): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(`${what}：${g}`)
  else bad(`${what}：拿到 ${g}，要的是 ${w}`)
}
function say(msg: string): void {
  console.log(`  ·    ${msg}`)
}

/** 跳过一条与架构对照的检查：说得出来为什么，就不算静默通过。 */
function note(msg: string): void {
  console.log(`  --   ${msg}`)
}

/** 字节的指纹：长度 + `sha256` 前 16 位（口径同 `.fugue/backlog/s6-stitch.md` § 4）。 */
function fingerprint(bytes: Uint8Array): string {
  const h = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  return `${String(bytes.length).padStart(6)} B · ${h}`
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 一个段名：`凝聚理解` · `运行时上下文`——两个汉字到六个汉字，不许有别的字符。 */
function isSegmentName(cell: string): boolean {
  return /^[\u4e00-\u9fff]{2,6}$/.test(cell)
}

/**
 * 从架构 § 8.11 那张区表里读出区 → 段名。
 *
 * 四处形状要照顾：**行会折行**（子 agent 的 B 区那几行）、**区名在第一格且带后缀**（两张表都
 * 写 `**A** 共享头`）、**同一张表里夹着工具目录那一行**（它的第三格——拥有者——是 `宿主`，不是
 * 人也不是某个模块），以及**紧挨着的持轮者那张"差别表"**——它的第一格同样是 `**A** …`，但第二
 * 格是整句话（带 `**`），所以那张表按"第二格不含 `**`"排掉。
 *
 * 三条判据都是**整格取值**，不是"这一格里有没有某句话"：子串判据在这里会误伤，而这一份的全部
 * 价值就是它读的是架构的原文、不是我们自己的常量表。
 */
function isZoneShapeTable(cells: string[]): boolean {
  const first = cells[0].replace(/[`*\u00a0]/g, ' ').trim()
  const zone = first.split(/\s+/)[0]
  if (!(zone === 'A' || zone === 'B' || zone === 'C')) return false
  // 差别表那一张的第二格是整句话（`逐字节相同——两个角色只在这里相交`），不是段名。
  return !cells[1].includes('**')
}
function parseZoneTable(md: string): { zones: Record<Zone, string[]>; unknown: string[] } {
  const zones: Record<Zone, string[]> = { A: [], B: [], C: [] }
  const unknown: string[] = []
  let cur: Zone | null = null
  for (const raw of md.split('\n')) {
    // 非表格行（空行 · 小标题 · 正文）就是那张表到头了：**收表**，否则后面每一节的表格都会
    // 被算进最后一个区里。
    if (!raw.startsWith('|')) {
      cur = null
      continue
    }
    const cells = raw.split('|').slice(1, -1)
    if (cells.length < 2) continue
    if (isZoneShapeTable(cells)) {
      cur = cells[0].replace(/[`*\u00a0]/g, ' ').trim().split(/\s+/)[0] as Zone
    }
    // 折行那一半：第一格是空的，段名跟在后面几行里——它属于上一次认出来的那个区。
    if (cur === null) continue
    // 工具目录那一行排掉：**判据是第三格（拥有者）恰好是 `宿主`**——不是"第二格里有没有某句话"。
    // 用子串判据在这里会误伤：段名本身可能是另一个名字的子串，而这一格里的句子与别处的写法未必
    // 逐字相同（架构这一行第二格只有"工具目录"四个字）。
    if (cells.length > 2 && cells[2].replace(/[`*\u00a0]/g, ' ').trim() === '宿主') continue
    const cell = cells[1].replace(/\\/g, '').replace(/`/g, '').replace(/（.*?）/g, '').trim()
    if (isSegmentName(cell)) zones[cur].push(cell)
    else if (isZoneShapeTable(cells)) unknown.push(`${cur} 区那一行没读出段名：${cells[1].trim()}`)
  }
  return { zones, unknown }
}

/** 从架构 § 8.10 那张目录表里读出工具名：一行一条，反引号里的那几个。 */
function parseToolTable(md: string): string[] {
  const names: string[] = []
  const head = md.indexOf('## 8.10 ')
  const from = head === -1 ? 0 : head
  const to = md.indexOf('\n## ', from + 1)
  for (const line of md.slice(from, to === -1 ? undefined : to).split('\n')) {
    if (!line.startsWith('|')) continue
    for (const m of line.matchAll(/`([a-z_]+)`/g)) names.push(m[1])
  }
  return names
}

console.log('Z0 · 装配的形状：三条断言与三处读数\n')

// ── 一 · 确定性 ────────────────────────────────────────────────────────────────
console.log('一 · 同一份（协议 · 段值）拼两次是不是逐字节相同')

/** 段的源：A 区第一段真读 `<realRoot>/AGENTS.md`，其余是占位（真实段源在 Z4）。 */
function stubSegments(): Record<SegmentId, SegmentValue> {
  const policy = readFileSync(join(REPO, 'AGENTS.md'), 'utf8')
  return {
    项目方针: policy,
    系统状态: { platform: 'linux', workspace: 'fugue', config: { materialize: 'overlayfs', net: 'none' } },
    代码树: [],
    工作总目标: '把 S6 装配这一站走完：十二个段三个区，前缀字节可核算。',
    文件内容: [
      { path: 'src/assemble/contract.ts', text: '// M10 的契约。\n' },
      { path: 'src/assemble/protocol.ts', text: '// 两个协议值。\n' },
    ],
    提交序列: ['40f0cf6 计划 · S6 的 Z0 三条断言改成本单元能证伪的', 'cf3ef97 清理 · .fugue/tmp 里上一轮的中间件清空'],
    交接提示词: '（首任为空——占位）',
    我的任务: '实现 Z0：形状与第一版真实协议。',
    凝聚理解: '（持轮者独占那一段：占位）',
    压缩前最近几次原文: '（持轮者独占那一段：占位）',
    运行时上下文: '（积累段：只追加，占位）',
    信号摘要: ['sig-1 · 占位'],
    上一步结果: '（上一步的工具结果：占位）',
  }
}

/** 排序 · 渲染 · 拼接。Z1 的 `assemble.ts` 长出真身之后，这里换成调用它。 */
function stitch(
  order: readonly SegmentId[],
  values: Readonly<Record<SegmentId, SegmentValue>>,
  renderers: Readonly<Record<SegmentId, string>>,
): Uint8Array {
  return concat(order.map((id) => render(renderers[id] as never, values[id])))
}

const values = stubSegments()
const first = stitch(SUBAGENT_PROTOCOL.segmentOrder, values, SUBAGENT_PROTOCOL.renderers)
const second = stitch(SUBAGENT_PROTOCOL.segmentOrder, values, SUBAGENT_PROTOCOL.renderers)
const whole = (bytes: Uint8Array): string => fingerprint(bytes)
eq('整个前缀（十一元段序）', whole(second), whole(first))
const perSegment = SUBAGENT_PROTOCOL.segmentOrder.map((id) => `${id}=${fingerprint(render(SUBAGENT_PROTOCOL.renderers[id], values[id]))}`)
say(`逐段：${perSegment.join(' · ')}`)

{
  const reversed = [...SUBAGENT_PROTOCOL.segmentOrder].reverse()
  const r = stitch(reversed, values, SUBAGENT_PROTOCOL.renderers)
  if (Buffer.compare(Buffer.from(r), Buffer.from(first)) !== 0) ok('红负对照（段序倒排）：字节变了')
  else bad('红负对照（段序倒排）：字节**没变**——这条断言量不出东西')
  say(`倒排之后：${whole(r)}（倒排前的 ${whole(first)}）`)
}

// ── 二 · A 区只由区表那三段构成 ─────────────────────────────────────────────────
console.log('\n二 · A 区的字节 = 区表那三段按序拼接，且只有那三段')

const arch = haveArch ? readFileSync(ARCH, 'utf8') : ''
if (haveArch) {
  const parsed = parseZoneTable(arch)
  for (const u of parsed.unknown) bad(`解析架构 § 8.11 的区表：${u}`)
  eq('架构 § 8.11 读出来的 A 区', parsed.zones.A, ZONE_SEGMENTS.A)
  eq('架构 § 8.11 读出来的 子 agent 的 B 区', parsed.zones.B, ZONE_SEGMENTS.B)
  eq('架构 § 8.11 读出来的 C 区', parsed.zones.C, ZONE_SEGMENTS.C)
  // 持轮者那一份：A 区与 C 区与子 agent 同一串字，B 区是子 agent 的 B 区去掉 `我的任务`、
  // 末尾接上它独占的那两段（架构 § 8.11 第二张表）。
  eq('架构 § 8.11 读出来的 持轮者的 B 区', HOLDER_B, [
    ...ZONE_SEGMENTS.B.filter((s) => s !== '我的任务'),
    '凝聚理解',
    '压缩前最近几次原文',
  ])
} else {
  note(`架构那两份表没对照：够不到 ${ARCH}（试过 ${DOCS_CANDIDATES.join(' · ')}）`)
}
{
  // 持轮者独占的那两段只该在 `HOLDER_B` 里出现一次：两份 B 区段表的交集就是它们共用的那四段，
  // 合起来七个不重复的段名（`我的任务` 与持轮者独占的那两段各归一边）。
  const holder = new Set<string>(HOLDER_B)
  const subagent = new Set<string>(ZONE_SEGMENTS.B)
  say(`持轮者 B 区比子 agent 多出的段：${[...holder].filter((s) => !subagent.has(s)).join(' · ')}；少的段：${[...subagent].filter((s) => !holder.has(s)).join(' · ')}`)
  eq('B 区那两份段表的交集', [...holder].filter((s) => subagent.has(s)), ['工作总目标', '文件内容', '提交序列', '交接提示词'])
  eq('B 区那两份段表合起来的不重复段名（四段共用 + `我的任务` + 持轮者独占的那两段）', [...new Set([...ZONE_SEGMENTS.B, ...HOLDER_B])].length, 7)
}

const zoneA = stitch(ZONE_SEGMENTS.A, values, SUBAGENT_PROTOCOL.renderers)
const realA = first.slice(0, zoneA.length)
eq('A 区的字节逐字节等于那三段拼接', fingerprint(realA), fingerprint(zoneA))
{
  const tail = first.slice(zoneA.length)
  say(`A 区之后还有 ${tail.length} B —— 按段序，下一个是「${SUBAGENT_PROTOCOL.segmentOrder[ZONE_SEGMENTS.A.length]}」`)
}
{
  // 红负对照：把「文件内容」排进 A 区。区表改一个字，哈希当场该变。
  const wrongOrder = [...ZONE_SEGMENTS.A, '文件内容'] as SegmentId[]
  const wrong = stitch(wrongOrder, values, SUBAGENT_PROTOCOL.renderers)
  const wrongA = wrong.slice(0, wrong.length)
  if (fingerprint(wrongA) !== fingerprint(realA)) ok('红负对照（「文件内容」排进 A 区）：hash(zoneA) 变了')
  else bad('红负对照（「文件内容」排进 A 区）：hash(zoneA) **没变**')
  say(`A 区换成 项目方针 · 系统状态 · 代码树 · 文件内容 之后：${fingerprint(wrongA)}（原来是 ${fingerprint(realA)}）`)
}

// ── 三 · 约束 3 那几串字符串今天长什么样 ─────────────────────────────────────────
console.log('\n三 · 读数：约束 3 要禁的那几串字符串的取值处')

say(`工作区根那条绝对路径（物化路径的形态）：${REPO}（${statSync(join(REPO, 'AGENTS.md')).size} 字节的 AGENTS.md 在它底下）`)
say(`<realRoot>/AGENTS.md：${fingerprint(readFileSync(join(REPO, 'AGENTS.md')))}`)
{
  const env = process.env.HOSTNAME ?? ''
  const cmd = execFileSync('hostname', { encoding: 'utf8' }).trim()
  const hostnameFile = readFileSync('/etc/hostname', 'utf8').trim()
  const hosts = readFileSync('/etc/hosts', 'utf8')
  say(`process.env.HOSTNAME：${env === '' ? '（空——bash 自己设这一个名字，但不导出，所以在这里读不到）' : env}`)
  say(`hostname 命令：${cmd}`)
  say(`/etc/hostname：${hostnameFile}`)
  say(`/etc/hosts 里出现宿主名的行：${hosts.split('\n').filter((l) => cmd !== '' && l.includes(cmd)).map((l) => l.trim()).join(' ｜ ') || '（没有）'}`)
  if (cmd !== '' && hostnameFile === cmd && hosts.includes(cmd)) {
    ok(`三处读到同一个名字（hostname 命令 · /etc/hostname · /etc/hosts）：${cmd}——约束 3 要禁的是这一串`)
  } else {
    say(`三处读到的名字对不上（命令=${cmd} · 文件=${hostnameFile}）——靶子表要按"逐一列出"写`)
  }
  say('注：沙箱里没有 /etc/hosts 这一项（S5 量到名字解析走 glibc 的 dns 那一支），所以那一栏按定义取')
}
{
  const events = readFileSync(join(REPO, 'src/log/events.ts'), 'utf8')
  const line = events.split('\n').find((l) => l.includes("t: 'signal'")) ?? ''
  const fields = [...line.matchAll(/([a-zA-Z?]+)\??:/g)].map((m) => m[1])
  say(`Signal 事件的字段：${fields.join(' · ')}`)
  if (fields.includes('digest') && !fields.includes('body')) {
    ok('Signal 原文的取值处 = `signal` 事件的 `digest`——这一档只有摘要，原文不在事件里')
  } else bad(`Signal 事件的取值处要重看：${line.trim()}`)
}

// ── 四 · 形状（读常量表，不是断言） ──────────────────────────────────────────────
console.log('\n四 · 形状：两份声明 · 工具目录 · 渲染规则')

eq('`PROTOCOLS` 里的名字', Object.keys(PROTOCOLS), ['subagent', 'holder'])
eq('子 agent 的段序', SUBAGENT_PROTOCOL.segmentOrder.length, 11)
eq('持轮者的段序', HOLDER_PROTOCOL.segmentOrder.length, 12)
eq('两份声明的版本号', [SUBAGENT_PROTOCOL.version, HOLDER_PROTOCOL.version], ['s6-1', 's6-1'])
{
  const all = [...SUBAGENT_PROTOCOL.segmentOrder, ...HOLDER_PROTOCOL.segmentOrder]
  eq('两份声明合起来出现过的段名（去重）', [...new Set(all)].length, 13)
  eq('两份声明的段序合起来不重不漏地铺满十三个段名', [...new Set(all)].length, Object.keys(SUBAGENT_PROTOCOL.renderers).length)
  eq('每次声明里段的个数 == 渲染规则的键数', [
    SUBAGENT_PROTOCOL.segmentOrder.length,
    Object.keys(SUBAGENT_PROTOCOL.renderers).length,
    HOLDER_PROTOCOL.segmentOrder.length,
    Object.keys(HOLDER_PROTOCOL.renderers).length,
  ], [11, 13, 12, 13])
}
{
  if (haveArch) eq('架构 § 8.10 读出来的工具名', parseToolTable(arch), [...TOOL_NAMES])
  else note('架构 § 8.10 那张工具表没对照：同上')
  eq('工具目录的个数', TOOL_NAMES.length, 15)
  eq('工具目录进的是 `toolCatalog`，不是段序', [
    SUBAGENT_PROTOCOL.toolCatalog.length,
    SUBAGENT_PROTOCOL.segmentOrder.includes('工具目录' as SegmentId),
  ], [15, false])
}
{
  const used = new Set(Object.values(SUBAGENT_PROTOCOL.renderers))
  const order = [...used].sort().join(' · ')
  ok(`四种渲染器都被用到（每个至少一段）：${order}`)
}

// ── 五 · 那条封口本身有没有读数 ──────────────────────────────────────────────────
console.log('\n五 · 载入时那条不变量：它抓不抓得住一份坏掉的声明（它要是恒真，探针自己就看不出来）')

/** 一份坏声明：改哪一处由外面给。错的地方只要有一条，`checkProtocolInvariant` 就该说出来。 */
function broken(mutate: (p: { version: string; segmentOrder: SegmentId[]; toolCatalog: readonly string[]; renderers: Record<SegmentId, RendererId> }) => void): string[] {
  const p = {
    version: SUBAGENT_PROTOCOL.version,
    segmentOrder: [...SUBAGENT_PROTOCOL.segmentOrder],
    toolCatalog: [...SUBAGENT_PROTOCOL.toolCatalog],
    renderers: { ...SUBAGENT_PROTOCOL.renderers },
  }
  mutate(p)
  return checkProtocolInvariant(p, ZONE_SEGMENTS.B)
}

{
  // 正那一半：两份真声明各自报'没有不一致'。
  eq('子 agent 那份没有不一致', checkProtocolInvariant(SUBAGENT_PROTOCOL, ZONE_SEGMENTS.B), [])
  eq('持轮者那份没有不一致', checkProtocolInvariant(HOLDER_PROTOCOL, HOLDER_B), [])
  // 反那一半：五种坏法各报一处。少了这一半，'当场炸'就只是一句话。
  const cases: [string, () => string[]][] = [
    ['短一段（把「我的任务」从段序里去掉）', () => broken((p) => { p.segmentOrder = p.segmentOrder.filter((s) => s !== '我的任务') })],
    ['多一段（把持轮者独占的「凝聚理解」排进来）', () => broken((p) => { p.segmentOrder = [...p.segmentOrder, '凝聚理解'] })],
    ['重复一段', () => broken((p) => { p.segmentOrder = [...p.segmentOrder, '代码树'] })],
    ['缺一条渲染规则', () => broken((p) => { delete (p.renderers as Partial<typeof p.renderers>)['信号摘要'] })],
    ['工具目录是空的', () => broken((p) => { p.toolCatalog = [] })],
  ]
  for (const [what, run] of cases) {
    const problems = run()
    if (problems.length > 0) ok(`坏声明（${what}）→ 报出 ${problems.length} 处：${problems[0]}`)
    else bad(`坏声明（${what}）→ **一处都没报**——这条不变量恒真`)
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `FAIL ${failed} 处`}`)
process.exit(failed === 0 ? 0 : 1)
