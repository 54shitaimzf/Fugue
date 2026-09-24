#!/bin/sh
# S7 的编排走查（PLAN § 5.7 的 A9 行 · 架构 § 20 S7 的可用性："完成拆分 → 并行 → 合并 → 验收
# 一个完整轮次；打回率有读数"）。
#
# **一条命令跑完这一站**：
#   建仓库 → 一个提交 → 配置里两条真断言 + 三份拆分草案 →
#   `round new` 钉底（分支的底 · 日志里那几条事件 · 契约正文 · 相交报出而照发 · 不相交报 0 对）→
#   `round run` 干净一趟（折 → 验 → 定格 → 推进）→
#   故意撞红一趟（一处冲突 → 冲突树物化 → 解决 → 重折 · 一次验收打回 · 一次动作被拒 · 真实工作树不动）→
#   打回那三个数与日志重放对账 → 漂移那一档（判据是「目标树 vs 盘上」：会被改写 → 拒 · 只被删 → 拒 ·
#   两边逐字节相同 → 照合并 · 红负对照）→
#   地板两档（一份契约直合 · 验收门只剩一条断言）→ 收尾：不留挂载 · 不留进程 · 不留孤儿分支。
#
# **它只用手边的东西**（与 S2–S6 那几份同一个形状）：每一步都是独立进程（§ 9.6），
# 所以收尾不需要杀进程；`--materialize` 那一档不在这里（它要卸挂载，归 S4 的走查）。
#
# 用法：sh tools/walkthrough-s7.sh。退出码 0 且 FAIL 0 才算走通。KEEP=1 留下现场。
set -u
cd /home/ubuntu/fugue || exit 9
FUGUE="node src/cli/fugue.ts"
W=$(mktemp -d /tmp/fugue-s7-XXXXXX)
T=$(mktemp -d /tmp/fugue-s7-read-XXXXXX)
PASS=0
FAIL=0
cleanup() {
  for n in 1 2 3; do
    $FUGUE --root "$W" --agent "agent/r1/$n" dispose > /dev/null 2>&1
  done
  if [ "${KEEP:-0}" = "1" ]; then
    printf '（KEEP=1，现场留着：%s · 读数在 %s）\n' "$W" "$T"
  else
    rm -rf "$W" "$T"
  fi
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
# 读数表：node 那几段把检查写成 `<ok|bad>\t<名字>\t<说明>`，这里逐行发落。**每一行恰好计一次数**，
# 所以收尾那行 PASS/FAIL 与上面印出来的行数永远对得上（原先有十一行 ok 没进计数）。
readings() {
  R="$1"
  while IFS="	" read -r v n d; do
    if [ "$v" = "ok" ]; then ok "$n"; else bad "$n（$d）"; fi
  done < "$R"
  rm -f "$R"
}

# **逐字节对账那把尺子**：`fugue commit` 不动 index（它自己造树、造提交），所以 `git status` ·
# `git diff` 在这个仓库里恒为空——它们比的是空 index，是**瞎绿**。要比就比树：把工作树临时灌进
# 一个另开的 index、`write-tree`，再与那个提交的树比 id。`.fugue/` 那条保留前缀写进
# `$GIT_DIR/info/exclude` 里排除（工作区的状态目录不是产品内容）。
tree_now() { rm -f "$T/tree-index"; GIT_INDEX_FILE="$T/tree-index" git -C "$W" add -A > /dev/null 2>&1; GIT_INDEX_FILE="$T/tree-index" git -C "$W" write-tree 2>/dev/null; }
# **每一趟轮次开跑之前把盘上与主线对齐。** A10 之后漂移那一档的判据是三方比出来的（底 · 盘上 ·
# 目标树），它看得见"轮次开始之前就存在的手改"——走查自己留下的那点脏（`--poke` 追加过的文件 ·
# 上一趟没推进而多出来的路径）会被判据当场拦下，而那不是这一趟要量的东西。
#
# 三件事，缺一不可：**空 index 摊平不了任何东西**（`checkout-index` 只按 index 写，index 是空的
# 它就一条都不写——实测 rc 0 而盘上纹丝不动），所以要先把主线那棵树读进一个另开的 index；
# `checkout-index` 也不删文件，所以主线里没有的得自己列出来删；落单的空目录也收掉（git 不当它是
# 条目，而 `scanTree` 扫的是盘上的目录）。
sync_disk() {
  want=$(git -C "$W" ls-tree -r --name-only refs/heads/main)
  have=$(cd "$W" && find . -type f -not -path './.git/*' -not -path './.fugue/*' | sed 's|^\./||')
  for f in $have; do
    case "$(printf '%s\n' "$want")" in
      *"$f"*) : ;;
      *) rm -f "$W/$f" ;;
    esac
  done
  (cd "$W" && find . -depth -type d -empty -not -path './.git*' -not -path './.fugue*' -exec rmdir {} + 2> /dev/null) || true
  rm -f "$T/sync-index"
  GIT_INDEX_FILE="$T/sync-index" git -C "$W" read-tree refs/heads/main > /dev/null 2>&1
  GIT_INDEX_FILE="$T/sync-index" git -C "$W" checkout-index -a -f > /dev/null 2>&1
  return 0
}
# 三条 agent 分支要在每一趟轮次之前是**空的**：`round run` 拒绝复用一条指过东西的分支
# （它不会搬别人的分支头）。所以收下一趟之前把这一趟的 agent 连分支带物化一起收掉。
drop_agents() {
  for n in 1 2 3; do
    $FUGUE --root "$W" --agent "agent/r1/$n" dispose > /dev/null 2>&1
  done
  for n in 1 2 3; do
    git -C "$W" update-ref -d "refs/heads/agent/r1/$n" > /dev/null 2>&1
  done
  # agent 的日志不删：run/end（第三个数的来源）落在 agent 那一份里，删了它第五段就数不出来。
  return 0
}

