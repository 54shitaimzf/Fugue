// 逃逸面封禁：seccomp 那一小层（计划 § 5.20 的 P1b 行）。
//
// **它只封一条：`socket(AF_VSOCK)` → EPERM，其余系统调用一律放行。** 由头（2026-09-29 实测，
// 沙箱内与宿主各量过一次）：AF_VSOCK 不属于网络命名空间——bwrap 的 `--unshare-net` 挡不住
// 它，沙箱里 `socket(40)` 照样通（它也不需要 `/dev/vsock` 节点），而那是一条直通宿主的道
// （WSL2 的内核带着它；同类 harness 都封它）。**这是最小清单，不是通用 seccomp 框架**：
// 多封一条都要先有一条会红的逃逸用例（`escape.ts` 那张表）。
//
// **它不是围栏层，不进 `Policy.layers` 与 `enforcement`**：挂载层管"看得见什么"、第二层管
// "写得动什么"，这一条管的是"哪条系统调用的道不通"——三个正交的维度。缺席时（cc 不在 ·
// 编不出来 · 这门内核没有 seccomp）不挂，命令照跑，逃逸表里那条用例**如实红**——封没封住
// 的常驻判据就是那条用例，不另设自检探针。
//
// 形制与 `landlock.ts` 的包装器同一套：源码是一份看得见的文件（`.fugue/bin/seccomp-exec.c`），
// 静态链优先（它自己不该依赖清单里那条动态链接器）、tmp + rename 原子落、mtime 判重编。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath } from '../terms.ts'

export const SECCOMP_DIR = join('.fugue', 'bin')
export const SECCOMP_SRC = 'seccomp-exec.c'
export const SECCOMP_BIN = 'seccomp-exec'

/**
 * 沙箱那一侧的落点：与 `landlock-exec` 同款点名挂（`ls /` 那份读数一个字节不变，
 * `ls -a /` 才多出它）。
 */
export const SECCOMP_SANDBOX_PATH = '/.fugue/seccomp-exec'

export const SECCOMP_C_SRC: string = String.raw`// 逃逸面封禁的那个小包装器（计划 § 5.20 的 P1b）。由 fugue 生成，别手改：
// 源码那一份在 src/boundary/seccomp.ts 里，改了它下一次运行会重编这一份。
//
// 只封一条：socket(AF_VSOCK) -> EPERM，其余一律放行（见那一份的头注：AF_VSOCK 不归
// 网络命名空间管，--unshare-net 挡不住它）。多封一条都要先有一条会红的逃逸用例。
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif

static int install(void) {
  struct sock_filter code[] = {
    /* 只认 x86_64 这一门；别的门一律 EPERM——fail-closed（这一台机器不会走到它）。 */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_VSOCK, 0, 1),
    /* socket(AF_VSOCK, *) -> EPERM */
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    /* 其余系统调用一律放行 */
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = { sizeof(code) / sizeof(code[0]), code };
  /* 与 landlock-exec 同一条内核要求：没有 no_new_privs，装过滤器会被拒。 */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "seccomp: 设不上 no_new_privs：errno=%d (%s)\n", errno, strerror(errno));
    return -1;
  }
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0) {
    fprintf(stderr, "seccomp: 过滤器装不上：errno=%d (%s)\n", errno, strerror(errno));
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) {
    /* 自检：装上过滤器之后自己 socket 一次——被拒成 EPERM 才算这一层真的封得住。 */
    if (install() != 0) return 126;
    errno = 0;
    int s = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (s >= 0 || errno != EPERM) {
      if (s >= 0) close(s);
      printf("seccomp=absent errno=%d\n", errno);
      return 1;
    }
    printf("seccomp=ok\n");
    return 0;
  }
  if (argc < 2) {
    fprintf(stderr, "用法：seccomp-exec [--probe] <argv...>\n");
    return 125;
  }
  if (install() != 0) return 126;
  execvp(argv[1], &argv[1]);
  fprintf(stderr, "seccomp: 起不来：%s（errno=%d %s）\n", argv[1], errno, strerror(errno));
  return 127;
}
`

/** 包装器在宿主上那一份：`<realRoot>/.fugue/bin/seccomp-exec`（与 landlock-exec 同目录）。 */
export function seccompHelperPath(roots: Roots): AbsPath {
  return join(roots.realRoot, SECCOMP_DIR, SECCOMP_BIN)
}

export interface SeccompMade {
  readonly ok: boolean
  readonly bin: AbsPath
  readonly note: string
}

/**
 * 编一次（或确认那一份还在、还是新的）。编译的原子性与判重编与 `landlock.ts` 的
 * `ensureHelper` 同一套（tmp + rename · mtime），注释在那一份里；**编得出来就算在架**——
 * 封没封得住的常驻判据是逃逸表那条用例（`escape.ts` 的 `vsock 那条道`），它红着就是
 * "这一层没生效"的如实报警，不在这里再开一个探针。
 */
export function ensureSeccompHelper(roots: Roots): SeccompMade {
  const dir = join(roots.realRoot, SECCOMP_DIR)
  const src = join(dir, SECCOMP_SRC)
  const bin = join(dir, SECCOMP_BIN)
  try {
    mkdirSync(dir, { recursive: true })
    let same = false
    if (existsSync(src)) {
      try {
        same = readFileSync(src, 'utf8') === SECCOMP_C_SRC
      } catch {
        same = false
      }
    }
    if (!same) {
      const tmp = `${src}.${process.pid}.tmp`
      writeFileSync(tmp, SECCOMP_C_SRC)
      renameSync(tmp, src)
    }
    if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) {
      return { ok: true, bin, note: `${SECCOMP_DIR}/${SECCOMP_BIN} 在（没重编）` }
    }
    const out = `${bin}.${process.pid}.tmp`
    // 静态链优先，编不出静态退动态链（理由同 landlock 那一份的头注）。
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
    return { ok: true, bin, note: `${SECCOMP_DIR}/${SECCOMP_BIN} 刚编出来（${how}）` }
  } catch (err) {
    return { ok: false, bin, note: `这一层落不下来：${String((err as Error).message)}` }
  }
}

/**
 * argv 外面加一层：先装过滤器、再 `execvp` 原命令行。包装器自己不认策略——它只封那一条
 * （沙箱那一侧用 `SECCOMP_SANDBOX_PATH` 当这一格的 bin，宿主那一侧用 `bin` 本身）。
 */
export function seccompArgv(bin: string, argv: readonly string[]): string[] {
  return [bin, ...argv]
}
