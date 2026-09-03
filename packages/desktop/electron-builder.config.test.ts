import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Configuration } from "electron-builder"
import { missingTreeSitterAssets, referencedWasmAssets } from "./scripts/wasm-assets"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const legacyDesktopEntry = "resources/linux/forge-desktop.desktop"
const noticeResource = {
  from: path.join(rootDir, "NOTICE"),
  to: "licenses/TurenOS-NOTICE.txt",
}
const thinkingOrbsLicenseResource = {
  from: path.join(rootDir, "packages", "ui", "src", "components", "thinking-engine", "THIRD_PARTY_LICENSE.txt"),
  to: "licenses/Thinking-Orbs-MIT.txt",
}
const thirdPartyNoticesResource = {
  from: path.join(rootDir, "packages", "desktop", "resources", "licenses", "THIRD_PARTY_NOTICES.txt"),
  to: "licenses/THIRD_PARTY_NOTICES.txt",
}
const thirdPartyInventoryResource = {
  from: path.join(rootDir, "packages", "desktop", "resources", "licenses", "THIRD_PARTY_LICENSES.json"),
  to: "licenses/THIRD_PARTY_LICENSES.json",
}
const decompilerWorkerResource = {
  from: "out/main/chunks/decompiler-worker.js",
  to: "decompiler/decompiler-worker.js",
}
const decompilerAssetsResource = {
  from: "out/main/chunks/ghidra-decompiler/",
  to: "decompiler/ghidra-decompiler/",
}
const yaraWorkerResource = {
  from: "out/main/chunks/yara-worker.js",
  to: "yara/yara-worker.js",
}
const yaraAssetsResource = {
  from: "out/main/chunks/yara-x/",
  to: "yara/yara-x/",
}
const wasmInspectWorkerResource = {
  from: "out/main/chunks/wasm-inspect-worker.js",
  to: "wasm-inspect/wasm-inspect-worker.js",
}
const wasmInspectAssetsResource = {
  from: "out/main/chunks/wasm-inspect/",
  to: "wasm-inspect/",
}
const protocolInspectWorkerResource = {
  from: "out/main/chunks/protocol-inspect/protocol-inspect-worker.js",
  to: "protocol-inspect/protocol-inspect-worker.js",
}
const protocolInspectAssetsResource = {
  from: "out/main/chunks/protocol-inspect/",
  to: "protocol-inspect/",
}
const debugSymbolsWorkerResource = {
  from: "out/main/chunks/debug-symbols/debug-symbols-worker.js",
  to: "debug-symbols/debug-symbols-worker.js",
}
const debugSymbolsAssetsResource = {
  from: "out/main/chunks/debug-symbols/",
  to: "debug-symbols/",
}
const binwalkScanWorkerResource = {
  from: "out/main/chunks/binwalk-scan/binwalk-scan-worker.js",
  to: "binwalk-scan/binwalk-scan-worker.js",
}
const binwalkScanAssetsResource = {
  from: "out/main/chunks/binwalk-scan/",
  to: "binwalk-scan/",
}
const binaryToolsResource = {
  from: "out/main/chunks/binary-tools/",
  to: "binary-tools/",
  filter: ["**/*", "!static-unpack/*-source.tar.gz"],
}
const staticAnalysisWorkerResource = {
  from: "out/main/chunks/static-analysis/static-analysis-worker.js",
  to: "static-analysis/static-analysis-worker.js",
}
const staticAnalysisAssetsResource = {
  from: "out/main/chunks/static-analysis/",
  to: "static-analysis/",
}
const forensicToolsResource = {
  from: "out/main/chunks/forensic-tools/",
  to: "forensic-tools/",
}

const channels = [
  { channel: "dev", appId: "com.turenlabs.forge.dev" },
  { channel: "beta", appId: "com.turenlabs.forge.beta" },
  { channel: "prod", appId: "com.turenlabs.forge" },
] as const

