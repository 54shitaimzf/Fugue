#!/bin/sh
# S9 的端到端走查（PLAN § 5.11 的 C6 · § 5.12 补完清单序 9 · 架构 § 15.1.a）。
#
# **一条命令跑完**（夹具档 · 不出网 · 不读凭据 · 一分钱不花）：
#   持轮者那一档（`$W`）：讨论态说一句 → 理解改了（Harness 判自然结束）→ 人写草案 + `--judge`
#     （人喊停那一档 · 也是这一站的地板）→ `round plan` 模型交卷（declared）
#     → 上界那一档（`--max-steps 1` · 步数到顶）→ 预备态说一句（改草案 · 重判 · 门再停一次 ·
#     版本那一栏印得到"第 3 版"与差异）→ `round go` 放行（契约逐条 · 分支起来 · 处境 Working）
#     → `round work` **接着跑**（那一批从日志读回 → 跑格 → 验收 → 定格 + 推进）。
#   地板那一档（`$FW` · 照 `src/cli/__fixture__/wire-in/scenario.json` 搭）：
#     `round run <目标> --wire-in <夹具>` → 真产物落盘 → 两条真断言跑过 → 工作树与定格那个提交
#     逐字节一致。
#
# **持轮者那一趟没有打桩档**（`say` / `round plan` 缺省就走真模型），所以夹具档自己造响应：
# `--wire-in <夹具> --dump-wire <目录>` 把**这一趟真会发出去的那一份请求**落下来（夹具里没有的那
# 一次调用 → 半截流，而请求字节是真的），再照那份请求补一份 `response.sse`（`exit_plan_mode` ·
# `write` · 一段文本），最后拿补齐的夹具重放。**夹具绑的就是那一趟的请求字节**。
#
# 而**一趟可能有不止一次调用**（改草案那一趟：第 1 次调 `write`、第 2 次说话收尾），**一次 dump
# 只能问出第一次**——空夹具在第 1 次调用上就断了。所以要问第 k 次，就得先把前 k-1 份响应造好、
# 再 dump 一遍（那一趟走到第 k 次、断在那里）。`one()` 因此是"逐次 dump + 逐份造"，见那一段。
#
# **dump 与重放要从同一份现场起跑**：dump 那一趟是真的往日志里写（会话记录 · `prefix/assemble` ·
# `llm/call`），而重放读的正是那份日志——不退回的话第二趟的 B 区、C 区就与 dump 那一趟不是同一串
# （实测：讨论态那一趟的会话记录留在日志里，第二趟的"最近几次原文"就多一条原文），于是回放档
# 当场拒："这一份不是那一次请求"。所以 `one()` 在 dump 之前把**整个靶子**拷一份（`$T/moment-N`），
# 每一趟 dump 之前再拷回来。**会话记录不在工作树上**（它在持轮者那份视图里，落在
# `.fugue/log/round.jsonl` 的 `view/write` 那几条上），所以"删掉 `.fugue/session/r1.jsonl`"
# 那条路根本不存在——这正是这一份最早那版报 13 个 FAIL 的根。
#
# **§ 四 量的是"接着跑"**：`round go` 之后那一环归 `round work`——契约与底**从日志读回**
# （`contract/issue` 的正文与 `round/intent` 的底：一句配置都不看、一份契约都不重算），尾巴与
# `round run` 是同一条（`runIssued`）。同一段里还有两条读数：在一轮已经放行（`Working`）的靶子上
# 再起一轮（`round run`），`startRound` 的处境守卫当场拒、**一个字节都不落**（同一批不重复派发）；
# 第二次 `round work` 照旧拒（那批契约已经跑过了）。三条都是量出来的，不拿"放行成功"顶替。
#
# `--live` 那一支：同一串路换真模型跑一遍（每一步真发一次调用）。那一支的断言是**不变量**
# （每条路都收得住并进判 · 退出码 0/1 之内 · **版本那一栏跟着日志里的落地条数走**），不是夹具档
# 那些定值。它与 `tools/live-round.sh` 的关系是**超集**（那边跑的是同一串路、覆盖面更窄）。
#
# **这一支已取证**（`sh tools/probe-live-s9.sh`，三次真档 · `PASS 11 · FAIL 0`），而它量出来的
# 第一件事是一条**缺口**：持轮者拿到的前缀里**没有一处说草案写哪儿 · 什么形状**。那一次
# `--dump-wire` 的实录：`system` 只有 89 字节（项目方针 + `{"entries":[]}`），两条 user 消息就是
# 目标那 16 个字节与一个空的 C 区——全仓 `grep .fugue/plan` 只出现在命令行帮助与代码注释里。
# 于是真模型三次都写不出草案：空仓库那两次是探路（`bash ls -la`）→ `bash` 被拒（预备态没有可执行
# 的树）→ `ask_user_question`（"这份 notes.md 想要的是什么？"），而**"有工具叫停就到这儿为止"**
# （`runtime/step.ts` 那一档，与模型自己说完同归"收敛"）；靶子里有内容那一次是把目标当交付物，
# 把 `notes.md` 写在了仓库根上。三次都按「构造器不猜」退回。**所以 ③ 那一支不断言"版本那一栏
# 印得出"**——它按落地条数分岔，两条都要在（那一段里）。
#
# 用法：sh tools/walkthrough-s9.sh [--live]。退出码 0 且 FAIL 0 才算走通。KEEP=1 留下现场。
set -u
LIVE=no
for a in "$@"; do
  case "$a" in
    --live) LIVE=yes ;;
    *) echo "不认这个开关：$a（这一份的开关只有 --live）"; exit 2 ;;
  esac
