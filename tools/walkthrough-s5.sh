#!/bin/sh
# S5 的走查（PLAN § 5.5 的 Y7 行 · 架构 § 20 的 S5 那一节）。
#
# **一条命令跑完**：建仓库 → 定 base → `fork` → `fugue policy` 三栏读数 → 正对照（真编译 + 真测试
# 在沙箱里跑得出）→ 一个"想逃逸"的动作每类一条（全部被拒，能指路的把指路那句话也印出来）→
# 地板一（`bwrap` 不在 → Landlock 接过"写得动什么"：未声明的写入当场拒）→ 地板底（两层都不在 →
# 树可写 + 回收兜底）→ `dispose` → 收尾不留挂载、不留进程、不留端口。
#
# 判据的分工：**机制那一半在 Y1–Y6 的断言里已经逐条比过**（逃逸用例集 19 条 · 策略值两处逐字
# 相等 · 启动前的三条拒绝 · 网络的三个读数 · 两层的地板）。走查这一份问的是可用性（§ 4.1 第二
# 档）：**这条命令今天拿在一个真工作区上跑，跑得起来吗、外面够得着吗**。所以它每类只取一条代表，
# 印的是读数本身。
#
# **点名要网那一档不在这里连公网**：那要看这台机器有没有出口，走查就成了一份机器的读数。它在这里
# 只读策略值那一栏（`want-net`），行为读数在 Y5 的断言 ②（同一个宿主服务端、两个答案，不依赖出口）。
# 「要网那一档按域名解得出地址」那一条同样是机器相关的（它要出口），门在 `src/boundary/net.test.ts`。
#
# 跑法（在 ext4 上 · 仓库根）：sh tools/walkthrough-s5.sh
# `KEEP=1` 把工作区留下；`FUGUE=<path>` 换实现（默认仓库里那个命令行）。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FUGUE=${FUGUE:-$ROOT/src/cli/fugue.ts}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fugue-s5-XXXXXX")
OUT=$(mktemp -d "${TMPDIR:-/tmp}/fugue-s5-out-XXXXXX")
FAIL=0
AGENT=agent/r1/1
OTHER=agent/r1/2

fugue() { node "$FUGUE" --root "$WORK" "$@"; }

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

leaf() { printf '%s/.fugue/mat/%s' "$WORK" "$1"; }
merged_of() { printf '%s/merged' "$(leaf "$1")"; }
upper_of() { printf '%s/upper' "$(leaf "$1")" ; }
cache_of() { printf '%s/cache' "$(leaf "$1")"; }

# 一份 --json 的输出落一个文件；**打印与返回的都是那条命令的退出码**。
json_run() { # json_run <out 文件> <args…>
  out=$1
  shift
  node "$FUGUE" --root "$WORK" --json "$@" >"$out" 2>"$out.err"
  c=$?
  printf '%s' "$c"
  return "$c"
}

# 子进程那一侧那句话：**取第一句带拒绝签名的**。
#
# 取"最后一行非空"会把读数读错——node 把栈打完还会在最后印一行版本号（实测那一行是
# `Node.js v24.21.0`，而真正的读数在它上面几行）；命令面自己那一行总结（`退出码 …`）也在这份
# 文件里。没有签名的那种（够不着）退回"最后一句非空、且不是总结"。
deny_line() {
  l=$(grep -m1 -E 'EROFS|Read-only file system|Permission denied|Operation not permitted' "$1" 2>/dev/null)
  if [ -z "$l" ]; then l=$(grep -v '^$' "$1" 2>/dev/null | grep -v '^退出码 ' | tail -1); fi
  printf '%s' "$l"
}

