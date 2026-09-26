#!/bin/sh
# 一趟真档：**从一份声明式的场景文件把工作区搭出来，跑一轮，把读数摊开**。
#
# 跑法：
#   cd ~/fugue
#   sh tools/live-round.sh tools/live-w11.json                       # 打桩档（不出网 · 不花钱）
#   sh tools/live-round.sh tools/live-w11.json --live                # 真档（要凭据 · 花钱）
#   sh tools/live-round.sh tools/live-w11.json --live --max-steps 4  # 压小上界
#   sh tools/live-round.sh tools/live-w11.json --break-a-zone        # 破坏对照：A 区改一个字节
#   sh tools/live-round.sh tools/live-w11.json --wire-in <目录>       # 回放档：把录下来的响应喂回去
#
# 末两个开关是取证用的：
#   `--break-a-zone` 往 `<工作区>/AGENTS.md` 尾部加一个字节——A 区第一个段（「项目方针」，
#     `src/assemble/contract.ts:69`）就是它的字节，于是这一趟的 A 区与前一趟差一个字节。
#     用来验"第 0 步那处命中确实落在前缀上"（PLAN § 5.9.1：命中掉不下去，说明命中的不是前缀）。
#   `--wire-in <目录>` 走回放那一档（不出网 · 不读凭据 · 要 `<目录>` 是某趟 `--dump-wire` 的落点），
#     两个开关一起给时以回放为准（`round run` 自己就拒 `--live` 与 `--wire-in` 同时给）。
#
# 它做的事（PLAN § 5.18 那张「真实场景验证清单」，逐条对应）：
#   一 · 场景文件里的 `base` 铺成工作区（真仓库 · 主线叫 `main`：`refFor` 用的是 `refs/heads/main`，
#        而 `git init` 的缺省分支是 `master`——不搬的话轮次起头就说「HEAD 还不存在」）
#   二 · `round.assertions` 与 `round.split` 从场景文件取（配置是工作区的输入，不是它的状态）
#   三 · **观察命令在真档那一趟被用掉**：先 `status --once`（起头那一刻的处境），再起
#        `watch --follow` 在后台跟着账——它是一条纯读路径，不取锁，所以与那一轮并行是安全的
#   四 · 跑那一轮（`--report` · `--metrics` · `--dump-wire <OUT>/wire`，落点在**工作区之外**）
#   五 · 收尾再 `status --once`，然后把读数摊开：轮次 · 推进（写/删/跳过）· 验收 · 工作树与
#        定格那个提交 · 三区指纹 · 用量 · 打回三个数与八元指标
#
# 凭据经环境变量给（`authOf` 唯一取值处），**从不打印它的值**。
set -u
SC=${1:-}
if [ -z "$SC" ] || [ ! -f "$SC" ]; then
  echo "跑法：sh tools/live-round.sh <场景.json> [--live] [--max-steps <n>] [--work <dir>] [--out <dir>]"
  exit 2
fi
shift
LIVE=no
MAXOVERRIDE=
WIREIN=
BREAK=no
WS=/tmp/live-w11
OUT=/tmp/live-w11-out
while [ $# -gt 0 ]; do
  case "$1" in
    --live) LIVE=yes ;;
    --max-steps) MAXOVERRIDE=$2; shift ;;
    --wire-in) WIREIN=$2; shift ;;
    --break-a-zone) BREAK=yes ;;
    --work) WS=$2; shift ;;
    --out) OUT=$2; shift ;;
    *) echo "不认这个开关：$1"; exit 2 ;;
  esac
  shift
done

HERE=$(cd "$(dirname "$0")/.." && pwd)
SCABS=$(cd "$(dirname "$SC")" && pwd)/$(basename "$SC")
CLI="src/cli/fugue.ts"

rm -rf "$WS" "$OUT"
mkdir -p "$WS" "$OUT"

# 一 · 工作区：主分支 + 底提交（场景文件里的 base 就是底那一棵树）
node -e '
const fs = require("fs"), path = require("path")
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const ws = process.argv[2]
for (const f of s.base) {
  const p = path.join(ws, f.path)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, f.text)
}
process.stdout.write(String(s.goal) + "\n")
process.stdout.write(JSON.stringify(s.split) + "\n")
process.stdout.write(JSON.stringify(s.assertions) + "\n")
process.stdout.write(String(s.maxSteps ?? 6) + "\n")
' "$SCABS" "$WS" > "$OUT/scenario.txt" || exit 9
if [ "$BREAK" = yes ]; then
  # 破坏对照：A 区第一个段（「项目方针」= AGENTS.md 的字节）多一个字节。
  # 这个字节进得了 A 区、进不了任何断言——它只用来把"第 0 步命中"打掉。
  printf ' ' >> "$WS/AGENTS.md" || exit 9
fi
GOAL=$(sed -n 1p "$OUT/scenario.txt")
SPLIT=$(sed -n 2p "$OUT/scenario.txt")
ASSERT=$(sed -n 3p "$OUT/scenario.txt")
MAXSTEPS=$(sed -n 4p "$OUT/scenario.txt")
if [ -n "$MAXOVERRIDE" ]; then MAXSTEPS=$MAXOVERRIDE; fi

