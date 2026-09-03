#!/usr/bin/env bun

import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { $ } from "bun"

const root = path.resolve(import.meta.dir, "..")
const desktop = path.join(root, "packages/desktop")
const app = "/Applications/TurenOS Beta.app"
const packagedApp = path.join(desktop, "dist/mac-arm64/TurenOS Beta.app")
const sourceCLI = path.join(root, "packages/forge/dist/forge-darwin-arm64/bin/forge")
const resourceCLI = path.join(desktop, "resources/forge-cli")
const cliDestinations = [
  path.join(process.env.HOME ?? "", ".local/bin/forge"),
  path.join(process.env.HOME ?? "", ".forge/bin/forge"),
]

if (Bun.argv.includes("--help")) {
  console.log("Rebuild, reinstall, and restart the Apple Silicon TurenOS Beta app.")
  console.log("Run from the repository with: bun ./script/beta-rebuild.ts")
  process.exit(0)
}

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error(`This workflow requires macOS arm64; found ${process.platform}/${process.arch}`)

const revision = (await $`git rev-parse HEAD`.cwd(root).text()).trim()
const dirtyState = await $`git status --porcelain=v1`.cwd(root).text()
const scriptHash = await sha256(path.join(root, "packages/script/src/index.ts"))
console.log(`Building beta from ${revision}`)
console.log(`Dirty entries: ${dirtyState.split("\n").filter(Boolean).length}`)
console.log(`Team metadata source hash: ${scriptHash}`)

await $`FORGE_CHANNEL=beta bun ./scripts/prepare.ts`.cwd(desktop)
await $`FORGE_CHANNEL=beta bunx electron-vite build`.cwd(desktop)
await $`FORGE_CHANNEL=beta bunx electron-builder --mac --publish never --config electron-builder.config.ts`.cwd(desktop)

if ((await $`git rev-parse HEAD`.cwd(root).text()).trim() !== revision)
  throw new Error("HEAD changed during the beta build")
if ((await sha256(path.join(root, "packages/script/src/index.ts"))) !== scriptHash)
  throw new Error("Team metadata source changed during the beta build")

const stageDirectory = path.join("/tmp", `forge-beta-install-${timestamp()}`)
const stagedApp = path.join(stageDirectory, "TurenOS Beta.app")
await $`mkdir -p ${stageDirectory}`
await $`ditto --rsrc --extattr --acl ${packagedApp} ${stagedApp}`

if (betaIsRunning()) {
  console.log(`Beta is still running; staged replacement at ${stagedApp}`)
  console.log(
    "Quit the running beta, move the staged bundle to /Applications/TurenOS Beta.app, and rerun verification.",
  )
  process.exit(0)
}

if (!existsSync(app)) throw new Error(`Installed beta bundle was not found at ${app}`)
await $`mv ${app} ${path.join(stageDirectory, "TurenOS Beta.app.old")}`
await $`mv ${stagedApp} ${app}`

for (const destination of cliDestinations) {
  await $`mkdir -p ${path.dirname(destination)}`
  await $`cp ${sourceCLI} ${destination}`
}

await $`codesign --verify --deep --strict ${app}`
const packagedAsarHash = await sha256(path.join(packagedApp, "Contents/Resources/app.asar"))
const installedAsarHash = await sha256(path.join(app, "Contents/Resources/app.asar"))
if (packagedAsarHash !== installedAsarHash) throw new Error("Installed app.asar does not match the packaged artifact")

const sourceCLIHash = await sha256(sourceCLI)
for (const destination of cliDestinations) {
  if ((await sha256(destination)) !== sourceCLIHash) throw new Error(`Standalone CLI is stale: ${destination}`)
}
if (
  (await unsignedSha256(resourceCLI, path.join(stageDirectory, "resource-cli-nosig"))) !==
  (await unsignedSha256(
    path.join(app, "Contents/Resources/forge-cli"),
    path.join(stageDirectory, "installed-cli-nosig"),
  ))
)
  throw new Error("Installed nested CLI content differs from the freshly packaged CLI")

const launchLog = path.join(stageDirectory, "beta-launch.log")
const probePassword = randomUUID()
const launchStdout = `${launchLog}.stdout`
const launchStderr = `${launchLog}.stderr`
const launched = Bun.spawn([path.join(app, "Contents/MacOS/TurenOS Beta")], {
  cwd: root,
  env: { ...process.env, FORGE_CHANNEL: "beta", FORGE_BETA_SERVER_PASSWORD: probePassword },
  stdin: "ignore",
  stdout: Bun.file(launchStdout),
  stderr: Bun.file(launchStderr),
  detached: true,
})
launched.unref()
console.log(`Started beta PID ${launched.pid}`)
const log = await waitForServerReady([launchStdout, launchStderr])
console.log(`Beta ready: ${log.path}`)
console.log(`Sidecar URL: ${log.url}`)

const response = await fetch(`${log.url}/session?roots=true`, {
  headers: {
    authorization: `Basic ${Buffer.from(`forge:${probePassword}`).toString("base64")}`,
    "x-forge-directory": root,
  },
  signal: AbortSignal.timeout(10_000),
})
const body = await response.text()
console.log(`Authenticated /session probe: status=${response.status} body=${body.slice(0, 500)}`)
if (!response.ok) throw new Error(`Authenticated sidecar probe failed with HTTP ${response.status}`)

console.log(`Installed beta app.asar: ${installedAsarHash}`)
console.log(`Standalone CLI: ${sourceCLIHash}`)

function betaIsRunning() {
  const executable = path.join(app, "Contents/MacOS/TurenOS Beta")
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return Bun.spawnSync(["pgrep", "-f", `^${escaped}( |$)`]).exitCode === 0
}

async function sha256(file: string) {
  return (await $`shasum -a 256 ${file}`.text()).trim().split(/\s+/)[0]
}

async function unsignedSha256(file: string, destination: string) {
  await $`cp ${file} ${destination}`
  await $`codesign --remove-signature ${destination}`
  return sha256(destination)
}

async function waitForServerReady(logPaths: ReadonlyArray<string>) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const text = (
      await Promise.all(logPaths.map((logPath) => (existsSync(logPath) ? Bun.file(logPath).text() : "")))
    ).join("\n")
    if (text) {
      const match = text.match(/server ready.*?http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) return { path: logPaths.join(", "), url: `http://127.0.0.1:${match[1]}` }
      if (/worker is unavailable|Unbound layer node: @forge\/v2\/SessionExecution/.test(text))
        throw new Error(`Beta startup log reports a runtime failure: ${logPaths.join(", ")}`)
    }
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for the beta server-ready log: ${logPath}`)
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)
}
