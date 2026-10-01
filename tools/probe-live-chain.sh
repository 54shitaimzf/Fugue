#!/bin/sh
# **一条真档完整链**：`round plan --live`（持轮者自己拆）→ 门停住 → `round go`（放行）→
# `round work --live` **接着跑**（契约与底从日志读回）→ 真产物 · 真断言 · 工作树与定格提交逐字节一致。
#
# 它量的是用户那条指令里的三样，**不是夹具档的定值**：
#
#   一 · **正确率**：判据 ⑥ 的**收敛率**（每一格的停因是 `end-turn` 而不是"到了你给的上界"）
#        × **验收通过率**（`pass / (pass + fail + unrunnable)`）——加上"真人看得见的那两件事"：
#        真产物落在真实工作树上 · 工作树与定格那个提交逐字节一致。
#   二 · **打回率**：`--report` 那三个数（`conflicts` · `rejects` · `denied`，从日志重算）
#        + **门退回**（`round plan` 那一趟判没通过几次）。三个数各自独立，不合成一个"率"
#        （`probe/round.ts` 那一句：分母没有定论）。
#   三 · **错误成本**：白烧的格（有几格是被打回之后重跑的 · 有几格在复用时没重跑）+ `llm/call`
#        条数与四个用量数（**逐 writer 摊开**：哪一格花的钱看得见）+ 八元指标里那两条
#        （`detour-rate` 绕路率 · `zero-tool-call-rate`）。
#
# 靶子是一份真能改的小仓库：`src/greet.js` 只会说"你好，X"，`check/` 底下三份检查现在**都不通过**
# ——目标是让它们通过。所以"验收通过"这句话在这一趟里算数：改动不到位就是红。
#
# 跑法：cd ~/fugue && sh tools/probe-live-chain.sh            （要凭据 · 花钱）
#       PLANMAX=12 WORKMAX=8 sh tools/probe-live-chain.sh      （上界；缺省就是这两个数）
#       SEED=1 sh tools/probe-live-chain.sh                    （只铺靶子不跑：看现场长什么样）
#       KEEP=1 sh tools/probe-live-chain.sh                    （留下现场）
# **取证用，不是产品的一部分**（仓库约定 § 七）。
set -u
cd /home/ubuntu/fugue || exit 9
PLANMAX=${PLANMAX:-12}
WORKMAX=${WORKMAX:-8}
GOAL='让 check/ 底下那三份检查都通过：src/greet.js 的 greet 要接第三个参数 options（greeting 缺省 你好 · punct 缺省 ！），拼出来是 greeting + ， + name + punct；README.md 里补一句怎么用。'
W=$(mktemp -d /tmp/fugue-chain-XXXXXX)
T=$(mktemp -d /tmp/fugue-chain-out-XXXXXX)
PASS=0
FAIL=0
N=0
RC=0
F() { node src/cli/fugue.ts --root "$W" "$@"; }

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
check() {
  a=$(printf %s "$2" | tr -d ' \n')
  b=$(printf %s "$3" | tr -d ' \n')
  if [ "$a" = "$b" ]; then ok "$1：$b"; else bad "$1：期望 $a，实得 $b"; fi
}
has() { if grep -q "$2" "$1"; then ok "$3"; else bad "$3"; fi }
atmost() { if [ "$2" -le 1 ]; then ok "$1：rc=$2（≤ 1）"; else bad "$1：rc=$2 不在 0/1 之内"; fi }
# **git 说的话留着**：树哈希偶尔取回空（刚卸完沙箱那一刻），而空值与"两棵树不同"在读数上
# 长得一样——所以这里不吞掉 stderr，收进一份文件，取回空时印出来（不然这一条红了也说不清）。
tree_now() {
  rm -f "$T/tree-index" "$T/git-says.txt"
  GIT_INDEX_FILE="$T/tree-index" git -C "$1" add -A >> "$T/git-says.txt" 2>&1
  GIT_INDEX_FILE="$T/tree-index" git -C "$1" write-tree 2>> "$T/git-says.txt"
}
head_tree() { git -C "$1" rev-parse 'refs/heads/main^{tree}' 2> /dev/null; }

