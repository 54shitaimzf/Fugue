// 0.2.9 ① 的挂载点：内部不变量那张网（`tools/check-invariants.ts`）必须挂在 **fast 组**里跑，
// 而且它自己不许恒真。出处：ROADMAP § 3 的 0.2.9 行 ①（先落网再删）与 ②③④⑤⑥ 各条。
//
// **这个文件守的是"网真的在跑、而且真的咬得住"**，两半：
//   ① 真状态那一趟：网退出码 0、不印 FAIL，且**逐条负对照的标签都在**——少一条就是网漏了一格
//      （标签名单在下面，是这一半的判据，不是把网里的判据抄第二遍）；
//   ② 端到端那一趟：把事件联合换一份坏的（给一格加一个信封字段），网必须当场红——它证明这张网
//      读的是那一份真文件，而不只是自己搓的夹具。
//
// 跑法：cd ~/fugue && node --test test/check-invariants.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const REPO = join(import.meta.dirname, '..')
const TOOL = join(REPO, 'tools', 'check-invariants.ts')

/**
 * 网里那些负对照的标签，逐条。**每一条都必须印出来**：删掉一条负对照 = 那一格没人守了，
 * 而网自己还是绿的——这正是"漏了不报错"（与 `test/entry.guard.test.ts` 同一个病）。
 * 增删负对照要同时改这里：改不动就该有人想一想为什么要改。
 */
const CONTROLS: readonly string[] = [
  '负对照（截短名表一格）',
  '负对照（层表里多一个目录没有的名字）',
  '负对照（声明集挂到了视图层）',
  '负对照（目录重名）',
  '负对照（层域未声明）',
  '负对照（能力标识重名）',
  '负对照（声明集标记非布尔）',
  '负对照（短一段（从段序里去掉最后一节））',
  '负对照（多一段（把持轮者独占的那一段排进来））',
  '负对照（重复一段）',
  '负对照（缺一条渲染规则）',
  '负对照（多一段不属于任何一个区的）',
  '负对照（工具目录是空的）',
  '负对照（段序里排了一个没有源的段）',
  '负对照（给实现型多塞一个字段）',
  '负对照（从实现型里去掉一个必有的字段）',
  '负对照（真源里给一格加一个信封字段 crc）',
  '负对照（真源里一格没有 `t`）',
  '负对照（载荷里出现信封字段 seq）',
  '负对照（一格压根没有 `t`）',
]

function runNet(env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TOOL], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('① 真状态那一趟：网退出码 0 · 不印 FAIL · 逐条负对照都在', () => {
  const r = runNet()
  assert.equal(r.status, 0, `网退非零：\n${r.stdout}\n${r.stderr}`)
  assert.doesNotMatch(r.stdout, /FAIL/, '网自己报了 FAIL')
  assert.match(r.stdout, /全部通过/)
  const missing = CONTROLS.filter((label) => !r.stdout.includes(label))
  assert.deepEqual(missing, [], `网里少了这几条负对照（那一格没人守了）：${missing.join(' · ')}`)
})

test('② 端到端负对照：换一份坏的事件联合，网当场红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-net-'))
  try {
    const good = readFileSync(join(REPO, 'src', 'log', 'events.ts'), 'utf8')
    // 给第一格加一个信封字段：载荷里出现 `crc` 会把信封那一栏顶掉，而编码器已经不再逐条查它。
    const bad = good.replace("t: 'view/write'; agent: AgentId", "t: 'view/write'; crc: string; agent: AgentId")
    assert.notEqual(bad, good, '那一处没改到——这条负对照本身是空的')
    const other = join(dir, 'events.ts')
    writeFileSync(other, bad)
    const r = runNet({ FUGUE_EVENTS: other })
    assert.notEqual(r.status, 0, `换一份坏声明之后网还是绿的：\n${r.stdout}`)
    assert.match(r.stdout, /FAIL/)
    assert.match(r.stdout, /crc/, '报出来的没提那个字段名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
