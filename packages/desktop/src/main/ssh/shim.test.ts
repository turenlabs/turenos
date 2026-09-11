import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FORGE_REMOTE_SHIM, parseRemoteState, remoteInstallMissing } from "./shim"

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

function run(homeDir: string, command: string, env: Record<string, string> = {}) {
  const script = join(homeDir, ".forge", "bin", "forge-remote")
  writeFileSync(script, FORGE_REMOTE_SHIM)
  chmodSync(script, 0o755)
  try {
    const stdout = execFileSync("sh", [script, ...command.split(" ")], {
      env: { HOME: homeDir, PATH: "/usr/bin:/bin", ...env },
      encoding: "utf8",
    })
    return { code: 0, stdout, stderr: "" }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

function installFakeForge(homeDir: string) {
  writeFileSync(
    join(homeDir, ".forge", "bin", "forge"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi',
      // `serve` mode: print the listening line the shim greps, then stay alive.
      'echo "forge server listening on http://127.0.0.1:4321"',
      "printf '%s\\n' \"$@\" > \"$HOME/.forge/run/invocation\"",
      "exec sleep 600",
    ].join("\n"),
  )
  chmodSync(join(homeDir, ".forge", "bin", "forge"), 0o755)
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

    // CORS origins reach the daemon's args (fake forge logs one arg per line)
    const args = readFileSync(join(dir, ".forge", "run", "invocation"), "utf8").trim().split("\n")
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
