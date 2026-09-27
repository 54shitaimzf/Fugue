#!/bin/sh
# S4 的走查（PLAN § 5.4 的 X5 行 · 架构 § 20 的 S4 那一节）。
#
# **一条命令跑完**：建仓库 → 定 base → 四条分支头 → 四路 `fork` → 各写各的 → 四路 `run build`
# → 四路 `run test` → 再逐个串行跑一遍 → 并行与串行逐字节一致 → 未声明的写入被拒并记事件
# → 地板：`bwrap` 从 PATH 上拿掉之后再跑一趟 → `dispose` → 收尾不留挂载、不留进程、不留端口。
#
# 夹具是一个**真在编译、真在跑**的小工程：`src/msg.h` 里那一句是每个 agent 自己写的，
# `build` 用 `cc` 把它编成 `dist/app`，`test` 跑那个可执行文件、比它打出来的那一句与头文件里
# 的一致，再把结论写进 `dist/test.log`。两个动作各有声明，所以这一趟也把回收的两半都走了一遍。
#
# 判据的分工：**"N 路并发与串行逐字节一致"这条性质在 X3 的断言里已经逐事件比过**（四路并发
# 一趟 · 逐个串行一趟，`mat/*` 与 `run/*` 逐条相同，`ms` 不比）；走查这一份比的是**同一批
# agent 两次的产物字节与退出码**——它是可用性的材料（§ 4.1 第二档），不是那条性质的第二次判决。
#
# **这台机器按 `overlayfs` 档走**（E2 的地板）。要是 `fork` 退到了 `hardlink-ro`/`copy`，第六节
# 那条"树可写"档会当场被拒（树可写而没有 `upper` 可枚举——`ReclaimRefused`，X4 记下的边界：
# 两条地板叠在一起的现场不在这一站的范围里），那时走查会红在那里，那是**读数**，不是回归。
#
# 跑法（在 ext4 上 · 仓库根）：sh tools/walkthrough-s4.sh
# `KEEP=1` 把工作区留下；`FUGUE=<path>` 换实现（默认仓库里那个命令行）。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FUGUE=${FUGUE:-$ROOT/src/cli/fugue.ts}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fugue-s4-XXXXXX")
OUT=$(mktemp -d "${TMPDIR:-/tmp}/fugue-s4-out-XXXXXX")
FAIL=0
AGENTS='agent/r1/1 agent/r1/2 agent/r1/3 agent/r1/4'

fugue() { node "$FUGUE" --root "$WORK" "$@"; }

run() {
  printf '\n$ %s\n' "$*"
  "$@"
  printf '[退出码 %s]\n' "$?"
}

check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s：%s\n' "$1" "$2"
  else
    printf '  FAIL %s（期望 %s，实得 %s）\n' "$1" "$3" "$2"
    FAIL=$((FAIL + 1))
  fi
}

# 从一份 --json 的输出里取一个字段（本脚本不引 jq：node 本来就在）。
jget() {
  node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=o;for(const k of process.argv[2].split("."))v=v==null?undefined:v[k];process.stdout.write(v==null?"":String(v))' "$1" "$2"
}

label() { printf '%s' "$1" | tr '/' '-'; }
leaf() { printf '%s/.fugue/mat/%s' "$WORK" "$1"; }
merged_of() { printf '%s/merged' "$(leaf "$1")"; }
cache_of() { printf '%s/cache' "$(leaf "$1")"; }
upper_of() { printf '%s/upper' "$(leaf "$1")"; }

# 一份 --json 的输出落一个文件；**打印与返回的都是那条命令的退出码**（打印给人看，返回给 `par`）。
json_run() { # json_run <out 文件> <args…>
  out=$1
  shift
  node "$FUGUE" --root "$WORK" --json "$@" >"$out" 2>"$out.err"
  c=$?
  printf '%s' "$c"
  return "$c"
}