done
FUGUE="node src/cli/fugue.ts"
FIX="$PWD/src/cli/__fixture__/wire-in"
W=$(mktemp -d /tmp/fugue-s9-XXXXXX)
FW=$(mktemp -d /tmp/fugue-s9-floor-XXXXXX)
T=$(mktemp -d /tmp/fugue-s9-read-XXXXXX)
PASS=0
FAIL=0
N=0
RC=0

# 收尾先走产品那一份（`fugue dispose`：先卸后删），再删目录——与 S8 同一段理由：真驱动那一档的
# 沙箱会在 `tmp/work/` 里留一个 `root:root 000` 的目录，而 `rm -rf` 会先读它。
cleanup() {
  for d in "$W" "$FW"; do
    for a in $(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads/agent 2> /dev/null); do
      $FUGUE --root "$d" --agent "$a" dispose > /dev/null 2>&1
    done
  done
  if [ "${KEEP:-0}" = "1" ]; then
    printf '（KEEP=1，现场留着：持轮者 %s · 地板 %s · 读数 %s）\n' "$W" "$FW" "$T"
  else
    rm -rf "$W" "$FW" "$T"
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
# **逐字节对账那把尺子**：`fugue commit` 不动 index，所以 `git status` 在这个仓库里恒为空（瞎绿）。
# 要比就比树：工作树临时灌进一个另开的 index、`write-tree`，再与那条分支上的树比 id。
tree_now() { rm -f "$T/tree-index"; GIT_INDEX_FILE="$T/tree-index" git -C "$1" add -A > /dev/null 2>&1; GIT_INDEX_FILE="$T/tree-index" git -C "$1" write-tree 2> /dev/null; }
head_tree() { git -C "$1" rev-parse 'refs/heads/main^{tree}' 2> /dev/null; }
# 日志里那一类事件有几条（grep 那一行 · `t` 那一栏在行里是平的）。
logcount() { grep -c "$1" "$W/.fugue/log/round.jsonl" 2> /dev/null || true; }
# 处境那条链的最后一条 `to` · 处境链上某一条 `from` 走了几次 · 某一版被写过几次——都是重放那份
# 日志的读数，写在 `$T/s9.js` 里一处（行里没有 `.e` 这一层，早先那份按 `.e` 读的取回是空的）。
laststate() { node "$T/s9.js" state "$W/.fugue/log/round.jsonl"; }
loghas() { node "$T/s9.js" count "$W/.fugue/log/round.jsonl" "$1"; }

# 造响应那一段（夹具档用）：把一份**真 dump 下来的请求**旁边补上 `response.sse` 与 `meta.json`
# ——`wire-in` 认的就是这三份（`request.json` · `response.sse` · `meta.json`）。
cat > "$T/s9.js" <<'ZZEOF'
// S9 走查的取证小工具：造响应 · 写草案 · 读日志。它不是产品的一部分。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const hashOf = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)

/** 一条 `event:` + 一条 `data:` + 一个空行 = 一件事（`wire/model/wire/stream.ts` 认的形状）。 */
function craft(reqPath, outDir, specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
  const reqBytes = fs.readFileSync(reqPath)
  const ev = (type, payload) => 'event: ' + type + '\ndata: ' + JSON.stringify(payload) + '\n\n'
  const usage = { input_tokens: 1200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
  let sse = ev('message_start', {
    type: 'message_start',
    message: { id: 's9-1', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage },
  })
  if (spec.kind === 'text') {
    sse += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse += ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: spec.text } })
  } else {
    const args = Object.assign({}, spec.args)
    if (typeof args.contentFile === 'string') args.content = fs.readFileSync(args.contentFile, 'utf8')
    delete args.contentFile
    sse += ev('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_s9', name: spec.name, input: {} },
    })
    sse += ev('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
    })
  }
  sse += ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  sse += ev('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: spec.kind === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null },
    usage: { output_tokens: 24 },
  })
  sse += ev('message_stop', { type: 'message_stop' })
  fs.mkdirSync(outDir, { recursive: true })
  const respBytes = Buffer.from(sse, 'utf8')
  fs.writeFileSync(path.join(outDir, 'request.json'), reqBytes)
  fs.writeFileSync(path.join(outDir, 'response.sse'), respBytes)
  fs.writeFileSync(path.join(outDir, 'request.sha256'), hashOf(reqBytes) + '  request.json\n')
  fs.writeFileSync(path.join(outDir, 'response.sha256'), hashOf(respBytes) + '  response.sse\n')
  fs.writeFileSync(
    path.join(outDir, 'meta.json'),
    JSON.stringify(
      {
        call: 1,
        target: { providerId: 'deepseek', host: '（这一份没出网）', path: '/anthropic/v1/messages', model: 'deepseek-flash', from: 'walkthrough-s9', wire: 'anthropic-messages' },
        model: 'deepseek-flash',
        requestBytes: reqBytes.length,
        requestHash: hashOf(reqBytes),
        responseBytes: respBytes.length,
        responseHash: hashOf(respBytes),
        stop: spec.kind === 'text' ? 'end-turn' : 'tool-calls',
        outcome: 'done',
      },
      null,
      2,
    ) + '\n',
  )
  fs.writeFileSync(
    path.join(outDir, 'README'),
    '这一份是 S9 走查**造**的响应（不是录的）：请求字节来自产品自己 `--dump-wire` 落下来的那一份，\n' +
      '响应照那个请求写死。夹具绑的是请求字节——请求一变它就过期，不过期不重修（重跑走查就重造）。\n',
  )
}