# 一条动作在沙箱里的读数：退出码 · 子进程那一句 · 那一趟的 `denied`。
#
# **两种"不得手"要分开读**：内核当场拒（`EROFS` / `Permission denied` 那一类签名）→ `denied`
# 读得出来；清单外那条路在沙箱里**根本不存在**（报 `No such file or directory`）→ 够不着，而
# `DENY` 里故意没有 ENOENT（Y3 定的）。两者都不是"通"，但混在一起读就把"够不着"读成了"拒得下来"。
# **落点那一侧另判**（下面每一条都跟一句"树上/真源上有没有"）：子进程非零退出不等于树没被动过。
escape_reading() { # escape_reading <标签> <动作> <denied 该是 true 还是 false>
  lbl=$1
  act=$2
  want=$3
  rc=$(json_run "$OUT/esc-$lbl.json" --agent "$AGENT" run "$act")
  last=$(deny_line "$OUT/esc-$lbl.json.err")
  kind=$(jget "$OUT/esc-$lbl.json" denied)
  if [ "$kind" = "true" ]; then kind='内核当场拒'; else kind='够不着（那条路不在）'; fi
  printf '  %-12s 退 %-3s %-20s %s\n' "$lbl" "$rc" "$kind" "$last"
  check "$lbl · 子进程没成功" "$([ "$rc" != "0" ] && echo 没成功 || echo 成功了)" "没成功"
  check "$lbl · 那一趟读出来的 denied" "$(jget "$OUT/esc-$lbl.json" denied)" "$want"
}

is_mounted() { awk '{print $2}' /proc/self/mounts | grep -qx "$1"; }
mountcount() { awk '{print $2}' /proc/self/mounts | grep -c "^$WORK/" || true; }
leftprocs() {
  ps -eo args= | grep -F -- "$WORK" | grep -v 'walkthrough-s5' | grep -v 'grep -F' | wc -l | tr -d ' '
}
portbusy() {
  ss -ltn 2>/dev/null | awk 'NR > 1 {print $4}' | grep -cE ':(31000|31004)$' || true
}

# ── 一 · 建仓库与夹具 ─────────────────────────────────────────────────────
printf '走查 · S5（边界可用：跑得起来，同时够不着外面）· 工作区 %s\n' "$WORK"
printf '文件系统 %s · %s · %s\n' "$(df -T "$WORK" | awk 'NR == 2 {print $2}')" "$(node -v)" "$(git --version)"

cd "$WORK" || exit 1
mkdir -p src
printf '#define MSG "s5"\n' > src/msg.h
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
import { writeFileSync } from 'node:fs'
writeFileSync('junk.txt', 'undeclared\n')
console.log('dirty ok')
JS
printf '# 走查用的工程\n' > README.md
git init -q -b main . >/dev/null
git add -A
git -c user.email=f@l -c user.name=f commit -qm 起点
BASE=$(git rev-parse HEAD)
printf '\n基线提交 %s\n' "$BASE"

# 正对照那两条 + 六条"想逃逸"的（每类一条代表，见下面第四节的表）。
fugue config set actions.build '{"argv":["node","build.mjs"],"cache":["dist"],"outputs":["dist/app"]}' >/dev/null
fugue config set actions.test '{"argv":["node","test.mjs"],"cache":["dist"],"outputs":["dist/test.log"]}' >/dev/null
fugue config set actions.dirty '{"argv":["node","dirty.mjs"],"cache":["dist"]}' >/dev/null
# 想逃逸的那几条：**argv 的最后一步就是那次写**——否则 `sh -c` 的退出码报的是后面那句 echo，
# 读数会把"写被拒了"读成"这一趟成功了"。
fugue config set actions.tamper '{"argv":["sh","-c","echo x >> src/a.c"]}' >/dev/null
fugue config set actions.peek-host '{"argv":["cat","/etc/passwd"]}' >/dev/null
fugue config set actions.peek-truth '{"argv":["cat","'"$WORK"'/README.md"]}' >/dev/null
fugue config set actions.peek-other '{"argv":["cat","'"$WORK"'/.fugue/mat/'"$OTHER"'/merged/src/a.c"]}' >/dev/null
fugue config set actions.peek-config '{"argv":["cat","/work/.fugue/config"]}' >/dev/null
fugue config set actions.list-etc '{"argv":["ls","-a","/etc"]}' >/dev/null
fugue config set actions.escape-out '{"argv":["sh","-c","echo x > $HOME/../escaped.txt"]}' >/dev/null
fugue config set actions.badcache '{"argv":["node","build.mjs"],"cache":["../x"]}' >/dev/null
fugue config set actions.want-net '{"argv":["node","build.mjs"],"net":"host"}' >/dev/null
printf '十二个动作：build · test · list-etc（正对照）· dirty · tamper · peek-host · peek-truth · peek-other · peek-config · escape-out（想逃逸）· badcache（声明本身就是坏的）· want-net（点名要网）\n'

