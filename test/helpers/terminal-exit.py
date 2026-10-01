"""Drive only an owned CLI process through a real Unix PTY; return terminal evidence."""
import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument('node')
parser.add_argument('cli')
parser.add_argument('root')
parser.add_argument('exit', choices=['q', 'ctrl-c', 'sigterm', 'sighup', 'bad-log'])
parser.add_argument('--startup-hook')
args = parser.parse_args()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
initial = termios.tcgetattr(slave)
env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': args.root,
       'TERM': 'xterm-256color', 'LANG': 'C.UTF-8'}
child = None
output = bytearray()
ready = False
raw_active = False
acted = False
timed_out = False
try:
    def interrupted(_signal, _frame):
        raise InterruptedError('owned terminal driver interrupted')

    signal.signal(signal.SIGTERM, interrupted)
    command = [args.node]
    if args.startup_hook:
        command += ['--import', args.startup_hook]
    command += [args.cli, '--root', args.root, 'tui', '--full', '--interval', '20']
    child = subprocess.Popen(command,
                             stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    def capture(chunk):
        if len(output) + len(chunk) > 1024 * 1024:
            raise RuntimeError('owned terminal output exceeded 1 MiB')
        output.extend(chunk)

    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                chunk = os.read(master, 65536)
                capture(chunk)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if not acted and b'\x1b[?1049h' in output and b'\x1b[?2004h' in output:
            if args.startup_hook:
                stopped = os.waitid(os.P_PID, child.pid, os.WSTOPPED | os.WNOHANG | os.WNOWAIT)
                if stopped is None:
                    if child.poll() is not None:
                        break
                    continue
                if stopped.si_status != signal.SIGSTOP:
                    raise RuntimeError('owned CLI did not reach its requested startup stop')
            ready = True
            active = termios.tcgetattr(slave)
            raw_active = not (active[3] & (termios.ECHO | termios.ICANON))
            if args.exit == 'q':
                os.write(master, b'q')
            elif args.exit == 'ctrl-c':
                os.write(master, b'\x03\x03')
            elif args.exit in ('sigterm', 'sighup'):
                child.send_signal(signal.SIGTERM if args.exit == 'sigterm' else signal.SIGHUP)
                if args.startup_hook:
                    child.send_signal(signal.SIGCONT)
            else:
                directory = os.path.join(args.root, '.fugue', 'log')
                os.makedirs(directory, exist_ok=True)
                with open(os.path.join(directory, 'broken.jsonl'), 'wb') as file:
                    file.write(b'not-json\n')
            acted = True
        if child.poll() is not None:
            # The slave remains owned by this helper, so drain available bytes without waiting for EOF.
            while select.select([master], [], [], 0)[0]:
                capture(os.read(master, 65536))
            break
    else:
        timed_out = True
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
    code = child.wait(timeout=2)
    restored = termios.tcgetattr(slave) == initial
    print(json.dumps({'ready': ready, 'rawActive': raw_active, 'acted': acted, 'timedOut': timed_out, 'code': code,
                      'restored': restored, 'output': output.decode('utf-8', 'replace')}))
finally:
    if child is not None and child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=2)
    termios.tcsetattr(slave, termios.TCSANOW, initial)
    os.close(master)
    os.close(slave)
