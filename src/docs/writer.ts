// 写作接缝的真档：**把三段文本发成一次真调用**（交接单 § 2.5 · 架构 § 9.9）。
//
// 这一份只做四件事：按配置与目录查模型声明 · 取凭据拼目标 · 发一次请求 · 把"没走完"翻译成
// 文档这一层的失败。它不认识页面、不认识清单——那些在 `build.ts`。
//
// **凭据只在真发请求那一步取**（架构 § 10.5 的口径）：`docs prompt` 与 `docs status` 走不到这里，
// 所以它们不需要 key。模型或凭据缺席按**文档失败**处理（交接单 § 3.5 末段），话里说出缺什么。
//
// **`thinking` 由调用方按趟给**：取证那一趟 `low`（只是选文件），写作那一趟用声明里的档。
// 输出预算取 `docs.maxTokens`，不写就用声明里那一档——32K 那一档是"想完再说"装得下的数。
import { getConfig } from '../config.ts'
import type { ConfigDoc } from '../config.ts'
import { modelDeclOf, readCatalog } from '../model/catalog.ts'
import type { Catalog } from '../model/catalog.ts'
import { authWith, promptCacheFor } from '../model/contract.ts'
import type { ModelDecl, ModelRequest, ThinkingLevel } from '../model/contract.ts'
import { callModel, targetAt } from '../model/http.ts'
import type { DocCall, DocCaller, DocCallRequest, ModelFacts } from './contract.ts'
import { DocsError } from './contract.ts'

export interface CallerOptions {
  /** 合并读过的配置（凭据引用表与 `round.model` 从这里来）。 */
  readonly config: ConfigDoc
  /** 命令行或配置给的模型键；都不给就按目录第一条（与 `--agent` 缺省走主线同一条口径）。 */
  readonly model?: string
  readonly credential?: string
}

/** 这一趟用哪个模型：命令行 > `docs.model` > `round.model` > 目录第一条。 */
export function resolvedModelId(config: ConfigDoc, model: string | undefined, cat: Catalog = readCatalog()): string {
  const fromConfig = getConfig(config, 'docs.model') ?? getConfig(config, 'round.model')
  const want = model ?? fromConfig
  if (want === undefined) {
    const first = Object.keys(cat.models)[0]
    if (first === undefined) throw new DocsError('model', '模型目录是空的：没有可用的模型声明')
    return first
  }
  if (typeof want !== 'string' || want === '') {
    throw new DocsError('model', `模型名要是一个非空字符串（目录里有的那几个），拿到的是 ${JSON.stringify(want)}`)
  }
  return want
}

/** 声明查不到时的话：**列出目录有的那几个**，不替人挑一个。 */
function declOf(config: ConfigDoc, model: string | undefined, cat: Catalog): ModelDecl {
  const id = resolvedModelId(config, model, cat)
  try {
    return modelDeclOf(id, cat)
  } catch (err) {
    throw new DocsError('model', (err as Error).message)
  }
}

/**
 * 一次请求的三区 + 调用配置。
 *
 * `promptCache` 必填（这条线的断点由谁声明，架构 § 10.2 的必固四条之一）；`tools` 一个都不带
 * ——写作这一趟不调工具，模型拿不到任何执行能力（交接单 § 2.1"不能自授能力"）。
 */
function requestOf(
  decl: ModelDecl,
  req: DocCallRequest,
  thinking: ThinkingLevel | undefined,
  maxTokens: number | undefined,
): ModelRequest {
  const enc = new TextEncoder()
  return {
    model: decl.model,
    zones: { A: enc.encode(req.system), B: enc.encode(req.context), C: enc.encode(req.task) },
    promptCache: promptCacheFor(decl.wire),
    call: {
      ...(decl.call.temperature === undefined ? {} : { temperature: decl.call.temperature }),
      maxTokens: maxTokens ?? decl.call.maxTokens,
      ...(thinking === undefined ? {} : { thinking }),
    },
  }
}

/**
 * 一台机器的模型声明（不取凭据）。**指纹只认这一份**：`build` 与 `status` 都从这里取"用了哪个模型"。
 */
export function modelFactsFromConfig(config: ConfigDoc, model: string | undefined, cat: Catalog = readCatalog()): ModelFacts {
  const decl = declOf(config, model, cat)
  return {
    id: decl.id,
    wireModel: decl.model,
    thinking: decl.call.thinking ?? null,
    temperature: decl.call.temperature ?? null,
    maxTokens: decl.call.maxTokens,
    contextLimit: decl.contextLimit,
  }
}

/** 建一个真档写作接缝。**声明在这里查一次**（写错模型名当场拒，不等到发请求）。 */
export function callerOf(o: CallerOptions): DocCaller {
  const cat = readCatalog()
  const decl = declOf(o.config, o.model, cat)
  let target: ReturnType<typeof targetAt> | null = null

  const targetNow = (): ReturnType<typeof targetAt> => {
    if (target !== null) return target
    let credential: string
    try {
      credential = authWith(decl.provider, getConfig(o.config, `credentials.${decl.provider}`), o.credential ?? null)
    } catch (err) {
      throw new DocsError('model', `模型或凭据缺席：${(err as Error).message}`)
    }
    target = targetAt(decl.id, credential, cat)
    return target
  }

  return {
    model: decl.id,
    wireModel: decl.model,
    ...(decl.call.thinking === undefined ? {} : { thinking: decl.call.thinking }),
    facts: {
      id: decl.id,
      wireModel: decl.model,
      thinking: decl.call.thinking ?? null,
      temperature: decl.call.temperature ?? null,
      maxTokens: decl.call.maxTokens,
      contextLimit: decl.contextLimit,
    },
    async call(req: DocCallRequest): Promise<DocCall> {
      const t = targetNow()
      const request = requestOf(decl, req, req.thinking ?? decl.call.thinking, req.maxTokens)
      const stream = callModel(t, request)
      try {
        // 把流走完：三区已经在请求里，事件这一层不再解释（文本由 `ledger().call` 给）。
        for await (const _e of stream.events) void _e
      } catch (err) {
        throw new DocsError('model', `模型调用失败：${(err as Error).message}`)
      }
      const ledger = stream.ledger()
      if (ledger.call === null) {
        throw new DocsError('model', `模型调用没走完：${ledger.failure ?? '没有回执'}`)
      }
      if (ledger.call.stop !== 'end-turn') {
        const why = ledger.call.stop === 'max-tokens' ? '输出预算用完了' : `结束原因是 ${String(ledger.call.stop)}`
        throw new DocsError('model', `模型没写完（${why}）：这一页不算成功，旧批次原样保留`)
      }
      const text = ledger.call.text
      if (text.trim() === '') throw new DocsError('model', '模型给了空正文')
      return { text, usage: ledger.call.usage }
    },
  }
}
