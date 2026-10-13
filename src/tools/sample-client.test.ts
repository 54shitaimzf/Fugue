// **样例客户端**（`tools/sample-client.mjs`）是一份活文档——这一条守着它别烂。
// 跑法：cd ~/fugue && node --test src/tools/sample-client.test.ts
//
// 出处：架构 § 9.11 全节（方法面 · 错误码两段 · 事件通道 · 游标每 writer 一个 · 字节走带外）·
// 验收锚 ④「外部客户端照可跑样例消费同一份协议」。
//
// 为什么不把那些断言抄进这一份：那一份自己带判据（两条脸逐字节 · 游标排他下界 · 错误两段 · 版本
// 拒），跑一遍就是全套。这一份只做两件事——**它跑得通**（退出码 0，且四段读数都印出来了），
// 以及**它只认报文**：它不 import 这一份代码里的任何模块，所以"外部客户端"这四个字是字面意思。
// 负对照：谁把 `sample-client.mjs` 里的 `import` 改成引 `src/`，最后那一条当场红。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SAMPLE = fileURLToPath(new URL('../../tools/sample-client.mjs', import.meta.url))

test('① 样例客户端跑得通：四段读数都印出来，退出码 0', () => {
  const r = spawnSync(process.execPath, [SAMPLE], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, `样例客户端退了 ${r.status}：\n${r.stdout}\n${r.stderr}`)
  for (const head of ['① 握手：', '② 两条脸：', '③ 事件通道：', '④ 错误两段：']) {
    assert.match(r.stdout, new RegExp(head), `那一份该印出这一段读数：${head}`)
  }
  assert.match(r.stdout, /逐字节相同/, '「两条脸逐字节相同」那句判据该在读数里')
  assert.match(r.stdout, /再问一趟 0 条/, '游标那一句判据该在读数里')
  console.log(r.stdout.trim().split('\n').slice(0, 4).join('\n'))
})

test('② 它只认报文：一份 import 都不许指着这一份代码', () => {
  const src = readFileSync(SAMPLE, 'utf8')
  // 唯一允许的那一条：起那个子进程要一个到 CLI 的路径（那是"怎么跑这一份"的接线，不是模块）。
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  assert.ok(imports.length > 0, '这一份该有 import——没有的话下面那句量的是空气')
  for (const spec of imports) {
    assert.ok(
      !spec.includes('/src/') && !spec.startsWith('../') && !spec.startsWith('./'),
      `样例客户端 import 了代码里的模块：${spec}——"外部客户端"这四个字要求它一条都不指着这一份`,
    )
  }
  console.log(`② 读数：import ${imports.length} 条（${imports.join(' · ')}）· 指着 src/ 的 0 条`)
})
