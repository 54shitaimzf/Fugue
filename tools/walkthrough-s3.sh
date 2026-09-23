#!/bin/sh
# S3 的走查（PLAN § 5.3 的 W4 行 · 架构 § 20 的 S3 那一节）。
#
# **一条命令跑完九个动作**：建仓库 → 定 base → 四条分支头 → 四路并发 `fork` → 各写各的 →
# 四路并发 `ensure` → 逐个 `verify-mat` + 全树摘要 + 互不可见 → `dispose` 三个留一个 →
# 重铺幂等（再 `fork` + `ensure`，树与第一次逐字节相同）→ 收尾不留挂载。
#
# 四个 agent 用**架构 § 4 的写法**（`agent/r1/<n>`，带 `/`），所以这一趟同时把 W3 那一维走一遍：
# 名字按段展开、`mat/` 与 `log/` 与 `snap/` 三处同形状。
#
# 两条判据的分工（§ 20 的 S3）：
#   · **互不可见**由两个来源各读一次——合并树里看不见别人的那条（文件系统），视图里 `read`
#     也退 1（日志重放）。两条独立，所以"看不见"不是某一处的自述。
#   · **各物化树全量哈希正确**由**另起一棵树**判：`git clone` 出 base 那一份，再拿普通文件
#     操作铺上这一路自己的改动（`refbuild`），全程不经过物化器。两边比同一条尺子
#     （路径 · 模式 · 内容哈希，**不比时间戳**——两棵树的年龄本来就不一样）。
#
# 跑法（在 ext4 上 · 仓库根）：sh tools/walkthrough-s3.sh
# `KEEP=1` 把工作区留下；`FUGUE=<path>` 换实现（默认仓库里那个命令行）。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FUGUE=${FUGUE:-$ROOT/src/cli/fugue.ts}
IMPL=$(cd "$(dirname "$FUGUE")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fugue-s3-XXXXXX")
OUT=$(mktemp -d "${TMPDIR:-/tmp}/fugue-s3-out-XXXXXX")
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

# 一条路径的标签：目录名要平（agent/r1/1 → agent-r1-1），它同时是文件名。
label() { printf '%s' "$1" | tr '/' '-'; }

leaf() { printf '%s/.fugue/mat/%s' "$WORK" "$1"; }
merged_of() { printf '%s/merged' "$(leaf "$1")"; }

# 一份 --json 里那一行长这样：{"merged":"…","strategy":"overlayfs",…}
json_run() { # json_run <out 文件> <args…>
  out=$1; shift
  node "$FUGUE" --root "$WORK" --json "$@" >"$out" 2>"$out.err"
  printf '%s' "$?"
}

# 全树摘要：路径 · 模式 · 内容哈希。**与 W2 的断言同一条尺子**（scanTree 的同一份实现）。
treehash() {
  node --input-type=module -e '
    const { createHash } = await import("node:crypto")
    const { scanTree, WORKSPACE_STATE } = await import(process.argv[1])
    const rows = scanTree(process.argv[2], { skip: WORKSPACE_STATE }).leaves
      .map((l) => l.path + "\t" + l.mode.toString(8) + "\t" + l.hash).sort()
    process.stdout.write(createHash("sha256").update(rows.join("\n")).digest("hex"))
  ' "$IMPL/materialize/diffstat.ts" "$1"
}

is_mounted() { awk '{print $2}' /proc/self/mounts | grep -qx "$1"; }
mountcount() { awk '{print $2}' /proc/self/mounts | grep -c "^$WORK/" || true; }

# 这一路自己的那两条内容：**视图里与参照树里用的是同一个 printf**，所以比的是同一批字节。
own_body() { printf 'own %s\n' "$1"; }
a_body() { printf "export const a = '%s'\n" "$1"; }

