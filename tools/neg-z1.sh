#!/bin/sh
# Z1 的两条红负对照（**取证用，不是产品的一部分**，随时可重跑）：
#
#   甲 · 把缺省分区反掉（`文件内容` → A 区），其余一切照旧——**④ 该红，别的该绿**。
#        它量的是 Z1 补上的那几条：没有它们，甲只红 ④ 里「两档共用同一条实现」那一句，
#        而 ②（四个 agent 的 A 区全等）照样绿——因为分区错了以后 A 区仍然全等，
#        只是相等的不是那三段。这正是「红负对照」本来要抓、而旧版断言抓不到的东西。
#   乙 · 把契约 `ZONE_OF` 反掉（不碰装配器）——**② 该红**，④ ⑤ 跟着红。
#
# 两个临时文件都落在 `src/assemble/` 里、名字以 `.` 开头、后缀不是 `.test.ts`：
# ① 里 `readFileSync('./assemble.ts')` 与 `__fixture__` 都靠这个位置才对得上，
# 而 `tools/test-entry.js` 扫的是 `*.test.ts`，扫不到它们。
set -u
cd /home/ubuntu/fugue || exit 9
RUN=src/assemble/.__neg-runner.ts
TST=src/assemble/.__neg.test.ts
OUT=/tmp/neg-z1
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
 "// 替身：只把分区换掉，其余一切从真身转出。",
 "// 用 export ... from（不是 import）：import 进来的名字只在本模块里可见，不会转出去。",
 ree(["hashOf", "readingOf", "readPrefix", "zoneBytes", "firstDivergence", "assembleWith"], "./assemble.ts"),
 ree(["ZONE_SEGMENTS", "HOLDER_B", "ZONE_OF", "zoneSplit"], "./contract.ts"),
 "export type * from " + q + "./contract.ts" + q,
 ree(["DEFAULT_MODEL", "MODELS", "modelOf"], "./models.ts"),
 ree(["TOOL_NAMES", "SUBAGENT_PROTOCOL", "HOLDER_PROTOCOL", "PROTOCOLS", "protocolOf", "protocolNamed", "checkProtocolInvariant"], "./protocol.ts"),
 ree(["render", "stableStringify", "RenderError"], "./render.ts"),
 "import type { AssembleInput, Partition } from " + q + "./contract.ts" + q,
 "import { DEFAULT_PARTITION } from " + q + "./contract.ts" + q,
 "import { assembleWith as assembleWithReal } from " + q + "./assemble.ts" + q,
 "/** 缺省分区反掉的那一档：文件内容 归 A 区。 */",
 "export const BAD_PARTITION: Partition = (id) => (id === " + q + "文件内容" + q + " ? " + q + "A" + q + " : DEFAULT_PARTITION(id))",
 "export function assemble(i: AssembleInput) {",
 "  return assembleWithReal(i, BAD_PARTITION)",
 "}",
]
io.open(run, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")

s = io.open("src/assemble/assemble.test.ts", encoding="utf-8").read()
for name in ("contract", "models", "protocol", "render", "assemble"):
    s = s.replace("from './%s.ts'" % name, "from './.__neg-runner.ts'")
# 测试自己也要用反掉的那一档，否则它会拿真分区给替身对账，两边一起错、比出来仍然相等
old_imp = "import { DEFAULT_PARTITION, HOLDER_B, ZONE_SEGMENTS, zoneSplit } from './.__neg-runner.ts'"
new_imp = "import { BAD_PARTITION as DEFAULT_PARTITION, HOLDER_B, ZONE_SEGMENTS, zoneSplit } from './.__neg-runner.ts'"
if old_imp not in s:
    print("测试副本的 import 一行都没换到"); sys.exit(2)
s = s.replace(old_imp, new_imp)
io.open(tst, "w", encoding="utf-8", newline="\n").write(s)
PY

brief() {
  grep -E '^(✔|✖) ' "$1" | head -10
  grep -E '^ℹ (tests|pass|fail)' "$1"
  echo "  --- 断言原文 ---"
  grep -E 'AssertionError' "$1" | head -6
}

echo "=== 甲 · 缺省分区反掉（契约不动）==="
node --test "$TST" > "$OUT/jia.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/jia.txt"

echo
echo "=== 乙 · 契约 ZONE_OF 反掉（装配器不动）==="
sed -i "s#^  文件内容: 'B',#  文件内容: 'A',#" src/assemble/contract.ts
if ! grep -q "^  文件内容: 'A'," src/assemble/contract.ts; then echo "改契约没改到，停"; exit 2; fi
grep -n "^  文件内容" src/assemble/contract.ts
node --test src/assemble/assemble.test.ts > "$OUT/yi.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/yi.txt"
sed -i "s#^  文件内容: 'A',#  文件内容: 'B',#" src/assemble/contract.ts
grep -n "^  文件内容" src/assemble/contract.ts

echo
echo "=== 复原之后，正面再跑一次 ==="
node --test src/assemble/assemble.test.ts > "$OUT/good.txt" 2>&1
echo "rc=$?"
grep -E '^ℹ (tests|pass|fail)' "$OUT/good.txt"