echo "=== 一 · 建仓库：一个提交 · 两条真断言 · 三份拆分草案 ==="
git -C "$W" init -q -b main
mkdir -p "$W/src" "$W/.fugue" "$W/.git/info"
printf '.fugue/\n' > "$W/.git/info/exclude"
printf 'export const a = 1\n' > "$W/src/a.ts"
printf 'export const b = 2\n' > "$W/src/b.ts"
# **起点用 git 落**（不是 `fugue commit`）：A10 之后漂移那一档的判据是三方比出来的（底 · 盘上 ·
# 目标树），它看得见"轮次开始之前就存在的手改"——每一趟轮次开跑时盘上必须与主线一致（下面那个
# `sync_disk`）。而 `fugue` 的提交没有父，主线要的是一条真历史。
git -C "$W" add -A > /dev/null 2>&1
git -C "$W" -c user.name=fugue -c user.email=fugue@local commit -q -m '起点' || bad "起点的提交"
BASE=$(git -C "$W" rev-parse refs/heads/main)
# 两条**真断言**：它们在合并之后那棵树上跑真进程（`test -f`），不是打桩的。
$FUGUE --root "$W" config set round.assertions \
  '[{"name":"合并之后 src/a.ts 在","argv":["/bin/sh","-c","test -f src/a.ts"]},
    {"name":"合并之后 src/b.ts 在","argv":["/bin/sh","-c","test -f src/b.ts"]}]' \
  > /dev/null || bad "config set round.assertions"
# 三份草案：第一与第三的写入面都是 `src/a.ts` —— **它们相交**（`Planning` 那一档报出而照发，
# 合并前那一档要 `--soft-merge-gate` 才放行；折叠里因此真撞出一次冲突）。
$FUGUE --root "$W" config set round.split \
  '[{"goal":"改 a","ownedPaths":["src/a.ts"],"assertions":[{"action":"x","name":"x"}]},
    {"goal":"改 b","ownedPaths":["src/b.ts"],"assertions":[{"action":"x","name":"x"}]},
    {"goal":"也改 a","ownedPaths":["src/a.ts"],"assertions":[{"action":"x","name":"x"}]}]' \
  > /dev/null || bad "config set round.split"
printf '  base = %s\n' "$BASE"

