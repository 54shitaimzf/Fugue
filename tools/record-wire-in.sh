#!/bin/sh
# 重录 `src/cli/__fixture__/wire-in/`：**真跑一趟**，把 `--dump-wire` 落下的那几份原始字节收进夹具。
#
# 为什么要有这一条命令：夹具绑的是**录制那一版的请求字节**（`src/model/http.ts` 的
# `wireInTransport` 按 `requestHash` 逐字节核），于是前缀或契约一变它就过期——`src/cli/chain.test.ts`
# 的「序 1」当场红，而那条命令自己写着"过期不重修"。这一份把"真跑一趟"收成一条命令：照
# `scenario.json` 搭一份工作区 → 真跑 `round run --live` → 把 dump 收进 `wire/` → 照新产物更新
# `scenario.json` 的 `expected`。
#
# **描述类漂移的缺省处置不是这一条，而是离线改齐**（`node tools/align-wire-in.ts`）：动的是目录
# 文案时，请求侧可以逐字节复算——不出网 · 不读凭据 · 不花钱，而快档那条对齐测试
# （`src/cli/wire-in.test.ts`）当场给红绿。这一份脚本留给两种天：**响应侧**要新证据（要新的模型
# 行为对照），或者动的是**参数面/语义**而不只是描述——那时旧响应不再是有意义的对照，离线改齐
# 就成了伪造对照。
#
# 跑法：cd ~/fugue && sh tools/record-wire-in.sh        # 花钱：约 ¥0.02 · 3 次调用 · 依赖网
#       sh tools/record-wire-in.sh --keep               # 现场留着（打印路径）
#
# **它只认一条**：这一趟真的收敛（`agents[0].stopped` 是「收敛」）、验收真的过。不然它**不碰夹具**
# ——一份回放不了的录像比一份过期的录像更坏（后者当场红，前者看着像有用）。
set -u
FUGUE="node src/cli/fugue.ts"
FIX="$PWD/src/cli/__fixture__/wire-in"
KEEP=0
for a in "$@"; do
  case "$a" in
    --keep) KEEP=1 ;;
    *) echo "不认这个开关：$a（这一份的开关只有 --keep）"; exit 2 ;;
  esac
done
[ -f "$FIX/scenario.json" ] || { echo "找不到 $FIX/scenario.json"; exit 2; }

W=$(mktemp -d /tmp/fugue-record-XXXXXX)
D=$(mktemp -d /tmp/fugue-record-wire-XXXXXX)
# **跑这一趟的读写口都在工作区之外**：`out.json` / `err.txt` / `meta.txt` 落在工作区里的话，
# 漂移检会把它们读成"盘上既不是底、也不是这次合并算出来的"两条路径，于是**合并前当场拒**——
# 重录这一步的分工是"真跑一趟"，不是"往靶子里塞文件"（第一次真跑就是这么被拒的：漂移检报
# `err.txt` · `out.json` 两条会被覆盖）。
T=$(mktemp -d /tmp/fugue-record-out-XXXXXX)
# 照 `scenario.json` 搭同一份工作区：底那几份文件 + 一个提交 + 那三条配置。**别的键一条都不设**
# （`系统状态` 那一段照 `projectConfig` 投影，多设一条 A 区的字节就变了，而夹具绑的就是那一串）。
# **每录一趟换一枚"趟次标记"，钉在 A 区第一段（`项目方针`）的第一行上。** 由头：前缀是
# 内容寻址的缓存键，而两次录制的 A/B 区几乎逐字相同——上一趟刚发过的那些字节还在上游的缓存里，
# 于是第 1 次调用照样报 `cacheReadTokens > 0`，`prefix-hit-rate` 就成了平凡的 3/3
# （第二次录制实测撞到：`walkthrough-s8` 的"命中读数是真读数（2/3）"当场红）。标记钉在**第一行**
# 才够：只改中段的话，它前面那一截仍然命中。标记写回 `scenario.json`，回放照同一份搭工作区。
NONCE=$(node -e 'process.stdout.write(require("crypto").randomBytes(4).toString("hex"))')
node -e '
const fs = require("fs")
const file = process.argv[1], nonce = process.argv[2]
const s = JSON.parse(fs.readFileSync(file, "utf8"))
const at = s.base.findIndex((f) => f.path === "AGENTS.md")
if (at >= 0) {
  const lines = s.base[at].text.split("\n")
  lines[0] = lines[0].replace(/（录制趟次[^）]*）/g, "") + "（录制趟次 " + nonce + "）"
  s.base[at].text = lines.join("\n")
}
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n")
' "$FIX/scenario.json" "$NONCE" || exit 9
echo "  趟次标记：$NONCE（前缀从头到尾是新的，第 1 次调用因此是真冷读）"
node -e '
const fs = require("fs"), path = require("path")
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
for (const f of s.base) {
  const p = path.join(process.argv[2], f.path)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, f.text)
}
process.stdout.write(String(s.maxSteps) + "\n" + s.goal + "\n")
' "$FIX/scenario.json" "$W" > "$T/meta.txt" || exit 9
MAX=$(sed -n 1p "$T/meta.txt")
GOAL=$(sed -n 2p "$T/meta.txt")
(cd "$W" && git init -q . && git symbolic-ref HEAD refs/heads/main &&
  git config user.email fugue@localhost && git config user.name fugue &&
  git add -A && git commit -qm 底) || { echo "铺底失败"; exit 9; }
