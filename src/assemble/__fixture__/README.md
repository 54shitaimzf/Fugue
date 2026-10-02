这一份是给 `src/assemble/assemble.test.ts` 的断言 ① 当靶子的（目录清单与文件字节两处都得有东西可比）。
它**不是段源**——真实的段源在 `src/assemble/sources.ts`（Z4）；Z4 落地后这一份留了下来，`src/assemble/sources.test.ts` 还在读它。
