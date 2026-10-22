// 产物形状检查（`tools/check-docs.js`）：**对着落盘之后的产物再核一遍**。
//
// 判据来自路线图 0.5.2 那一行「文档形状检查进 check-*」与交接单 § 6.1 的形状那一半：
// 清单 · 批次 · 地址 · 自足四组，每一组各配一个负对照（红得起来才是断言）。
// 生成时那一道校验决定"要不要落盘"；这一份看的是落盘之后——手改、半截拷贝、旧批次拼新页面
// 都只在这一层看得见。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { commitFiles, tmpRepo } from './helpers/docs-repo.ts'
import { tmpDir } from './helpers/tmp.ts'
import { openTruth } from '../src/truth/truth.ts'
import { buildDocs } from '../src/docs/build.ts'
import type { DocCaller } from '../src/docs/contract.ts'

const REPO = join(import.meta.dirname, '..')
const TOOL = join(REPO, 'tools', 'check-docs.js')

function run(dir?: string): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [TOOL, ...(dir === undefined ? [] : [dir])], { cwd: REPO, encoding: 'utf8' })
  return { status: r.status ?? -1, stdout: r.stdout ?? '' }
}

const BODY = [
  '## 这一页 {#top}',
  '',
  '正文。'.repeat(300),
  '',
  '见 [本页](#top)。',
].join('\n')

const caller: DocCaller = {
  model: 'fake/model',
  wireModel: 'fake',
  async call(req) {
    if (req.system.includes('只输出一个 JSON 对象')) return { text: '{"paths":[]}', usage: null }
    return { text: BODY, usage: null }
  },
}

async function built(): Promise<{ root: string; docs: string }> {
  const root = tmpRepo('fugue-check-docs-')
  await commitFiles(root, { 'README.md': '# demo\n', 'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }) }, [], 'refs/heads/main')
  const truth = openTruth(root)
  try {
    const out = await buildDocs({
      root,
      config: {
        docs: {
          pages: [
            { id: 'start', title: '开始', source: 'README.md', audience: '新人', role: '上手', prompt: '最短路径' },
          ],
        },
      },
      truth,
      caller,
      materials: { kind: 'manual', note: '测试' },
      now: () => new Date('2026-10-22T00:00:00.000Z'),
    })
    assert.ok(out.ok, JSON.stringify(out))
  } finally {
    truth.close()
  }
  return { root, docs: join(root, '.fugue', 'docs') }
}

test('① 一份刚生成的产物：四组都过，退 0', async () => {
  const { docs } = await built()
  const r = run(docs)
  assert.equal(r.status, 0, r.stdout)
  assert.ok(r.stdout.includes('全部通过'), r.stdout)
  for (const want of ['清单', '批次', '地址', '自足', '主题与清单一致', '页脚带完整提交与指纹']) {
    assert.ok(r.stdout.includes(want), `输出里缺：${want}`)
  }
  console.log(`① 读数：${r.stdout.split('\n').filter((l) => l.includes('ok   ')).length} 条 ok · 退 0`)
})

test('② 负对照：清单里的一份文件被删 → 当场红（并说出是哪一份）', async () => {
  const { docs } = await built()
  rmSync(join(docs, 'content', 'start.md'))
  const r = run(docs)
  assert.equal(r.status, 1)
  assert.ok(r.stdout.includes('content/start.md 不在产物里'), r.stdout)
  console.log('② 读数：退 1 · 指名 content/start.md')
})

test('③ 负对照：页面里多一条死锚点 → 当场红（地址那一组）', async () => {
  const { docs } = await built()
  const page = join(docs, 'start.html')
  writeFileSync(page, readFileSync(page, 'utf8').replace('</main>', '<p><a href="#nope">坏锚点</a></p></main>'))
  const r = run(docs)
  assert.equal(r.status, 1)
  assert.ok(r.stdout.includes('不存在的锚点：#nope'), r.stdout)
  console.log('③ 读数：退 1 · 指名 start.html 的 #nope')
})

test('④ 负对照：目录里多一份清单没写的 HTML → 当场红（批次那一组）', async () => {
  const { docs } = await built()
  writeFileSync(join(docs, 'stray.html'), '<html><body><h1>多出来的</h1></body></html>')
  const r = run(docs)
  assert.equal(r.status, 1)
  assert.ok(r.stdout.includes('清单没写的 HTML：stray.html'), r.stdout)
  console.log('④ 读数：退 1 · 指名 stray.html')
})

test('⑤ 还没生成过：说一句就退 0（不是失败——那是"还没做"）', () => {
  const empty = tmpDir('fugue-check-docs-empty-')
  mkdirSync(empty, { recursive: true })
  const r = run(join(empty, 'nope'))
  assert.equal(r.status, 0)
  assert.ok(r.stdout.includes('还没生成过'), r.stdout)
  console.log('⑤ 读数：目录不在 → info 一句 · 退 0')
})
