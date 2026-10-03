# 0.3.0 接线增量：walk 的限制状态

这一份叠在 0.2.5 清单缓存之上，只增加可观察的句柄能力，给后续 grep/glob
如实呈现截尾提供依据。原有 `ToolHost.walk()` 的路径数组、顺序和边界完全不变。
冻结的 View 契约、工具目录文案与模型回执尚未改变；后者在接线增量中一起处理。

产品宿主额外提供 `walkDetailed()`，与普通 `walk()` 共用同一次缓存遍历：

```ts
interface WalkResult {
  readonly paths: readonly string[]
  readonly truncated: boolean
  readonly limits: readonly ('rows' | 'depth')[]
}
```

- `truncated` 表示因预算而未完成枚举，不声称已经知道遗漏了多少个文件
- `rows`：已有 5,000 个候选后又遇到文件或未走的目录；刚好 5,000 个且没有
  更多文件/目录时不报截尾，软链和 gitlink 的尾部也不算遗漏候选
- `depth`：目录深度超过原有 24；被跳过的目录可能为空，仍如实报「未枚举」
- 两种限制可以同时出现；原因顺序固定为 rows、depth
- 缓存返回独立的路径数组和原因数组；写入视图、枚举失败、遍历期间的变更
  与旧请求晚完成的处理沿用上一增量
- 可选能力未接上的旧宿主仍可用普通 walk；不能凭旧数组长度假称枚举完整

```sh
node tools/test-entry.js fast src/tools/walk.test.ts
node tools/bench-walk.js
```

测试覆盖精确边界、真正遗漏、只有软链/gitlink 的尾部、两个限制的组合、
生产的 5,000/24 阈值、独立数组和同一产品宿主两种读口共用缓存。
这一增量没有执行面、权限、网络、凭据、外部依赖或版本号变化。
