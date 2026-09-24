#!/bin/sh
# Z5 的红负对照（**取证用，不是产品的一部分**，随时可重跑）：
#
#   甲 · 把 `<realRoot>` 拼进系统状态那一段（产品那一份的 `systemSegment`）——**①②⑤ 该红**：
#        同一份配置在两个宿主根下装出来的 A 区不同（宿主坐标漏进了 A 区，架构 § 8.11 的约束 2），
#        而同一根下四个 agent 照旧全等（这一档动的是宿主坐标，不是 agent 坐标）。
#   乙 · 把 agent 的 id 拼进系统状态那一段——**② 该红**（四个 agent 拿到的系统状态不再相同，
#        A 区的全等当场不成立）。它量的是 ② 那一句：「A 区的全等取决于源的输出，不取决于读它的
#        那个 agent」。
#
# 两个临时文件都落在 `src/assemble/` 里、名字以 `.` 开头、后缀不是 `.test.ts`：测试与真身同目录，
# 相对 import 才对得上；而 `tools/test-entry.js` 扫的是 `*.test.ts`，扫不到它们。
#
# ② 那一档要一个 agent 才动得起来，所以替身模块把 `systemSegment` 换成收一个 id 的那一版；
# 测试副本里凡是 `stateWithState` 进来的那一份也走替身（它内部调的就是 `systemSegment`）。
set -u
cd /home/ubuntu/fugue || exit 9
RUN=src/assemble/.__neg5-runner.ts
TST=src/assemble/.__neg5.test.ts
OUT=/tmp/neg-z5
rm -rf "$OUT"; mkdir -p "$OUT"
rm -f "$RUN" "$TST"
cp src/assemble/sources-state.ts "$OUT/state.bak"
trap 'cp "$OUT/state.bak" src/assemble/sources-state.ts; rm -f "$RUN" "$TST"' EXIT

python3 - "$RUN" "$TST" <<'PY'
import io, sys
run, tst = sys.argv[1], sys.argv[2]
q = chr(39)
def ree(what, mod):
    return "export { %s } from %s%s%s" % (", ".join(what), q, mod, q)
lines = [
 "// 替身：一切从真身转出，只把系统状态那一段换成「按读它的那个 agent 生成」的。",
 "// 用 export ... from（不是 import）：import 进来的名字不会转出去。",
 ree(["projectConfig"], "./sources-state.ts"),
 "export type * from " + q + "./sources-state.ts" + q,
 ree(["ZONE_SEGMENTS", "HOLDER_B", "DEFAULT_PARTITION", "zoneSplit"], "./contract.ts"),
 "export type * from " + q + "./contract.ts" + q,
 ree(["DEFAULT_MODEL", "MODELS", "modelOf"], "./models.ts"),
 ree(["SUBAGENT_PROTOCOL", "HOLDER_PROTOCOL", "protocolOf"], "./protocol.ts"),
 ree(["render", "stableStringify"], "./render.ts"),
 ree(["assemble", "hashOf", "firstDivergence"], "./assemble.ts"),
 ree(["HOLDER", "SourceError", "emptyState", "resolverFor", "sourcesFor", "readPolicy"], "./sources.ts"),
 "export type * from " + q + "./sources.ts" + q,
 "import type { ConfigDoc } from " + q + "../config.ts" + q,
 "import { systemSegment as plain } from " + q + "./sources-state.ts" + q,
 "import { readPolicy as realPolicy } from " + q + "./sources.ts" + q,
 "import type { AgentCoord as Coord, AssembleState } from " + q + "./sources.ts" + q,
 "let currentAgent: string | undefined",
 "/** 甲那一档：宿主坐标漏进 A 区（架构 § 8.11 的约束 2 与 3 要拦下的写法）。 */",
 "export function systemSegment(config: ConfigDoc) {",
 "  const base = plain(config) as unknown as Record<string, unknown>",
 "  return { ...base, realRoot: process.env.FUGUE_NEG_ROOT ?? '/home/ubuntu/work' }",
 "}",
 "/** 同一份装出来的状态：系统状态那一段走替身。 */",
 "export function stateWithState(base: AssembleState, config: ConfigDoc, realRoot: string): AssembleState {",
 "  return { ...base, system: systemSegment(config) as never, policy: realPolicy(realRoot) }",
 "}",
 "/** 乙那一档：每个 agent 拿到的字不一样（② 要拦下的写法）。 */",
 "export function systemForEachAgent(config: ConfigDoc, agents: readonly Coord[]): string[] {",
 "  return agents.map((a) => {",
 "    currentAgent = a.id",
 "    const v = process.env.FUGUE_NEG_AGENT === '1' ? systemSegment(config) : plain(config)",
 "    return JSON.stringify({ ...(v as unknown as Record<string, unknown>), agentId: currentAgent })",
 "  })",
 "}",
]
io.open(run, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")

s = io.open("src/assemble/sources-state.test.ts", encoding="utf-8").read()
for name in ("contract", "models", "protocol", "render", "assemble", "sources", "sources-state"):
    s = s.replace("from './%s.ts'" % name, "from './.__neg5-runner.ts'")
s = s.replace(
  "import { projectConfig, stateWithState, systemForEachAgent, systemSegment } from './.__neg5-runner.ts'",
  "import { projectConfig, stateWithState, systemForEachAgent, systemSegment } from './.__neg5-runner.ts'")
io.open(tst, "w", encoding="utf-8", newline="\n").write(s)
PY

brief() {
  grep -E '^(✔|✖) ' "$1" | head -10
  grep -E '^ℹ (tests|pass|fail)' "$1"
  echo "  --- 断言原文 ---"
  grep -E 'AssertionError' "$1" | head -6
}

echo "=== 甲 · 把宿主根拼进系统状态（替身那一侧）==="
node --test "$TST" > "$OUT/jia.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/jia.txt"

echo
echo "=== 乙 · 系统状态那一段按读它的那个 agent 生成（替身那一侧）==="
# 替身里那一版给每个坐标带上了自己的 id：这一档量的是 ② 那句「A 区的全等取决于源的输出，
# 不取决于读它的那个 agent」。
FUGUE_NEG_AGENT=1 node --test "$TST" > "$OUT/yi.txt" 2>&1
echo "rc=$? （1 = 有断言红了）"
brief "$OUT/yi.txt"

echo
echo "=== 复原之后，正面再跑一次 ==="
node --test src/assemble/sources-state.test.ts > "$OUT/good.txt" 2>&1
echo "rc=$?"
grep -E '^ℹ (tests|pass|fail)' "$OUT/good.txt"
