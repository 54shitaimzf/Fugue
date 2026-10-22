// 整批替换与旧深链接：**切换要么整批换，要么整批不换**；标题改了而主题没变，旧地址仍到达。
//
// 判据来自交接单 § 2.1 末段（可引用的地址跨版本成立）· § 3.2（整批替换）· § 6.1 第 6 条
// （新版至少一页生成后中断，旧入口仍对应同一个提交与指纹）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { commitFiles, tmpRepo } from '../../test/helpers/docs-repo.ts'
import { openTruth } from '../truth/truth.ts'
import { buildDocs } from './build.ts'
import type { DocCaller } from './contract.ts'
import { docsRootOf, stageRootOf } from './contract.ts'
import { publishBatch, recoverPublish, writeLast } from './publish.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

test('① 整批替换：新批次里没有的旧文件一起消失（不是"叠一层"）', async () => {
  const root = tmpRepo()
  await publishBatch(root, [
    { path: 'index.html', bytes: enc('A 首页') },
    { path: 'manifest.json', bytes: enc('{"fingerprint":"old"}') },
    { path: 'old.html', bytes: enc('旧页') },
  ])
  await publishBatch(root, [
    { path: 'index.html', bytes: enc('B 首页') },
    { path: 'manifest.json', bytes: enc('{"fingerprint":"new"}') },
    { path: 'new.html', bytes: enc('新页') },
  ])
  const docs = docsRootOf(root)
  assert.equal(readFileSync(join(docs, 'index.html'), 'utf8'), 'B 首页')
  assert.equal(existsSync(join(docs, 'old.html')), false, '上一批的页不能留着')
  assert.equal(existsSync(join(docs, 'new.html')), true)
  assert.equal(readFileSync(join(docs, 'manifest.json'), 'utf8'), '{"fingerprint":"new"}')
  console.log('① 读数：old.html 已消失 · new.html 就位 · 清单同批')
})

test('② 两次改名之间被杀：recoverPublish 把旧批次改回来，并清掉暂存', async (t) => {
  const root = tmpRepo()
  await publishBatch(root, [
    { path: 'index.html', bytes: enc('旧批次') },
    { path: 'manifest.json', bytes: enc('{"fingerprint":"old"}') },
  ])
  const docs = docsRootOf(root)
  const prev = join(root, '.fugue', 'docs-prev-test')
  const stage = stageRootOf(root, 'test')
  // 模拟：旧批次已改名为 prev，新批次刚写进 stage，进程在这里被杀。
  renameSync(docs, prev)
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'index.html'), '新批次')
  assert.equal(recoverPublish.length > 0, true)
  const restored = await recoverPublish(root)
  assert.notEqual(restored, null, '要能认出恢复的是哪一次')
  assert.equal(readFileSync(join(docs, 'index.html'), 'utf8'), '旧批次')
  assert.equal(existsSync(stage), false, '暂存目录收掉')
  assert.equal(existsSync(prev), false, 'prev 收掉')
  console.log(`② 读数：恢复 ${restored} · 旧批次回来了`)
})

test('③ 两次改名都完成、只差收尾：新批次留着，prev 收掉', async () => {
  const root = tmpRepo()
  await publishBatch(root, [
    { path: 'index.html', bytes: enc('第一批') },
    { path: 'manifest.json', bytes: enc('{}') },
  ])
  const docs = docsRootOf(root)
  const prev = join(root, '.fugue', 'docs-prev-leftover')
  mkdirSync(prev, { recursive: true })
  writeFileSync(join(prev, 'index.html'), '第一批')
  const restored = await recoverPublish(root)
  assert.equal(restored, null)
  assert.equal(readFileSync(join(docs, 'index.html'), 'utf8'), '第一批')
  assert.equal(existsSync(prev), false, '残留的 prev 要收掉')
  console.log('③ 读数：新批次留下 · prev 收掉')
})

