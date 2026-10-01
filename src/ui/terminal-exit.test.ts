// tier: real —— Unix PTY / Python标准库termios；实际CLI终端状态，不是假输出口。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
const startupHook = fileURLToPath(new URL('../../test/helpers/terminal-startup-stop.mjs', import.meta.url))
const repository = fileURLToPath(new URL('../../', import.meta.url))
const driver = fileURLToPath(new URL('../../test/helpers/terminal-exit.py', import.meta.url))
function runTerminal(exit: string, entry = cli) {
  const root = mkdtempSync(join(tmpdir(), 'fugue-terminal-exit-'))
  try {
    const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
    assert.equal(init.status, 0, init.stderr)
    const args = [driver, process.execPath, entry, root, exit]
    if (exit === 'sigterm' || exit === 'sighup') args.push('--startup-hook', startupHook)
    const run = spawnSync('python3', args, { encoding: 'utf8', timeout: 12_000, maxBuffer: 1 << 20 })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
function assertRestored(result: ReturnType<typeof runTerminal>, exit: string) {
  assert.equal(result.ready, true, result.output)
  assert.equal(result.rawActive, true, result.output)
  assert.equal(result.timedOut, false, result.output)
  assert.equal(result.restored, true, result.output)
  assert.equal(result.code, exit === 'bad-log' ? 1 : 0, result.output)
  assert.equal(result.output.split('\x1b[?1049h').length - 1, 1)
  assert.equal(result.output.split('\x1b[?1049l').length - 1, 1)
  assert.equal(result.output.split('\x1b[?2004h').length - 1, 1)
  assert.equal(result.output.split('\x1b[?2004l').length - 1, 1)
}
for (const exit of ['q', 'ctrl-c', 'sigterm', 'sighup', 'bad-log']) {
  test(`real terminal restores raw mode, paste and full screen on ${exit}`, () => assertRestored(runTerminal(exit), exit))
}

test('negative control: a private runtime missing ALT_OFF fails the actual terminal assertion', () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-terminal-mutant-'))
  try {
    cpSync(join(repository, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(repository, 'package.json'), join(root, 'package.json'))
    const path = join(root, 'src/ui/term.ts'), source = readFileSync(path, 'utf8')
    const before = 'if (leave) buf.push(ALT_OFF)'
    assert.equal(source.split(before).length - 1, 1)
    writeFileSync(path, source.replace(before, 'if (leave) { /* controlled missing restoration */ }'))
    assert.throws(() => assertRestored(runTerminal('q', join(root, 'src/cli/fugue.ts')), 'q'), /0 !== 1/)
    assert.equal(readFileSync(join(repository, 'src/ui/term.ts'), 'utf8'), source)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
