#!/bin/sh
# **样本盘**：把"这一版到底改对了没有"变成一个不依赖模型的读数。
#
# 跑法（cd ~/fugue）：
#   sh tools/scenario/board.sh --selftest                 # 离线：判据自己有牙没有（不花钱）
#   sh tools/scenario/board.sh --stub                     # 打桩档：机制烟测（不出网）
#   sh tools/scenario/board.sh --live --runs 3            # 真档：每一案连跑 3 趟，逐趟判已知答案
#   sh tools/scenario/board.sh --live --runs 5 --gate-only    # 只跑到门口：门退回率多样本（一趟 ≈ 一次持轮者那一趟）
#   sh tools/scenario/board.sh --live --case "改码 · 单文件（最小的一案，反复采样用）"
#   sh tools/scenario/board.sh --live --runs 1 --case "改码 · 记账库" --dump-wire
#       # 实录那一档：`round plan` 与 `round work` 各落一份 `--dump-wire`（诊断"这一格那几步
#       #   到底干了什么"用；落点 `$OUT/run/<案>-<趟>/{wire-plan,wire}`，在工作区之外）
#   sh tools/scenario/board.sh --live --runs 3 --gate-only --max-steps 16
#       # 覆盖出题那一栏的上界：量的是"这一趟自然几步收工"（**不是拿它把判据弄绿**——
#       #   § 5.9.2 那条纪律管的是后者：连续几趟停在"到了你给的上界"是协议或提示的问题）。
#       #   用了哪个上界会落在 $OUT/decl/<案>/meta.json 与每趟那一行里，台账因此读得出来。
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
# **账本自己也要看得见**（第十五趟样本盘照出来的那条缝）：账 · 实录 · 判分结果都住在 `$OUT` 里，
# 而助手手里那条 `bash` 只要够得着它，这一趟的读数就分不开"它自己解出来的"与"它翻到了我们的
# 账本"（那一趟 `case-1-1` 读到的是 `/tmp/scenario-b14/run/case-1-1/work.json` 与 `wire-plan/`
# 的请求实录）。两半各做一件事：
#   · **围栏那一半由产品封**：`round work` 每一格第一次起子进程时记一条 `run/confined`
#     （`src/round/driver.ts`），这一份逐趟核它是不是 `full`——不是就当场红。那一趟的数字照
#     印在账上（它们是读数），而"不当证据"由那一行下面恒印的「围栏：」那一行说；`—` 只留给
#     真的一个子进程都没有那一档，有子进程而没有记录读出来是 `缺：…`。
#   · **这一半是绊线**：`$OUT` 里放一枚记号，跑完在实录里找它（`--dump-wire` 那一档）。
#     找不到不证明什么，找到了就是当场红——它是读数，不是判据。
#
# **取证用，不是产品的一部分**（仓库约定 § 七）。凭据经环境变量给（`authOf` 唯一取值处），不打印它的值。
set -u
cd /home/ubuntu/fugue || exit 9