is_mounted() { awk '{print $2}' /proc/self/mounts | grep -qx "$1"; }
mountcount() { awk '{print $2}' /proc/self/mounts | grep -c "^$WORK/" || true; }

# 某个 agent 的某一类事件，一行一条 JSON（读 `fugue --json log` 那串全序列）。
events_of() { # events_of <agent> <t>
  node -e '
    const fs = require("fs")
    for (const l of fs.readFileSync(0, "utf8").trim().split("\n")) {
      if (!l) continue
      const e = JSON.parse(l).e
      if (e.agent === process.argv[1] && e.t === process.argv[2]) console.log(JSON.stringify(e))
    }
  ' "$1" "$2"
}
count_of() { fugue --json log | events_of "$1" "$2" | wc -l | tr -d ' '; }
# 某个 agent 在一条路径上最后一次写进视图的那个 blob。
lastblob() {
  fugue --json log | node -e '
    const fs = require("fs")
    let last = ""
    for (const l of fs.readFileSync(0, "utf8").trim().split("\n")) {
      if (!l) continue
      const e = JSON.parse(l).e
      if (e.t === "view/write" && e.agent === process.argv[1] && e.path === process.argv[2]) last = e.blob
    }
    process.stdout.write(last)
  ' "$1" "$2"
}
# 某个 agent 最后一条 run/confined 报出来的档：<mode>/<enforcement>。
lastconfined() {
  fugue --json log | node -e '
    const fs = require("fs")
    let last = ""
    for (const l of fs.readFileSync(0, "utf8").trim().split("\n")) {
      if (!l) continue
      const e = JSON.parse(l).e
      if (e.t === "run/confined" && e.agent === process.argv[1]) last = e.mode + "/" + e.enforcement
    }
    process.stdout.write(last)
  ' "$1"
}
# 还有谁挂在这个工作区上（走查自己不算）。
leftprocs() {
  ps -eo args= | grep -F -- "$WORK" | grep -v 'walkthrough-s4' | grep -v 'grep -F' | wc -l | tr -d ' '
}
# 四条端口片里还有人在听吗（这一段夹具里没人 listen，所以它照例读到 0——真要有残留，
# 得是动作自己 fork 出去的东西；S4 里没有那个东西）。
portbusy() {
  ss -ltn 2>/dev/null | awk 'NR > 1 {print $4}' | grep -cE ':(31000|31004|31008|31012)$' || true
}

# 四路并发：每个 agent 一路，后台跑，**退出码落进一个文件**（`par` 里的函数要把真码返回出来）。
par() {
  phase=$1
  fn=$2
  for a in $AGENTS; do
    lbl=$(label "$a")
    ( "$fn" "$a" >"$OUT/$phase-$lbl.out" 2>"$OUT/$phase-$lbl.err"; echo $? >"$OUT/$phase-$lbl.code" ) &
  done
  wait
}

# 每个 agent 自己那一句：**同一个 printf 写进视图，也写进下面比对的期望里**。
msg_body() { printf '#define MSG "%s"\n' "$1"; }
own_body() { printf 'own %s\n' "$1"; }

# ── 一 · 建仓库 ────────────────────────────────────────────────────────────
printf '走查 · S4（隔离执行：每个分支真正能跑构建与测试）· 工作区 %s\n' "$WORK"
printf '文件系统 %s · %s · %s\n' "$(df -T "$WORK" | awk 'NR == 2 {print $2}')" "$(node -v)" "$(git --version)"

