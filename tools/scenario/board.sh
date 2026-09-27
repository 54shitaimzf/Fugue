#!/bin/sh
# **样本盘**：把"这一版到底改对了没有"变成一个不依赖模型的读数。
#
# 跑法（cd ~/fugue）：
#   sh tools/scenario/board.sh --selftest                 # 离线：判据自己有牙没有（不花钱）
#   sh tools/scenario/board.sh --stub                     # 打桩档：机制烟测（不出网）
#   sh tools/scenario/board.sh --live --runs 3            # 真档：每一案连跑 3 趟，逐趟判已知答案
#   sh tools/scenario/board.sh --live --case "改码 · 单文件（最小的一案，反复采样用）"
#
# 它逐案做五件事（每一件都留读数在 $OUT 里）：
#   一 · 按 `base` 铺一份真仓库（主线 `main`）+ 把 `actions` 与（有 `split` 的案）`round.split` 写进配置
#   二 · 跑那条链：有 `split` 的案走 `round run`（人拆那一档）；没有的走
#        `round plan`（持轮者自己拆）→ 停在门口 → `round go` → `round work`。**门退回在那一段量**
#   三 · 跑案自带的那几条**观察**（`observes`）——它们与模型选的断言无关，是出题人给的
#   四 · 拿 `answer` 判**真实工作树**（判据在 `src/probe/board.ts`，纯读）
#   五 · 把这一轮压成账上一行（`$OUT/ledger.tsv`）：门退回 · 停因 · 验收 · 已知答案 · 观察 ·
#        打回三数 · 调用与四个 token 数（用量从日志现算，不看模型报什么）
#
# **取证用，不是产品的一部分**（仓库约定 § 七）。凭据经环境变量给（`authOf` 唯一取值处），不打印它的值。
set -u
cd /home/ubuntu/fugue || exit 9

LIVE=no
MODE=run
RUNS=1
ONECASE=
OUT=/tmp/scenario-out
while [ $# -gt 0 ]; do
  case "$1" in
    --selftest) MODE=selftest ;;
    --live) LIVE=yes ;;
    --stub) LIVE=no ;;
    --runs) RUNS=$2; shift ;;
    --case) ONECASE=$2; shift ;;
    --out) OUT=$2; shift ;;
    *) echo "不认这个开关：$1"; exit 2 ;;
  esac
  shift
done

