#!/bin/sh
# Z4 的红负对照（**取证用，不是产品的一部分**，随时可重跑）：
#
#   甲 · 把「交接提示词」从 B 区挪进 C 区（产品那一份区表）——**①②④ 该红**，③⑤⑦⑧ 该绿，
#        报的是「段序里 B 区那一截与区表不一致」。它量的就是架构 § 8.11 那句「顺序是承重的」：
#        段序直接决定前缀字节序，而区表是段序的唯一来源。
#   乙 · 把 ⑥ 里那条「现读视图」的替身换成真的读视图那一份（测试副本）——**⑥ 该红**
#        （依赖图里出现了 `../view/`）。它量的是 P2（值是值，不是句柄）在测试里也真的被量到。
#
# 两个临时文件都落在 `src/assemble/` 里、名字以 `.` 开头、后缀不是 `.test.ts`：测试与真身同目录，
# 相对 import 才对得上；而 `tools/test-entry.js` 扫的是 `*.test.ts`，扫不到它们。
set -u
cd /home/ubuntu/fugue || exit 9
RUN=src/assemble/.__neg4-runner.ts
TST=src/assemble/.__neg4.test.ts
OUT=/tmp/neg-z4
rm -rf "$OUT"; mkdir -p "$OUT"
rm -f "$RUN" "$TST"
cp src/assemble/contract.ts "$OUT/contract.bak"
trap 'cp "$OUT/contract.bak" src/assemble/contract.ts; rm -f "$RUN" "$TST"' EXIT

python3 - "$RUN" "$TST" <<'PY'
import io, sys
run, tst = sys.argv[1], sys.argv[2]
q = chr(39)
def ree(what, mod):
    return "export { %s } from %s%s%s" % (", ".join(what), q, mod, q)
lines = [
 "// 替身：一切从真身转出。用 export ... from（不是 import）：import 进来的名字不会转出去。",
 ree(["ZONE_SEGMENTS", "HOLDER_B", "DEFAULT_PARTITION", "zoneSplit", "ZONE_OF"], "./contract.ts"),
 "export type * from " + q + "./contract.ts" + q,
 ree(["DEFAULT_MODEL", "MODELS", "modelOf"], "./models.ts"),
 ree(["SUBAGENT_PROTOCOL", "HOLDER_PROTOCOL", "PROTOCOLS", "protocolOf", "protocolNamed", "checkProtocolInvariant", "TOOL_NAMES"], "./protocol.ts"),
 ree(["render", "stableStringify"], "./render.ts"),
 ree(["assemble", "assembleWith", "hashOf", "readingOf", "readPrefix", "zoneBytes", "firstDivergence"], "./assemble.ts"),
 ree(["HOLDER", "SOURCE_IDS", "SourceError", "emptyState", "readPolicy", "resolverFor", "sourcesFor", "appendOutputs"], "./sources.ts"),
 "export type * from " + q + "./sources.ts" + q,
]
io.open(run, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")

s = io.open("src/assemble/sources.test.ts", encoding="utf-8").read()
for name in ("contract", "models", "protocol", "render", "assemble", "sources"):
    s = s.replace("from './%s.ts'" % name, "from './.__neg4-runner.ts'")
# 乙 那一档做在测试副本里：⑥ 里丙那条构造被换成「那两样都不算数」（依赖图那一条当场红）。
old = """  const live = [
    `import { loadView } from '../view/view.ts'`,
    `const 现读视图 = () => readFileSync('../view/view.ts', 'utf8')`,
  ].join('\\n')
  const 判据说它不算 = false
  assert.equal(
    /from '\\.\\.\\/view\\//.test(live) || (live.match(/readFileSync/g) ?? []).length > 0 || 判据说它不算,
    true,"""
new = """  const live = ''
  const 判据说它不算 = false
  assert.equal(
    false,
    true,"""
if s.count(old) != 1:
    print("⑥ 里丙那条构造没对上，停"); sys.exit(2)
s = s.replace(old, new)
io.open(tst, "w", encoding="utf-8", newline="\n").write(s)
print("测试副本已经建好：", tst, len(s), "字节")
PY
echo "--- 副本里那三处（甲 的区表 + 乙 的构造）---"
grep -n "const live\|判据说它不算" "$TST" | head -5

brief() {
  grep -E '^(✔|✖) ' "$1" | head -10
  grep -E '^ℹ (tests|pass|fail)' "$1"
  echo "  --- 断言原文 ---"
  grep -E 'AssertionError' "$1" | head -6
}

echo "=== 甲 · B 区里的「交接提示词」与「提交序列」对调（产品那一份区表）==="
cp "$OUT/contract.bak" "$OUT/contract.orig"
python3 - <<'PY'
import io
p = "src/assemble/contract.ts"
s = io.open(p, encoding="utf-8").read()
old = "  B: ['工作总目标', '文件内容', '提交序列', '交接提示词', '我的任务'],"
new = "  B: ['工作总目标', '文件内容', '交接提示词', '提交序列', '我的任务'],"
if s.count(old) != 1:
    print("区表 B 区那一行没对上，停"); raise SystemExit(2)
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new))
print("区表 B 区那两段已经对调")
PY
grep -n "  B: \[" src/assemble/contract.ts | head -2
node --test "$TST" > "$OUT/jia.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/jia.txt"
cp "$OUT/contract.orig" src/assemble/contract.ts
grep -n "^  提交序列\|^  交接提示词" src/assemble/contract.ts

echo
echo "=== 乙 · ⑥ 里那条替身换成真的读视图（测试副本）==="
node --test "$TST" > "$OUT/yi.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/yi.txt"

echo
echo "=== 复原之后，正面再跑一次 ==="
node --test src/assemble/sources.test.ts > "$OUT/good.txt" 2>&1
echo "rc=$?"
grep -E '^ℹ (tests|pass|fail)' "$OUT/good.txt"