ASSERT=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).assertions))' "$FIX/scenario.json")
SPLIT=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).split))' "$FIX/scenario.json")
$FUGUE --root "$W" config set round.id r1 > /dev/null || exit 9
$FUGUE --root "$W" config set round.assertions "$ASSERT" > /dev/null || exit 9
$FUGUE --root "$W" config set round.split "$SPLIT" > /dev/null || exit 9

echo "=== 真跑一趟（goal=「$GOAL」 · 上界 $MAX · 花钱）==="
$FUGUE --root "$W" --json round run "$GOAL" --live --max-steps "$MAX" --report --metrics --dump-wire "$D" \
  > "$T/out.json" 2> "$T/err.txt"
RC=$?
if [ "$RC" != "0" ]; then
  echo "这一趟退了 $RC——夹具一个字节都没动："
  sed 's/^/  err| /' "$T/err.txt" | tail -20
  echo "（现场留在 $W）"
  exit 1
fi
node -e '
const fs = require("fs")
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const a = (j.agents ?? [])[0]
const ok = j.verify?.ok === true
console.log("  停因：" + String(a?.stopped) + " · 走了 " + String(a?.steps) + " 步 · 验收 " + String(j.verify?.pass) + "/" + String(j.verify?.fail))
if (!ok) { console.error("  验收没过——不收这一趟"); process.exit(1) }
if (a?.stopped !== "收敛") { console.error("  停因不是「收敛」——不收这一趟"); process.exit(1) }
' "$T/out.json" || { echo "（现场留在 $W · dump 在 $D）"; exit 1; }

N=$(ls "$D" | wc -l)
[ "$N" -ge 1 ] || { echo "dump 里一份调用都没有：$D"; exit 1; }
echo "  录到 $N 次调用 · $(node tools/scenario/board-node.ts usage "$W" 2>/dev/null || echo 账没读出来)"

rm -rf "$FIX/wire"
cp -r "$D" "$FIX/wire"
node -e '
const fs = require("fs")
const file = process.argv[1], root = process.argv[2]
const s = JSON.parse(fs.readFileSync(file, "utf8"))
const out = {}
for (const k of Object.keys(s.expected ?? {})) {
  try { out[k] = fs.readFileSync(require("path").join(root, k), "utf8") }
  catch { out[k] = s.expected[k] }
}
s.expected = out
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n")
console.log("  scenario.json 的 expected 照这一趟的产物更新：" + Object.keys(out).join(" · "))
' "$FIX/scenario.json" "$W" || exit 1

echo "=== 夹具换新（$FIX/wire）==="
echo "  接着跑：node --test src/cli/chain.test.ts"
if [ "$KEEP" = "1" ]; then echo "  现场：$W · dump：$D · 读数：$T"; else rm -rf "$W" "$D" "$T"; fi
exit 0