CASES=tools/scenario/cases.json
NODE=src/cli/fugue.ts
F() {
  # POSIX sh 没有 `${@:2}`：第一个参数先取下来，剩下的原样交给产品那一层。**吞掉 stderr**，
  # 只给那些"成不成都不影响读数"的调用用（`config set` · `dispose`）。
  f_root=$1
  shift
  node "$NODE" --root "$f_root" "$@" 2> /dev/null
}
# 跑链那三条用这个：**stderr 留给调用者重定向**——不然"这一趟为什么没跑起来"就看不见了。
FX() {
  f_root=$1
  shift
  node "$NODE" --root "$f_root" "$@"
}
MACH_PASS=0
MACH_FAIL=0
ok() { MACH_PASS=$((MACH_PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { MACH_FAIL=$((MACH_FAIL + 1)); printf '  FAIL %s\n' "$1"; }

if [ "$MODE" = selftest ]; then
  echo "=== 判据自己有牙没有（离线 · 不花钱）==="
  node tools/scenario/board-node.ts selftest "$CASES"
  exit $?
fi

rm -rf "$OUT"
mkdir -p "$OUT"
printf '案\t趟\t门退回\t停因收敛\t验收\t已知答案\t观察\t冲突\t拒绝\t越界\t调用\tinput\tcacheRead\toutput\t推进\n' > "$OUT/ledger.tsv"

# 逐案：把声明摊成一份速查文件（sh 里解析 JSON 不如交给 node）
node -e '
const fs = require("fs")
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).cases
const out = process.argv[2]
fs.mkdirSync(out, { recursive: true })
for (const [i, one] of c.entries()) {
  const dir = out + "/case-" + String(i + 1)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of one.base) {
    const p = dir + "/base/" + f.path
    fs.mkdirSync(require("path").dirname(p), { recursive: true })
    fs.writeFileSync(p, f.text)
  }
  fs.writeFileSync(dir + "/meta.json", JSON.stringify({ name: one.name, goal: one.goal, maxSteps: one.maxSteps ?? 6, covers: one.covers, actions: one.actions, split: one.split ?? null, assertions: one.assertions ?? null, observes: one.observes ?? [] }, null, 2))
}
console.log(c.map((o, i) => "case-" + String(i + 1) + "\t" + o.name).join("\n"))
' "$CASES" "$OUT/decl" > "$OUT/names.txt" || exit 9

seed() { # seed <工作区> <case-N>
  mkdir -p "$1/.git/info"
  printf '.fugue/\n' > "$1/.git/info/exclude"
  cp -r "$OUT/decl/$2/base/." "$1/"
  (cd "$1" && git init -q . && git symbolic-ref HEAD refs/heads/main &&
    git config user.email fugue@localhost && git config user.name fugue &&
    git add -A && git commit -qm 起点) || return 1
  F "$1" config set round.id r1 > /dev/null || return 1
  node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const out = []
for (const [name, spec] of Object.entries(m.actions ?? {})) out.push("actions." + name + "\t" + JSON.stringify(spec))
if (m.split) out.push("round.split\t" + JSON.stringify(m.split))
if (m.assertions) out.push("round.assertions\t" + JSON.stringify(m.assertions))
process.stdout.write(out.join("\n") + "\n")   // 末行也要换行：`while read` 会漏掉没有换行的那一行
' "$OUT/decl/$2/meta.json" > "$OUT/decl/$2/config.txt"
  while IFS="$(printf '\t')" read -r k v; do
    [ -n "$k" ] && F "$1" config set "$k" "$v" > /dev/null
  done < "$OUT/decl/$2/config.txt"
  return 0
}

observe() { # observe <工作区> <case-N> → 过/总
  obs=$(node -e 'process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).observes ?? []).join("\n"))' "$OUT/decl/$2/meta.json")
  pass=0
  all=0
  [ -z "$obs" ] && { printf '没有观察'; return; }
  printf '%s\n' "$obs" | while IFS= read -r one; do
    [ -z "$one" ] && continue
    all=$((all + 1))
    if (cd "$1" && sh -c "$one" > /dev/null 2>&1); then pass=$((pass + 1)); fi
    printf '%s\t%s\n' "$pass" "$all" > "$OUT/decl/$2/observe.txt"
  done
  cat "$OUT/decl/$2/observe.txt" 2> /dev/null | tr '\t' '/'
}

run_one() { # run_one <案名> <case-N> <趟>
  name=$1
  cn=$2
  run=$3
  W="$OUT/run/$cn-$run/ws"
  D="$OUT/run/$cn-$run"
  mkdir -p "$W" "$D"
  seed "$W" "$cn" || { bad "$name 第 $run 趟：铺底"; return; }
  MAX=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).maxSteps))' "$OUT/decl/$cn/meta.json")
  GOAL=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goal)' "$OUT/decl/$cn/meta.json")
  HASSPLIT=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).split ? "yes" : "no")' "$OUT/decl/$cn/meta.json")
  GATE=—
  if [ "$HASSPLIT" = yes ]; then
    if [ "$LIVE" = yes ]; then
      FX "$W" --json --report --metrics round run "$GOAL" --live --max-steps "$MAX" > "$D/work.json" 2> "$D/work.err"
    else
      FX "$W" --json --report --metrics round run "$GOAL" --max-steps "$MAX" > "$D/work.json" 2> "$D/work.err"
    fi
  else
    if [ "$LIVE" = yes ]; then
      FX "$W" round plan "$GOAL" --live --max-steps "$MAX" > "$D/plan.out" 2> "$D/plan.err"
    else
      FX "$W" round plan "$GOAL" --max-steps "$MAX" > "$D/plan.out" 2> "$D/plan.err"
    fi
    if grep -q '停在门口' "$D/plan.out"; then
      GATE=停在门口
      FX "$W" --json round go > "$D/go.json" 2> "$D/go.err"
      if [ "$LIVE" = yes ]; then
        FX "$W" --json --report --metrics round work --live --max-steps "$MAX" > "$D/work.json" 2> "$D/work.err"
      else
        FX "$W" --json --report --metrics round work --max-steps "$MAX" > "$D/work.json" 2> "$D/work.err"
      fi
    else
      GATE=退回
      printf '（%s 第 %s 趟：门退回了，放行与接着跑那两段没有东西可量）\n' "$name" "$run"
      sed 's/^/  err| /' "$D/plan.err"
      U=$(node tools/scenario/board-node.ts usage "$W")
      printf '%s\t%s\t%s\t—\t—\t—\t—\t—\t—\t—\t%s\t—\n' "$name" "$run" "$GATE" "$U" >> "$OUT/ledger.tsv"
      return
    fi
  fi
  if [ ! -s "$D/work.json" ]; then
    bad "$name 第 $run 趟：这一趟没跑起来—— $(head -2 "$D/work.err" | tr '\n' ' ')"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t—\t—\t—\t—\t—\t—\t—\t—\n' "$name" "$run" "$GATE" 没有读数 没有读数 没有读数 "—" >> "$OUT/ledger.tsv"
    return
  fi
  # 清掉物化坐标（内核在 tmp 里挖的那个点会让 git add -A 吃 EACCES）
  for a in $(git -C "$W" for-each-ref --format='%(refname:short)' refs/heads/agent 2> /dev/null); do
    F "$W" --agent "$a" dispose > /dev/null 2>&1
  done
  OBS=$(observe "$W" "$cn")
  if node tools/scenario/board-node.ts judge "$CASES" "$W" "$name" > "$D/judge.txt" 2>&1; then
    ok "$name 第 $run 趟：已知答案过（观察 $OBS）"
  else
    bad "$name 第 $run 趟：已知答案不过（观察 $OBS）—— $(tail -3 "$D/judge.txt" | tr '\n' ' ')"
  fi
  node tools/scenario/board-node.ts row "$CASES" "$W" "$D/work.json" "$name" "$run" "$GATE" "$OBS" >> "$OUT/ledger.tsv" 2>> "$D/row.err"
  grep -v '^*$' "$D/judge.txt" | sed 's/^/  | /'
}