/** 一份草案的正文：一段散文 + 逐节的 `json` 围栏块（`contract/draft.ts` 认的形状）。 */
function draft(prose, outFile) {
  const section = {
    kind: 'implement',
    goal: '写一份 notes.md（内容一行：数完了）。',
    ownedPaths: ['notes.md'],
    deliverables: [{ path: 'notes.md', form: '一份文件' }],
    assertions: [{ name: '文件在', action: 'ok' }],
    seed: [],
  }
  fs.writeFileSync(outFile, prose + '\n\n## 第 1 节\n\n```json\n' + JSON.stringify(section) + '\n```\n')
}

/** 日志里的几笔读数。**行是平的**（`t` 与它那几栏就在最外层，没有 `.e` 这一层）。 */
function rows(logFile) {
  return fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l))
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'craft') craft(args[0], args[1], args[2])
else if (cmd === 'draft') draft(args[0], args[1])
else if (cmd === 'state') {
  const s = rows(args[0]).filter((r) => r.t === 'round/state')
  process.stdout.write(s.length === 0 ? '(一条都没有)' : String(s[s.length - 1].to))
} else if (cmd === 'edges') {
  process.stdout.write(String(rows(args[0]).filter((r) => r.t === 'round/state' && r.from === args[1]).length))
} else if (cmd === 'writes') {
  process.stdout.write(String(rows(args[0]).filter((r) => r.t === 'view/write' && r.path === args[1]).length))
} else if (cmd === 'permanent') {
  // 分法上"进历史"的那十族各有几条。**这里是把它重抄一遍**（走查不 import TS）：两边对不上的
  // 那一天，`tui --once` 的行数与这个数当场不等——那条 check 就是这两处的对账。
  const FAMILIES = [
    'round/state',
    'round/intent',
    'contract/issue',
    'round/approve',
    'agent/stop',
    'agent/handoff',
    'merge/attempt',
    'merge/accept',
    'bound/deny',
    'signal',
  ]
  process.stdout.write(String(rows(args[0]).filter((r) => FAMILIES.includes(r.t)).length))
} else if (cmd === 'count') {
  // 日志里那句话出现几次（"原话不另存"那一档量的就是它——正文那一栏有没有它）。
  let n = 0
  for (const row of rows(args[0])) if (JSON.stringify(row).includes(args[1])) n += 1
  process.stdout.write(String(n))
} else {
  console.error('不认这个子命令：' + String(cmd))
  process.exit(2)
}
ZZEOF

# **一趟持轮者那一趟**（夹具档）：拷现场 → 逐次 dump 真请求 → 每次退回现场 → 造响应 → 重放。
# 留下 `RC` · `FIXD` · `OUTF`。`one <标签> <spec 目录> <命令…>`；`<spec 目录>` 里写这一趟
# 每一次调用该干什么（`call-0001.json` · `call-0002.json` …）。
#
# **为什么要逐次 dump**：一次 dump 只能问出**第一次**调用——空夹具在第 1 次调用上就断了
# （半截流），第 2 次调用根本没发生。要问第 2 次，就得把第 1 次那份响应先造好、再 dump 一遍
# （那一趟会走到第 2 次调用、断在那里）。于是"造第 k 份响应"这件事本身要跑 k 趟 dump。
# **每一趟 dump 都从同一份现场起跑**（`$_moment`）——这就是上面那段注释说的那件事：dump 那一趟
# 真的往日志里写，而重放读的正是那份日志；不退回去，第 2 趟的 B 区就多一条原文，夹具当场过期。
# 那一份"退没退回去"由 `cmp` 当场验：第 k 趟的 `call-0001` 必须与第 1 趟逐字节相同。
one() {
  _label=$1
  _spec=$2
  shift 2
  N=$((N + 1))
  _moment="$T/moment-$N"
  FIXD="$T/fix-$N"
  mkdir -p "$FIXD"
  rm -rf "$_moment"
  cp -a "$W" "$_moment"
  _i=1
  while [ -f "$_spec/$(printf 'call-%04d' "$_i").json" ]; do
    _c=$(printf 'call-%04d' "$_i")
    _d="$T/dump-$N-$_i"
    rm -rf "$W"
    cp -a "$_moment" "$W"
    $FUGUE --root "$W" "$@" --wire-in "$FIXD" --dump-wire "$_d" > "$T/dump-$N-$_i.log" 2>&1
    if [ ! -f "$_d/$_c/request.json" ]; then
      bad "$_label：第 $_i 次调用没走到（$_c 没 dump 出来）"
      RC=9
      return 0
    fi
    if [ "$_i" -gt 1 ]; then
      if cmp -s "$T/dump-$N-1/call-0001/request.json" "$_d/call-0001/request.json"; then
        ok "$_label：第 $_i 趟的 call-0001 与第 1 趟逐字节相同（现场退回去了）"
      else
        bad "$_label：第 $_i 趟的 call-0001 与第 1 趟不是同一份——现场没退回去，夹具会说谎"
      fi
    fi
    node "$T/s9.js" craft "$_d/$_c/request.json" "$FIXD/$_c" "$_spec/$_c.json" || bad "$_label：造响应失败（$_c）"
    _i=$((_i + 1))
  done
  rm -rf "$W"
  cp -a "$_moment" "$W"
  printf '  夹具：造了 %s 份响应（%s）\n' "$((_i - 1))" "$(ls "$FIXD" | tr '\n' ' ')"
  OUTF="$T/run-$N.out"
  $FUGUE --root "$W" "$@" --wire-in "$FIXD" > "$OUTF" 2> "$T/run-$N.err"
  RC=$?
}

