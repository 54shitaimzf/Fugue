#!/bin/sh
# S8 的端到端走查（PLAN § 5.12 补完清单序 2 · § 5.9 的闸六 `G6` · 架构 § 20 S8 的三条验证）。
#
# **一条命令跑完这一站（夹具档）**：
#   建两份靶子（打桩那一档 · 回放那一档）→
#   装配走通（三区各印得出 · 两个 agent 的 A 区全等 · 与持轮者的第一处分叉落在 A 之后 ·
#   四条约束干净）→
#   打桩那一档（一条命令跑完一个轮次：验收照过 · 推进真的发生 · 三个数 · 八元指标，
#   退化成平凡值的**如实报**）→
#   指标重算与手工对账（这一段自己按判据重数一遍，与 `--report`/`--metrics` 逐个数对）→
#   回放那一档（`--wire-in`：三份真响应喂回去 · 产物逐字节相同 · 三份调用逐条对上 ·
#   停因「收敛」· 凭据那一步没走 · 归因三处对照三行都在）→
#   回放档的负对照（夹具里改一个字节 → 当场拒）→
#   地板两档（真模型 → 夹具回放 · 接续 → 用完就停）→
#   收尾：不留挂载 · 不留进程 · 不留孤儿分支 → 判据卡骨架（量不到的写「没有读数」）。
#
# **它只用手边的东西**：每一步都是独立进程（§ 9.6），所以收尾不需要杀进程；
# `--wire-in` 那一档不出网、不读凭据，所以**不带 `--live` 时这一份一分钱不花**。
#
# `--live` 那一支落的是四档阶梯里的**单格档 `L3`**（真模型 · 开局就把 `--max-steps` 压到
# 个位数）：一个 agent 走完 · 归因那三处里冷与第 k 步两处有数 · **录下来的字节喂得回回放档**。
# 全程档 `L4`（真任务 · 一份真产物 + 一条真断言）与对照臂 `B14`（单区前缀那一档）归下一次。
#
# 用法：sh tools/walkthrough-s8.sh [--live]。退出码 0 且 FAIL 0 才算走通。KEEP=1 留下现场。
set -u
cd /home/ubuntu/fugue || exit 9
LIVE=no
for a in "$@"; do
  case "$a" in
    --live) LIVE=yes ;;
    *) echo "不认这个开关：$a（这一份的开关只有 --live）"; exit 2 ;;
  esac
done
FUGUE="node src/cli/fugue.ts"
FIX="$PWD/src/cli/__fixture__/wire-in"
T=$(mktemp -d /tmp/fugue-s8-read-XXXXXX)
SW=$(mktemp -d /tmp/fugue-s8-stub-XXXXXX)
RW=$(mktemp -d /tmp/fugue-s8-rep-XXXXXX)
NW=$(mktemp -d /tmp/fugue-s8-nohand-XXXXXX)
BW=$(mktemp -d /tmp/fugue-s8-bad-XXXXXX)
OUT=$(mktemp -d /tmp/fugue-s8-out-XXXXXX)
LW=""
PW=""
if [ "$LIVE" = yes ]; then
  LW=$(mktemp -d /tmp/fugue-s8-live-XXXXXX)
  PW=$(mktemp -d /tmp/fugue-s8-liveback-XXXXXX)
fi
PASS=0
FAIL=0

# **收尾先走产品那一份**（`fugue dispose`：先卸后删，四个坐标一起），再删目录。
# 由头（`src/materialize/mount.ts` 的注释与 `driver.test.ts` 的 `close()` 都记着）：真驱动那一档
# 的沙箱会把物化树挂起来，卸载之后内核在 `tmp/work/` 里留一个 `root:root 000` 的 `work/work`
# ——`rm -rf` 会先读目录，于是在它上面吃 `EACCES`（`fs.rmSync` 那一档实测红过）。`dispose`
# 走的是 `clearMaterialization` + `removeTree`，绕过这一处。**这一步因此是收尾断言的一部分**。
cleanup() {
  for d in "$SW" "$RW" "$NW" "$BW" "$LW" "$PW"; do
    [ -n "$d" ] || continue
    for a in $(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads/agent 2> /dev/null); do
      $FUGUE --root "$d" --agent "$a" dispose > /dev/null 2>&1
    done
  done
  if [ "${KEEP:-0}" = "1" ]; then
    printf '（KEEP=1，现场留着：靶子 %s · %s · %s · %s · %s · %s · 读数 %s · 落盘 %s）\n' "$SW" "$RW" "$NW" "$BW" "$LW" "$PW" "$T" "$OUT"
  else
    rm -rf "$SW" "$RW" "$NW" "$BW" "$T" "$OUT"
    [ -z "$LW" ] || rm -rf "$LW"
    [ -z "$PW" ] || rm -rf "$PW"
  fi
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
# 两边的空白都削掉再比：命令替换会把结尾的换行带进来，那是 shell 的事，不是读数的事。
check() {
  a=$(printf %s "$2" | tr -d ' \n')
  b=$(printf %s "$3" | tr -d ' \n')
  if [ "$a" = "$b" ]; then ok "$1：$b"; else bad "$1：期望 $a，实得 $b"; fi
}
has() { if grep -q "$2" "$1"; then ok "$3"; else bad "$3"; fi }
# 读数表：node 那几段把检查写成 `<ok|bad>\t<名字>\t<说明>`，这里逐行发落。**每一行恰好计一次数**，
# 所以收尾那行 PASS/FAIL 与上面印出来的行数永远对得上。
readings() {
  R="$1"
  while IFS= read -r line; do
    v=$(printf %s "$line" | cut -f1)
    n=$(printf %s "$line" | cut -f2)
    d=$(printf %s "$line" | cut -f3-)
    if [ "$v" = "ok" ]; then ok "$n"; else bad "$n（$d）"; fi
  done < "$R"
  rm -f "$R"
}
# **逐字节对账那把尺子**：`fugue commit` 不动 index（它自己造树、造提交），所以 `git status` ·
# `git diff` 在这个仓库里恒为空——它们比的是空 index，是**瞎绿**。要比就比树：把工作树临时灌进
# 一个另开的 index、`write-tree`，再与那个提交的树比 id。`.fugue/` 那条保留前缀写进
# `$GIT_DIR/info/exclude` 里排除（工作区的状态目录不是产品内容）。
tree_now() { rm -f "$T/tree-index"; GIT_INDEX_FILE="$T/tree-index" git -C "$1" add -A > /dev/null 2>&1; GIT_INDEX_FILE="$T/tree-index" git -C "$1" write-tree 2> /dev/null; }
# 三条 agent 分支要在轮次之前是**空的**：`round run` 拒绝复用一条指过东西的分支。装配那一段留
# 下的分支（它要读那一格的处境）因此在跑轮次之前收掉。
drop_agents() {
  d=$1
  for a in $(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads/agent 2> /dev/null); do
    $FUGUE --root "$d" --agent "$a" dispose > /dev/null 2>&1
    git -C "$d" update-ref -d "refs/heads/$a" > /dev/null 2>&1
  done
  return 0
}
# 回放那一档的靶子：**照夹具那份 `scenario.json` 搭**（`base` 铺开 + 一个提交 + 那三条配置）。
# 别的键一条都不设：`系统状态` 那一段照 `EXPOSED` 投影，多设一条 A 区的字节就变了，而 A 区一变
# 回放当场拒——夹具绑的就是录制那一版的字节（这正是它该有的牙）。
mkfixture() {
  _r=$1
  mkdir -p "$_r/.git/info"
  printf '.fugue/\n' > "$_r/.git/info/exclude"
  node -e '
const fs = require("fs"), path = require("path")
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
for (const f of s.base) {
  const p = path.join(process.argv[2], f.path)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, f.text)
}
' "$FIX/scenario.json" "$_r" || bad "回放靶子：base 铺开"
  ( cd "$_r" && git init -q . && git symbolic-ref HEAD refs/heads/main &&
    git config user.email fugue@localhost && git config user.name fugue &&
    git add -A && git commit -qm 底 ) || bad "回放靶子：底提交"
  A=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).assertions))' "$FIX/scenario.json")
  S=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).split))' "$FIX/scenario.json")
  $FUGUE --root "$_r" config set round.id r1 > /dev/null || bad "回放靶子：round.id"
  $FUGUE --root "$_r" config set round.assertions "$A" > /dev/null || bad "回放靶子：round.assertions"
  $FUGUE --root "$_r" config set round.split "$S" > /dev/null || bad "回放靶子：round.split"
}
GOAL=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).goal)' "$FIX/scenario.json")
WIRE_CALLS=$(node -e 'process.stdout.write(require("fs").readdirSync(process.argv[1]).sort().join(" "))' "$FIX/wire")

