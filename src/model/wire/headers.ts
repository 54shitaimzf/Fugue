// 两条线协议各自要的头。出处：架构 § 10.1 的传输那一层 · § 10.3 的两条线。PLAN § 5.8 的 `B3`。
//
// **鉴权的头是"怎么发"的一部分，所以它归传输那一层**（`ModelRequest` 里没有凭据的位置，
// 这是 `B1` 断言 ④ 在签名上的兑现）。这一份与两个适配器挨着，是因为**头与线协议是一对**：
// 走哪条路，就带哪一套头；两份适配器各自那一套写在各自的模块里，不在这里按名字分岔。
//
// **凭据的值只从这里过一手**：进来的是 `authOf()` 取来的一个字符串，出去的是头里的一个值。
// 这一份不留副本、不落盘、不进事件。
import type { WireName } from '../contract.ts'

/**
 * 一条线协议要的头。`key` 是凭据的**值**（已经从工作区外取来了）。
 *
 * Messages 那条线：`x-api-key` + `anthropic-version`（版本是这条线协议的一部分，不是可选的
 * 装饰）。Chat Completions 那条线：`authorization: Bearer`。两条都带 `content-type`。
 *
 * DeepSeek 那一侧两条路吃同一个 key（`B0` 的读数：两条路都在、同一个凭据）——所以这里
 * 唯一的差别是**头叫什么名字**。
 */
export function wireHeader(wire: WireName, key: string): Readonly<Record<string, string>> {
  const common = { 'content-type': 'application/json', accept: 'text/event-stream' } as const
  switch (wire) {
    case 'anthropic-messages':
      return { ...common, 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    case 'openai-chat':
      return { ...common, authorization: `Bearer ${key}` }
  }
}

/**
 * Messages 那条线要的版本号。**它是这条线协议的一个取值，不是我们这边的开关**——
 * 写在这里而不是散在调用处，是为了让它只有一处（改它是一条线协议的事）。
 */
export const ANTHROPIC_VERSION = '2023-06-01'