# `--live` 那一档：模型是真来的（同一条链 · 同一个判据），夹具那一层换成真网络。
liveone() {
  N=$((N + 1))
  OUTF="$T/run-$N.out"
  $FUGUE --root "$W" "$@" > "$OUTF" 2> "$T/run-$N.err"
  RC=$?
}

echo "=== 一 · 建两份靶子 ==="
# 持轮者那一档：一份方针 + 一个提交 + 四条配置（`round.id` · 绑好的动作 `ok` · 拆分草案与断言
# 那两栏——后两条 § 四 要用：`round run` 是配置那一档的人拆，缺了它连"发不发得出去"都问不到）。
mkdir -p "$W/.git/info"
printf '.fugue/\n' > "$W/.git/info/exclude"
printf '# 项目方针（S9 走查用）\n\n- 交付物写在仓库根上；要核自己刚写的东西就直接 `cat` 它。\n- 不要列目录、不要看时间戳、不要 `pwd`。\n' > "$W/AGENTS.md"
( cd "$W" && git init -q . && git symbolic-ref HEAD refs/heads/main &&
  git config user.email fugue@localhost && git config user.name fugue &&
  git add -A && git commit -qm 起点 ) || bad "持轮者靶子的起点提交"
$FUGUE --root "$W" config set round.id r1 > /dev/null || bad "持轮者靶子：round.id"
$FUGUE --root "$W" config set actions.ok '{"argv":["/bin/sh","-c","true"],"outputs":[]}' > /dev/null || bad "持轮者靶子：actions.ok"
WBASE=$(head_tree "$W")
check "持轮者靶子的底树" "40" "$(printf %s "$WBASE" | wc -c | tr -d ' ')"

# 地板那一档：**照夹具那份 `scenario.json` 搭**（base 铺开 + 一个提交 + 那三条配置）——`round run
# --wire-in` 绑的就是录制那一版的请求字节，多设一条配置 A 区就变了（这正是它该有的判据）。
mkdir -p "$FW/.git/info"
printf '.fugue/\n' > "$FW/.git/info/exclude"
node -e '
const fs = require("fs"), path = require("path")
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
for (const f of s.base) {
  const p = path.join(process.argv[2], f.path)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, f.text)
}
' "$FIX/scenario.json" "$FW" || bad "地板靶子：base 铺开"
( cd "$FW" && git init -q . && git symbolic-ref HEAD refs/heads/main &&
  git config user.email fugue@localhost && git config user.name fugue &&
  git add -A && git commit -qm 底 ) || bad "地板靶子：底提交"
FA=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).assertions))' "$FIX/scenario.json")
SP=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).split))' "$FIX/scenario.json")
$FUGUE --root "$FW" config set round.id r1 > /dev/null || bad "地板靶子：round.id"
$FUGUE --root "$FW" config set round.assertions "$FA" > /dev/null || bad "地板靶子：round.assertions"
$FUGUE --root "$FW" config set round.split "$SP" > /dev/null || bad "地板靶子：round.split"
# 持轮者那一档也把那两条配置给上（§ 四 要拿它跑一次配置那一档）；**在 dump 之前**给，所以后面每一趟
# 夹具绑的都是这份配置下的请求字节。
$FUGUE --root "$W" config set round.assertions "$FA" > /dev/null || bad "持轮者靶子：round.assertions"
$FUGUE --root "$W" config set round.split "$SP" > /dev/null || bad "持轮者靶子：round.split"
GOAL=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goal)' "$FIX/scenario.json")
printf '  持轮者靶子 %s（底树 %s）· 地板靶子 %s · 目标「%s」\n' "$W" "$(printf %s "$WBASE" | cut -c1-8)" "$FW" "$GOAL"

echo
echo "=== 二 · 入口第一条与三条收法（持轮者那一档）==="
node "$T/s9.js" draft '为什么这么拆：这一格只写一份 notes.md，写完就交。' "$T/draft1.md"
mkdir -p "$T/spec-1" "$T/spec-3" "$T/spec-4" "$T/spec-5"

# ① 讨论态：说一句 → 那一趟读得到它 → **Harness 判自然结束**（模型把话说完了）→ 理解改了。
printf '{"kind":"text","text":"明白了：先拆第一节，其余的下一版再说。"}\n' > "$T/spec-1/call-0001.json"
if [ "$LIVE" = yes ]; then
  liveone --json say '第一节也要拆' --live --max-steps 4
else
  one "① 讨论态 say（自然结束 · 一段文本）" "$T/spec-1" say '第一节也要拆'
fi
printf '  rc = %s\n' "$RC"
sed 's/^/  | /' "$OUTF"
sed 's/^/  err| /' "$T/run-$N.err"
if [ "$LIVE" = yes ]; then
  check "① live：收得住（0=说出来了 · 1=那句话没换来产物）" "1" "$([ "$RC" -le 1 ] && printf 1 || printf 0)"
  has "$OUTF" '收工：' "① live：那一趟报出了收工那一句"
