// 三档结构的自检（0.2.2）：CI 的形状是**冻结面**（路线图 §9 的 0.2.2 行），冻结点要带一条会红的
// 断言——漂了当场红，而不是等人去 Actions 里翻。判据是**解析后的结构**，不是正则。
//
// YAML 由下面这个**受限读取器**解：只建模本站用到的那点语法（块映射 · 块序列 · 序列项里的行内
// 映射 · `|` 块标量 · 引号标量 · 平坦的行内序列 `['**']`），**遇到没建模的构造当场红**——不静默
// 忽略。为什么不用真 YAML 库：仓库零依赖（引一个解析器就破了这条），而这一步在**快档**里常驻。
// 真 YAML 解析做过一次交叉取证（读数在 0.2.2 的提交序列里：PyYAML 6.0.1 解出来的结构与这里
// 逐键相同，唯一差别是 YAML 1.1 把 `on` 当布尔真——本读取器不做那种解释）。
//
// 这一条同时守着头部那两段注释的决定：**标签不跑** · **`branches: ['**']` 不能删**。后者是
// "删了不报错、只是静默不跑"的那一类陷阱，所以它在这里有断言：`push.branches` 与
// `push.tags-ignore` 两条都得在，且触发器里不许出现 `tags`。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const REPO = join(import.meta.dirname, '..')
const WORKFLOWS = join(REPO, '.github', 'workflows')
const TEST_YML = join(WORKFLOWS, 'test.yml')
const YAML_TEXT = readFileSync(TEST_YML, 'utf8')

// ── 受限 YAML 读取器 ────────────────────────────────────────────────────────────

type Yaml = { [k: string]: Yaml | Yaml[] | string }

interface Tok {
  n: number
  indent: number
  text: string
  /** `key: |` 的块标量正文（行尾换行保留）。 */
  body?: string
}

function fail(n: number, why: string): never {
  throw new Error(`test.yml 第 ${n + 1} 行：${why}`)
}

/** 去掉行尾注释；引号里的 `#` 不算注释。 */
function stripComment(s: string): string {
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

/** 标量：配对引号脱掉，其余原样。 */
function scalar(s: string): string {
  const t = s.trim()
  const q = t[0]
  if (t.length >= 2 && (q === "'" || q === '"') && t.at(-1) === q) return t.slice(1, -1)
  return t
}

/** 平坦的行内序列：`['**']`。嵌套或映射形状没建模（当场红）。 */
function flowSeq(s: string, n: number): string[] {
  const t = s.trim()
  if (!t.endsWith(']')) fail(n, `行内序列没闭合：${t}`)
  const inner = t.slice(1, -1).trim()
  if (inner === '') return []
  if (inner.includes('[') || inner.includes('{')) fail(n, `嵌套的行内集合没建模：${t}`)
  return inner.split(',').map((x) => scalar(x))
}

/** `key: value` / `key:` 拆开。 */
function splitPair(text: string, n: number): [string, string] {
  const i = text.indexOf(': ')
  if (i !== -1) return [scalar(text.slice(0, i)), text.slice(i + 2).trim()]
  if (text.endsWith(':')) return [scalar(text.slice(0, -1)), '']
  fail(n, `不是 key: value 形状：${text}`)
}

function tokenize(raw: string[]): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < raw.length) {
    const line = raw[i]
    if (/^[ ]*\t/.test(line)) fail(i, '缩进里出现制表符（没建模）')
    const nc = stripComment(line)
    if (nc.trim() === '') {
      i++
      continue
    }
    const indent = nc.length - nc.trimStart().length
    const text = nc.trim()
    if (text === '---' || text === '...') fail(i, '多文档标记没建模')
    if (/^[&*!]/.test(text)) fail(i, '锚点 · 别名 · 标签没建模')
    if (text.startsWith('{')) fail(i, '流式映射没建模——写成块形式')
    // 块标量：`key: |`（含 `- key: |`）。正文是后面缩进更深的那些行，原样收进来。
    if (/:\s*[|>][-+]?$/.test(text)) {
      const body: string[] = []
      let j = i + 1
      let bodyIndent = -1
      for (; j < raw.length; j++) {
        const l = raw[j]
        if (l.trim() === '') {
          body.push('')
          continue
        }
        const ind = l.length - l.trimStart().length
        if (ind <= indent) break
        if (bodyIndent === -1) bodyIndent = ind
        if (ind < bodyIndent) break
        body.push(l.slice(bodyIndent))
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop()
      out.push({ n: i, indent, text, body: body.join('\n') + '\n' })
      i = j
      continue
    }
    out.push({ n: i, indent, text })
    i++
  }
  return out
}

