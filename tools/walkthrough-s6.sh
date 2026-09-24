#!/bin/sh
# S6 的装配走查（PLAN § 5.6 的 Z7 行 · 架构 § 20 S6 的可用性：可核算缓存命中 · 可做协议 A/B）。
#
# **一条命令跑完这一站**：建仓库 → 一个提交 → 四条 agent 分支 → 四个 agent 各装配一次
# （印三区哈希，hash(zoneA) 四行全等）→ 同一份状态两份协议（印 firstDivergence 落在第几个
# 字节）→ 印三区的字节数与哈希 → 四条约束那五条断言跑一次（坏掉的输入四条全红）→ 地板走两档：
# 段值缺源那一档（代码树缺源时 A 区仍是确定性的）· 单区那一档（tools/single-zone.ts：
# zoneB · zoneC 是空字节而哈希照出）。
#
# **它只用手边的东西**：没有 ensure（不挂载、不起容器），所以收尾不需要拆挂载；每一步都是独立
# 进程（§ 9.6），所以收尾不需要杀进程。trap 那一句是保险，不是流程的一部分。
#
# 用法：sh tools/walkthrough-s6.sh。退出码 0 且 FAIL 0 才算走通。
set -u
cd /home/ubuntu/fugue || exit 9
FUGUE="node src/cli/fugue.ts"
W=$(mktemp -d /tmp/fugue-s6-XXXXXX)
PASS=0
FAIL=0
trap 'rm -rf "$W"' EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
# 两边的空白都削掉再比：命令替换会把结尾的换行带进来，那是 shell 的事，不是读数的事。
check() {
  a=$(printf %s "$2" | tr -d ' \n')
  b=$(printf %s "$3" | tr -d ' \n')
  if [ "$a" = "$b" ]; then ok "$1：$b"; else bad "$1：期望 $a，实得 $b"; fi
}
has() { if grep -q "$2" "$1"; then ok "$3"; else bad "$3"; fi }

echo "=== 一 · 建仓库：一个提交、四条 agent 分支 ==="
git -C "$W" init -q
printf '# 项目方针（走查用）\n\n- 这一份是 S6 走查的靶子。\n' > "$W/AGENTS.md"
mkdir -p "$W/.fugue" "$W/src"
printf '{"platform":"linux","workspace":"fugue","config":{"net":"none"},"ports.range":"31000-31099"}' > "$W/.fugue/config"
printf 'export const a = 1\n' > "$W/src/a.ts"
$FUGUE --root "$W" write src/a.ts --from "$W/src/a.ts" > /dev/null || bad "write src/a.ts"
printf 'export const b = 2\n' > "$W/src/b.ts"
$FUGUE --root "$W" write src/b.ts --from "$W/src/b.ts" > /dev/null || bad "write src/b.ts"
$FUGUE --root "$W" commit -m '起点' > /dev/null || bad "commit"
for n in 1 2 3 4; do
  $FUGUE --root "$W" --agent "agent/r1/$n" branch main > /dev/null || bad "branch agent/r1/$n"
done
check "四条 agent 分支" "4" "$(git -C "$W" for-each-ref --format='%(refname)' refs/heads/agent | wc -l)"

echo
echo "=== 二 · 四个 agent 各装配一次：hash(zoneA) 四行全等 ==="
for n in 1 2 3 4; do
  $FUGUE --root "$W" --json assemble subagent --agent "agent/r1/$n" > "$W/as-$n.json" 2> "$W/as-$n.err" \
    || bad "assemble --agent agent-$n：$(head -1 "$W/as-$n.err")"
done
node -e '
const fs = require("fs")
const w = process.argv[1]
const got = []
for (const n of [1, 2, 3, 4]) {
  const j = JSON.parse(fs.readFileSync(w + "/as-" + n + ".json", "utf8"))
  got.push({ n, a: j.zones.A.hash, v: j.violations.length })
  console.log("  agent-" + n + "  A=" + j.zones.A.hash + "  B=" + j.zones.B.hash + "  C=" + j.zones.C.hash)
}
const same = new Set(got.map((g) => g.a)).size === 1
console.log((same ? "ok   " : "FAIL ") + "   四个 agent 的 A 区哈希全等：" + got[0].a)
const clean = got.every((g) => g.v === 0)
console.log((clean ? "ok   " : "FAIL ") + "   四条约束一处都不报（干净的输入）")
process.exit(same && clean ? 0 : 1)
' "$W" && ok "四个 agent 的 A 区全等且四条约束干净" || bad "四个 agent 的 A 区全等"

echo
echo "=== 三 · 同一份状态两份协议：firstDivergence 落在第几个字节 ==="
$FUGUE --root "$W" --json assemble subagent --agent agent/r1/1 --against holder > "$W/ab.json" 2> "$W/ab.err" \
  || bad "assemble --against holder：$(head -1 "$W/ab.err")"
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1] + "/ab.json", "utf8"))
const at = j.firstDivergence.at
console.log("  A+B = " + (j.zones.A.bytes + j.zones.B.bytes) + " 字节 · 与 " + j.firstDivergence.against + " 第一处不同：第 " + at + " 个字节")
console.log("  " + j.firstDivergence.note)
const good = Number.isInteger(at) && at >= j.zones.A.bytes
console.log((good ? "ok   " : "FAIL ") + "   第一处不同落在 A 区之后（两份声明的差别在 B 区）")
process.exit(good ? 0 : 1)
' "$W" && ok "firstDivergence 那一栏印得出来" || bad "firstDivergence 那一栏"

echo
echo "=== 四 · 三区的字节数与哈希（结账口那两栏）==="
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1] + "/as-1.json", "utf8"))
for (const z of ["A", "B", "C"]) console.log("  " + z + " 区 " + j.zones[z].bytes + " 字节 · " + j.zones[z].hash)
const good = ["A", "B", "C"].every((z) => j.zones[z].bytes > 0 && /^[0-9a-f]{16}$/.test(j.zones[z].hash))
console.log((good ? "ok   " : "FAIL ") + "   三区哈希都印得出来")
process.exit(good ? 0 : 1)
' "$W" && ok "三区那一栏" || bad "三区那一栏"

echo
echo "=== 五 · 四条约束：坏掉的输入四条全红（constraints.test.ts 的 ① 就是这一档）==="
node --test src/assemble/constraints.test.ts > "$W/cons.txt" 2>&1
check "constraints.test.ts 退出码" "0" "$?"
has "$W/cons.txt" "^ℹ pass 5" "四条约束那五条断言全绿"

echo
echo "=== 六 · 地板两档 ==="
node tools/single-zone.ts > "$W/single.txt" 2>&1
check "单区那一档退出码（三区 → 单区）" "0" "$?"
cat "$W/single.txt"
has "$W/single.txt" "B 区 0 字节 · C 区 0 字节" "单区那一档：B 区与 C 区是空字节"
node tools/floor-missing-source.mjs > "$W/missing.txt" 2>&1
check "段值缺源那一档退出码" "0" "$?"
cat "$W/missing.txt"
has "$W/missing.txt" "ok" "段值缺源那一档：代码树缺源时 A 区仍然确定性"

echo
echo "=== 七 · 收尾：不留挂载、不留进程 ==="
check "挂载表里没有 fugue 相关的那一条" "0" "$(grep -c fugue /proc/self/mountinfo)"
check "没有残留的 fugue 进程" "0" "$(pgrep -fc 'cli/fugue' || true)"

echo
echo "PASS $PASS · FAIL $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
