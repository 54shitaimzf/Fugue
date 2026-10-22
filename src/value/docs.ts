// `fugue docs build|status|prompt`：文档这一族的命令面（交接单 § 2.3 · § 3.5 · § 5.2）。
//
// 三条命令都走**值层**（架构 § 9.6「命令本身是一份值层，CLI 是它的第一个壳」）：
// 人读那一面与 `--json` 那一面是同一格值的两条投影，serve 那一侧因此也拿得到同一份（§ 9.11）。
//
// 失败的三档与 § 9.8 对得上：配置写错/来源缺失/模型失败 → 1（做不成）；参数缺了 → 2（敲错了）；
// 成功 → 0。**生成失败时当前可读产物留在原处**（publish 那一层保证），话里指给读者。
import { ConfigError, readConfig } from '../config.ts'
import { openTruth } from '../truth/truth.ts'
import type { Truth } from '../truth/contract.ts'
import type { ConfigDoc } from '../config.ts'
import { pageOf, parseDocs } from '../docs/config.ts'
import { DocsError, docsRootOf } from '../docs/contract.ts'
import type { Materials, StatusReport } from '../docs/contract.ts'
import { buildDocs } from '../docs/build.ts'
import { sourceTextOf, treeFactsOf } from '../docs/facts.ts'
import { shortFingerprint } from '../docs/fingerprint.ts'
import { promptTextOf } from '../docs/prompt.ts'
import { statusOf } from '../docs/status.ts'
import { THEME_IDS, themeOf } from '../docs/theme.ts'
import { callerOf, resolvedModelId } from '../docs/writer.ts'
import { CommandError, UsageError, ok } from './types.ts'
import type { ValueArgs, ValueResult } from './types.ts'

/** 千分位（自己拼：不依赖宿主 locale，两条脸逐字节稳定）。 */
function num(n: number | null): string {
  if (n === null) return '（没量到）'
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 一条旗标的值。**给了却没值**是用法错（与 `--root` 那条同一把尺子）。 */
function str(a: ValueArgs, name: string): string | undefined {
  const v = a.flags.get(name)
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v === '') throw new UsageError(`--${name} 需要一个值：--${name} <值>`)
  return v
}

/**
 * 值层把**命令之后的全部位置参数**原样递进来（`args = positional.slice(1)`），所以子命令
 * 自己是 `args[0]`。这一处把它剥掉，顺手拒掉多余的参数——`docs build` 收位置参数会让
 * "写错了一格"看起来像"跑了但没效果"。
 */
function restOf(a: ValueArgs, verb: string): readonly string[] {
  if (a.args[0] !== verb) throw new Error(`值层键与子命令对不上：${verb} vs ${String(a.args[0])}`)
  return a.args.slice(1)
}

function noExtra(a: ValueArgs, verb: string): void {
  const rest = restOf(a, verb)
  if (rest.length > 0) {
    throw new UsageError(`docs ${verb} 不带位置参数，多出来的是：${rest.join(' ')}`)
  }
}

/** 配置读不动（坏 JSON · 未知顶层键）是"做不成"，不是用法错。 */
async function configOf(root: string): Promise<ConfigDoc> {
  try {
    return await readConfig(root)
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message)
    throw err
  }
}

/** 文档这一层的失败 → 命令面的一档。**原因原样带出来**，不吞。 */
function failOf(err: unknown, root: string): never {
  if (err instanceof DocsError) {
    const stage = STAGES[err.at] ?? err.at
    throw new CommandError(`文档（${stage}）：${err.message}`, {
      hint: `产物目录 ${docsRootOf(root)}/；生成用 fugue docs build，状态用 fugue docs status`,
    })
  }
  throw err
}

/** 阶段名：给"失败落在哪一格"一个说得出的话。 */
const STAGES: Readonly<Record<string, string>> = {
  config: '配置',
  facts: '材料',
  model: '模型',
  render: '校验',
  publish: '保存',
  build: '生成',
}

