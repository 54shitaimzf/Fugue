// 文档这一族的命令面：**两脸一致 · 退出码四档 · 未配置直说**。
//
// 判据来自交接单 § 2.3（`docs prompt` 的实际输入）· § 3.5（未配置 · 状态两栏 · 失败退出码）·
// § 6.1 第 7、8 条。这一份走真入口（`runCli`）：从 argv 到值层到两条脸，中间不绕路。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runCli, stdinOf } from '../../test/helpers/run-cli.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { tmpRepo } from '../../test/helpers/docs-repo.ts'

/** 系统根换到临时目录：文档这三条不该取决于这台机器上配过哪些模型。 */
const SYS = tmpDir('fugue-docs-sys-')
process.env.FUGUE_SYSTEM_DIR = SYS

const PAGES = [
  { id: 'start', title: '开始', source: 'README.md', audience: '第一次用的人', role: '跑通第一条命令', prompt: '最短路径', out: 'start.html' },
  { id: 'arch', title: '架构', source: 'design/A.md', audience: '维护者', role: '理解边界', prompt: '讲约束' },
]

/** 一个**有提交**的仓库：`refs/heads/main` 指向含 README 与 design/A.md 的那一条。 */
async function seeded(): Promise<{ root: string; commit: string }> {
  const root = tmpRepo('fugue-docs-cli-')
  mkdirSync(join(root, 'design'), { recursive: true })
  assert.equal((await runCli(['--root', root, 'write', 'README.md', '--stdin'], stdinOf('# demo\n\n这是第一版。\n'))).code, 0)
  assert.equal((await runCli(['--root', root, 'write', 'design/A.md', '--stdin'], stdinOf('# 架构\n\n边界。\n'))).code, 0)
  const commit = await runCli(['--root', root, 'commit', '-m', 'seed'])
  assert.equal(commit.code, 0, commit.stderr)
  // 提交号从 git 那一侧取（CLI 的 revs 给的是修订点，不是提交号）。
  const head = spawnSync('git', ['rev-parse', 'refs/heads/main'], { cwd: root, encoding: 'utf8' })
  assert.equal(head.status, 0, head.stderr)
  return { root, commit: head.stdout.trim() }
}

async function setDocs(root: string): Promise<void> {
  const a = await runCli(['--root', root, 'config', 'set', 'docs.pages', JSON.stringify(PAGES)])
  assert.equal(a.code, 0, a.stderr)
  const b = await runCli(['--root', root, 'config', 'set', 'docs.theme', 'primer'])
  assert.equal(b.code, 0, b.stderr)
}

test('① `docs` 家族：没有子命令与不认识的子命令都退 2，并列出三条', async () => {
  const { root } = await seeded()
  for (const argv of [['--root', root, 'docs'], ['--root', root, 'docs', 'wat']]) {
    const r = await runCli([...argv, '--json'])
    assert.equal(r.code, 2)
    assert.ok(r.stderr.includes('docs.build') || r.stderr.includes('build（生成）'), r.stderr)
  }
  const badFlag = await runCli(['--root', root, '--json', 'docs', 'status', '--theme', 'x'])
  assert.equal(badFlag.code, 2, '表外开关当场退 2')
  console.log('① 读数：docs / docs wat / docs status --theme 三条都是 2')
})

test('② 未配置：三条命令都直说"没有 docs 键"（不是"未生成"）', async () => {
  const { root } = await seeded()
  for (const sub of [['status'], ['prompt', 'start']]) {
    const r = await runCli(['--root', root, '--json', 'docs', ...sub])
    assert.equal(r.code, 1, r.stderr)
    assert.ok(r.stderr.includes('没有 docs 键'), r.stderr)
  }
  console.log('② 读数：status / prompt 都退 1，话里带"没有 docs 键"')
})

test('③ `docs prompt <id>`：打出实际写作输入（三段 + 来源正文），两条脸同源', async () => {
  const { root } = await seeded()
  await setDocs(root)
  const human = await runCli(['--root', root, 'docs', 'prompt', 'start'])
  assert.equal(human.code, 0, human.stderr)
  for (const want of ['# A 区', '# B 区', '# C 区', '给谁看（audience）：第一次用的人', '这是第一版。', '只输出 markdown 正文']) {
    assert.ok(human.stdout.includes(want), `人读面缺：${want}`)
  }
  const json = await runCli(['--root', root, '--json', 'docs', 'prompt', 'start'])
  assert.equal(json.code, 0, json.stderr)
  const v = JSON.parse(json.stdout) as { id: string; text: string; theme: string; commit: string; source: string }
  assert.equal(v.id, 'start')
  assert.equal(v.theme, 'primer')
  assert.equal(v.source, 'README.md')
  assert.equal(v.text, human.stdout.trimEnd(), '两条脸是同一份文本')
  console.log(`③ 读数：${v.text.length} 字符 · 三段齐全 · commit ${v.commit.slice(0, 12)}`)
})

test('④ `docs prompt`：缺 id 退 2；id 不认识退 1 并列出有哪几份', async () => {
  const { root } = await seeded()
  await setDocs(root)
  const noId = await runCli(['--root', root, '--json', 'docs', 'prompt'])
  assert.equal(noId.code, 2)
  const unknown = await runCli(['--root', root, '--json', 'docs', 'prompt', 'nope'])
  assert.equal(unknown.code, 1)
  assert.ok(unknown.stderr.includes('start') && unknown.stderr.includes('arch'), unknown.stderr)
  console.log('④ 读数：缺 id → 2 · 不认识 → 1（话里列出 start · arch）')
})

test('⑤ `docs status`：未生成那一档说清当前提交与入口，机器面是同一份值', async () => {
  const { root } = await seeded()
  await setDocs(root)
  const human = await runCli(['--root', root, 'docs', 'status'])
  assert.equal(human.code, 0, human.stderr)
  assert.ok(human.stdout.includes('文档：未生成'), human.stdout)
  assert.ok(human.stdout.includes('fugue docs build'))
  const json = await runCli(['--root', root, '--json', 'docs', 'status'])
  assert.equal(json.code, 0, json.stderr)
  const v = JSON.parse(json.stdout) as { artifact: { state: string; now: { commit: string } }; attempt: unknown; docsDir: string }
  assert.equal(v.artifact.state, 'missing')
  assert.equal(v.artifact.now.commit.length, 40)
  assert.equal(v.attempt, null)
  assert.ok(v.docsDir.endsWith('.fugue/docs'))
  console.log(`⑤ 读数：state=missing · 当前提交 ${v.artifact.now.commit.slice(0, 12)} · 入库 ${v.docsDir}`)
})
