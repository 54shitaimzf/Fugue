#!/bin/sh
# S9 那三条路的**真档取证**（便宜档）：讨论态说一句 → `round plan`（持轮者自己拆）→ 预备态说一句。
#
# 为什么单开一份、而不是 `sh tools/walkthrough-s9.sh --live`：走查整支换真模型要跑 § 二 那四段各
# 一次真调用，**还要跑 § 五 那一整轮**（多格 × 最多 6 步），而 § 五 的断言是夹具档的定值（真模型
# 跑出来的产物内容不一定逐字节相同）——那一趟既贵，红了也不说明产品坏了。这一份只走**三条最不
# 确定的路**，并把账摊开：调用条数 · 四个用量数 · 停因 · 落地条数 · 版本那一栏。
#
# 它量的是走查头注里那一句"真档那一支的不变量"，**不是夹具档的定值**：
#
#   一 · 每条路都收得住（rc ≤ 1）并说得出收工那一句；
#   二 · **版本那一栏跟着日志走**——这一趟落了地（`holder/distill` 多了一条）就印得出「版本：第 N 版」，
#        没落地就印得出"没落地"的理由（退回/停在门口）。**两条都要在**才叫"这一栏没骗人"。
#   三 · 讨论不落地：① 之后这一轮的处境照旧 Idle。
#
# **实录（三次）**：真模型在 `round plan` 那一趟**走的是"问人"那一条**——它先探路（`bash ls` 在预备态
# 被拒：「这一格没有可执行的树」），再问 `ask_user_question`（「这份 notes.md 想要的是什么？」），
# 而**"有工具叫停就到这儿为止"**（`runtime/step.ts` 那一档：它与模型自己说完同归"收敛"）。于是这一趟
# 没有草案、没有落地，判按「构造器不猜」退回。`--dump-wire` 那一趟的三次调用是这么走的：
# ① `bash ls -la` + `glob **/*.md`（bash 被拒）→ ② `read AGENTS.md` + `glob **/*` → ③ `ask_user_question`。
# 所以这不是"模型偷懒"，是**「人答→续跑」那条路还没落地**（PLAN § 5.19 明列的那一条）在真档下的样子。
# 两个旋钮是为了把这条结论钉死：`SEED_STRICT=1` 把"交付物是那个文件"明写进方针（还是问人）；
# `SEED_FILES=1` 给靶子塞进两三个可读的文件（让「写一份 notes.md」有东西可凝，看它落不落地）。
#
# 跑法：cd ~/fugue && sh tools/probe-live-s9.sh          （要凭据 · 花钱：**不给上界**，走到模型自己收敛）
#       MAX=6 sh tools/probe-live-s9.sh                   （给个上界，约 ≤ 6×2 + 2 次调用）
#       SEED_STRICT=1 MAX=6 sh tools/probe-live-s9.sh     （方针里明写交付物那个文件）
#       SEED_FILES=1 MAX=6 sh tools/probe-live-s9.sh      （靶子里有东西可读）
#       KEEP=1 sh tools/probe-live-s9.sh                  （留下现场）
# 退出码 0 且 FAIL 0 才算三条路都收得住。**取证用，不是产品的一部分**（仓库约定 § 七）。
set -u
cd /home/ubuntu/fugue || exit 9
MAX=${MAX:-}
W=$(mktemp -d /tmp/fugue-live-s9-XXXXXX)
T=$(mktemp -d /tmp/fugue-live-s9-out-XXXXXX)
PASS=0
FAIL=0
N=0
RC=0
L0=0
L1=0
F() { node src/cli/fugue.ts --root "$W" "$@"; }
# 走上界的写法**只在给了 `MAX` 时**才带：不给上界才是产品缺省（`--max-steps` 那一栏的说明：
# 「不给就是不设上界」）。给了就压到那个数——它是**花钱的上界**，压住才敢重跑。
FMAX() { if [ -n "$MAX" ]; then F "$@" --live --max-steps "$MAX"; else F "$@" --live; fi; }