/** 一次生成：人读那一面先说"现在能做什么"，机器面与返回的结构同一份。 */
export async function docsBuildValue(a: ValueArgs): Promise<ValueResult> {
  noExtra(a, 'build')
  const at = str(a, 'at')
  const theme = str(a, 'theme')
  const model = str(a, 'model')
  const credential = str(a, 'credential')
  if (theme !== undefined && themeOf(theme) === null) {
    throw new UsageError(`--theme 取 ${THEME_IDS.join(' / ')} 之一，拿到的是 ${JSON.stringify(theme)}`)
  }
  const config = await configOf(a.root)
  const materials: Materials =
    at === undefined
      ? {
          kind: 'manual',
          note: '手动 fugue docs build：来源与事实取当前提交（refs/heads/main），定义与主题取当前工作区配置',
        }
      : {
          kind: 'manual',
          note: `手动 --at ${at}：来源与事实取指定提交，定义与主题取当前工作区配置——回答"用今天的计划看那一版代码是什么样"`,
        }

  const truth = openTruth(a.root)
  try {
    let caller
    try {
      caller = callerOf({
        config,
        ...(model === undefined ? {} : { model }),
        ...(credential === undefined ? {} : { credential }),
      })
    } catch (err) {
      failOf(err, a.root)
    }
    const out = await buildDocs({
      root: a.root,
      config,
      truth,
      caller,
      materials,
      ...(at === undefined ? {} : { at }),
      ...(theme === undefined ? {} : { theme }),
      evidence: !a.flags.has('no-evidence'),
    })
    if (!out.ok) {
      throw new CommandError(`文档生成失败（${STAGES[out.at_stage] ?? out.at_stage}）：${out.reason}`, {
        hint: `当前可读产物留在 ${docsRootOf(a.root)}/（之前生成过的话），旧批次没有被替换；处理好再跑一次 fugue docs build`,
      })
    }
    const lines = [
      `文档：${out.pages.length} 页已生成 —— 打开 ${out.docsDir}/index.html 就能读（file:// 即可，不用起服务）`,
      `  提交 ${out.commitShort}（${out.commit}）· 版本 ${out.version ?? '提交里没有可读的版本号'} · 指纹 ${shortFingerprint(out.fingerprint)}`,
      `  视觉语言 ${out.theme} · 模型 ${out.model} · 调用 ${out.usage.calls} 次 · ${num(out.usage.inputTokens)} 入 / ${num(out.usage.outputTokens)} 出`,
      `  材料：${out.materials.note}`,
      ...out.pages.map((p) => `  · ${p.title}（${p.out}）${p.headings.length} 节`),
    ]
    if (out.notes.length > 0) {
      lines.push(`  待复核：${out.notes.length} 处`)
      for (const n of out.notes.slice(0, 8)) lines.push(`    - ${n}`)
      if (out.notes.length > 8) lines.push(`    …还有 ${out.notes.length - 8} 处，见清单 pages[].notes`)
    }
    return ok({
      value: {
        ok: true as const,
        commit: out.commit,
        commitShort: out.commitShort,
        fingerprint: out.fingerprint,
        theme: out.theme,
        model: out.model,
        version: out.version,
        docsDir: out.docsDir,
        index: `${out.docsDir}/index.html`,
        generatedAt: out.generatedAt,
        materials: out.materials,
        usage: out.usage,
        notes: out.notes,
        pages: out.pages.map((p) => ({ id: p.id, title: p.title, out: p.out, headings: p.headings.length })),
      },
      faces: { json: JSON.stringify({ ok: true, commit: out.commit, commitShort: out.commitShort, fingerprint: out.fingerprint, theme: out.theme, model: out.model, version: out.version, docsDir: out.docsDir, index: `${out.docsDir}/index.html`, generatedAt: out.generatedAt, materials: out.materials, usage: out.usage, notes: out.notes, pages: out.pages }), human: lines.join('\n') },
    })
  } catch (err) {
    failOf(err, a.root)
  } finally {
    truth.close()
  }
}

/** 两栏分开报：现有产物对应哪一版 · 最近一次生成成没成（交接单 § 3.5）。 */
export async function docsStatusValue(a: ValueArgs): Promise<ValueResult> {
  noExtra(a, 'status')
  const config = await configOf(a.root)
  // **能力没启用就直说**（交接单 § 3.5 末段）：不是"未生成"，是"这份配置里没有文档这一节"。
  try {
    if (parseDocs(config) === null) {
      throw new DocsError('config', '文档能力没有启用：工作区配置里没有 docs 键（架构 § 15.3.a）——收口只做归并与验收')
    }
  } catch (err) {
    failOf(err, a.root)
  }
  const truth = openTruth(a.root)
  try {
    let model: string
    try {
      model = resolvedModelId(config, undefined)
    } catch (err) {
      failOf(err, a.root)
    }
    const report = await statusOf({ root: a.root, config, truth, model })
    return ok({ value: report, faces: { json: JSON.stringify(report), human: statusLines(report) } })
  } catch (err) {
    if (err instanceof DocsError) {
      throw new CommandError(`文档状态读不出来（${STAGES[err.at] ?? err.at}）：${err.message}`, {
        hint: `产物目录：${docsRootOf(a.root)} —— 清单损坏时重新生成一次：fugue docs build`,
      })
    }
    throw err
  } finally {
    truth.close()
  }
}