else
  check "① 退出码" "0" "$RC"
  has "$OUTF" '收工：natural' "① 收法（Harness 判自然结束）"
  has "$OUTF" '这一态的处境没动：Idle' "① 讨论不落地（处境照旧 Idle）"
  has "$OUTF" '凝聚：修正后的理解' "① 那一趟落下了修正后的理解"
  has "$OUTF" '版本：第 1 版' "① 版本那一栏印出来了（第 1 版）"
  has "$OUTF" '对话：.fugue/session/r1.jsonl' "① 那句原话落在会话记录里"
  check "① 处境照旧（日志里一条 round/state 都没有）" "(一条都没有)" "$(laststate)"
  check "① 日志里 holder/distill 条数" "1" "$(logcount 'holder/distill')"
  check "① 原话不另存（日志里那句出现几次）" "0" "$(loghas '第一节也要拆')"
fi

# ② 人喊停那一档（`--judge`）：**人写草案、机器判**——这一档也是这一站的地板（草案由人写）。
$FUGUE --root "$W" write .fugue/plan/r1.md --from "$T/draft1.md" > /dev/null 2>&1 || bad "② 草案写进视图"
N=$((N + 1))
OUTF="$T/run-$N.out"
$FUGUE --root "$W" round plan '写一份 notes.md' --judge > "$OUTF" 2> "$T/run-$N.err"
RC=$?
printf '  rc = %s（%s）\n' "$RC" "$(head -1 "$OUTF" | cut -c1-60)"
check "② 人喊停那一档的退出码" "0" "$RC"
has "$OUTF" '收工：judged' "② 收法（人喊停）"
has "$OUTF" '0 步' "② 一步都不跑"
has "$OUTF" '停在门口' "② 判完停在门口"
has "$OUTF" '契约造得出来' "② 门后面那一批已经在手上"
check "② 门停着：日志里 contract/issue 条数" "0" "$(logcount 'contract/issue')"
check "② 门停着：日志里一条分支都没有" "" "$(git -C "$W" for-each-ref --format='%(refname:short)' refs/heads/agent | tr -d ' ')"
check "② 真实工作树一个字节不动（树哈希）" "$WBASE" "$(tree_now "$W")"
check "② 草案住视图（真实工作树上没有那一份）" "无" "$(node -e 'process.stdout.write(require("fs").existsSync(process.argv[1])?"有":"无")' "$W/notes.md")"

# ③ declared：模型调 `exit_plan_mode` 交卷（一步）。打印里那一版是**第 2 版**——第 1 版是讨论态
# 落下的那一段理解，草案是第 2 版（同一轮同一条链：架构 § 15.1.a）。
printf '{"kind":"tool","name":"exit_plan_mode","args":{"plan":"拆成一格：写一份 notes.md","planFilePath":".fugue/plan/r1.md"}}\n' > "$T/spec-3/call-0001.json"
L3=$(logcount 'holder/distill')
if [ "$LIVE" = yes ]; then
  liveone round plan '写一份 notes.md' --live --max-steps 4
else
  one "③ round plan（declared · exit_plan_mode）" "$T/spec-3" round plan '写一份 notes.md'
fi
printf '  rc = %s\n' "$RC"
sed 's/^/  | /' "$OUTF"
if [ "$LIVE" = yes ]; then
  check "③ live：收得住" "1" "$([ "$RC" -le 1 ] && printf 1 || printf 0)"
  has "$OUTF" '收工：' "③ live：那一趟报出了收工那一句"
  # **版本那一栏跟着日志走**（真档那一支的主断言）：落了地就印得出「版本：第 N 版」，没落地就
  # 印得出没落地的理由。真档今天走的是**没落地**那一条——前缀里没有一处说草案写哪儿（见头注）。
  L3N=$(logcount 'holder/distill')
  if [ "$L3N" -gt "$L3" ]; then
    has "$OUTF" '版本：第' "③ live：落了地（holder/distill $L3 → $L3N），版本那一栏印得出来"
  elif grep -q '退回' "$OUTF"; then
    ok "③ live：没落地（holder/distill 还是 $L3 条），印的是没落地的理由（退回）"
  else
    bad "③ live：没落地，却没印出理由：既没有「版本：第」也没有「退回」"
  fi
else
  check "③ 退出码" "0" "$RC"
  has "$OUTF" '收工：declared' "③ 收法（模型交卷）"
  has "$OUTF" '停在门口' "③ 停在门口"
  has "$OUTF" '契约造得出来' "③ 门后面那一批已经在手上"
  has "$OUTF" '版本：第 2 版' "③ 版本那一栏印出「第 2 版」（讨论那一段是第 1 版）"
  check "③ 门停着：日志里 contract/issue 条数" "0" "$(logcount 'contract/issue')"
  check "③ 真实工作树一个字节不动（树哈希）" "$WBASE" "$(tree_now "$W")"
fi

# ④ 上界那一档：模型把草案写出来（一步），`--max-steps 1` 让它到顶——**收得住并进判**。
printf '{"kind":"tool","name":"write","args":{"path":".fugue/plan/r1.md","contentFile":"%s"}}\n' "$T/draft1.md" > "$T/spec-4/call-0001.json"
if [ "$LIVE" = yes ]; then
  liveone round plan '写一份 notes.md' --live --max-steps 1
else
  one "④ round plan（上界 · 步数到顶）" "$T/spec-4" round plan '写一份 notes.md' --max-steps 1
