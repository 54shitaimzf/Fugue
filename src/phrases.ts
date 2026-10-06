// **机器要 grep 的那几句文案，一处定义。** 出处：架构 § 8.6（`denied` 那一栏：子进程 `open()` 拿
// `errno 30`，而父进程手里只剩退出码与 stderr 那一句——**判据因此是那几句文案，不是 errno**）·
// § 9.8（`hint` 指向正确的替代能力）· § 9.11（号牌 · 钟栏随事件透出）。
//
// 为什么单独一份：**同一句写在两处就会漂，而漂了不报错**。表外任何文件里再出现同一串字面，
// `tools/check-phrases.ts` 当场报出来（跑在快档里，见 `test/phrases.test.ts`）。
// 加一句 = 在这里加一格，用它的人 import 这一格——**不抄第二份**。
//
// **这里只收"机器要 grep"的那几句**：用户可见的排版、给人读的散文不在表里（那些改了不影响任何
// 消费者）。判据一句话：**外部脚本会按这一串字面做判断的，就进表**。
export const PHRASES = {
  /** `watch --follow` 退出时印的那一行：机器拿它当"接着读的号牌"。 */
  resumeHead: '接着读的号牌',
  /** `status` 报钟回拨那一块的表头。**报的是事实，不是错误**（回拨是环境里发生的事）。 */
  clockRollbackHead: '钟回拨（信封上的事实，不是账的错）',
  /** `watch` 不给 `--follow` 时的说明（命令不认某个开关时印在指路那一句里）。 */
  watchNote: '不给 --follow 就把账上有的念一遍就停',
  /** 写面上那道开关的说明：`--no-clock` 关掉的是信封钟那三栏（架构 § 9.2）。 */
  noClockNote: '不给 --no-clock 就带信封钟（ts · boot · inc 三栏）',
} as const

/** 表里每一句的键（供唯一性检查与外部消费者枚举，不手抄一份键名）。 */
export const PHRASE_KEYS = Object.keys(PHRASES).sort()

/** 表里的全部字面。 */
export const PHRASE_TEXTS: readonly string[] = PHRASE_KEYS.map(
  (k) => PHRASES[k as keyof typeof PHRASES],
)
