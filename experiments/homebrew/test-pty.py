"""Controlled fixture PTY only. Never pass passwords or run a real installer."""
import errno
import os
import pty
import select
import signal
import sys
import time

pid, master = pty.fork()
if pid == 0:
    os.execv('/bin/bash', ['/bin/bash', sys.argv[1]])
os.write(master, sys.argv[2].encode())
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    else:
        os.kill(pid, signal.SIGKILL)
        raise RuntimeError('Fixture PTY timeout')
finally:
    os.close(master)
    os.waitpid(pid, 0)