function parseYamlSubset(text: string): Yaml {
  const toks = tokenize(text.replace(/\r\n/g, '\n').split('\n'))
  if (toks.length === 0) throw new Error('YAML 是空的')
  let p = 0

  const top = parseNode(toks[0].indent)
  if (p < toks.length) fail(toks[p].n, `这一行没被吃进去（缩进 ${toks[p].indent}）`)
  return top as Yaml

  function parseNode(indent: number): Yaml | Yaml[] | string {
    const t = toks[p]
    if (t.text === '-' || t.text.startsWith('- ')) return parseSeq(indent)
    return parseMap(indent)
  }

  function parseMap(indent: number): Yaml {
    const obj: Yaml = {}
    while (p < toks.length) {
      const t = toks[p]
      if (t.indent < indent) break
      if (t.indent > indent) fail(t.n, `缩进不齐：这一层是 ${indent}，这一行是 ${t.indent}`)
      if (t.text === '-' || t.text.startsWith('- ')) fail(t.n, '映射里混进了序列项')
      const [key, rest] = splitPair(t.text, t.n)
      if (key in obj) fail(t.n, `键重复：${key}`)
      obj[key] = parseValue(rest, t, indent)
    }
    return obj
  }

  /** `rest` 是 `key:` 后面那半截；本函数负责把 `p` 推过这一个值（含它的子树）。 */
  function parseValue(rest: string, t: Tok, indent: number): Yaml | Yaml[] | string {
    if (rest === '') {
      p++
      if (p >= toks.length || toks[p].indent <= indent) return ''
      return parseNode(toks[p].indent)
    }
    if (/^[|>][-+]?$/.test(rest)) {
      p++
      return t.body ?? ''
    }
    if (rest.startsWith('[')) {
      p++
      return flowSeq(rest, t.n)
    }
    if (rest.startsWith('{')) fail(t.n, '流式映射没建模——写成块形式')
    if (/^[&*!]/.test(rest)) fail(t.n, '锚点 · 别名 · 标签没建模')
    p++
    return scalar(rest)
  }

  function parseSeq(indent: number): Yaml[] {
    const arr: Yaml[] = []
    while (p < toks.length) {
      const t = toks[p]
      if (t.indent < indent) break
      if (t.indent > indent) fail(t.n, `缩进不齐：这一层是 ${indent}，这一行是 ${t.indent}`)
      if (!(t.text === '-' || t.text.startsWith('- '))) break
      const item = t.text === '-' ? '' : t.text.slice(2).trim()
      if (item === '') {
        p++
        if (p < toks.length && toks[p].indent > indent) arr.push(parseNode(toks[p].indent))
        else arr.push('')
        continue
      }
      if (/:\s|:$/.test(item)) {
        arr.push(parseItemMap(t, item, indent + 2))
        continue
      }
      if (item.startsWith('[')) {
        p++
        arr.push(flowSeq(item, t.n))
        continue
      }
      p++
      arr.push(scalar(item))
    }
    return arr
  }

  /** 序列项里的行内映射：`- uses: …`——本行是第一对，后面同层的对缩进 = 项的缩进 + 2。 */
  function parseItemMap(t: Tok, item: string, childIndent: number): Yaml {
    const obj: Yaml = {}
    const [key, rest] = splitPair(item, t.n)
    obj[key] = parseValue(rest, t, t.indent)
    while (p < toks.length && toks[p].indent >= childIndent) {
      const u = toks[p]
      if (u.indent > childIndent) fail(u.n, `缩进不齐：这一层是 ${childIndent}，这一行是 ${u.indent}`)
      if (u.text === '-' || u.text.startsWith('- ')) fail(u.n, '序列项里混进了序列')
      const [k, r] = splitPair(u.text, u.n)
      if (k in obj) fail(u.n, `键重复：${k}`)
      obj[k] = parseValue(r, u, u.indent)
    }
    return obj
  }
}

