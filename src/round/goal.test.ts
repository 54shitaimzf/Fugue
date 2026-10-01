// `goalOf` 的断言：契约那一句人读的话逐变体钉住——`round/driver.ts` 导出它就是为了这一份。
// 出处：0.2.2 的变异审计里 `c.kind === …` 那两行一直是 survivor（`driver.test.ts` 归真档，
// 快档里没有文件执行它；归档 § 5.22 · § 5.23 的「遗留」一条）——这一份把两行收进快档的判据里。
//
// 跑法：cd ~/fugue && node --test src/round/goal.test.ts
//
//   ① implement → `c.goal` 原文
//   ② resolve：有 goal 用 goal · 没有 goal → `解 N 条冲突`（N 是 `conflictPaths` 的条数）
//   ③ investigate → `查清 <question>`**不取 `c.goal`**——三个变体都带 `goal` 那一格，
//      所以这一条是真负对照：取错格的话，另两条断言看不出来
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CommitId, RelPath } from '../terms.ts'
import type { ImplementContract, InvestigateContract, ResolveContract } from '../contract/types.ts'
import { goalOf } from './driver.ts'

/** 三份最小契约：`goalOf` 只读 `kind` `goal` `question` `conflictPaths` 那几格。 */
function implement(goal: string): ImplementContract {
  return {
    kind: 'implement',
    id: 'r1.implement.1',
    agent: 'agent-1',
    branch: 'b/1',
    goal,
    ownedPaths: [] as readonly RelPath[],
    deliverables: [],
    assertions: [{ action: 'test', name: '过' }],
    seed: [] as readonly RelPath[],
    actionOutputs: {},
  }
}

function investigate(goal: string, question: string): InvestigateContract {
  return {
    kind: 'investigate',
    id: 'r1.investigate.1',
    agent: 'agent-1',
    branch: 'b/2',
    goal,
    question,
    evidenceRequired: [{ artifact: 'evidence/agent-1/current-state' as RelPath, note: 'current-state' }],
    seed: [] as readonly RelPath[],
  }
}

function resolve(goal: string | undefined, conflictPaths: readonly RelPath[]): ResolveContract {
  return {
    kind: 'resolve',
    id: 'r1.resolve.1',
    agent: 'agent-1',
    branch: 'b/3',
    // `goal` 类型上是必填——这里故意喂 `undefined` 走「没有 goal」那一档：日志里读回来的
    // 契约可能缺它，`??` 那一支就是为这一档写的。
    goal: goal as string,
    base: 'beefcafe' as CommitId,
    conflictPaths,
    assertions: [{ action: 'test', name: '过' }],
  }
}

test('① implement：那一句就是它自己的 goal', () => {
  assert.equal(goalOf(implement('把解析器拆出来')), '把解析器拆出来')
})

test('② resolve：有 goal 用 goal · 没有 goal 报「解 N 条冲突」', () => {
  const conflicts = ['src/a.ts', 'src/b.ts'] as readonly RelPath[]
  assert.equal(goalOf(resolve('照冲突报告解', conflicts)), '照冲突报告解')
  assert.equal(goalOf(resolve(undefined, conflicts)), '解 2 条冲突')
})

test('③ investigate：那一句是「查清 <question>」，不取 goal', () => {
  const c = investigate('给一份现状', 'src/parse.ts 被谁引用？')
  assert.equal(goalOf(c), '查清 src/parse.ts 被谁引用？')
  assert.notEqual(goalOf(c), c.goal, 'investigate 不许拿 goal 当那一句')
})
