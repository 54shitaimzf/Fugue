// tier: real —— bwrap（doctor 那行对一次真探测）
// U9 · `fugue doctor` 的断言。口径（probe/doctor.ts 头上也写着）：**读得出就退 0——
// 「缺」是读数不是失败**；纯读不落盘。三条盯的是：
//   ① 读数逐项可对：`--json` 那一份的每一行有名字/在不在/说明三样，绿项 > 0，
//      bwrap 那一行与 `probeBwrap()` **当场对账**（同一只探针，两处读同一份）；
//   ② 负对照：PATH 掐掉再跑——bwrap 与 git 如实报**缺**，退出码仍是 0（缺不是失败）；
//   ③ 「纯读不落盘」可证伪：跑完之后 `<root>/.fugue` 一个字节都不存在。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { runCli } from '../../test/helpers/run-cli.ts'
import { probeBwrap } from '../boundary/confine.ts'

test('① doctor 读得出就退 0：逐项有名有说明，bwrap 那行与探针对账', async () => {
  const root = tmpDir('fugue-doctor-')
  const r = await runCli(['--root', root, '--json', 'doctor'])
  assert.equal(r.code, 0, `读得出就该退 0：${r.stderr}`)
  const j = JSON.parse(r.stdout) as {
    rows: { name: string; ok: boolean; note: string }[]
    allOk: boolean
    host: { fs: string; class: string }
  }
  assert.ok(j.rows.length >= 5, `该至少五行（node · crc32 · bwrap · landlock · git · 落点），拿到 ${j.rows.length}`)
  for (const row of j.rows) {
    assert.equal(typeof row.name, 'string', `每一行要有名字：${JSON.stringify(row)}`)
    assert.equal(typeof row.ok, 'boolean', `每一行要有在不在：${JSON.stringify(row)}`)
    assert.ok(row.note.length > 0, `每一行要有一句说明：${JSON.stringify(row)}`)
  }
  assert.ok(j.rows.some((row) => row.ok), '本机绿项该 > 0')
  assert.ok(j.rows.some((row) => row.name === '落点'), '落点那一行在（E1 的读数）')
  assert.equal(typeof j.host.fs, 'string')
  // 逐项可对：bwrap 那一行就是 probeBwrap() 说的那一句——同一只探针，两处读同一份。
  const bwrap = j.rows.find((row) => row.name === 'bwrap')
  const direct = probeBwrap()
  assert.equal(bwrap!.ok, direct.ok, 'bwrap 那一行与当场跑一遍 probeBwrap 对不上')
  // crc32 那一行带一个算得出的样值（对账的牙：换一台机器/一个 node，样值该是同一个）。
  assert.match(j.rows.find((row) => row.name === 'node:zlib.crc32')!.note, /crc32\("doctor"\) = [0-9a-f]{8}/)
})

test('② 负对照：PATH 掐掉，bwrap 与 git 如实报缺，退出码仍是 0', async () => {
  const root = tmpDir('fugue-doctor-')
  const realPath = process.env.PATH
  process.env.PATH = '/fugue-doctor-不存在的目录'
  try {
    const r = await runCli(['--root', root, '--json', 'doctor'])
    assert.equal(r.code, 0, '缺是读数不是失败——PATH 空了也该退 0')
    const j = JSON.parse(r.stdout) as { rows: { name: string; ok: boolean; note: string }[] }
    const bwrap = j.rows.find((row) => row.name === 'bwrap')
    assert.equal(bwrap!.ok, false, 'PATH 里没有 bwrap：那一行该报缺')
    const git = j.rows.find((row) => row.name === 'git')
    assert.equal(git!.ok, false, 'PATH 里没有 git：那一行该报缺')
    assert.equal(j.rows.some((row) => row.ok), true, '落点与 node 那几行不靠 PATH——绿项仍在')
  } finally {
    process.env.PATH = realPath
  }
})

test('③ 纯读不落盘：跑完之后 <root>/.fugue 一个字节都不存在', async () => {
  const root = tmpDir('fugue-doctor-')
  assert.ok(!existsSync(join(root, '.fugue')), '前置：临时根上还没有 .fugue')
  const r = await runCli(['--root', root, 'doctor'])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(!existsSync(join(root, '.fugue')), 'doctor 跑完不许留下 .fugue（landlock 未铺时不探、不铺）')
  assert.ok(r.stdout.includes('落点'), `人读那一面把落点那一行印出来：${r.stdout}`)
})
