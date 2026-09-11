import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import os from "node:os"

const roots: string[] = []
const install = path.resolve(import.meta.dir, "../../../../install")
const unixTest = process.platform === "win32" ? test.skip : test

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("public release installer integrity", () => {
  unixTest("installs an archive only after checksum and version verification", async () => {
    const result = await runInstaller("0.1.0")
    expect(result.code).toBe(0)
    expect(await Bun.file(path.join(result.root, "home", ".forge", "bin", "forge")).exists()).toBe(true)
  })

  unixTest("rejects a checksum mismatch", async () => {
    const result = await runInstaller("0.1.0", "0".repeat(64))
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("checksum verification failed")
  })

  unixTest("rejects a binary whose embedded version does not match the release", async () => {
    const result = await runInstaller("0.1.1")
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("expected 0.1.0")
    expect((await readdir(path.join(result.root, "tmp"))).filter((name) => name.startsWith("forge_install."))).toEqual(
      [],
    )
  })

  unixTest("rejects a symlink extracted as the release binary", async () => {
    const result = await runInstaller("0.1.0", undefined, { symlink: true })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("must contain one regular Forge binary")
    expect((await readdir(path.join(result.root, "tmp"))).filter((name) => name.startsWith("forge_install."))).toEqual(
      [],
    )
  })

  unixTest("allows the official Windows arm64 release target", async () => {
    const result = await runInstaller("0.1.0", undefined, { target: "windows-arm64" })
    expect(result.code).toBe(0)
    expect(await Bun.file(path.join(result.root, "home", ".forge", "bin", "forge.exe")).exists()).toBe(true)
  })
})

async function runInstaller(
  binaryVersion: string,
  checksum?: string,
  options?: { symlink?: boolean; target?: string },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-install-test-"))
  roots.push(root)
  const assets = path.join(root, "assets")
  const commands = path.join(root, "bin")
  const payload = path.join(root, "payload")
  const temp = path.join(root, "tmp")
  await Promise.all(
    [assets, commands, payload, temp, path.join(root, "home")].map((dir) => mkdir(dir, { recursive: true })),
  )

  const filename = await archiveName(options?.target)
  const binary = options?.target?.startsWith("windows-") ? "forge.exe" : "forge"
  if (options?.symlink) {
    await Bun.write(path.join(payload, "real-forge"), `#!/usr/bin/env sh\nprintf '%s\\n' '${binaryVersion}'\n`)
    await symlink("real-forge", path.join(payload, binary))
  } else {
    await Bun.write(path.join(payload, binary), `#!/usr/bin/env sh\nprintf '%s\\n' '${binaryVersion}'\n`)
    await chmod(path.join(payload, binary), 0o755)
  }
  const archive = path.join(assets, filename)
  const packed = filename.endsWith(".tar.gz")
    ? Bun.spawn(["tar", "-czf", archive, binary], { cwd: payload })
    : Bun.spawn(["zip", "-q", ...(options?.symlink ? ["-y"] : []), archive, binary], { cwd: payload })
  expect(await packed.exited).toBe(0)

  const hash = createHash("sha256")
    .update(new Uint8Array(await Bun.file(archive).arrayBuffer()))
    .digest("hex")
  await Bun.write(path.join(assets, "SHA256SUMS"), `${checksum ?? hash}  ${filename}\n`)
  await Bun.write(
    path.join(commands, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */releases/latest)
    # resolving the latest tag reads the redirect target
    printf '%s' "https://github.com/turenlabs/turenos/releases/tag/v0.1.0"
    exit 0
    ;;
  */releases/download/*)
    asset="\${url##*/}"
    if [ ! -f "$ASSET_DIR/$asset" ]; then exit 22; fi
    if [ -n "$output" ] && [ "$output" != "/dev/null" ]; then cp "$ASSET_DIR/$asset" "$output"; fi
    exit 0
    ;;
esac
exit 22
`,
  )
  await chmod(path.join(commands, "curl"), 0o755)
  if (options?.target === "windows-arm64") {
    await Bun.write(
      path.join(commands, "uname"),
      '#!/usr/bin/env sh\nif [ "$1" = "-s" ]; then echo MINGW_NT-10.0; else echo aarch64; fi\n',
    )
    await chmod(path.join(commands, "uname"), 0o755)
  }

  const processResult = Bun.spawn(["bash", install, "--version", "0.1.0", "--no-modify-path"], {
    env: {
      ...process.env,
      ASSET_DIR: assets,
      HOME: path.join(root, "home"),
      PATH: `${commands}:${process.env.PATH}`,
      TMPDIR: temp,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ])
  return { code, output: stdout + stderr, root }
}

async function archiveName(override?: string) {
  if (override) return `forge-${override}.zip`
  const target = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`
  if (process.platform === "darwin") return `forge-${target}.zip`

  const cpuinfo = await Bun.file("/proc/cpuinfo")
    .text()
    .catch(() => "")
  const baseline = process.arch === "x64" && !/\bavx2\b/i.test(cpuinfo) ? "-baseline" : ""
  const musl = (await Bun.file("/etc/alpine-release").exists()) ? "-musl" : ""
  return `forge-${target}${baseline}${musl}.tar.gz`
}
