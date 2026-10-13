// **只读那一份名单**（本版）。跑法：cd ~/fugue && node --test src/value/registry.test.ts
//
// 出处：架构 § 9.7（观察不得影响状态）· § 9.11 的第一句（服务端可以记住派生物，而其第一条
// 就是"一次只读批次固定在一个代上"）。
//
// 这一份量四件事，各配一条负对照：
//
//   ① **名单是命令面的一份投影**：里头的每一条都真在 `FLAGS_OF` 里、都是一条动词；写组那八条
//      一条都不在里头（写命令自己就是一趟，绑了批等于一写就作废）。负对照：往名单里塞一条写
//      命令，② 那条判据当场红。
//   ② **空跑一趟不动状态**：名单里的一条只读命令跑完之后，那个工作区的日志目录一个字节没变
//      ——"只读"这两个字在磁盘上量得到。负对照：同一条命令换成写组的一条（`write`），
//      同一把尺当场红。
//   ④ **绑不绑那一份代，判据是命令自己**（`value/invoke.ts`）：同一条只读命令、同一次
//      运行期写入，给了 `batchRoot` 的当场作废，没给的照旧给回原值——差别只有那一份代。
//   ③ **批次那一份判据接得上命令那一趟**（`cli/shared.ts` 的两个入口）：同代给回原值，
//      期间落了写入就抛 `BatchStaleError`（那句错话把两个代都印出来）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FLAGS_OF } from '../cli/flags.ts'
import { bindReadBatch, verifyBatch } from '../cli/shared.ts'
import { BatchStaleError, generationOf } from '../log/batch.ts'
import { logFileOf } from '../log/log.ts'
import { READ_ONLY_KEYS, VALUE_LAYER, valueRunnerOf, verbKeys } from './registry.ts'
import { invoke } from './invoke.ts'
import type { WriterId } from '../terms.ts'

/** 写组那八条（`cli/fugue.ts` 那一支取锁的键）。**名单里一条都不许有。** */
const WRITE_KEYS: readonly string[] = ['write', 'remove', 'rename', 'chmod', 'commit', 'branch', 'fork', 'ensure', 'dispose']