for a in $AGENT $OTHER; do
  fugue --agent "$a" branch "$BASE" >/dev/null || exit 1
  fugue --agent "$a" fork "$BASE" >/dev/null || exit 1
done
fugue --agent "$AGENT" ensure >/dev/null
printf '两条分支头定在同一个 base 上 · %s 的树铺好了\n' "$AGENT"

# ── 二 · 策略值：一处解析，两处读 ─────────────────────────────────────────
printf '\n══ 一 · 策略值（架构 § 8.8 的结账口：`fugue policy` 那一行）══\n'
POL=$(json_run "$OUT/policy.json" --agent "$AGENT" policy)
check "fugue policy 退码" "$POL" "0"
check "档" "$(jget "$OUT/policy.json" mode)" "read-only"
check "enforcement" "$(jget "$OUT/policy.json" enforcement)" "full"
check "在场的层" "$(jget "$OUT/policy.json" layers)" "bwrap,landlock"
check "网络那一档（没有动作点名）" "$(jget "$OUT/policy.json" net)" "none"
check "清单里只读根的条数" "$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o.reach.roRoots.length))' "$OUT/policy.json")" "6"
check "清单里的软链条数" "$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o.reach.symlinks.length))' "$OUT/policy.json")" "4"
printf '  可达集 %s\n' "$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(o.reach.roRoots.join(" · "))' "$OUT/policy.json")"
printf '  可写落点 %s\n' "$(jget "$OUT/policy.json" writableRoots)"
json_run "$OUT/policy-build.json" --agent "$AGENT" policy build >/dev/null
check "给了动作就读它那一栏（build 没点名要网）" "$(jget "$OUT/policy-build.json" net)" "none"
json_run "$OUT/policy-net.json" --agent "$AGENT" policy want-net >/dev/null
check "want-net 点名要网" "$(jget "$OUT/policy-net.json" net)" "host"
fugue --agent "$AGENT" policy | sed 's/^/  /'

# ── 三 · 正对照：正事照跑 ────────────────────────────────────────────────
printf '\n══ 二 · 正对照：真编译 + 真测试在沙箱里跑得出，产物落声明目录 ══\n'
RC=$(json_run "$OUT/build.json" --agent "$AGENT" run build)
check "run build 退码" "$RC" "0"
printf '  build：%s\n' "$(deny_line "$OUT/build.json.err")"
check "build 收回了 dist/app" "$(jget "$OUT/build.json" reclaimed)" "dist/app"
check "build 那一趟报的档" "$(jget "$OUT/build.json" mode)/$(jget "$OUT/build.json" enforcement)" "read-only/full"
RC=$(json_run "$OUT/test.json" --agent "$AGENT" run test)
check "run test 退码" "$RC" "0"
check "test 收回了 dist/test.log" "$(jget "$OUT/test.json" reclaimed)" "dist/test.log"
# 产出那两条走的是绑定（落在缓存那一侧），**收进视图之后才落盘**：`run` 起进程之前先兑现一次
# 物化，所以上一条 `run` 收进来的产出在下一条开始时才落到树上。这里显式 `ensure` 一次，把
# 落点读全——读到的是"声明集内的一条不多、一条不少"（声明集外的写入由内核当场拒，见下一节）。
printf '  ensure 之前树上：%s\n' "$(find "$(upper_of "$AGENT")" -type f 2>/dev/null | sed "s|$(upper_of "$AGENT")/||" | sort | tr '\n' ' ')"
fugue --agent "$AGENT" ensure >/dev/null
check "落盘之后树那一侧正好是声明集内的那两条产出" "$(find "$(upper_of "$AGENT")" -type f 2>/dev/null | sed "s|$(upper_of "$AGENT")/||" | sort | tr '\n' ' ' | sed 's/ *$//')" "dist/app dist/test.log"
check "视图里读得到产物" "$(fugue --agent "$AGENT" read dist/test.log 2>/dev/null)" "ok s5"
check "真源里那条源码一个字节没被动" "$(cat src/a.c | md5sum | cut -c1-8)" "$(cd "$WORK" && git show "$BASE:src/a.c" | md5sum | cut -c1-8)"