test('④ 旧深链接：标题改了而主题没变，旧锚点仍到达内容（清单里指得出对照）', async (ctx) => {
  const root = tmpRepo()
  const c1 = await commitFiles(root, { 'README.md': '# demo\n', 'design/A.md': '# 架构\n' }, [], 'refs/heads/main')
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const now = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const config = {
    docs: {
      pages: [
        { id: 'start', title: '开始', source: 'README.md', audience: '新人', role: '上手', prompt: '最短路径' },
        { id: 'arch', title: '架构', source: 'design/A.md', audience: '维护者', role: '边界', prompt: '讲约束' },
      ],
    },
  }
  const content = (heading: string, link: string): string =>
    [
      `## ${heading}`,
      '',
      '这一段说明这一页要解决的问题，以及读者能从这里得到什么。'.repeat(12),
      '',
      `见 [${heading}](${link})。`,
      '',
      '## 下一节',
      '',
      '更多内容。'.repeat(30),
    ].join('\n')

  const callerWith = (texts: Record<string, string>): DocCaller => ({
    model: 'fake/model',
    wireModel: 'fake',
    async call(req) {
      const id = /文档 id：([^\n]+)/.exec(req.context)?.[1]?.trim() ?? '?'
      if (req.system.includes('只输出一个 JSON 对象')) return { text: '{"paths":[]}', usage: null }
      return { text: texts[id] ?? content('安装', 'start.html#安装'), usage: null }
    },
  })

  // 第一版：标题"安装 Fugue" → id 由文字推出来（安装-fugue）
  const first = await buildDocs({
    root,
    config,
    truth,
    caller: callerWith({ start: content('安装 Fugue', '#安装-fugue'), arch: content('边界', 'start.html#安装-fugue') }),
    materials: { kind: 'manual', note: 'n' },
    now,
  })
  assert.ok(first.ok)
  const oldId = '安装-fugue'
  assert.ok(readFileSync(join(docsRootOf(root), 'start.html'), 'utf8').includes(`id="${oldId}"`))

  // 第二版：标题改成"装好 Fugue"，主题与读者都没变；别的页仍链到旧锚点
  const c2 = await commitFiles(root, { 'README.md': '# demo\n（第二版）\n', 'design/A.md': '# 架构\n' }, [c1 as never], 'refs/heads/main')
  const second = await buildDocs({
    root,
    config,
    truth,
    caller: callerWith({ start: content('装好 Fugue', '#装好-fugue'), arch: content('边界', `start.html#${oldId}`) }),
    materials: { kind: 'manual', note: 'n' },
    now,
  })
  assert.ok(second.ok)
  assert.equal(second.commit, String(c2))
  const manifest = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  const start = manifest.pages.find((p: { id: string }) => p.id === 'start')
  const newId = '装好-fugue'
  assert.equal(start.anchors[oldId], newId, '清单里记着旧地址的去向')
  const page = readFileSync(join(docsRootOf(root), 'start.html'), 'utf8')
  assert.ok(page.includes(`<span class="anchor-alias" id="${oldId}"></span>`), '旧地址在页面上仍是一个锚点')
  assert.ok(page.includes(`id="${newId}"`), '新地址在')
  // 别的页链接旧锚点：不判"锚点不在"，也不记 note（兑得掉）
  const arch = readFileSync(join(docsRootOf(root), 'arch.html'), 'utf8')
  assert.ok(arch.includes(`href="start.html#${oldId}"`), '旧深链接原样保留')
  assert.ok(!manifest.pages.find((p: { id: string }) => p.id === 'arch').notes.some((n: string) => n.includes('锚点')), '不该有一条"锚点不在"的 note')
  console.log(`④ 读数：${oldId} → ${newId} · 别名锚点在页面 · 跨页旧链接原样`)
})

test('⑤ 暂存写不进去：当场拒，旧批次一个字节不动，暂存目录不留', async () => {
  const root = tmpRepo()
  await publishBatch(root, [
    { path: 'index.html', bytes: enc('旧批次') },
    { path: 'manifest.json', bytes: enc('{}') },
  ])
  await assert.rejects(
    () =>
      publishBatch(root, [
        { path: 'index.html', bytes: enc('新批次') },
        // 路径里带 NUL：写文件当场抛，批次没开始切换
        { path: 'bad\u0000name', bytes: enc('x') },
      ]),
    (err: unknown) => err instanceof Error && err.message.includes('写不进暂存目录'),
  )
  assert.equal(readFileSync(join(docsRootOf(root), 'index.html'), 'utf8'), '旧批次')
  const leftovers = readdirSync(join(root, '.fugue')).filter((n) => n.startsWith('docs-stage-'))
  assert.deepEqual(leftovers, [], '暂存目录要收掉')
  console.log('⑤ 读数：旧批次不变 · 暂存残留 0 个')
})

