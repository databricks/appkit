"""Run a Python entrypoint and take its whole process group down if the Node parent goes away.

    python watchdog.py <module-or-script.py> [args...]

The AppKit omnigent plugin starts each Omnigent process in its own process group. If Node dies without running its
shutdown hook (a crash, SIGKILL, or a platform stop that never reached it), this thread notices the parent change and
kills the group, so no Omnigent process outlives the app and blocks the next deployment.
"""
import os
import runpy
import signal
import sys
import threading
import time

PARENT = os.getppid()


def _watch():
    while True:
        if os.getppid() != PARENT:
            try:
                os.killpg(os.getpgid(0), signal.SIGTERM)
                time.sleep(3)
                os.killpg(os.getpgid(0), signal.SIGKILL)
            finally:
                os._exit(1)
        time.sleep(1)


def main():
    threading.Thread(target=_watch, daemon=True, name="parent-watchdog").start()
    target = sys.argv[1]
    sys.argv = sys.argv[1:]
    if target.endswith(".py"):
        sys.path.insert(0, os.path.dirname(os.path.abspath(target)))
        runpy.run_path(target, run_name="__main__")
    else:
        runpy.run_module(target, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
