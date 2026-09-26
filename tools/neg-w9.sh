#!/bin/sh
# C6 的负对照（**取证用，不是产品的一部分**，随时可重跑）。
#
# 把走查里一条期望值改坏（⑤ 的「版本：第 3 版」→「版本：第 9 版」），那一趟必须**当场红**：
# 退出码 1，而且红的就是那一条（别的照绿）。一份断言没红过，就不知道它是不是恒绿——
# 这一份量的就是"走查那一堆断言真的在读东西"。
#
# 它**不改仓库里的文件**：改的那一份落在 `/tmp/walkthrough-s9-neg.sh`，日志落在同目录。
# 用法：sh tools/neg-w9.sh；退出码 0 = 负对照成立（走查按预期红了那一条）。
set -u
cd /home/ubuntu/fugue || exit 9
NEG=/tmp/walkthrough-s9-neg.sh
LOG=/tmp/walkthrough-s9-neg.log
sed 's/版本：第 3 版/版本：第 9 版/' tools/walkthrough-s9.sh > "$NEG"
sh "$NEG" > "$LOG" 2>&1
rc=$?
echo "负对照那一趟：EXIT=$rc"
grep '^FAIL' "$LOG"
red=$(grep -c '^FAIL' "$LOG")
if [ "$rc" = "1" ] && [ "$red" = "1" ]; then
  echo "负对照成立：改坏一条期望 → 那一趟退 1，且只有那一条红"
  exit 0
fi
echo "负对照不成立：退出码 $rc · 红的条数 $red"
exit 1