# ── 四 · 逃逸：每类一条 ──────────────────────────────────────────────────
printf '\n══ 三 · 一个"想逃逸"的动作（每类一条）：全部被拒，指路那句也印出来 ══\n'
printf '  ── 物理侧 I · 内核当场拒（那几条签名读得出来）──\n'
escape_reading dirty dirty true
check "dirty · 树上没有 junk.txt" "$([ -e "$(upper_of "$AGENT")/junk.txt" ] && echo 有 || echo 没有)" "没有"
check "dirty · 视图里也读不到" "$(fugue --agent "$AGENT" read junk.txt >/dev/null 2>&1; echo $?)" "1"
escape_reading tamper tamper true
check "tamper · 真源那条源码没被改" "$(cd "$WORK" && git show "$BASE:src/a.c" | md5sum | cut -c1-8)" "$(cat src/a.c | md5sum | cut -c1-8)"
escape_reading escape-out escape-out true
check "escape-out · 工作区外没落下东西" "$([ -e "$WORK/escaped.txt" ] && echo 有 || echo 没有)" "没有"

printf '  ── 物理侧 II · 够不着（清单外那条路在沙箱里根本不在）──\n'
escape_reading peek-host peek-host false
escape_reading peek-truth peek-truth false
escape_reading peek-other peek-other false
escape_reading peek-config peek-config false
RC=$(json_run "$OUT/list-etc.json" --agent "$AGENT" run list-etc)
check "list-etc · 退码" "$RC" "0"
check "沙箱里那份 /etc 就是清单那几条" "$(grep -v '^$' "$OUT/list-etc.json.err" | grep -v '^退出码 ' | tr '\n' ' ' | sed 's/ *$//')" ". .. alternatives ld.so.cache resolv.conf ssl"

printf '  ── 虚拟侧（文件工具那一面：拒了，文案原样印出来）──\n'
for p in ../outside.txt /etc/passwd; do
  MSG=$(fugue --agent "$AGENT" read "$p" 2>&1 >/dev/null)
  RC=$?
  printf '  read  %-18s 退 %s：%s\n' "$p" "$RC" "$MSG"
  check "read $p · 拒了" "$RC" "1"
done
for p in ../outside.txt /etc/passwd; do
  MSG=$(printf 'hi\n' | fugue --agent "$AGENT" write "$p" --stdin 2>&1 >/dev/null)
  RC=$?
  printf '  write %-18s 退 %s：%s\n' "$p" "$RC" "$MSG"
  check "write $p · 拒了" "$RC" "1"
done
printf '  （这两条报在路径检查那一步；文案的形状与指路那一句一并记在步骤审的疑点里）\n'

printf '  ── 配置那一侧（清单里一条写错了：拒在起进程之前，话指回那一栏）──\n'
BEFORE=$(fugue --agent "$AGENT" --json log | grep -c '"t":"run/start"' || true)
fugue config set boundary.reach '["/usr","/opt","/etc/ld.so.cache","/etc/ssl","/etc/alternatives","/opt/没有这个"]' >/dev/null
RC=$(json_run "$OUT/badreach.json" --agent "$AGENT" run build)
check "badreach · 拒在起进程之前" "$RC" "1"
check "badreach · 一条 run/start 都没多" "$(fugue --agent "$AGENT" --json log | grep -c '"t":"run/start"' || true)" "$BEFORE"
printf '  %s\n' "$(head -1 "$OUT/badreach.json.err")"
check "badreach · 那句指路指回配置那一栏（给出一条能照抄的命令）" "$(grep -c "fugue config set boundary.reach" "$OUT/badreach.json.err" || true)" "1"
fugue config set boundary.reach '["/usr","/opt","/etc/ld.so.cache","/etc/ssl","/etc/alternatives"]' >/dev/null
printf '  （清单改回来了：缺省那五条）\n'