# 参照树：`git clone` 出 base，再拿普通文件操作铺上这一路自己的改动——**不经过物化器**。
refbuild() {
  a=$1
  lbl=$(label "$a")
  REF="$OUT/ref/$lbl"
  mkdir -p "$OUT/ref"
  rm -rf "$REF"
  git clone -q --no-hardlinks "$WORK" "$REF"
  rm -rf "$REF/.git"
  mkdir -p "$REF/own"
  own_body "$lbl" > "$REF/own/$lbl.txt"
  a_body "$lbl" > "$REF/src/a.ts"
  case "$a" in
    agent/r1/1) rm -f "$REF/src/b.ts" ;;
  esac
  if [ "$a" = "agent/r1/4" ]; then chmod 644 "$REF/bin/run.sh"; fi
  treehash "$REF"
}

# 四路并发：每个 agent 一路，后台跑，退出码落进一个文件。
par() {
  phase=$1
  fn=$2
  for a in $AGENTS; do
    lbl=$(label "$a")
    ( "$fn" "$a" >"$OUT/$phase-$lbl.out" 2>"$OUT/$phase-$lbl.err"; echo $? >"$OUT/$phase-$lbl.code" ) &
  done
  wait
}

# ── 一 · 建仓库 ────────────────────────────────────────────────────────────
printf '走查 · S3（并发视图：N 个分支并行独立工作）· 工作区 %s\n' "$WORK"
printf '文件系统 %s · %s · %s\n' "$(df -T "$WORK" | awk 'NR == 2 {print $2}')" "$(node -v)" "$(git --version)"

cd "$WORK" || exit 1
mkdir -p src docs bin
printf 'export const a = 1\n' > src/a.ts
printf 'export const b = 2\n' > src/b.ts
printf '# 手册\n' > docs/manual.md
ln -s src/a.ts link.ts
printf '#!/bin/sh\necho hi\n' > bin/run.sh
chmod 755 bin/run.sh
run git init -q -b main .
run git add -A
git -c user.email=f@l -c user.name=f commit -qm 起点
BASE=$(git -C "$WORK" rev-parse HEAD)
printf '\n基线提交 %s\n' "$BASE"

# ── 二 · 定 base 与四条分支头 ──────────────────────────────────────────────
printf '\n══ 一 · 四条分支头定在同一个 base 上（fugue branch <base>）══\n'
for a in $AGENTS; do
  RC=$(json_run "$OUT/branch-$(label "$a").json" --agent "$a" branch "$BASE")
  check "$a · branch 退码" "$RC" "0"
  check "$a · 分支头指着的提交" "$(git -C "$WORK" rev-parse "refs/heads/$a")" "$BASE"
done

# ── 三 · 四路并发 fork ────────────────────────────────────────────────────
printf '\n══ 二 · 四路并发 fork ══\n'
do_fork() { printf '%s' "$(json_run "$OUT/fork-$(label "$1").json" --agent "$1" fork "$BASE")"; }
par fork do_fork
STRATEGY=''
for a in $AGENTS; do
  lbl=$(label "$a")
  RC=$(cat "$OUT/fork-$lbl.code")
  check "$a · fork 退码" "$RC" "0"
  M=$(jget "$OUT/fork-$lbl.json" merged)
  check "$a · 合并树在" "$([ -d "$M" ] && echo 在 || echo 不在)" "在"
  if [ "$a" = "$(printf '%s' "$AGENTS" | cut -d' ' -f1)" ]; then STRATEGY=$(jget "$OUT/fork-$lbl.json" strategy); fi
  if is_mounted "$M"; then MOUNT=挂着; else MOUNT=没挂; fi
  printf '  %s · %s 档 · %s · %s\n' "$a" "$(jget "$OUT/fork-$lbl.json" strategy)" "$M" "$MOUNT"
done
printf '  四个都用了同一档：%s\n' "$STRATEGY"