// ── 结构判据 ───────────────────────────────────────────────────────────────────

/** 一个 job 里所有 `run:` 的正文拼起来（判据看的是命令，不是编排）。 */
function scripts(job: Yaml): string {
  const steps = (job.steps as Yaml[]) ?? []
  return steps.map((s) => (s as Yaml).run ?? '').join('\n')
}

/** 这一份脚本调了哪些档（`node tools/test-entry.js <档>` 与计时器那条同形）。 */
function lanes(script: string): string[] {
  return [...script.matchAll(/node\s+tools\/(?:test-entry|ci-timing)\.js\s+([\w-]+)/g)].map((m) => m[1])
}

/** 这一份脚本里所有 `node <路径>` 调的东西——用来断言"不长第二条路"。 */
function nodeTargets(script: string): string[] {
  return [...script.matchAll(/\bnode\s+([^\s|&;]+)/g)].map((m) => m[1])
}

/** `if:` 说的这件事在哪些事件上跑。只建模 `github.event_name == 'x'` 用 `||` 连起来这一种形状。 */
function gateEvents(ifText: string | undefined): string[] {
  if (typeof ifText !== 'string' || ifText.trim() === '') return []
  return ifText
    .split('||')
    .map((part) => {
      const m = /^\s*github\.event_name\s*==\s*'([a-z_]+)'\s*$/.exec(part)
      if (m === null) throw new Error(`没建模的条件形状：${part.trim()}`)
      return m[1]
    })
    .sort()
}

const TRIGGERS = ['pull_request', 'push', 'schedule', 'workflow_dispatch']
const JOBS = ['audit', 'fast', 'full']
const ALLOWED_TOOLS = ['tools/test-entry.js', 'tools/ci-timing.js', 'tools/mutation-audit.js']
// 计时 artifact 的名字与路径（冻结点 ② 的另一半）：报告 · 保护 payload 附近的那张表引的就是这两个。
const TIMING_ARTIFACT = 'ci-timing'
const TIMING_PATH = 'ci-timing-*.json'
const TIMING_RUNS = ['fast→ci-timing-fast.json', 'real→ci-timing-real.json']
// 审档的报告（没进冻结面，但它也得真产出——报告缺了那一趟就白跑）。
const MUTATION_ARTIFACT = 'mutation-audit'
const MUTATION_PATH = 'mutation-audit.json'
// 保护 payload（冻结点 ③）：必绿集合是**快 + 真**；文档仓那条留在本机（文档仓无远端），audit 只报不挡。
const PROTECTION = join(REPO, '.github', 'main-protection.json')
const PROTECTION_MD = join(REPO, '.github', 'main-protection.md')
const PROTECTION_JSON = readFileSync(PROTECTION, 'utf8')
const REQUIRED_CONTEXTS = ['fast', 'full']
const PROTECTION_CMD =
  'gh api -X PUT repos/54shitaimzf/Fugue/branches/main/protection --input .github/main-protection.json'