cat > "$T/chain.js" <<'ZZEOF'
// 真档链那一份的取证小工具：读日志 · 读两张 JSON 面 · 数账。**不是产品的一部分。**
const fs = require('node:fs')
const path = require('node:path')

function rowsOf(ws) {
  const dir = path.join(ws, '.fugue', 'log')
  if (!fs.existsSync(dir)) return []
  const out = []
  const walk = (base, rel) => {
    for (const ent of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(base, ent.name)
      const one = rel === '' ? ent.name : rel + '/' + ent.name
      if (ent.isDirectory()) walk(abs, one)
      else if (one.endsWith('.jsonl')) {
        // writer 名 = 相对 `.fugue/log/` 那一条路径去掉 `.jsonl`（身份名本身是一条路径）。
        const writer = one.slice(0, -'.jsonl'.length)
        for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
          if (line.trim() === '') continue
          let r
          try { r = JSON.parse(line) } catch { continue }
          out.push({ writer, e: r.e ?? r })
        }
      }
    }
  }
  walk(dir, '')
  return out
}

function stateOf(ws) {
  let s = 'Idle'
  for (const { e } of rowsOf(ws)) if (e.t === 'round/state') s = e.to
  return s
}

/** 处境那条链：`from──on──>to` 逐条（放行走了哪两条边 · 打回那条回边走没走）。 */
function trailOf(ws) {
  const out = []
  for (const { e } of rowsOf(ws)) {
    // 日志里那条事件只有 `from` 与 `to`（`on` 那一栏是 `--json` 那一面从转移表上补的）。
    if (e.t === 'round/state') out.push(e.on === undefined ? `${e.from}──>${e.to}` : `${e.from}──${e.on}──>${e.to}`)
  }
  return out
}

/** 逐 writer 的账：`llm/call` 几条 · 四个用量数。**哪一格花的钱看得见。** */
function ledgerOf(ws) {
  const per = new Map()
  for (const { writer, e } of rowsOf(ws)) {
    if (e.t !== 'llm/call') continue
    const one = per.get(writer) ?? { calls: 0, input: 0, read: 0, write: 0, output: 0 }
    one.calls += 1
    const u = e.usage ?? {}
    one.input += u.inputTokens ?? 0
    one.read += u.cacheReadTokens ?? 0
    one.write += u.cacheWriteTokens ?? 0
    one.output += u.outputTokens ?? 0
    per.set(writer, one)
  }
  return per
}

function ledgerLine(ws) {
  const per = ledgerOf(ws)
  const total = { calls: 0, input: 0, read: 0, write: 0, output: 0 }
  const parts = []
  for (const [w, one] of [...per.entries()].sort()) {
    for (const k of Object.keys(total)) total[k] += one[k]
    parts.push(`  ${w}：${one.calls} 次 · input ${one.input} · cacheRead ${one.read} · cacheWrite ${one.write} · output ${one.output}`)
  }
  return { total, lines: parts }
}

function face(ws, file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const v = j.verify ?? {}
  const yes = (n) => (n === null || n === undefined ? '—' : String(n))
  const out = []
  out.push(`处境 ${j.state} · 契约 ${(j.contracts ?? []).length} 份（${(j.contracts ?? []).map((c) => c.id).join(' · ')}）`)
  out.push(`验收：通过 ${v.pass} · 没通过 ${v.fail} · 跑不起来 ${v.unrunnable} · ok=${String(v.ok)}`)
  out.push(`折叠：${j.fold && j.fold.kind === 'folded' ? `折了 ${j.fold.steps} 步` : '停在冲突上'}`)
  out.push(`推进：${j.advanced === null ? '没有（验收没过）' : `写 ${j.advanced.written.length} 条 · 删 ${j.advanced.removed.length} 条 · 跳过 ${j.advanced.skipped.length} 条`}`)
  out.push(`停因（每一格为什么停）：${(j.agents ?? []).length === 0 ? '（没有读数）' : (j.agents ?? []).map((a) => `${a.agent} ${a.steps} 步 · ${a.stopped}`).join(' ｜ ')}`)
  out.push(`打回三数：${(j.report ?? []).map((r) => `${r.metric} ${r.count}`).join(' · ')}`)
  out.push(`八元指标：${(j.metrics ?? []).map((m) => `${m.metric} ${m.value === null ? '算不出来' : m.value}（${m.numerator ?? '—'}/${m.denominator ?? '—'}）`).join(' · ')}`)
  for (const a of j.assertions ?? []) out.push(`  断言 ${a.verdict}\t${a.assertion}\t${a.note ?? ''}`)
  return out.join('\n')
}