# ── 四 · 各写各的（四路并发）──────────────────────────────────────────────
printf '\n══ 三 · 各写各的：每条改动都不一样 ══\n'
do_ops() {
  a=$1
  lbl=$(label "$a")
  own_body "$lbl" | node "$FUGUE" --root "$WORK" --agent "$a" write "own/$lbl.txt" --stdin || return 1
  a_body "$lbl" | node "$FUGUE" --root "$WORK" --agent "$a" write src/a.ts --stdin || return 1
  case "$a" in
    agent/r1/1) node "$FUGUE" --root "$WORK" --agent "$a" remove src/b.ts || return 1 ;;
  esac
  if [ "$a" = "agent/r1/4" ]; then node "$FUGUE" --root "$WORK" --agent "$a" chmod bin/run.sh 644 || return 1; fi
  return 0
}
par ops do_ops
for a in $AGENTS; do
  check "$a · 三条操作退码" "$(cat "$OUT/ops-$(label "$a").code")" "0"
done
printf '  改动：每人 own/<标签>.txt 与 src/a.ts 各一条 · agent/r1/1 另删 src/b.ts · agent/r1/4 另改 bin/run.sh 644\n'

# ── 五 · 四路并发 ensure ──────────────────────────────────────────────────
printf '\n══ 四 · 四路并发 ensure ══\n'
do_ensure() { printf '%s' "$(json_run "$OUT/ensure-$(label "$1").json" --agent "$1" ensure)"; }
par ensure do_ensure
for a in $AGENTS; do
  lbl=$(label "$a")
  check "$a · ensure 退码" "$(cat "$OUT/ensure-$lbl.code")" "0"
  printf '  %s · 落地 %s 条\n' "$a" "$(jget "$OUT/ensure-$lbl.json" touched)"
done

# ── 六 · 逐个核：三集合 · 全树摘要 · 互不可见 ──────────────────────────────
printf '\n══ 五 · 逐个核：verify-mat（三集合）· 全树摘要 == base ⊕ 自己的改动 · 互不可见 ══\n'
for a in $AGENTS; do
  lbl=$(label "$a")
  M=$(merged_of "$a")
  V=$(json_run "$OUT/verify-$lbl.json" --agent "$a" verify-mat)
  check "$a · verify-mat 退码" "$V" "0"
  check "$a · 清单 == 差异集 == 落地" "$(jget "$OUT/verify-$lbl.json" manifest.paths.length)/$(jget "$OUT/verify-$lbl.json" diff.paths.length)/$(jget "$OUT/verify-$lbl.json" landed.paths.length)" \
    "$(jget "$OUT/verify-$lbl.json" manifest.paths.length)/$(jget "$OUT/verify-$lbl.json" manifest.paths.length)/$(jget "$OUT/verify-$lbl.json" manifest.paths.length)"
  check "$a · 全树摘要 == base ⊕ 自己的改动" "$(treehash "$M")" "$(refbuild "$a")"
  check "$a · 自己那条在" "$([ -f "$M/own/$lbl.txt" ] && echo 在 || echo 不在)" "在"
  for o in $AGENTS; do
    if [ "$o" = "$a" ]; then continue; fi
    olbl=$(label "$o")
    check "$a · 合并树里看不见 $o" "$([ -e "$M/own/$olbl.txt" ] && echo 看得见 || echo 看不见)" "看不见"
    node "$FUGUE" --root "$WORK" --agent "$a" read "own/$olbl.txt" >/dev/null 2>&1
    check "$a · 视图里读不到 $o" "$?" "1"
  done
done

# ── 七 · dispose 三个留一个 ───────────────────────────────────────────────
printf '\n══ 六 · dispose 三个留一个：留下的那棵一个字节没动 ══\n'
KEEPAGENT=$(printf '%s' "$AGENTS" | cut -d' ' -f4)
KEEPMERGED=$(merged_of "$KEEPAGENT")
KEEPBEFORE=$(treehash "$KEEPMERGED")
for a in $(printf '%s' "$AGENTS" | cut -d' ' -f1-3); do
  RC=$(json_run "$OUT/dispose-$(label "$a").json" --agent "$a" dispose)
  check "$a · dispose 退码" "$RC" "0"
  check "$a · 物化根跟着走" "$([ -e "$(leaf "$a")" ] && echo 还在 || echo 走了)" "走了"
