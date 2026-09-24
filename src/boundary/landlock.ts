// 第二层：Landlock（架构 § 8.8 的"两层机制，实测均可用" · PLAN § 5.5 的 Y6 行）。
//
// **它管的是"写"那一维，与挂载层正交。** 挂载层（`bwrap`）管的是"看得见什么"——清单里没点名的
// 一律不在；这一层管的是"写得动什么"——没声明的一律写不动，而且是**内核当场拒**（EACCES），
// 不是事后记一笔。两层都在场时它叠在挂载层里面（纵深）；挂载层不在时它一个人撑着地板：
// `bwrap` 不在 → 这一层仍在（`mode` 照实报 `read-only`），两层都不在 → 树可写 + 回收兜底。
//
// **三件事，一处做完**：
//   ① **探 ABI**：`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`——用系统
//      调用问内核，**不看 `/sys/kernel/security/lsm`**（WSL 里 `securityfs` 没挂，那个文件读不到，
//      按文件探会得到假阴性。实测它确实读不到，而 ABI 是 7）。
//   ② **编一次**：`cc` 把那份包装器编到 `<realRoot>/.fugue/bin/`（源码变了或产物不在才编）。
//      它是**派生**的：可弃、可重生成，`dispose` 不管它（与 `mat/` 同一个性质）。**静态链**：
//      它自己不该依赖清单里那条动态链接器——清单少一条时它要是起不来，报出来的就是"包装器找
//      不到"（指向的是错的地方）；这一台编不出静态（没有 `libc.a`）就退回动态链，note 里说清。
//   ③ **把 argv 包一层**：`<包装器> --rw <可写落点>… -- <原命令行>`。包装器自己不认策略——
//      给它哪几条它开哪几条，策略那一侧的推法在这一份里（`writableFor`）。
//
// **为什么非得编一个二进制**：Node 里没有直接发这个系统调用的路（没有 FFI），而这一层要在
// `exec` 之前把自己关进去——那就只能是一个先关自己、再 `execvp` 的小程序。`cc` 不在、编不出来、
// 或这一门内核里没有 Landlock：这一层**如实缺**（`layers` 里没有它、`enforcement` 降一档），
// 绝不静默——那三种情形的原话都在 `probeLandlock().note` 里。
//
// **可写集里为什么有 `/dev/null` 那一类**（Y6 的断言 ③）：不含它时**任何一次重定向都翻车**
// （实测 `echo x > /dev/null` → `cannot create /dev/null: Permission denied`），而那跟边界无关，
// 是每个人都会撞上的噪声。加上 `/dev/null` `/dev/zero` `/dev/full` `/dev/random` `/dev/urandom`
// `/dev/tty` 之后重定向照旧。`/dev/stdout` `/dev/stderr` 那一类**开不成**（它们指到管道上，
// 内核给 `EBADFD`）——不进这份清单。
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath } from '../terms.ts'
import type { Policy } from './policy.ts'

/** 工作区里那两处：`<realRoot>/.fugue/bin/`（§ 9.2 的布局里与 `log/` · `snap/` · `mat/` 并列）。 */
export const LANDLOCK_DIR = join('.fugue', 'bin')
export const LANDLOCK_SRC = 'landlock-exec.c'
export const LANDLOCK_BIN = 'landlock-exec'

/**
 * 包装器在**沙箱那一侧**的落点：挂载层把它只读挂进来，argv 里写的就是这一条。
 *
 * **点名字是有意的**：`ls /` 那份读数（Y3 量过的十二条）一个字节不变，`ls -a /` 才多出它
 * （实测两条都在）。另选一个普通名字会把 Y3 的读数改掉，而那份读数不该为了这一层动。
 */
export const LANDLOCK_SANDBOX_PATH = '/.fugue/landlock-exec'

/** 可写集里那几条设备：不含它们任何一次重定向都翻车（实测见文件头）。 */
export const DEVICE_FILES: readonly AbsPath[] = [
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
]

/**
 * 那份包装器的源码，**原样落进工作区**（`.fugue/bin/landlock-exec.c`）：编译的输入是一份看得见
 * 的文件，不是一段藏在别处的字符串——出错时 `cc` 报的是它，人改的也是它。
 *
 * `String.raw`：C 里那些 `"\n"` 要原样过去，模板串默认会把它们变成真的换行、把字面量截断。
 */