fi
printf '  rc = %s\n' "$RC"
sed 's/^/  | /' "$OUTF"
if [ "$LIVE" = yes ]; then
  check "④ live：收得住" "1" "$([ "$RC" -le 1 ] && printf 1 || printf 0)"
  has "$OUTF" '收工：' "④ live：那一趟报出了收工那一句"
else
  check "④ 退出码" "0" "$RC"
  has "$OUTF" '到了你给的上界' "④ 收法（用户给的上界到了）"
  has "$OUTF" '1 步' "④ 步数就是给的那个上界"
  has "$OUTF" '停在门口' "④ 到顶照样进判：停在门口"
  check "④ 真实工作树一个字节不动（树哈希）" "$WBASE" "$(tree_now "$W")"
fi

# ⑤ 预备态：说一句 → 那一趟**改的是那份草案**（第 1 次调用写文件）→ 第 2 次调用说话收尾
# （**自然结束**，不是半截流）→ 重判 → 门再停一次；版本那一栏印得出差异。
node "$T/s9.js" draft '为什么这么拆：这一格只写一份 notes.md；第二格的事等下一轮。' "$T/draft2.md"
printf '{"kind":"tool","name":"write","args":{"path":".fugue/plan/r1.md","contentFile":"%s"}}\n' "$T/draft2.md" > "$T/spec-5/call-0001.json"
printf '{"kind":"text","text":"改好了：开头那段把第二格的事挪到下一轮。"}\n' > "$T/spec-5/call-0002.json"
if [ "$LIVE" = yes ]; then
  liveone say '为什么这么拆再写清楚一点' --live --max-steps 4
else
  one "⑤ 预备态 say（改草案 · 重判）" "$T/spec-5" say '为什么这么拆再写清楚一点'
fi
printf '  rc = %s\n' "$RC"
sed 's/^/  | /' "$OUTF"
if [ "$LIVE" = yes ]; then
  check "⑤ live：收得住" "1" "$([ "$RC" -le 1 ] && printf 1 || printf 0)"
  has "$OUTF" '收工：' "⑤ live：那一趟报出了收工那一句"
else
  check "⑤ 退出码（门停着那一档退 0）" "0" "$RC"
  has "$OUTF" '预备态' "⑤ 它知道自己站在预备态"
  has "$OUTF" '判：仍然停在门口' "⑤ 重判之后仍然停在门口"
  has "$OUTF" '版本：第 3 版' "⑤ 版本那一栏印出「第 3 版」（讨论 1 · 草案 2 · 改过的是 3）"
  has "$OUTF" '开头那段（为什么这么拆）变了' "⑤ 与它改自的那一版差在哪印出来了"
  has "$OUTF" '原话不另存' "⑤ 那一句原话不另存"
  check "⑤ 处境照旧" "Planning" "$(laststate)"
  check "⑤ 门停着：日志里 contract/issue 条数" "0" "$(logcount 'contract/issue')"
  # 会话记录那两份是 ① 写下的（人那句 + 持轮者那段理解）；预备态那一趟**一份都不写**——这一句
  # 原话在日志里出现 0 次（"不另存"的判据）。它在视图里，不在工作树上。
  check "⑤ 会话记录只被 ① 写过（人 + 持轮者两笔）" "2" "$(node "$T/s9.js" writes "$W/.fugue/log/round.jsonl" '.fugue/session/r1.jsonl')"
  check "⑤ 那句原话不落日志" "0" "$(loghas '为什么这么拆再写清楚一点')"
fi

# ⑤b 回退那一档（A→B→A）：把草案写回**第 1 版那一份**（逐字节）再判一遍。**版本那一栏说的必须是
#     真话**：号退回内容坐标（讨论 1 · 草案 2 → 第 2 版），而差异比的是它**真正改自的那一版**
#     （上一趟落地的第 3 版）——按内容编号减一会指到一个不存在的「第 0 版」，那时印出来的是假的
#     形状（实测：改之前它印「第一版：逐节全是加的」／「这一版不是一份草案」）。
$FUGUE --root "$W" write .fugue/plan/r1.md --from "$T/draft1.md" > /dev/null 2>&1 || bad "⑤b 草案写回第 1 版那一份"
N=$((N + 1))
OUTF="$T/run-$N.out"
$FUGUE --root "$W" round plan '写一份 notes.md' --judge > "$OUTF" 2> "$T/run-$N.err"
RC=$?
printf '  rc = %s\n' "$RC"
sed 's/^/  | /' "$OUTF"
if [ "$LIVE" = yes ]; then
  has "$OUTF" '版本：第' "⑤b live：回退之后版本那一栏照旧印得出来"
else
  check "⑤b 回退那一趟的退出码" "0" "$RC"
  has "$OUTF" '版本：第 2 版' "⑤b 号退回内容坐标（第 2 版：讨论 1 · 草案 2）"
  has "$OUTF" '与第 3 版比' "⑤b 差异比的是它真正改自的那一版（上一趟落地的第 3 版）"
  has "$OUTF" '开头那段（为什么这么拆）变了' "⑤b 与那一版的差印出来了"
  check "⑤b 没有把回退印成假形状（没印「这一版不是一份草案」）" "0" "$(grep -c '这一版不是一份草案' "$OUTF" || true)"
  check "⑤b 也没印「第一版：逐节全是加的」" "0" "$(grep -c '第一版：' "$OUTF" || true)"
  check "⑤b 处境照旧" "Planning" "$(laststate)"
  check "⑤b 门停着：日志里 contract/issue 条数" "0" "$(logcount 'contract/issue')"