echo "=== 样本盘：$CASES（$([ "$LIVE" = yes ] && echo 真档 || echo 打桩档) · 每案 $RUNS 趟）==="
echo
echo "=== 一 · 判据自己有牙没有（离线 · 不花钱）==="
node tools/scenario/board-node.ts selftest "$CASES" || bad "判据自检"
echo
echo "=== 二 · 逐案跑（$([ "$LIVE" = yes ] && echo "真档 · 花钱" || echo 打桩档)）==="
i=0
while IFS="$(printf '\t')" read -r cn name; do
  [ -z "$cn" ] && continue
  i=$((i + 1))
  if [ -n "$ONECASE" ] && [ "$name" != "$ONECASE" ]; then continue; fi
  echo
  echo "--- $name（$cn）"
  run=1
  while [ "$run" -le "$RUNS" ]; do
    run_one "$name" "$cn" "$run"
    run=$((run + 1))
  done
done < "$OUT/names.txt"

echo
echo "=== 三 · 账（$OUT/ledger.tsv）==="
sed 's/^/  /' "$OUT/ledger.tsv"
echo
printf '机制：PASS %s · FAIL %s\n' "$MACH_PASS" "$MACH_FAIL"
[ "$MACH_FAIL" = "0" ] || exit 1
exit 0