export const LANDLOCK_C_SRC: string = String.raw`// 第二层那个包装器（架构 § 8.8 · PLAN § 5.5 的 Y6 行）。由 fugue 生成，别手改：
// 源码那一份在 src/boundary/landlock.ts 里，改了它下一次运行会重编这一份。
//
// 两件事：探 ABI（"--probe"：用系统调用问内核，不看 /sys）与把 argv 包一层（其余参数）。
// 只处理"写"那一维：读不加限制——读那一维由可达集清单在挂载层上管（"边界 受限令牌 → 只读"）。
//
// 失败一律关起来（fail closed）：建不出规则集就以 126 退出，绝不 exec 一个没关上的孩子。
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* 系统调用号：Landlock 自 5.13 起，各架构同号。头文件老一点的机器上要自己写。 */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1

/* 访问权：ABI 1 的那些 + ABI 2 的 REFER + ABI 3 的 TRUNCATE（ABI 5 的 IOCTL_DEV 不管）。 */
#define A_WRITE_FILE (1ULL << 1)
#define A_REMOVE_DIR (1ULL << 4)
#define A_REMOVE_FILE (1ULL << 5)
#define A_MAKE_CHAR (1ULL << 6)
#define A_MAKE_DIR (1ULL << 7)
#define A_MAKE_REG (1ULL << 8)
#define A_MAKE_SOCK (1ULL << 9)
#define A_MAKE_FIFO (1ULL << 10)
#define A_MAKE_BLOCK (1ULL << 11)
#define A_MAKE_SYM (1ULL << 12)
#define A_REFER (1ULL << 13)
#define A_TRUNCATE (1ULL << 14)

struct ll_ruleset_attr { unsigned long long handled_access_fs; };
struct ll_path_beneath_attr { unsigned long long allowed_access; int parent_fd; } __attribute__((packed));

static long ll_create(const struct ll_ruleset_attr *a, size_t n, unsigned int flags) {
  return syscall(__NR_landlock_create_ruleset, a, n, flags);
}
/* 四个参数：fd · 规则类型 · 规则本体 · flags（**不是结构体长度**——多给一个 sizeof 就是 EINVAL）。 */
static long ll_add(int fd, const struct ll_path_beneath_attr *a) {
  return syscall(__NR_landlock_add_rule, fd, LL_RULE_PATH_BENEATH, a, 0U);
}
static long ll_restrict(int fd) { return syscall(__NR_landlock_restrict_self, fd, 0U); }

/* 这一层管的那几样：全是"写"那一维。读与执行不进来，它们是挂载层与清单的事。 */
static unsigned long long handled_of(long abi) {
  unsigned long long m = A_WRITE_FILE | A_REMOVE_DIR | A_REMOVE_FILE | A_MAKE_CHAR | A_MAKE_DIR |
                         A_MAKE_REG | A_MAKE_SOCK | A_MAKE_FIFO | A_MAKE_BLOCK | A_MAKE_SYM;
  if (abi >= 2) m |= A_REFER;    /* 跨目录 rename / link */
  if (abi >= 3) m |= A_TRUNCATE; /* O_TRUNC */
  return m;
}

/*
 * 目录才有的那几样：删一个条目、建一个条目，都是**目录上的**动作（REMOVE_FILE 也在里面），
 * 跨目录的 rename / link 同属这一档。只有目录那一条规则许带它们——文件那一条带了就是 EINVAL
 * （实测：/dev/null 那条规则第一次没开成，多的正是 REMOVE_FILE）。
 */
static const unsigned long long DIR_ONLY =
    A_REMOVE_DIR | A_REMOVE_FILE | A_MAKE_CHAR | A_MAKE_DIR | A_MAKE_REG | A_MAKE_SOCK |
    A_MAKE_FIFO | A_MAKE_BLOCK | A_MAKE_SYM | A_REFER;

/* 文件那一条规则许带的：写与截断。 */
static const unsigned long long FILE_OK = A_WRITE_FILE | A_TRUNCATE;

static int probe(void) {
  long abi = ll_create(NULL, 0, LL_CREATE_RULESET_VERSION);
  if (abi < 0) {
    fprintf(stderr, "landlock: UNAVAILABLE errno=%d (%s)\n", errno, strerror(errno));
    return 1;
  }
  printf("landlock: AVAILABLE ABI=%ld\n", abi);
  return 0;
}

static int usage(void) {
  fprintf(stderr, "用法：landlock-exec [--rw <路径>]… -- <命令行…>\n");
  return 2;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) return probe();

  long abi = ll_create(NULL, 0, LL_CREATE_RULESET_VERSION);
  if (abi < 0) {
    fprintf(stderr, "landlock: 这一门内核里没有（errno=%d %s）——不套这一层就不起进程\n", errno,
            strerror(errno));
    return 126;
  }
  unsigned long long handled = handled_of(abi);
  struct ll_ruleset_attr rs = {handled};
  int fd = (int)ll_create(&rs, sizeof(rs), 0U);
  if (fd < 0) {
    fprintf(stderr, "landlock: 建不出规则集（ABI %ld）：errno=%d (%s)\n", abi, errno, strerror(errno));
    return 126;
  }

  int i = 1;
  while (i < argc && strcmp(argv[i], "--") != 0) {
    if (strcmp(argv[i], "--rw") != 0 || i + 1 >= argc) return usage();
    const char *p = argv[i + 1];
    i += 2;
    int pfd = open(p, O_PATH | O_CLOEXEC);
    if (pfd < 0) {
      fprintf(stderr, "landlock: 这一条不在，没给它开口子：%s（errno=%d %s）\n", p, errno,
              strerror(errno));
      continue;
    }
    struct stat st;
    if (fstat(pfd, &st) != 0) {
      fprintf(stderr, "landlock: 这一条没开成：%s（errno=%d %s）\n", p, errno, strerror(errno));
      close(pfd);
      continue;
    }
    unsigned long long allowed = S_ISDIR(st.st_mode) ? handled : (handled & FILE_OK);
    if (allowed == 0) {
      fprintf(stderr, "landlock: 这一条没开成（文件那几样里一样都不沾）：%s\n", p);
      close(pfd);
      continue;
    }
    struct ll_path_beneath_attr pb = {allowed, pfd};
    if (ll_add(fd, &pb) != 0) {
      fprintf(stderr, "landlock: 这一条没开成：%s（errno=%d %s）\n", p, errno, strerror(errno));
    }
    close(pfd);
  }
  if (i >= argc || i + 1 >= argc) return usage();
  int cmd = i + 1;
  /* 这两步的顺序是内核要求的：没有 no_new_privs，restrict_self 会被拒（EPERM）。 */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "landlock: 设不上 no_new_privs：errno=%d (%s)\n", errno, strerror(errno));
    return 126;
  }
  if (ll_restrict(fd) != 0) {
    fprintf(stderr, "landlock: 这一层关不上：errno=%d (%s)\n", errno, strerror(errno));
    return 126;
  }
  close(fd);
  execvp(argv[cmd], &argv[cmd]);
  fprintf(stderr, "landlock: 起不来：%s（errno=%d %s）\n", argv[cmd], errno, strerror(errno));
  return 127;
}
`

