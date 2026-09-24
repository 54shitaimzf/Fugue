// 一份表：线协议的名字 → 那一份适配器。PLAN § 5.8 的 `B2` 的第三个接口。
//
// **为什么它是单独一份而不是写进 `contract.ts`**：`contract.ts` 是**声明的值域持有者**，它认识
// "有哪两条线协议"（`WIRE_NAMES`）与"各自的路那一段"（`WIRES`），但它**不认识字节**——那是
// `B2` 这一层的事。于是这里由**每个适配器自己报名字**建表（`wireOf().name`），而不是在这里再写
// 一遍字符串：写两遍就有两处会漂，而漂了不报错，只是取到另一份实现。
//
// **取不到就当场拒，并列出有的。** 一个不存在的线协议名是"打错了一个字"，不是"以后再支持"
// （同 `modelDeclOf` 的口径，`B0` 的断言 ②）：替它挑一个默认的会让一条本该报错的请求发出去。
import type { WireName } from '../contract.ts'
import { ModelDeclError } from '../contract.ts'
import type { WireAdapter } from './stream.ts'
import { wireOf as anthropicWireOf } from './anthropic.ts'
import { wireOf as openaiWireOf } from './openai.ts'

export { WIRE_NAMES } from '../contract.ts'

/** 两条线协议的表。**键域与 `WIRE_NAMES` 同域**（下面那一条载入时的核对保证）。 */
export const WIRES: Readonly<Record<WireName, WireAdapter>> = {
  'anthropic-messages': anthropicWireOf(),
  'openai-chat': openaiWireOf(),
}

/**
 * 按名字取适配器。**不认识的当场拒并列出有的**（PLAN § 5.8 的 `B2` 断言 ③）。
 *
 * 拒的是 `ModelDeclError`——**线协议名是声明里的一栏**（`ModelDecl.wire`），所以"盘上写了这个
 * 名字、而这一版没有这条线"与"声明里打错了一个字"是同一件事，报的话也该是同一句。
 *
 * 参数收 `string` 而不是 `WireName`：名字从盘上（声明 · 夹具 · 命令行）来的时候，类型系统不在场，
 * 所以那道检查必须在运行时——签名收窄只会在编译期挡住自己人。
 */
export function wireNamed(name: string): WireAdapter {
  const one = (WIRES as Record<string, WireAdapter | undefined>)[name]
  if (one === undefined) {
    throw new ModelDeclError(`没有这一种线协议：${JSON.stringify(name)}（有的两种是 ${Object.keys(WIRES).join(' · ')}）`)
  }
  return one
}

/** 这条线上的那一份适配器报的名字是不是表里的键——**载入时对一次**，两处漂了当场炸。 */
export class WireRegistryError extends Error {}

for (const [key, adapter] of Object.entries(WIRES)) {
  if (adapter.name !== key) {
    throw new WireRegistryError(`表里的键 ${JSON.stringify(key)} 与适配器自报的名字 ${JSON.stringify(adapter.name)} 对不上`)
  }
}
