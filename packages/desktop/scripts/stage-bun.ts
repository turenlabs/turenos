#!/usr/bin/env bun
import { $ } from "bun"
import { mkdtemp, rm, cp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Platform } from "@turenlabs/script/platform"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const version = (await Bun.file(path.join(desktopDir, "../../package.json")).json()).packageManager.split("@")[1]
const target = Platform.get()
const packageName = `@oven/bun-${target.bun}`
const directory = await mkdtemp(path.join(os.tmpdir(), "turen-bun-"))
try {
  await $`npm pack ${packageName}@${version} --pack-destination ${directory}`
  const archive = (await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: directory })))[0]
  await $`tar -xzf ${archive}`.cwd(directory)
  const source = path.join(directory, "package", "bin", target.platform === "win32" ? "bun.exe" : "bun")
  const destination = path.join(desktopDir, "resources", target.platform === "win32" ? "bun.exe" : "bun")
  await cp(source, destination)
  if (target.platform !== "win32") await $`chmod 755 ${destination}`
  if (
    target.platform === "win32" &&
    process.platform === "win32" &&
    process.env.GITHUB_ACTIONS === "true" &&
    !Bun.argv.includes("--unsigned")
  )
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${path.join(desktopDir, "../../script/sign-windows.ps1")} ${destination}`
  console.log(`Staged ${packageName}@${version} for ${target.rustTarget}`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