/** 包装器在宿主上那一份：`<realRoot>/.fugue/bin/landlock-exec`。 */
export function helperPath(roots: Roots): AbsPath {
  return join(roots.realRoot, LANDLOCK_DIR, LANDLOCK_BIN)
}

export interface HelperMade {
  readonly ok: boolean
  readonly bin: AbsPath
  readonly note: string
}

/**
 * 编一次（或确认那一份还在、还是新的）。
 *
 * **两处写都用临时名 + `rename`**：同一个工作区里两个进程同时探层是常事（两条命令并行），
 * 就地写会让人读到半份源码或半份二进制——那两种都会让这一层"看起来不在"，而它其实在。
 * 判据是 **mtime**：源码文件变了（`LANDLOCK_C_SRC` 改过）就重编，否则一次都不编。
 */
export function ensureHelper(roots: Roots): HelperMade {
  const dir = join(roots.realRoot, LANDLOCK_DIR)
  const src = join(dir, LANDLOCK_SRC)
  const bin = join(dir, LANDLOCK_BIN)
  try {
    mkdirSync(dir, { recursive: true })
    // 源码只在内容变了才落：mtime 因此是"这一份源码什么时候进来的"，重编的判据靠它。
    let same = false
    if (existsSync(src)) {
      try {
        same = readFileSync(src, 'utf8') === LANDLOCK_C_SRC
      } catch {
        same = false
      }
    }
    if (!same) {
      const tmp = `${src}.${process.pid}.tmp`
      writeFileSync(tmp, LANDLOCK_C_SRC)
      renameSync(tmp, src)
    }
    const fresh =
      existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs
    if (fresh) return { ok: true, bin, note: `${LANDLOCK_DIR}/${LANDLOCK_BIN} 在（没重编）` }
    const out = `${bin}.${process.pid}.tmp`
    // **先试静态链**：包装器是边界自己的实现，不该依赖清单里那条动态链接器。清单少一条时它要是
    // 起不来，报出来的就是"包装器找不到"——指向的是错的地方（Y3 ③ 那两条负对照量的正是这件事）。
    // 编不出静态（这一台没有 `libc.a`）就退回动态链，并在 note 里说清是哪一种：那一档上包装器
    // 就跟着清单一起活或一起死，如实记着。
    let r = spawnSync('cc', ['-static', '-O2', '-o', out, src], { encoding: 'utf8', timeout: 60_000 })
    let how = '静态链'
    if (r.error !== undefined && r.error !== null) {
      rmSync(out, { force: true })
      return { ok: false, bin, note: `PATH 里起不来 cc：${String((r.error as Error).message)}` }
    }
    if (r.status !== 0) {
      r = spawnSync('cc', ['-O2', '-o', out, src], { encoding: 'utf8', timeout: 60_000 })
      how = '动态链（这一台编不出静态）'
    }
    if (r.error !== undefined && r.error !== null) {
      rmSync(out, { force: true })
      return { ok: false, bin, note: `PATH 里起不来 cc：${String((r.error as Error).message)}` }
    }
    if (r.status !== 0) {
      rmSync(out, { force: true })
      const why = `${(r.stderr ?? '').trim().split('\n').slice(0, 2).join(' / ')}`
      return { ok: false, bin, note: `cc 编不出这一层（退 ${r.status ?? '?'}）：${why}` }
    }
    renameSync(out, bin)
    return { ok: true, bin, note: `${LANDLOCK_DIR}/${LANDLOCK_BIN} 刚编出来（${how}）` }
  } catch (err) {
    return { ok: false, bin, note: `这一层落不下来：${String((err as Error).message)}` }
  }
}