/** 三档结构的问题清单（空数组 = 全过）。 */
function inspectWorkflow(wf: Yaml): string[] {
  const bad: string[] = []
  const on = wf.on
  if (typeof on !== 'object' || Array.isArray(on)) return ['触发器（`on:`）读不出来']
  const triggers = Object.keys(on).sort()
  if (JSON.stringify(triggers) !== JSON.stringify(TRIGGERS)) {
    bad.push(`触发器是 ${triggers.join(' · ')}——要的是 ${TRIGGERS.join(' · ')}`)
  }
  const push = on.push as Yaml
  if (typeof push !== 'object') bad.push('push 触发器读不出来')
  else {
    if (JSON.stringify(push.branches) !== JSON.stringify(['**'])) {
      bad.push("push 少了 `branches: ['**']`——删了不报错，只会让流水线静默地不再跑")
    }
    if (JSON.stringify(push['tags-ignore']) !== JSON.stringify(['**'])) {
      bad.push("push 少了 `tags-ignore: ['**']`——标签照跑就回来了")
    }
    if ('tags' in push) bad.push('push 里出现了 `tags:`——现行决策是标签不跑')
  }
  const schedule = on.schedule
  if (!Array.isArray(schedule) || schedule.length === 0) bad.push('schedule 里没有 cron')
  else if (typeof (schedule[0] as Yaml).cron !== 'string') bad.push('schedule 的 cron 形状不对')

  const jobs = wf.jobs as Yaml
  if (typeof jobs !== 'object' || Array.isArray(jobs)) return [...bad, 'jobs 读不出来']
  const ids = Object.keys(jobs).sort()
  if (JSON.stringify(ids) !== JSON.stringify(JOBS)) {
    bad.push(`job 是 ${ids.join(' · ')}——声明之外不开 job（windows/macos 通道 · 空 job 都不开）`)
  }
  for (const id of ids) {
    const job = jobs[id] as Yaml
    if (typeof job !== 'object' || Array.isArray(job)) {
      bad.push(`${id}：读不出来`)
      continue
    }
    // check 名 = job 名：必绿集合里写的必须就是这里这个名字。
    if (job.name !== id) bad.push(`${id}：name 是 ${String(job.name)}——check 名必须等于 job 名`)
    let events: string[]
    try {
      events = gateEvents(job.if as string | undefined)
    } catch (e) {
      bad.push(`${id}：${(e as Error).message}`)
      continue
    }
    const script = scripts(job)
    const want: Record<string, { events: string[]; lanes: string[] }> = {
      fast: { events: ['pull_request', 'push'], lanes: ['fast'] },
      full: { events: ['pull_request'], lanes: ['fast', 'real'] },
      audit: { events: ['schedule', 'workflow_dispatch'], lanes: ['all'] },
    }
    const target = want[id]
    if (target === undefined) continue
    if (JSON.stringify(events) !== JSON.stringify(target.events)) {
      bad.push(`${id}：跑在 ${events.join(' · ') || '（没有 if，任何事件都跑）'} 上——要的是 ${target.events.join(' · ')}`)
    }
    const got = lanes(script)
    if (JSON.stringify(got) !== JSON.stringify(target.lanes)) {
      bad.push(`${id}：调了档 ${got.join(' + ') || '（没有）'}——要的是 ${target.lanes.join(' + ')}`)
    }
    for (const t of nodeTargets(script)) {
      if (t.startsWith('tools/') && !ALLOWED_TOOLS.includes(t)) {
        bad.push(`${id}：跑了 ${t}——CI 不长第二条路（本地一条命令之外的入口不进这里）`)
      }
    }
    if (script.includes('node --test')) bad.push(`${id}：直接调了 \`node --test\`——路只许从 tools/test-entry.js 走`)
  }
  // 快档不装真依赖：档判据万一破了，让它在 CI 上当场红，而不是被 apt 那一步盖过去。
  const fastJob = jobs.fast as Yaml | undefined
  if (fastJob !== undefined && typeof fastJob === 'object') {
    const s = scripts(fastJob)
    if (s.includes('bubblewrap') || s.includes('apt-get')) {
      bad.push('fast：快档 job 里装了真依赖（apt/bubblewrap）——按定义快档不碰它们')
    }
  }
  // artifact 那一组判据两个 job 共用：恰好一个上传步 · 名字与路径是冻结面 · 红了也上传。
  const fullJob = jobs.full as Yaml | undefined
  if (fullJob !== undefined && typeof fullJob === 'object') {
    const timing = [...scripts(fullJob).matchAll(/node\s+tools\/ci-timing\.js\s+([\w-]+)\s+--out\s+(\S+)/g)].map(
      (m) => `${m[1]}→${m[2]}`,
    )
    if (JSON.stringify(timing) !== JSON.stringify(TIMING_RUNS)) {
      bad.push(`full：计时步是 ${timing.join(' · ') || '（没有）'}——要的是 ${TIMING_RUNS.join(' · ')}`)
    }
    bad.push(...artifactFindings(fullJob, 'full', TIMING_ARTIFACT, TIMING_PATH))
  }
  // 审档：全量兜底 + 变异审计。只装今天存在的东西；报告是产出，survivor 只报不挡。
  const auditJob = jobs.audit as Yaml | undefined
  if (auditJob !== undefined && typeof auditJob === 'object') {
    const auditRuns = [...scripts(auditJob).matchAll(/node\s+tools\/mutation-audit\.js\s+([^\n]*)/g)].map((m) =>
      m[1].trim(),
    )
    if (auditRuns.length !== 1) {
      bad.push(`audit：变异审计步应当恰好一个，实得 ${auditRuns.length}`)
    } else if (!auditRuns[0].includes('--out ' + MUTATION_PATH)) {
      bad.push(`audit：变异审计要 \`--out ${MUTATION_PATH}\`，实得 ${auditRuns[0]}`)
    }
    const steps = (auditJob.steps as Yaml[]) ?? []
    const step = steps.find((s) => String((s as Yaml).run ?? '').includes('mutation-audit.js'))
    if (step !== undefined && (step as Yaml).if !== 'always()') {
      bad.push('audit：变异审计步要 `if: always()`——全量兜底红了也照跑（它的产出是报告）')
    }
    bad.push(...artifactFindings(auditJob, 'audit', MUTATION_ARTIFACT, MUTATION_PATH))
  }
  return bad
}

