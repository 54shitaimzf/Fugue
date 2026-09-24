#!/bin/sh
# A4 的取证脚本（PLAN § 5.7 的 A4 行）：`fugue round new` 一条命令走完"钉底 → 造契约 →
# Planning 预检 → 发契约 → 起分支"，加 `--materialize` 那一档的 N 次物化。
#
# 它跑真命令、印原始读数：四条分支的底 · 日志里那几条事件 · 契约正文与 id/owner 逐条对上 ·
# 相交的那一对报出来而照发 · 物化缺省不做（`deferMaterialize`）。
#
# 用法：sh tools/probe-a4.sh。退出码 0 且 FAIL 0 才算走通。
set -u
cd /home/ubuntu/fugue || exit 9
FUGUE="node src/cli/fugue.ts"
W=$(mktemp -d /tmp/fugue-a4-XXXXXX)
PASS=0
FAIL=0
cleanup() {
  # 挂载先卸再删（`dispose` 那一句的次序）。物化缺省不铺，所以正常收尾什么都不用卸。
  for n in 1 2 3 4; do
    $FUGUE --root "$W" --agent "agent/r1/$n" dispose > /dev/null 2>&1
  done
  rm -rf "$W"
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
check() {
  a=$(printf %s "$2" | tr -d ' \n')
  b=$(printf %s "$3" | tr -d ' \n')
  if [ "$a" = "$b" ]; then ok "$1：$b"; else bad "$1：期望 $a，实得 $b"; fi
}

echo "=== 一 · 建仓库：一个提交 ==="
git -C "$W" init -q
mkdir -p "$W/src" "$W/.fugue"
printf 'export const a = 1\n' > "$W/src/a.ts"
printf 'export const b = 2\n' > "$W/src/b.ts"
$FUGUE --root "$W" write src/a.ts --from "$W/src/a.ts" > /dev/null || bad "write a.ts"
$FUGUE --root "$W" write src/b.ts --from "$W/src/b.ts" > /dev/null || bad "write b.ts"
$FUGUE --root "$W" commit -m '起点' > /dev/null || bad "commit"
BASE=$(git -C "$W" rev-parse refs/heads/main)
printf '  base = %s\n' "$BASE"

# 拆分草案：四份。第一份与第三份**故意相交**（`src/a.ts` 落在 `src` 里），用来量"报出而照发"。
$FUGUE --root "$W" config set round.split \
  '[{"goal":"改 a","ownedPaths":["src/a.ts"],"assertions":[{"action":"test","name":"测试全过"}]},
    {"goal":"改 b","ownedPaths":["src/b.ts"],"assertions":[{"action":"test","name":"测试全过"}]},
    {"goal":"改 src 这一片","ownedPaths":["src"],"assertions":[{"action":"test","name":"测试全过"}]},
    {"goal":"再加一处","ownedPaths":["src/c.ts"],"assertions":[{"action":"test","name":"测试全过"}]}]' \
  > /dev/null || bad "config set round.split"

echo
echo "=== 二 · 开轮次：一条命令（物化缺省不做） ==="
$FUGUE --root "$W" round new '把 a 与 b 各改一处' > "$W/new.out" 2> "$W/new.err"
RC=$?
printf '  rc = %s\n' "$RC"
sed 's/^/  /' "$W/new.out"
sed 's/^/  err| /' "$W/new.err"
check "round new 的退出码" "0" "$RC"
check "stdout 的第一行" "$(printf 'r1\t%s\t4 份契约\t4 条分支' "$BASE")" "$(head -1 "$W/new.out")"

echo
echo "=== 三 · 四条分支的底都是钉住的那一个 ==="
for n in 1 2 3 4; do
  got=$(git -C "$W" rev-parse "refs/heads/agent/r1/$n" 2>/dev/null)
  check "agent/r1/$n 的底" "$BASE" "$got"
done
check "refs/heads 里分支数（main + 四条）" "5" "$(git -C "$W" for-each-ref --format='%(refname)' refs/heads | wc -l)"

echo
echo "=== 四 · 日志里那几条事件 ==="
$FUGUE --root "$W" --json log > "$W/log.json" 2>/dev/null || bad "log"
node -e '
const fs = require("fs")
const W = process.argv[1]
// `--json log` 每一行是 `{pos, e}`（信封 + 事件）：事件在 `e` 里，写者在 `pos.writer` 里。
const lines = fs.readFileSync(W + "/log.json", "utf8").trim().split("\n").map((l) => JSON.parse(l))
const rows = lines.map((l) => l.e)
const by = (t) => rows.filter((r) => r.t === t)
const writers = [...new Set(lines.map((l) => l.pos.writer))].sort()
const states = by("round/state").map((r) => r.from + "->" + r.to)
console.log("  写者：" + writers.join(" · "))
console.log("  round/state：" + states.join(" · "))
console.log("  round/intent：" + by("round/intent").length + " 条")
console.log("  contract/issue：" + by("contract/issue").length + " 条")
console.log("  mat/fork：" + by("mat/fork").length + " 条")
const want = ["Idle->Planning", "Planning->Delegated", "Delegated->Working"]
const okStates = JSON.stringify(states) === JSON.stringify(want)
console.log((okStates ? "ok   " : "FAIL ") + "   三步转移与图一致")
console.log((by("contract/issue").length === 4 ? "ok   " : "FAIL ") + "   四份契约各一条 contract/issue")
console.log((by("mat/fork").length === 0 ? "ok   " : "FAIL ") + "   物化缺省不做：mat/fork 一条都没有")
console.log((writers.join() === "round" ? "ok   " : "FAIL ") + "   这一轮只动了持轮者那一份日志")
let bodyOk = 0
for (const r of by("contract/issue")) {
  const c = JSON.parse(r.body)
  if (c.id === r.contract && c.agent === r.owner) bodyOk++
}
console.log((bodyOk === 4 ? "ok   " : "FAIL ") + "   四条 contract/issue 的正文与 id/owner 逐条对上：" + bodyOk + "/4")
console.log("  契约：" + by("contract/issue").map((r) => r.contract + "(" + JSON.parse(r.body).kind + ")").join(" · "))
console.log("  intent：" + JSON.parse(by("round/intent")[0].body).goal)
process.exit(okStates && by("contract/issue").length === 4 && by("mat/fork").length === 0 && bodyOk === 4 && writers.join() === "round" ? 0 : 1)
' "$W" || bad "日志那一节的读数"

