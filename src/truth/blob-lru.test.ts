// 格 1 的断言：**按字节封顶的 LRU**（`blob-lru.ts`）。四条对应交接单 § 3 格 1 的四条硬性，
// 另有一条守"缓存里那一份与调用方手里那份是两份"。
//
// 这一层是纯数据结构，所以断言全是**改一处实现就当场红**的那种：淘汰序、上限守恒、零容量
// 直通、超大单条不缓存。跑法：cd ~/fugue && node --test src/truth/blob-lru.test.ts
// （它没有 tier 行，自动进 fast 组）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BlobLru } from './blob-lru.ts'

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))
const text = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8')

test('① 淘汰序：get 触达刷新新旧序，先走的是最旧那一条', () => {
  const c = new BlobLru(300)
  assert.equal(c.set('a', bytes('a'.repeat(100))), true)
  assert.equal(c.set('b', bytes('b'.repeat(100))), true)
  assert.equal(c.set('c', bytes('c'.repeat(100))), true)
  assert.deepEqual(c.keysOldestFirst(), ['a', 'b', 'c'])

  // **触达 a**：它成了最新的一条，于是现在最旧的是 b。
  assert.equal(c.get('a')?.byteLength, 100)
  assert.deepEqual(c.keysOldestFirst(), ['b', 'c', 'a'])

  // 再存一条 100 字节：挤掉的是 b（不是 a）——这一条就是"触达要刷新新旧序"。
  assert.equal(c.set('d', bytes('d'.repeat(100))), true)
  assert.deepEqual(c.keysOldestFirst(), ['c', 'a', 'd'])
  assert.equal(c.has('b'), false, 'b 该被挤掉')
  assert.equal(c.evictions, 1)
  assert.equal(c.evictedBytes, 100)
  assert.equal(c.bytes, 300, `淘汰之后存量应当是 3 条 300 字节，实际 ${c.bytes}`)
  assert.equal(c.size, 3)

  // **再触达一次 a**：它又成了最新，于是最旧的是 c。
  assert.equal(c.get('a')?.byteLength, 100)
  assert.deepEqual(c.keysOldestFirst(), ['c', 'd', 'a'])
  assert.equal(c.hits, 2)
  assert.equal(c.evictedBytes, 100, '只是触达，不该再挤掉谁')

  // `set` 同一个键是**改写**，也刷新新旧序（不是插一条重复的）。
  assert.equal(c.set('c', bytes('c'.repeat(50))), true)
  assert.deepEqual(c.keysOldestFirst(), ['d', 'a', 'c'])
  assert.equal(c.bytes, 250, `改写该按新长度记账，实际 ${c.bytes}`)
  assert.equal(c.size, 3)
  assert.equal(c.evictions, 1, '改写腾出来的地方够用，不该再挤掉谁')
})

test('② 上限守恒：存量恒 ≤ 容量，超出的按最旧一个一个挤掉', () => {
  const c = new BlobLru(250)
  for (let i = 0; i < 10; i++) assert.equal(c.set(`k${i}`, bytes(String(i).padStart(100, '0'))), true)
  assert.ok(c.bytes <= c.capacityBytes, `存量 ${c.bytes} 超过了容量 ${c.capacityBytes}`)
  assert.equal(c.size, 2, '250 字节的容量只装得下两条 100 字节')
  assert.deepEqual(c.keysOldestFirst(), ['k8', 'k9'], '留下的是最新的两条')
  assert.equal(c.evictions, 8)
  assert.equal(c.evictedBytes, 800)

  // **零字节的条目照样算一条**（空文件是合法内容）：它不吃容量，但会参与新旧序。
  const z = new BlobLru(10)
  assert.equal(z.set('empty', new Uint8Array(0)), true)
  assert.equal(z.size, 1)
  assert.equal(z.bytes, 0)

  const bad = new BlobLru(100)
  assert.equal(bad.set('x', new Uint8Array(100)), true)
  assert.equal(bad.bytes, 100)
  assert.equal(bad.delete('x'), true)
  assert.equal(bad.delete('x'), false, '删一个不在的键报 false，不是抛')
  assert.equal(bad.bytes, 0)
  assert.equal(bad.size, 0)
  bad.clear()
  assert.equal(bad.bytes, 0)

  assert.throws(() => new BlobLru(-1), /容量必须是非负整数/)
  assert.throws(() => new BlobLru(1.5), /容量必须是非负整数/)
})

test('③ 容量 0：可用，且就是直通——每次 get 未命中、每次 set 不存', () => {
  const c = new BlobLru(0)
  assert.equal(c.capacityBytes, 0)
  assert.equal(c.set('a', new Uint8Array(0)), false, '容量 0 一条都不存（空条目也不存）')
  assert.equal(c.size, 0)
  assert.equal(c.bytes, 0)
  assert.equal(c.get('a'), undefined, '存不进去，所以取不到')
  assert.equal(c.set('b', bytes('x')), false)
  assert.equal(c.size, 0)
  assert.equal(c.misses, 1, '未命中的次数要记（统计那一栏）')
  assert.equal(c.hits, 0)
  assert.equal(c.evictions, 0, '直通不是淘汰：一个字节都没被挤掉过')
})

test('④ 超容量的单条不缓存：存量一个字节都不动', () => {
  const c = new BlobLru(100)
  assert.equal(c.set('small', bytes('s'.repeat(40))), true)
  assert.equal(c.set('huge', bytes('h'.repeat(200))), false, '放不下的单条不缓存')
  assert.equal(c.has('huge'), false)
  assert.equal(c.size, 1, '那一条不该把 small 挤掉')
  assert.equal(c.bytes, 40)
  assert.deepEqual(c.keysOldestFirst(), ['small'])
  assert.equal(c.evictions, 0)

  // 恰好等于容量的单条：**装得下**（判据是 `>`，不是 `>=`）。
  assert.equal(c.set('exact', bytes('e'.repeat(100))), true)
  assert.ok(c.bytes <= 100)
  assert.deepEqual(c.keysOldestFirst(), ['exact'])
})

test('⑤ 缓存里那一份与调用方手里那份是两份：改写谁也带不动谁', () => {
  const c = new BlobLru(100)
  const mine = bytes('原始')
  c.set('a', mine)
  mine[0] = 0x58
  assert.equal(text(c.get('a')!), '原始', '存进去之后改写调用方那份，缓存里那份不该跟着变')

  const out = c.get('a')!
  out[0] = 0x59
  assert.equal(text(c.get('a')!), '原始', '取出来的那份被改写，缓存里那份不该跟着变')
  assert.equal(c.hits, 3, '三次触达逐次记账')

  // `has` 只看在不在：**不记命中，也不刷新新旧序**（用它的地方是"先滤后发"）。
  const seq = new BlobLru(200)
  seq.set('a', bytes('a'))
  seq.set('b', bytes('b'))
  assert.equal(seq.has('a'), true)
  assert.deepEqual(seq.keysOldestFirst(), ['a', 'b'], 'has 不刷新新旧序')
  assert.equal(seq.hits, 0)
  assert.equal(seq.misses, 0)
  assert.equal(seq.get('b')?.byteLength, 1)
  assert.deepEqual(seq.keysOldestFirst(), ['a', 'b'])
  assert.equal(seq.hits, 1)
})
