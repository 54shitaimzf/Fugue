#!/bin/bash
# 仓库哈希格式探测（0.2.6 ⑤ 的取证件）。问的是一句话：
# **sha256 对象库里，视图那一侧自己算的 blob id 还能不能用。**
#
# 零依赖、零改动、可重跑；跑完自己清干净。读数进 0.2.6 ⑥ 的提交正文。
set -u
GIT=$(command -v git)
REPO=$(cd "$(dirname "$0")/.." && pwd)
CLI="$REPO/src/cli/fugue.ts"
W=$(mktemp -d /tmp/probe-hashfmt.XXXXXX)
trap 'rm -rf "$W"' EXIT

echo "git --version : $($GIT --version)"
echo "本仓库格式    : $($GIT -C "$REPO" rev-parse --show-object-format)"

# 同一个内容在两把尺下的 id：`view.ts` 的 `blobIdOf` 用的是 sha1 那一条。
node -e '
const {createHash} = require("node:crypto")
const b = Buffer.from("第一版\n")
const h = createHash("sha1")
h.update(Buffer.from("blob " + b.length + "\0", "utf8")); h.update(b)
console.log("内容 第一版\\n 的两把 id：")
console.log("  view.blobIdOf 算的（sha1 口径）:", h.digest("hex"))
'

one() {
  local fmt=$1 d="$W/$1" w c out head blob
  mkdir -p "$d"; cd "$d" || return 1
  if ! $GIT init -q "--object-format=$fmt" . 2>&1; then
    echo "[$fmt] git init 不支持这一档——探测到此为止"; return 1
  fi
  $GIT config user.email a@b.example; $GIT config user.name t
  printf '第一版\n' | node "$CLI" write a.txt --stdin > /tmp/probe-hashfmt-w.log 2>&1; w=$?
  out=$(node "$CLI" commit -m 一号 2>&1); c=$?
  echo
  echo "########## $fmt ##########"
  echo "  git rev-parse --show-object-format : $($GIT rev-parse --show-object-format)"
  echo "  git 的空树 id                      : $($GIT hash-object -t tree /dev/null)"
  echo "  git 给「第一版\\n」的 blob id        : $(printf '第一版\n' | $GIT hash-object --stdin)"
  echo "  fugue write   EXIT=$w"
  echo "  fugue commit  EXIT=$c"
  echo "  commit 说的话：$(printf '%s' "$out" | head -1)"
  # 问 `refs/heads/main` 而不是 `HEAD`：`git init` 的缺省分支名可能还是 master，
  # 而 fugue 推进的是 main——HEAD 这时是"未出生"的，问它会得到一句与本题无关的
  # `Not a valid object name HEAD`。
  head=$($GIT rev-parse --verify refs/heads/main 2>/dev/null || true)
  echo "  refs/heads/main : ${head:-（没有提交）}"
  echo "  git ls-tree -r main : $($GIT ls-tree -r main 2>&1 | head -2)"
  echo "  git 读得回文件内容吗 : $($GIT cat-file -p main:a.txt 2>&1 | head -1)"
  blob=$(node "$CLI" log --json 2>/dev/null | node -e '
let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
  const rows=s.trim().split("\n").filter(Boolean).map((l)=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
  const last=rows.filter((r)=>r.e && r.e.t==="view/write").pop()
  console.log(last ? String(last.e.blob) : "（没有）")})')
  echo "  日志里 view/write 的 blob 长度     : ${#blob}（${blob:0:16}…）"
}

one sha1
one sha256

echo
echo "########## 读数怎么读 ##########"
echo "  · sha1 那一档是**对照**：同一串命令走通，HEAD 上看得见 a.txt。"
echo "  · sha256 那一档里，日志自己记的 blob 是 64 位（git 给的），"
echo "    而视图重建树时用的是自己算的 40 位——git 只认 64 位，于是当场拒。"