printf '  ── 启动前（声明本身就是坏的：Y4 那条 fail-closed）──\n'
RC=$(json_run "$OUT/badcache.json" --agent "$AGENT" run badcache)
check "badcache · 拒在起进程之前" "$RC" "1"
check "badcache · 一个子进程都没起（没有 run/start）" "$(fugue --agent "$AGENT" --json log | grep -c '"t":"run/start".*badcache' || true)" "0"
BAD=$(cat "$OUT/badcache.json.err")
printf '  %s\n' "$(printf '%s' "$BAD" | head -1)"
check "badcache · 指路那句话在" "$(printf '%s' "$BAD" | grep -c '要往工作区外写，改的是这个动作的声明' || true)" "1"

# ── 五 · 地板一：bwrap 不在 ──────────────────────────────────────────────
printf '\n══ 四 · 地板一：bwrap 从 PATH 上拿掉——第二层接过来，未声明的写入当场拒 ══\n'
BIN1=$(mktemp -d "$OUT/bin1-XXXXXX")
for d in /usr/bin /usr/local/bin; do
  for n in "$d"/*; do
    b=$(basename "$n")
    if [ "$b" = bwrap ]; then continue; fi
    if [ ! -e "$BIN1/$b" ]; then ln -s "$n" "$BIN1/$b" 2>/dev/null || true; fi
  done
done
check "镜像 PATH 里没有 bwrap" "$([ -e "$BIN1/bwrap" ] && echo 有 || echo 没有)" "没有"
env PATH="$BIN1" node "$FUGUE" --root "$WORK" --json --agent "$AGENT" run dirty >"$OUT/floor1.json" 2>"$OUT/floor1.err"
RC=$?
printf '  dirty：%s\n' "$(deny_line "$OUT/floor1.err")"
check "地板一 · run dirty 退码（子进程没成功）" "$RC" "1"
check "地板一 · 在场的层" "$(jget "$OUT/floor1.json" layers)" "landlock"
check "地板一 · 档如实报 read-only（树不可写）" "$(jget "$OUT/floor1.json" mode)" "read-only"
check "地板一 · enforcement 如实报 partial" "$(jget "$OUT/floor1.json" enforcement)" "partial"
check "地板一 · 机制报 landlock" "$(jget "$OUT/floor1.json" mechanism)" "landlock"
check "地板一 · 自己探出来沙箱不在" "$(jget "$OUT/floor1.json" sandbox)" "false"
check "地板一 · 树上没有 junk.txt（当场拒，不是事后记）" "$([ -e "$(upper_of "$AGENT")/junk.txt" ] && echo 有 || echo 没有)" "没有"
check "地板一 · 没有可报的声明集外改动" "$(jget "$OUT/floor1.json" undeclared)" ""

# 声明目录那一半：同一档里正对照照跑。
env PATH="$BIN1" node "$FUGUE" --root "$WORK" --json --agent "$AGENT" run build >"$OUT/floor1-build.json" 2>"$OUT/floor1-build.err"
RC=$?
check "地板一 · 同一档里 run build 退码" "$RC" "0"
check "地板一 · 声明目录照写、产物照回收" "$(jget "$OUT/floor1-build.json" reclaimed)" "dist/app"
check "地板一 · 收进视图的那一条读得回来" "$(fugue --agent "$AGENT" read dist/app >/dev/null 2>&1; echo $?)" "0"

# ── 六 · 地板底：两层都不在 ─────────────────────────────────────────────
printf '\n══ 五 · 地板底：两层都不在（把编过的那一份拿走，cc 也不给）——树可写 + 回收兜底 ══\n'
rm -rf "$WORK/.fugue/bin"
printf '  拿走了 %s（第二层那份包装器是派生物：可弃、可重生成）\n' "$WORK/.fugue/bin"
BIN2=$(mktemp -d "$OUT/bin2-XXXXXX")
for d in /usr/bin /usr/local/bin; do
  for n in "$d"/*; do
    b=$(basename "$n")
    if [ "$b" = bwrap ] || [ "$b" = cc ]; then continue; fi
    if [ ! -e "$BIN2/$b" ]; then ln -s "$n" "$BIN2/$b" 2>/dev/null || true; fi
  done
done
check "镜像 PATH 里没有 bwrap 也没有 cc" "$([ -e "$BIN2/bwrap" ] || [ -e "$BIN2/cc" ] && echo 有 || echo 没有)" "没有"
env PATH="$BIN2" node "$FUGUE" --root "$WORK" --json --agent "$AGENT" run dirty >"$OUT/floor2.json" 2>"$OUT/floor2.err"
RC=$?
check "地板底 · run dirty 退码（这一档子进程成功了）" "$RC" "0"
check "地板底 · 一层都没有" "$(jget "$OUT/floor2.json" layers)" ""
check "地板底 · 档如实报 workspace-write（树可写是那一档的事实）" "$(jget "$OUT/floor2.json" mode)" "workspace-write"
check "地板底 · 机制报 none" "$(jget "$OUT/floor2.json" mechanism)" "none"
check "地板底 · junk.txt 真写进了树里" "$(cat "$(upper_of "$AGENT")/junk.txt" 2>/dev/null)" "undeclared"
check "地板底 · 回收把这笔账报出来了" "$(jget "$OUT/floor2.json" undeclared)" "junk.txt"
check "地板底 · 照旧进不来视图" "$(fugue --agent "$AGENT" read junk.txt >/dev/null 2>&1; echo $?)" "1"

# ── 七 · 收尾 ───────────────────────────────────────────────────────────
printf '\n══ 六 · 收尾：dispose · 不留挂载 · 不留进程 · 不留端口 ══\n'
for a in $AGENT $OTHER; do
  RC=$(json_run "$OUT/dispose-$(printf '%s' "$a" | tr '/' '-').json" --agent "$a" dispose)
  check "$a · dispose 退码" "$RC" "0"
  check "$a · 物化根跟着走" "$([ -e "$(leaf "$a")" ] && echo 还在 || echo 走了)" "走了"
done
check "挂载表里一条都不剩" "$(mountcount)" "0"
check "没有残留进程" "$(leftprocs)" "0"
check "两条端口片没人听" "$(portbusy)" "0"
printf '  %s 还在（派生：下一次运行会重编）\n' "$([ -e "$WORK/.fugue/bin/landlock-exec" ] && echo '.fugue/bin/landlock-exec' || echo '.fugue/bin 里没有编好的那一份')"

printf '\n── 读数并列 ──\n'
printf '  %-24s %s\n' '沙箱档（两层都在）' "$(jget "$OUT/build.json" mode)/$(jget "$OUT/build.json" enforcement) · layers=$(jget "$OUT/build.json" layers) · mechanism=$(jget "$OUT/build.json" mechanism)"
printf '  %-24s %s\n' '地板一（只有第二层）' "$(jget "$OUT/floor1.json" mode)/$(jget "$OUT/floor1.json" enforcement) · layers=$(jget "$OUT/floor1.json" layers) · mechanism=$(jget "$OUT/floor1.json" mechanism)"
printf '  %-24s %s\n' '地板底（两层都不在）' "$(jget "$OUT/floor2.json" mode)/$(jget "$OUT/floor2.json" enforcement) · layers=（空） · mechanism=$(jget "$OUT/floor2.json" mechanism)"
printf '  （三档的读数各自与 `fugue policy` 报的那一份同源：一处解析，两处读）\n'

if [ "${KEEP:-0}" = "1" ]; then
  printf '\n工作区留在 %s（读数在 %s · 两个镜像 PATH 在 %s）\n' "$WORK" "$OUT" "$BIN1"
else
  cd / || exit 1
  for w in $(awk '{print $2}' /proc/self/mounts | grep "^$WORK/" || true); do
    sudo -n umount -l "$w" 2>/dev/null || umount -l "$w" 2>/dev/null || true
  done
  rm -rf "$WORK" "$OUT"
fi

if [ "$FAIL" = "0" ]; then
  printf '\n走查全部通过\n'
  exit 0
fi
printf '\n%s 项不通过\n' "$FAIL"
exit 1
