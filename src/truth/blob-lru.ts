// 一层**按字节封顶的 LRU**，只装对象库里已有的字节。出处：TARGETS `T16` ①（检索热路径的
// 第一层机制修复）· ROADMAP § 3 的 0.2.4 行。
//
// 它是**派生体，不是第二处真源**：键是 `BlobId`，而 blob 是内容寻址、不可变的，所以这一层
// 不需要失效逻辑、不需要 TTL、不需要跟着修订走——清空它随时安全，它死了系统只是**变慢**，
// 不是跑不起来（`capacityBytes = 0` 就是那条地板）。
//
// 四条硬性（都是测试里会红的那几条）：
//
//   一 · 上限按**字节**计，不按条数：条目大小悬殊（一份源码几十 KB、一个空文件 0 字节），
//        按条数封顶封不住内存。
//   二 · `get` 触达要刷新新旧序：命中的那一条成为最新，淘汰从最旧那一头走。
//   三 · 容量 0 可用：每次 `get` 未命中、每次 `set` 不存（**空条目也不存**）——这就是退化档的
//        直通，调用方不必为"关掉缓存"另写一条路。
//   四 · 超容量的单条**不缓存**（`set` 返回 false，存量一个字节都不动）：塞进去等于把别的东西
//        全挤掉，而直通更诚实。
//
// 内部实现用 `Map` 的删插序（JS 的 Map 保插入序：头是 LRU、尾是 MRU），不另接双向链表——
// 容量上限是 8 MiB 量级、条目数在几千，删一插一的常数代价看不见，而少一个链表就少一处
// "指针与 Map 对不上"的静默错。**两个方向都记账**（图省内存时只留链表、省掉 Map 也是一种
// 写法），这里是三层结构里最里面那一层，可读性优先。
export class BlobLru {
  /** 容量上限，字节。0 = 直通（不存任何东西）。 */
  readonly capacityBytes: number
  /** 键 → 那一条的字节。插入序：头最旧、尾最新。 */
  private readonly rows = new Map<string, Uint8Array>()
  private used = 0
  private hitCount = 0
  private missCount = 0
  private evictedCount = 0
  private evictedBytesCount = 0

  constructor(capacityBytes: number) {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 0) {
      throw new Error(`LRU 的容量必须是非负整数（字节）：${JSON.stringify(capacityBytes)}`)
    }
    this.capacityBytes = capacityBytes
  }

  /** 当前存了多少字节。恒 ≤ 容量。 */
  get bytes(): number {
    return this.used
  }

  /** 当前存了多少条。 */
  get size(): number {
    return this.rows.size
  }

  /**
   * 取一条。**命中就刷新新旧序**（它成了最新的一条），返回值是**独立的一份字节**——
   * 缓存里的那一份不许被调用方改写（它是后面每一次读都要发出去的东西）。
   */
  get(id: string): Uint8Array | undefined {
    const hit = this.rows.get(id)
    if (hit === undefined) {
      this.missCount++
      return undefined
    }
    this.hitCount++
    this.rows.delete(id)
    this.rows.set(id, hit)
    return Uint8Array.prototype.slice.call(hit)
  }

  /** 触达但**不**刷新新旧序、也不记命中——给"只想知道在不在"的地方用（如先滤后发）。 */
  has(id: string): boolean {
    return this.rows.has(id)
  }

  /**
   * 存一条。**超容量的单条不缓存**（返回 false，存量不动）。存得下就淘汰最旧的那些，
   * 直到这一条放得进去为止。存进去的也是**独立的一份**：调用方手里那份随后被改写，
   * 不该把缓存里的这一份带着变。
   *
   * 容量 0 是**显式的一条出口**，不走下面那套：`0 > 0` 为假，零字节的条目会从"装得下"
   * 那一支钻进去，于是"容量 0 一条都不存"就不成立了——这一条是单元测试当场抓出来的。
   */
  set(id: string, bytes: Uint8Array): boolean {
    if (this.capacityBytes === 0 || bytes.byteLength > this.capacityBytes) return false
    const had = this.rows.get(id)
    if (had !== undefined) {
      this.rows.delete(id)
      this.used -= had.byteLength
    }
    const copy = Uint8Array.prototype.slice.call(bytes)
    while (this.used + copy.byteLength > this.capacityBytes) {
      const oldest = this.rows.keys().next()
      if (oldest.done === true) break
      const victim = this.rows.get(oldest.value)
      this.rows.delete(oldest.value)
      if (victim !== undefined) {
        this.used -= victim.byteLength
        this.evictedCount++
        this.evictedBytesCount += victim.byteLength
      }
    }
    this.rows.set(id, copy)
    this.used += copy.byteLength
    return true
  }

  /** 把这一条从缓存里去掉。**它不是失效**（不可变的对象没有失效），是"这一条不再值得占地方"。 */
  delete(id: string): boolean {
    const had = this.rows.get(id)
    if (had === undefined) return false
    this.rows.delete(id)
    this.used -= had.byteLength
    return true
  }

  /** 清空。**随时可以做，且不影响正确性**——缓存是派生体。 */
  clear(): void {
    this.rows.clear()
    this.used = 0
  }

  /** 命中与未命中的次数（`stats()` 报的就是它）。 */
  get hits(): number {
    return this.hitCount
  }

  get misses(): number {
    return this.missCount
  }

  /** 因为容量不够而被挤掉的条数与字节数。 */
  get evictions(): number {
    return this.evictedCount
  }

  get evictedBytes(): number {
    return this.evictedBytesCount
  }

  /** 从最旧到最新，只报键。测试与探针看得出"谁先走"。 */
  keysOldestFirst(): string[] {
    return [...this.rows.keys()]
  }
}
