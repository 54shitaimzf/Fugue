// 地址身份：旧标题 → 新标题。**这一份不知道清单、页面与渲染**，只吃“上一批的地址 + 这一版的标题”。
//
// 从 `build.ts` 搬出来时补的断言：搬之前这个文件不存在（导入即失败），搬之后它必须给出与
// 生成路径同一套映射。判据来自交接单 § 2.1 末段与第二刀（删 / 并 / 改各一例）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { aliasPlan, similarity } from './address.ts'
import type { Headed, PriorAddresses } from './address.ts'

const h = (id: string, text: string): Headed => ({ id, text })

function fresh(entries: [string, Headed[]][]): ReadonlyMap<string, readonly Headed[]> {
  return new Map(entries)
}

test('① 地址：同一 id 不动 · 改名走相似度 · 版本号写法变了也认 · 链跟到终点 · 合并与通配 · 版本不符不继承 · 删过能复活', () => {
  // 一 · 同一 id：不产生别名（也不该出现在 dropped 里）
  {
    const prior: PriorAddresses = { pages: [{ id: 'p', headings: [h('a', '甲')] }] }
    const out = aliasPlan(prior, fresh([['p', [h('a', '甲')]]]))
    assert.deepEqual(out.get('p')!.anchors, {})
    assert.deepEqual(out.get('p')!.dropped, [])
  }

  // 二 · 改名：相似度那一档（0.8，明显高于第二名）
  {
    const prior: PriorAddresses = { pages: [{ id: 'p', headings: [h('安装-fugue', '安装 Fugue')] }] }
    const out = aliasPlan(prior, fresh([['p', [h('装好-fugue', '装好 Fugue')]]]))
    assert.equal(out.get('p')!.anchors['安装-fugue'], '装好-fugue')
    assert.ok(similarity('安装 Fugue', '装好 Fugue') >= 0.75)
  }

  // 三 · 分隔符折掉之后同一个 id（`v9-8-7` = `v987`）
  {
    const prior: PriorAddresses = { pages: [{ id: 'p', headings: [h('v9-8-7', '9.8.7')] }] }
    const out = aliasPlan(prior, fresh([['p', [h('v987', '9.8.7 —— 文档成为可读产物')]]]))
    assert.equal(out.get('p')!.anchors['v9-8-7'], 'v987')
  }

  // 四 · 同一个版本号：标题写法变了（`1.2.3 旧` → `1.2.3 —— 新`）
  {
    const prior: PriorAddresses = { pages: [{ id: 'p', headings: [h('old', '1.2.3 旧写法')] }] }
    const out = aliasPlan(prior, fresh([['p', [h('v123', '1.2.3 —— 新写法')]]]))
    assert.equal(out.get('p')!.anchors['old'], 'v123')
  }

  // 五 · 同一段文字（折掉标点与大小写）
  {
    const prior: PriorAddresses = { pages: [{ id: 'p', headings: [h('a1', '安装与卸载')] }] }
    const out = aliasPlan(prior, fresh([['p', [h('b1', '安装与卸载')]]]))
    assert.equal(out.get('p')!.anchors['a1'], 'b1')
  }

  // 六 · 上一批的对照链：A→B 之后 B→C，A 也要到 C
  {
    const prior: PriorAddresses = {
      pages: [{ id: 'p', headings: [h('b', '装好 Fugue')], anchors: { a: 'b' } }],
    }
    const out = aliasPlan(prior, fresh([['p', [h('c', '装好 Fugue')]]]))
    assert.equal(out.get('p')!.anchors.b, 'c')
    assert.equal(out.get('p')!.anchors.a, 'c', 'A→B→C：最早的地址要跟到终点')
  }

  // 七 · 版本号不同的“继承”是错的：旧 id 自己带 0.5.1，目标那一节是 0.1.0
  {
    const prior: PriorAddresses = {
      pages: [{ id: 'p', headings: [h('v0-5-1', '0.5.1')], anchors: { 'v0-5-1': 'v010' } }],
    }
    const out = aliasPlan(prior, fresh([['p', [h('v010', '0.1.0 —— 第一版')]]]))
    assert.equal(out.get('p')!.anchors['v0-5-1'], undefined, '版本不符的继承要被拒')
  }

  // 八 · 合并的那一节接住两个版本号（“0.3.4 到 0.3.1”）
  {
    const prior: PriorAddresses = {
      pages: [{ id: 'p', headings: [h('v0-3-4', '0.3.4'), h('v0-3-1', '0.3.1')] }],
    }
    const out = aliasPlan(prior, fresh([['p', [h('v03x', '0.3.4 到 0.3.1 —— 索引立起来')]]]))
    assert.equal(out.get('p')!.anchors['v0-3-4'], 'v03x')
    assert.equal(out.get('p')!.anchors['v0-3-1'], 'v03x', '合并那一节要接住被并掉的那一版')
  }

  // 九 · 通配的那一族（“0.2.x”）
  {
    const prior: PriorAddresses = { pages: [{ id: 'p', headings: [h('v0-2-1', '0.2.1')] }] }
    const out = aliasPlan(prior, fresh([['p', [h('v02x', '0.2.x —— 收口批次')]]]))
    assert.equal(out.get('p')!.anchors['v0-2-1'], 'v02x')
  }

  // 十 · 判过“没有后继”的地址，这一版重新出现时接回来
  {
    const prior: PriorAddresses = { pages: [{ id: 'p', headings: [], dropped: ['v0-4-4'] }] }
    const out = aliasPlan(prior, fresh([['p', [h('v044', '0.4.4 —— 界面的两版')]]]))
    assert.equal(out.get('p')!.anchors['v0-4-4'], 'v044')
    assert.deepEqual(out.get('p')!.dropped, [], '复活之后不该还挂在 dropped 里')
  }

  // 十一 · 真删掉的进 dropped（“没有对应内容”只在真没有时说）
  {
    const prior: PriorAddresses = { pages: [{ id: 'p', headings: [h('gone', '走掉的')] }] }
    const out = aliasPlan(prior, fresh([['p', [h('stay', '留下的')]]]))
    assert.deepEqual(out.get('p')!.dropped, ['gone'])
  }

  // 十二 · 没有上一批：不产生任何别名，也不抛
  {
    const out = aliasPlan(null, fresh([['p', [h('a', '甲')]]]))
    assert.deepEqual(out.get('p')!.anchors, {})
  }

  console.log(
    `① 读数：12 例（同 id · 改名 · 折分隔符 · 版本号 · 文字同一 · 链 · 版本不符 · 合并 · 通配 · 复活 · 真删 · 无前批）· 相似度 ${similarity('安装 Fugue', '装好 Fugue').toFixed(2)}`,
  )
})