/** 收敛率与验收通过率：**分母一起印**（不然两个比率各自能骗人）。 */
function rates(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const stops = j.agents ?? []
  const settled = stops.filter((a) => String(a.stopped).includes('收敛')).length
  const v = j.verify ?? {}
  const all = (v.pass ?? 0) + (v.fail ?? 0) + (v.unrunnable ?? 0)
  return {
    cells: stops.length,
    settled,
    pass: v.pass ?? 0,
    all,
  }
}

const [cmd, ws, arg] = process.argv.slice(2)
if (cmd === 'state') process.stdout.write(stateOf(ws))
else if (cmd === 'trail') process.stdout.write(trailOf(ws).join(' , '))
else if (cmd === 'ledger') {
  const l = ledgerLine(ws)
  process.stdout.write(`合计 ${l.total.calls} 次 · input ${l.total.input} · cacheRead ${l.total.read} · cacheWrite ${l.total.write} · output ${l.total.output}`)
}
else if (cmd === 'ledger-lines') process.stdout.write(ledgerLine(ws).lines.join('\n'))
else if (cmd === 'face') process.stdout.write(face(ws, arg))
else if (cmd === 'rates') {
  const r = rates(ws)
  process.stdout.write(`格 ${r.cells} · 收敛 ${r.settled} · 验收通过 ${r.pass}/${r.all}`)
}
else if (cmd === 'contracts' || cmd === 'fingerprint' || cmd === 'trail-json') {
  // 这三个读的是**一份 JSON 面**，文件在 `ws` 那一格（`arg` 是给 `face` / `rates` 用的）。
  const j = JSON.parse(fs.readFileSync(ws, 'utf8'))
  if (cmd === 'contracts') process.stdout.write(String((j.contracts ?? []).length))
  else if (cmd === 'fingerprint') process.stdout.write(String(j.fingerprint))
  else process.stdout.write((j.trail ?? []).map((t) => `${t.from}──${t.on}──>${t.to}`).join(','))
}
else { process.stderr.write('不认这个动作：' + cmd + '\n'); process.exit(2) }
ZZEOF

echo "=== 一 · 靶子（一份方针 + 一个小仓库 + 三份现在不通过的检查）==="
mkdir -p "$W/.git/info" "$W/src" "$W/check"
printf '.fugue/\n' > "$W/.git/info/exclude"
cat > "$W/AGENTS.md" <<'ZZEOF'
# 项目方针（真档链取证用）

- 这一仓的活是改文件：要改就改在仓库里；写完要核就直接 `cat` 它，或者跑 `check/` 底下那一份。
- 不要列目录、不要看时间戳、不要 `pwd`。
ZZEOF
cat > "$W/src/greet.js" <<'ZZEOF'
'use strict'

/** 打招呼。**今天只会说"你好，X"**——options 是这一趟要加的那一样。 */
function greet(name) {
  return '你好，' + name
}

module.exports = { greet }
ZZEOF
cat > "$W/README.md" <<'ZZEOF'
# 小仓库

只有一件事：`src/greet.js` 里的 `greet(name)`。

## 怎么跑

    node -e "console.log(require('./src/greet.js').greet('小明'))"
