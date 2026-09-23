import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FORGE_REMOTE_SHIM, parseRemoteState, remoteEnsureScript, remoteInstallMissing } from "./shim"

// These run the actual POSIX shim against a fake forge binary, so `ensure`'s
// pidfile/port/authfile contract and its idempotent reattach are exercised the
// way the remote host will run them.

const homes: string[] = []

function home() {
  const dir = join(tmpdir(), `forge-ssh-shim-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(dir, ".forge", "bin"), { recursive: true })
  homes.push(dir)
  return dir
}

afterEach(() => {
  while (homes.length) {
    const dir = homes.pop()!
    try {
      const pid = readFileSync(join(dir, ".forge", "run", "server.pid"), "utf8").trim()
      if (pid) process.kill(Number(pid))
    } catch {
      /* not running */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function exec(homeDir: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const script = join(homeDir, ".forge", "bin", "forge-remote")
  writeFileSync(script, FORGE_REMOTE_SHIM)
  chmodSync(script, 0o755)
  try {
    const stdout = execFileSync("sh", args, {
      input: opts.input,
      env: { HOME: homeDir, PATH: "/usr/bin:/bin", ...opts.env },
      encoding: "utf8",
    })
    return { code: 0, stdout, stderr: "" }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

function run(homeDir: string, command: string, env: Record<string, string> = {}) {
  return exec(homeDir, [join(homeDir, ".forge", "bin", "forge-remote"), ...command.split(" ")], { env })
}

/** Runs `remoteEnsureScript` the way ssh does: piped to `sh -s` on stdin. */
function runEnsureScript(homeDir: string, script: string) {
  return exec(homeDir, ["-s"], { input: script })
}

function installFakeForge(homeDir: string) {
  writeFileSync(
    join(homeDir, ".forge", "bin", "forge"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi',
      // `serve` mode: print the listening line the shim greps, then stay alive.
      'echo "forge server listening on http://127.0.0.1:4321"',
      'printf \'%s\\n\' "$@" > "$HOME/.forge/run/invocation"',
      "exec sleep 600",
    ].join("\n"),
  )
  chmodSync(join(homeDir, ".forge", "bin", "forge"), 0o755)
}

/** Fake forge that records the environment it was started with. */
function installEnvRecordingForge(homeDir: string) {
  writeFileSync(
    join(homeDir, ".forge", "bin", "forge"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi',
      'echo "forge server listening on http://127.0.0.1:4321"',
      'printf \'%s\\n\' "$FORGE_SECRET_VAULT_KEY_ID" "$FORGE_SECRET_VAULT_KEY" "$FORGE_REMOTE_CORS" "$*" \\',
      '  > "$HOME/.forge/run/recorded"',
      "exec sleep 600",
    ].join("\n"),
  )
  chmodSync(join(homeDir, ".forge", "bin", "forge"), 0o755)
}

function recorded(homeDir: string) {
  return readFileSync(join(homeDir, ".forge", "run", "recorded"), "utf8").split("\n")
}

describe("forge-remote shim", () => {
  test("status reports nothing before a server exists", () => {
    const dir = home()
    expect(run(dir, "status").code).toBe(1)
  })

  test("stop is a no-op when nothing is running", () => {
    const dir = home()
    expect(run(dir, "stop").code).toBe(0)
  })

  test("ensure fails with the missing-forge sentinel when no binary exists", () => {
    const dir = home()
    const result = run(dir, "ensure")
    expect(result.code).toBe(3)
    expect(remoteInstallMissing(result.stderr)).toBe(true)
  })

  test("ensure daemonizes, reports state, and reattaches idempotently", () => {
    const dir = home()
    installFakeForge(dir)

    const first = run(dir, "ensure", { FORGE_REMOTE_CORS: "http://localhost:5173 https://app.example" })
    expect(first.code).toBe(0)
    const state = parseRemoteState(first.stdout)
    expect(state).not.toBeNull()
    expect(state!.port).toBe(4321)
    expect(state!.username).toBe("forge")
    expect(state!.password.length).toBeGreaterThanOrEqual(16)

    // pidfile points at a live process
    const pid = readFileSync(join(dir, ".forge", "run", "server.pid"), "utf8").trim()
    expect(() => process.kill(Number(pid), 0)).not.toThrow()

    // state files are not world-readable
    expect(statSync(join(dir, ".forge", "run", "server.auth")).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, ".forge", "run", "server.log")).mode & 0o777).toBe(0o600)

    // CORS origins reach the daemon's args (fake forge logs one arg per line)
    const args = readFileSync(join(dir, ".forge", "run", "invocation"), "utf8")
      .trim()
      .split("\n")
    const corsAt = args.indexOf("--cors")
    expect(args.slice(corsAt)).toEqual(["--cors", "http://localhost:5173", "--cors", "https://app.example"])
    expect(args.slice(0, corsAt)).toEqual([
      "--print-logs",
      "--log-level",
      "WARN",
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ])

    // Second ensure reattaches the same daemon: identical credentials, same pid.
    const second = run(dir, "ensure")
    expect(parseRemoteState(second.stdout)).toEqual(state)
    expect(readFileSync(join(dir, ".forge", "run", "server.pid"), "utf8").trim()).toBe(pid)

    // status reports the running server
    const status = run(dir, "status")
    expect(status.code).toBe(0)
    expect(parseRemoteState(status.stdout)).toEqual(state)

    // stop kills the daemon and clears state
    expect(run(dir, "stop").code).toBe(0)
    expect(run(dir, "status").code).toBe(1)
    expect(existsSync(join(dir, ".forge", "run", "server.pid"))).toBe(false)
  })

  for (const output of ["", "abcd", "z".repeat(32)]) {
    test(`ensure fails closed when random password output is ${JSON.stringify(output)}`, () => {
      const dir = home()
      installFakeForge(dir)
      const bin = join(dir, ".forge", "bin")
      writeFileSync(join(bin, "od"), `#!/bin/sh\nprintf '%s' '${output}'\n`)
      chmodSync(join(bin, "od"), 0o755)
      const result = run(dir, "ensure", { PATH: `${bin}:/usr/bin:/bin` })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("secure password generation failed")
      expect(existsSync(join(dir, ".forge", "run", "server.pid"))).toBe(false)
      expect(existsSync(join(dir, ".forge", "run", "server.auth"))).toBe(false)
    })
  }

  test("ensure respawns when the pidfile is stale", () => {
    const dir = home()
    installFakeForge(dir)
    mkdirSync(join(dir, ".forge", "run"), { recursive: true })
    writeFileSync(join(dir, ".forge", "run", "server.pid"), "999999")
    writeFileSync(join(dir, ".forge", "run", "server.port"), "4321")
    writeFileSync(join(dir, ".forge", "run", "server.auth"), "stale")

    const result = run(dir, "ensure")
    expect(result.code).toBe(0)
    const state = parseRemoteState(result.stdout)
    expect(state).not.toBeNull()
    // A fresh daemon means fresh credentials - the stale auth is not reused.
    expect(state!.password).not.toBe("stale")
  })

  test("install downloads, verifies, and installs the matching release asset", () => {
    const dir = home()
    const fixtures = releaseFixtures("1.2.3")

    const result = run(dir, "install 1.2.3", { PATH: `${fixtures}:/usr/bin:/bin` })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("FORGE_REMOTE installed 1.2.3")

    const bin = join(dir, ".forge", "bin", "forge")
    expect(existsSync(bin)).toBe(true)
    expect(statSync(bin).mode & 0o111).toBeGreaterThan(0)
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toBe("1.2.3")
  })

  test("install rejects an asset whose checksum does not match", () => {
    const dir = home()
    const fixtures = releaseFixtures("1.2.3", { corrupt: true })

    const result = run(dir, "install 1.2.3", { PATH: `${fixtures}:/usr/bin:/bin` })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("FORGE_REMOTE_ERROR checksum mismatch")
    expect(existsSync(join(dir, ".forge", "bin", "forge"))).toBe(false)
  })
})

