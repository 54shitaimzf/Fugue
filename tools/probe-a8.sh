#!/bin/sh
# A8 的取证脚本：`fugue round run` 一条命令跑完一个轮次，加打回那三个数。
#
# 它真跑两轮（同一份账，第二轮换个轮次号——一轮只从 Idle 起一次，见下）：
#   一 · 断言全过的一趟：推进发生 · 打回那三个数里 rejects 与 denied 是 0
#        （conflicts 不是 0：第一与第三份草案都改 `src/a.ts`，折叠那一步撞出那一条——
#          这份拆分是故意这么摆的，撞出来的冲突由折叠当场报出、不静默）
#   二 · 故意撞红的一趟（一次验收没过 + 一次动作被拒）→ 三个数逐个大于 0
#   三 · 同一份账上算两次（`status --report`）→ 三个数逐字同值；并钉住那三支里哪几支按轮次
#        筛、哪一支整份账数（重算，不是采集）
#
# 用法：sh tools/probe-a8.sh。退出码 0 且 FAIL 0 才算走通。
set -u
cd /home/ubuntu/fugue || exit 9
FUGUE="node src/cli/fugue.ts"
W=$(mktemp -d /tmp/fugue-a8-XXXXXX)
# 读数落在 $W **之外**：`cleanup` 把工作区整个删掉，落在里面的输出会跟着没。
T=$(mktemp -d /tmp/fugue-a8-read-XXXXXX)
PASS=0
FAIL=0
cleanup() {
  # 两轮各有各的 agent（`agent/<轮次号>/<第几格>`）：逐个 dispose（先卸后删，架构 § 8.4），
  # 漏掉的那一份 overlay 挂载会留在内核里。
  for r in r1 r2; do
    for n in 1 2 3; do
      $FUGUE --root "$W" --agent "agent/$r/$n" dispose > /dev/null 2>&1
    done
  done
  rm -rf "$W" "$T"
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
check() {
  a=$(printf %s "$2" | tr -d ' \n')
  b=$(printf %s "$3" | tr -d ' \n')
  if [ "$a" = "$b" ]; then ok "$1：$b"; else bad "$1：期望 $a，实得 $b"; fi
}
has() { if grep -q "$2" "$1"; then ok "$3"; else bad "$3"; fi }

echo "=== 一 · 建仓库：一个提交 + 拆分草案 + 两条真断言 ==="
git -C "$W" init -q
mkdir -p "$W/src" "$W/.fugue"
printf 'export const a = 1\n' > "$W/src/a.ts"
printf 'export const b = 2\n' > "$W/src/b.ts"
$FUGUE --root "$W" write src/a.ts --from "$W/src/a.ts" > /dev/null || bad "write a.ts"
$FUGUE --root "$W" write src/b.ts --from "$W/src/b.ts" > /dev/null || bad "write b.ts"
$FUGUE --root "$W" commit -m '起点' > /dev/null || bad "commit"
BASE=$(git -C "$W" rev-parse refs/heads/main)
# 三份草案：第一与第三的写入面都是 `src/a.ts` —— **它们相交**。于是：
#   · `Planning` 那一档**报出来、照发**（PLAN § 5.7 的口径一）
#   · 合并前那一档**缺省只报不拒**（判决印在报告那一行，折叠照做——撞出折叠里那次冲突）
#     （把那一档的严宽拉平到 `Planning` 那一档；真冲突由折叠当场报出，不静默）
$FUGUE --root "$W" config set round.split \
  '[{"goal":"改 a","ownedPaths":["src/a.ts"],"assertions":[{"action":"x","name":"x"}]},
    {"goal":"改 b","ownedPaths":["src/b.ts"],"assertions":[{"action":"x","name":"x"}]},
    {"goal":"也改 a","ownedPaths":["src/a.ts"],"assertions":[{"action":"x","name":"x"}]}]' \
  > /dev/null || bad "config set round.split"
$FUGUE --root "$W" config set round.assertions \
  '[{"name":"合并之后 src/a.ts 在","argv":["/bin/sh","-c","test -f src/a.ts"]},
    {"name":"合并之后 src/b.ts 在","argv":["/bin/sh","-c","test -f src/b.ts"]}]' \
  > /dev/null || bad "config set round.assertions"
printf '  base = %s\n' "$BASE"