cleanup() {
  for a in $(git -C "$W" for-each-ref --format='%(refname:short)' refs/heads/agent 2> /dev/null); do
    F --agent "$a" dispose > /dev/null 2>&1
  done
  if [ "${KEEP:-0}" = "1" ]; then
    printf '（KEEP=1，现场留着：靶子 %s · 读数 %s）\n' "$W" "$T"
  else
    rm -rf "$W" "$T"
  fi
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
has() { if grep -q "$2" "$1"; then ok "$3"; else bad "$3"; fi }
atmost() { if [ "$2" -le 1 ]; then ok "$1：rc=$2（≤ 1）"; else bad "$1：rc=$2 不在 0/1 之内"; fi }

# 这一轮当下的处境（从 `round/state` 链重放：与产品同一处口径）。
state() {
  node -e '
const fs = require("fs");
const p = process.argv[1] + "/.fugue/log/round.jsonl";
if (!fs.existsSync(p)) { process.stdout.write("Idle"); process.exit(0); }
const rows = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
let s = "Idle";
for (const r of rows) {
  const e = r.e ?? r;
  if (e.t === "round/state") s = e.to;
}
process.stdout.write(s);
' "$W"
}

# 这一轮在日志里落过几版（`holder/distill` 的条数）——**版本那一栏的同一处源头**。
# **日志还没生出来时是 0**（第一趟之前那一问：`round.jsonl` 那一刻还不存在，不是错）。
landings() {
  node -e '
const fs = require("fs");
const p = process.argv[1] + "/.fugue/log/round.jsonl";
if (!fs.existsSync(p)) { process.stdout.write("0"); process.exit(0); }
const rows = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
let n = 0;
for (const r of rows) {
  const e = r.e ?? r;
  if (e.t === "holder/distill" && e.round === "r1") n += 1;
}
process.stdout.write(String(n));
' "$W"
}

# 账：`llm/call` 几条 + 四个用量数（**从日志重算**，不采集）。累积读数——每一段印的是到那一刻为止。
ledger() {
  node -e '
const fs = require("fs");
const p = process.argv[1] + "/.fugue/log/round.jsonl";
if (!fs.existsSync(p)) { process.stdout.write("0\t0\t0\t0\t0"); process.exit(0); }
const rows = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
let calls = 0, input = 0, read = 0, write = 0, output = 0;
for (const r of rows) {
  const e = r.e ?? r;
  if (e.t !== "llm/call") continue;
  calls += 1;
  const u = e.usage ?? {};
  input += u.inputTokens ?? 0;
  read += u.cacheReadTokens ?? 0;
  write += u.cacheWriteTokens ?? 0;
  output += u.outputTokens ?? 0;
}
process.stdout.write(calls + "\t" + input + "\t" + read + "\t" + write + "\t" + output);
' "$W"
}
ledger_line() {
  l=$(ledger)
  printf 'llm/call %s 条 · input %s · cacheRead %s · cacheWrite %s · output %s' \
    "$(printf %s "$l" | cut -f1)" "$(printf %s "$l" | cut -f2)" "$(printf %s "$l" | cut -f3)" \
    "$(printf %s "$l" | cut -f4)" "$(printf %s "$l" | cut -f5)"
}

if [ -n "$MAX" ]; then CEIL="上界 $MAX 步/段"; else CEIL="不给上界（产品缺省）"; fi
if [ -n "${SEED_STRICT:-}" ]; then SEEDNAME="写明交付物"; else SEEDNAME="缺省"; fi
if [ -n "${SEED_FILES:-}" ]; then FILESNAME="+ 靶子里有东西"; else FILESNAME=""; fi
printf '=== 一 · 靶子（一份方针 + 一个提交）· %s · 方针档 %s%s\n' "$CEIL" "$SEEDNAME" "$FILESNAME"
mkdir -p "$W/.git/info"
printf '.fugue/\n' > "$W/.git/info/exclude"
{
  printf '# 项目方针（真档取证用）\n\n- 交付物写在仓库根上；要核自己刚写的东西就直接 `cat` 它。\n- 不要列目录、不要看时间戳、不要 `pwd`。\n'
  if [ -n "${SEED_STRICT:-}" ]; then
    printf -- '- 这一次的交付物是 `.fugue/plan/r1.md`：方案要**写在那个文件里**，只在回答里说一遍不算交卷。\n'
  fi
} > "$W/AGENTS.md"
if [ -n "${SEED_FILES:-}" ]; then
  mkdir -p "$W/src" "$W/docs"
  printf '# 手记\n\n这个仓库里放着三件事：一句方针（`AGENTS.md`）· 一份说明（`README.md`）· 一小段代码\n（`src/hello.ts`）。说明里写着怎么跑，代码里那一个函数只做一件事：把一行字打出来。\n\n## 为什么只有这么点\n\n起点是空的：这一份只是为了有东西可读。\n' > "$W/README.md"
  printf 'export function hello(name: string): string {\n  return `你好，${name}`\n}\n' > "$W/src/hello.ts"
  printf '# 待办\n\n- 把 hello 的返回改成可配置的问候语。\n- README 里补一句怎么跑。\n' > "$W/docs/todo.md"
fi
printf '  # —— 靶子里的文件 ——\n'
find "$W" -path "$W/.git" -prune -o -path "$W/.fugue" -prune -o -type f -print | sed "s|^$W/|  # |"
(
  cd "$W" && git init -q . && git symbolic-ref HEAD refs/heads/main &&
    git config user.email fugue@localhost && git config user.name fugue &&
    git add -A && git commit -qm 起点
) || bad "靶子的起点提交"
F config set round.id r1 > /dev/null || bad "靶子配置：round.id"
F config set actions.ok '{"argv":["/bin/sh","-c","true"],"outputs":[]}' > /dev/null || bad "靶子配置：actions.ok"
F config set round.assertions '[{"name":"在","action":"ok"}]' > /dev/null || bad "靶子配置：round.assertions"

# 一趟：跑一条命令，把它那几行摊开，再把账与落地条数印出来。L0/L1 = 这一趟前后日志里的落地条数。
run() {
  seg=$1
  name=$2
  shift 2
  N=$((N + 1))
  OUT="$T/run-$N.out"
  echo
  printf '=== %s · %s\n' "$seg" "$name"
  L0=$(landings)
  FMAX "$@" > "$OUT" 2> "$T/run-$N.err"
  RC=$?
  L1=$(landings)
  printf '  rc = %s · 落地 %s 条（%s → %s）\n' "$RC" "$((L1 - L0))" "$L0" "$L1"
  sed 's/^/  | /' "$OUT"
  sed 's/^/  err| /' "$T/run-$N.err"
  printf '  账（累计）：%s\n' "$(ledger_line)"
}

# **版本那一栏跟着日志走**：落了地就要印得出来；没落地就要印得出理由。
# 这一条是这一份探针的主断言——它把命令行那一栏钉在日志上（两处都得对，缺一不可）。
column_follows() {
  seg=$1
  out="$T/run-$N.out"
  if [ "$L1" -gt "$L0" ]; then
    has "$out" '版本：第' "$seg 落了地（+$((L1 - L0)) 条 holder/distill），版本那一栏印得出来"
  elif grep -q '停在门口' "$out" || grep -q '退回' "$out"; then
    ok "$seg 没落地（日志里还是 $L1 条），印的是没落地的理由（退回/停在门口）"
  else
    bad "$seg 没落地，却没印出理由：既没有「版本：第」也没有「停在门口/退回」"
  fi
}

# ① 讨论态：说一句 → 那句话进会话记录，那一趟落下修正后的理解（处境不动）。
run ① '讨论态 say（Idle）' say '第一节也要拆'
atmost '①' "$RC"
has "$T/run-1.out" '收工：' '① 那一趟报出了收工那一句'
has "$T/run-1.out" '这一态的处境没动：Idle' '① 讨论不落地（处境照旧 Idle）'
column_follows '①'

# ③ 持轮者自己拆：读 → 设计 → 写草案 → 交卷（走上界到顶也算收得住）。
run ③ 'round plan（持轮者自己拆）' round plan '写一份 notes.md'
atmost '③' "$RC"
has "$T/run-2.out" '收工：' '③ 那一趟报出了收工那一句'
if grep -q '停在门口' "$T/run-2.out" || grep -q '退回' "$T/run-2.out"; then
  ok '③ 进了判（停在门口或退回）'
else
  bad '③ 没进判：打印里既没有「停在门口」也没有「退回」'
fi
column_follows '③'
printf '  ③ 之后处境：%s\n' "$(state)"

# ⑤ 预备态：**只在 ③ 把这一轮留在预备态时走**（没留在预备态就没有这一段可走）。
if [ "$(state)" = "Planning" ]; then
  run ⑤ '预备态 say（改草案 · 重判）' say '为什么这么拆再写清楚一点'
  atmost '⑤' "$RC"
  has "$T/run-3.out" '收工：' '⑤ 那一趟报出了收工那一句'
  column_follows '⑤'
else
  printf '\n=== ⑤ 跳过：③ 之后这一轮不在预备态（%s）\n' "$(state)"
fi

echo
echo '==== 摊开（写进提交信息的那几行）'
for i in $(seq 1 "$N"); do
  printf '  第 %s 段：%s\n' "$i" "$(grep -m1 '收工：' "$T/run-$i.out" | sed 's/^ *//')"
  grep -m1 '版本：第' "$T/run-$i.out" | sed 's/^ */             /'
done
printf '  合计：%s\n' "$(ledger_line)"
printf '  最后处境：%s · 日志里落地 %s 条\n' "$(state)" "$(landings)"
printf 'PASS %s · FAIL %s\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ] || exit 1
exit 0