cd "$WORK" || exit 1
mkdir -p src
msg_body base > src/msg.h
cat > src/a.c <<'C'
#include <stdio.h>
#include "msg.h"
int main(void) {
  printf("%s\n", MSG);
  return 0;
}
C
cat > build.mjs <<'JS'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
execFileSync('cc', ['-o', 'dist/app', 'src/a.c'])
console.log('build ok')
JS
cat > test.mjs <<'JS'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const want = /MSG "([^"]*)"/.exec(readFileSync('src/msg.h', 'utf8'))[1]
const got = execFileSync('./dist/app', { encoding: 'utf8' }).trim()
if (got !== want) {
  console.error(`不等：产物打出 ${got}，头文件里要的是 ${want}`)
  process.exit(1)
}
writeFileSync('dist/test.log', `ok ${want}\n`)
console.log(`test ok · ${got}`)
JS
cat > dirty.mjs <<'JS'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
execFileSync('cc', ['-o', 'dist/app', 'src/a.c'])
writeFileSync('junk.txt', 'undeclared\n')
console.log('dirty ok')
JS
printf '# 走查用的工程\n' > README.md
run git init -q -b main .
run git add -A
git -c user.email=f@l -c user.name=f commit -qm 起点
BASE=$(git -C "$WORK" rev-parse HEAD)
printf '\n基线提交 %s\n' "$BASE"

fugue config set actions.build '{"argv":["node","build.mjs"],"cache":["dist"],"outputs":["dist/app"]}' >/dev/null
fugue config set actions.test '{"argv":["node","test.mjs"],"cache":["dist"],"outputs":["dist/test.log"]}' >/dev/null
fugue config set actions.dirty '{"argv":["node","dirty.mjs"],"cache":["dist"]}' >/dev/null
printf '三个动作：build（产出 dist/app）· test（产出 dist/test.log）· dirty（不声明产出，往树里写 junk.txt）\n'

# ── 二 · 四条分支头 + 四路并发 fork ────────────────────────────────────────
printf '\n══ 一 · 四条分支头定在同一个 base 上，四路并发 fork ══\n'
for a in $AGENTS; do
  RC=$(json_run "$OUT/branch-$(label "$a").json" --agent "$a" branch "$BASE")
  check "$a · branch 退码" "$RC" "0"
done
do_fork() { json_run "$OUT/fork-$(label "$1").json" --agent "$1" fork "$BASE" >/dev/null; }
par fork do_fork
STRATEGY=''
for a in $AGENTS; do
  lbl=$(label "$a")
  check "$a · fork 退码" "$(cat "$OUT/fork-$lbl.code")" "0"
  M=$(jget "$OUT/fork-$lbl.json" merged)
  check "$a · 合并树在" "$([ -d "$M" ] && echo 在 || echo 不在)" "在"
  if [ "$a" = "agent/r1/1" ]; then STRATEGY=$(jget "$OUT/fork-$lbl.json" strategy); fi
  if is_mounted "$M"; then MOUNT=挂着; else MOUNT=没挂; fi
  printf '  %s · %s 档 · %s\n' "$a" "$(jget "$OUT/fork-$lbl.json" strategy)" "$MOUNT"
done

# ── 三 · 各写各的 ─────────────────────────────────────────────────────────
printf '\n══ 二 · 各写各的：每人改自己那一句，另加一条自己的文件 ══\n'
do_ops() {
  a=$1
  lbl=$(label "$a")
  msg_body "$lbl" | node "$FUGUE" --root "$WORK" --agent "$a" write src/msg.h --stdin || return 1
  own_body "$lbl" | node "$FUGUE" --root "$WORK" --agent "$a" write "own/$lbl.txt" --stdin || return 1
  return 0
}
par ops do_ops
for a in $AGENTS; do
  lbl=$(label "$a")
  check "$a · 两条写入退码" "$(cat "$OUT/ops-$lbl.code")" "0"
  node "$FUGUE" --root "$WORK" --agent "$a" read src/msg.h >"$OUT/read-$lbl.txt" 2>/dev/null
  check "$a · 视图里那一句是自己写的" "$(cat "$OUT/read-$lbl.txt")" "$(msg_body "$lbl")"
  if [ "$a" != "agent/r1/1" ]; then
    check "$a · 看不见 1 号那句" "$(grep -c 'agent-r1-1' "$OUT/read-$lbl.txt" || true)" "0"
  fi