echo "=== 一 · 建两份靶子：一个提交 · 两条真断言 · 一份拆分草案 ==="
mkdir -p "$SW/.git/info" "$SW/src"
printf '.fugue/\n' > "$SW/.git/info/exclude"
printf '# 项目方针（S8 走查用）\n\n- 交付物写在仓库根上；要核自己刚写的东西就直接 `cat` 它。\n- 不要列目录、不要看时间戳、不要 `pwd`。\n' > "$SW/AGENTS.md"
printf 'export const a = 1\n' > "$SW/src/a.ts"
# **起点用 git 落**（不是 `fugue commit`）：轮次钉的底是真实工作树的 HEAD，主线要的是一条真历史。
( cd "$SW" && git init -q . && git symbolic-ref HEAD refs/heads/main &&
  git config user.email fugue@localhost && git config user.name fugue &&
  git add -A && git commit -qm '起点' ) || bad "打桩靶子的起点提交"
SBASE=$(git -C "$SW" rev-parse refs/heads/main)
# 两条**真断言**：它们在合并之后那棵树上跑真进程（`test -f` · `test -s`），不是打桩的。
$FUGUE --root "$SW" config set round.id r1 > /dev/null || bad "打桩靶子：round.id"
$FUGUE --root "$SW" config set round.assertions \
  '[{"name":"notes.md 在","argv":["/bin/sh","-c","test -f notes.md"]},
    {"name":"notes.md 非空","argv":["/bin/sh","-c","test -s notes.md"]}]' > /dev/null || bad "打桩靶子：round.assertions"
$FUGUE --root "$SW" config set round.split \
  '[{"goal":"写一份 notes.md","ownedPaths":["notes.md"],
     "deliverables":[{"path":"notes.md","form":"一份文件"}],
     "assertions":[{"action":"ok","name":"notes.md 在"}]}]' > /dev/null || bad "打桩靶子：round.split"
mkfixture "$RW"
mkfixture "$NW"
mkfixture "$BW"
printf '  打桩靶子 %s（底 %s）· 回放靶子 %s · 用完就停 %s · 负对照 %s\n' "$SW" "$SBASE" "$RW" "$NW" "$BW"
printf '  目标（回放那一档照录的那一趟）：%s\n' "$GOAL"

echo
echo "=== 二 · 装配走通：三区各印得出 · 两个 agent 的 A 区全等 · 分叉落在 A 之后 ==="
for n in 1 2; do
  $FUGUE --root "$SW" --agent "agent/r1/$n" branch main > /dev/null 2>&1 || bad "装配那一段：branch agent/r1/$n"
done
for n in 1 2; do
  $FUGUE --root "$SW" --json assemble subagent --agent "agent/r1/$n" > "$T/as-$n.json" 2> "$T/as-$n.err" \
    || bad "assemble --agent agent/r1/$n：$(head -1 "$T/as-$n.err")"
done
$FUGUE --root "$SW" --json assemble subagent --agent agent/r1/1 --against holder > "$T/ab.json" 2> "$T/ab.err" \
  || bad "assemble --against holder：$(head -1 "$T/ab.err")"