echo
echo "=== 二 · round new：钉底 · 发契约 · 起分支 ==="
$FUGUE --root "$W" round new '把 a 与 b 各改一处，并撞一次车' > "$T/new.out" 2> "$T/new.err"
RC=$?
printf '  rc = %s\n' "$RC"
sed 's/^/  /' "$T/new.out"
sed 's/^/  err| /' "$T/new.err"
check "round new 的退出码" "0" "$RC"
for n in 1 2 3; do
  check "agent/r1/$n 的底" "$BASE" "$(git -C "$W" rev-parse "refs/heads/agent/r1/$n" 2>/dev/null)"
done
has "$T/new.err" '照发' "相交报出来了，且话里写着照发"
$FUGUE --root "$W" --json log > "$T/log1.json" 2>/dev/null
node -e '
const fs = require("fs")
const T = process.argv[1]
const lines = fs.readFileSync(T + "/log1.json", "utf8").trim().split("\n").map((l) => JSON.parse(l))
const rows = lines.map((l) => l.e)
const by = (t) => rows.filter((r) => r.t === t)
const states = by("round/state").map((r) => r.from + "->" + r.to)
const writers = [...new Set(lines.map((l) => l.pos.writer))].sort()
console.log("  写者：" + writers.join(" · "))
console.log("  round/state：" + states.join(" · "))
// 正文原样印出来给人看（下面那条检查只报判决；正文是这个单元留给人读的档）。
console.log("  三份正文：" + by("contract/issue").map((r) => {
  const b = JSON.parse(r.body)
  return b.id + "=" + b.kind + "/" + b.agent + "/写" + b.ownedPaths.join(",")
}).join(" · "))
const okStates = JSON.stringify(states) === JSON.stringify(["Idle->Planning", "Planning->Delegated", "Delegated->Working"])
const okContracts = by("contract/issue").length === 3
const okBodies = by("contract/issue").every((r) => JSON.parse(r.body).id === r.contract)
const okFork = by("mat/fork").length === 0
const rows2 = [
  [okStates ? "ok" : "bad", "三步转移与图一致", states.join(" · ")],
  [okContracts ? "ok" : "bad", "三份契约各一条 contract/issue", "实得 " + by("contract/issue").length + " 条"],
  [okBodies ? "ok" : "bad", "契约正文与 id 逐条对上", "三份正文的 id 与 contract 字段逐个相等"],
  [okFork ? "ok" : "bad", "物化缺省不做（deferMaterialize）：mat/fork 一条都没有", "实得 " + by("mat/fork").length + " 条"]
]
fs.writeFileSync(T + "/r2.tsv", rows2.map((r) => r.join("\t")).join("\n") + "\n")
process.exit(okStates && okContracts && okBodies && okFork ? 0 : 1)
' "$T" || bad "round new 那一节的读数：node 那一段自己挂了"
readings "$T/r2.tsv"
# **第一条验证的负对照（不交那一半）**：同一个预检、同一个读者与切分，只有写入面互不相交，
# 它必须报 0 对——量具对"这就是相交"有分辨力，不是见谁都报。
$FUGUE --root "$W" round new '不相交的负对照' --split '[{"goal":"只改 a","ownedPaths":["src/a.ts"],"assertions":[{"action":"x","name":"x"}]},
  {"goal":"只改 b","ownedPaths":["src/b.ts"],"assertions":[{"action":"x","name":"x"}]}]' > "$T/new2.out" 2> "$T/new2.err"
RC0=$?
printf '  不相交那一趟 rc = %s · stderr：%s\n' "$RC0" "$(tr -d '\n' < "$T/new2.err")"
check "不相交那一趟的退出码" "0" "$RC0"
has "$T/new2.err" '0 对相交' "不相交时报的是 0 对（第一条验证的负对照）"
has "$T/new2.err" '2 条路径' "预检真跑了（报出看了 2 条路径——不是没跑才没有那一行）"
drop_agents