test("finds the exact WASM assets referenced by the desktop bundle", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "turen-desktop-wasm-"))
  await mkdir(path.join(directory, "chunks"))
  await Promise.all([
    Bun.write(
      path.join(directory, "chunks/runtime.js"),
      'export const runtime = "./tree-sitter-live.wasm"; export const bash = "./tree-sitter-bash-live.wasm"',
    ),
    Bun.write(path.join(directory, "chunks/powershell.js"), 'export default "./tree-sitter-powershell-live.wasm"'),
    Bun.write(path.join(directory, "chunks/tree-sitter-stale.wasm"), "stale"),
  ])

  const assets = await referencedWasmAssets(directory)
  expect(assets).toEqual([
    path.join("chunks", "tree-sitter-bash-live.wasm"),
    path.join("chunks", "tree-sitter-live.wasm"),
    path.join("chunks", "tree-sitter-powershell-live.wasm"),
  ])
  expect(missingTreeSitterAssets(assets)).toEqual([])
  expect(missingTreeSitterAssets([path.join("chunks", "tree-sitter-stale.wasm")])).toEqual(["Bash", "PowerShell"])
  await rm(directory, { recursive: true })
})

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.FORGE_CHANNEL
    process.env.FORGE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.FORGE_CHANNEL
    else process.env.FORGE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.productName).toBe(
      channel.channel === "prod"
        ? "TurenOS"
        : `TurenOS ${channel.channel.charAt(0).toUpperCase() + channel.channel.slice(1)}`,
    )
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.packageName).toBe(channel.channel === "prod" ? "forge" : `forge-${channel.channel}`)
    expect(config.rpm?.packageName).toBe(channel.channel === "prod" ? "forge" : `forge-${channel.channel}`)
    expect(config.mac?.extendInfo).toMatchObject({
      NSLocalNetworkUsageDescription: "TurenOS connects to model servers and other services on your local network.",
    })
    expect(config.artifactName).toBe("turenos-desktop-${os}-${arch}.${ext}")
    expect(config.mac).toMatchObject({
      hardenedRuntime: true,
      entitlements: "resources/entitlements.plist",
      entitlementsInherit: "resources/entitlements.plist",
      notarize: true,
      target: ["dmg", "zip"],
    })
    expect(config.dmg?.sign).toBe(true)
    expect(config.win?.target).toEqual(["nsis"])
    expect(config.win?.signtoolOptions?.sign).toBeFunction()
    expect(config.linux?.target).toEqual(["AppImage", "deb", "rpm"])
    expect(config.afterPack).toBeFunction()
    expect(config.files).toContain("!resources/forge-cli*")
    expect(config.files).toContain("!out/main/chunks/decompiler-worker.js")
    expect(config.files).toContain("!out/main/chunks/ghidra-decompiler/**/*")
    expect(config.files).toContain("!out/main/chunks/yara-worker.js")
    expect(config.files).toContain("!out/main/chunks/yara-x/**/*")
    expect(config.files).toContain("!out/main/chunks/wasm-inspect-worker.js")
    expect(config.files).toContain("!out/main/chunks/wasm-inspect/**/*")
    expect(config.files).toContain("!out/main/chunks/protocol-inspect/**/*")
    expect(config.files).toContain("!out/main/chunks/debug-symbols/**/*")
    expect(config.files).toContain("!out/main/chunks/binwalk-scan/**/*")
    expect(config.files).toContain("!out/main/chunks/binary-tools/**/*")
    expect(config.files).toContain("!out/main/chunks/static-analysis/**/*")
    expect(config.files).toContain("!out/main/chunks/forensic-tools/**/*")
    expect(config.asarUnpack).toBeUndefined()
    expect(config.publish).toEqual([{ provider: "github", owner: "turenio", repo: "turen" }])
    expect(config.extraResources).toContainEqual({
      from: "resources/",
      to: ".",
      filter: ["forge-cli*"],
    })
    expect(config.extraResources).toContainEqual(noticeResource)
    expect(config.extraResources).toContainEqual(thinkingOrbsLicenseResource)
    expect(config.extraResources).toContainEqual(thirdPartyNoticesResource)
    expect(config.extraResources).toContainEqual(thirdPartyInventoryResource)
    expect(config.extraResources).toContainEqual(decompilerWorkerResource)
    expect(config.extraResources).toContainEqual(decompilerAssetsResource)
    expect(config.extraResources).toContainEqual(yaraWorkerResource)
    expect(config.extraResources).toContainEqual(yaraAssetsResource)
    expect(config.extraResources).toContainEqual(wasmInspectWorkerResource)
    expect(config.extraResources).toContainEqual(wasmInspectAssetsResource)
    expect(config.extraResources).toContainEqual(protocolInspectWorkerResource)
    expect(config.extraResources).toContainEqual(protocolInspectAssetsResource)
    expect(config.extraResources).toContainEqual(debugSymbolsWorkerResource)
    expect(config.extraResources).toContainEqual(debugSymbolsAssetsResource)
    expect(config.extraResources).toContainEqual(binwalkScanWorkerResource)
    expect(config.extraResources).toContainEqual(binwalkScanAssetsResource)
    expect(config.extraResources).toContainEqual(binaryToolsResource)
    expect(config.extraResources).toContainEqual(staticAnalysisWorkerResource)
    expect(config.extraResources).toContainEqual(staticAnalysisAssetsResource)
    expect(config.extraResources).toContainEqual(forensicToolsResource)
  })
}

test("desktop notice resources exist at their configured sources", async () => {
  expect(await Bun.file(noticeResource.from).exists()).toBe(true)
  expect(await Bun.file(thinkingOrbsLicenseResource.from).exists()).toBe(true)
  expect(await Bun.file(thirdPartyNoticesResource.from).exists()).toBe(true)
  expect(await Bun.file(thirdPartyInventoryResource.from).exists()).toBe(true)
  expect(await Bun.file(noticeResource.from).text()).toContain("licenses/Thinking-Orbs-MIT.txt")
  expect(await Bun.file(thinkingOrbsLicenseResource.from).text()).toContain("Copyright (c) 2026 Jakub Antalik")
})

test("normalizes the legacy latest channel to prod", async () => {
  const previous = process.env.FORGE_CHANNEL
  process.env.FORGE_CHANNEL = "latest"

  const module = await import("./electron-builder.config.ts?channel=latest")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.FORGE_CHANNEL
  else process.env.FORGE_CHANNEL = previous

  expect(config.appId).toBe("com.turenlabs.forge")
  expect(config.productName).toBe("TurenOS")
})

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.FORGE_CHANNEL
  process.env.FORGE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.FORGE_CHANNEL
  else process.env.FORGE_CHANNEL = previous

  expect(config.deb?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/forge-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/forge-desktop.desktop`)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/Forge/com.turenlabs.forge %U")
  expect(desktop).toContain("Icon=com.turenlabs.forge")
  expect(desktop).toContain("StartupWMClass=com.turenlabs.forge")
  expect(desktop).toContain("NoDisplay=true")
})