/** artifact 那一组：恰好一个上传步 · 名字与路径对得上 · 红了也上传 · 没读数就报错。 */
function artifactFindings(job: Yaml, id: string, wantName: string, wantPath: string): string[] {
  const out: string[] = []
  const steps = (job.steps as Yaml[]) ?? []
  const uploads = steps.filter((s) => String((s as Yaml).uses ?? '').startsWith('actions/upload-artifact@'))
  if (uploads.length !== 1) {
    out.push(`${id}：artifact 的上传步应当恰好一个，实得 ${uploads.length}`)
    return out
  }
  const u = uploads[0] as Yaml
  const w = (u.with ?? {}) as Yaml
  if (w.name !== wantName) out.push(`${id}：artifact 名是 ${String(w.name)}——要的是 ${wantName}`)
  if (w.path !== wantPath) out.push(`${id}：artifact 路径是 ${String(w.path)}——要的是 ${wantPath}`)
  if (u.if !== 'always()') out.push(`${id}：上传步要 \`if: always()\`——红了的那趟也要留下读数`)
  if (w['if-no-files-found'] !== 'error') {
    out.push(`${id}：上传步要 \`if-no-files-found: error\`——没有读数就是形状破了，不许静默上传空 artifact`)
  }
  return out
}

test('三档结构：触发器齐 · job 名 = check 名 · 每档跑什么（0.2.2 冻结面）', () => {
  const wf = parseYamlSubset(YAML_TEXT)
  const bad = inspectWorkflow(wf)
  const on = wf.on as Yaml
  const jobs = wf.jobs as Yaml
  const table = Object.keys(jobs)
    .sort()
    .map((id) => `${id}(${gateEvents((jobs[id] as Yaml).if as string).join('/')})→${lanes(scripts(jobs[id] as Yaml)).join('+')}`)
  console.log(
    `三档读数：触发器 ${Object.keys(on).sort().join(' · ')} ｜ ${table.join(' ｜ ')} ｜ artifact ${TIMING_ARTIFACT}(${TIMING_PATH}) + ${MUTATION_ARTIFACT}(${MUTATION_PATH})`,
  )
  assert.deepEqual(bad, [], '三档结构自检不过：\n' + bad.join('\n'))
})