export interface LandlockProbe {
  readonly ok: boolean
  /** 探到的 ABI（`ok` 为假时是 `null`）。 */
  readonly abi: number | null
  readonly note: string
  readonly bin: AbsPath
}

/**
 * 这一门内核里有没有 Landlock：**系统调用问一句**（不是读 `/sys`）。
 *
 * 探的时候顺手就把包装器跑起来了——"编得出来"与"跑得起来"是两件事，只有后者算这一层在场。
 */
export function probeLandlock(roots: Roots): LandlockProbe {
  const made = ensureHelper(roots)
  if (!made.ok) return { ok: false, abi: null, note: made.note, bin: made.bin }
  const r = spawnSync(made.bin, ['--probe'], { encoding: 'utf8', timeout: 20_000 })
  if (r.error !== undefined && r.error !== null) {
    return { ok: false, abi: null, note: `包装器起不来：${String((r.error as Error).message)}`, bin: made.bin }
  }
  const line = (r.stdout ?? '').trim()
  const m = /ABI=(\d+)/.exec(line)
  if (r.status !== 0 || m === null) {
    const why = (r.stderr ?? '').trim() || line || `退 ${r.status ?? '?'}`
    return { ok: false, abi: null, note: `这一门内核里没有 Landlock：${why}`, bin: made.bin }
  }
  return { ok: true, abi: Number(m[1]), note: `Landlock ABI ${Number(m[1])}（系统调用探到的）`, bin: made.bin }
}

/**
 * 设备那几条，按**宿主上在不在**过一遍：挂载档的 `/dev` 是 `bwrap` 自己那份 devtmpfs，实测
 * `/dev/null` `/dev/zero` `/dev/full` `/dev/random` `/dev/urandom` `/dev/tty` 都在。
 *
 * `/dev/stdout` `/dev/stderr` 那一类不进来：它们指到管道上，内核给 `EBADFD`（实测）。
 */
export function deviceFiles(): string[] {
  return DEVICE_FILES.filter((p) => existsSync(p))
}

/**
 * **没有挂载层时**这一层的可写集：策略值里那几处可写落点 + 树自己（只在树可写那一档）+ 设备。
 *
 * 坐标跟着档走（`Policy.coords`）：那一档里子进程就在宿主上跑，坐标就是宿主那三条——所以包装器
 * 不需要知道自己在哪一档里，它只认给它的那几条。
 *
 * **有挂载层时不用这个函数**：那时可写集是**第一层真的挂成可写的那几处**，由 `confine()` 从它
 * 自己那条 argv 里数出来——两份各数各的会让两层错位，而错位的那一半是静默的。
 */
export function writableFor(policy: Policy): string[] {
  const tree = policy.mode === 'workspace-write' ? [policy.coords.tree] : []
  return [...new Set<string>([...policy.writableRoots, ...tree, ...deviceFiles()])]
}

/** 把一条命令行包成第二层的形式：`<包装器> --rw … -- <原命令行>`。 */
export function landlockArgv(bin: AbsPath, rw: readonly string[], argv: readonly string[]): string[] {
  const args: string[] = []
  for (const p of rw) args.push('--rw', p)
  return [bin, ...args, '--', ...argv]
}