echo
# 折叠时撞出的那一次冲突由**两条契约改同一条文件**造成（第一与第三都是 `src/a.ts`）。
# 打桩的解决那一格按 `ResolveHint` 把冲突路径**收敛到下一折那一路**——逐路折叠这条路上，
# 收敛到另一侧的话下一折会报同一个冲突（那是这条路的真实形状，写进提交信息的疑点里）。

echo "=== 二 · 断言全过的一趟：一条命令跑完一个轮次 ==="
$FUGUE --root "$W" round run '把 a 与 b 各改一处' --report > "$T/run1.out" 2> "$T/run1.err"
RC1=$?
printf '  rc = %s\n' "$RC1"
sed 's/^/  /' "$T/run1.out"
sed 's/^/  err| /' "$T/run1.err"
check "断言全过那一趟的退出码" "0" "$RC1"
has "$T/run1.out" '验收：通过' "验收那一行印出来了"
has "$T/run1.out" '打回读数' "--report 印了三个数"
# **只有一轮时的整份账**：`status --report` 印的是账上那三个数（不带轮次的那一档），而上面那一趟
# `--report` 印的是**这一轮**。账上此刻只有 `r1`，所以两处该同值——那就是序 32 那条"两处出口同一份
# 折法"（`src/probe/round.ts` 的 `countsOf`）。
$FUGUE --root "$W" status --report --json > "$T/after1.json" 2> "$T/after1.err" || bad "status --report（只有 r1 时）"
node -e '
const fs = require("fs")
const T = process.argv[1]
const j = JSON.parse(fs.readFileSync(T + "/after1.json", "utf8"))
const m = Object.fromEntries(j.report.map((r) => [r.metric, r.count]))
console.log("  账上只有 r1 时，整份账那三个数：" + JSON.stringify(m))
const ok = m.conflicts === 1 && m.rejects === 0 && m.denied === 0
console.log((ok ? "ok   " : "FAIL ") + "   只有一轮时两处读法同值（conflicts 1 · rejects 0 · denied 0）")
process.exit(ok ? 0 : 1)
' "$T" && ok "只有 r1 时 status --report 的读数" || bad "只有 r1 时 status --report 的读数"

echo
echo "=== 三 · 故意撞红的一趟：三个数逐个大于 0 ==="
# 把主线与工作树一起推回起点（上一趟推进过了），再开一轮：这次带 --fail 与 --deny。
# **盘上也要摊回起点那一份**：A10 之后漂移那一档的判据看得见"盘上与底/目标树都不同的那些"，
# 只挪主线、让盘上停在上一趟的结果上的话，这一趟会先被漂移那一档拦下（拒的话里报出 `src/a.ts`），
# 撞红的读数就读不出来了。
git -C "$W" update-ref refs/heads/main "$BASE"
printf 'export const a = 1\n' > "$W/src/a.ts"
printf 'export const b = 2\n' > "$W/src/b.ts"
# **另起一个轮次号**：处境守卫是逐轮的（`src/round/start.ts` 第一步——`Idle → Planning` 只在
# `Idle` 里成立，架构 § 8.13）。`r1` 已经从 Idle 起过头了，同一个号不会再起第二次；而这一节要的
# 是**同一份账上的第二轮**（第四节拿 `r1` 那一轮与它对照），所以换号，不换账。
$FUGUE --root "$W" config set round.id r2 > /dev/null || bad "config set round.id r2"
# `--retry 1`：给那条回边一次余量，于是这一趟停在 `Working`（回边走了一次 = 打回读数第二个数）。
$FUGUE --root "$W" round run '再跑一趟，故意撞红' --fail '合并之后 src/b.ts 在' --deny --retry 1 --report --json > "$T/run2.json" 2> "$T/run2.err"
RC2=$?
printf '  rc = %s（没通过那一档的退出码该是 1）\n' "$RC2"
sed 's/^/  err| /' "$T/run2.err"
check "撞红那一趟的退出码" "1" "$RC2"
node -e '
const fs = require("fs")
const T = process.argv[1]
const j = JSON.parse(fs.readFileSync(T + "/run2.json", "utf8"))
// 打回三数在 `--json` 的 `report` 那一栏；`metrics` 那一栏是八元指标（不给 `--metrics` 时是 null）。
const m = Object.fromEntries(j.report.map((r) => [r.metric, r.count]))
console.log("  三个数：" + JSON.stringify(m))
console.log("  验收：" + JSON.stringify(j.verify))
console.log("  折叠：" + JSON.stringify(j.fold) + "  冲突树：" + JSON.stringify(j.conflictTree))
console.log("  被拒的动作：" + JSON.stringify(j.deniedAction))
console.log("  推进：" + (j.advanced === null ? "没有（真品：没过就一个字节不动）" : JSON.stringify(j.advanced)))
console.log("  停下来那个状态：" + j.state)
const allPositive = m.conflicts > 0 && m.rejects > 0 && m.denied > 0
console.log((allPositive ? "ok   " : "FAIL ") + "   三个数逐个大于 0")
console.log((j.advanced === null ? "ok   " : "FAIL ") + "   验收没过 → 推进没有发生")
console.log((j.verify.ok === false ? "ok   " : "FAIL ") + "   验收判成没过")
console.log((j.state === "Working" ? "ok   " : "FAIL ") + "   带余量时回 Working（打回那条回边）")
process.exit(allPositive && j.advanced === null && j.verify.ok === false && j.state === "Working" ? 0 : 1)
' "$T" && ok "撞红那一趟的读数" || bad "撞红那一趟的读数"