test('CI 只有一条：`.github/workflows/` 下只有 test.yml', () => {
  const files = readdirSync(WORKFLOWS).sort()
  console.log(`workflows 读数：${files.join(' · ')}`)
  assert.deepEqual(files, ['test.yml'], 'CI 只有一条——多出来的那条得先想清楚它是不是第二套真相')
})

test('头部两段注释在位：标签不跑 · `branches` 不能删的陷阱', () => {
  assert.ok(YAML_TEXT.includes('标签不跑'), '「标签不跑」那段理由没了')
  assert.ok(YAML_TEXT.includes('这一行不能删'), '「`branches` 不能删」那段没写')
  assert.ok(YAML_TEXT.includes('undefined Git ref'), '那段理由里的文档原话没了')
})

// 负对照：每一条都先确认"靶子还在"，再把它弄坏，确认自检当场红——
// 靶子漂了（有人重排了 YAML）这一条自己红，守卫不会因此变成一句空话。
//
// 两种弄坏法各管一半：**改文字**（靶子要在文件里找得到，管的是"那一行还在不在"）与**改树**
// （管的是判据本身还咬不咬得住）。
function broken(from: string, to: string): string[] {
  assert.ok(YAML_TEXT.includes(from), `负对照的靶子不在了：${JSON.stringify(from)}`)
  return inspectWorkflow(parseYamlSubset(YAML_TEXT.replace(from, to)))
}

function changed(mutate: (wf: Yaml) => void): string[] {
  const wf = parseYamlSubset(YAML_TEXT)
  mutate(wf)
  return inspectWorkflow(wf)
}

function jobOf(wf: Yaml, id: string): Record<string, unknown> {
  return (wf.jobs as Record<string, Record<string, unknown>>)[id]
}

