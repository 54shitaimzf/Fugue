// 一份**像样的装配状态**：给夹具生成与 B3 的断言共用的一处。
//
// 为什么它是一份共享的小东西、而不是两处各写一遍：B3 的断言里那句"这次装配出来的请求与夹具里
// 那份逐字节相同"只有在**两处喂进同一个状态**时才成立。两份各自写的状态会漂，而漂了不报错，
// 只是断言变成"两次不同的装配恰好对得上"——那种断言有时候会通过。
//
// 它与 `B1` 的 `stateWith` 是同一个形状（十二段都不空：空值会让"只追加"那类读数量不出东西），
// 而那边那一份留在 `contract.test.ts` 里不动：`B1` 的读数（`723 / 7171` 字节 · 三区 `115/472/20`）
// 是照着它取的，换一份就换了读数。**两处的差别只有"goal 那句话"**：这边写的是 B3 这一站的事，
// 那边写的是 B1 那一站的事——字节不同是正常的，两处都不需要对方那一份。
//
// 它进 `src/` 而不是 `tools/`：测试与生成器都要 import 它，而 `tools/` 底下的东西按纪律是
// "取证用的，不是产品的一部分"。这一份不碰模型、不碰网络、不碰凭据，只是一份状态值。
import type { AssembleState } from '../assemble/sources.ts'
import { emptyState } from '../assemble/sources.ts'

/** 一份像样的状态：三区都不空。 */
export function fixtureState(step: number): AssembleState {
  return {
    ...emptyState(),
    policy: '# 项目方针\n\n- 一条方针。\n',
    system: { platform: 'linux', net: 'none' },
    codeTree: ['src/model/http.ts', 'src/model/session.ts'],
    goal: '把模型这一路接上：录一份夹具，回放得出同一串事件。',
    files: [
      { path: 'src/model/http.ts', text: '// 唯一碰网的那一处。\n' },
      { path: 'src/model/session.ts', text: '// 录一份夹具 · 回放一份夹具。\n' },
    ],
    commits: ['75b0e30 B0 · 模型与提供方的声明', 'bf65726 B1 · 调用的边界'],
    handoff: '',
    task: {
      goal: '把模型这一路接上。',
      question: '',
      deliverables: ['src/model/http.ts'],
      evidenceRequired: ['node --test src/model/http.test.ts'],
      assertions: ['上游分片不丢不重', '回放两次请求体逐字节相同'],
    },
    distill: '',
    recent: '',
    runtime: `第 ${step} 步。`,
    signals: [`sig-${step + 1}`],
    lastStep: step === 0 ? '' : `第 ${step - 1} 步的结果。`,
  }
}
