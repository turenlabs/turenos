import { $ } from "bun"
import { dirname } from "node:path"
import { Platform } from "@turenlabs/script/platform"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.FORGE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (raw === "latest") return "prod"
  return "dev"
}

export const SIDECAR_BINARIES = Platform.targets.map((target) => ({
  rustTarget: target.rustTarget,
  ocBinary: `forge-${target.platform === "win32" ? "windows" : target.platform}-${target.arch}${target.arch === "x64" ? "-baseline" : ""}`,
  assetExt: target.platform === "linux" ? "tar.gz" : "zip",
}))

export const RUST_TARGET = Bun.env.RUST_TARGET

export function getCurrentSidecar(target = Platform.get(RUST_TARGET).rustTarget) {
  const binaryConfig = SIDECAR_BINARIES.find((b) => b.rustTarget === target)
  if (!binaryConfig) throw new Error(`Sidecar configuration not available for Rust target '${target}'`)

  return binaryConfig
}

export async function copyBinaryToSidecarFolder(source: string) {
  const dir = `resources`
  await $`mkdir -p ${dir}`
  const dest = windowsify(`${dir}/forge-cli`)
  await $`cp ${source} ${dest}`
  await $`rm -rf ${dir}/vigil`
  await $`cp -R ${dirname(source)}/vigil ${dir}/vigil`
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Copied ${source} to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
