#!/bin/sh
# S2 的走查（PLAN § 5.2 的 V6 行 · 架构 § 20 的 S2 那一节 · § 2.4 的门）。
#
# **它在一个真实项目上跑**：一个 C 项目 + Makefile。选 `make` 不是随手挑的——它是"按 mtime
# 判定新旧"那一类工具链的头一个（§ 8.5 那张表：make · Cargo · ccache），而整条承重性质说的
# 就是这类工具链会不会被物化器骗出假失效。
#
# 四条判据，逐条对 V6 那一行：
#
#   ① fork → ensure → 构建 → 改 3 个无关文件 → ensure → 再构建：第二次只重编那 3 个，
#      且全树快照恰好 3 条变化
#   ② 再物化一次（dispose + fork + ensure）之后再构建：`preserveMtime` 开着仍只重编 3 个，
#      关掉就全量重建——**假失效出现了**（§ 8.5 的负对照）
#   ③ 三档策略（overlayfs · hardlink-ro · copy）各跑一遍，承重性质三档都成立，读数并列
#
# 两条纪律在这个脚本里的落点：
#
#   **构建产物落在树外**（`make O=<树外>`）。§ 8.6：合并树内每写一次都付一次 copy-up；而且
#   产物留在树里，"恰好 3 条变化"永远不成立（§ 8.5 的第一条验证性质）。
#   **尺子也落在树外**（`diff-stat --baseline/--save`，§ 9.6）：基线留在被扫的树里，下一轮
#   它自己会被报成"多了一条"——量树的人亲手污染读数。
#
# 跑法（在 ext4 上 · 仓库根）：sh tools/walkthrough-s2.sh
# `KEEP=1` 把工作区留下；`FUGUE=<path>` 换实现（默认仓库里那个命令行）。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FUGUE=${FUGUE:-$ROOT/src/cli/fugue.ts}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fugue-s2-XXXXXX")
OUT=$(mktemp -d "${TMPDIR:-/tmp}/fugue-s2-out-XXXXXX")
FAIL=0
UNITS='u1 u2 u3 u4 u5 u6'
CHANGED='u1 u2 u3'          # 这一趟要改的 3 个无关文件
TOTAL=8                     # 6 个单元 + vendor 里那一个 + main

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

# 从一份 --json 的输出里取一个字段（本脚本不引 jq：`node` 本来就在）。
jget() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=process.argv[2].split(".");let v=o;for(const k of p)v=v==null?undefined:v[k];process.stdout.write(v===undefined?"":String(v))' "$1" "$2"; }

# 一个文件的"时间戳 + inode"：承重性质在那四样上，而 mtime 与 inode 是其中两样。
stamp() { stat -c '%y|%i' "$1"; }

# 构建一次，报出重编了几个单元（配方是逐行回显的，`-c -o` 那几行就是编译）。
build() {
  if ! make -C "$MERGED" O="$1" > "$2" 2>&1; then
    printf '  FAIL 构建没成，看 %s\n' "$2"
    FAIL=$((FAIL + 1))
    printf '0\n'
    return
  fi
  grep -c -- '-c -o' "$2" || true
}

printf '走查 · S2（增量物化）· 工作区 %s\n' "$WORK"
printf '文件系统 %s · %s · %s · %s\n' "$(df -T "$WORK" | awk 'NR == 2 {print $2}')" "$(node -v)" "$(make --version | head -1)" "$(cc --version | head -1)"

# ── 一 · 起一个真项目：6 个单元 + vendor 里 1 个 + main + 一个 Makefile ────────
cd "$WORK" || exit 1
mkdir -p src vendor include
cat > include/common.h <<'EOF'
#ifndef COMMON_H
#define COMMON_H
int u1(void); int u2(void); int u3(void);
int u4(void); int u5(void); int u6(void);
int v1(void);
#endif
EOF
for n in $UNITS; do
  printf '#include "common.h"\nint %s(void) { return %s; }\n' "$n" "$(printf '%s' "$n" | tr -d 'u')" > "src/$n.c"
