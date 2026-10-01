#!/usr/bin/env node
// 临时离线兼容输入：只适配新搜索描述，历史真录制/响应不改，不碰网络或凭据。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adaptSearchWire } from '../test/helpers/search-wire.ts'
const source = fileURLToPath(new URL('../src/cli/__fixture__/wire-in/',import.meta.url))
const target = mkdtempSync(join(tmpdir(),'fugue-search-wire-offline-'))
console.log(JSON.stringify({ directory:target,...adaptSearchWire(source,target) },null,2))
