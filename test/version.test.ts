// 版本收口的两条断言（路线图 §1 末句：版本只在收口点跳，CHANGELOG 跟版本走）。两条都是
// "少了不报错"的那一类：忘了跳 package.json、或者跳了版本忘了写 CHANGELOG，全程没人红。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

const REPO = join(import.meta.dirname, '..')
const VERSION = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

test('CHANGELOG 跟版本走：[未发布] 在最前，最新一段 == package.json', () => {
  const md = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8')
  const heads = [...md.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1])
  console.log(`版本读数：package.json ${VERSION} · CHANGELOG 段 ${heads.join(' · ')}`)
  assert.equal(heads[0], '未发布', '第一段该是 [未发布]')
  assert.equal(heads[1], VERSION, '最新版本段与 package.json 对不上——收了口没写 CHANGELOG，或者反过来')
})

test('版本唯一出处：这个号不许硬编码在 src/ 与 bin/ 里', () => {
  const files = [...walk(join(REPO, 'src')), ...walk(join(REPO, 'bin'))]
  const hits = files.filter((f) => readFileSync(f, 'utf8').includes(VERSION)).map((f) => relative(REPO, f))
  assert.deepEqual(hits, [], `版本号只许住在 package.json：${hits.join(' · ')}`)
})