fi

echo
echo "=== 三 · 放行（round go）==="
$FUGUE --root "$W" --json round go > "$T/go.json" 2> "$T/go.err"
RCG=$?
printf '  rc = %s · 契约 %s · 批号 %s\n' "$RCG" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((j.contracts||[]).length))' "$T/go.json")" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.fingerprint))' "$T/go.json")"
sed 's/^/  err| /' "$T/go.err"
check "⑥ 放行的退出码" "0" "$RCG"
check "⑥ 发出去的契约份数" "1" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((j.contracts||[]).length))' "$T/go.json")"
check "⑥ 走过的边" "Planning──contracts-issued──>Delegated,Delegated──branches-started──>Working" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((j.trail||[]).map((t)=>t.from+"──"+t.on+"──>"+t.to).join(","))' "$T/go.json")"
check "⑥ 分支起了几条" "1" "$(git -C "$W" for-each-ref --format='%(refname:short)' refs/heads/agent | wc -l | tr -d ' ')"
check "⑥ 日志里 contract/issue 条数" "1" "$(logcount 'contract/issue')"
check "⑥ 日志里 round/approve 条数" "1" "$(logcount 'round/approve')"
check "⑥ 处境" "Working" "$(laststate)"
BEFORE=$(wc -c < "$W/.fugue/log/round.jsonl" | tr -d ' ')
$FUGUE --root "$W" round go > /dev/null 2>&1
check "⑥ 第二次放行的退出码（这一批已经发过了）" "1" "$?"
check "⑥ 第二次放行一个字节都没落" "$BEFORE" "$(wc -c < "$W/.fugue/log/round.jsonl" | tr -d ' ')"

echo
echo "=== 四 · 放行之后接着跑（round work）==="
# **三件事依次量**（S8 那条纪律：量不到的写出来，不拿"放行成功"顶替）：
#   1. **拒得住**：在一轮已经放行（`Working`）的靶子上再起一轮（`round run`）→ `startRound` 的
#      处境守卫当场拒，而且一个字节都不落（同一批不重复派发）。
#   2. **接着跑**：`round work` 从日志读回那一批（契约与底都从日志来，一句配置都不看）→ 跑格 →
#      合并前预检 → 折叠 → 漂移检 → 验收（契约里那条断言，argv 从绑好的 `actions.ok` 来）→
#      定格 + 推进。**工作树与定格那个提交逐字节一致**。
#   3. **不重复**：第二次 `round work` 当场拒（那批契约已经跑过了），一个字节都不落。
BEFORE2=$(wc -c < "$W/.fugue/log/round.jsonl" | tr -d ' ')
$FUGUE --root "$W" round run '写一份 notes.md' --max-steps 1 > "$T/gap.out" 2> "$T/gap.err"
RCGAP=$?
printf '  rc = %s\n' "$RCGAP"
sed 's/^/  | /' "$T/gap.out"
sed 's/^/  err| /' "$T/gap.err"
check "⑦a 处境守卫：在一轮已经 Working 的靶子上再起一轮的退出码" "1" "$RCGAP"
has "$T/gap.err" '这一轮的处境是 Working' "⑦a 拒的原文里报出了处境"
has "$T/gap.err" '不再从 Idle 起一次' "⑦a 拒的原文里说清楚了为什么"
has "$T/gap.err" 'config set round.id' "⑦a 拒的原文里给了另一条路（换轮次号）"
check "⑦a 契约份数照旧（没有又发一遍）" "1" "$(logcount 'contract/issue')"
check "⑦a 处境链上照旧只有一条 Idle→Planning" "1" "$(node "$T/s9.js" edges "$W/.fugue/log/round.jsonl" Idle)"
check "⑦a 拒那一趟一个字节都不落" "$BEFORE2" "$(wc -c < "$W/.fugue/log/round.jsonl" | tr -d ' ')"
printf '  上面量到的是"同一批不重复派发"；接着跑走下面那一条（契约从日志读回 · 尾巴同一条）。\n'

# 二 · **接着跑**（`round work`）：契约与底从日志来（`contract/issue` 的正文 · `round/intent` 的底），
# 一句配置都不看、一份契约都不重算。打桩那一档（不给 --live/--wire-in）夹具档不花钱。
printf '  --- round work（夹具档 · 打桩那一档）---\n'
$FUGUE --root "$W" round work > "$T/work.out" 2> "$T/work.err"
RCW=$?
printf '  rc = %s\n' "$RCW"
sed 's/^/  | /' "$T/work.out"
sed 's/^/  err| /' "$T/work.err"
check "⑦b 接着跑的退出码" "0" "$RCW"
has "$T/work.out" '验收：通过 1' "⑦b 契约里那条断言跑过了（argv 从 actions.ok 来）"
check "⑦b 契约份数照旧（接着跑不发契约）" "1" "$(logcount 'contract/issue')"
check "⑦b 分支条数照旧（接着跑不起分支）" "1" "$(git -C "$W" for-each-ref --format='%(refname:short)' refs/heads/agent | wc -l | tr -d ' ')"
check "⑦b 推进之后工作树与定格提交逐字节一致" "$(head_tree "$W")" "$(tree_now "$W")"
check "⑦b 处境走到定格之后那一步" "Rebuilding" "$(laststate)"
check "⑦b 日志里 merge/accept 一条" "1" "$(logcount 'merge/accept')"

