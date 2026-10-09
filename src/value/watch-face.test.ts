// 第一幕 ② 前置的一处缺陷断言：`watch --follow` 收尾之后**每一行只许出现一次**。
//
// 现场（修之前）：壳给 `onBatch` 时行是随读随印的，而收尾那句 `writeValue` 又把同一批行
// 当 `faces.human` 写了一遍——人按 Ctrl-C 之后，2 条事件印出 4 行。`timeout` 那种杀法是
// SIGTERM（进程直接死，走不到收尾），所以这一条只在**真的按一下 Ctrl-C** 之后现形：
// 它量的正是"没有变更的稳态"那条交互律的反面——同一个东西印两遍就是不稳定。
//
// 负对照（红得起来才是断言）：把 `human` 那一格改回 `rows.map(…)`（不看 `streamed`），
// ① 当场红（4 行）；②（`--json` 那一面不受影响）照旧绿——所以这条断言抓的是人读那一面。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'

const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))

function run(root: string, input: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 24 })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

/** 一份有小账的工作区：两条 `write` 就是两条事件。 */
function fixture(): string {
  const root = tmpDir('fugue-follow-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  assert.equal(run(root, '甲\n', 'write', 'a.txt', '--stdin').code, 0, '造现场：write a.txt')
  assert.equal(run(root, '乙\n', 'write', 'b.txt', '--stdin').code, 0, '造现场：write b.txt')
  return root
}

/**
 * 起一条 `watch --follow`，**等它真印出 `want` 行之后**再按一下 Ctrl-C（SIGINT），收回两股输出
 * 与退出码。
 *
 * 为什么不等一个固定的毫秒数：`SIGINT` 的处理器是在进程起来之后才挂上的，而全量那一趟机器忙，
 * 固定睡 400ms 会赶在它挂上之前杀到——那时进程是被信号直接带走的（退出码 `null`），不是"人喊停"
 * 那一档。等输出到齐再按，量到的才是收尾那条路。兜底 2500ms 防夹具本身出问题。
 */
function follow(
  root: string,
  want: number,
  ...args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, '--root', root, 'watch', '--follow', '--interval', '50', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let sent = false
    const send = (): void => {
      if (sent) return
      sent = true
      p.kill('SIGINT')
    }
    const fallback = setTimeout(send, 2500)
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      out += d
      if (out.split('\n').filter((l) => l !== '').length >= want) setTimeout(send, 50)
    })
    p.stderr.on('data', (d: string) => { err += d })
    p.on('close', (code) => {
      clearTimeout(fallback)
      resolve({ code, stdout: out, stderr: err })
    })
  })
}

const rowsOf = (out: string): string[] => out.split('\n').filter((l) => l !== '')

test('① 按一下 Ctrl-C 收尾：每一行恰好一次（修之前每一行两次——2 条事件印 4 行）', async () => {
  const root = fixture()
  const one = run(root, '', 'watch')
  assert.equal(one.code, 0, one.stderr)
  const once = rowsOf(one.stdout)
  assert.equal(once.length, 2, `现场该有 2 条事件：拿到 ${once.length}`)

  const got = await follow(root, 2)
  assert.equal(got.code, 0, `Ctrl-C 是"人喊停"，退出码 0：${got.code}\n${got.stderr}`)
  const lines = rowsOf(got.stdout)
  assert.deepEqual(lines, once, '跟随那一档印的那些行，与不跟随时读到的逐行相同（且各一次）')
  assert.equal(lines.length, 2, `2 条事件就该是 2 行：拿到 ${lines.length} 行`)
  // 收尾那一行（接着读的入口）仍需在场，走的还是 stderr。
  assert.ok(got.stderr.includes('--resume'), `stderr 里仍要有游标那一行：${got.stderr}`)
  console.log(`① 读数：Ctrl-C 收尾 stdout ${lines.length} 行（每条事件一次）；stderr「${got.stderr.trim()}」`)
})

test('② `--json` 那一面不受影响：还是一行一个对象，条数与事件数相同', async () => {
  const root = fixture()
  const r = run(root, '', '--json', 'watch')
  assert.equal(r.code, 0, r.stderr)
  const lines = rowsOf(r.stdout)
  assert.equal(lines.length, 2, `2 条事件 2 行 NDJSON：拿到 ${lines.length}`)
  for (const l of lines) JSON.parse(l)
})
