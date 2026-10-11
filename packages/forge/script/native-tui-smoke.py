#!/usr/bin/env python3
"""Check native rendering and normal quit in a private PTY without dependencies."""
import argparse
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument("binary")
args = parser.parse_args()
with socket.socket() as endpoint, tempfile.TemporaryDirectory(prefix="forge-tui-native-") as root:
    # Reserve our port without listening. No other process can accept the request.
    endpoint.bind(("127.0.0.1", 0))
    binary = shutil.copy2(os.path.abspath(args.binary), os.path.join(root, "forge"))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    child = subprocess.Popen(
        [binary, "tui", f"http://127.0.0.1:{endpoint.getsockname()[1]}"],
        cwd=root,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env={
            "PATH": "",
            "TERM": "xterm-256color",
            "HOME": root,
            "XDG_DATA_HOME": os.path.join(root, "data"),
            "XDG_CONFIG_HOME": os.path.join(root, "config"),
            "XDG_STATE_HOME": os.path.join(root, "state"),
            "XDG_CACHE_HOME": os.path.join(root, "cache"),
            "FORGE_SERVER_PASSWORD": "",
        },
        start_new_session=True,
        preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0),
    )
    os.close(slave)
    output = bytearray()
    forced = False
    quit_sent = False
    cancel_sent = False
    cancel_offset = 0
    try:
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.2)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
                raw = not termios.tcgetattr(master)[3] & termios.ICANON
                if not cancel_sent and raw and b"Esc cancel" in output:
                    cancel_offset = len(output)
                    # Give Escape a boundary so a following q cannot become Alt+q.
                    os.write(master, b"\x1b[27u")
                    cancel_sent = True
                if not quit_sent and raw and (
                    b"Connection cancelled." in output[cancel_offset:]
                    or b"q quit" in output[cancel_offset:]
                ):
                    os.write(master, b"q")
                    quit_sent = True
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            forced = True
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        os.close(master)
    rendered = b"Choose a TurenOS server" in output and b"\x1b[?1049h" in output
    print(json.dumps({
        "nativeRendered": rendered,
        "outputBytes": len(output),
        "exitCode": child.returncode,
        "forcedStop": forced,
        "cancelSent": cancel_sent,
        "quitSent": quit_sent,
        "terminalRestored": b"\x1b[?1049l" in output,
        "closedLine": b"Turen TUI closed." in output,
        "gracefulQuit": quit_sent and not forced and child.returncode == 0,
        "inertEndpoint": True,
        "cwdHasNodeModules": os.path.exists(os.path.join(root, "node_modules")),
    }))
    raise SystemExit(0 if rendered and quit_sent and not forced and child.returncode == 0 else 1)
