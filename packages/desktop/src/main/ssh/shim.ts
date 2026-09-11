/**
 * The remote lifecycle shim, piped to `~/.forge/bin/forge-remote` on the
 * target host. It owns the daemonized `forge serve`: pidfile + port + auth
 * under `~/.forge/run/` (mode 0600/0700), `ensure` is idempotent so
 * reconnects reattach to the running server instead of spawning a second.
 *
 * Keep this POSIX sh - remote hosts may not have bash.
 */
export const FORGE_REMOTE_SHIM_PATH = "$HOME/.forge/bin/forge-remote"

export const FORGE_REMOTE_SHIM = `#!/bin/sh
set -u
FORGE_BIN="$HOME/.forge/bin/forge"
RUN_DIR="$HOME/.forge/run"
PIDFILE="$RUN_DIR/server.pid"
AUTHFILE="$RUN_DIR/server.auth"
PORTFILE="$RUN_DIR/server.port"
LOGFILE="$RUN_DIR/server.log"

alive() {
  [ -f "$PIDFILE" ] || return 1
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

read_state() {
  port=$(cat "$PORTFILE" 2>/dev/null || true)
  pass=$(cat "$AUTHFILE" 2>/dev/null || true)
  [ -n "$port" ] && [ -n "$pass" ]
}

print_state() {
  printf 'FORGE_REMOTE {"port":%s,"username":"forge","password":"%s"}\\n' "$port" "$pass"
}

case "\${1:-ensure}" in
  status)
    if alive && read_state; then print_state; exit 0; fi
    exit 1
    ;;
  ensure)
    if alive && read_state; then print_state; exit 0; fi
    if [ ! -x "$FORGE_BIN" ]; then
      echo "FORGE_REMOTE_ERROR forge is not installed" >&2
      exit 3
    fi
    mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR"
    pass=$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \\n')
    [ -n "$pass" ] || pass="$(date +%s)-$$-$(hostname 2>/dev/null || echo forge)"
    cors_args=""
    for origin in \${FORGE_REMOTE_CORS:-}; do cors_args="$cors_args --cors $origin"; done
    : > "$LOGFILE"
    env \\
      FORGE_SERVER_USERNAME=forge \\
      FORGE_SERVER_PASSWORD="$pass" \\
      FORGE_CLIENT=desktop \\
      FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER=true \\
      XDG_STATE_HOME="$HOME/.local/state" \\
      \${FORGE_SECRET_VAULT_KEY_ID:+FORGE_SECRET_VAULT_KEY_ID="$FORGE_SECRET_VAULT_KEY_ID"} \\
      \${FORGE_SECRET_VAULT_KEY:+FORGE_SECRET_VAULT_KEY="$FORGE_SECRET_VAULT_KEY"} \\
      nohup "$FORGE_BIN" --print-logs --log-level \${FORGE_REMOTE_LOG_LEVEL:-WARN} serve --hostname 127.0.0.1 --port 0 $cors_args >>"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    chmod 600 "$PIDFILE"
    i=0
    port=""
    while [ "$i" -lt 300 ]; do
      port=$(sed -n 's|.*listening on http://[^:/ ]*:\\([0-9][0-9]*\\).*|\\1|p' "$LOGFILE" | tail -n 1)
      [ -n "$port" ] && break
      alive || break
      sleep 0.2 2>/dev/null || sleep 1
      i=$((i + 1))
    done
    if [ -z "$port" ]; then
      echo "FORGE_REMOTE_ERROR forge server failed to start" >&2
      tail -n 20 "$LOGFILE" >&2 2>/dev/null || true
      rm -f "$PIDFILE"
      exit 1
    fi
    printf '%s' "$pass" > "$AUTHFILE" && chmod 600 "$AUTHFILE"
    printf '%s' "$port" > "$PORTFILE" && chmod 600 "$PORTFILE"
    print_state
    ;;
  install)
    ver="\${2:-}"
    [ -n "$ver" ] || { echo "FORGE_REMOTE_ERROR install requires a version" >&2; exit 2; }
    command -v curl >/dev/null 2>&1 || { echo "FORGE_REMOTE_ERROR curl is required to install forge" >&2; exit 1; }
    os=$(uname -s 2>/dev/null || true)
    case "$os" in
      Linux) os=linux ;;
      Darwin) os=darwin ;;
      *) echo "FORGE_REMOTE_ERROR unsupported remote OS: $os" >&2; exit 1 ;;
    esac
    arch=$(uname -m 2>/dev/null || true)
    case "$arch" in
      aarch64|arm64) arch=arm64 ;;
      x86_64|amd64) arch=x64 ;;
      *) echo "FORGE_REMOTE_ERROR unsupported remote arch: $arch" >&2; exit 1 ;;
    esac
    if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
      [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] && arch=arm64
    fi
    target="$os-$arch"
    if [ "$arch" = x64 ]; then
      if [ "$os" = linux ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then target="$target-baseline"; fi
      if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)" != "1" ]; then target="$target-baseline"; fi
    fi
    if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; }; then
      target="$target-musl"
    fi
    ext=tar.gz
    [ "$os" = darwin ] && ext=zip
    file="forge-$target.$ext"
    base="https://github.com/turenlabs/turenos/releases/download/v$ver"
    tmp=$(mktemp -d) || exit 1
    if ! curl -fsSL "$base/$file" -o "$tmp/$file"; then
      echo "FORGE_REMOTE_ERROR release v$ver does not provide $file" >&2; rm -rf "$tmp"; exit 1
    fi
    if ! curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"; then
      echo "FORGE_REMOTE_ERROR could not download release checksums" >&2; rm -rf "$tmp"; exit 1
    fi
    expected=$(awk -v n="$file" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")
    [ -n "$expected" ] || { echo "FORGE_REMOTE_ERROR checksums missing $file" >&2; rm -rf "$tmp"; exit 1; }
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/$file" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$tmp/$file" | awk '{print $1}')
    else echo "FORGE_REMOTE_ERROR sha256sum or shasum is required" >&2; rm -rf "$tmp"; exit 1; fi
    [ "$actual" = "$expected" ] || { echo "FORGE_REMOTE_ERROR checksum mismatch for $file" >&2; rm -rf "$tmp"; exit 1; }
    if [ "$ext" = tar.gz ]; then tar -xzf "$tmp/$file" -C "$tmp"; else unzip -q -o "$tmp/$file" -d "$tmp"; fi
    bin="$tmp/forge"
    [ -f "$bin" ] || bin=$(find "$tmp" -type f -name forge | head -n 1)
    if [ -z "$bin" ] || [ ! -f "$bin" ] || [ -L "$bin" ]; then
      echo "FORGE_REMOTE_ERROR release archive did not contain a forge binary" >&2; rm -rf "$tmp"; exit 1
    fi
    chmod 755 "$bin"
    got=$("$bin" --version 2>/dev/null || true)
    [ "$got" = "$ver" ] || { echo "FORGE_REMOTE_ERROR downloaded forge reports \${got:-no version}; expected $ver" >&2; rm -rf "$tmp"; exit 1; }
    mkdir -p "$HOME/.forge/bin"
    staged=$(mktemp "$HOME/.forge/bin/.forge.new.XXXXXX") || { rm -rf "$tmp"; exit 1; }
    cp "$bin" "$staged" && chmod 755 "$staged" && mv -f "$staged" "$FORGE_BIN"
    rm -rf "$tmp"
    echo "FORGE_REMOTE installed $ver"
    exit 0
    ;;
  stop)
    if alive; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; fi
    rm -f "$PIDFILE" "$PORTFILE"
    exit 0
    ;;
  *)
    echo "FORGE_REMOTE_ERROR unknown command: $1" >&2
    exit 2
    ;;
esac
`

export type ForgeRemoteState = {
  port: number
  username: string
  password: string
}

/** Extracts the `FORGE_REMOTE {...}` state line from shim output. */
export function parseRemoteState(output: string): ForgeRemoteState | null {
  const line = output
    .split(/\r?\n/g)
    .reverse()
    .find((line) => line.startsWith("FORGE_REMOTE "))
  if (!line) return null
  try {
    const parsed = JSON.parse(line.slice("FORGE_REMOTE ".length)) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (
      typeof record.port !== "number" ||
      typeof record.username !== "string" ||
      typeof record.password !== "string"
    ) {
      return null
    }
    return { port: record.port, username: record.username, password: record.password }
  } catch {
    /* fall through */
  }
  return null
}

export function remoteInstallMissing(output: string) {
  return output.includes("FORGE_REMOTE_ERROR forge is not installed")
}