test('⑥ 恢复不动活进程的暂存：并发一次 status 不会把正在写的批次收掉', async () => {
  const root = tmpRepo()
  const live = stageRootOf(root, `${process.ppid}-live`)
  const dead = stageRootOf(root, '4194303-dead')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'index.html'), '正在写')
  mkdirSync(dead, { recursive: true })
  writeFileSync(join(dead, 'index.html'), '已经死了')
  await recoverPublish(root)
  assert.equal(existsSync(live), true, '活进程的暂存要留着')
  assert.equal(existsSync(dead), false, '死进程的暂存要收掉')
  console.log('⑥ 读数：活 pid 的 stage 在 · 死 pid 的删')
})

test('⑦ 多个 prev 时恢复最新那个：按落盘时刻，不按 pid 字典序', async () => {
  const root = tmpRepo()
  const old = join(root, '.fugue', 'docs-prev-1000-a')
  const late = join(root, '.fugue', 'docs-prev-999-b')
  mkdirSync(old, { recursive: true })
  mkdirSync(late, { recursive: true })
  writeFileSync(join(old, 'index.html'), '早的旧批')
  writeFileSync(join(late, 'index.html'), '晚的旧批')
  utimesSync(old, new Date('2026-10-22T00:00:00Z'), new Date('2026-10-22T00:00:00Z'))
  utimesSync(late, new Date('2026-10-22T00:00:05Z'), new Date('2026-10-22T00:00:05Z'))
  const restored = await recoverPublish(root)
  assert.equal(restored, '999-b')
  assert.equal(readFileSync(join(docsRootOf(root), 'index.html'), 'utf8'), '晚的旧批')
  console.log('⑦ 读数：恢复 999-b（名字小、时刻新）')
})

test('⑧ 最近一次的结果原子落盘：写完之后没有临时文件，读回来就是那一份', async () => {
  const root = tmpRepo()
  await writeLast(root, {
    ok: true,
    at: '2026-10-22T00:00:00.000Z',
    commit: null,
    fingerprint: null,
    pages: 0,
    theme: null,
    model: null,
    materials: null,
    reason: null,
    at_stage: null,
  })
  const names = readdirSync(join(root, '.fugue', 'docs'))
  assert.deepEqual(names.filter((n) => n.startsWith('last.json.tmp-')), [])
  const back = JSON.parse(readFileSync(join(root, '.fugue', 'docs', 'last.json'), 'utf8')) as { ok: boolean }
  assert.equal(back.ok, true)
  console.log('⑧ 读数：last.json 可读 · 临时文件 0 个')
})

test('⑨ 旧锚点没有后继：清单里说明去向，不静默消失（交接单 § 2.1）', async (ctx) => {
  const root = tmpRepo()
  const c1 = await commitFiles(root, { 'README.md': '# demo\n' }, [], 'refs/heads/main')
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const cfg = {
    docs: {
      pages: [{ id: 'start', title: '开始', source: 'README.md', audience: '新人', role: '上手', prompt: '最短路径' }],
    },
  }
  const body = (withTemp: boolean): string =>
    [
      '## 安装 Fugue {#install}',
      '',
      '这一段说明这一页要解决的问题，以及读者能从这里得到什么。'.repeat(12),
      '',
      ...(withTemp ? ['## 临时一节 {#temp}', '', '下一版会被删掉的一节。'.repeat(6), ''] : []),
      '## 下一节',
      '',
      '更多内容。'.repeat(30),
    ].join('\n')
  const caller = (withTemp: boolean): DocCaller => ({
    model: 'fake/model',
    wireModel: 'fake',
    async call(req) {
      if (req.system.includes('只输出一个 JSON 对象')) return { text: '{"paths":[]}', usage: null }
      return { text: body(withTemp), usage: null }
    },
  })
  const first = await buildDocs({ root, config: cfg, truth, caller: caller(true), materials: { kind: 'manual', note: 'n' }, now: () => new Date('2026-10-22T00:00:00.000Z') })
  assert.ok(first.ok)
  await commitFiles(root, { 'README.md': '# demo 2\n' }, [c1 as never], 'refs/heads/main')
  const second = await buildDocs({ root, config: cfg, truth, caller: caller(false), materials: { kind: 'manual', note: 'n' }, now: () => new Date('2026-10-22T00:00:00.000Z') })
  assert.ok(second.ok)
  const manifest = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  const start = manifest.pages.find((p: { id: string }) => p.id === 'start')
  assert.ok(start.notes.some((n: string) => n.includes('旧深链接没有后继') && n.includes('temp')), JSON.stringify(start.notes))
  assert.equal(Object.hasOwn(start.anchors, 'temp'), false)
  console.log(`⑨ 读数：note：${start.notes.join(' / ')}`)
})