cd "$WS" || exit 9
git init -q .
# `.fugue/` 是这一格的账，不进提交（与 walkthrough 那几份靶子同一个约定）。
printf '.fugue/\n' >> .git/info/exclude
git symbolic-ref HEAD refs/heads/main
git config user.email fugue@localhost
git config user.name fugue
git add -A
git commit -qm '底' || exit 9
BASE=$(git rev-parse HEAD)
cd "$HERE" || exit 9

node "$CLI" --root "$WS" config set round.id r1 > "$OUT/config.log" 2>&1
node "$CLI" --root "$WS" config set round.assertions "$ASSERT" >> "$OUT/config.log" 2>&1
node "$CLI" --root "$WS" config set round.split "$SPLIT" >> "$OUT/config.log" 2>&1

{
  echo "=== 场景 ==="
  echo "工作区 $WS · 读数 $OUT · 主线 $BASE"
  echo "目标：$GOAL"
  echo "格数：$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$SPLIT")"
  echo "上界：--max-steps $MAXSTEPS（档：$LIVE$([ -n "$WIREIN" ] && echo " · 回放 $WIREIN")$([ "$BREAK" = yes ] && echo " · A 区已改一个字节")）"
  echo
  echo "=== status --once（起头那一刻）==="
  node "$CLI" --root "$WS" status --once
} > "$OUT/before.txt" 2>&1

# 三 · 观察命令上场：跟随后台起，与那一轮并行
node "$CLI" --root "$WS" watch --follow --interval 200 > "$OUT/watch.log" 2>&1 &
WATCH=$!
sleep 1

LIVEFLAG=
if [ "$LIVE" = yes ]; then LIVEFLAG=--live; fi
WIREFLAG=
if [ -n "$WIREIN" ]; then WIREFLAG="--wire-in $WIREIN"; fi
KEY=""
if [ "$LIVE" = yes ]; then KEY=$(cat /home/ubuntu/.fugue/credentials/deepseek.key); fi
DEEPSEEK_API_KEY="$KEY" node "$CLI" --root "$WS" round run "$GOAL" \
  $LIVEFLAG $WIREFLAG --max-steps "$MAXSTEPS" --report --metrics --dump-wire "$OUT/wire" > "$OUT/run.log" 2>&1
RUNEXIT=$?

# **先等一趟轮询再收跟随者**：跟随是"再看一眼"，而收尾那一条（`round/state` 的最后一次转移）
# 写在那一轮返回之前的最后一刻——立刻杀就会漏掉它。实测：头两趟各差一条，差的都是这条
# （`watch` 44 行对账上 45 条 · 48 对 49），第三趟 70 对 70 全中。
sleep 1
kill "$WATCH" 2>/dev/null
wait "$WATCH" 2>/dev/null

{
  echo "=== 那一轮（EXIT=$RUNEXIT）==="
  cat "$OUT/run.log"
  echo
  echo "=== status --once（收尾那一刻）==="
  node "$CLI" --root "$WS" status --once
  echo
  echo "=== 跟着账的那一条（watch --follow 的行数）==="
  wc -l < "$OUT/watch.log"
  echo
  echo "=== 工作树（底 → 收尾）==="
  cd "$WS" || exit 9
  git --no-pager log --oneline
  echo "--- 工作树 vs 定格那个提交（两棵树的哈希；相等 = 保留前缀之外逐字节一致）---"
  # **不读 `git status`**：`fugue commit` 走的是 plumbing，git 索引留在底那一版，于是 `git status`
  # 是瞎红（实测 L4 那一趟：产物一模一样，它却报 `MM src/format.ts` / `AD legacy/old-format.js`）。
  # 按工作树现算一棵树来比（`GIT_INDEX_FILE` 另起一份，不动它的索引）。
  IDX=/tmp/live-round-idx.$$
  rm -f "$IDX"
  GIT_INDEX_FILE="$IDX" git add -A -- . ':(exclude).fugue' 2>/dev/null
  WTTREE=$(GIT_INDEX_FILE="$IDX" git write-tree)
  HEADTREE=$(git rev-parse 'HEAD^{tree}')
  echo "工作树 $WTTREE · 定格提交 $HEADTREE"
  if [ "$WTTREE" = "$HEADTREE" ]; then echo "一致 ✓"; else echo "不一致 ✗"; GIT_INDEX_FILE="$IDX" git diff --name-status "$HEADTREE" "$WTTREE" | head -20; fi
  rm -f "$IDX"
  echo "--- 盘上 src/format.ts ---"
  cat src/format.ts
  echo "--- 盘上 src/total.ts ---"
  cat src/total.ts
  echo "--- legacy/ 还在吗 ---"
  ls legacy 2>&1 || true
  echo "--- 收尾提交的树（保留前缀之外）---"
  git --no-pager ls-tree -r --name-only HEAD
} > "$OUT/after.txt" 2>&1

echo "EXIT=$RUNEXIT"
echo "读数：$OUT/before.txt · $OUT/run.log · $OUT/after.txt · $OUT/watch.log · $OUT/wire/"
