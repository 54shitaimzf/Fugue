// `fugue doctor` 的读数（U9）：把这台机器上那些「档位」一格格读出来——node · zlib.crc32 ·
// git · bwrap · landlock · 落点。**每一样读数在系统里都有归属**（§ 9.6 那张表"呈现与核对类"
// 的判据）：三只围栏/落点探针是 § 15.7 与 `run/confined` 写进日志的同一批，node 与 git 的
// 版本是 engines 与变更检测各自的门槛，crc32 是信封校验和（`log/envelope.ts`）用的那一个。
//
// **纯读，不落盘**：`probeLandlock` 要铺包装器（写 `.fugue/bin/`），所以 doctor 只在包装器
// **已经在盘上**时才探它；没铺就如实说"未铺"——铺是 fork/run 那一步的事。
//
// **「缺」是读数不是失败**（§ 8.15 不造伪判据）：读得出就退 0，哪一项不在那一行自己说；
// 唯一退 1 的情形是 statfs 都问不出落点——自检自己跑不了。
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import { probeBwrap } from '../boundary/confine.ts'
import { helperPath, probeLandlock } from '../boundary/landlock.ts'
import { probeHost } from '../roots/host.ts'
import type { HostFacts } from '../roots/host.ts'
import { createRoots } from '../roots/roots.ts'

/** 一格读数：`ok` 是"这一层在场/这一项达标"，`note` 是那句人读的说明（含出路）。 */
export interface DoctorRow {
  readonly name: string
  readonly ok: boolean
  readonly note: string
}

/** 全部读数 + 落点那份原始事实（`host` 为 null 就是自检跑不了的那一档）。 */
export interface DoctorReport {
  readonly rows: readonly DoctorRow[]
  readonly host: HostFacts | null
}

/**
 * git 的**在场判读**（不另起进程）：PATH 里扫得到可执行的 `git` 就算在场。版本门槛
 * （≥2.38）的判据归属**真跑那一层**——变更检测真的起 git 时它自己说话，doctor 纯读，
 * 不为一条读数再起一个子进程。
 */
function gitOk(): { ok: boolean; note: string } {
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d !== '')
  const hit = dirs.find((d) => existsSync(join(d, 'git')))
  return hit === undefined
    ? { ok: false, note: 'PATH 里找不到 git：变更检测那一层要它（fork 的底靠 git 对象库）' }
    : { ok: true, note: `PATH 里有 git（${join(hit, 'git')}）· 版本门槛 ≥2.38 由真跑那一层说话` }
}

/** node 的版本门槛：package.json 的 engines（≥22.6）——strip-only 直跑 .ts 要它。 */
function nodeOk(): { ok: boolean; note: string } {
  const parts = process.versions.node.split('.').map(Number)
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const ok = major > 22 || (major === 22 && minor >= 6)
  return { ok, note: `${process.version}（engines 要 ≥22.6：strip-only 直跑 .ts）` }
}

/**
 * 读一遍。**收口在 `rows` 的次序**：先版本两样（node · crc32），再围栏两层（bwrap ·
 * landlock），落点压轴——它是 E1 的硬要求，也是唯一能让整条命令退 1 的那一样。
 */
export function doctorOf(root: string): DoctorReport {
  const abs = resolve(root)
  const roots = createRoots(abs)
  const host = probeHost(abs)

  const rows: DoctorRow[] = []
  const node = nodeOk()
  rows.push({ name: 'node', ok: node.ok, note: node.note })
  // 信封校验和用的那一个函数：能进来（import 没炸）它就在，报一个算得出的样值做对账。
  const sample = crc32('doctor')
  rows.push({
    name: 'node:zlib.crc32',
    ok: Number.isInteger(sample),
    note: `crc32("doctor") = ${sample.toString(16).padStart(8, '0')}（信封校验和用的同一函数，log/envelope.ts）`,
  })
  const bwrap = probeBwrap()
  rows.push({ name: 'bwrap', ok: bwrap.ok, note: bwrap.note })
  const bin = helperPath(roots)
  if (existsSync(bin)) {
    const land = probeLandlock(roots)
    rows.push({ name: 'landlock', ok: land.ok, note: land.note })
  } else {
    rows.push({
      name: 'landlock',
      ok: true,
      note: `包装器未铺（${bin}）：fork/run 那一步按需铺，doctor 纯读不落盘——没铺不是缺`,
    })
  }
  const git = gitOk()
  rows.push({ name: 'git', ok: git.ok, note: git.note })
  if (host !== null) {
    rows.push({
      name: '落点',
      ok: host.class === 'native',
      note: `${host.fs} · ${host.class}（探的是 ${host.probed}${host.probed === abs ? '' : '——根还不存在，探的最近祖先'}）`,
    })
  }
  return { rows, host }
}