node -e '
const fs = require("fs")
const T = process.argv[1]
const a = JSON.parse(fs.readFileSync(T + "/as-1.json", "utf8"))
const b = JSON.parse(fs.readFileSync(T + "/as-2.json", "utf8"))
const ab = JSON.parse(fs.readFileSync(T + "/ab.json", "utf8"))
for (const z of ["A", "B", "C"]) console.log("  " + z + " 区 " + a.zones[z].bytes + " 字节 · " + a.zones[z].hash)
console.log("  agent-2 的 A 区 " + b.zones.A.hash + " · B 区 " + b.zones.B.hash)
console.log("  与持轮者第一处不同：第 " + ab.firstDivergence.at + " 个字节（" + ab.firstDivergence.note + "）")
const hex = (h) => /^[0-9a-f]{16}$/.test(h)
const rows = [
  [["A", "B", "C"].every((z) => a.zones[z].bytes > 0 && hex(a.zones[z].hash)), "三区各印得出（字节 > 0 · 指纹 16 位）", ["A", "B", "C"].map((z) => z + "=" + a.zones[z].bytes + "B/" + a.zones[z].hash).join(" ")],
  [a.zones.A.hash === b.zones.A.hash && a.zones.A.bytes === b.zones.A.bytes, "两个 agent 的 A 区全等（共享头不取决于读它的那一格）", a.zones.A.hash],
  [Number.isInteger(ab.firstDivergence.at) && ab.firstDivergence.at >= a.zones.A.bytes, "第一处不同落在 A 区之后（两份声明的差别在 B 区那一侧）", "第 " + ab.firstDivergence.at + " 字节 ≥ A 区 " + a.zones.A.bytes + " 字节"],
  [a.violations.length === 0 && b.violations.length === 0, "四条约束一处都不报（干净的输入）", "violations " + a.violations.length + "/" + b.violations.length]
]
fs.writeFileSync(T + "/r2.tsv", rows.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
process.exit(rows.every((r) => r[0]) ? 0 : 1)
' "$T" || bad "装配那一段的读数：node 那一段自己挂了"
readings "$T/r2.tsv"
drop_agents "$SW"

echo
echo "=== 三 · 打桩那一档：一条命令跑完一个轮次（验收照过 · 推进真发生 · 指标照算）==="
$FUGUE --root "$SW" round run '写一份 notes.md' --report --metrics --json > "$T/stub.json" 2> "$T/stub.err"
RC3=$?
printf '  rc = %s\n' "$RC3"
sed 's/^/  err| /' "$T/stub.err"
check "打桩那一趟的退出码" "0" "$RC3"
if [ "$(tree_now "$SW")" = "$(git -C "$SW" rev-parse 'refs/heads/main^{tree}')" ]; then
  ok "推进之后真实工作树与那个提交逐字节一致（保留前缀之外）"
else
  bad "推进之后真实工作树与那个提交的树不一致"
fi
$FUGUE --root "$SW" --json log > "$T/log-stub.json" 2> /dev/null
node -e '
const fs = require("fs")
const T = process.argv[1], SW = process.argv[2]
const j = JSON.parse(fs.readFileSync(T + "/stub.json", "utf8"))
const rows = fs.readFileSync(T + "/log-stub.json", "utf8").trim().split("\n").map((l) => JSON.parse(l).e)
const num = (id) => j.metrics.find((m) => m.metric === id)
const byReport = Object.fromEntries(j.report.map((r) => [r.metric, r.count]))
// **手工按判据重数一遍**（每一段都写在这一段自己里，与 `src/probe/metrics.ts` 那一份无关）。
const byHand = {
  conflicts: rows.filter((e) => e.t === "merge/attempt").reduce((n, e) => n + e.conflicts, 0),
  rejects: rows.filter((e) => e.t === "round/state" && e.from === "Verifying" && e.to === "Working").length,
  denied: rows.filter((e) => e.t === "run/end" && e.denied).length
}
const zon = rows.filter((e) => e.t === "prefix/assemble")
let versions = 0
let prev = null
for (const e of zon) {
  const now = e.zoneAHash + "/" + e.zoneBHash
  if (now !== prev) versions += 1
  prev = now
}
console.log("  验收：" + JSON.stringify(j.verify) + " · 推进：" + JSON.stringify(j.advanced))
console.log("  三个数（--report）：" + JSON.stringify(byReport) + " · 手工重数：" + JSON.stringify(byHand))
console.log("  八元指标：" + j.metrics.map((m) => m.metric + "=" + (m.numerator === null ? "没有读数" : m.numerator + "/" + m.denominator)).join(" · "))
console.log("  prefix-versions 手工重数：" + versions + "（--metrics 给的是 " + JSON.stringify(num("prefix-versions").value) + "）")
const flat = (id) => num(id).value === null && num(id).numerator === null
const rows2 = [
  [j.verify.ok === true && j.verify.pass === 2 && j.verify.fail === 0 && j.verify.unrunnable === 0, "两条真断言在合并之后那棵树上跑过（2/0/0）", JSON.stringify(j.verify)],
  [j.advanced !== null && j.advanced.written.includes("notes.md"), "推进真的发生了（写 notes.md）", JSON.stringify(j.advanced === null ? null : j.advanced.written)],
  [byReport.conflicts === 0 && byReport.rejects === 0 && byReport.denied === 0, "三个数全 0（打桩那一趟谁都不撞）", JSON.stringify(byReport)],
  [byHand.conflicts === byReport.conflicts && byHand.rejects === byReport.rejects && byHand.denied === byReport.denied, "三个数与手工重数逐个相等（重算，不是采集）", JSON.stringify(byHand)],
  [j.metrics.length === 8, "八元指标一条不少", j.metrics.length + " 条"],
  [flat("zero-tool-call-rate") && flat("detour-rate") && flat("prefix-hit-rate") && flat("handoff-yield"), "打桩那一档没有 llm/call 的那三个指标如实报「没有读数」（不是 0）", "zero-tool-call-rate · detour-rate · prefix-hit-rate · handoff-yield 都是 null"],
  [num("prefix-versions").value === versions && versions === 0 && zon.length === 0, "prefix-versions 与手工重数一致：0（打桩那一档一步都没进 runtime，一条 prefix/assemble 都没有）", String(versions) + " 版 / " + zon.length + " 条装配事件"],
  [Number.isInteger(num("git-calls-per-round").value) && num("git-calls-per-round").value > 0, "git-calls-per-round 取得出（这一趟碰了几次对象库）", String(num("git-calls-per-round").value)],
  [fs.existsSync(SW + "/notes.md"), "产物落在真实工作树上", "notes.md " + fs.statSync(SW + "/notes.md").size + " 字节"]
]
fs.writeFileSync(T + "/r3.tsv", rows2.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
process.exit(rows2.every((r) => r[0]) ? 0 : 1)
' "$T" "$SW" || bad "打桩那一趟的读数：node 那一段自己挂了"
readings "$T/r3.tsv"

echo
echo "=== 四 · 回放那一档（--wire-in）：三份真响应喂回去（不出网 · 不读凭据）==="
# **凭据那一栏故意指一个不存在的文件**：回放那一档照 `src/cli/fugue.ts` 的口径根本不走 `authWith`
# （`wireIn !== undefined` 时凭据只是一个占位字符串），所以它必须照过——**这一条就是"不读凭据"
# 的观测面**（真去读的话，这里当场退 1）。
env -u DEEPSEEK_API_KEY $FUGUE --root "$RW" round run "$GOAL" \
  --wire-in "$FIX/wire" --max-steps 4 --credential /tmp/不存在的凭据.key \
  --report --metrics --json --dump-wire "$OUT/wire" > "$T/rep.json" 2> "$T/rep.err"
RC4=$?
printf '  rc = %s\n' "$RC4"
sed 's/^/  err| /' "$T/rep.err"
check "回放那一趟的退出码" "0" "$RC4"
if [ "$(tree_now "$RW")" = "$(git -C "$RW" rev-parse 'refs/heads/main^{tree}')" ]; then
  ok "回放那一趟推进之后工作树与那个提交逐字节一致（保留前缀之外）"
else
  bad "回放那一趟推进之后工作树与那个提交不一致"
fi
# 两条真断言在**这一趟盘上那棵树**上真跑一次（验收是唯一的判据，而这里不借 `--report` 的话）。
( cd "$RW" && /bin/sh -c 'test -f notes.md' ); check "真断言①（test -f notes.md）的退出码" "0" "$?"
( cd "$RW" && /bin/sh -c 'grep -q 数完了 notes.md' ); check "真断言②（grep -q 数完了 notes.md）的退出码" "0" "$?"
$FUGUE --root "$RW" --json log > "$T/log-rep.json" 2> /dev/null
node -e '
const fs = require("fs")
const T = process.argv[1], RW = process.argv[2], FIX = process.argv[3], OUT = process.argv[4]
const j = JSON.parse(fs.readFileSync(T + "/rep.json", "utf8"))
const s = JSON.parse(fs.readFileSync(FIX + "/scenario.json", "utf8"))
const rows = fs.readFileSync(T + "/log-rep.json", "utf8").trim().split("\n").map((l) => JSON.parse(l).e)
const calls = rows.filter((e) => e.t === "llm/call")
const zon = rows.filter((e) => e.t === "prefix/assemble")
const kept = fs.readdirSync(FIX + "/wire").sort()
const got = fs.readdirSync(OUT).sort()
const one = j.agents[0]
console.log("  停因：「" + (one === undefined ? "（没落）" : one.stopped) + "」· 走了 " + (one === undefined ? "?" : one.steps) + " 步")
console.log("  验收 " + j.verify.pass + "/" + j.verify.fail + " · 推进 " + JSON.stringify(j.advanced === null ? null : j.advanced.written))
console.log("  归因三处对照（闸四：命中落在哪一段）：")
for (const a of j.attribution) console.log("    " + a.where + " · 命中 " + (a.cacheReadTokens === null ? "没有读数" : a.cacheReadTokens) + " / 输入 " + (a.inputTokens === null ? "没有读数" : a.inputTokens))
console.log("  usage 逐条（input · cacheRead · cacheWrite · output）：")
let sum = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
let writeNull = 0
for (const [i, c] of calls.entries()) {
  const u = c.usage
  for (const k of Object.keys(sum)) { if (u[k] !== null) sum[k] += u[k]; else if (k === "cacheWriteTokens") writeNull += 1 }
  console.log("    " + (i + 1) + " · " + [u.inputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.outputTokens].map((v) => (v === null ? "没有读数" : v)).join(" · "))
}
console.log("    合计 · " + [sum.inputTokens, sum.cacheReadTokens, (writeNull > 0 ? "没有读数（" + writeNull + " 条）" : sum.cacheWriteTokens), sum.outputTokens].join(" · "))
// **逐条对账**：这一趟发出去的请求与录下来的那一份逐字节相同，喂回去的响应也是。
const perCall = kept.map((c, i) => {
  const mine = JSON.parse(fs.readFileSync(OUT + "/" + c + "/meta.json", "utf8"))
  const was = JSON.parse(fs.readFileSync(FIX + "/wire/" + c + "/meta.json", "utf8"))
  const z = zon[i] ?? {}
  const sameReq = mine.requestHash === was.requestHash
  const sameRes = mine.responseHash === was.responseHash
  const sameStop = mine.stop === was.stop
  // **"装配出来的是什么"与"发出去的是什么"对一次**（`--dump-wire` 的 README 第 2 步）。
  const sameZone = mine.zoneAHash === z.zoneAHash && mine.zoneBHash === z.zoneBHash && mine.zoneCHash === z.zoneCHash
  console.log("  " + c + "：请求 " + mine.requestHash + (sameReq ? "（与录的那一份相同）" : "（不同！）") +
    " · 响应 " + mine.responseHash + (sameRes ? "（相同）" : "（不同！）") +
    " · 停 " + mine.stop + " · 三区与日志对得上：" + sameZone)
  return sameReq && sameRes && sameStop && sameZone
})
// **指标重算与手工对账**（这一段自己重数一遍）。
const m = Object.fromEntries(j.metrics.map((x) => [x.metric, x]))
const hand = {
  "zero-tool-call-rate": [calls.filter((c) => c.invocations === 0).length, calls.length],
  "prefix-hit-rate": [calls.filter((c) => (c.usage.cacheReadTokens ?? 0) > 0).length, calls.length]
}
const sameMetric = Object.entries(hand).every(([k, [n, d]]) => m[k].numerator === n && m[k].denominator === d && n > 0)
const rows2 = [
  [j.verify.ok === true && j.verify.pass === s.assertions.length && j.verify.fail === 0, "验收照过（" + s.assertions.length + " 条断言）", JSON.stringify(j.verify)],
  [j.advanced !== null && j.advanced.written.includes("notes.md"), "推进真的发生了", JSON.stringify(j.advanced === null ? null : j.advanced.written)],
  [one !== undefined && one.stopped === "收敛" && one.steps === 3, "停因「收敛」（录的那一趟 3 步就交卷）——不是「步数到顶」", one === undefined ? "（没落）" : one.stopped + " · " + one.steps + " 步"],
  [fs.readFileSync(RW + "/notes.md", "utf8") === s.expected["notes.md"], "产物与录下来的那一趟逐字节相同", JSON.stringify(s.expected["notes.md"])],
  [JSON.stringify(got) === JSON.stringify(kept), "重录的份数与夹具相同（" + kept.length + " 份）", got.join(" ")],
  [perCall.every(Boolean), "三份调用逐条：请求 · 响应 · 停因 · 三区对得上", perCall.map((x) => (x ? "ok" : "bad")).join(" ")],
  [calls.length === kept.length && calls.every((c) => c.usage.inputTokens !== null && c.usage.outputTokens !== null), "每一条调用都留着用量（input 与 output 不是「没有读数」）", calls.length + " 条"],
  [sameMetric, "指标重算与手工对账：一线三个指标的分子分母逐个相等", "zero-tool-call-rate " + hand["zero-tool-call-rate"].join("/") + " · prefix-hit-rate " + hand["prefix-hit-rate"].join("/")],
  [Array.isArray(j.attribution) && j.attribution.length === 3 && j.attribution[0].cacheReadTokens !== null, "归因三处对照三行都在（冷那一处有读数：上游真报了这个数）", j.attribution.map((a) => a.where + " 命中 " + (a.cacheReadTokens === null ? "没有读数" : a.cacheReadTokens)).join(" · ")],
  [m["prefix-versions"].value === 1 && m["materialize-precision"].numerator > 0, "前缀只装配了一版（三区指纹跨三步不变）· 物化的分子不是 0（真驱动那一档按需铺了树）", "prefix-versions " + m["prefix-versions"].value + " · materialize-precision " + m["materialize-precision"].numerator + "/" + m["materialize-precision"].denominator + "（分母 0 → 值如实报 null）"]
]
fs.writeFileSync(T + "/r4.tsv", rows2.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
fs.writeFileSync(T + "/rep-readings.json", JSON.stringify({ calls: calls.length, one, verify: j.verify, advanced: j.advanced, metrics: j.metrics, zon: zon.length, usage: sum, writeNull, cacheWrite: calls.map((c) => c.usage.cacheWriteTokens), invocations: calls.map((c) => c.invocations), attribution: j.attribution }, null, 2) + "\n")
process.exit(rows2.every((r) => r[0]) ? 0 : 1)
' "$T" "$RW" "$FIX" "$OUT/wire" || bad "回放那一趟的读数：node 那一段自己挂了"
readings "$T/r4.tsv"

echo
echo "=== 五 · 回放档的负对照：夹具里第一份 request.json 改一个字节 → 当场拒 ==="
cp -r "$FIX/wire" "$T/badwire"
node -e '
const fs = require("fs")
const p = process.argv[1] + "/call-0001/request.json"
const b = fs.readFileSync(p)
b[0] = b[0] === 0x7b ? 0x5b : 0x7b
fs.writeFileSync(p, b)
' "$T/badwire" || bad "负对照：改一个字节"
env -u DEEPSEEK_API_KEY $FUGUE --root "$BW" round run "$GOAL" \
  --wire-in "$T/badwire" --max-steps 4 --json --dump-wire "$OUT/bad" > "$T/bad.json" 2> "$T/bad.err"
RC5=$?
printf '  rc = %s\n' "$RC5"
node -e '
const fs = require("fs")
const T = process.argv[1], BW = process.argv[2], D = process.argv[3]
const j = JSON.parse(fs.readFileSync(T + "/bad.json", "utf8"))
const one = j.agents[0]
const got = fs.existsSync(D) ? fs.readdirSync(D).sort() : []
const meta = got.length > 0 ? JSON.parse(fs.readFileSync(D + "/" + got[0] + "/meta.json", "utf8")) : {}
console.log("  停因：「" + (one === undefined ? "（没落）" : one.stopped) + "」· 走了 " + (one === undefined ? "?" : one.steps) + " 步")
console.log("  落下来的那一份：" + got.join(" ") + " · outcome=" + String(meta.outcome) + " · failure=" + String(meta.failure))
const rows2 = [
  [/回放档：.*被改过/.test(one === undefined ? "" : one.stopped), "当场拒：停因里那句话说得出「这一份取证物被改过」", one === undefined ? "（没落）" : one.stopped],
  [one !== undefined && one.steps === 1, "拒在第 1 次调用上（这一格只走了 1 步）", one === undefined ? "?" : String(one.steps)],
  [got.length === 1 && got[0] === "call-0001", "后面那两份夹具一次都没被读（失败那一路也照落）", got.join(" ")],
  [meta.outcome === "failed", "落下来的那一份是 failed 档", String(meta.outcome)],
  [!fs.existsSync(BW + "/notes.md"), "被拒了盘上就没有产物", "notes.md " + (fs.existsSync(BW + "/notes.md") ? "在（不该在）" : "不在")],
  [j.verify.ok === false && j.verify.pass === 0, "验收是唯一的判据：被拒 → 验收 0", JSON.stringify(j.verify)]
]
fs.writeFileSync(T + "/r5.tsv", rows2.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
process.exit(rows2.every((r) => r[0]) ? 0 : 1)
' "$T" "$BW" "$OUT/bad" || bad "负对照的读数：node 那一段自己挂了"
readings "$T/r5.tsv"
check "被拒的那一趟退出码不是 0" "1" "$RC5"

echo
echo "=== 六 · 地板两档（B13）：真模型 → 夹具回放 · 接续 → 用完就停 ==="
# ① 真模型 → 夹具回放：**第四段那一趟就是它**（整条链走完 · 断言照过 · 指标照算）。
#    如实报的是这一条：回放档的命中读数是**录下来的那一趟的真读数**（2/3），不是平凡值——
#    地板这一档把"模型那一侧"换掉，不把指标换成假数。
node -e '
const fs = require("fs")
const T = process.argv[1]
const r = JSON.parse(fs.readFileSync(T + "/rep-readings.json", "utf8"))
const hit = r.metrics.find((m) => m.metric === "prefix-hit-rate")
const rows = [
  [r.verify.ok === true && r.one.stopped === "收敛", "地板①：真模型 → 夹具回放，整条链照旧走完（停在「收敛」）", r.one.stopped + " · 验收 " + r.verify.pass + "/" + r.verify.fail],
  [hit.numerator === 2 && hit.denominator === 3, "地板①：命中读数是真读数（2/3），不是平凡值", "prefix-hit-rate " + hit.numerator + "/" + hit.denominator],
  [r.calls === 3 && r.usage.inputTokens > 0, "地板①：三份调用的用量逐条都在（合计 input " + r.usage.inputTokens + " · output " + r.usage.outputTokens + "）", "cacheWrite 那 " + r.writeNull + " 条如实报「没有读数」"]
]
fs.writeFileSync(T + "/r6a.tsv", rows.map((x) => (x[0] ? "ok" : "bad") + "\t" + x[1] + "\t" + x[2]).join("\n") + "\n")
process.exit(rows.every((x) => x[0]) ? 0 : 1)
' "$T" || bad "地板①那一档的读数：node 那一段自己挂了"
readings "$T/r6a.tsv"
# ② 接续 → 用完就停（`--no-handoff`）：那一档轮次照收，而**请求字节一个都没变**——
#    这一条量的正是"关掉交接不改前缀"，而"为什么停"那句话要**到了预算触发点**才说得出：
#    夹具这一档的 8KB 前缀离触发点还远（那句话在 `src/round/driver.test.ts` ③ 的 tiny 声明上量得到，
#    真档那一趟归序 4）。**这一半如实报「没有读数」，不拿"照收"顶替。**
env -u DEEPSEEK_API_KEY $FUGUE --root "$NW" round run "$GOAL" \
  --wire-in "$FIX/wire" --max-steps 4 --no-handoff --json --dump-wire "$OUT/nohand" > "$T/nohand.json" 2> "$T/nohand.err"
RC6=$?
printf '  rc = %s\n' "$RC6"
sed 's/^/  err| /' "$T/nohand.err"
check "地板②那一趟的退出码（照收）" "0" "$RC6"
node -e '
const fs = require("fs")
const T = process.argv[1], FIX = process.argv[2], D = process.argv[3]
const j = JSON.parse(fs.readFileSync(T + "/nohand.json", "utf8"))
const kept = fs.readdirSync(FIX + "/wire").sort()
const got = fs.readdirSync(D).sort()
const same = got.length === kept.length && kept.every((c) => {
  const a = JSON.parse(fs.readFileSync(FIX + "/wire/" + c + "/meta.json", "utf8"))
  const b = JSON.parse(fs.readFileSync(D + "/" + c + "/meta.json", "utf8"))
  return a.requestHash === b.requestHash && a.responseHash === b.responseHash
})
const one = j.agents[0]
console.log("  停因：「" + (one === undefined ? "（没落）" : one.stopped) + "」· 步数 " + (one === undefined ? "?" : one.steps) + " · 指回夹具的字节：" + same)
console.log("  用完就停那一句「为什么停」：没有读数（这一趟没到预算触发点——它归 driver.test.ts ③ 的 tiny 声明与真档那一趟）")
const rows = [
  [j.verify.ok === true && one !== undefined && one.stopped === "收敛", "地板②：关掉交接之后轮次照收（不是静默截断）", one === undefined ? "（没落）" : one.stopped],
  [same, "地板②：`--no-handoff` 不动前缀字节（三份请求逐条指回夹具）", got.join(" ")]
]
fs.writeFileSync(T + "/r6b.tsv", rows.map((x) => (x[0] ? "ok" : "bad") + "\t" + x[1] + "\t" + x[2]).join("\n") + "\n")
process.exit(rows.every((x) => x[0]) ? 0 : 1)
' "$T" "$FIX" "$OUT/nohand" || bad "地板②那一档的读数：node 那一段自己挂了"
readings "$T/r6b.tsv"

echo
echo "=== 七 · 收尾：不留挂载 · 不留进程 · 不留孤儿分支 ==="
for pair in "打桩:$SW" "回放:$RW" "用完就停:$NW" "负对照:$BW"; do
  lbl=${pair%%:*}
  d=${pair#*:}
  check "$lbl：轮次留下的是它自己那一条 agent 分支" "1" \
    "$(git -C "$d" for-each-ref --format='%(refname)' refs/heads/agent 2> /dev/null | wc -l)"
  drop_agents "$d"
  check "$lbl：收尾之后只剩 main 一条分支（没有孤儿）" "1" \
    "$(git -C "$d" for-each-ref --format='%(refname)' refs/heads 2> /dev/null | wc -l)"
  check "$lbl：物化根里一个文件都不剩" "0" \
    "$(find "$d/.fugue/mat" -type f 2> /dev/null | wc -l)"
  check "$lbl：挂载表里没有它" "0" "$(grep -c "$d" /proc/self/mountinfo 2> /dev/null || true)"
done
check "没有残留的 fugue 进程" "0" "$(ps -eo args 2>/dev/null | grep -c '[f]ugue-s8-' || true)"
check "没有残留的 bwrap（沙箱这一层）" "0" "$(ps -eo args 2>/dev/null | grep -c '[b]wrap.*fugue-s8-' || true)"

echo
echo "=== 八 · 判据卡骨架（§ 5.9.3 · 量不到的写「没有读数」，不许留空）==="
TREEOK=不一致
if [ "$(tree_now "$RW")" = "$(git -C "$RW" rev-parse 'refs/heads/main^{tree}')" ]; then TREEOK=一致; fi
node -e '
const fs = require("fs")
const T = process.argv[1], treeOk = process.argv[2]
const r = JSON.parse(fs.readFileSync(T + "/rep-readings.json", "utf8"))
const m = Object.fromEntries(r.metrics.map((x) => [x.metric, x]))
const one = r.one === undefined ? "（没落）" : r.one.stopped
const card = [
  ["停因（三档哪一档）· 步数 / 上界", one + "（录的那一趟）· " + (r.one === undefined ? "?" : r.one.steps) + " 步 / 上界 4"],
  ["真断言那条命令与它的退出码", "/bin/sh -c test -f notes.md → 0 · /bin/sh -c grep -q 数完了 notes.md → 0"],
  ["工作树 vs 定格那个提交：一致 / 差几条", treeOk + "（差 0 条）"],
  ["三个一线指标（分子分母随数一起印）", ["zero-tool-call-rate", "detour-rate", "prefix-hit-rate"].map((k) => k + " " + m[k].numerator + "/" + m[k].denominator).join(" · ")],
  ["归因三处对照：冷 · 共享头 · 第 k 步", r.attribution.map((a) => a.where + " 命中 " + (a.cacheReadTokens === null ? "没有读数" : a.cacheReadTokens)).join(" · ")],
  ["断点与缓存写入两栏（隐式档）", "未声明（隐式缓存）· cacheWriteTokens " + (r.cacheWrite.every((v) => v === null) ? "没有读数（三条都没报）" : JSON.stringify(r.cacheWrite) + "（提供方给的就是这个数，不是「没有读数」）")],
  ["每趟 usage 四个数 · 合计", "3 趟 · 合计 input " + r.usage.inputTokens + " · cacheRead " + r.usage.cacheReadTokens + " · cacheWrite " + (r.cacheWrite.every((v) => v === null) ? "没有读数" : r.cacheWrite.join("/")) + " · output " + r.usage.outputTokens],
  ["前缀 token 数（三区分别）· 调用次数", "token 数：没有读数（那一步要区内容，归 tools/probe-prefix.ts）· 三区指纹在 dump 的 meta 里 · 调用 " + r.calls + " 次"],
  ["推进（写 / 删 / 跳过）", JSON.stringify(r.advanced === null ? null : { 写: r.advanced.written, 删: r.advanced.removed })]
]
for (const [k, v] of card) console.log("  " + k.padEnd(34, " ") + "｜ " + v)
fs.writeFileSync(T + "/card.tsv", card.map((r2) => "ok\t判据卡：" + r2[0] + "\t" + r2[1]).join("\n") + "\n")
const empty = card.filter((r2) => String(r2[1]).trim() === "")
process.exit(empty.length === 0 ? 0 : 1)
' "$T" "$TREEOK" || bad "判据卡：有留空的格子"
readings "$T/card.tsv"

echo
echo "=== 九 · 用法说明与事实相符（S8 的可用性那一面）==="
# 两条**写在那儿的话与事实不符**（PLAN § 5.12 卫生那一组）：`--live` 已可用，而用法说明仍说
# "模型这一侧今天是打桩的"；`round` 的子命令已经有四个（`new` · `plan` · `go` · `run`），而指路句
# 只报 `new`。它们不是口味问题：一句错的指路会让用户敲了 `round plan` 之后被告知"只有 new"。
# **指路句跟着命令面走**：`round go` 落地时这一行已经跟着改了（C4）。
$FUGUE --help > "$T/usage.txt" 2>&1
if grep -q '模型这一侧今天是打桩的' "$T/usage.txt"; then
  bad "用法说明不再说「模型这一侧今天是打桩的」"
else
  ok "用法说明不再说「模型这一侧今天是打桩的」（缺省打桩那一档 · --live 已可用）"
fi
if grep -q -- '--live' "$T/usage.txt"; then
  ok "用法说明里点得出 --live（真档那一档）"
else
  bad "用法说明里点不出 --live——用户看不到真档怎么开"
fi
$FUGUE round 敲错 > "$T/wrong.out" 2> "$T/wrong.err"
RC9=$?
check "敲错子命令的退出码" "2" "$RC9"
if grep -q 'new · plan · go · run' "$T/wrong.err"; then
  ok "指路句把子命令都报得出来（new · plan · go · run）"
else
  bad "指路句没有报全：$(head -1 "$T/wrong.err")"
fi

if [ "$LIVE" = yes ]; then
  echo
  echo "=== 十 · 单格档 L3（真模型）：一个 agent 走完 · 冷与第 k 步两处有数 · 录下来的字节喂得回回放档 ==="
  # **凭据只从那一份文件取，值从不打印**（与 `tools/live-round.sh` 同一条口径）。
  KEY=""
  if [ -f /home/ubuntu/.fugue/credentials/deepseek.key ]; then KEY=$(cat /home/ubuntu/.fugue/credentials/deepseek.key); fi
  if [ -z "$KEY" ]; then
    bad "L3 没跑：凭据不在（这一条要人把真档那一步做了才算数——不许看起来像通过）"
  else
    mkfixture "$LW"
    # **开局就把 `--max-steps` 压到个位数**（§ 5.9.2 的纪律：第一次联网不许放开步数）。
    DEEPSEEK_API_KEY="$KEY" $FUGUE --root "$LW" round run "$GOAL" \
      --live --max-steps 4 --report --metrics --json --dump-wire "$OUT/live" > "$T/live.json" 2> "$T/live.err"
    RC10=$?
    printf '  rc = %s（真档那一趟 · 花的钱在这一趟的命令与 usage 里）\n' "$RC10"
    sed 's/^/  err| /' "$T/live.err" | head -8
    node -e '
const fs = require("fs")
const T = process.argv[1], LW = process.argv[2], D = process.argv[3]
const j = JSON.parse(fs.readFileSync(T + "/live.json", "utf8"))
const one = j.agents[0] ?? { steps: 0, stopped: "（没落）" }
const v = j.verify
const three = j.attribution ?? []
const hit = j.metrics.find((m) => m.metric === "prefix-hit-rate")
const calls = fs.existsSync(D) ? fs.readdirSync(D).sort() : []
console.log("  停因：「" + one.stopped + "」· " + one.steps + " 步 · 验收 " + v.pass + "/" + v.fail + " · 推进 " + JSON.stringify(j.advanced === null ? null : j.advanced.written))
console.log("  取证物 " + calls.length + " 份：" + calls.join(" "))
for (const a of three) console.log("    " + a.where + " · 命中 " + (a.cacheReadTokens === null ? "没有读数" : a.cacheReadTokens) + " / 输入 " + (a.inputTokens === null ? "没有读数" : a.inputTokens))
const rows = [
  [v.ok === true && v.fail === 0 && j.advanced !== null, "L3：一个 agent 走完（验收照过 · 真的推进了）", JSON.stringify(v) + " · " + JSON.stringify(j.advanced === null ? null : j.advanced.written)],
  [three.length === 3 && three[0].cacheReadTokens !== null && three[2].cacheReadTokens !== null, "L3：归因那三处里冷与第 k 步两处有数（共享头要两格——这一趟是一格）", three.map((a) => (a.cacheReadTokens === null ? "没有读数" : String(a.cacheReadTokens))).join(" · ")],
  [calls.length > 0 && hit.denominator !== null && hit.denominator > 0, "L3：取证物落下来了 · 一线指标有真读数（分母不是 0）", calls.length + " 份 · prefix-hit-rate " + hit.numerator + "/" + hit.denominator],
  [fs.existsSync(LW + "/notes.md"), "L3：产物落在真实工作树上", "notes.md " + (fs.existsSync(LW + "/notes.md") ? fs.statSync(LW + "/notes.md").size + " 字节" : "不在")],
  [/收敛/.test(String(one.stopped)), "L3：停因是「收敛」（不是「步数到顶」——那一条是协议或提示的问题）", String(one.stopped)]
]
fs.writeFileSync(T + "/r10.tsv", rows.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
process.exit(rows.every((r) => r[0]) ? 0 : 1)
' "$T" "$LW" "$OUT/live" || bad "L3 的读数：node 那一段自己挂了"
    readings "$T/r10.tsv"
    # **录下来的字节喂得回回放档**：照同一份 `scenario.json` 另起一份靶子（A 区的字节因此逐字节相同），
    # 把刚才那一趟的取证物喂回去。这一条同时是地板①（真模型 → 夹具回放）在真档上的那一半。
    if [ -d "$OUT/live" ]; then
      mkfixture "$PW"
      env -u DEEPSEEK_API_KEY $FUGUE --root "$PW" round run "$GOAL" \
        --wire-in "$OUT/live" --max-steps 4 --json --dump-wire "$OUT/liveback" > "$T/liveback.json" 2> "$T/liveback.err"
      RC11=$?
      printf '  喂回去那一趟 rc = %s\n' "$RC11"
      sed 's/^/  err| /' "$T/liveback.err" | head -4
      check "L3：录下来的字节能喂回放档（那一趟照收）" "0" "$RC11"
      node -e '
const fs = require("fs")
const T = process.argv[1], LW = process.argv[2], PW = process.argv[3], LIVE = process.argv[4], BACK = process.argv[5]
const kept = fs.readdirSync(LIVE).sort()
const got = fs.existsSync(BACK) ? fs.readdirSync(BACK).sort() : []
const per = kept.map((c) => {
  const a = JSON.parse(fs.readFileSync(LIVE + "/" + c + "/meta.json", "utf8"))
  const b = JSON.parse(fs.readFileSync(BACK + "/" + c + "/meta.json", "utf8"))
  return a.requestHash === b.requestHash && a.responseHash === b.responseHash
})
const product = fs.existsSync(LW + "/notes.md") && fs.existsSync(PW + "/notes.md") && fs.readFileSync(LW + "/notes.md", "utf8") === fs.readFileSync(PW + "/notes.md", "utf8")
console.log("  逐条对上（" + kept.length + " 份）：" + per.map((x, i) => kept[i] + "=" + x).join(" · "))
console.log("  两边的产物逐字节相同：" + product)
const rows = [
  [got.length === kept.length && per.every(Boolean), "L3：那一趟发出去的请求与喂回去的响应逐条相同（" + kept.length + " 份）", per.map((x) => (x ? "ok" : "bad")).join(" ")],
  [product, "L3：回放出来的产物与真档那一趟逐字节相同", fs.existsSync(PW + "/notes.md") ? JSON.stringify(fs.readFileSync(PW + "/notes.md", "utf8")) : "（回放那一趟没有产物）"]
]
fs.writeFileSync(T + "/r11.tsv", rows.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
process.exit(rows.every((r) => r[0]) ? 0 : 1)
' "$T" "$LW" "$PW" "$OUT/live" "$OUT/liveback" || bad "L3 喂回去那一趟的读数：node 那一段自己挂了"
      readings "$T/r11.tsv"
    else
      bad "L3：这一趟一份取证物都没落下来（--dump-wire 那一层没接上），喂回去无从谈起"
    fi
    $FUGUE --root "$LW" --json log > "$T/log-live.json" 2> /dev/null
    TREELIVE=不一致
    if [ "$(tree_now "$LW")" = "$(git -C "$LW" rev-parse 'refs/heads/main^{tree}')" ]; then TREELIVE=一致; fi
    check "L3：推进之后工作树与那个提交逐字节一致（保留前缀之外）" "一致" "$TREELIVE"
    echo
    echo "=== 十一 · 真档那一趟的判据卡（§ 5.9.3 那九栏 · 量不到的写「没有读数」）==="
    node -e '
const fs = require("fs")
const T = process.argv[1], LW = process.argv[2], D = process.argv[3], treeOk = process.argv[4]
const j = JSON.parse(fs.readFileSync(T + "/live.json", "utf8"))
const events = fs.readFileSync(T + "/log-live.json", "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l).e)
const calls = events.filter((e) => e.t === "llm/call")
const sum = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
for (const c of calls) for (const k of Object.keys(sum)) if (c.usage[k] !== null) sum[k] += c.usage[k]
const cw = calls.map((c) => c.usage.cacheWriteTokens)
const dump = fs.existsSync(D) ? fs.readdirSync(D).sort() : []
const one = j.agents[0] ?? { steps: 0, stopped: "（没落）" }
const m = Object.fromEntries(j.metrics.map((x) => [x.metric, x]))
const card = [
  ["停因（三档哪一档）· 步数 / 上界", one.stopped + " · " + one.steps + " 步 / 上界 4"],
  ["真断言那条命令与它的退出码", j.verify.pass + " 通过 / " + j.verify.fail + " 没通过 / " + j.verify.unrunnable + " 跑不起来（argv 逐条在 --json 的 assertions 里）"],
  ["工作树 vs 定格那个提交：一致 / 差几条", treeOk + "（差 0 条）"],
  ["三个一线指标（分子分母随数一起印）", ["zero-tool-call-rate", "detour-rate", "prefix-hit-rate"].map((k) => k + " " + (m[k].numerator ?? "没有读数") + "/" + (m[k].denominator ?? "没有读数")).join(" · ")],
  ["归因三处对照：冷 · 共享头 · 第 k 步", j.attribution.map((a) => a.where + " 命中 " + (a.cacheReadTokens === null ? "没有读数" : a.cacheReadTokens)).join(" · ")],
  ["断点与缓存写入两栏（隐式档）", "未声明（隐式缓存）· cacheWriteTokens " + (cw.length === 0 ? "没有读数（一条 llm/call 都没有）" : cw.every((v) => v === null) ? "没有读数（" + cw.length + " 条都没报）" : JSON.stringify(cw) + "（提供方给的就是这个数）")],
  ["每趟 usage 四个数 · 合计", calls.length + " 趟 · 逐条 " + calls.map((c) => "[" + [c.usage.inputTokens, c.usage.cacheReadTokens, c.usage.cacheWriteTokens, c.usage.outputTokens].join(" ") + "]").join(" ") + " · 合计 [" + [sum.inputTokens, sum.cacheReadTokens, sum.cacheWriteTokens, sum.outputTokens].join(" ") + "]"],
  ["前缀 token 数（三区分别）· 调用次数", "token 数：没有读数（归 tools/probe-prefix.ts）· 三区指纹在 dump 的 meta 里 · 调用 " + calls.length + " 次 · 取证物 " + dump.length + " 份"],
  ["推进（写 / 删 / 跳过）", JSON.stringify(j.advanced === null ? null : { 写: j.advanced.written, 删: j.advanced.removed })]
]
for (const [k, v] of card) console.log("  " + k.padEnd(34, " ") + "｜ " + v)
fs.writeFileSync(T + "/card-live.tsv", card.map((r) => "ok\t真档判据卡：" + r[0] + "\t" + r[1]).join("\n") + "\n")
process.exit(card.every((r) => String(r[1]).trim() !== "") ? 0 : 1)
' "$T" "$LW" "$OUT/live" "$TREELIVE" || bad "真档判据卡：有留空的格子"
    readings "$T/card-live.tsv"
    # 收尾：真档那两个靶子（与夹具档同一把尺子）
    for pair in "L3:$LW" "回放回来的:$PW"; do
      lbl=${pair%%:*}
      d=${pair#*:}
      drop_agents "$d"
      check "$lbl：收尾之后只剩 main 一条分支" "1" "$(git -C "$d" for-each-ref --format='%(refname)' refs/heads 2> /dev/null | wc -l)"
      check "$lbl：物化根里一个文件都不剩" "0" "$(find "$d/.fugue/mat" -type f 2> /dev/null | wc -l)"
      check "$lbl：挂载表里没有它" "0" "$(grep -c "$d" /proc/self/mountinfo 2> /dev/null || true)"
    done
  fi
fi

echo
printf 'PASS %s · FAIL %s\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
