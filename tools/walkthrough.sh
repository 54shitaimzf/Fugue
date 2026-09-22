#!/bin/sh
# U6 的走查：起一个真仓库 → 写 → 提交 → 杀进程 → 重放 → 看变更（PLAN § 5 的 U6 行）。
#
# **它是给人跑一遍看的**：每一步先打 `$ 命令行`，再原样打输出与退出码——不吞输出、不藏
# 错误。走查要证的就是"这套东西现在跑得通"，那读到的人就得自己看见。
#
# 跑法（在 ext4 上 · 仓库根）：
#     sh tools/walkthrough.sh
#
# **不要求 PATH 上有 `fugue`**：走查用的是 § 9.6 的仓库内调用形 `node src/cli/fugue.ts`。
# PATH 上那个壳是 U7 的事，而这张表在 U6 就该自己跑得通。
#
# 最后那段 `检查` 是走查自己的断言：任何一条不成立就非零退出。`KEEP=1` 把工作区留下。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FUGUE=${FUGUE:-$ROOT/src/cli/fugue.ts}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fugue-walkthrough-XXXXXX")
BIG=$((64 * 1024 * 1024))
FAIL=0

fugue() { node "$FUGUE" --root "$WORK" "$@"; }

run() {
  printf '\n$ %s\n' "$*"
  "$@"
  printf '[退出码 %s]\n' "$?"
}

runin() {
  text=$1
  shift
  printf '\n$ echo %s | %s\n' "$text" "$*"
  printf '%s\n' "$text" | "$@"
  printf '[退出码 %s]\n' "$?"
}

check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s（期望 %s，实得 %s）\n' "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
  fi
}

printf '走查 · 工作区 %s\n' "$WORK"
printf '文件系统 %s · %s · %s\n' "$(df -T "$WORK" | awk 'NR == 2 {print $2}')" "$(node -v)" "$(git --version)"

# ── 一 · 起一个真仓库 ───────────────────────────────────────────────────────
cd "$WORK" || exit 1
run git init -q .

# ── 二 · 写：每条命令各说一件事 ─────────────────────────────────────────────
runin 第一份 fugue write notes/one.txt --stdin
runin 第二份 fugue write notes/two.txt --stdin
run fugue chmod notes/two.txt 755
run fugue list notes
run fugue read notes/one.txt
run fugue --json stat notes/two.txt
run fugue revs

# ── 三 · 提交：视图定格成一个提交点，ref 前移 ───────────────────────────────
run fugue commit -m '走查 · 第一次提交'
run git show-ref
run git --no-pager log --oneline -1 refs/heads/main
run fugue revs

# ── 四 · 杀进程：一次 64 MiB 的写，落到一半 SIGKILL ─────────────────────────
printf '\n$ head -c %s /dev/zero | %s --root %s write big.bin --stdin &\n' "$BIG" "$FUGUE" "$WORK"
printf '$ sleep 0.3; kill -9 %%1; wait          # 它可能死在读 stdin、写对象、或追加日志\n'
head -c "$BIG" /dev/zero | node "$FUGUE" --root "$WORK" write big.bin --stdin &
WRITER=$!
sleep 0.3
kill -9 "$WRITER" 2>/dev/null || true
wait "$WRITER" 2>/dev/null
printf '[退出码 %s —— 137 就是被 SIGKILL]\n' "$?"

# ── 五 · 重放：崩溃恢复就是"下一条命令照常加载" ─────────────────────────────
run fugue replay --verify
run fugue replay
run fugue revs
run fugue log
run fugue diff
run fugue read notes/one.txt
run git --no-pager fsck --no-progress

# ── 六 · 检查：走查自己的断言 ───────────────────────────────────────────────
printf '\n检查\n'
fugue replay --verify >/dev/null 2>&1
check '杀进程之后重放比对通过（两条重建路径一致）' 0 "$?"
check '被杀之前写下的内容一个字节没动' 第一份 "$(fugue read notes/one.txt)"
check '被杀之前写下的模式还在' 100755 "$(fugue stat notes/two.txt | awk '{print $2}')"
check '日志里的变更事件数 == 视图给出的变更数' \
  "$(fugue log | grep -c 'view/')" "$(fugue diff | wc -l)"
check '修订点是一段连续前缀：0 到最新，中间没有洞' \
  "$(fugue revs | tail -1)" "$(( $(fugue revs | wc -l) - 1 ))"
if fugue --json stat big.bin 2>/dev/null | grep -q '"size"'; then
  check '被杀的那次写：它整个在（绝不半份）' "$BIG" \
    "$(fugue --json stat big.bin | sed 's/.*"size":\([0-9]*\).*/\1/')"
else
  check '被杀的那次写：一个字节都没落（日志里也没有它的行）' 0 \
    "$(fugue log | grep -c 'big\.bin' || true)"
fi
git --no-pager fsck --no-progress >/dev/null 2>&1
check '对象库干净（孤儿对象是垃圾，不是损坏）' 0 "$?"

# ── 七 · 结账：§ 9.6 里属于 S1 的每一行，逐行走一遍 ─────────────────────────
printf '\n结账 · § 9.6 的表逐行（每条命令一个新进程 · 都在上面那个被杀过的工作区上）\n'
sweep() {
  printf '  %-46s' "$*"
  "$@" >/dev/null 2>&1 </dev/null
  code=$?
  printf '退出码 %s\n' "$code"
  [ "$code" = 0 ] || FAIL=$((FAIL + 1))
}
sweep fugue read notes/one.txt
sweep fugue list notes
sweep fugue stat notes/two.txt
sweep fugue write notes/three.txt --stdin
sweep fugue rename notes/three.txt notes/renamed.txt
sweep fugue chmod notes/renamed.txt 600
sweep fugue remove notes/renamed.txt
sweep fugue diff
sweep fugue diff --since 3
sweep fugue log
sweep fugue log --agent round
sweep fugue revs
sweep fugue commit -m '走查 · 结账'
sweep fugue replay
sweep fugue replay --to 3
sweep fugue replay --verify
sweep fugue config set walkthrough.done true
sweep fugue config get walkthrough.done
sweep fugue config show
printf '  %-46s' 'fugue --json revs（机器那一面）'
fugue --json revs >/dev/null 2>&1 </dev/null
printf '退出码 %s\n' "$?"

printf '\n%s\n' "$([ "$FAIL" = 0 ] && echo '走查全部通过' || echo "$FAIL 项不通过")"
if [ "${KEEP:-0}" = 1 ]; then printf '工作区留着：%s\n' "$WORK"; else rm -rf "$WORK"; fi
exit $FAIL