echo
echo "=== 五 · 相交报出来而照发 ==="
grep -q 'r1.implement.1 与 r1.implement.3' "$W/new.err" && ok "相交的那一对报出来了" || bad "相交没报出来：$(cat "$W/new.err")"
grep -q '照发' "$W/new.err" && ok "话里写着照发" || bad "话里没写照发"

echo
echo "=== 六 · --materialize 那一档：N 次 fork，落在各自那一份日志里 ==="
$FUGUE --root "$W" --agent 'agent/r1/1' dispose > /dev/null 2>&1
$FUGUE --root "$W" --json log > "$W/before.json" 2>/dev/null
$FUGUE --root "$W" round new '再开一轮，这次铺物化' --materialize > "$W/mat.out" 2> "$W/mat.err"
RC2=$?
check "--materialize 那一档的退出码" "0" "$RC2"
$FUGUE --root "$W" --json log > "$W/after.json" 2>/dev/null
node -e '
const fs = require("fs")
const W = process.argv[1]
const lines = fs.readFileSync(W + "/after.json", "utf8").trim().split("\n").map((l) => JSON.parse(l))
const rows = lines.map((l) => l.e)
const forks = lines.filter((l) => l.e.t === "mat/fork").map((l) => ({ ...l.e, writer: l.pos.writer }))
const writers = [...new Set(forks.map((r) => r.writer))].sort()
const agents = [...new Set(forks.map((r) => r.agent))].sort()
const bases = [...new Set(forks.map((r) => r.base))]
console.log("  四次 mat/fork 的写者：" + writers.join(" · "))
console.log("  四条分支的底：" + bases.join(" · "))
console.log((forks.length === 4 ? "ok   " : "FAIL ") + "   四条分支各一次 mat/fork（共 " + forks.length + "；第一轮没铺物化，所以是 4 不是 8）")
console.log((writers.length === 4 ? "ok   " : "FAIL ") + "   物化落在四个 agent 各自的日志里")
console.log((agents.length === 4 ? "ok   " : "FAIL ") + "   四个 agent 各一次")
console.log((bases.length === 1 ? "ok   " : "FAIL ") + "   四次 fork 的底是同一个提交")
process.exit(forks.length === 4 && writers.length === 4 && agents.length === 4 && bases.length === 1 ? 0 : 1)
' "$W" || bad "物化那一档的读数"
[ -d "$W/.fugue/mat/agent/r1/1/merged" ] && ok "r1/1 的物化铺出来了（.fugue/mat/r1/1/merged）" || bad "r1/1 没有物化"

echo
echo "=== 七 · 分支已经不是空的：拒 ==="
printf 'x\n' > "$W/src/a.ts"
$FUGUE --root "$W" --agent 'agent/r1/1' write src/a.ts --from "$W/src/a.ts" > /dev/null 2>&1
$FUGUE --root "$W" --agent 'agent/r1/1' commit -m '往前一步' > /dev/null 2>&1
MOVED=$(git -C "$W" rev-parse refs/heads/agent/r1/1)
if [ "$MOVED" != "$BASE" ]; then
  ok "r1/1 的分支头已经挪到 $MOVED"
  $FUGUE --root "$W" round new '第三次' > /dev/null 2> "$W/third.err"
  check "分支被往前挪过之后 round new 的退出码" "1" "$?"
  grep -q '不是空的' "$W/third.err" && ok "拒的话里指得出分支不是空的" || bad "拒的话不对：$(cat "$W/third.err")"
else
  bad "没能把分支往前挪（这条断言量不到东西）"
fi

echo
echo "=== 八 · 幂等那一半：分支本来就指着同一个底 → 照开 ==="
git -C "$W" update-ref refs/heads/agent/r1/1 "$BASE"
$FUGUE --root "$W" round new '第四次' > /dev/null 2> "$W/fourth.err"
check "分支指回底之后再开一次的退出码" "0" "$?"
check "这下 refs/heads 里的分支数没变" "5" "$(git -C "$W" for-each-ref --format='%(refname)' refs/heads | wc -l)"

echo
if [ "$FAIL" = "0" ]; then printf 'PASS %s · FAIL 0\n' "$PASS"; else printf 'PASS %s · FAIL %s\n' "$PASS" "$FAIL"; fi
[ "$FAIL" = "0" ]
