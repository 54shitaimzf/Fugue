#!/bin/sh
# Z6 的红负对照（**取证用，不是产品的一部分**，随时可重跑）：
#
#   甲 · 把宿主名那一条检查短路（`envHits` 里不查宿主名、也不查 pid）——**① 该红**（少一处），
#        报的是「短路之后还报得出宿主名」。它量的就是 ④ 那句：这一条检查真的在做事。
#   乙 · 把 Signal 那一条判据换成永不命中——**① 该红**（`Signal 原文没报出来`），
#        报的是另一处。两条合起来说明四条约束各有各的判据，不是一条共用的"什么都报"。
#
# 两个临时文件都落在 `src/assemble/` 里、名字以 `.` 开头、后缀不是 `.test.ts`：测试与真身同目录，
# 相对 import 才对得上；而 `tools/test-entry.js` 扫的是 `*.test.ts`，扫不到它们。
set -u
cd /home/ubuntu/fugue || exit 9
RUN=src/assemble/.__neg6-runner.ts
TST=src/assemble/.__neg6.test.ts
OUT=/tmp/neg-z6
rm -rf "$OUT"; mkdir -p "$OUT"
rm -f "$RUN" "$TST"
cp src/assemble/constraints.ts "$OUT/constraints.bak"
trap 'cp "$OUT/constraints.bak" src/assemble/constraints.ts; rm -f "$RUN" "$TST"' EXIT

python3 - "$RUN" "$TST" <<'PY'
import io, sys
run, tst = sys.argv[1], sys.argv[2]
q = chr(39)
def ree(what, mod):
    return "export { %s } from %s%s%s" % (", ".join(what), q, mod, q)
lines = [
 "// 替身：一切从真身转出。用 export ... from（不是 import）：import 进来的名字不会转出去。",
 ree(["CONSTRAINT_KINDS", "CONSTRAINT_NAMES", "checkConstraints", "envFacts", "formatViolation", "kindIndex"], "./constraints.ts"),
 "export type * from " + q + "./constraints.ts" + q,
 ree(["ZONE_SEGMENTS", "HOLDER_B", "DEFAULT_PARTITION", "zoneSplit", "ZONE_OF"], "./contract.ts"),
 "export type * from " + q + "./contract.ts" + q,
 ree(["DEFAULT_MODEL", "MODELS"], "./models.ts"),
 ree(["SUBAGENT_PROTOCOL", "HOLDER_PROTOCOL"], "./protocol.ts"),
 ree(["render", "stableStringify"], "./render.ts"),
 ree(["assemble", "hashOf", "firstDivergence"], "./assemble.ts"),
 ree(["emptyState", "sourcesFor", "HOLDER"], "./sources.ts"),
 "export type * from " + q + "./sources.ts" + q,
 ree(["stateWithState"], "./sources-state.ts"),
]
io.open(run, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")

s = io.open("src/assemble/constraints.test.ts", encoding="utf-8").read()
for name in ("contract", "models", "protocol", "render", "assemble", "sources", "sources-state", "constraints"):
    s = s.replace("from './%s.ts'" % name, "from './.__neg6-runner.ts'")
io.open(tst, "w", encoding="utf-8", newline="\n").write(s)
print("测试副本已经建好：", tst, len(s), "字节")
PY

brief() {
  grep -E '^(✔|✖) ' "$1" | head -10
  grep -E '^ℹ (tests|pass|fail)' "$1"
  echo "  --- 断言原文 ---"
  grep -E 'AssertionError' "$1" | head -6
}

echo "=== 甲 · 宿主名那一条检查短路（不查宿主名、不查 pid）==="
python3 - <<'PY'
import io
p = "src/assemble/constraints.ts"
s = io.open(p, encoding="utf-8").read()
old = """  const hits = facts.hostname === '' ? [] : allIn(bytes, new RegExp(escapeRe(facts.hostname), 'g'))
  if (facts.pid > 0) hits.push(...allIn(bytes, new RegExp(`(?:^|[^0-9])${facts.pid}(?![0-9])`, 'g')))
  return hits"""
new = """  const hits: string[] = []
  return hits"""
if s.count(old) != 1:
    print("envHits 那两行没对上，停"); raise SystemExit(2)
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new))
print("宿主名那一条已经短路")
PY
node --test "$TST" > "$OUT/jia.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/jia.txt"
cp "$OUT/constraints.bak" src/assemble/constraints.ts

echo
echo "=== 乙 · Signal 那一条判据换成永不命中 ==="
python3 - <<'PY'
import io
p = "src/assemble/constraints.ts"
s = io.open(p, encoding="utf-8").read()
old = "export const SIGNAL_SHAPE = /digest\"?[ \\t]*[:=]/"
new = "export const SIGNAL_SHAPE = /绝不命中的那一条/"
if s.count(old) != 1:
    print("SIGNAL_SHAPE 那一行没对上，停"); raise SystemExit(2)
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new))
print("Signal 那一条已经换成永不命中")
PY
node --test "$TST" > "$OUT/yi.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/yi.txt"
cp "$OUT/constraints.bak" src/assemble/constraints.ts
if ! grep -q "digest" src/assemble/constraints.ts; then echo "复原没复干净，停"; exit 2; fi

echo
echo "=== 复原之后，正面再跑一次 ==="
node --test src/assemble/constraints.test.ts > "$OUT/good.txt" 2>&1
echo "rc=$?"
grep -E '^ℹ (tests|pass|fail)' "$OUT/good.txt"