echo
echo "=== 三 · round run 干净一趟：拆分 → 并行 → 合并 → 验收 ==="
# **收口四样里的 1（一条命令跑完一个轮次）与 3（地板第一档）。**
# 干净那一趟的三份草案里第一与第三都写 `src/a.ts` —— 折叠时真撞一次车，冲突环解掉它。
sync_disk
# 盘上就是底那一份（`sync_disk` 刚摊平过）——漂移那一档照样放行：推进是在写新内容，**合并本来
# 就该改它**（判据放行的两档之一是"盘上 == 底"，见 `src/merge/drift.ts` 的文件头）。
$FUGUE --root "$W" round run '把 a 与 b 各改一处' --soft-merge-gate --report > "$T/run1.out" 2> "$T/run1.err"
RC1=$?
printf '  rc = %s\n' "$RC1"
sed 's/^/  /' "$T/run1.out"
sed 's/^/  err| /' "$T/run1.err"
check "干净那一趟的退出码" "0" "$RC1"
has "$T/run1.out" '验收：通过' "验收那一行印出来了"
has "$T/run1.out" '推进：写' "推进发生了（承重不变量：只推进到已通过验收的状态）"
# **第四条验证的读数**：推进之后真实工作树与 `main` 那个提交逐字节一致（保留前缀之外）。
if [ "$(tree_now)" = "$(git -C "$W" rev-parse 'refs/heads/main^{tree}')" ]; then
  ok "推进之后真实工作树与那个提交逐字节一致（保留前缀之外）"
else
  bad "推进之后真实工作树与那个提交的树不一致"
fi
node -e '
const fs = require("fs")
const T = process.argv[1]
const out = fs.readFileSync(T + "/run1.out", "utf8")
const m = {}
for (const line of out.split("\n")) {
  // **按制表符切**：那一行是 `<名字>\t<数>\t<判据>`（`reportOf` 一处排的版），
  // 而正则里的 `\s` 会连着把后面的中文判据也吃进去一截。
  const parts = line.replace(/^\s+/, "").split("\t")
  if (parts.length >= 2 && ["conflicts", "rejects", "denied"].includes(parts[0])) m[parts[0]] = Number(parts[1])
}
console.log("  干净那一趟的三个数：" + JSON.stringify(m))
const ok = m.conflicts === 1 && m.rejects === 0 && m.denied === 0
fs.writeFileSync(T + "/r3.tsv", (ok ? "ok" : "bad") + "\t干净一趟：撞了一次冲突（那一次被解掉了）· 没有打回 · 没有被拒\t" + JSON.stringify(m) + "\n")
process.exit(ok ? 0 : 1)
' "$T" || bad "干净那一趟的三个数：node 那一段自己挂了"
readings "$T/r3.tsv"
drop_agents

echo
echo "=== 四 · 故意撞红一趟：一处冲突 · 一次打回 · 一次被拒 · 真实工作树一个字节不动 ==="
# **回到这一趟的起点**：主线与工作树都退回那个钉住的底。折叠撞不撞车看的是底
# （同一批契约、同一个底 → 同一个结果），不回退就撞不出冲突树那一档。
git -C "$W" reset -q --hard "$BASE" 2> /dev/null
# reset --hard 只按 index 恢复**被跟踪**的那些（这个仓库里 fugue commit 不动 index，
# 所以 index 是空的）——余下的逐条按 index 摊平，路径还是那几条。
GIT_INDEX_FILE= git -C "$W" checkout-index -a -f 2> /dev/null
SNAP=$(tree_now)
if [ -z "$SNAP" ]; then bad "这一趟的起点读数没取到（tree_now 给的是空串）"; fi
printf '  这一趟之前的树 = %s（= 那个底）\n' "$SNAP"
sync_disk
$FUGUE --root "$W" round run '再跑一趟，故意撞红' --soft-merge-gate \
  --fail '合并之后 src/b.ts 在' --deny --retry 1 --report --json > "$T/run2.json" 2> "$T/run2.err"
