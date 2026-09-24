#!/bin/sh
# Z3 的红负对照（**取证用，不是产品的一部分**，随时可重跑）：
#
#   甲 · 把 ⑤ 里那条反事实换成恒等映射（产品那一份不动）——**只红 ⑤**，报的是「状态塞进了参数面，
#        哈希却没变——② 那一行相等是恒等式」。它量的是：② 那一行相等之所以有意义，是因为 ⑤ 真的
#        把状态塞进了字节；反事实一空，它就自己招了。
#   乙 · 把 `read` 那一条从目录里真删掉（产品那一份）——**③ 红**（目录里 14 条 · 能力表对这份目录
#        有话说），⑤ 跟着红（它比的是整份目录的哈希）。它量的是「目录是名字的定义处」这句承重的
#        读法：掉一条工具，两处名字表当场不相等——那不是「少一条描述」，是少一个能力。
#
# 两个临时文件都落在 `src/tools/` 里、名字以 `.` 开头、后缀不是 `.test.ts`：测试与真身同目录，
# 相对 import 才对得上；而 `tools/test-entry.js` 扫的是 `*.test.ts`，扫不到它们。
set -u
cd /home/ubuntu/fugue || exit 9
RUN=src/tools/.__neg-runner.ts
TST=src/tools/.__neg.test.ts
OUT=/tmp/neg-z3
rm -rf "$OUT"; mkdir -p "$OUT"
rm -f "$RUN" "$TST"
trap 'rm -f "$RUN" "$TST"' EXIT

python3 - "$RUN" "$TST" <<'PY'
import io, sys
run, tst = sys.argv[1], sys.argv[2]
q = chr(39)
def ree(what, mod):
    return "export { %s } from %s%s%s" % (", ".join(what), q, mod, q)
lines = [
 "// 替身：一切从真身转出。目录那一份不动——这一档要验的是「测试里那条反事实能抓住状态泄漏」，",
 "// 所以改动落在 ⑤ 那份反事实构造上，而不是产品那一份（改动落在产品上会让 ① 与 ② 也红，而它们",
 "// 红的原因会是别的东西）。",
 "// 用 export ... from（不是 import）：import 进来的名字只在本模块里可见，不会转出去。",
 ree(["TOOL_ENTRIES", "CATALOG_STATES", "catalog", "catalogBytes", "catalogHash", "catalogNames", "toolHash", "TOOL_NAMES"], "./catalog.ts"),
 # 协议值那一栏也从这里转出：测试副本里凡是 import 真身的行都指到替身模块，转出才跟得上。
 ree(["SUBAGENT_PROTOCOL", "HOLDER_PROTOCOL"], "../assemble/protocol.ts"),
 "export type * from " + q + "./catalog.ts" + q,
]
io.open(run, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")

s = io.open("src/tools/catalog.test.ts", encoding="utf-8").read()
s = s.replace("from './catalog.ts'", "from './.__neg-runner.ts'")
s = s.replace("from '../assemble/protocol.ts'", "from './.__neg-runner.ts'")
# ⑤ 那份反事实构造：不动产品，只把「状态写进参数面」这件事做在构造里。
start = s.index("  /** 替身目录：`todo_write` 的参数面里多一句随状态变的话")
end = s.index("  const withTodo = catalogHash(leaky(1))")
s = s[:start] + """  /** 反事实目录：硬纪律 2 要拦下的那种写法——参数面里带上这一步的状态。 */
  const leaky = (pending: number): ToolEntry[] =>
    TOOL_ENTRIES.map((t) =>
      // tools/neg-z3.sh 的甲把下一行换成一个恒等映射，量的是这条反事实真的在做那件事。
      t.name === 'todo_write'
        ? { ...t, parameters: { ...t.parameters, note: `现在有 ${pending} 条待办` } }
        : { ...t },
    )

""" + s[end:]
io.open(tst, "w", encoding="utf-8", newline="\n").write(s)
PY

brief() {
  grep -E '^(✔|✖) ' "$1" | head -10
  grep -E '^ℹ (tests|pass|fail)' "$1"
  echo "  --- 断言原文 ---"
  grep -E 'AssertionError' "$1" | head -6
}

echo "=== 甲 · ⑤ 那条反事实被换成恒等映射（产品那一份不动）==="
# 恒等映射 = 反事实什么都没做：⑤ 的 `notEqual` 当场不成立。它量的是这条反事实真的在做那件事。
python3 - "$TST" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = "        ? { ...t, parameters: { ...t.parameters, note: `现在有 ${pending} 条待办` } }"
if s.count(old) != 1:
    print("反事实那一行没对上，停"); raise SystemExit(2)
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, "        ? { ...t }", 1))
print("反事实已经换成恒等映射")
PY
node --test "$TST" > "$OUT/jia.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/jia.txt"

echo
echo "=== 乙 · read 那一条从目录里掉出去（少一条工具）==="
# 少一条工具红的是 ①（名字表那两句话不再相等）与 ③（能力表对这份目录有话说），量的正是
# 「目录是名字的定义处」这句**承重**的读法。定义与恢复都用同一段原文，逐字对上。
python3 - <<'PY'
import io
p = "src/tools/catalog.ts"
s = io.open(p, encoding="utf-8").read()
block = """  {
    name: 'read',
    description: '读一个文件的内容。可以只读一段。',
    parameters: {
      type: 'object',
      properties: {
        path: PATH,
        offset: { type: 'integer', description: '从第几行开始（从 1 数）' },
        limit: { type: 'integer', description: '最多读几行' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
"""
if s.count(block) != 1:
    print("read 那一条没对上，停"); raise SystemExit(2)
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(block, "", 1))
io.open("/tmp/neg-z3/read-block.txt", "w", encoding="utf-8", newline="\n").write(block)
print("read 那一条已经删掉")
PY
node --test "$TST" > "$OUT/yi.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/yi.txt"
python3 - <<'PY'
import io
p = "src/tools/catalog.ts"
s = io.open(p, encoding="utf-8").read()
block = io.open("/tmp/neg-z3/read-block.txt", encoding="utf-8").read()
i = s.index("  {\n    name: 'glob',")
io.open(p, "w", encoding="utf-8", newline="\n").write(s[:i] + block + s[i:])
print("read 那一条已经复原")
PY
if ! grep -q "name: 'read'," src/tools/catalog.ts; then echo "复原没复干净，停"; exit 2; fi

echo
echo "=== 复原之后，正面再跑一次 ==="
node --test src/tools/catalog.test.ts > "$OUT/good.txt" 2>&1
echo "rc=$?"
grep -E '^ℹ (tests|pass|fail)' "$OUT/good.txt"
