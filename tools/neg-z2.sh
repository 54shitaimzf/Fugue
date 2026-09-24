#!/bin/sh
# Z2 的红负对照（**取证用，不是产品的一部分**，随时可重跑）：
#
#   甲 · 把 `bash` 那一格从执行层挪到视图层（表本身），其余一切照旧——**① 与 ③ 该红，别的该绿**。
#        它量的是「层不是标签，是四个开关」：层一挪，先物化与关进沙箱两条同时不成立。
#   乙 · 把同一次改动做在推论的算式里（层不动）——**③ 该红，而 ① 该绿**。
#        两条合起来才说明「表写层、推论由层算出来」这两个方向各有一条断言看着：
#        甲红的是「层与目录对不上」，乙红的是「层对了而推论没跟着」。
#
# 两个临时文件都落在 `src/capability/` 里、名字以 `.` 开头、后缀不是 `.test.ts`：
# 测试与真身同目录，相对 import 才对得上；而 `tools/test-entry.js` 扫的是 `*.test.ts`，扫不到它们。
set -u
cd /home/ubuntu/fugue || exit 9
RUN=src/capability/.__neg-runner.ts
TST=src/capability/.__neg.test.ts
OUT=/tmp/neg-z2
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
 "// 替身：一切从真身转出，只多给一条「把某个工具的层换掉」的算法。",
 "// 用 export ... from（不是 import）：import 进来的名字只在本模块里可见，不会转出去。",
 ree(["TOOL_NAMES", "CAPABILITY_TABLE", "lookup", "namesOn", "inferences", "checkInvariant", "INFERENCES", "INFERENCE_LIST"], "./table.ts"),
 "export type * from " + q + "./table.ts" + q,
 "import type { Capability, Layer } from " + q + "./table.ts" + q,
 "import { inferences } from " + q + "./table.ts" + q,
 "/** 某一格的四条推论：层的取值由调用方给，算法与产品同一处。 */",
 "export function INFERENCES_OF(layer: Layer, decl: boolean): Omit<Capability, " + q + "tool" + q + " | " + q + "layer" + q + " | " + q + "capability" + q + "> {",
 "  return inferences(layer, decl)",
 "}",
]
io.open(run, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")

s = io.open("src/capability/table.test.ts", encoding="utf-8").read()
s = s.replace("from './table.ts'", "from './.__neg-runner.ts'")
# 测试副本用同一份算法，只是输入换成替身表：所以它从替身模块取，而不是自己再写一遍。
s = s.replace(
  "import { CAPABILITY_TABLE, checkInvariant, lookup, namesOn } from './.__neg-runner.ts'",
  "import { CAPABILITY_TABLE, INFERENCES_OF, checkInvariant, lookup, namesOn } from './.__neg-runner.ts'")
# ⑥ 里那份本地算法搬进替身模块了，这里只留 import。
start = s.find("/** 替身表那一格的四条推论")
if start < 0:
    print("测试副本里那份本地算法没找到"); sys.exit(2)
s = s[:start].rstrip() + "\n"
io.open(tst, "w", encoding="utf-8", newline="\n").write(s)
PY

brief() {
  grep -E '^(✔|✖) ' "$1" | head -10
  grep -E '^ℹ (tests|pass|fail)' "$1"
  echo "  --- 断言原文 ---"
  grep -E 'AssertionError' "$1" | head -6
}

echo "=== 甲 · bash 那一格挪到视图层（表本身）==="
sed -i "s#^  execute: \['bash', 'run_action'\],#  execute: ['run_action'],#" src/capability/table.ts
sed -i "s#^  view: \['read', 'write', 'edit', 'read_image', 'glob', 'grep'\],#  view: ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash'],#" src/capability/table.ts
if ! grep -q "^  view: .*'bash'" src/capability/table.ts; then echo "改表没改到，停"; exit 2; fi
grep -n "^  view:\|^  execute:" src/capability/table.ts
node --test "$TST" > "$OUT/jia.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/jia.txt"
sed -i "s#^  view: \['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash'\],#  view: ['read', 'write', 'edit', 'read_image', 'glob', 'grep'],#" src/capability/table.ts
sed -i "s#^  execute: \['run_action'\],#  execute: ['bash', 'run_action'],#" src/capability/table.ts

echo
echo "=== 乙 · 同一次改动做在算里（表的层不动）==="
sed -i "s#^    materialize: layer === 'execute',#    materialize: layer === 'view',#" src/capability/table.ts
if ! grep -q "^    materialize: layer === 'view'," src/capability/table.ts; then echo "改算没改到，停"; exit 2; fi
grep -n "materialize: layer ===" src/capability/table.ts
node --test "$TST" > "$OUT/yi.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/yi.txt"
sed -i "s#^    materialize: layer === 'view',#    materialize: layer === 'execute',#" src/capability/table.ts
grep -n "materialize: layer ===" src/capability/table.ts

echo
echo "=== 复原之后，正面再跑一次 ==="
node --test src/capability/table.test.ts > "$OUT/good.txt" 2>&1
echo "rc=$?"
grep -E '^ℹ (tests|pass|fail)' "$OUT/good.txt"