ZZEOF
cat > "$W/check/greet-default.js" <<'ZZEOF'
'use strict'
// 缺省那一档：`greet('小明')` 要说「你好，小明！」
const { greet } = require('../src/greet.js')
const got = greet('小明')
const want = '你好，小明！'
if (got !== want) {
  console.error('实得 ' + JSON.stringify(got) + ' · 要的是 ' + JSON.stringify(want))
  process.exit(1)
}
ZZEOF
cat > "$W/check/greet-options.js" <<'ZZEOF'
'use strict'
// options 那一档：greeting 与 punct 都能换。
const { greet } = require('../src/greet.js')
const got = greet('小明', { greeting: '早上好', punct: '。' })
const want = '早上好，小明。'
if (got !== want) {
  console.error('实得 ' + JSON.stringify(got) + ' · 要的是 ' + JSON.stringify(want))
  process.exit(1)
}
ZZEOF
cat > "$W/check/readme.js" <<'ZZEOF'
'use strict'
// README 里要有一句怎么用（出现 `greet(` 且出现 `options`）。
const fs = require('node:fs')
const text = fs.readFileSync(require('node:path').join(__dirname, '..', 'README.md'), 'utf8')
for (const one of ['greet(', 'options']) {
  if (!text.includes(one)) {
    console.error('README 里找不到 ' + JSON.stringify(one))
    process.exit(1)
  }
}
ZZEOF
printf '  # —— 靶子里的文件 ——\n'
find "$W" -path "$W/.git" -prune -o -path "$W/.fugue" -prune -o -type f -print | sed "s|^$W/|  # |"
(
  cd "$W" && git init -q . && git symbolic-ref HEAD refs/heads/main &&
    git config user.email fugue@localhost && git config user.name fugue &&
    git add -A && git commit -qm 起点
) || bad "靶子的起点提交"
# 三份检查**现在都不通过**：这一条是"验收通过"这句话的判据（负对照）。
for one in greet-default greet-options readme; do
  if (cd "$W" && node "check/$one.js" > /dev/null 2>&1); then
    bad "起点上 check/$one.js 就通过了——那这一趟量不出「改对了没有」"
  else
    ok "起点上 check/$one.js 不通过（改对了才会变绿）"
  fi
done

F config set round.id r1 > /dev/null || bad "靶子配置：round.id"
F config set actions.greet_default '{"argv":["node","check/greet-default.js"],"outputs":[]}' > /dev/null || bad "靶子配置：greet_default"
F config set actions.greet_options '{"argv":["node","check/greet-options.js"],"outputs":[]}' > /dev/null || bad "靶子配置：greet_options"
F config set actions.readme_how '{"argv":["node","check/readme.js"],"outputs":[]}' > /dev/null || bad "靶子配置：readme_how"

if [ "${SEED:-0}" = "1" ]; then
  printf '（SEED=1：只铺靶子不跑 · %s）\n' "$W"
  exit 0
fi

# 一趟：跑一条命令，把它那几行摊开，再把账与处境印出来。
run() {
  seg=$1
  name=$2
  shift 2
  N=$((N + 1))
  OUT="$T/run-$N.out"
  echo
  printf '=== %s · %s\n' "$seg" "$name"
  F "$@" > "$OUT" 2> "$T/run-$N.err"
  RC=$?
  printf '  rc = %s · 处境 %s\n' "$RC" "$(node "$T/chain.js" state "$W")"
  sed 's/^/  | /' "$OUT"
  sed 's/^/  err| /' "$T/run-$N.err"
  printf '  账（累计）：%s\n' "$(node "$T/chain.js" ledger "$W")"
}

echo
echo "=== 二 · 持轮者自己拆（round plan --live · 上界 $PLANMAX 步）==="
run ① "round plan --live（目标那一句 · 上界 $PLANMAX）" round plan "$GOAL" --live --max-steps "$PLANMAX"
atmost '①' "$RC"
has "$T/run-1.out" '收工：' '① 报出了收工那一句'
if grep -q '停在门口' "$T/run-1.out"; then
  ok '① 停在门口等人批'