echo
echo "=== 四 · 同一份账上算两次：三个数逐字同值（重算，不采集） ==="
# **这一节不再开新一轮**：要证的是"那三个数是从账上重算出来的"，所以取数这一下不许有轮次动作
# 掺进来——`status --report` 只读账（不取锁 · 不起轮次，架构 § 9.7）。算两次，两份逐字比。
# **顺带钉住口径**：那三支里 `conflicts`（第 61 行）与 `rejects`（第 66 行）按轮次筛
# （`range.round`），`denied`（第 72 行）不筛——`run/end` 事件里没有轮次那一栏。
$FUGUE --root "$W" status --report --json > "$T/recalc1.json" 2> "$T/recalc1.err" || bad "status --report（第一次）"
$FUGUE --root "$W" status --report --json > "$T/recalc2.json" 2> "$T/recalc2.err" || bad "status --report（第二次）"
node -e '
const fs = require("fs")
const T = process.argv[1]
const read = (f) => JSON.parse(fs.readFileSync(T + "/" + f, "utf8"))
const num = (j) => Object.fromEntries(j.report.map((r) => [r.metric, r.count]))
const w1 = read("recalc1.json").report
const w2 = read("recalc2.json").report
const one = num(read("after1.json"))
const two = num(read("run2.json"))
const whole = num(read("recalc1.json"))
console.log("  r1 那一轮：" + JSON.stringify(one))
console.log("  r2 那一轮：" + JSON.stringify(two))
console.log("  整份账：" + JSON.stringify(whole))
const same = JSON.stringify(w1) === JSON.stringify(w2)
const sumC = one.conflicts + two.conflicts
const sumR = one.rejects + two.rejects
const cOk = whole.conflicts === sumC
const rOk = whole.rejects === sumR
const dOk = whole.denied === two.denied
console.log((same ? "ok   " : "FAIL ") + "   同一份账算两次：逐字同值")
console.log((cOk ? "ok   " : "FAIL ") + "   conflicts 按轮次筛：整份账 " + whole.conflicts + " = r1 的 " + one.conflicts + " + r2 的 " + two.conflicts)
console.log((rOk ? "ok   " : "FAIL ") + "   rejects 按轮次筛：整份账 " + whole.rejects + " = r1 的 " + one.rejects + " + r2 的 " + two.rejects)
console.log((dOk ? "ok   " : "FAIL ") + "   denied 不按轮次筛：整份账 " + whole.denied + " = r2 那一趟读出来的 " + two.denied + "（逐轮相加会重复计）")
process.exit(same && cOk && rOk && dOk ? 0 : 1)
' "$T" && ok "重算那一条" || bad "重算那一条"

echo
echo "=== 五 · 三个数的判据指得出（三个字段各自一处定义） ==="
node -e '
const fs = require("fs")
const src = fs.readFileSync("src/probe/round.ts", "utf8")
const want = ["merge/attempt", "Verifying", "run/end"]
const missing = want.filter((w) => !src.includes(w))
console.log((missing.length === 0 ? "ok   " : "FAIL ") + "   三条判据在那一份里逐条写出来了")
console.log("  判据：" + JSON.stringify(want))
process.exit(missing.length === 0 ? 0 : 1)
' && ok "判据那一节" || bad "判据那一节"

echo
if [ "$FAIL" = "0" ]; then printf 'PASS %s · FAIL 0\n' "$PASS"; else printf 'PASS %s · FAIL %s\n' "$PASS" "$FAIL"; fi
[ "$FAIL" = "0" ]