done

# ── 四 · 四路并发：先 build 再 test ────────────────────────────────────────
printf '\n══ 三 · 四路并发 run build，然后四路并发 run test ══\n'
do_build() { json_run "$OUT/p1-build-$(label "$1").json" --agent "$1" run build >/dev/null; }
do_test() { json_run "$OUT/p1-test-$(label "$1").json" --agent "$1" run test >/dev/null; }
par p1build do_build
par p1test do_test
for a in $AGENTS; do
  lbl=$(label "$a")
  check "$a · build 退码" "$(cat "$OUT/p1build-$lbl.code")" "0"
  check "$a · test 退码" "$(cat "$OUT/p1test-$lbl.code")" "0"
  check "$a · build 报的是 full 档" "$(jget "$OUT/p1-build-$lbl.json" enforcement)" "full"
  check "$a · build 收回了 dist/app" "$(jget "$OUT/p1-build-$lbl.json" reclaimed)" "dist/app"
  check "$a · test 收回了 dist/test.log" "$(jget "$OUT/p1-test-$lbl.json" reclaimed)" "dist/test.log"
  check "$a · test 的日志内容" "$(cat "$(cache_of "$a")/dist/test.log")" "$(printf 'ok %s' "$lbl")"
  cp "$(cache_of "$a")/dist/app" "$OUT/A-$lbl-app"
  cp "$(cache_of "$a")/dist/test.log" "$OUT/A-$lbl-test.log"
  printf '  %s · build %s ms · test %s ms · 端口 %s\n' "$a" \
    "$(jget "$OUT/p1-build-$lbl.json" ms)" "$(jget "$OUT/p1-test-$lbl.json" ms)" "$(jget "$OUT/p1-build-$lbl.json" port)"
done

# ── 五 · 逐个串行再跑一遍 ─────────────────────────────────────────────────
printf '\n══ 四 · 同一批 agent 逐个串行再跑一遍（build + test）══\n'
for a in $AGENTS; do
  lbl=$(label "$a")
  RC=$(json_run "$OUT/p2-build-$lbl.json" --agent "$a" run build)
  printf '%s' "$RC" >"$OUT/p2-build-$lbl.code"
  check "$a · 串行 build 退码" "$RC" "0"
  RC=$(json_run "$OUT/p2-test-$lbl.json" --agent "$a" run test)
  printf '%s' "$RC" >"$OUT/p2-test-$lbl.code"
  check "$a · 串行 test 退码" "$RC" "0"
done

printf '\n══ 五 · 并行一趟与串行一趟：同一批 agent，产物逐字节相同 ══\n'
for a in $AGENTS; do
  lbl=$(label "$a")
  C=$(cache_of "$a")
  check "$a · 两趟 build 退出码相同" "$(cat "$OUT/p2-build-$lbl.code")" "$(cat "$OUT/p1build-$lbl.code")"
  check "$a · 两趟 test 退出码相同" "$(cat "$OUT/p2-test-$lbl.code")" "$(cat "$OUT/p1test-$lbl.code")"
  check "$a · dist/app 逐字节相同" "$(cmp -s "$C/dist/app" "$OUT/A-$lbl-app" && echo 相同 || echo 不同)" "相同"
  check "$a · dist/test.log 逐字节相同" "$(cmp -s "$C/dist/test.log" "$OUT/A-$lbl-test.log" && echo 相同 || echo 不同)" "相同"
  printf '  %s · 视图里 dist/app 的 blob %s\n' "$a" "$(lastblob "$a" dist/app | cut -c1-12)"
done
BL=$(for a in $AGENTS; do lastblob "$a" dist/app; printf "\n"; done)
check "四个 agent 的产物两两不同（各写各的那一句真进了产物）" \
  "$(printf '%s\n' $BL | sort -u | wc -l | tr -d ' ')" "4"