# 三 · **不重复**：那一批已经跑过了 → 当场拒 · 一个字节都不落。
BEFORE3=$(wc -c < "$W/.fugue/log/round.jsonl" | tr -d ' ')
$FUGUE --root "$W" round work > "$T/work2.out" 2> "$T/work2.err"
RCW2=$?
printf '  rc = %s\n' "$RCW2"
sed 's/^/  err| /' "$T/work2.err"
check "⑦c 第二次接着跑的退出码（那批契约已经跑过了）" "1" "$RCW2"
has "$T/work2.err" '已经跑过了' "⑦c 拒的原文里说清楚了为什么"
has "$T/work2.err" 'round.id' "⑦c 拒的原文里给了另一条路（换轮次号）"
check "⑦c 第二次一个字节都不落" "$BEFORE3" "$(wc -c < "$W/.fugue/log/round.jsonl" | tr -d ' ')"

echo
echo "=== 五 · 地板那一档（人拆 · 回放档）：真产物 · 真断言 · 树哈希 ==="
if [ "$LIVE" = yes ]; then
  env -u DEEPSEEK_API_KEY $FUGUE --root "$FW" round run "$GOAL" --live --max-steps 6 --report --metrics --json > "$T/floor.json" 2> "$T/floor.err"
else
  env -u DEEPSEEK_API_KEY $FUGUE --root "$FW" round run "$GOAL" --wire-in "$FIX/wire" --max-steps 4 --report --metrics --json > "$T/floor.json" 2> "$T/floor.err"
fi
RCF=$?
printf '  rc = %s\n' "$RCF"
sed 's/^/  err| /' "$T/floor.err"
check "⑧ 地板那一趟的退出码" "0" "$RCF"
check "⑧ 验收（过/没过）" "2/0" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.verify.pass+"/"+j.verify.fail)' "$T/floor.json")"
check "⑧ 推进之后工作树与那个提交逐字节一致" "$(head_tree "$FW")" "$(tree_now "$FW")"
( cd "$FW" && /bin/sh -c 'test -f notes.md' )
check "⑧ 真断言①（test -f notes.md）" "0" "$?"
( cd "$FW" && /bin/sh -c 'grep -q 数完了 notes.md' )
check "⑧ 真断言②（grep -q 数完了 notes.md）" "0" "$?"
check "⑧ 产物内容逐字节" "数完了" "$(cat "$FW/notes.md" 2> /dev/null | tr -d '\n')"
node -e '
const fs = require("fs")
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const one = (j.agents || [])[0]
console.log("  停因：「" + (one === undefined ? "（没落）" : one.stopped) + "」· 走了 " + (one === undefined ? "?" : one.steps) + " 步")
console.log("  验收 " + j.verify.pass + "/" + j.verify.fail + " · 推进 " + JSON.stringify(j.advanced === null ? null : j.advanced.written))
console.log("  八元指标 " + (j.metrics || []).length + " 条")
' "$T/floor.json"

echo
echo "=== 五之二 · 观察那一档（tui）：只印永久行 · 一行 ANSI 都不写 ==="
$FUGUE --root "$W" tui --once > "$T/tui.out" 2> "$T/tui.err"
RCT=$?
printf '  rc = %s\n' "$RCT"
sed 's/^/  err| /' "$T/tui.err"
check "tui① --once 的退出码" "0" "$RCT"
check "tui① 一个转义字节都不写（管道那一档不是 TTY）" "0" "$(grep -c "$(printf '\033')" "$T/tui.out" || true)"
check "tui② 行数 = 账上进历史那十族的条数之和" "$(node "$T/s9.js" permanent "$W/.fugue/log/round.jsonl")" "$(wc -l < "$T/tui.out" | tr -d ' ')"
has "$T/tui.out" 'Idle → Planning' "tui② 处境那条链印得出"
check "tui② 不是抄本那一档（没有制表符 · 那一档是 fugue log）" "0" "$(grep -c "$(printf '\t')" "$T/tui.out" || true)"
printf '  头几行：\n'
head -5 "$T/tui.out" | sed 's/^/  | /'
printf '  账上一共 %s 条事件 · 其中 %s 条进历史\n' "$(wc -l < "$W/.fugue/log/round.jsonl" | tr -d ' ')" "$(wc -l < "$T/tui.out" | tr -d ' ')"

echo
echo "=== 六 · 收尾：不留挂载 · 不留进程 · 不留孤儿分支 ==="
for d in "$W" "$FW"; do
  check "⑨ $(basename "$d")：挂载表里没有它" "0" "$(grep -c "$d" /proc/self/mountinfo 2> /dev/null || true)"
done
check "⑨ 没有残留的 fugue-s9 进程" "0" "$(ps -eo args 2> /dev/null | grep -c '[f]ugue-s9-' || true)"
for d in "$W" "$FW"; do
  for a in $(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads/agent 2> /dev/null); do
    $FUGUE --root "$d" --agent "$a" dispose > /dev/null 2>&1
    git -C "$d" update-ref -d "refs/heads/$a" > /dev/null 2>&1
  done
  check "⑨ $(basename "$d")：agent 分支收干净了" "0" "$(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads/agent | wc -l | tr -d ' ')"
  check "⑨ $(basename "$d")：只剩 main 那一支" "main" "$(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads | tr '\n' ' ' | tr -d ' ')"
done

echo
printf 'PASS %s · FAIL %s\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ] || exit 1
exit 0