done
printf '#include "common.h"\nint v1(void) { return 0; }\n' > vendor/v1.c
cat > src/main.c <<'EOF'
#include <stdio.h>
#include "common.h"
int main(void) {
  printf("%d\n", u1() + u2() + u3() + u4() + u5() + u6() + v1());
  return 0;
}
EOF
# `.RECIPEPREFIX` 让配方用 `>` 起头——这个脚本本身是写出来的，制表符在传输里是第一个阵亡的
# 东西，而 make 的默认配方前缀正是一个制表符。
cat > Makefile <<'EOF'
.RECIPEPREFIX = >
CC ?= cc
CFLAGS ?= -Iinclude
O ?= build
SRC := $(sort $(wildcard src/*.c) $(wildcard vendor/*.c))
OBJ := $(patsubst %.c,$(O)/%.o,$(SRC))
all: $(O)/app
$(O)/%.o: %.c include/common.h
> @mkdir -p $(dir $@)
> $(CC) $(CFLAGS) -c -o $@ $<
$(O)/app: $(OBJ)
> $(CC) -o $@ $(OBJ)
EOF
run git init -q -b main .
run git add -A
git -c user.email=f@l -c user.name=f commit -qm 起点
BASE=$(git rev-parse HEAD)
printf '\n基线提交 %s\n' "$BASE"

# ── 二 · 一趟：全量构建 → 改 3 个 → ensure → 增量构建 → 再物化 → 再构建 ────────
# 每趟一个自己的输出目录（树外）：上一趟的 .o 会让这一趟的"全量"读成"增量"。
pass() {
  LABEL=$1; shift
  BOUT="$OUT/$LABEL"
  mkdir -p "$BOUT"
  printf '\n══ %s ══\n' "$LABEL"

  run fugue dispose
  node "$FUGUE" --root "$WORK" --json fork "$BASE" "$@" > "$BOUT/fork.json" 2>"$BOUT/fork.err"
  STRATEGY=$(jget "$BOUT/fork.json" strategy)
  MS_FORK=$(jget "$BOUT/fork.json" ms)
  MERGED=$(jget "$BOUT/fork.json" merged)
  printf '  档 %s（fork %s ms）· %s\n' "$STRATEGY" "$MS_FORK" "$(cat "$BOUT/fork.err")"

  # 全量构建：产物落在树外，合并树一次都不被写。
  FIRST=$(build "$BOUT/build" "$BOUT/make1.log")
  check "$LABEL · 第一次构建（全量）" "$FIRST" "$TOTAL"

  # 尺子也落在树外：先拍一张，再改。
  fugue diff-stat --save "$BOUT/before.json" > /dev/null 2>&1
  BEFORE=''
  for n in u4 u5 u6; do BEFORE="$BEFORE$(stamp "$MERGED/src/$n.c")|"; done
  BEFORE="$BEFORE$(stamp "$MERGED/vendor/v1.c")"

  # 改 3 个无关文件——**在视图里改**（`fugue write` 不碰真实工作树）。
  for n in $CHANGED; do
    printf '#include "common.h"\nint %s(void) { return 9%s; }\n' "$n" "$(printf '%s' "$n" | tr -d 'u')" \
      | node "$FUGUE" --root "$WORK" write "src/$n.c" --stdin > /dev/null
  done
  node "$FUGUE" --root "$WORK" --json ensure > "$BOUT/ensure.json" 2>"$BOUT/ensure.err"
  MS_ENSURE=$(jget "$BOUT/ensure.json" ms)
  LANDED=$(jget "$BOUT/ensure.json" touched)
  printf '  ensure：%s ms · 清单 %s 条 · %s\n' "$MS_ENSURE" "$LANDED" "$(cat "$BOUT/ensure.err")"
  check "$LABEL · 落地条数" "$LANDED" "3"

  # ① 增量构建：只有那 3 个被重编。
  SECOND=$(build "$BOUT/build" "$BOUT/make2.log")
  fugue --json diff-stat --baseline "$BOUT/before.json" > "$BOUT/diff.json" 2>/dev/null
  DIFFCOUNT=$(jget "$BOUT/diff.json" count)
  AFTER=''
  for n in u4 u5 u6; do AFTER="$AFTER$(stamp "$MERGED/src/$n.c")|"; done
  AFTER="$AFTER$(stamp "$MERGED/vendor/v1.c")"

  # ② 再物化一次：dispose + fork + ensure——"每次提交点都重铺一遍"那件事。
  run fugue dispose
  node "$FUGUE" --root "$WORK" --json fork "$BASE" "$@" > "$BOUT/refork.json" 2>/dev/null
  node "$FUGUE" --root "$WORK" --json ensure > /dev/null 2>&1
  THIRD=$(build "$BOUT/build" "$BOUT/make3.log")

  check "$LABEL · ① 第二次构建（只该重编那 3 个）" "$SECOND" "3"
  check "$LABEL · ① 全树快照恰好 3 条变化" "$DIFFCOUNT" "3"
  if [ "$BEFORE" = "$AFTER" ]; then UNCHANGED=yes; else UNCHANGED=no; fi
  check "$LABEL · ③ 未变文件的 mtime 与 inode 逐字节不变" "$UNCHANGED" "yes"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$LABEL" "$STRATEGY" "$MS_FORK" "$MS_ENSURE" "$SECOND" "$THIRD" "$UNCHANGED" >> "$OUT/table.txt"
}

# ── 三 · 四趟：三档 + 一个负对照 ────────────────────────────────────────────
# `hardlink-ro` 要声明只读子树（§ 8.5 硬链接纪律）：`vendor/` 就是那个"无人可写"的路径。
pass overlayfs
pass hardlink-ro --strategy hardlink-ro --ro vendor
pass copy --strategy copy
pass 'copy·不保时间戳' --strategy copy --no-preserve-mtime

printf '\n══ 读数并列（V6 的三条断言）══\n'
printf '  %-16s %-12s %8s %10s %12s %14s %10s\n' 趟 档 'fork ms' 'ensure ms' 第二次重编 再物化后重编 未变四样
while IFS='' read -r a b c d e f g; do
  printf '  %-16s %-12s %8s %10s %12s %14s %10s\n' "$a" "$b" "$c" "$d" "$e" "$f" "$g"
done < "$OUT/table.txt"

printf '\n判据\n'
cell() { awk -F'\t' -v k="$1" -v c="$2" '$1==k {print $c}' "$OUT/table.txt"; }
check "② overlayfs 那一趟：再物化之后仍只重编 3 个" "$(cell overlayfs 6)" "3"
check "② hardlink-ro 那一趟：再物化之后仍只重编 3 个" "$(cell hardlink-ro 6)" "3"
check "② copy 那一趟：再物化之后仍只重编 3 个" "$(cell copy 6)" "3"
check "② 负对照：不保时间戳时全量重建（假失效）" "$(cell 'copy·不保时间戳' 6)" "$TOTAL"
check "③ 四趟的 ensure 都没碰未变文件（承重性质；三档 + 负对照）" "$(awk -F'\t' '$7=="yes"' "$OUT/table.txt" | wc -l | tr -d ' ')" "4"

# ── 四 · 收尾 ──────────────────────────────────────────────────────────────
fugue dispose > /dev/null 2>&1
if [ "${KEEP:-0}" = "1" ]; then
  printf '\n工作区留在 %s（构建产物与基线在 %s）\n' "$WORK" "$OUT"
else
  cd / || exit 1
  rm -rf "$WORK" "$OUT"
fi
printf '\n%s\n' "$([ "$FAIL" = 0 ] && echo '走查全部通过' || echo "$FAIL 项不通过")"
exit "$([ "$FAIL" = 0 ] && echo 0 || echo 1)"