/**
 * A fake `curl` plus release fixtures covering every asset the shim can
 * compute on this machine: tarballs for linux, zips for darwin (when `zip`
 * exists), and a SHA256SUMS for all of them. The shim picks whichever asset
 * matches this host's uname, so the test is platform-agnostic.
 */
function releaseFixtures(version: string, opts: { corrupt?: boolean } = {}) {
  const dir = join(tmpdir(), `forge-ssh-release-${Math.random().toString(36).slice(2)}`)
  const dist = join(dir, "dist")
  mkdirSync(dist, { recursive: true })
  homes.push(dir)

  const forgeScript = join(dir, "forge")
  writeFileSync(forgeScript, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; fi\n`)
  chmodSync(forgeScript, 0o755)

  const names: string[] = []
  const make = (name: string, zip: boolean) => {
    const out = join(dist, name)
    if (zip) {
      execFileSync("zip", ["-q", "-j", out, forgeScript])
      names.push(name)
      return
    }
    execFileSync("tar", ["-czf", out, "-C", dir, "./forge"])
    names.push(name)
  }

  make("forge-linux-arm64.tar.gz", false)
  make("forge-linux-arm64-musl.tar.gz", false)
  make("forge-linux-x64.tar.gz", false)
  make("forge-linux-x64-baseline.tar.gz", false)
  make("forge-linux-x64-musl.tar.gz", false)
  make("forge-linux-x64-baseline-musl.tar.gz", false)
  try {
    make("forge-darwin-arm64.zip", true)
    make("forge-darwin-x64.zip", true)
    make("forge-darwin-x64-baseline.zip", true)
  } catch {
    /* no zip on this host - linux assets still cover CI */
  }

  writeFileSync(
    join(dist, "SHA256SUMS"),
    names
      .map((name) => {
        const bytes = readFileSync(join(dist, name))
        const hash = opts.corrupt
          ? createHash("sha256").update("tampered").digest("hex")
          : createHash("sha256").update(bytes).digest("hex")
        return `${hash}  ${name}`
      })
      .join("\n") + "\n",
  )

  // Fake curl: `curl -fsSL <url> -o <out>` copies dist/<basename of url>.
  writeFileSync(
    join(dir, "curl"),
    [
      "#!/bin/sh",
      'out=""; url=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done',
      'src="$(dirname "$0")/dist/${url##*/}"',
      '[ -f "$src" ] || exit 22',
      'cp "$src" "$out"',
    ].join("\n"),
  )
  chmodSync(join(dir, "curl"), 0o755)
  return dir
}

describe("remoteEnsureScript", () => {
  // The vault key must never reach argv: it would be readable via `ps` on both
  // the desktop and the remote for the life of the call.
  const key = new Uint8Array(32).fill(7)

  test("delivers cors origins and the vault key over stdin", () => {
    const dir = home()
    installEnvRecordingForge(dir)

    const result = runEnsureScript(
      dir,
      remoteEnsureScript({
        corsOrigins: ["http://localhost:5173", "https://app.example"],
        keyID: "11111111-2222-3333-4444-555555555555",
        key,
      }),
    )

    expect(result.code).toBe(0)
    expect(parseRemoteState(result.stdout)?.port).toBe(4321)
    const fields = recorded(dir)
    expect(fields[0]).toBe("11111111-2222-3333-4444-555555555555")
    expect(fields[1]).toBe(Buffer.from(key).toString("base64"))
    expect(fields[2]).toBe("http://localhost:5173 https://app.example")
    expect(fields[3]).toContain("--cors http://localhost:5173 --cors https://app.example")
  })

  // connectSshRemote's auto-install branch keys off this exact exit status, so
  // it has to survive `exec` through the piped script.
  test("propagates the missing-forge sentinel and exit code through the pipe", () => {
    const dir = home()

    const result = runEnsureScript(dir, remoteEnsureScript({ corsOrigins: [], keyID: "id", key }))

    expect(result.code).toBe(3)
    expect(remoteInstallMissing(result.stderr)).toBe(true)
  })

  test("quotes values so a single quote cannot escape into the remote shell", () => {
    const dir = home()
    installEnvRecordingForge(dir)

    const hostile = "http://x'; touch \"$HOME/pwned\"; echo '"
    const result = runEnsureScript(dir, remoteEnsureScript({ corsOrigins: [hostile], keyID: "id'with'quotes", key }))

    expect(result.code).toBe(0)
    expect(existsSync(join(dir, "pwned"))).toBe(false)
    expect(recorded(dir)[0]).toBe("id'with'quotes")
    expect(recorded(dir)[2]).toBe(hostile)
  })
})