/** 状态的人读面。**先说结论**，再说两栏各自的事实。 */
function statusLines(r: StatusReport): string {
  const lines: string[] = []
  const a = r.artifact
  if (a.state === 'missing') {
    lines.push('文档：未生成')
    if (a.now.error !== null) lines.push(`  当前这一版读不出来：${a.now.error}`)
    else lines.push(`  定义已就绪，对应的提交 ${a.now.commit?.slice(0, 12) ?? '（还没提交）'}`)
    lines.push(`  生成：fugue docs build　产物目录：${r.docsDir}`)
  } else if (a.state === 'current') {
    lines.push(`文档：最新 —— 产物对应 ${a.commitShort ?? a.commit?.slice(0, 12) ?? '?'}`)
    lines.push(`  ${r.artifact.pages} 页 · 生成于 ${a.generatedAt ?? '?'} · 视觉语言 ${a.theme ?? '?'}`)
    lines.push(`  指纹 ${shortFingerprint(a.fingerprint ?? '')}`)
    lines.push(`  入口 ${r.docsDir}/index.html`)
  } else {
    lines.push(`文档：过期 —— 产物对应 ${a.commitShort ?? a.commit?.slice(0, 12) ?? '?'}，当前提交 ${a.now.commit?.slice(0, 12) ?? '（读不出来）'}`)
    if (a.now.error !== null) lines.push(`  当前这一版读不出来：${a.now.error}`)
    if (a.fingerprint !== null && a.now.fingerprint !== null) {
      lines.push(`  指纹：产物 ${shortFingerprint(a.fingerprint)} · 当前 ${shortFingerprint(a.now.fingerprint)}`)
    }
    if (a.integrity.length > 0) lines.push(`  与清单不一致：${a.integrity.slice(0, 6).join(' · ')}${a.integrity.length > 6 ? ` …共 ${a.integrity.length} 份` : ''}`)
    lines.push('  重新生成：fugue docs build（旧批次在生成成功之前一直留在原处）')
    lines.push(`  入口 ${r.docsDir}/index.html（读到的是旧的那一版）`)
  }
  if (r.attempt === null) {
    lines.push('最近一次生成：还没有记录')
  } else if (r.attempt.ok) {
    lines.push(`最近一次生成：成功（提交 ${r.attempt.commit?.slice(0, 12) ?? '?'} · ${r.attempt.pages} 页 · ${r.attempt.at}）`)
  } else {
    const stage = r.attempt.at_stage === null ? '' : `${STAGES[r.attempt.at_stage] ?? r.attempt.at_stage}·`
    lines.push(`最近一次生成：失败（${stage}${r.attempt.reason ?? '没有原因'}）`)
    lines.push(`  尝试的是 ${r.attempt.commit?.slice(0, 12) ?? '（还没定提交）'} · ${r.attempt.at}`)
    if (r.attempt.materials !== null) lines.push(`  当时的材料：${r.attempt.materials.note}`)
  }
  return lines.join('\n')
}

/**
 * `docs prompt <id>`：打出这一份的**实际写作输入**（定义 · 来源 · 本次事实 · 输出约定）。
 * 它停在检查与交接这一步：不调模型、不写盘（交接单 § 2.3 末段）。
 */
export async function docsPromptValue(a: ValueArgs): Promise<ValueResult> {
  const rest = restOf(a, 'prompt')
  const id = rest[0]
  if (id === undefined || id === '') {
    throw new UsageError('docs prompt 需要 <id>：fugue docs prompt <id>（id 见 fugue docs status 的清单或配置）')
  }
  if (rest.length > 1) throw new UsageError(`docs prompt 只收一个 <id>，多出来的是：${rest.slice(1).join(' ')}`)
  const config = await configOf(a.root)
  let plan
  try {
    plan = parseDocs(config)
    if (plan === null) {
      throw new DocsError('config', '文档能力没有启用：工作区配置里没有 docs 键（架构 § 15.3.a）')
    }
    const def = pageOf(plan, id)
    const theme = themeOf(plan.theme)
    if (theme === null) throw new DocsError('config', `配置 docs.theme 写的 ${JSON.stringify(plan.theme)} 不在目录里`)
    const truth: Truth = openTruth(a.root)
    try {
      const commit = await truth.resolve('refs/heads/main' as never)
      const facts = await treeFactsOf(truth, commit, plan)
      // 这一条命令**只关心被点名的那一份**：别的来源缺失不该拦住"看这一份的写作输入"。
      const mine = facts.missing.find((m) => m.id === id)
      if (mine !== undefined) {
        throw new DocsError('facts', `来源缺失：文档 ${id} 的 source 指向 ${mine.source}，而提交 ${String(commit).slice(0, 12)} 里没有这一份`)
      }
      const source = await sourceTextOf(truth, commit, id, def.source)
      const text = promptTextOf({
        page: def,
        plan,
        facts,
        source,
        theme,
        materials: {
          kind: 'manual',
          note: '手动 docs prompt：只有定义、来源与事实；没有本轮变化，也没有取证摘录（这一条命令不调模型）',
        },
      })
      return ok({
        value: {
          id: def.id,
          title: def.title,
          out: def.out,
          source: def.source,
          audience: def.audience,
          role: def.role,
          prompt: def.prompt,
          theme: theme.id,
          commit: String(commit),
          commitShort: facts.commitShort,
          version: facts.version,
          text,
        },
        faces: { json: JSON.stringify({ id: def.id, title: def.title, out: def.out, source: def.source, audience: def.audience, role: def.role, prompt: def.prompt, theme: theme.id, commit: String(commit), commitShort: facts.commitShort, version: facts.version, text }), human: text },
      })
    } finally {
      truth.close()
    }
  } catch (err) {
    failOf(err, a.root)
  }
}