LIVE=no
MODE=run
RUNS=1
GATE_ONLY=no
# **实录那一档**（取证用）：给了它，`round plan` 与 `round work` 各带 `--dump-wire`，
# 落点在 `$OUT/run/<案>-<趟>/{wire-plan,wire}`。诊断"这一格那几步到底干了什么"要它
# （落点在工作区之外：**落进 `<root>` 会被下一轮的 fork 当成漂移**，`dumpWireDir` 那一道守卫）。
DUMP=no
ONECASE=
# 空 = 用出题那一栏给的那个上界（缺省就是这样；覆盖只在我显式给了 `--max-steps` 时发生）。
MAXOVERRIDE=
OUT=/tmp/scenario-out
while [ $# -gt 0 ]; do
  case "$1" in
    --selftest) MODE=selftest ;;
    --live) LIVE=yes ;;
    --stub) LIVE=no ;;
    --runs) RUNS=$2; shift ;;
    --gate-only) GATE_ONLY=yes ;;
    --dump-wire) DUMP=yes ;;
    --case) ONECASE=$2; shift ;;
    # 出题那一栏的上界（`meta.json` 的 `maxSteps`）在这里可以被**覆盖一次**：量"自然几步收工"用。
    # 覆盖之后**处处读的都是它**（`run_one` 从 `meta.json` 现读），所以台账与真调用不可能分家。
    --max-steps) MAXOVERRIDE=$2; shift ;;
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
# **绊线那一枚记号**：它住在这本账旁边，助手够得着的话就该在实录里现形。
CANARY="FUGUE-CANARY-$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
printf '%s\n' "$CANARY" > "$OUT/canary.txt"

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
  // **上界：出题那一栏给的那个，除非人显式覆盖**（覆盖之后这一份就是唯一出处，`run_one` 读它）。
  const override = process.argv[3] === "" ? null : Number(process.argv[3])
  const maxSteps = override === null ? (one.maxSteps ?? 6) : override
  fs.writeFileSync(dir + "/meta.json", JSON.stringify({ name: one.name, goal: one.goal, maxSteps, declaredMaxSteps: one.maxSteps ?? 6, maxStepsOverridden: override !== null, covers: one.covers, actions: one.actions, split: one.split ?? null, assertions: one.assertions ?? null, observes: one.observes ?? [] }, null, 2))
}
console.log(c.map((o, i) => "case-" + String(i + 1) + "\t" + o.name).join("\n"))
' "$CASES" "$OUT/decl" "$MAXOVERRIDE" > "$OUT/names.txt" || exit 9

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
  # 实录那一档的两个落点：**plan 与 work 分开**（同一个目录会让两段的 call-0001 互相覆盖）。
  WD=""
  PD=""
  if [ "$DUMP" = yes ]; then
    WD="--dump-wire $D/wire"
    PD="--dump-wire $D/wire-plan"
  fi
  # **只到门口这一档跳过人拆那一案**：那一档不经门（`round run` 直接从配置里读拆分），量不到①。
  if [ "$GATE_ONLY" = yes ] && [ "$HASSPLIT" = yes ]; then
    printf '（%s 第 %s 趟：人拆那一档不经门，"只到门口"这一档跳过它）\n' "$name" "$run"
    return
  fi
  if [ "$HASSPLIT" = yes ]; then
    if [ "$LIVE" = yes ]; then
      FX "$W" --json --report --metrics round run "$GOAL" --live --max-steps "$MAX" > "$D/work.json" 2> "$D/work.err"
    else
      FX "$W" --json --report --metrics round run "$GOAL" --max-steps "$MAX" > "$D/work.json" 2> "$D/work.err"
    fi
  else
    if [ "$LIVE" = yes ]; then
      FX "$W" round plan "$GOAL" --live --max-steps "$MAX" $PD > "$D/plan.out" 2> "$D/plan.err"
    else
      # **打桩档一次调用都不发。** 持轮者那一趟没有打桩那一档（`--wire-in` 与 `--judge` 之外都会
      # 真发调用：`round plan` 缺省就是真网络），所以这一档走人喊停那条路——`--judge` 一步都不跑，
      # 拿视图里那一份直接判。账上因此四列全 0，而那一趟照旧记"退回"（烟雾档只烟测铺底 · 判据 · 账）。
      FX "$W" round plan "$GOAL" --judge > "$D/plan.out" 2> "$D/plan.err"
    fi
    if grep -q '停在门口' "$D/plan.out"; then
      GATE=停在门口
      if [ "$GATE_ONLY" = yes ]; then
        # **只跑到门口**：这一档量的是那道门（判据①那一句"门退回率"），派发与验收都不跑——
        # 一趟的调用数因此只是持轮者那一趟的数（上界在 `--max-steps` 上），多样本才花得起。
        U=$(node tools/scenario/board-node.ts usage "$W")
        printf '%s\t%s\t%s\t—\t—\t—\t—\t—\t—\t—\t%s\t只到门口\n' "$name" "$run" "$GATE" "$U" >> "$OUT/ledger.tsv"
        printf '（%s 第 %s 趟：停在门口——派发与验收没跑 · 上界 %s · 账 %s）\n' "$name" "$run" "$MAX" "$U"
        return
      fi
      FX "$W" --json round go > "$D/go.json" 2> "$D/go.err"
      if [ "$LIVE" = yes ]; then
        FX "$W" --json --report --metrics round work --live --max-steps "$MAX" $WD > "$D/work.json" 2> "$D/work.err"
      else
        FX "$W" --json --report --metrics round work --max-steps "$MAX" > "$D/work.json" 2> "$D/work.err"
      fi
    else
      GATE=退回
      printf '（%s 第 %s 趟：门退回了（上界 %s），放行与接着跑那两段没有东西可量）\n' "$name" "$run" "$MAX"
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
  # **这一趟的围栏**（第十五趟那条缝的封口）：真档里每一格第一次起子进程时记一条
  # `run/confined`。不是 `full` 就是"子进程读得到 $OUT 这本账"——那一趟的数字不当证据。
  # **`—` 只留给真的一个子进程都没有那一档**：有子进程而一条记录都没有（那份账早于这个
  # 事件）读出来的是 `缺：…`，走 `*` 那一支当场红——第十九趟照出来的那处静默正是两半原先
  # 都以 `—` 开头，于是一份漏出去的账按"不适用"放过了。数字照印在账上（它们是读数），
  # 而"不当证据"由这一行下面恒印的「围栏：」那一行说。
  if [ "$LIVE" = yes ]; then
    FENCE=$(node tools/scenario/board-node.ts fence "$W" 2> /dev/null)
    case "$FENCE" in
      full*) ok "$name 第 $run 趟：围栏 full——子进程够不到账本与答案纸" ;;
      —*) ok "$name 第 $run 趟：这一趟没有子进程（围栏那一栏不适用）" ;;
      *) bad "$name 第 $run 趟：这一趟的围栏是「$FENCE」——那一档里子进程读得到 $OUT，读数不当证据" ;;
    esac
    if [ "$DUMP" = yes ] && grep -rqF "$CANARY" "$D" 2> /dev/null; then
      bad "$name 第 $run 趟：实录里出现了账本那枚记号（$CANARY）——助手翻到了 $OUT"
    fi
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

echo "=== 样本盘：$CASES（$([ "$LIVE" = yes ] && echo 真档 || echo 打桩档) · 每案 $RUNS 趟$([ -n "$MAXOVERRIDE" ] && echo " · 上界覆盖 $MAXOVERRIDE"）)==="
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
if [ "$GATE_ONLY" = yes ]; then
  # **门那一条读数单独报**：分母是"能进门的案"（人拆那一案这一档跳过），与派发之后分开。
  TAB=$(printf '\t')
  AT=$(grep -c '停在门口' "$OUT/ledger.tsv" || true)
  BACK=$(grep -c "${TAB}退回${TAB}" "$OUT/ledger.tsv" || true)
  printf '门：停在门口 %s 趟 · 退回 %s 趟\n' "$AT" "$BACK"
fi
printf '机制：PASS %s · FAIL %s\n' "$MACH_PASS" "$MACH_FAIL"
[ "$MACH_FAIL" = "0" ] || exit 1
exit 0