RC2=$?
printf '  rc = %s（没通过那一档的退出码是 1，不是用法错）\n' "$RC2"
check "撞红那一趟的退出码" "1" "$RC2"
node -e '
const fs = require("fs")
const T = process.argv[1]
const snap = process.argv[2]
const j = JSON.parse(fs.readFileSync(T + "/run2.json", "utf8"))
const m = Object.fromEntries(j.metrics.map((r) => [r.metric, r.count]))
console.log("  三个数：" + JSON.stringify(m))
console.log("  预检：Planning " + j.precheckPlanning + " 对 · 合并前 " + j.precheckMerge.count + " 对")
console.log("  冲突树：" + JSON.stringify(j.conflictTree))
console.log("  被拒的动作：" + JSON.stringify(j.deniedAction))
console.log("  验收：" + JSON.stringify(j.verify))
console.log("  推进：" + (j.advanced === null ? "没有" : JSON.stringify(j.advanced)))
console.log("  停下来那个状态：" + j.state)
const allPositive = m.conflicts > 0 && m.rejects > 0 && m.denied > 0
const rows4 = [
  [allPositive, "三个数逐个大于 0", JSON.stringify(m)],
  [j.conflictTree !== null, "冲突树物化出来了", JSON.stringify(j.conflictTree)],
  [j.verify.fail > 0, "有一次验收没通过", JSON.stringify(j.verify)],
  [j.advanced === null, "没过 → 推进没有发生（真实工作树一个字节不动）", JSON.stringify(j.advanced)],
  [j.state === "Working", "带余量时回 Working（那条回边）", j.state]
]
fs.writeFileSync(T + "/r4.tsv", rows4.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
process.exit(allPositive && j.conflictTree !== null && j.verify.fail > 0 && j.advanced === null && j.state === "Working" ? 0 : 1)
' "$T" "$SNAP" || bad "撞红那一趟的读数：node 那一段自己挂了"
readings "$T/r4.tsv"
# **第二条验证的读数**：注入一次失败的断言之后，真实工作树**没有被改动**——这一条拿树 id 判，
# 不拿 `git status` 判（那个在这个仓库里恒为空，见上面那把尺子的说明）。
if [ "$(tree_now)" = "$SNAP" ]; then
  ok "注入失败断言之后真实工作树还是那一棵树（树 id 没动）"
else
  bad "注入失败断言之后真实工作树变了：$SNAP → $(tree_now)"
fi
drop_agents

echo
echo "=== 五 · 打回三个数与日志重放对账 ==="
$FUGUE --root "$W" --json log > "$T/log2.json" 2>/dev/null
node -e '
const fs = require("fs")
const T = process.argv[1]
const lines = fs.readFileSync(T + "/log2.json", "utf8").trim().split("\n").map((l) => JSON.parse(l))
const rows = lines.map((l) => l.e)
// **手工按三条判据各数一遍**——三条判据都写在这一段里，与 `src/probe/round.ts` 那一份无关。
const conflicts = rows.filter((e) => e.t === "merge/attempt").reduce((n, e) => n + e.conflicts, 0)
const rejects = rows.filter((e) => e.t === "round/state" && e.from === "Verifying" && e.to === "Working").length
const denied = rows.filter((e) => e.t === "run/end" && e.denied).length
const j = JSON.parse(fs.readFileSync(T + "/run2.json", "utf8"))
const m = Object.fromEntries(j.metrics.map((r) => [r.metric, r.count]))
const byHand = { conflicts, rejects, denied }
console.log("  按日志手工数：" + JSON.stringify(byHand))
console.log("  --report 印的：" + JSON.stringify(m))
const same = byHand.conflicts === m.conflicts && byHand.rejects === m.rejects && byHand.denied === m.denied
fs.writeFileSync(T + "/r5.tsv", (same ? "ok" : "bad") + "\t两边逐个数相等（重算，不是采集）\t手工 " + JSON.stringify(byHand) + " 对 " + JSON.stringify(m) + "\n")
// 事件落在几个 writer 上：`merge/attempt` 与 `round/state` 在持轮者那一份，`run/end` 在 agent 那一份。
const w = (t) => [...new Set(lines.filter((l) => l.e.t === t).map((l) => l.pos.writer))].sort()
console.log("  merge/attempt 的写者：" + w("merge/attempt").join(" · "))
console.log("  run/end 的写者：" + w("run/end").join(" · "))
process.exit(same ? 0 : 1)
' "$T" || bad "三个数与日志重放对账：node 那一段自己挂了"
readings "$T/r5.tsv"

echo
echo "=== 六 · 漂移那一档：判据是「目标树 vs 盘上」（A10）==="
# **`--poke` 落在折叠之后、物化之前**（A10 把漂移检挪到了那个位置：判据的另一边是折出来的那棵
# 目标树）。上一趟撞红没有推进，所以工作树与 `main` 那棵树仍然一致，底是 `$BASE`。

# 六之一 · **两边逐字节相同 → 照合并**。这一档量的是：这次合并**要写** `src/a.ts`，而盘上那份
# 与它算出来的结果**逐字节相同**——`--poke-exact` 抄的正是折出来的目标树里那条路径的字节
# （`--poke` 是「追加上一行」，抄不出「一样」）。于是推进之后工作树与提交仍然一致：没人丢字节。
sync_disk
$FUGUE --root "$W" round run '两边一样那一趟' --soft-merge-gate --poke-exact src/a.ts > "$T/run3.out" 2> "$T/run3.err"
RC3=$?
printf '  两边一样那一趟 rc = %s\n' "$RC3"
sed 's/^/  err| /' "$T/run3.err"
check "盘上与目标树逐字节相同 → 照合并（不退回「脏了就拒」）" "0" "$RC3"
has "$T/run3.err" '这次合并动到' "漂移读数印出来了：这次合并动到几条 · 盘上与目标树有没有差"
has "$T/run3.err" '盘上与目标树不同 \[\]' "读数里那一条是空的：盘上与目标树一处都不同"
if grep -q '会被覆盖掉' "$T/run3.err"; then
  bad "两边一样却按覆盖拒了（判据退回「脏了就拒」）"
else
  ok "两边一样的那一条没有被拒（拦的果真是「会被覆盖的那些」）"
fi
if [ "$(tree_now)" = "$(git -C "$W" rev-parse 'refs/heads/main^{tree}')" ]; then
  ok "两边一样那一趟推进了，工作树与那个提交逐字节一致"
else
  bad "两边一样那一趟之后工作树与提交不一致"
fi
# 这一趟定格的那一次接受：**恰好一条** `merge/accept`（不是"两次尝试都记成接受"）。
$FUGUE --root "$W" --json log > "$T/log-drift.json" 2>/dev/null
node -e '
const fs = require("fs")
const T = process.argv[1]
const W = process.argv[2]
const lines = fs.readFileSync(T + "/log-drift.json", "utf8").trim().split("\n").map((l) => JSON.parse(l))
const all = lines.map((l) => l.e).filter((e) => e.t === "merge/accept")
// **按提交数，不按轮次号**：每一趟轮次的名字都是 r1（走查里就那么配的），轮次号分不开它们。
// 定格的提交是唯一的，而这一趟那一份必须与主线现在指着的那一个相同。
const commits = [...new Set(all.map((e) => e.commit))]
const head = require("child_process").execFileSync("git", ["-C", W, "rev-parse", "refs/heads/main"]).toString().trim()
const rows = [
  [all.length > 0, "两边一样那一趟定格了提交点（merge/accept）", "全场 " + all.length + " 条 · 提交 " + commits.map((c) => c.slice(0, 7)).join(" · ")],
  [commits.length === 2, "每一趟各定格一次（两次尝试不会都记成接受）", "实得 " + commits.length + " 个提交"],
  [commits.includes(head), "这一趟定格的那个提交就是主线现在指着的那一个", head.slice(0, 7)]
]
fs.writeFileSync(T + "/r6.tsv", rows.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
process.exit(commits.length === 2 && commits.includes(head) ? 0 : 1)
' "$T" "$W" || bad "两边一样那一趟的事件读数：node 那一段自己挂了"
readings "$T/r6.tsv"
drop_agents

# 六之二 · **只被删的那一条 → 拒**（A10 补上的那一栏）。
# 六之一那一趟把 `src/z.ts` 新写上去、随提交点进了主线。这一趟先 `sync_disk`（盘上摊回主线那棵
# 树：z 因此回到盘上），再把它从盘上拿掉——于是底与主线里都**在**、盘上**没有**，而目标树里也
# 没有（谁都不写这一条路径）：第 7 步推进会把它删掉。`--poke` 再把一条手改写上去，判据那一档要
# 拦的正是这个（换判据之前，这一条一处都不「写」，「会被覆盖的那些」是空的，两个集合没得相交
# ——手改被静默退回底那一版，退出码 0）。
sync_disk
rm -f "$W/src/z.ts"
SNAP_D=$(tree_now)
HEAD_D=$(git -C "$W" rev-parse 'refs/heads/main')
$FUGUE --root "$W" round run '只被删那一趟' --soft-merge-gate --poke src/z.ts > "$T/run4.out" 2> "$T/run4.err"
RC4=$?
printf '  只被删那一趟 rc = %s\n' "$RC4"
sed 's/^/  err| /' "$T/run4.err"
check "一条只被删的路径上有手改 → 拒" "1" "$RC4"
has "$T/run4.err" '会被删掉' "拒的话里说得出它推进时会被删掉"
has "$T/run4.err" 'src/z.ts' "拒的话里报出是哪一条"
# **量"推进没有发生"**：主线一个字节没挪（工作树这一趟是 `--poke` 自己写的那一条，不算）。
if [ "$(git -C "$W" rev-parse 'refs/heads/main')" = "$HEAD_D" ]; then
  ok "拒的时候主线没挪（推进没有发生）"
else
  bad "拒的时候主线挪了：$(git -C "$W" rev-parse 'refs/heads/main')"
fi
if [ "$(cat "$W/src/z.ts" 2>/dev/null)" = "轮次中有人手改了这条：src/z.ts" ]; then
  ok "拒的时候那条手改的字节还在（没被覆盖 · 也没被删）"
else
  bad "拒的时候那条手改的字节没了"
fi
drop_agents

echo
echo "=== 六之三 · 第四条验证的红负对照：手改一个字节 → 那把尺子当场变红 ==="
# 上一趟被拒了，盘上还留着 `--poke` 写的那一条（主线里没有它）：先摊回主线那棵树，再量这一档。
sync_disk
# 合并已经做完、工作树与提交一致，这时候动它一个字节：逐字节对账必须立刻变红。
# 变红就证明上面那几条绿不是瞎绿——同一把尺子对"就是不一致"有分辨力。
cp "$W/src/b.ts" "$T/b.keep"
printf '\n// 红负对照：手改一个字节\n' >> "$W/src/b.ts"
if [ "$(tree_now)" = "$(git -C "$W" rev-parse 'refs/heads/main^{tree}')" ]; then
  bad "负对照没红：手改了 src/b.ts，逐字节对账却说一致"
else
  ok "负对照红了：手改 src/b.ts 之后逐字节对账报不一致"
fi
cp "$T/b.keep" "$W/src/b.ts"
if [ "$(tree_now)" = "$(git -C "$W" rev-parse 'refs/heads/main^{tree}')" ]; then
  ok "把文件放回去之后又是逐字节一致（这把尺子两边都量得出来）"
else
  bad "放回去之后仍报不一致"
fi
drop_agents

echo
echo "=== 七 · 地板两档：两条分支直合 · 验收门只剩一条断言 ==="
# 架构 § 3 的地板：这一站的机制是编排（合并与验收），退化档是**逐路折叠 → 两条分支直合**，
# 第二档是**验收门只剩一条断言**（PLAN § 5.7 的「地板」那段）。两档在这一趟里一起走：
# 一份契约（折叠表的长度 1，与 N 份走同一条代码路径）· 验收门一条断言。
$FUGUE --root "$W" config set round.assertions \
  '[{"name":"合并之后 src/a.ts 在","argv":["/bin/sh","-c","test -f src/a.ts"]}]' > /dev/null || bad "地板那一档的断言配置"
$FUGUE --root "$W" config set round.split \
  '[{"goal":"只改 a","ownedPaths":["src/a.ts"],"assertions":[{"action":"x","name":"x"}]}]' > /dev/null || bad "地板那一档的拆分配置"
SNAP6=$(tree_now)
sync_disk
$FUGUE --root "$W" round run '地板那一趟' --report --json > "$T/run5.json" 2> "$T/run5.err"
RC5=$?
printf '  rc = %s\n' "$RC5"
sed 's/^/  err| /' "$T/run5.err"
check "地板那一趟的退出码" "0" "$RC5"
node -e '
const fs = require("fs")
const T = process.argv[1]
const snap = process.argv[2]
const j = JSON.parse(fs.readFileSync(T + "/run5.json", "utf8"))
const plan = j.precheckPlanning
const vs = j.verify
const adv = j.advanced
// **"推进发生了"看的是"工作树与那个提交点一致"**，不是"写了几条"：盘上就是底那一份时
// `advance` 一条都不用写（它只改与目标不同的那些，§ 8.5 的"不 touch 一致的"），而那正是
// A10 判据放行的两档之一。写了 0 条也是推进做完了。
const ok = plan === 0 && vs.pass === 1 && vs.fail === 0 && vs.unrunnable === 0 && vs.ok === true && adv !== null
console.log("  Planning 预检 " + plan + " 对 · 验收 " + JSON.stringify(vs) + " · 推进 " + JSON.stringify(adv))
const rows7 = [
  [ok, "地板两档：一份契约直合 + 一条断言的验收门，轮次照收", "预检 " + plan + " 对 · " + JSON.stringify(vs)],
  [adv !== null, "地板那一档照样推进（写 " + (adv === null ? 0 : adv.written.length) + " 条 · 删 " + (adv === null ? 0 : adv.removed.length) + " 条）", JSON.stringify(adv)]
]
fs.writeFileSync(T + "/r7.tsv", rows7.map((r) => (r[0] ? "ok" : "bad") + "\t" + r[1] + "\t" + r[2]).join("\n") + "\n")
process.exit(ok ? 0 : 1)
' "$T" "$SNAP6" || bad "地板两档的读数：node 那一段自己挂了"
readings "$T/r7.tsv"
if [ "$(tree_now)" = "$(git -C "$W" rev-parse 'refs/heads/main^{tree}')" ]; then
  ok "地板那一趟之后仍然逐字节一致"
else
  bad "地板那一趟之后不一致"
fi

echo
echo "=== 八 · 收尾：不留挂载 · 不留进程 · 不留孤儿分支 ==="
MOUNTS=$(grep -c "fugue-s7-" /proc/mounts 2>/dev/null || true)
check "挂载表里没有这一趟的痕迹" "0" "${MOUNTS:-0}"
LEFT=$(ps -eo args 2>/dev/null | grep -c "[f]ugue-s7-.*bwrap" || true)
check "没有这一趟的沙箱进程" "0" "${LEFT:-0}"
# 分支的条数是最后一趟（地板那一趟一份契约）留下的，不是第二段那三条：round run 每趟各起各的。
# 留在这里的那一条是"还能再跑一趟"的证据；多了才是漏（谁把别人的分支留下了）。
$FUGUE --root "$W" --json log > "$T/log3.json" 2>/dev/null
REFS=$(git -C "$W" for-each-ref --format='%(refname)' refs/heads | wc -l)
check "分支：main + 最后一趟那一条 agent" "2" "$REFS"
LAST=$(git -C "$W" for-each-ref --format='%(refname)' refs/heads | grep agent | tr -d "\n")
check "留着的正是地板那一趟的 agent" "refs/heads/agent/r1/1" "$LAST"
STRAY=$(git -C "$W" for-each-ref --format='%(refname)' refs/heads | grep -vc "^refs/heads/agent/r1/1$" || true)
check "没有多出来的分支" "1" "${STRAY:-0}"
puts=$(grep -c . "$T/log3.json" 2>/dev/null || true)
printf '  日志条数（三趟加起来）：%s\n' "${puts:-0}"

echo
printf 'PASS %s · FAIL %s\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