/** 一条 git 命令（与别的夹具同一套环境：全局与系统配置都不读，作者身份钉住）。 */
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'fugue',
      GIT_AUTHOR_EMAIL: 'fugue@localhost',
      GIT_COMMITTER_NAME: 'fugue',
      GIT_COMMITTER_EMAIL: 'fugue@localhost',
      GIT_AUTHOR_DATE: '2026-02-01T00:00:00+0000',
      GIT_COMMITTER_DATE: '2026-02-01T00:00:00+0000',
    },
  })
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`)
}

test('① 只读名单是命令面的一份投影：每条都在 `FLAGS_OF` 里，写组一条都不在', () => {
  const verbs = verbKeys()
  for (const key of READ_ONLY_KEYS) {
    assert.ok(FLAGS_OF[key] !== undefined, `只读名单里的这一条不在命令面里：${key}`)
    assert.ok(verbs.includes(key), `只读名单里的这一条不是动词：${key}`)
  }
  // 每一条真的只读（判据是"这条命令会不会取锁"，与写组那份名单互核）。
  const overlap = READ_ONLY_KEYS.filter((k) => WRITE_KEYS.includes(k))
  assert.deepEqual(overlap, [], `只读名单与写组重叠了：${overlap.join(' · ')}`)
  // **负对照**：把 `write` 塞进名单，上面那条判据当场红。
  const wrong = [...READ_ONLY_KEYS, 'write']
  const bad = wrong.filter((k) => WRITE_KEYS.includes(k))
  assert.notDeepEqual(bad, [], '往名单里塞一条写命令之后竟然没报——上面那条判据是空话')
  // 而那几条"值层登记过"的只读命令都在名单里（漏一条就是那一条的批从不作废）。
  for (const key of ['read', 'list', 'stat', 'diff', 'revs', 'log', 'status', 'watch']) {
    assert.ok(READ_ONLY_KEYS.includes(key), `这一条只读命令不在名单里：${key}`)
  }
  console.log(`① 读数：只读 ${READ_ONLY_KEYS.length} 条（${READ_ONLY_KEYS.join(' · ')}）· 写组 ${WRITE_KEYS.length} 条 · 重叠 0`)
})

test('② 空跑一趟不动状态：只读命令跑完，日志目录一个字节没变；写组那一条同一把尺当场红', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-ro-'))
  try {
    // 一条真命令要一个真的工作区（真源是既有的 git 对象库，§ 9.1）——建一个最小的。
    git(dir, 'init', '-q', '-b', 'main', '.')
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', '起点')
    const logDirPath = join(dir, '.fugue', 'log')
    mkdirSync(logDirPath, { recursive: true })
    const writer = 'agent-ro' as WriterId
    writeFileSync(logFileOf(dir, writer), '{"seq":1,"t":"run/end"}\n')
    const before = generationOf(dir)
    const stamp = readdirSync(logDirPath).map((n) => `${n}:${statSync(join(logDirPath, n)).size}`)

    // 一 · 真的跑一条只读命令（这一格就是"只读"这句话的落点：整条命令从头到尾不碰日志目录）。
    const stat = valueRunnerOf('stat')
    assert.ok(stat !== null, '`stat` 该在值层里——不然下面那一条量的是别的命令')
    const r = await stat({ root: dir, flags: new Map(), args: ['a.ts'], rest: [], batchRoot: dir })
    assert.equal(r.ok, true, `这一格该读得出 a.ts：${r.ok ? '' : r.message}`)
    assert.match(
      r.ok ? r.value.faces.json : '',
      /a\.ts/,
      '`stat` 那一面该报出那条路径——不然下面"没动日志"那句是空话',
    )
    assert.equal(generationOf(dir), before, '跑完一条只读命令之后日志目录变了——那它就不是只读')
    assert.deepEqual(
      readdirSync(logDirPath).map((n) => `${n}:${statSync(join(logDirPath, n)).size}`),
      stamp,
      '日志目录里的文件清单变了',
    )
    // 它真的读到了东西（不是"因为目录是空的所以没变"）。
    assert.notEqual(before, '', '这一份夹具该有一份非空的日志：否则上面那条是空话')

    // 二 · **负对照**：同一把尺换个写者——追加一个字节，代当场变。
    writeFileSync(logFileOf(dir, writer), '{"seq":1,"t":"run/end"}\n{"seq":2,"t":"run/end"}\n')
    const after = generationOf(dir)
    assert.notEqual(after, before, '往日志里追加之后代竟然没变——上面那条"没变"是空话')
    console.log(`② 读数：只读一趟之后代不变（${before.slice(0, 40)}…）· 追加一个字节之后当场变 · ${readdirSync(logDirPath).length} 个文件`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③ 批次那一份判据接得上命令那一趟：同代给回原值，期间落了写入就抛 BatchStaleError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-batchw-'))
  try {
    const logDirPath = join(dir, '.fugue', 'log')
    mkdirSync(logDirPath, { recursive: true })
    const writer = 'agent-w' as WriterId
    assert.equal(generationOf(dir), '', '空账的代是空串（那是一个代，不是"没有代"）')

    // 一 · 同代：读完还在同一个代上 → 原值交回来，一个字节不抛。
    const clean = bindReadBatch({ batchRoot: dir })
    const got = await clean?.read(() => '同代的那一份')
    assert.equal(got, '同代的那一份')
    await verifyBatch(clean)

    // 二 · 期间落了写入 → 整批作废（**不把两代拼在一起**）。
    writeFileSync(logFileOf(dir, writer), '{"seq":1}\n')
    const dirty = bindReadBatch({ batchRoot: dir })
    assert.ok(dirty !== null)
    const inside = await dirty.read(() => '第一代里读到的')
    writeFileSync(logFileOf(dir, writer), '{"seq":1}\n{"seq":2}\n')
    assert.equal(inside, '第一代里读到的')
    let caught: unknown = null
    try {
      await verifyBatch(dirty)
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof BatchStaleError, `该抛 BatchStaleError，实际 ${String(caught)}`)
    // 那句错话把两个代都印出来（人读得出来"哪一段到哪一段之间有人写过"）。
    assert.match((caught as Error).message, /整批作废/, (caught as Error).message)
    assert.match((caught as Error).message, /agent-w\.jsonl/, (caught as Error).message)

    // 三 · **不给根就是没批**（CLI 那一侧走的就是这一条）：一个字节都不抛。
    await verifyBatch(bindReadBatch({}))
    assert.equal(bindReadBatch({}), null)
    assert.equal(existsSync(join(dir, '.fugue', 'log', 'agent-w.jsonl')), true)
    console.log(`③ 读数：同代照过 · 期间写入 → ${(caught as Error).name}（两个代都在那句话里）· 不给根 → null（CLI 那一档）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ 绑不绑那一份代看命令自己：同一趟里落了写入，绑了的当场作废、没绑的照旧给回原值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-inv-'))
  try {
    git(dir, 'init', '-q', '-b', 'main', '.')
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', '起点')
    const logDirPath = join(dir, '.fugue', 'log')
    mkdirSync(logDirPath, { recursive: true })
    const writer = 'agent-w' as WriterId
    writeFileSync(logFileOf(dir, writer), '{"seq":1,"t":"run/end"}\n')
    const before = generationOf(dir)
    assert.notEqual(before, '', '这一份夹具该有一份非空的日志：否则下面那条"代变了"是空话')

    /** 把 `stat` 那一格包一层：命令跑起来之后、值层验代之前，往账里落一笔。 */
    const run = valueRunnerOf('stat')
    assert.ok(run !== null, '`stat` 该在值层里——不然这条量的是别的命令')
    const argsOf = (batchRoot: string | undefined) => ({
      root: dir,
      flags: new Map(),
      args: ['a.ts'],
      rest: [],
      ...(batchRoot === undefined ? {} : { batchRoot }),
    })
    const staleOnce = async (batchRoot: string | undefined) => {
      // 打桩的那一层薄到只剩"跑起来之后往账里落一笔"——`invoke` 的查表在调用那一刻发生，
      // 所以这一笔落在 **绑代之后、验代之前**，那一格判据才有得判。
      ;(VALUE_LAYER as Record<string, typeof run>).stat = async (a) => {
        writeFileSync(logFileOf(dir, writer), '{"seq":1,"t":"run/end"}\n{"seq":2,"t":"run/end"}\n')
        return run(a)
      }
      try {
        return await invoke('stat', argsOf(batchRoot))
      } finally {
        ;(VALUE_LAYER as Record<string, typeof run>).stat = run
      }
    }

    // 一 · 绑了代（serve 那一侧给根）→ 这一批作废。**以异常逃出去**是这一档的既定形状
    //     （`log/batch.ts` 那条判据抛、壳那一层认）：CLI 那一侧它就是一条失败命令，serve 那一侧
    //     由 `connect.ts` 的 `failed` 收成 `-32000`（§ 9.11「调用的失败用实现段」）——两处都接得住。
    let held: unknown = null
    try {
      await staleOnce(dir)
    } catch (err) {
      held = err
    }
    assert.ok(held instanceof BatchStaleError, `该抛 BatchStaleError，实际 ${String(held)}`)
    assert.match((held as Error).message, /整批作废/, (held as Error).message)
    assert.match((held as Error).message, /agent-w\.jsonl/, (held as Error).message)

    // 二 · **负对照**：同一把尺、同一次写入，只是没给根（CLI 那一侧）→ 照旧给回原值。
    const after = generationOf(dir)
    assert.notEqual(after, before, '落了一笔之后代竟然没变——上面那条"作废"是空话')
    const loose = await staleOnce(undefined)
    assert.equal(loose.ok, true, `没给根的那一趟该照旧跑完：${loose.ok ? '' : loose.message}`)
    assert.match(loose.ok ? loose.value.faces.json : '', /a\.ts/, '没给根的那一趟该照旧报出那条路径')
    console.log(`④ 读数：绑了代的这一趟 → ${(held as Error).name} · 没绑的那一趟 → 照旧给回原值 · 代 ${before.slice(0, 12)}… → ${after.slice(0, 12)}…`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