printf '  （同一批 agent 的两次逐字节相同是断言；**跨 agent 的字节不作为断言**——带 -g 的二进制里会'
printf '进物化树路径，X3 记过这条口径。这里的四个 blob 两两不同，是"各写各的"那条读数）\n'

# ── 六 · 未声明的写入：默认档由内核拒 · 树可写那一档由回收拒并记事件 ─────────
#
# **这一节量的是"树敞不敞开"那一维，不是"有没有挂载层"那一维**：`--mode workspace-write`
# 今天两层都在场（挂载层把树整个绑成可写），所以未声明的写入内核不拒、由回收如实报出来；
# 真正"挂载层不在"那一档在第七节（`partial` + 第二层接过来）。
printf '\n══ 六 · 第三条验证的现场：未声明的写入被拒并记事件 ══\n'
A1=agent/r1/1
RC=$(json_run "$OUT/dirty-default.json" --agent "$A1" run dirty)
check "默认档 · dirty 退码（子进程没成功）" "$RC" "1"
check "默认档 · denied 读出来了" "$(jget "$OUT/dirty-default.json" denied)" "true"
check "默认档 · 树里没有 junk.txt" "$([ -e "$(upper_of "$A1")/junk.txt" ] && echo 有 || echo 没有)" "没有"
check "默认档 · 没有 mat/reclaim" "$(count_of "$A1" mat/reclaim)" "0"
RC=$(json_run "$OUT/dirty-deg.json" --agent "$A1" run dirty --mode workspace-write)
check "树可写那一档 · dirty 退码（子进程成功了）" "$RC" "0"
check "树可写那一档 · enforcement 如实报 full（两层都在场）" "$(jget "$OUT/dirty-deg.json" enforcement)" "full"
check "树可写那一档 · undeclared" "$(jget "$OUT/dirty-deg.json" undeclared)" "junk.txt"
check "树可写那一档 · junk.txt 真写下去了" "$(cat "$(upper_of "$A1")/junk.txt" 2>/dev/null)" "undeclared"
check "树可写那一档 · 正好一条 mat/reclaim" "$(count_of "$A1" mat/reclaim)" "1"
check "树可写那一档 · 视图里读不到 junk.txt" "$(node "$FUGUE" --root "$WORK" --agent "$A1" read junk.txt >/dev/null 2>&1; echo $?)" "1"

