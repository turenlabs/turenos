#!/usr/bin/env python3
"""Audit current runTui source in isolated tmux PTYs, not a live Forge service.

Run from any directory: python3 script/visual-audit.py [output-dir]
Requires installed Bun, tmux, Pillow, and a monospace font family with regular,
bold, italic, and bold-italic faces (DejaVu Sans Mono on Linux, Menlo on macOS).
Each invocation retains its own artifacts; evidence.json and summary.md at the
output root describe the latest invocation. Exit 1 means an audit check failed.
PNGs reconstruct captured terminal cells, not a GUI terminal or image review.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
import uuid
from urllib.parse import parse_qs, urlsplit

import PIL
from PIL import Image, ImageDraw, ImageFont


SIZES = [(160, 48), (120, 36), (90, 28), (80, 24), (60, 24)]
DIRECTORY = "/srv/projects/terminal-workbench/packages/runtime"
TITLE = "Review terminal workbench runtime navigation and preserve every unfinished investigation draft"
LAUNCH = "What would you like to do?"
FINDER = "Search title, project, agent, or session ID\u2026"
ENTER_KEYS = [("Return", "\r"), ("keypad Enter", "\x1b[57414u"), ("LF", "\n")]
UPDATE = (
    "## Keep the conversation in view\n\n"
    "The synthetic runtime review is **ready to inspect**.\n\n"
    "- Preserve the draft while reading updates.\n"
    "- Check long titles and directory clipping.\n\n"
    "```text\nfixture only: no tools or live service\n```\n\n"
    + "\n\n".join(f"Read marker {i:02d}: synthetic review notes." for i in range(1, 41))
    + "\n\n## Live transcript end"
)
TYPING = re.compile(r"\bTyping\b|\u2502\s+(?:Send|Steer|Queue) \u00b7 ")
ANSI = re.compile(r"\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
BASIC = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
]


def color256(n):
    if n < 16:
        return BASIC[n]
    if n > 231:
        return "#%02x%02x%02x" % ((8 + 10 * (n - 232),) * 3)
    n -= 16
    values = [0, 95, 135, 175, 215, 255]
    return "#%02x%02x%02x" % (values[n // 36], values[(n // 6) % 6], values[n % 6])


def render_png(raw, width, height, path, fonts):
    """Render tmux's resolved cell grid, retaining SGR colors and Unicode width."""
    cellw = math.ceil(fonts[0].getlength("M"))
    cellh = sum(fonts[0].getmetrics()) + 2
    image = Image.new("RGB", (width * cellw, height * cellh), "#0a0a0a")
    draw = ImageDraw.Draw(image)
    fg, bg, bold, italic, reverse, underline, dim = "#eeeeee", "#0a0a0a", False, False, False, False, False
    for y, line in enumerate(raw.splitlines()[:height]):
        x = 0
        for token in re.split(f"({ANSI.pattern})", line):
            if token.startswith("\x1b]"):
                continue
            if token.startswith("\x1b["):
                nums = [int(n or 0) for n in token[2:-1].replace(":", ";").split(";")]
                i = 0
                while i < len(nums):
                    n = nums[i]
                    if n == 0:
                        fg, bg, bold, italic, reverse, underline, dim = "#eeeeee", "#0a0a0a", False, False, False, False, False
                    elif n == 1:
                        bold = True
                    elif n == 2:
                        dim = True
                    elif n == 3:
                        italic = True
                    elif n == 4:
                        underline = True
                    elif n == 7:
                        reverse = True
                    elif n == 22:
                        bold = dim = False
                    elif n == 23:
                        italic = False
                    elif n == 24:
                        underline = False
                    elif n == 27:
                        reverse = False
                    elif n == 39:
                        fg = "#eeeeee"
                    elif n == 49:
                        bg = "#0a0a0a"
                    elif 30 <= n <= 37:
                        fg = BASIC[n - 30]
                    elif 40 <= n <= 47:
                        bg = BASIC[n - 40]
                    elif 90 <= n <= 97:
                        fg = BASIC[n - 90 + 8]
                    elif 100 <= n <= 107:
                        bg = BASIC[n - 100 + 8]
                    elif n in (38, 48) and i + 2 < len(nums):
                        value = None
                        if nums[i + 1] == 5:
                            value = color256(nums[i + 2])
                            i += 2
                        elif nums[i + 1] == 2 and i + 4 < len(nums):
                            value = "#%02x%02x%02x" % tuple(nums[i + 2:i + 5])
                            i += 4
                        if value and n == 38:
                            fg = value
                        if value and n == 48:
                            bg = value
                    i += 1
                continue
            for ch in token:
                cells = 0 if unicodedata.combining(ch) else 2 if unicodedata.east_asian_width(ch) in "WF" else 1
                if unicodedata.category(ch).startswith("C"):
                    continue
                a, b = (bg, fg) if reverse else (fg, bg)
                if dim:
                    a = tuple(int(a[i:i + 2], 16) // 2 for i in (1, 3, 5))
                left = (x if cells else max(0, x - 1)) * cellw
                if cells:
                    draw.rectangle((left, y * cellh, (x + cells) * cellw - 1, (y + 1) * cellh - 1), fill=b)
                draw.text((left, y * cellh), ch, font=fonts[int(bold) + 2 * int(italic)], fill=a)
                if underline:
                    draw.line((left, (y + 1) * cellh - 2, left + cellw - 1, (y + 1) * cellh - 2), fill=a)
                x += cells
    image.save(path)


# One monospace face per bold/italic combination, in the order the cell renderer
# indexes them. Pillow resolves bare filenames through the platform's font
# directories; macOS ships its monospace faces in one collection addressed by
# index rather than as separate files.
FONT_SETS = (
    [(f"DejaVuSansMono{suffix}.ttf", 0) for suffix in ("", "-Bold", "-Oblique", "-BoldOblique")],
    [("/System/Library/Fonts/Menlo.ttc", index) for index in range(4)],
    [(f"LiberationMono-{style}.ttf", 0) for style in ("Regular", "Bold", "Italic", "BoldItalic")],
)


# PENDIN marks input awaiting retype and FLUSHO marks discarded output. Both are
# kernel-managed transient state rather than terminal modes a program sets, and
# both legitimately differ across any program that reads stdin: tmux send-keys
# leaves PENDIN set in the "before" sample, and the kernel clears it once the
# client consumes input. Every other bit, and every field of Linux's positional
# `stty -g`, stays strict.
TRANSIENT_LFLAG = 0x20000000 | 0x00800000


def transient_only(before, after):
    if not (before.startswith("lflag=") and after.startswith("lflag=")):
        return False
    try:
        return int(before[6:], 16) & ~TRANSIENT_LFLAG == int(after[6:], 16) & ~TRANSIENT_LFLAG
    except ValueError:
        return False


def stty_changes(before_path, after_path):
    """Name the termios fields a restore failed to put back, for both `stty -g`
    dialects: macOS emits `key=value` pairs and Linux emits positional hex."""
    try:
        before, after = (path.read_text().strip().split(":") for path in (before_path, after_path))
    except OSError:
        return "the shell recorded no stty state"
    if len(before) != len(after):
        return f"stty field count changed: {len(before)} -> {len(after)}"
    changed = [
        f"{b} -> {a}" if "=" in b else f"field {index}: {b} -> {a}"
        for index, (b, a) in enumerate(zip(before, after))
        if b != a and not transient_only(b, a)
    ]
    return "; ".join(changed)


def load_fonts(size=15):
    tried = []
    for candidates in FONT_SETS:
        try:
            return [ImageFont.truetype(name, size, index=index) for name, index in candidates]
        except OSError as error:
            tried.append(f"{candidates[0][0]} ({error})")
    raise SystemExit(
        "No monospace font with regular, bold, italic, and bold-italic faces was found.\n"
        "Install DejaVu Sans Mono (Debian/Ubuntu: fonts-dejavu-core) or Liberation Mono.\n"
        "Tried: " + "; ".join(tried)
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, default=Path(tempfile.gettempdir()) / "opencode" / f"turen-tui-{datetime.now():%Y-%m-%d}")
    parser.add_argument("--sizes", nargs="+", choices=[f"{w}x{h}" for w, h in SIZES], help="Run only these supported terminal sizes")
    parser.add_argument("--built", action="store_true", help="Exercise dist/cli.js from bun run build instead of source")
    parser.add_argument("--exit-only", action="store_true", help="Run only shell-screen and terminal-mode restoration checks")
    parser.add_argument("--lifecycle-only", action="store_true", help="Run exit checks and close/reopen/resize text-widget regressions")
    args = parser.parse_args()
    sizes = [tuple(map(int, size.split("x"))) for size in args.sizes] if args.sizes else SIZES
    repo = Path(__file__).resolve().parents[1]
    bun, tmux_bin = shutil.which("bun"), shutil.which("tmux")
    if not bun or not tmux_bin:
        parser.error("Installed bun and tmux are required; this runner never downloads runtimes.")
    fonts = load_fonts()
    output = args.output.resolve()
    if output == repo or repo in output.parents:
        parser.error("Place generated audit artifacts outside the source repository.")
    run = output / f"run-{datetime.now(timezone.utc):%H%M%S}-{uuid.uuid4().hex[:6]}"
    run.mkdir(parents=True)
    for directory in ("home", "cache", "config", "data", "tmp"):
        (run / directory).mkdir()
    socket = run / "tmux.sock"
    stty_before, stty_after = run / "stty-before", run / "stty-after"
    # Explicit -S never targets an inherited tmux server, even inside user tmux.
    if len(os.fsencode(socket)) >= 104:
        parser.error("Output path is too long for a Unix tmux socket; choose a shorter path.")
    env = {
        "PATH": os.defpath,
        "HOME": str(run / "home"),
        "XDG_CACHE_HOME": str(run / "cache"),
        "XDG_CONFIG_HOME": str(run / "config"),
        "XDG_DATA_HOME": str(run / "data"),
        "TMPDIR": str(run / "tmp"),
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH": str(run / "cache"),
        "BUN_INSTALL_CACHE_DIR": str(run / "cache"),
        "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "C.UTF-8",
        "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1",
    }
    manifest = json.loads((repo / "package.json").read_text())
    # The monorepo pins Bun once, in the workspace root manifest.
    root_manifest = json.loads((repo.parents[1] / "package.json").read_text())
    def hashes():
        return {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((repo / "src").rglob("*.ts"))}
    result = {
        "started": datetime.now(timezone.utc).isoformat(), "repo": str(repo), "artifacts": str(run),
        "entrypoint": "dist/cli.js" if args.built else "src/index.ts:runTui", "source_sha256_start": hashes(),
        "versions": {
            "bun_installed": subprocess.check_output([bun, "--version"], text=True, env=env).strip(),
            "bun_manifest": root_manifest["packageManager"], "root_package": root_manifest["version"],
            "tui_package": manifest["version"], "opentui_manifest": manifest["dependencies"]["@opentui/core"],
            "tmux": subprocess.check_output([tmux_bin, "-V"], text=True, env=env).strip(),
            "python": sys.version.split()[0], "pillow": PIL.__version__,
        },
        "sizes": [list(size) for size in sizes], "resize_shield": [59, 23],
        "fixture": {"scope": "synthetic numeric-loopback only; no real service, credentials, or auth discovery", "directory": DIRECTORY, "title": TITLE},
        "rendering": {"method": "tmux capture-pane SGR cells rendered with Pillow; no image vision assertion", "fonts": [f"{' '.join(filter(None, font.getname()))} ({font.path})" for font in fonts], "cursor": "not overlaid", "visual_review": "required separately"},
        "socket": str(socket), "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "checks": [], "captures": [], "requests": [], "keys": [],
    }
    result["versions"]["matches_manifest_bun"] = "bun@" + result["versions"]["bun_installed"] == root_manifest["packageManager"]
    base = {
        "id": "ses_review", "projectID": "project", "title": TITLE, "agent": "build",
        "location": {"directory": DIRECTORY}, "model": {"providerID": "fixture", "id": "local"},
        "time": {"created": 1, "updated": 100}, "cost": 0,
        "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
    }
    inventory = [base.copy(), {**base, "id": "ses_server", "title": "Review server startup", "location": {"directory": "/srv/services/build"}, "time": {"created": 1, "updated": 90}}, {**base, "id": "ses_release", "title": "Prepare the release notes", "time": {"created": 1, "updated": 80}}]
    inventory += [
        {**base, "id": f"ses_finder_{i:02d}", "title": f"Finder {'child' if i % 5 == 0 else 'session'} {i:02d}",
         "location": {"directory": f"/srv/fixtures/finder/{i:02d}"}, "agent": "plan",
         "time": {"created": 1, "updated": 80 - i}, **({"parentID": "ses_review"} if i % 5 == 0 else {})}
        for i in range(1, 31)
    ]
    result["fixture"]["sessions"] = inventory
    result["fixture"]["session_count"] = len(inventory)
    result["input_encoding"] = {"enter": dict(ENTER_KEYS), "Alt+Enter": "\x1b\r", "Shift+Enter": "\x1b[13;2u", "method": "tmux send-keys -l injects delivered PTY bytes; not physical keyboard capability verification"}
    sessions = []
    # The Ctrl+C that ends a scenario stops a running fixture turn, which is cleanup rather than behaviour under test.
    cleaning = {"on": False}
    stage, size, last_capture = "startup", "", None
    stream_state = {"complete": False, "roster_done": False, "active": True}
    variant_body = {"model": {"providerID": "fixture", "id": "local", "variant": "audit-high"}}
    variant_confirmation = {"armed": False}
    fixture_goal = {
        "id": "goal_audit", "sessionID": "ses_review", "revision": 7,
        "objective": "Synthetic goal objective", "status": "active",
        "tokensUsed": 123, "timeUsedSeconds": 45,
        "time": {"created": 1, "updated": 2, "statusChanged": 1},
    }

    def task_snapshot():
        complete = stage == "live-roster" and stream_state["roster_done"]
        return {"id": "tsk_fixture", "rootSessionID": "ses_review", "parentSessionID": "ses_review", "childSessionID": "ses_finder_05", "agent": "plan", "description": "Live worker" if stage == "live-roster" else "Owned child fixture", "depth": 1, "status": "completed" if complete else "running", "revision": 2 if complete else 1, "time": {"created": 1, "updated": 2 if complete else 1}}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, data, status=200):
            payload = json.dumps(data).encode()
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def record(self, body=None):
            request = {"scenario": stage, "size": size, "method": self.command, "path": self.path, "body": body, "authorization_present": "Authorization" in self.headers, "cleanup": cleaning["on"]}
            result["requests"].append(request)
            return request

        def do_GET(self):
            self.record()
            url = urlsplit(self.path)
            path = url.path
            sid = path.split("/")[3] if path.startswith("/api/session/") else ""
            session = next((s for s in sessions if s["id"] == sid), None)
            if path == "/api/event":
                captured_stage, captured_size = stage, size
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                def emit(kind, fields=None):
                    payload = {"id": "evt_" + uuid.uuid4().hex, "type": kind, "data": fields or {}}
                    self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode())
                    self.wfile.flush()
                base_event = {"sessionID": "ses_review", "assistantMessageID": "msg_latest", "timestamp": 3}
                emitted = 0
                started = time.monotonic()
                try:
                    emit("server.connected")
                    while stage == captured_stage and size == captured_size:
                        elapsed = time.monotonic() - started
                        if captured_stage == "live-stream" and elapsed > 1 and emitted == 0:
                            emit("session.next.text.delta", {**base_event, "textID": "part_text", "delta": "\n\nStreaming update before completion"})
                            emit("session.next.text.delta", {**base_event, "sessionID": "ses_foreign", "textID": "part_text", "delta": "FOREIGN STREAM MUST NOT APPEAR"})
                            emitted = 1
                        if captured_stage == "live-stream" and elapsed > 2 and emitted == 1:
                            emit("session.next.tool.input.started", {**base_event, "callID": "call_stream", "name": "read_file"})
                            emit("session.next.tool.called", {**base_event, "callID": "call_stream", "tool": "read_file", "input": {}, "provider": {"executed": False}})
                            emit("session.next.tool.progress", {**base_event, "callID": "call_stream", "structured": {}, "content": [{"type": "text", "text": "Tool is still running"}]})
                            emitted = 2
                        if captured_stage == "live-stream" and elapsed > 4 and emitted == 2:
                            stream_state["complete"] = True
                            emit("session.next.tool.success", {**base_event, "callID": "call_stream", "structured": {}, "content": [{"type": "text", "text": "Streaming tool complete"}], "provider": {"executed": False}})
                            emit("session.next.text.ended", {**base_event, "textID": "part_text", "text": UPDATE + "\n\nFinished streamed reply"})
                            emitted = 3
                        if captured_stage == "live-roster" and elapsed > 3 and emitted == 0:
                            stream_state["roster_done"] = True
                            emit("session.next.task.updated", {"sessionID": "ses_review", "timestamp": 3, "taskID": "tsk_fixture", "task": task_snapshot()})
                            emitted = 1
                        self.wfile.write(b": heartbeat\n\n")
                        self.wfile.flush()
                        time.sleep(0.25)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if path == "/global/health":
                data = {"healthy": True, "version": "fixture"}
            elif path == "/global/storage":
                data = {"state": {"scope": "desktop/store/working-folders", "key": "open", "value": json.dumps({"version": 1, "directories": [DIRECTORY, "/srv/empty-folder"]}), "revision": 1, "timeCreated": 1, "timeUpdated": 1} if stage == "folder-browser" else None}
            elif path == "/api/location":
                data = {"directory": DIRECTORY, "project": {"id": "project", "directory": DIRECTORY}}
            elif path == "/api/session":
                data = {"data": sessions, "cursor": {}}
            elif path == "/api/session/active":
                data = {"data": {"ses_review": {"type": "running"}} if stream_state["active"] else {}}
            elif path == "/api/pty":
                directory = parse_qs(url.query).get("location[directory]", [DIRECTORY])[0]
                data = {"location": {"directory": directory, "project": {"id": "project", "directory": directory}}, "data": []}
            elif path == "/api/loop":
                data = []
            elif path == "/extension" or re.fullmatch(r"/session/ses_[A-Za-z0-9_]+/todo", path):
                data = []
            elif path == "/api/command":
                directory = parse_qs(url.query).get("location[directory]", [DIRECTORY])[0]
                data = {"location": {"directory": directory, "project": {"id": "project", "directory": directory}}, "data": [{"name": "audit", "description": "Synthetic audit command", "template": "Audit $ARGUMENTS"}]}
            elif path == "/api/agent":
                data = {"location": {"directory": parse_qs(url.query).get("directory", [DIRECTORY])[0]}, "data": [{"id": agent, "mode": "primary", "hidden": False} for agent in ("build", "plan")]}
            elif path == "/provider":
                data = {"all": [{"id": "fixture", "name": "Fixture Provider", "models": {name: {"id": name, "providerID": "fixture", "name": title} for name, title in (("local", "Local Audit Model"), ("review", "Review Audit Model"))}}], "connected": ["fixture"]}
                if stage in ("model-variants", "launch-variant"):
                    data["all"][0]["models"]["local"]["variants"] = {"audit-low": {}, "audit-high": {}}
            elif path == "/provider/auth":
                data = {"fixture": [{"type": "api", "label": "Use fixture API key"}]}
            elif stage == "goal-controls" and path == "/api/session/ses_review/goal":
                data = {"data": fixture_goal}
            elif session and path.endswith("/message"):
                text = UPDATE if sid == "ses_review" else "## " + ("Server startup\n\nThe startup checks are complete." if sid == "ses_server" else f"{session['title']}\n\nFixture session: {sid}\n\nNo model or tools were executed.")
                if stage == "wrapped-text" and sid == "ses_review":
                    text = "\n\n".join(f"WRAP_{i:03d} " + "Long paragraph words retain their spacing while the terminal changes width. " * 3 for i in range(30)) + "\n\nLive transcript end"
                if stage == "numbered-lists" and sid == "ses_review":
                    text = "9.\n   **Ninth item:** Keep this number beside its text even when the sentence wraps.\n10.\n    **Tenth item:** Keep the next item aligned as well.\n\n    Separate paragraph stays separated.\n\nLive transcript end"
                if stage == "live-stream" and sid == "ses_review" and stream_state["complete"]:
                    text += "\n\nFinished streamed reply"
                data = {"data": [{"id": "msg_latest", "sessionID": sid, "type": "assistant", "agent": "build", "model": {"providerID": "fixture", "id": "local"}, "time": {"created": 2}, "content": [{"id": "part_text", "type": "text", "text": text}]}], "cursor": {}}
                if stage == "numbered-lists" and sid == "ses_review":
                    data["data"][0]["content"].insert(0, {"id": "part_reasoning", "type": "reasoning", "text": "Planning the response layout."})
                if stage == "keyboard-workflow" and sid == "ses_review":
                    data["data"].append({"id": "msg_previous", "type": "user", "text": "Prior user prompt for recall.", "time": {"created": 1}})
                if stage == "rewind" and sid == "ses_review":
                    data["data"].append({"id": "msg_rewind_user", "type": "user", "text": "Prior user prompt for undo.", "time": {"created": 1}})
                if stage == "transcript-scroll" and sid == "ses_review":
                    if parse_qs(url.query).get("cursor") == ["before-latest"]:
                        data = {"data": [
                            {"id": "msg_older_reply", "type": "assistant", "agent": "build", "model": {"providerID": "fixture", "id": "local"}, "time": {"created": 1}, "content": [{"id": "part_older", "type": "text", "text": "Earlier reply from the previous page."}]},
                            {"id": "msg_older_prompt", "type": "user", "text": "Earlier prompt from the previous page.", "time": {"created": 0}},
                        ], "cursor": {}}
                    else:
                        data["cursor"] = {"next": "before-latest"}
            elif session and path.endswith("/task"):
                data = {"data": [], "active": [], "cursor": {}}
                if stage in ("owned-reply", "live-roster"):
                    task = task_snapshot()
                    data = {"data": [task], "active": [task], "cursor": {}}
                    if task["status"] == "completed":
                        data["active"] = []
            elif session and stage == "request-enter-guards" and sid == "ses_review" and path.endswith("/permission"):
                data = {"data": [{"id": "per_fixture", "sessionID": sid, "action": "Read fixture file", "resources": ["/srv/fixtures/example.txt"]}]}
            elif session and stage == "request-enter-guards" and sid == "ses_review" and path.endswith("/question"):
                data = {"data": [{"id": "que_fixture", "sessionID": sid, "questions": [{"header": "Fixture question", "question": "Choose a fixture option", "options": [{"label": "Keep", "description": "No real work"}], "custom": False}]}]}
            elif session and stage == "question-picker" and sid == "ses_review" and path.endswith("/question"):
                data = {"data": [{"id": "que_picker", "sessionID": sid, "questions": [
                    {"header": "Approach", "question": "Choose an approach", "options": [{"label": "Small change", "description": "Keep the current design"}, {"label": "New design", "description": "Replace the design"}], "custom": False},
                    {"header": "Scope", "question": "Choose the scope", "options": [{"label": "Source", "description": "Application code"}, {"label": "Tests", "description": "Regression coverage"}], "multiple": True, "custom": True},
                ]}]}
            elif session and path.rsplit("/", 1)[-1] in ("permission", "question", "input"):
                data = {"data": []}
            elif session and path == f"/api/session/{sid}":
                data = {"data": session}
            elif re.fullmatch(r"/api/session/ses_[0-9a-f]+", path):
                # A launch whose prompt is refused locally probes whether its draft session id exists.
                self.send({"message": "Session not found"}, 404)
                return
            else:
                result.setdefault("unexpected_routes", []).append(self.path)
                self.send({"message": "Unknown synthetic fixture route"}, 404)
                return
            self.send(data)

        def mutate(self):
            path = urlsplit(self.path).path
            if self.command == "POST" and stage in ("rewind", "exit-running-ctrl-c") and path in ("/api/session/ses_review/interrupt", "/api/session/ses_review/revert/clear"):
                self.record()
                if path.endswith("/interrupt"):
                    stream_state["active"] = False
                else:
                    next(s for s in sessions if s["id"] == "ses_review").pop("revert", None)
                self.send_response(204)
                self.end_headers()
                return
            if self.command == "POST" and stage == "session-controls" and path == "/api/session/ses_review/compact":
                self.record()
                self.send_response(204)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 131072:
                self.record()
                self.send({"message": "Fixture body limit"}, 413)
                return
            body = json.loads(self.rfile.read(length))
            request = self.record(body)
            path = urlsplit(self.path).path
            if self.command == "POST" and stage == "question-picker" and path == "/api/session/ses_review/question/que_picker/reply":
                self.send_response(204)
                self.end_headers()
                return
            if self.command == "POST" and stage == "model-variants" and path == "/api/session/ses_review/model" and body == variant_body and variant_confirmation["armed"]:
                variant_confirmation["armed"] = False
                request["explicit_variant_confirmation"] = True
                next(s for s in sessions if s["id"] == "ses_review")["model"] = body["model"]
                self.send_response(204)
                self.end_headers()
                return
            if stage in ("goal-controls", "model-variants", "launch-variant"):
                self.send({"message": "No unconfirmed mutation allowed in goal/variant audit"}, 405)
                return
            if self.command == "POST" and stage == "rewind" and path == "/api/session/ses_review/revert/stage" and body == {"messageID": "msg_rewind_user", "files": False}:
                revert = {"messageID": body["messageID"], "files": []}
                next(s for s in sessions if s["id"] == "ses_review")["revert"] = revert
                self.send({"data": revert})
                return
            if self.command == "POST" and stage == "session-controls" and path == "/api/session/ses_review/agent" and body.get("agent") == "plan":
                next(s for s in sessions if s["id"] == "ses_review")["agent"] = "plan"
                self.send_response(204)
                self.end_headers()
                return
            if self.command == "POST" and path == "/api/session":
                session = {**base, "id": body["id"], "title": "Synthetic launch audit", "location": body["location"], "time": {"created": 200, "updated": 200}}
                sessions.append(session)
                self.send({"data": session})
                return
            if self.command == "POST" and re.fullmatch(r"/api/session/ses_[A-Za-z0-9_]+/prompt", path):
                self.send({"data": {"id": body["id"], "sessionID": path.split("/")[3], "prompt": body["prompt"], "delivery": body.get("delivery", "steer"), "admittedSeq": 1, "timeCreated": 1}})
                return
            if self.command == "POST" and stage == "slash-commands" and body.get("command") == "audit" and re.fullmatch(r"/api/session/ses_[A-Za-z0-9_]+/command", path):
                self.send({"data": {"id": body["id"], "sessionID": path.split("/")[3], "admittedSeq": 1, "timeCreated": 1}})
                return
            self.send({"message": "Only synthetic session creation and prompts are allowed"}, 405)

        do_POST = do_PUT = do_PATCH = do_DELETE = mutate

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"
    result["fixture"]["url"] = url
    code = f"import {{runTui}} from {json.dumps(str(repo / 'src/index.ts'))}; await runTui({json.dumps({'url': url, 'directory': DIRECTORY, 'password': ''})});"
    command = [bun, "--no-install", "-e", code]
    if args.built:
        command = [bun, "--no-install", str(repo / "dist/cli.js"), "--dir", DIRECTORY, url]
    result["command"] = command

    def tmux(*args, check=True):
        return subprocess.run([tmux_bin, "-S", str(socket), "-f", "/dev/null", *args], env=env, text=True, capture_output=True, check=check, timeout=15).stdout

    def frame():
        return tmux("capture-pane", "-p", "-t", "audit:0.0")

    def key(*keys, literal=False):
        result["keys"].append({"scenario": stage, "size": size, "literal": literal, "keys": list(keys)})
        for value in keys:
            tmux("send-keys", "-t", "audit:0.0", *(["-l", "--"] if literal else []), value)
            # Escape needs its own timeout boundary, or Escape+b is Alt+b.
            time.sleep(0.3 if value == "Escape" and not literal else 0.16)

    def wait(text, absent=False, seconds=6):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            plain = frame()
            # A notice that wraps at narrow widths still counts as the same sentence.
            if (text in plain or text in " ".join(plain.split())) != absent:
                return plain
            time.sleep(0.1)
        raise AssertionError(f"{'Unexpected remaining' if absent else 'Missing'} terminal text: {text!r}")

    def typing(plain=None):
        """True while the reply editor holds the keyboard. The footer says Typing, but it truncates at 60 columns, so the docked editor's heading counts too."""
        return bool(TYPING.search(frame() if plain is None else plain))

    def wait_typing(absent=False, seconds=6):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            plain = frame()
            if typing(plain) != absent:
                return plain
            time.sleep(0.1)
        raise AssertionError(f"{'Unexpected remaining' if absent else 'Missing'} reply editor (Typing)")

    def shortcuts():
        """Leave the reply editor, which holds the keyboard while a session is in view, so letters act as shortcuts."""
        if typing():
            key("Escape")
        wait_typing(absent=True)

    def compose():
        """Open the reply editor from shortcut mode with f, or keep it when it is already open."""
        time.sleep(0.3)  # a closing dialog may hand the keyboard back to the editor just now
        if typing():
            return
        key("f")
        wait_typing()

    def is_open(kind):
        return typing() if kind == "reply" else LAUNCH in frame()

    def wait_open(kind):
        return wait_typing() if kind == "reply" else wait(LAUNCH)

    def open_kind(kind):
        """Open the reply editor (f) or the New session dialog (n) from whatever the screen holds."""
        if kind == "reply":
            return compose()
        shortcuts()
        key("n")
        wait(LAUNCH)

    def writes_since(start):
        return [r for r in result["requests"][start:] if r["method"] != "GET"]

    def allowed_request(request):
        if request.get("cleanup"):
            return request["method"] == "GET" or request["path"] == "/api/session/ses_review/interrupt"
        if request["authorization_present"]:
            return False
        if request["method"] == "GET":
            return True
        if request["method"] != "POST":
            return False
        path, body = request["path"], request["body"] or {}
        if request["scenario"] in ("goal-controls", "model-variants", "launch-variant"):
            return request["scenario"] == "model-variants" and path == "/api/session/ses_review/model" and body == variant_body and request.get("explicit_variant_confirmation") is True
        if path == "/api/session" or re.fullmatch(r"/api/session/ses_[A-Za-z0-9_]+/prompt", path):
            return True
        if request["scenario"] == "slash-commands":
            return path == "/api/session/ses_review/command" and body.get("command") == "audit"
        if request["scenario"] == "session-controls":
            return path == "/api/session/ses_review/compact" or (path == "/api/session/ses_review/agent" and body.get("agent") == "plan")
        if request["scenario"] == "exit-running-ctrl-c":
            return path == "/api/session/ses_review/interrupt"
        if request["scenario"] == "rewind":
            return path in ("/api/session/ses_review/interrupt", "/api/session/ses_review/revert/clear") or (path == "/api/session/ses_review/revert/stage" and body == {"messageID": "msg_rewind_user", "files": False})
        if request["scenario"] == "question-picker":
            return path == "/api/session/ses_review/question/que_picker/reply" and body == {"answers": [["New design"], ["Source", "Alpha, beta"]]}
        return False

    def mouse(button, x, y):
        # SGR mouse coordinates are one-based; wheel events have no release.
        key(f"\x1b[<{button};{x + 1};{y + 1}M" + (f"\x1b[<{button};{x + 1};{y + 1}m" if button < 64 else ""), literal=True)

    def finder_position():
        found = re.search(r"(\d+)/(\d+)(?: main sessions)? ·", frame())
        if not found:
            raise AssertionError("Finder selection/count footer is missing")
        return tuple(map(int, found.groups()))

    def capture(name):
        nonlocal last_capture
        time.sleep(0.2)
        width, height = map(int, tmux("display-message", "-p", "-t", "audit:0.0", "#{pane_width} #{pane_height}").split())
        raw = tmux("capture-pane", "-p", "-e", "-t", "audit:0.0")
        plain = ANSI.sub("", raw)
        stem = run / f"{name}-{size}"
        stem.with_suffix(".ansi").write_text(raw)
        stem.with_suffix(".txt").write_text(plain)
        render_png(raw, width, height, stem.with_suffix(".png"), fonts)
        last_capture = {"scenario": stage, "name": name, "requested_size": size, "actual_size": [width, height], "ansi": str(stem.with_suffix(".ansi")), "text": str(stem.with_suffix(".txt")), "png": str(stem.with_suffix(".png"))}
        result["captures"].append(last_capture)
        print(f"CAPTURE {last_capture['png']}", flush=True)
        return plain

    def check(condition, label, details=None):
        if not condition:
            capture(f"failure-{stage}-{len(result['checks'])}")
        result["checks"].append({"scenario": stage, "size": size, "check": label, "passed": bool(condition), "details": details, "png": last_capture["png"] if last_capture else None})
        if not condition:
            print(f"FAIL {size} {stage}: {label}", flush=True)

    @contextmanager
    def scenario(name, width, height):
        nonlocal stage, size, last_capture
        stage, size, last_capture = name, f"{width}x{height}", None
        stream_state.update(complete=False, roster_done=False, active=True)
        variant_confirmation["armed"] = False
        sessions[:] = [] if name == "welcome" else [session.copy() for session in inventory]
        if name == "welcome" or (name.startswith("exit-") and not name.startswith("exit-running")) or name == "keyboard-workflow":
            # Nothing running, so q and Ctrl+C quit at once instead of stopping or warning first.
            stream_state["active"] = False
        try:
            tmux("new-session", "-d", "-s", "audit", "-x", str(width), "-y", str(height), "-c", str(repo), "/bin/sh")
            # Keep this dedicated server alive between cases; cleanup kills its exact socket.
            tmux("set-option", "-s", "exit-empty", "off")
            tmux("set-option", "-t", "audit", "status", "off")
            tmux("set-option", "-t", "audit", "remain-on-exit", "on")
            launch = "exec " + shlex.join(command)
            if name.startswith("exit-"):
                # Record both mode strings off-screen: a restore failure is only
                # actionable if it names the termios fields that changed.
                launch = (
                    "modes=$(stty -g); printf '\\033[2J\\033[HPREVIOUS-SHELL-SCREEN\\n'; "
                    + shlex.join(command)
                    + "; code=$?; printf '\\nAPP_EXIT:%s\\n' \"$code\"; after=$(stty -g); "
                    + f"printf '%s\\n' \"$modes\" >{shlex.quote(str(stty_before))}; "
                    + f"printf '%s\\n' \"$after\" >{shlex.quote(str(stty_after))}; "
                    + "if [ \"$after\" = \"$modes\" ]; then printf 'TTY_RESTORED\\n'; else printf 'TTY_CHANGED\\n'; fi; "
                    + "printf 'RETURNED-TO-SHELL\\n'"
                )
            tmux("send-keys", "-t", "audit:0.0", "-l", launch)
            tmux("send-keys", "-t", "audit:0.0", "Enter")
            wait("[ Turen ]" if name == "welcome" else "Question 1 of 2" if name == "question-picker" else "Needs input" if name == "request-enter-guards" else "Live transcript end", seconds=15)
            yield
        except Exception as error:
            try:
                capture(f"failure-{name}")
            except Exception as capture_error:
                result.setdefault("capture_errors", []).append(str(capture_error))
            result["checks"].append({"scenario": stage, "size": size, "check": "scenario completed", "passed": False, "details": str(error), "png": last_capture["png"] if last_capture else None})
            print(f"FAIL {size} {stage}: {error}", flush=True)
        finally:
            cleaning["on"] = True
            tmux("send-keys", "-t", "audit:0.0", "C-c", check=False)
            time.sleep(0.4)
            tmux("kill-session", "-t", "audit", check=False)
            cleaning["on"] = False

    def edited_draft(kind):
        key("alpha beta gamma", literal=True)
        key("C-a", "C-d")
        check("lpha beta gamma" in frame(), f"{kind}: Ctrl+D deletes forward without discarding")
        key("End", "M-Left")
        key("X", literal=True)
        check("lpha beta Xgamma" in frame(), f"{kind}: Alt+Left moves by word without hopping")
        key("M-Right")
        key("Y", literal=True)
        check("lpha beta XgammaY" in frame(), f"{kind}: Alt+Right moves by word without hopping")
        key("C-a", "Right", "Right", "Right", "Right", "C-k")
        check("lpha" in frame() and "Xgamma" not in frame() and FINDER not in frame(), f"{kind}: Ctrl+K kills line suffix without opening picker")
        key(" preserved", literal=True)
        capture(f"{kind}-edited")
        return "lpha preserved"

    def choose_session(query, expected):
        shortcuts()
        key("C-k")
        wait(FINDER)
        key(query, literal=True)
        key("Enter")
        wait(expected)

    def stop_on_signal(signum, _frame):
        raise KeyboardInterrupt(f"signal {signum}")

    old_signals = {sig: signal.signal(sig, stop_on_signal) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        for width, height in sizes:
            for exit_kind in ("q", "ctrl-c", "draft", "draft-q", "resize", "late-csi", "late-osc", "running-q", "running-ctrl-c"):
                with scenario(f"exit-{exit_kind}", width, height):
                    start = len(result["requests"])
                    if exit_kind == "draft":
                        # The reply editor holds the draft; the first Ctrl+C only warns.
                        compose()
                        key("Unsent exit fixture", literal=True)
                        key("C-c")
                        wait("Draft kept. Ctrl+C again quits and discards unsent drafts.")
                        check("RETURNED-TO-SHELL" not in frame() and typing(), "first Ctrl+C retains a draft without exiting")
                    if exit_kind == "draft-q":
                        compose()
                        key("Unsent exit fixture", literal=True)
                        shortcuts()
                        key("q")
                        wait("Unsent drafts are kept only until you quit.")
                        check("RETURNED-TO-SHELL" not in frame(), "first q retains a draft without exiting")
                    if exit_kind == "running-q":
                        shortcuts()
                        key("q")
                        wait("The agent is still working. Press q again to quit")
                        check("RETURNED-TO-SHELL" not in frame() and not writes_since(start), "first q on a running session warns without stopping it")
                    if exit_kind == "running-ctrl-c":
                        key("C-c")
                        wait("Session interrupted. Ctrl+C again quits.")
                        check([r["path"] for r in writes_since(start)] == ["/api/session/ses_review/interrupt"], "first Ctrl+C stops the running turn and does not exit")
                        check("RETURNED-TO-SHELL" not in frame(), "Ctrl+C that stopped a turn leaves the TUI running")
                    if exit_kind == "resize":
                        tmux("resize-window", "-t", "audit:0", "-x", "59", "-y", "23")
                        wait("Resize the terminal")
                        tmux("resize-window", "-t", "audit:0", "-x", str(width), "-y", str(height))
                        wait("Live transcript end")
                    if exit_kind.startswith("late-"):
                        tmux("send-keys", "-t", "audit:0.0", "C-c")
                        time.sleep(0.06)
                        reply = "\x1b[4;480;800t" if exit_kind == "late-csi" else "\x1b]11;rgb:1111/2222/3333\x07"
                        tmux("send-keys", "-t", "audit:0.0", "-l", reply)
                    elif exit_kind in ("q", "resize"):
                        shortcuts()
                        key("q")
                    else:
                        key("C-c" if exit_kind in ("ctrl-c", "draft", "running-ctrl-c") else "q")
                    wait("RETURNED-TO-SHELL")
                    plain = capture(f"exit-restored-{exit_kind}")
                    check(plain.splitlines()[0].strip() == "PREVIOUS-SHELL-SCREEN", "exit restores the previous shell screen")
                    check("Live transcript end" not in plain and "Type a message" not in plain, "exit leaves no TUI transcript or reply artifacts")
                    check("4;480;800t" not in plain and "rgb:1111/2222/3333" not in plain and "^[" not in plain, "late terminal replies do not leak into the shell")
                    drift = stty_changes(stty_before, stty_after)
                    check("APP_EXIT:0" in plain and not drift, "exit succeeds and restores original stty modes", drift or None)
                    modes = tmux("display-message", "-p", "-t", "audit:0.0", "#{alternate_on}:#{cursor_flag}:#{mouse_any_flag}:#{mouse_button_flag}:#{mouse_standard_flag}").strip()
                    check(modes == "0:1:0:0:0", "exit leaves normal screen, visible cursor, and mouse reporting off", modes)
                    expected = ["/api/session/ses_review/interrupt"] if exit_kind == "running-ctrl-c" else []
                    check([r["path"] for r in writes_since(start)] == expected, "exiting never sends a prompt or stops server work beyond the Ctrl+C that asked for it")
            if args.exit_only:
                continue
            with scenario("text-lifecycle", width, height):
                start = len(result["requests"])
                for shortcut, title in (("C-n", LAUNCH), ("C-k", "Switch session")):
                    for cycle in range(2):
                        shortcuts()
                        key(shortcut)
                        wait(title)
                        key("Escape")
                        wait(title, absent=True)
                        resized = (160, 48) if cycle == 0 else (60, 24)
                        tmux("resize-window", "-t", "audit:0", "-x", str(resized[0]), "-y", str(resized[1]))
                        wait("Live transcript end")
                        plain = capture(f"closed-{shortcut}-resize-{cycle}")
                        check("TextBuffer is destroyed" not in plain and "[ERROR]" not in plain, "closed text widgets survive later resize and reopening")
                check(not writes_since(start), "widget lifecycle checks perform no mutation")
            if args.lifecycle_only:
                continue
            with scenario("launch-logo", width, height):
                start = len(result["requests"])
                key("C-n")
                wait(LAUNCH)
                plain = capture("launch-retro-logo")
                check("▀" in plain and "[ Send (Enter) ]" in plain, "retro logo retains visible task and Send controls")
                ansi = tmux("capture-pane", "-p", "-e", "-t", "audit:0.0")
                check(len(set(re.findall(r"38;(?:2;\d+;\d+;\d+|5;\d+)", ansi))) >= 6, "logo emits multiple native terminal colors")
                key("Ready to build", literal=True)
                check("Ready to build" in frame() and not writes_since(start), "logo never takes task input focus or submits")
                key("F4")
            with scenario("sidebar-finder", width, height):
                start = len(result["requests"])
                if width < 90:
                    shortcuts()
                    key("b")
                sidebar = wait("Find a session").splitlines()
                row = next(i for i, line in enumerate(sidebar) if "Find a session" in line)
                mouse(0, sidebar[row].index("Find a session") + 1, row)
                wait("Switch session")
                plain = capture("sidebar-finder")
                check("[Recent]" in plain and "Archived" in plain, "sidebar finder exposes the same scopes as Ctrl+K")
                if width >= 90:
                    check("Live transcript end" in plain, "right-side finder leaves desktop conversation visible")
                key("server startup", literal=True)
                key("Enter")
                wait("The startup checks are complete")
                check(not writes_since(start), "sidebar search opens its chosen session without mutation")
            with scenario("folder-browser", width, height):
                start = len(result["requests"])
                key("C-p")
                wait("Commands")
                key("Working folders", literal=True)
                key("Enter")
                wait("Directory on the server")
                plain = capture("working-folders")
                check("/srv/empty-folder" in plain, "shared folder without sessions remains discoverable")
                key("Enter")
                check(not writes_since(start), "Enter does not implicitly open or close a shared folder")
                key("Escape")
            with scenario("welcome", width, height):
                start = len(result["requests"])
                plain = capture("welcome")
                check("Connected" in plain and "Ctrl+K Session picker" in plain and "? Help" in plain, "welcome shows connection and direct shortcuts")
                shortcuts()
                key("C-k")
                wait(FINDER)
                key("Escape")
                wait("[ Turen ]")
                shortcuts()
                key("n")
                wait(LAUNCH)
                check(not writes_since(start), "welcome opens picker and New session without an extra gate or submission")
                key("F4")
            if (width, height) in ((60, 24), (160, 48)):
                with scenario("goal-controls", width, height):
                    start = len(result["requests"])
                    compose()
                    key("/goal", literal=True)
                    key("Enter")
                    wait("Enter choose · Ctrl+R refresh · Esc close")
                    plain = capture("goal-overview")
                    check("Synthetic goal objective" in plain and "Revision: 7" in plain, "/goal displays captured goal read-only")
                    key("C-r")
                    key("Enter")
                    wait("Goal › Edit?")
                    key("End", "Enter")
                    key("GOAL-TEXTAREA-MARKER", literal=True)
                    plain = capture("goal-textarea")
                    check("GOAL-TEXTAREA-MARKER" in plain and "STARTS execution" in plain, "actual goal textarea and execution warning remain visible")
                    check(not writes_since(start), "overview refresh and textarea Enter only read; no prompt or goal mutation")
                    key("Escape")
                    wait("Enter choose · Ctrl+R refresh · Esc close")
                    key("Down", "Down", "Enter")
                    wait("Goal › Clear?")
                    key("Enter", "C-s")
                    wait("Type clear to confirm.")
                    key("clear", literal=True)
                    key("Enter")
                    plain = capture("goal-clear-typed")
                    # A separate input row proves visibility, not the repeated instructions.
                    typed_rows = [line.strip(" │") for line in plain.splitlines()]
                    check("clear" in typed_rows and "STOPS active work" in plain, "actual typed clear input and stop warning remain visible")
                    check(not writes_since(start), "blank Ctrl+S and typed clear plus Enter never confirm or interrupt")
                    key("Escape")
                    wait("Enter choose · Ctrl+R refresh · Esc close")
                    key("Escape")
                    check(not writes_since(start), "cancelling goal controls performs zero writes")

                with scenario("model-variants", width, height):
                    start = len(result["requests"])
                    compose()
                    key("/effort", literal=True)
                    key("Enter")
                    wait("audit-high")
                    plain = capture("effort-advertised")
                    check("Model default" in plain and "audit-low" in plain, "/effort offers only advertised variants and default")
                    key("Down", "Down")
                    check(not writes_since(start), "effort browsing is read-only before explicit selection")
                    variant_confirmation["armed"] = True
                    key("Enter")
                    wait("Variant confirmed: audit-high")
                    capture("effort-confirmed")
                    writes = writes_since(start)
                    check(len(writes) == 1 and allowed_request(writes[0]), "explicit effort selection sends only exact synthetic model write", writes)
                    compose()
                    key("/effort", literal=True)
                    key("Enter")
                    wait("audit-high")
                    key("Escape")
                    check(len(writes_since(start)) == 1, "reopening and cancelling effort sends no additional write")

                with scenario("launch-variant", width, height):
                    start = len(result["requests"])
                    shortcuts()
                    key("n")
                    wait(LAUNCH)
                    key("C-l")
                    wait("Find a model or provider")
                    key("Local Audit Model", literal=True)
                    key("Enter")
                    wait(LAUNCH)
                    key("/effort", literal=True)
                    key("Enter")
                    wait("audit-high")
                    capture("launch-effort-advertised")
                    key("Down", "Down", "Enter")
                    wait(LAUNCH)
                    key("LAUNCH-DRAFT-MARKER", literal=True)
                    key("Escape", "n")
                    wait(LAUNCH)
                    plain = capture("launch-effort-draft-restored")
                    check("LAUNCH-DRAFT-MARKER" in plain and "audit-high" in plain, "new-session task and local variant survive cancel and reopen")
                    key("C-l")
                    wait("Find a model or provider")
                    key("Escape")
                    wait(LAUNCH)
                    check("LAUNCH-DRAFT-MARKER" in frame() and "audit-high" in frame(), "local model picker cancellation preserves task and effort")
                    key("F4")
                    check(not writes_since(start), "launch effort selection and draft preservation never create a session or send work")

            with scenario("dashboard", width, height):
                plain = capture("dashboard")
                check("Live transcript end" in plain and "ses_review" not in plain, "default conversation follows latest transcript without internal IDs")
                check(("2 Term" in plain) == (width >= 90), "sidebar default follows 90-column breakpoint")
                shortcuts()
                key("b")
                plain = capture("dashboard-sidebar-hidden" if width >= 90 else "dashboard-sidebar-shown")
                check(("2 Term" in plain) == (width < 90), "b toggles sidebar")
                if width < 90:
                    check("> * Review" in plain, "shown narrow sidebar reveals the current session")
                check("Live transcript end" in plain, "conversation remains visible when sidebar toggled")
                shortcuts()
                key("b")
                shortcuts()
                # The fixture session is running, so the first q only warns that it keeps running.
                key("q")
                wait("The agent is still working. Press q again to quit")
                key("q")
                time.sleep(0.3)
                check(tmux("display-message", "-p", "-t", "audit:0.0", "#{pane_dead}:#{pane_dead_status}").strip() == "1:0", "q exits source TUI cleanly")

            with scenario("rewind", width, height):
                start = len(result["requests"])
                key("C-p")
                key("Undo conversation turn", literal=True)
                key("Enter")
                wait("Confirmation (type undo)")
                plain = capture("undo-confirmation")
                check("Conversation only" in plain and "Conversation + files" in plain, "undo file mode stays visible beside confirmation")
                key("Enter")
                check(not writes_since(start), "undo never mutates before typed confirmation")
                key("undo", literal=True)
                key("C-s")
                wait("UNDO STAGED")
                plain = capture("undo-staged")
                check("Live transcript end" not in plain, "recent view hides staged-away output")
                compose()
                wait("Prior user prompt for undo.")
                capture("undo-restored-draft")
                key("Escape")
                key("C-p")
                key("Redo conversation turn", literal=True)
                key("Enter")
                wait("Confirmation (type redo)")
                key("redo", literal=True)
                key("C-s")
                wait("Live transcript end")
                capture("redo-restored")
                check([r["path"] for r in writes_since(start)] == ["/api/session/ses_review/interrupt", "/api/session/ses_review/revert/stage", "/api/session/ses_review/interrupt", "/api/session/ses_review/revert/clear"], "undo/redo use explicit ordered endpoints without sending a prompt")

            with scenario("live-stream", width, height):
                start = len(result["requests"])
                wait("Streaming update before completion")
                wait("Tool is still running")
                plain = capture("live-in-progress")
                check(not stream_state["complete"] and "FOREIGN STREAM MUST NOT APPEAR" not in plain, "text and tool progress render before completion and ignore foreign sessions")
                wait("Streaming tool complete")
                wait("Finished streamed reply")
                capture("live-completed")
                check(not writes_since(start), "live events are read-only")

            with scenario("live-roster", width, height):
                shortcuts()
                key("t")
                wait("Live worker")
                key("Live", literal=True)
                wait("[completed] Live worker")
                plain = capture("roster-live-update")
                check("Recent and active subagent tasks" in plain and "Live" in plain, "open task roster refreshes without leaving picker")

            with scenario("keyboard-workflow", width, height):
                start = len(result["requests"])
                if width >= 90:
                    key("Enter")
                wait_typing()
                key("Up")
                wait("Prior user prompt for recall.")
                capture("prompt-recall")
                key("C-c")
                wait("Draft kept.")
                check(typing() and "Prior user prompt for recall." in frame(), "Ctrl+C keeps the draft in the open editor and does not quit")
                shortcuts()
                compose()
                check("Prior user prompt for recall." in frame(), "draft survives leaving and reopening the editor")
                key("C-c")
                wait("Draft kept.")
                key("C-c")
                time.sleep(0.2)
                check(tmux("display-message", "-p", "-t", "audit:0.0", "#{pane_dead}:#{pane_dead_status}").strip() == "1:0", "second Ctrl+C explicitly quits")
                check(not writes_since(start), "recall and cancel never submit a message")

            with scenario("session-controls", width, height):
                start = len(result["requests"])
                key("C-p")
                key("Choose agent for this session", literal=True)
                key("Enter")
                wait("Choose session agent")
                key("plan", literal=True)
                wait("plan")
                key("Enter")
                wait("Agent: plan")
                capture("agent-selected")
                key("C-p")
                key("Compact session context", literal=True)
                key("Enter")
                wait("Compact session?")
                key("Enter")
                check(len(writes_since(start)) == 1, "plain Enter does not confirm compaction")
                key("C-s")
                wait("Compacted")
                capture("session-compacted")
                check([r["path"] for r in writes_since(start)] == ["/api/session/ses_review/agent", "/api/session/ses_review/compact"], "agent change and explicit compaction use exact endpoints without interrupting")

            with scenario("slash-commands", width, height):
                start = len(result["requests"])
                if width >= 90:
                    key("Enter")
                shortcuts()
                key("/", literal=True)
                wait_typing()
                key("hel", literal=True)
                wait("Keyboard help")
                capture("slash-suggestions")
                key("Tab", "C-s")
                wait("Keyboard shortcuts")
                check(not writes_since(start), "local slash help opens UI without sending a prompt")
                key("Escape")
                compose()
                key("/audit  recent changes", literal=True)
                key("Enter")
                wait("Reply sent.")
                capture("slash-command-sent")
                writes = writes_since(start)
                check(len(writes) == 1 and writes[0]["path"] == "/api/session/ses_review/command" and writes[0]["body"]["arguments"] == " recent changes" and writes[0]["body"].get("resume") is True and "delivery" not in writes[0]["body"], "server slash command preserves arguments and uses command endpoint", writes)
                key("C-x")
                wait("Recent and active subagent tasks")
                capture("subagent-browser")
                check(len(writes_since(start)) == 1, "Ctrl+X opens subagent browser without sending")

            with scenario("copy-mouse", width, height):
                start = len(result["requests"])
                # A first click in the transcript opens the reply editor and moves the rows, so open it before aiming.
                compose()
                lines = frame().splitlines()
                row = next(i for i, line in enumerate(lines) if "Live transcript end" in line)
                column = lines[row].index("Live transcript end")
                key(f"\x1b[<0;{column + 1};{row + 1}M\x1b[<32;{column + 8};{row + 1}M\x1b[<0;{column + 8};{row + 1}m", literal=True)
                key("C-y")
                plain = capture("copy-selection")
                check("Terminal copy attempted" in plain or "Terminal copy unavailable" in plain, "selected text requests terminal clipboard copy without claiming delivery")
                mouse(2, column + 2, row)
                check("Terminal copy" in frame(), "right-click on selected transcript invokes copy")
                key("F6")
                wait("TUI mouse disabled")
                key("F6")
                wait("TUI mouse enabled")
                capture("mouse-restored")
                check(not writes_since(start), "copy and mouse mode changes do not mutate sessions")

            with scenario("owned-reply", width, height):
                start = len(result["requests"])
                choose_session("Finder child 05", "Fixture session: ses_finder_05")
                shortcuts()
                key("/", literal=True)
                wait("Find a command")
                key("help", literal=True)
                key("Enter")
                wait("Keyboard shortcuts")
                key("Escape")
                shortcuts()
                key("f")
                wait("Task-owned subagent")
                plain = capture("owned-child-reply")
                check(not typing(plain), "owned child offers navigation instead of an invalid reply editor")
                key("Enter")
                wait_typing()
                check("Reply to" in frame(), "owning-session navigation opens its reply editor")
                check(not writes_since(start), "opening the owning main session sends no prompt")
                key("F4")

            with scenario("wrapped-text", width, height):
                start = len(result["requests"])
                if width >= 90:
                    key("Enter")
                key("PPage", "PPage")
                marker = re.search(r"WRAP_\d+", frame()).group(0)
                capture("wrapped-reading")
                for columns in [60 if width >= 90 else 120, width]:
                    tmux("resize-window", "-t", "audit:0", "-x", str(columns), "-y", str(height))
                    wait(marker)
                    check("Live transcript end" not in frame(), "width reflow keeps the reader's paragraph rather than jumping to the tail")
                compose()
                draft = "Wrapped draft words preserve spaces. " * 35 + "\nDRAFTEND"
                key("\x1b[200~" + draft + "\x1b[201~", literal=True)
                wait("DRAFTEND")
                for columns in [60, 120, width]:
                    tmux("resize-window", "-t", "audit:0", "-x", str(columns), "-y", str(height))
                    wait("DRAFTEND")
                    plain = capture(f"wrapped-reply-{columns}")
                    check("Enter Send" in plain and "F4 discard" in plain, "wrapped draft keeps its tail and controls visible")
                check(not writes_since(start), "wrapping and resizing never submits the draft")
                key("F4")

            with scenario("numbered-lists", width, height):
                start = len(result["requests"])
                wait("9. Ninth item:")
                wait("10. Tenth item:")
                for columns in [60, 120, width]:
                    tmux("resize-window", "-t", "audit:0", "-x", str(columns), "-y", str(height))
                    wait("9. Ninth item:")
                    wait("10. Tenth item:")
                    plain = capture(f"numbered-list-{columns}")
                    check("9. Ninth item:" in plain and "10. Tenth item:" in plain, "number and next-line item text share a row after reflow")
                shortcuts()
                key("r")
                wait("10. Tenth item:")
                check(not writes_since(start), "numbered-list inspection and refresh send no prompt")

            with scenario("activity-orb", width, height):
                orbs = []
                for index in range(4):
                    plain = capture(f"particle-orb-{index}")
                    match = re.search(r"Working(?: \([^)]*\))? ([\u2800-\u28ff]{3})", plain)
                    check(match is not None, "working indicator uses three dotted cells")
                    orbs.append(match[1] if match else "")
                    time.sleep(0.13)
                check(len(set(orbs)) > 1, "orb particles move between terminal frames")
                key("C-p")
                key("Toggle reduced motion", literal=True)
                key("Enter")
                wait("Reduced motion on")
                first = re.search(r"Working(?: \([^)]*\))? ([\u2800-\u28ff]{3})", frame())[1]
                time.sleep(0.35)
                check(re.search(r"Working(?: \([^)]*\))? ([\u2800-\u28ff]{3})", frame())[1] == first, "reduced motion freezes particles without hiding Working")

            with scenario("transcript-scroll", width, height):
                start = len(result["requests"])
                if width >= 90:
                    key("Enter")
                # With the reply editor open, paging up only reveals what is cached; older pages load in shortcut mode.
                shortcuts()
                for _ in range(12):
                    key("PPage")
                    if "Earlier prompt from the previous page." in frame():
                        break
                plain = capture("transcript-earlier")
                check("Earlier prompt from the previous page." in plain and "Earlier reply from the previous page." in plain, "scrolling up loads previous prompts and replies without switching modes")
                check("History" not in plain.splitlines()[3], "older messages remain in the live transcript")
                key("End")
                wait("Live transcript end")
                shortcuts()
                key("r")
                for _ in range(12):
                    key("PPage")
                    if "Earlier prompt from the previous page." in frame():
                        break
                check("Earlier prompt from the previous page." in frame(), "refresh retains loaded older conversation")
                older_reads = [r for r in result["requests"][start:] if "cursor=before-latest" in r["path"]]
                check(len(older_reads) == 1, "older cursor loads once, not again on refresh or scroll")

            with scenario("resize", width, height):
                def stable_frame():
                    return re.sub(r"[\u2800-\u28ff]{3}", "GLOBE", frame())

                baseline = None
                for cycle in range(2):
                    for columns, rows in [(60, 24), (160, 48), (90, 28), (59, 23), (120, 36), (width, height)]:
                        tmux("resize-window", "-t", "audit:0", "-x", str(columns), "-y", str(rows))
                        if columns < 60 or rows < 24:
                            wait("Resize the terminal")
                        else:
                            wait("Live transcript end")
                            check("Resize the terminal" not in frame(), "resize clears the size shield", f"{columns}x{rows}")
                        capture(f"resize-cycle-{columns}x{rows}")
                    # First shrink can legitimately clamp scroll offsets. Subsequent
                    # identical cycles must settle to the same complete terminal cells.
                    if cycle == 0:
                        baseline = stable_frame()
                        capture("resize-baseline")
                    else:
                        current = stable_frame()
                        differences = [{"row": i + 1, "before": before, "after": after} for i, (before, after) in enumerate(zip(baseline.splitlines(), current.splitlines())) if before != after]
                        check(current == baseline, "repeated resize restores the settled full frame without stale cells", differences)

            with scenario("help", width, height):
                shortcuts()
                key("?", literal=True)
                wait("Keyboard shortcuts")
                top = capture("help-top")
                check("ESSENTIALS" in top and re.search(r"F4\s+discard", top), "help starts at essentials with current discard key")
                for _ in range(10):
                    key("NPage")
                    if re.search(r"Esc\s+closes without responding", " ".join(frame().split())):
                        break
                bottom = capture("help-bottom")
                check(re.search(r"Esc\s+closes without responding", " ".join(bottom.split())) and "ESSENTIALS" not in bottom, "Page Down reaches help bottom")
                key("PPage")
                check(frame() != bottom, "Page Up moves back through help")
                key("Escape")
                wait("Keyboard shortcuts", absent=True)
                check("Live transcript end" in frame(), "Escape closes help to dashboard")

            with scenario("commands", width, height):
                key("C-p")
                wait("Find a command")
                capture("commands")
                key("new session", literal=True)
                key("Enter")
                wait(LAUNCH)
                capture("commands-launch")
                check(True, "command search and Enter open New session")
                key("F4")
                wait(LAUNCH, absent=True)

            with scenario("picker", width, height):
                shortcuts()
                key("C-k")
                wait(FINDER)
                capture("picker")
                key("zz-no-synthetic-match", literal=True)
                wait("No matching loaded sessions")
                capture("picker-empty")
                key("Enter")
                check("No matching loaded sessions" in frame(), "Enter on empty picker keeps recoverable search")
                key("C-a", "C-k")
                key("server startup", literal=True)
                wait("Review server startup")
                capture("picker-recovered")
                key("Enter")
                wait("The startup checks are complete")
                check(True, "clearing empty picker and selecting result opens correct conversation")
                shortcuts()
                key("C-k")
                wait(FINDER)
                key("Escape")
                check("The startup checks are complete" in frame(), "session picker closes without changing selection")
                key("M-Left")
                wait("Live transcript end")
                key("M-Right")
                wait("The startup checks are complete")
                check(True, "dashboard Alt arrows hop sessions")

            with scenario("finder-browsing", width, height):
                start = len(result["requests"])
                shortcuts()
                key("C-k")
                top = wait(FINDER)
                query_row = next(i for i, line in enumerate(top.splitlines()) if FINDER in line)
                left = top.splitlines()[query_row].index(FINDER)
                right = top.splitlines()[query_row].index("│", left)
                # The switcher leads with the folder of the session on screen (ses_review in DIRECTORY), then sorts by folder.
                ordered = sorted(
                    (session for session in inventory if not session.get("parentID")),
                    key=lambda session: (session["location"]["directory"] != DIRECTORY, session["location"]["directory"]),
                )
                check("Finder child" not in top and "ses_review" in top and DIRECTORY in top, "picker keeps compact groups and exposes selected-session details under the list")
                for _ in range(len(ordered)):
                    if finder_position()[0] == 1:
                        break
                    key("PPage")
                check(finder_position() == (1, len(ordered)), "finder groups sessions by project with keyboard-selectable titles")
                key("NPage")
                position, count = finder_position()
                plain = capture("finder-page-down")
                check(position > 2 and count == len(ordered) and f"▶ {ordered[position - 1]['title']}" in plain and FINDER in plain.splitlines()[query_row], "Page Down moves highlight by a page while search stays fixed")
                key("PPage")
                check(finder_position()[0] == 1, "Page Up restores first finder result")
                key("C-Home", "Down", "Down")
                position, _ = finder_position()
                selected_row = next(i for i, line in enumerate(frame().splitlines()) if "▶ " + ordered[position - 1]["title"] in line)
                x = frame().splitlines()[selected_row].index("▶ ") + 3
                mouse(65, x, selected_row)
                plain = capture("finder-wheel-down")
                check(finder_position()[0] == position + 3 and f"▶ {ordered[position + 2]['title']}" in plain, "wheel down moves and reveals the selected finder row")
                mouse(64, x, selected_row)
                check(finder_position()[0] == position, "wheel up reverses finder movement")
                for _ in range(len(ordered)):
                    if finder_position()[0] == len(ordered):
                        break
                    key("NPage")
                plain = capture("finder-last-page")
                check(finder_position() == (len(ordered), len(ordered)) and "▶ " + ordered[-1]["title"] in plain and FINDER in plain.splitlines()[query_row], "paging reaches final project without scrolling search away")
                resized = (120, 36) if width == 60 else (60, 24)
                tmux("resize-window", "-t", "audit:0", "-x", str(resized[0]), "-y", str(resized[1]))
                wait(FINDER)
                plain = capture("finder-resized")
                check("Live transcript end" not in plain and "Read marker" not in plain, "resized modal masks underlying conversation text")
                check(finder_position() == (len(ordered), len(ordered)) and "▶ " + ordered[-1]["title"] in plain, "finder resize keeps highlighted result visible and preserves selection")
                tmux("resize-window", "-t", "audit:0", "-x", "59", "-y", "23")
                wait("Resize the terminal")
                key("Enter", "NPage")
                key("BLOCKED", literal=True)
                tmux("resize-window", "-t", "audit:0", "-x", str(width), "-y", str(height))
                wait(FINDER)
                check(finder_position() == (len(ordered), len(ordered)), "finder survives resize shield without typing, selection, or opening")
                key("Tab")
                key("Finder ", literal=True)
                key("BTab")
                key("session 29", literal=True)
                wait("1/1")
                plain = capture("finder-typing-after-browsing")
                # The dialog is as tall as its results and centred, so the search row moves with the result count: it is the text row above the scope tabs.
                lines = plain.splitlines()
                search = next(line for line in reversed(lines[:next(i for i, line in enumerate(lines) if "[Recent]" in line)]) if line.strip(" │╭╮╰╯─"))
                check("Finder session 29" in search and "▶ Finder session 29" in plain, "Tab and Shift+Tab retain search focus after paging, wheel, and resize")
                check(not writes_since(start) and not any(re.match(r"/api/session/ses_finder_\d+/", r["path"]) for r in result["requests"][start:]), "finder browsing neither mutates nor loads another conversation")
                row = next(i for i, line in enumerate(plain.splitlines()) if "▶ Finder session 29" in line)
                mouse(0, plain.splitlines()[row].index("Finder session 29"), row)
                wait("Fixture session: ses_finder_29")
                check(True, "clicking finder title opens its exact synthetic session")
                shortcuts()
                key("C-k")
                wait(FINDER)
                key("Finder session", literal=True)
                wait("/24")
                key("NPage")
                plain = capture("finder-unselected-target")
                row, match = next((i, match) for i, line in enumerate(plain.splitlines()) if "▶ " not in line and (match := re.search(r"  (Finder session (\d+))", line)))
                target = f"ses_finder_{match[2]}"
                mouse(0, match.start(1), row)
                wait(f"Fixture session: {target}")
                capture("finder-unselected-opened")
                check(True, "clicking unselected title opens clicked identity, not highlighted identity", target)

            with scenario("models", width, height):
                start = len(result["requests"])
                shortcuts()
                key("m")
                wait("Find a model or provider")
                key("Down", "Up")
                wait("Local Audit Model")
                capture("models")
                key("F2")
                wait("Find a provider")
                capture("provider")
                check("Server-global" in frame() and url in frame(), "F2 setup identifies synthetic origin and global scope")
                key("fixture", literal=True)
                key("Enter")
                wait("Use fixture API key")
                key("Enter")
                wait("API key (hidden)")
                key("synthetic-not-a-secret", literal=True)
                capture("provider-key-unsaved")
                check("synthetic-not-a-secret" not in frame(), "unsaved synthetic provider key is masked")
                key("C-u", "Escape")
                wait("Connect Fixture Provider")
                key("Escape")
                wait("Find a provider")
                key("Escape")
                wait("Choose model")
                key("Escape")
                check(all(r["method"] == "GET" for r in result["requests"][start:]), "models and provider browsing/cancel send no writes")

            with scenario("launch", width, height):
                shortcuts()
                key("n")
                wait(LAUNCH)
                capture("launch")
                draft = edited_draft("launch")
                key("Escape")
                choose_session("server startup", "The startup checks are complete")
                shortcuts()
                key("n")
                wait(LAUNCH)
                check(draft in frame(), "launch draft survives Escape, dashboard picker, and resume")
                key("C-l")
                wait("Find a model or provider")
                key("review", literal=True)
                wait("Review Audit Model")
                key("Enter")
                wait(LAUNCH)
                check(draft in frame(), "local model selection preserves launch task")
                capture("launch-model-selected")
                key("Tab")
                wait("Directory on the server")
                capture("launch-settings")
                key("BTab")
                start = len(result["requests"])
                key("Enter")
                wait("Task sent.")
                capture("launch-sent")
                writes = [r for r in result["requests"][start:] if r["method"] != "GET"]
                check(len(writes) == 2 and writes[0]["path"] == "/api/session" and writes[0]["body"]["location"]["directory"] == DIRECTORY and writes[0]["body"].get("model") == {"providerID": "fixture", "id": "review"} and writes[1]["body"]["prompt"]["text"] == draft and writes[1]["path"] == f"/api/session/{writes[0]['body']['id']}/prompt", "Enter creates one synthetic launch with original directory, selected model, and exact edited prompt", writes)
                shortcuts()
                key("n")
                wait(LAUNCH)
                key("discard launch marker", literal=True)
                key("F4")
                wait(LAUNCH, absent=True)
                shortcuts()
                key("n")
                wait(LAUNCH)
                check("discard launch marker" not in frame(), "F4 clears local launch draft")
                key("F4")

            with scenario("reply", width, height):
                compose()
                key("Keep this reply draft.", literal=True)
                plain = capture("reply")
                check("Live transcript end" in plain and "Reply to" in plain and "Keep this reply draft." in plain, "docked reply keeps conversation, recipient, and draft visible")
                if width < 90:
                    key("Escape", "b", "f")
                    capture("reply-sidebar-requested")
                    check("Live transcript end" in frame() and "Keep this reply draft." in frame(), "reply from shown narrow sidebar keeps conversation and draft visible")
                    key("Escape", "b", "f")
                tmux("resize-window", "-t", "audit:0", "-x", "59", "-y", "23")
                wait("Resize the terminal")
                capture("resize-shield-59x23")
                start = len(result["requests"])
                key("BLOCKED", literal=True)
                key("C-d", "C-k", "F4", "F2", "M-Right", "C-s", "Enter")
                for _, enter in ENTER_KEYS[1:]:
                    key(enter, literal=True)
                tmux("resize-window", "-t", "audit:0", "-x", str(width), "-y", str(height))
                wait_typing()
                capture("reply-restored")
                check("Keep this reply draft." in frame() and "BLOCKED" not in frame() and all(r["method"] == "GET" for r in result["requests"][start:]), "59x23 shield blocks edits, discard, navigation, and sends; resize restores draft")
                key("C-a", "C-k")
                draft = edited_draft("reply")
                key("Escape", "M-Right")
                wait("The startup checks are complete")
                key("M-Left")
                wait("Live transcript end")
                compose()
                check(draft in frame(), "reply survives Escape then dashboard Alt hopping and resume")
                key("PPage")
                scrolled = capture("reply-reading")
                check("Read marker" in scrolled and "Live transcript end" not in scrolled and draft in scrolled, "Page Up reads earlier conversation while preserving editor")
                key("NPage")
                check("Live transcript end" in frame() and draft in frame(), "Page Down restores live end without moving editor focus")
                key("C-t")
                check("Queue" in frame(), "Ctrl+T makes reply delivery mode visible")
                start = len(result["requests"])
                key("Enter")
                wait("Reply queued. The agent reads it when it is idle.")
                capture("reply-sent")
                writes = [r for r in result["requests"][start:] if r["method"] != "GET"]
                check(len(writes) == 1 and writes[0]["path"] == "/api/session/ses_review/prompt" and writes[0]["body"]["prompt"]["text"] == draft and writes[0]["body"].get("delivery") == "queue", "Enter sends exact edited reply once to original fixture recipient", writes)
                compose()
                key("discard reply marker", literal=True)
                key("F4")
                # The editor reopens empty once the draft is gone.
                time.sleep(0.5)
                compose()
                check("discard reply marker" not in frame(), "F4 clears local reply draft")
                key("F4")

            for kind, notice in (("launch", "Task sent."), ("reply", "Reply sent.")):
                with scenario(f"{kind}-composition", width, height):
                    open_kind(kind)
                    for name, enter in ENTER_KEYS:
                        start = len(result["requests"])
                        key(enter, literal=True)
                        check(not writes_since(start) and is_open(kind), f"blank {kind}: {name} does not mutate or close editor")
                    key(" ", literal=True)
                    key("\x1b\r", literal=True)
                    key("Enter")
                    check(not writes_since(start) and is_open(kind), f"whitespace-only {kind}: Enter does not mutate")
                    key("F4")
                    time.sleep(0.5)
                    open_kind(kind)
                    key("first", literal=True)
                    start = len(result["requests"])
                    for modifier in (6, 7, 13, 21):
                        key(f"\x1b[115;{modifier}u\x1b[13;{modifier}u", literal=True)
                    key("\x1b[13;9u\x1b[13;17u\x1b[13;1:3u", literal=True)
                    check(not writes_since(start) and is_open(kind) and "first" in frame(), f"{kind}: extra-modified send keys and Enter release do not submit")
                    if kind == "launch":
                        for field in ("directory", "agent", "model"):
                            key("Tab")
                            for _, enter in ENTER_KEYS:
                                key(enter, literal=True)
                            check(not writes_since(start) and "New session" in frame(), f"launch {field}: Enter aliases do not submit task outside textarea")
                        key("BTab", "BTab", "BTab")
                    key("\x1b\r", literal=True)
                    key("second", literal=True)
                    lines = frame().splitlines()
                    check(not writes_since(start) and any("first" in a and "second" in b for a, b in zip(lines, lines[1:])), f"{kind}: Alt+Enter adds a line without submitting")
                    key("\x1b[13;2u", literal=True)
                    key("\x1b[200~pasted third\npasted fourth\n\x1b[201~", literal=True)
                    plain = capture(f"{kind}-multiline-paste")
                    lines = plain.splitlines()
                    check(not writes_since(start) and any("second" in a and "pasted third" in b for a, b in zip(lines, lines[1:])), f"{kind}: CSI-u Shift+Enter inserts a newline before pasted text")
                    check(not writes_since(start) and any("pasted third" in a and "pasted fourth" in b for a, b in zip(lines, lines[1:])), f"{kind}: bracketed multiline paste including trailing LF never auto-submits")
                    key("Home", "Right", "Right", "Escape")
                    choose_session("server startup", "The startup checks are complete")
                    if kind == "reply":
                        shortcuts()
                        key("M-Left")
                        wait("Live transcript end")
                    open_kind(kind)
                    key("CURSOR", literal=True)
                    check("fiCURSORrst" in frame(), f"{kind}: reopened draft restores interior cursor, not just text")
                    expected = "fiCURSORrst\nsecond\npasted third\npasted fourth\n"
                    if kind == "launch":
                        key("C-l")
                        wait("Find a model or provider")
                        key("Escape")
                        wait(LAUNCH)
                        key("MODEL", literal=True)
                        expected = expected.replace("CURSOR", "CURSORMODEL")
                        check("fiCURSORMODELrst" in frame(), "launch model-picker return restores draft cursor")
                    capture(f"{kind}-cursor-restored")
                    start = len(result["requests"])
                    key("Enter")
                    wait(notice)
                    writes = writes_since(start)
                    target = f"/api/session/{writes[0]['body']['id']}/prompt" if kind == "launch" and writes else "/api/session/ses_review/prompt"
                    check(len(writes) == (2 if kind == "launch" else 1) and writes[-1]["path"] == target and writes[-1]["body"]["prompt"]["text"] == expected, f"{kind}: Return sends exact restored multiline draft once", writes)
                for name, enter in ENTER_KEYS[1:] + [("Ctrl+S", "\x13")]:
                    with scenario(f"{kind}-send-{name.replace(' ', '-').replace('+', '-')}", width, height):
                        open_kind(kind)
                        text = f"{kind} via {name}"
                        key(text, literal=True)
                        start = len(result["requests"])
                        key(enter, literal=True)
                        wait(notice)
                        writes = writes_since(start)
                        target = f"/api/session/{writes[0]['body']['id']}/prompt" if kind == "launch" and writes else "/api/session/ses_review/prompt"
                        check(len(writes) == (2 if kind == "launch" else 1) and writes[-1]["path"] == target and writes[-1]["body"]["prompt"]["text"] == text, f"{kind}: {name} sends one exact prompt", writes)

            with scenario("question-picker", width, height):
                start = len(result["requests"])
                wait("Question 1 of 2")
                check(not writes_since(start), "pending question opens automatically without answering")
                plain = capture("question-options")
                check("Live transcript end" in plain and "QUESTION PENDING" not in plain, "question is framed beside the transcript without a duplicate preview")
                key("C-s")
                check(not writes_since(start), "unanswered question cannot bypass review with Ctrl+S")
                key("Down", "Enter")
                wait("Question 2 of 2")
                key("Space", "Down", "Down", "Enter")
                wait("Your answer")
                key("Alpha, beta", literal=True)
                shortcuts()
                key("C-k")
                wait(FINDER)
                key("Escape")
                wait("Your answer")
                check("Alpha, beta" in frame(), "Ctrl+K cancellation restores custom question text")
                key("Enter")
                wait("Question 2 of 2")
                key("Left")
                wait("Question 1 of 2")
                check("(•) New design" in frame(), "back navigation preserves the first answer")
                key("Right", "Right")
                wait("Review answers")
                plain = capture("question-review")
                check("New design" in plain and "Alpha, beta" in plain and not writes_since(start), "review shows selections and preserves custom commas without sending")
                choose_session("server startup", "The startup checks are complete")
                choose_session("terminal workbench", "Review answers")
                check("Alpha, beta" in frame() and not writes_since(start), "returning to a session restores its question review")
                key("C-s")
                wait("Answers sent.")
                writes = writes_since(start)
                check(len(writes) == 1 and writes[0]["path"] == "/api/session/ses_review/question/que_picker/reply" and writes[0]["body"] == {"answers": [["New design"], ["Source", "Alpha, beta"]]}, "confirmed question sends captured labels exactly once", writes)

            with scenario("request-enter-guards", width, height):
                wait("Needs input")
                for shortcut, title, control in (("p", "Permission request", "Reject"), ("o", "Answer agent", "Question 1 of 1")):
                    shortcuts()
                    key(shortcut)
                    wait(control)
                    key("Tab")
                    start = len(result["requests"])
                    for name, enter in ENTER_KEYS:
                        key(enter, literal=True)
                        check(not writes_since(start) and "Esc close" in frame(), f"{title}: {name} does not confirm or mutate requests")
                        if shortcut == "o":
                            wait("Review answers")
                            key("Left")
                    if shortcut == "p":
                        key("Down", "Enter")
                        check(not writes_since(start) and "Esc close" in frame(), "permission Allow once plus Enter still requires explicit confirmation")
                    if shortcut == "o":
                        key("C-r", "Enter")
                        check(not writes_since(start) and "Ctrl+S Confirm rejection" in frame(), "question rejection plus Enter still requires explicit confirmation")
                    capture(f"{shortcut}-enter-not-confirmed")
                    key("Escape")
                    if shortcut == "o":
                        # Esc backs out of the rejection confirmation to the question; a second Esc closes the panel.
                        key("Escape")
    except BaseException as error:
        result["fatal"] = "".join(traceback.format_exception(error))
    finally:
        # Never issue a tmux operation without this invocation's explicit socket.
        tmux("kill-server", check=False)
        server.shutdown()
        server.server_close()
        for sig, handler in old_signals.items():
            signal.signal(sig, handler)
        result["source_sha256_end"] = hashes()
        result["source_changed_during_run"] = result["source_sha256_start"] != result["source_sha256_end"]
        result["checks"].append({"scenario": "coverage", "check": "source remained unchanged during capture", "passed": not result["source_changed_during_run"]})
        result["checks"].append({"scenario": "safety", "check": "no authentication header or provider/config writes", "passed": all(allowed_request(request) for request in result["requests"]) and not result.get("unexpected_routes")})
        for width, height in sizes:
            if args.exit_only or args.lifecycle_only:
                continue
            for name in ("dashboard", "undo-confirmation", "undo-staged", "undo-restored-draft", "redo-restored", "live-in-progress", "live-completed", "roster-live-update", "prompt-recall", "agent-selected", "session-compacted", "slash-suggestions", "slash-command-sent", "copy-selection", "mouse-restored", "owned-child-reply", "particle-orb-0", "transcript-earlier", "help-top", "help-bottom", "launch", "reply", "finder-page-down", "finder-last-page", "finder-unselected-opened", "launch-multiline-paste", "reply-multiline-paste", "o-enter-not-confirmed", f"resize-cycle-{width}x{height}"):
                result["checks"].append({"scenario": "coverage", "size": f"{width}x{height}", "check": f"required {name} PNG captured", "passed": any(c["name"] == name and c["actual_size"] == [width, height] for c in result["captures"])})
        failed = [c for c in result["checks"] if not c["passed"]]
        result["passed"] = not failed and "fatal" not in result
        result["finished"] = datetime.now(timezone.utc).isoformat()
        result["counts"] = {"checks": len(result["checks"]), "failed": len(failed), "pngs": len(result["captures"])}
        summary = [
            "# TUI PTY Audit", "", f"Result: {'PASS' if result['passed'] else 'FAIL'}; {len(failed)} failed / {len(result['checks'])} checks; {len(result['captures'])} PNGs.",
            f"Entrypoint: `{result['entrypoint']}` in `{repo}`.",
            f"Scope: {'exit restoration only' if args.exit_only else 'text lifecycle and exit restoration' if args.lifecycle_only else 'full visual harness'}.",
            f"Bun on PATH **{result['versions']['bun_installed']}**; manifest **{root_manifest['packageManager']}**. " + ("Matches the pinned runtime." if root_manifest["packageManager"] == f"bun@{result['versions']['bun_installed']}" else "This is not pinned-runtime verification."),
            f"Sizes: {', '.join(f'{w}x{h}' for w, h in sizes)}; resize shield: 59x23.",
            f"Fixture only: `{url}`; no live service, credential discovery, or provider writes.",
            f"Source changed during run: {result['source_changed_during_run']}. Rerun after concurrent edits finish.",
            "PNGs are Pillow reconstructions of real tmux PTY cells. No image vision or visual approval is claimed.",
            f"Evidence: `{run / 'evidence.json'}`.", "", "## Failed Checks", "",
        ]
        summary += [f"- {c.get('size', '')} {c['scenario']}: {c['check']}. {c.get('details') or ''} PNG: `{c.get('png') or 'not captured'}`" for c in failed] or ["None."]
        if "fatal" in result:
            summary += ["", "## Runner Error", "", "```text", result["fatal"], "```"]
        summary += ["", "## Captures", ""] + [f"- {c['requested_size']} {c['name']}: `{c['png']}`" for c in result["captures"]]
        for destination in (run, output):
            (destination / "evidence.json").write_text(json.dumps(result, indent=2) + "\n")
            (destination / "summary.md").write_text("\n".join(summary) + "\n")
        print(json.dumps({"passed": result["passed"], **result["counts"], "evidence": str(run / "evidence.json"), "summary": str(run / "summary.md")}), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
