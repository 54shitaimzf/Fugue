// 写**自有**一格的口子：全仓要写「人给的键名」的地方都用它——`src/config.ts` 的读 · 写 ·
// 合并 · `src/cli/cmd/config.ts` 的 `ui.keys` 暂存 · `src/boundary/binding.ts` 的 `-- k=v`
// 注入。再有要写自有属性的位置，也走这里，不另起炉灶。
//
// 成员名是数据，`__proto__` 也在内——走 `Object.defineProperty` 才不碰原型链。普通赋值撞上
// `Object.prototype` 上那个设值器：值是对象就写进了原型，值是标量就整个无声无效——两种都是
// 「报成功，那份里什么都没有」（`JSON.stringify` 与 `Object.keys` 只看得见自有属性）。
//
// **描述符要给全**：`defineProperty` 缺省 `enumerable: false`，少给一个就是把「假成功」
// 换成「静默丢键」——两种都不及格。
export function setOwnKey(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}