# ── 七 · 地板：把 bwrap 从 PATH 上拿掉 ─────────────────────────────────────
printf '\n══ 七 · 地板：bwrap 从 PATH 上拿掉——第二层接过来，同一趟照样跑得出同一份声明集 ══\n'
BIN=$(mktemp -d "$OUT/bin-XXXXXX")
for d in /usr/bin /usr/local/bin; do
  for n in "$d"/*; do
    b=$(basename "$n")
    if [ "$b" = bwrap ]; then continue; fi
    if [ ! -e "$BIN/$b" ]; then ln -s "$n" "$BIN/$b" 2>/dev/null || true; fi
  done
done
if [ -e "$BIN/bwrap" ]; then
  check "镜像 PATH 里没有 bwrap" "有" "没有"
else
  printf '  ok   镜像 PATH 里没有 bwrap（%s 条，其余照旧）\n' "$(ls "$BIN" | wc -l | tr -d ' ')"
fi
BLOB_BEFORE=$(lastblob "$A1" dist/app)
env PATH="$BIN" node "$FUGUE" --root "$WORK" --json --agent "$A1" run build >"$OUT/floor.json" 2>"$OUT/floor.err"
RC=$?
check "地板 · run build 退码" "$RC" "0"
check "地板 · 如实报 partial" "$(jget "$OUT/floor.json" enforcement)" "partial"
# **Y6 起这一档降一档而不是降到底**：`bwrap` 不在，第二层（Landlock）接过来——`mechanism` 报的
# 是它，`mode` 报 `read-only`（它管着"写得动什么"那一维，所以树不可写），产出照旧收得回来。
# 两层都不在时才是 X4 原样那一档（`mechanism: none` · 树可写 + 回收兜底）。
check "地板 · 机制报 landlock（第二层接过来）" "$(jget "$OUT/floor.json" mechanism)" "landlock"
check "地板 · 档如实报 read-only（树不可写）" "$(jget "$OUT/floor.json" mode)" "read-only"
check "地板 · 自己探出来沙箱不在" "$(jget "$OUT/floor.json" sandbox)" "false"
check "地板 · 声明集内的产出照样收得回来" "$(jget "$OUT/floor.json" reclaimed)" "dist/app"
check "地板 · 收进视图的那一条与全档同一份" "$(lastblob "$A1" dist/app)" "$BLOB_BEFORE"
check "地板 · 树上那一份与全档逐字节相同" "$(cmp -s "$(upper_of "$A1")/dist/app" "$OUT/A-$(label "$A1")-app" && echo 相同 || echo 不同)" "相同"
printf '  这一档的落点是树自己那一侧：%s\n' "$([ -e "$(upper_of "$A1")/dist/app" ] && echo 'upper/dist/app 在（全档那一趟它不在）' || echo '还没落下来')"

# ── 八 · dispose 与收尾 ───────────────────────────────────────────────────
printf '\n══ 八 · dispose 四个，收尾不留挂载 · 不留进程 · 不留端口 ══\n'
for a in $AGENTS; do
  RC=$(json_run "$OUT/dispose-$(label "$a").json" --agent "$a" dispose)
  check "$a · dispose 退码" "$RC" "0"
  check "$a · 物化根跟着走" "$([ -e "$(leaf "$a")" ] && echo 还在 || echo 走了)" "走了"
done
check "挂载表里一条都不剩" "$(mountcount)" "0"
FILES=$(find "$WORK/.fugue/mat" -type f 2>/dev/null | wc -l | tr -d ' ')
check "mat 底下不留一个文件" "$FILES" "0"
check "没有残留进程" "$(leftprocs)" "0"
check "四条端口片没人听" "$(portbusy)" "0"

# ── 九 · 读数并列 ─────────────────────────────────────────────────────────
printf '\n══ 读数并列 ══\n'
printf '  %-12s %-11s %8s %8s %-18s %-6s %s\n' agent 档 'build ms' 'test ms' 那一趟的档 端口 'dist/app 的 blob'
for a in $AGENTS; do
  lbl=$(label "$a")
  printf '  %-12s %-11s %8s %8s %-18s %-6s %s\n' "$a" "$STRATEGY" \
    "$(jget "$OUT/p1-build-$lbl.json" ms)" "$(jget "$OUT/p1-test-$lbl.json" ms)" \
    "$(jget "$OUT/p1-build-$lbl.json" mode)/$(jget "$OUT/p1-build-$lbl.json" enforcement)" \
    "$(jget "$OUT/p1-build-$lbl.json" port)" "$(lastblob "$a" dist/app | cut -c1-12)"
done
printf '  （四路的端口片两两不同；四个 agent 的物化树各自独立，收尾时一个挂载都不剩）\n'

if [ "${KEEP:-0}" = "1" ]; then
  printf '\n工作区留在 %s（读数在 %s · 镜像 PATH 在 %s）\n' "$WORK" "$OUT" "$BIN"
else
  cd / || exit 1
  for w in $(awk '{print $2}' /proc/self/mounts | grep "^$WORK/" || true); do
    sudo -n umount -l "$w" 2>/dev/null || umount -l "$w" 2>/dev/null || true
  done
  chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf "$WORK" "$OUT"
fi
printf '\n%s\n' "$([ "$FAIL" = 0 ] && echo '走查全部通过' || echo "$FAIL 项不通过")"
exit "$([ "$FAIL" = 0 ] && echo 0 || echo 1)"
