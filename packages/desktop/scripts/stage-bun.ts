#!/usr/bin/env bun
import { $ } from "bun"
import { mkdtemp, rm, cp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getCurrentSidecar } from "./utils"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const version = (await Bun.file(path.join(desktopDir, "../../package.json")).json()).packageManager.split("@")[1]
const target = getCurrentSidecar().rustTarget
const [platform, arch] =
  target === "aarch64-apple-darwin"
    ? ["darwin", "aarch64"]
    : target === "x86_64-apple-darwin"
      ? ["darwin", "x64"]
      : target === "aarch64-pc-windows-msvc"
        ? ["windows", "aarch64"]
        : target === "x86_64-pc-windows-msvc"
          ? ["windows", "x64"]
          : target === "aarch64-unknown-linux-gnu"
            ? ["linux", "aarch64"]
            : ["linux", "x64"]
const baseline = getCurrentSidecar().ocBinary.endsWith("-baseline")
const packageName = `@oven/bun-${platform}-${arch}${baseline ? "-baseline" : ""}`
const directory = await mkdtemp(path.join(os.tmpdir(), "turen-bun-"))
try {
  await $`npm pack ${packageName}@${version} --pack-destination ${directory}`
  const archive = (await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: directory })))[0]
  await $`tar -xzf ${path.join(directory, archive)} -C ${directory}`
  const source = path.join(directory, "package", "bin", platform === "windows" ? "bun.exe" : "bun")
  const destination = path.join(desktopDir, "resources", platform === "windows" ? "bun.exe" : "bun")
  await cp(source, destination)
  if (platform !== "windows") await $`chmod 755 ${destination}`
  if (platform === "windows" && process.platform === "win32" && process.env.GITHUB_ACTIONS === "true")
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${path.join(desktopDir, "../../script/sign-windows.ps1")} ${destination}`
  console.log(`Staged ${packageName}@${version} for ${target}`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