test('负对照：删掉 `branches` 那一行 → 当场红', () => {
  const bad = broken("    branches: ['**']\n", '')
  assert.ok(
    bad.some((m) => m.includes('branches')),
    `删了 branches 应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：删掉 workflow_dispatch → 当场红', () => {
  const bad = broken('  workflow_dispatch:\n', '')
  assert.ok(
    bad.some((m) => m.includes('触发器')),
    `审档不能手动开应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：快档 job 改跑全量 → 当场红', () => {
  const bad = changed((wf) => {
    jobOf(wf, 'fast').steps = [{ run: 'node tools/test-entry.js all' }]
  })
  assert.ok(
    bad.some((m) => m.includes('fast：调了档')),
    `快档跑 all 应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：多开一个 job（windows 通道）→ 当场红', () => {
  const bad = changed((wf) => {
    ;(wf.jobs as Record<string, unknown>).windows = { 'runs-on': 'windows-latest' }
  })
  assert.ok(
    bad.some((m) => m.includes('job 是')),
    `多一个 job 应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：快档 job 里加一步 apt/bwrap → 当场红', () => {
  const bad = changed((wf) => {
    ;(jobOf(wf, 'fast').steps as unknown[]).unshift({ run: 'sudo apt-get install -y -qq bubblewrap' })
  })
  assert.ok(
    bad.some((m) => m.includes('装了真依赖')),
    `快档装真依赖应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

function uploadStep(wf: Yaml): Record<string, unknown> {
  const steps = jobOf(wf, 'full').steps as Record<string, unknown>[]
  const u = steps.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'))
  assert.ok(u !== undefined, '负对照的靶子不在了：全档的上传步')
  return u
}

/** 上传步的 `with:`（artifact 名与路径在那里，不在步骤那一层）。 */
function uploadWith(wf: Yaml): Record<string, unknown> {
  return uploadStep(wf).with as Record<string, unknown>
}

test('负对照：全档没有计时 artifact 上传步 → 当场红', () => {
  const bad = changed((wf) => {
    ;(jobOf(wf, 'full').steps as unknown[]).pop()
  })
  assert.ok(
    bad.some((m) => m.includes('上传步')),
    `少了上传步应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：artifact 改名 → 当场红', () => {
  const bad = changed((wf) => {
    uploadWith(wf).name = 'timing'
  })
  assert.ok(
    bad.some((m) => m.includes('artifact 名')),
    `artifact 改名应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：上传步去掉 `if: always()` → 当场红', () => {
  const bad = changed((wf) => {
    delete uploadStep(wf).if
  })
  assert.ok(
    bad.some((m) => m.includes('always')),
    `红了就不上传应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：计时步漏掉真档 → 当场红', () => {
  const bad = changed((wf) => {
    const steps = jobOf(wf, 'full').steps as Record<string, unknown>[]
    steps.splice(
      steps.findIndex((s) => String(s.run ?? '').includes('ci-timing.js real')),
      1,
    )
  })
  assert.ok(
    bad.some((m) => m.includes('full：计时步')),
    `计时只量了快档应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

function auditSteps(wf: Yaml): Record<string, unknown>[] {
  return jobOf(wf, 'audit').steps as Record<string, unknown>[]
}

function auditUploadWith(wf: Yaml): Record<string, unknown> {
  const u = auditSteps(wf).find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'))
  assert.ok(u !== undefined, '负对照的靶子不在了：审档的上传步')
  return u.with as Record<string, unknown>
}

test('负对照：审档没有变异审计步 → 当场红', () => {
  const bad = changed((wf) => {
    const steps = auditSteps(wf)
    steps.splice(
      steps.findIndex((s) => String(s.run ?? '').includes('mutation-audit.js')),
      1,
    )
  })
  assert.ok(
    bad.some((m) => m.includes('变异审计步')),
    `审档少了变异审计应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：审档的变异审计步去掉 `if: always()` → 当场红', () => {
  const bad = changed((wf) => {
    const step = auditSteps(wf).find((s) => String(s.run ?? '').includes('mutation-audit.js'))
    assert.ok(step !== undefined, '负对照的靶子不在了：审档的变异审计步')
    delete step.if
  })
  assert.ok(
    bad.some((m) => m.includes('always')),
    `全量兜底红了就不跑审计应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：审档报告改名 → 当场红', () => {
  const bad = changed((wf) => {
    auditUploadWith(wf).name = 'mutation'
  })
  assert.ok(
    bad.some((m) => m.includes('artifact 名')),
    `审档 artifact 改名应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：审档改跑快档 → 当场红', () => {
  const bad = changed((wf) => {
    const step = auditSteps(wf).find((s) => String(s.run ?? '').includes('test-entry.js all'))
    assert.ok(step !== undefined, '负对照的靶子不在了：审档的全量那一步')
    step.run = 'node tools/test-entry.js fast'
  })
  assert.ok(
    bad.some((m) => m.includes('audit：调了档')),
    `审档不跑全量兜底应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

/** 保护 payload 的问题清单。`jobNames` 是 workflow 里定义的 job/check 名（`name:` = job id）。 */
function inspectProtection(p: Record<string, unknown>, jobNames: string[]): string[] {
  const bad: string[] = []
  const rsc = p.required_status_checks as Record<string, unknown> | null | undefined
  if (rsc === null || rsc === undefined || typeof rsc !== 'object') return ['payload 里没有 required_status_checks']
  const contexts = rsc.contexts
  if (!Array.isArray(contexts)) return ['required_status_checks.contexts 不是数组']
  const names = contexts.map(String)
  if (JSON.stringify([...names].sort()) !== JSON.stringify(REQUIRED_CONTEXTS)) {
    bad.push(`必绿集合是 ${names.join(' · ')}——要的是 ${REQUIRED_CONTEXTS.join(' · ')}（快 + 真；审档只报不挡）`)
  }
  for (const c of names) {
    if (!jobNames.includes(c)) {
      bad.push(`必绿集合里的 ${c} 在 workflow 里没有同名的 job/check——这条 check 永远不会出现，PR 会被永远挡在门外`)
    }
  }
  if (p.required_pull_request_reviews !== null) {
    bad.push('payload 要求了 PR 审查——与「CI 挡的是合，不是写」（不要求 PR）的口径相反；要改就连口径一起改（人批）')
  }
  if (p.restrictions !== null && p.restrictions !== undefined) {
    bad.push('payload 加了推送限制（restrictions）——那会改掉"谁能推 main"，要改就得人批')
  }
  return bad
}

test('保护 payload：必绿集合 ↔ workflow 的 job 名逐一对照（错一个名就永远挡合）', () => {
  const wf = parseYamlSubset(YAML_TEXT)
  const jobNames = Object.keys(wf.jobs as Yaml).sort()
  const payload = JSON.parse(PROTECTION_JSON) as Record<string, unknown>
  const contexts = (payload.required_status_checks as Record<string, unknown>).contexts as string[]
  const table = contexts.map((c) => `${c}↔${jobNames.includes(c) ? 'job ' + c : '**没有这个 job**'}`)
  console.log(
    `必绿读数：context ${contexts.join(' · ')} ｜ ${table.join(' · ')} ｜ workflow 里的 job ${jobNames.join(' · ')}（audit 不在集合里）`,
  )
  assert.deepEqual(inspectProtection(payload, jobNames), [], '保护 payload 不过这组判据')
})

test('应用命令与 payload 成对：md 里那条 gh api 指的就是这一份文件', () => {
  const md = readFileSync(PROTECTION_MD, 'utf8')
  assert.ok(md.includes(PROTECTION_CMD), 'md 里那条应用命令漂了（或指到别的文件去了）')
  const contexts = (JSON.parse(PROTECTION_JSON) as Record<string, unknown>).required_status_checks as Record<string, unknown>
  for (const c of contexts.contexts as string[]) {
    assert.ok(md.includes('`' + c + '`'), `md 的对照表里少了 ${c}`)
  }
})

// 负对照：保护配置最常见的翻车是"名字错一个"——写错了不报错，只是 PR 永远合不进来。
function brokenProtection(mutate: (p: Record<string, unknown>) => void): string[] {
  const wf = parseYamlSubset(YAML_TEXT)
  const payload = JSON.parse(PROTECTION_JSON) as Record<string, unknown>
  mutate(payload)
  return inspectProtection(payload, Object.keys(wf.jobs as Yaml))
}

test('负对照：必绿集合里写错一个名字 → 当场红', () => {
  const bad = brokenProtection((p) => {
    ;(p.required_status_checks as Record<string, unknown>).contexts = ['fats', 'full']
  })
  assert.ok(
    bad.some((m) => m.includes('没有同名的 job')),
    `名字拼错应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：必绿集合漏了真档（只剩 fast）→ 当场红', () => {
  const bad = brokenProtection((p) => {
    ;(p.required_status_checks as Record<string, unknown>).contexts = ['fast']
  })
  assert.ok(
    bad.some((m) => m.includes('必绿集合是')),
    `漏了真档应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：把 audit 塞进必绿集合 → 当场红（审档只报不挡）', () => {
  const bad = brokenProtection((p) => {
    ;(p.required_status_checks as Record<string, unknown>).contexts = ['audit', 'fast', 'full']
  })
  assert.ok(
    bad.some((m) => m.includes('必绿集合是')),
    `审档进了必绿集合应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：payload 要求 PR 审查 → 当场红（与「挡的是合，不是写」的口径相反）', () => {
  const bad = brokenProtection((p) => {
    p.required_pull_request_reviews = { required_approving_review_count: 1 }
  })
  assert.ok(
    bad.some((m) => m.includes('审查')),
    `要求 PR 审查应当报出来，实得 ${JSON.stringify(bad)}`,
  )
})

test('负对照：没建模的 YAML 构造当场红（不静默忽略）', () => {
  assert.throws(() => parseYamlSubset('a: {b: c}\n'), /流式映射/)
  assert.throws(() => parseYamlSubset('a:\n\tb: c\n'), /制表符/)
  assert.throws(() => parseYamlSubset('a: 1\na: 2\n'), /键重复/)
  assert.throws(() => parseYamlSubset('a: &x 1\n'), /锚点/)
  // 正着来一条：自己这一套解析器的读数（`on` 不做 YAML 1.1 那种布尔解释）。
  assert.deepEqual(parseYamlSubset("on:\n  push:\n    branches: ['**']\n"), {
    on: { push: { branches: ['**'] } },
  })
})