elif grep -q '退回' "$T/run-1.out"; then
  bad "① 被退回了（门退回 +1）——去看那几行：$(grep -m3 '退回' "$T/run-1.out" | tr '\n' ' ')"
else
  bad '① 既没停在门口也没退回'
fi
printf '  ① 之后处境：%s\n' "$(node "$T/chain.js" state "$W")"
printf '  日志里 contract/issue 条数（放行之前该是 0）：%s\n' "$(grep -c 'contract/issue' "$W/.fugue/log/round.jsonl" 2> /dev/null || true)"
check '① 门停着：一个契约都没发' '0' "$(grep -c 'contract/issue' "$W/.fugue/log/round.jsonl" 2> /dev/null || true)"
check '① 处境' 'Planning' "$(node "$T/chain.js" state "$W")"

# 退回那一档：**到不了门**，后面两段量不到任何东西。当场停，把这一趟的账摊完再退。
if ! grep -q '停在门口' "$T/run-1.out"; then
  echo
  echo "==== ① 退回了：门都没到，放行与接着跑那两段没有东西可量"
  printf '  退回的理由：\n'
  sed 's/^/  err| /' "$T/run-1.err"
  printf '  账（合计）：%s\n' "$(node "$T/chain.js" ledger "$W")"
  printf '  账（逐 writer）：\n%s\n' "$(node "$T/chain.js" ledger-lines "$W")"
  printf 'PASS %s · FAIL %s\n' "$PASS" "$FAIL"
  exit 1
fi

echo
echo "=== 三 · 放行（round go）==="
F --json round go > "$T/go.json" 2> "$T/go.err"
RCG=$?
printf '  rc = %s · 契约 %s 份 · 批号 %s\n' "$RCG" "$(node "$T/chain.js" contracts "$T/go.json")" "$(node "$T/chain.js" fingerprint "$T/go.json")"
printf '  走过的边：%s\n' "$(node "$T/chain.js" trail-json "$T/go.json")"
sed 's/^/  err| /' "$T/go.err"
check '③ 放行的退出码' '0' "$RCG"
check '③ 处境' 'Working' "$(node "$T/chain.js" state "$W")"
NC=$(node "$T/chain.js" contracts "$T/go.json")
check '③ 分支起了几条' "$NC" "$(git -C "$W" for-each-ref --format='%(refname:short)' refs/heads/agent | wc -l | tr -d ' ')"

echo
echo "=== 四 · 放行之后接着跑（round work --live · 每格上界 $WORKMAX 步）==="
F --json --report --metrics round work --live --max-steps "$WORKMAX" > "$T/work.json" 2> "$T/work.err"
RCW=$?
printf '  rc = %s\n' "$RCW"
node "$T/chain.js" face "$W" "$T/work.json" | sed 's/^/  | /'
sed 's/^/  err| /' "$T/work.err"
printf '  账（累计 · 逐 writer 摊开）：\n%s\n' "$(node "$T/chain.js" ledger-lines "$W")"
printf '  账（合计）：%s\n' "$(node "$T/chain.js" ledger "$W")"
printf '  **正确率那一栏**：%s（分母：格数 · 验收条数）\n' "$(node "$T/chain.js" rates "$T/work.json")"

# 一 · 验收过了（rc=0 就是"没过 0 条 · 跑不起来 0 条 · 过的不为 0"）
check '④ 退出码（验收过了才是 0）' '0' "$RCW"
# 二 · 每一格都收敛（判据 ⑥）：不许有一格是"到了你给的上界"
if node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const bad = (j.agents ?? []).filter((a) => !String(a.stopped).includes("收敛"))
process.stdout.write(String(bad.length))
' "$T/work.json" | grep -qx 0; then
  ok "④ 每一格都收敛（停因是 end-turn，不是步数到顶）——判据 ⑥"