done
check "留下的那棵还在挂着" "$(is_mounted "$KEEPMERGED" && echo 挂着 || echo 没挂)" "挂着"
check "留下的那棵全树摘要没动" "$(treehash "$KEEPMERGED")" "$KEEPBEFORE"
check "留下的那棵 verify-mat 照旧" "$(json_run "$OUT/verify-keep.json" --agent "$KEEPAGENT" verify-mat)" "0"
if [ "$STRATEGY" = overlayfs ]; then
  check "挂载表里只剩留下的那一个" "$(mountcount)" "1"
else
  printf '  （%s 档：没有挂载，这一条不适用）\n' "$STRATEGY"
fi

# ── 八 · 重铺幂等 ─────────────────────────────────────────────────────────
printf '\n══ 七 · 重铺幂等：再 fork + ensure，树与第一次逐字节相同 ══\n'
RC=$(json_run "$OUT/refork.json" --agent "$KEEPAGENT" fork "$BASE")
check "再 fork 退码" "$RC" "0"
RC=$(json_run "$OUT/reensure.json" --agent "$KEEPAGENT" ensure)
check "再 ensure 退码" "$RC" "0"
check "重铺之后全树摘要与第一次相同" "$(treehash "$KEEPMERGED")" "$KEEPBEFORE"
check "重铺之后 verify-mat" "$(json_run "$OUT/verify-refork.json" --agent "$KEEPAGENT" verify-mat)" "0"

# ── 九 · 收尾 ────────────────────────────────────────────────────────────
printf '\n══ 八 · 收尾：不留挂载 · 不留坐标 ══\n'
for a in $AGENTS; do
  node "$FUGUE" --root "$WORK" --agent "$a" dispose >/dev/null 2>&1
done
check "挂载表里一条都不剩" "$(mountcount)" "0"
LEFT=0
for a in $AGENTS; do
  if [ -e "$(leaf "$a")" ]; then LEFT=$((LEFT + 1)); fi
done
check "四个物化根一个不剩" "$LEFT" "0"
FILES=$(find "$WORK/.fugue/mat" -type f 2>/dev/null | wc -l | tr -d ' ')
check "mat 底下不留一个文件" "$FILES" "0"

# ── 读数并列 ─────────────────────────────────────────────────────────────
printf '\n══ 读数并列（§ 20 的 S3 三条验证）══\n'
printf '  %-14s %-12s %10s %10s %8s %8s %-10s\n' agent 档 'fork ms' 'ensure ms' 落地 verify-mat 全树摘要
for a in $AGENTS; do
  lbl=$(label "$a")
  printf '  %-14s %-12s %10s %10s %8s %8s %-10s\n' "$a" "$(jget "$OUT/fork-$lbl.json" strategy)" \
    "$(jget "$OUT/fork-$lbl.json" ms)" "$(jget "$OUT/ensure-$lbl.json" ms)" "$(jget "$OUT/ensure-$lbl.json" touched)" \
    "$(jget "$OUT/verify-$lbl.json" ok)" "$(printf '%s' "$(treehash "$OUT/ref/$lbl")" | cut -c1-8)"
done

if [ "${KEEP:-0}" = "1" ]; then
  printf '\n工作区留在 %s（读数与参照树在 %s）\n' "$WORK" "$OUT"
else
  cd / || exit 1
  for w in $(awk '{print $2}' /proc/self/mounts | grep "^$WORK/" || true); do
    sudo -n umount -l "$w" 2>/dev/null || umount -l "$w" 2>/dev/null || true
  done
  rm -rf "$WORK" "$OUT"
fi
printf '\n%s\n' "$([ "$FAIL" = 0 ] && echo '走查全部通过' || echo "$FAIL 项不通过")"
exit "$([ "$FAIL" = 0 ] && echo 0 || echo 1)"
