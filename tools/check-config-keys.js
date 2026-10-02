#!/usr/bin/env node
// Check actual top-level domains and literal consumers against configuration documentation.
import { fileURLToPath } from 'node:url'
import { checkCliHelp, configDocsProblems, sourceConfigKeys } from './config-key-docs.ts'
import { USAGE } from '../src/cli/shared.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const keys = sourceConfigKeys(root)
const problems = [...configDocsProblems(root), ...checkCliHelp(USAGE)]
for (const problem of problems) console.error(problem)
if (problems.length > 0) process.exitCode = 1
else console.log(`配置文档：顶层键域与 ${keys.length} 个已知实际读取键一致；动态成员按族说明，不定义新 schema`)