else
  bad "④ 有格没收敛：$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((j.agents??[]).filter((a)=>!String(a.stopped).includes("收敛")).map((a)=>a.agent+":"+a.stopped).join(" · "))' "$T/work.json")"
fi
# 三 · 打回三数全 0（真实场景下这三样该是低的：这一趟是两个不同文件的活，撞不上）
if node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const bad = (j.report ?? []).filter((r) => r.count !== 0)
process.stdout.write(String(bad.length))
' "$T/work.json" | grep -qx 0; then
  ok '④ 打回三数全 0（conflicts · rejects · denied）'
else
  bad "④ 打回三数里有非 0：$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((j.report??[]).filter((r)=>r.count!==0).map((r)=>r.metric+"="+r.count).join(" · "))' "$T/work.json")"
fi
# 四 · 真产物落盘：真实工作树上那三份检查现在跑得过（不是在物化树上）
for one in greet-default greet-options readme; do
  if (cd "$W" && node "check/$one.js" > /dev/null 2>&1); then
    ok "④ 真实工作树上 check/$one.js 跑过了"
  else
    bad "④ 真实工作树上 check/$one.js 还是红的：$(cd "$W" && node "check/$one.js" 2>&1 | head -1)"
  fi
done
# 五 · 工作树与定格那个提交逐字节一致（判据 ④）。
# **比树之前先走产品那一份收尾**（`dispose`：先卸后删）：真驱动那一档会在工作区里留物化坐标，
# 而内核自己在 `tmp/work/` 里建的 `work/work` 是 `root:root 000`——`git add -A` 会先 `readdir`
# 它、当场吃 EACCES，于是树哈希取回的是空（走查 s9 头注里那一条同一个根）。
for a in $(git -C "$W" for-each-ref --format='%(refname:short)' refs/heads/agent 2> /dev/null); do
  F --agent "$a" dispose > /dev/null 2>&1
done
TREENOW=$(tree_now "$W")
if [ -z "$TREENOW" ]; then
  printf '  （树哈希取回空 · git 说：）\n'
  sed 's/^/  git| /' "$T/git-says.txt"
  printf '  （工作区根上是这些：）\n'
  ls -la "$W" | sed 's/^/  ls| /'
  sleep 1
  TREENOW=$(tree_now "$W")
  [ -n "$TREENOW" ] && printf '  （退一步重试取到了：%s）\n' "$TREENOW"
fi
check '④ 工作树与 main 那棵树' "$(head_tree "$W")" "$TREENOW"
printf '  **错误成本那一栏**：%s\n' "$(node "$T/chain.js" ledger "$W")"
printf '  **处境链**：%s\n' "$(node "$T/chain.js" trail "$W")"

echo
echo "==== 摊开（写进提交信息的那几行）"
printf '  ① 目标那一句：%s\n' "$GOAL"
printf '  ① 收工：%s\n' "$(grep -m1 '收工：' "$T/run-1.out" | sed 's/^ *//')"
printf '  ③ 放行：契约 %s 份 · 批号 %s\n' "$NC" "$(node "$T/chain.js" fingerprint "$T/go.json")"
printf '  ④ 接着跑：rc=%s · %s\n' "$RCW" "$(node "$T/chain.js" rates "$T/work.json")"
printf '  ④ 停因：%s\n' "$(node "$T/chain.js" face "$W" "$T/work.json" | grep '停因' | sed 's/^ *//')"
printf '  ④ 打回三数：%s\n' "$(node "$T/chain.js" face "$W" "$T/work.json" | grep '打回三数' | sed 's/^ *//')"
printf '  ④ 八元指标：%s\n' "$(node "$T/chain.js" face "$W" "$T/work.json" | grep '八元指标' | sed 's/^ *//')"
printf '  账（合计）：%s\n' "$(node "$T/chain.js" ledger "$W")"
printf '  账（逐 writer）：\n%s\n' "$(node "$T/chain.js" ledger-lines "$W")"
printf 'PASS %s · FAIL %s\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ] || exit 1
exit 0
