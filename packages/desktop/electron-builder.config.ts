import { execFile } from "node:child_process"
import { access, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { extractFile } from "@electron/asar"
import type { Configuration } from "electron-builder"
import { missingTreeSitterAssets, referencedWasmAssets } from "./scripts/wasm-assets"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const noticeFile = path.join(rootDir, "NOTICE")
const thinkingOrbsLicense = path.join(
  rootDir,
  "packages",
  "ui",
  "src",
  "components",
  "thinking-engine",
  "THIRD_PARTY_LICENSE.txt",
)
const thirdPartyNotices = path.join(packageDir, "resources", "licenses", "THIRD_PARTY_NOTICES.txt")
const thirdPartyInventory = path.join(packageDir, "resources", "licenses", "THIRD_PARTY_LICENSES.json")
// Keep a stable launcher alias so existing GNOME/KDE pins survive package updates.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "forge-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/forge-desktop.desktop`
const localNetworkUsage = "TurenOS connects to model servers and other services on your local network."
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
const emailSecurityWorkerResource = {
  from: "out/main/chunks/email-security-worker.js",
  to: "email-security/email-security-worker.js",
}
const emailSecurityAssetsResource = {
  from: "out/main/chunks/email-security/",
  to: "email-security/",
}
const emailAuthenticateWorkerResource = {
  from: "out/main/chunks/email-authenticate/email-authenticate-worker.js",
  to: "email-authenticate/email-authenticate-worker.js",
}
const emailAuthenticateAssetsResource = {
  from: "out/main/chunks/email-authenticate/",
  to: "email-authenticate/",
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
const wasmToolLeaves = [
  "apk-dex",
  "binary-diff",
  "browser-artifacts",
  "capa-match",
  "code-signing",
  "codec",
  "crypto-markers",
  "firmware-formats",
  "fuzzy-hash",
  "git-inspect",
  "image-inspect",
  "installer-inspect",
  "java-inspect",
  "json-query",
  "macos-artifacts",
  "minidump",
  "pdf-inspect",
  "ripgrep-wasm",
  "rtf-inspect",
  "sourcemap",
  "sqlite-inspect",
  "squashfs",
  "unicode-audit",
  "wasm-toolkit",
]
async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const verifyPackage: NonNullable<Configuration["afterPack"]> = async (context) => {
  const resources = path.join(
    context.appOutDir,
    context.electronPlatformName === "darwin"
      ? `${context.packager.appInfo.productFilename}.app/Contents/Resources`
      : "resources",
  )
  await Promise.all(
    [
      "decompiler/decompiler-worker.js",
      "decompiler/ghidra-decompiler/package.json",
      "decompiler/ghidra-decompiler/dist/ghidra_decompiler.js",
      "decompiler/ghidra-decompiler/dist/ghidra_decompiler.wasm",
      "decompiler/ghidra-decompiler/dist/Processors/x86/data/languages/x86-64.sla",
      "yara/yara-worker.js",
      "yara/yara-x/package.json",
      "yara/yara-x/dist/yara_x_js.js",
      "yara/yara-x/dist/yara_x_js_bg.wasm",
      "email-security/email-security-worker.js",
      "email-security/dist/turen_email_security_wasm.js",
      "email-security/dist/turen_email_security_wasm_bg.wasm",
      "email-authenticate/email-authenticate-worker.js",
      "email-authenticate/package.json",
      "email-authenticate/dist/turen_email_authenticate_wasm.js",
      "email-authenticate/dist/turen_email_authenticate_wasm.d.ts",
      "email-authenticate/dist/turen_email_authenticate_wasm_bg.wasm",
      "wasm-inspect/wasm-inspect-worker.js",
      "wasm-inspect/package.json",
      "wasm-inspect/dist/turen_wasm_inspect_wasm.js",
      "wasm-inspect/dist/turen_wasm_inspect_wasm.d.ts",
      "wasm-inspect/dist/turen_wasm_inspect_wasm_bg.wasm",
      "protocol-inspect/protocol-inspect-worker.js",
      "protocol-inspect/package.json",
      "protocol-inspect/dist/turen_protocol_inspect_wasm.js",
      "protocol-inspect/dist/turen_protocol_inspect_wasm.d.ts",
      "protocol-inspect/dist/turen_protocol_inspect_wasm_bg.wasm",
      "debug-symbols/debug-symbols-worker.js",
      "debug-symbols/package.json",
      "debug-symbols/dist/turen_debug_symbols_wasm.js",
      "debug-symbols/dist/turen_debug_symbols_wasm.d.ts",
      "debug-symbols/dist/turen_debug_symbols_wasm_bg.wasm",
      "binwalk-scan/binwalk-scan-worker.js",
      "binwalk-scan/package.json",
      "binwalk-scan/dist/turen_binwalk_scan_wasm.js",
      "binwalk-scan/dist/turen_binwalk_scan_wasm.d.ts",
      "binwalk-scan/dist/turen_binwalk_scan_wasm_bg.wasm",

      "binary-tools/binary-analysis-worker.js",
      "binary-tools/goblin/dist/turen_goblin_wasm_bg.wasm",
      "binary-tools/stng-core/dist/turen_stng_core_wasm_bg.wasm",
      "binary-tools/libpcap/dist/libpcap.wasm",
      "binary-tools/static-unpack/dist/upx.wasm",
      "binary-tools/static-unpack/dist/mpress/turen_mpress_wasm_bg.wasm",
      "binary-tools/monodis/package.json",
      "binary-tools/monodis/NOTICE",
      "binary-tools/monodis/dist/monodis.js",
      "binary-tools/monodis/dist/monodis.wasm",
      "binary-tools/monodis/dist/monodis.wasm.map",
      "binary-tools/monodis/dist/LICENSE-MONO",
      "binary-tools/monodis/dist/PATENTS-MONO",
      "static-analysis/static-analysis-worker.js",
      "static-analysis/package.json",
      "static-analysis/dist/turen_static_analysis_wasm.js",
      "static-analysis/dist/turen_static_analysis_wasm_bg.wasm",
      "forensic-tools/forensic-worker.js",
      "forensic-tools/wifi-offline/dist/turen_wifi_offline_wasm.js",
      "forensic-tools/wifi-offline/dist/turen_wifi_offline_wasm_bg.wasm",
      "forensic-tools/windows-artifacts/dist/turen_windows_artifacts_wasm.js",
      "forensic-tools/windows-artifacts/dist/turen_windows_artifacts_wasm_bg.wasm",
      "forensic-tools/rebuild-timeline/dist/turen_rebuild_timeline_wasm.js",
      "forensic-tools/rebuild-timeline/dist/turen_rebuild_timeline_wasm_bg.wasm",
      "vigil/SHA256SUMS",
      "vigil/compact-model.onnx",
      "vigil/compact-model.onnx.json",
      `vigil/${context.electronPlatformName === "win32" ? "vigil-compact.exe" : "vigil-compact"}`,
      `vigil/${context.electronPlatformName === "darwin" ? "libonnxruntime.dylib" : context.electronPlatformName === "win32" ? "onnxruntime.dll" : "libonnxruntime.so"}`,
      ...wasmToolLeaves.flatMap((name) => [`${name}/${name}-worker.js`, `${name}/package.json`]),
    ].map((file) =>
      access(path.join(resources, file)).catch(() => {
        throw new Error(`Packaged decompile artifact is missing: ${file}`)
      }),
    ),
  )
  await Promise.all(
    wasmToolLeaves.map(async (name) => {
      const dist = await readdir(path.join(resources, name, "dist")).catch(() => [] as string[])
      if (!dist.some((file) => file.endsWith(".wasm")))
        throw new Error(`Packaged wasm tool artifact is missing: ${name}/dist/*.wasm`)
    }),
  )
  const mainOutput = path.join(packageDir, "out/main")
  const protocolInspectMetadata = JSON.parse(
    await readFile(path.join(resources, "protocol-inspect/package.json"), "utf8"),
  )
  if (
    protocolInspectMetadata.name !== "@turenlabs/protocol-inspect-wasm" ||
    protocolInspectMetadata.type !== "module" ||
    (protocolInspectMetadata.main !== undefined &&
      protocolInspectMetadata.main !== "dist/turen_protocol_inspect_wasm.js") ||
    (protocolInspectMetadata.types !== undefined &&
      protocolInspectMetadata.types !== "dist/turen_protocol_inspect_wasm.d.ts") ||
    (protocolInspectMetadata.main === undefined &&
      !JSON.stringify(protocolInspectMetadata.exports ?? "").includes("turen_protocol_inspect_wasm.js")) ||
    (protocolInspectMetadata.exports !== undefined &&
      !JSON.stringify(protocolInspectMetadata.exports).includes("turen_protocol_inspect_wasm.js"))
  )
    throw new Error(`Packaged protocol-inspect metadata is invalid: ${JSON.stringify(protocolInspectMetadata)}`)

  await Promise.all(
    [
      "protocol-inspect/package.json",
      "protocol-inspect/dist/turen_protocol_inspect_wasm.js",
      "protocol-inspect/dist/turen_protocol_inspect_wasm.d.ts",
      "protocol-inspect/dist/turen_protocol_inspect_wasm_bg.wasm",
    ].map(async (file) => {
      const built = await readFile(path.join(mainOutput, "chunks", file))
      const packaged = await readFile(path.join(resources, file))
      if (built.equals(packaged)) return
      throw new Error(`Packaged protocol-inspect artifact differs from the desktop build: ${file}`)
    }),
  )
  const debugSymbolsMetadata = JSON.parse(await readFile(path.join(resources, "debug-symbols/package.json"), "utf8"))
  if (
    debugSymbolsMetadata.name !== "@turenlabs/debug-symbols-wasm" ||
    debugSymbolsMetadata.type !== "module" ||
    debugSymbolsMetadata.main !== "dist/turen_debug_symbols_wasm.js" ||
    debugSymbolsMetadata.types !== "dist/turen_debug_symbols_wasm.d.ts"
  )
    throw new Error(`Packaged debug-symbols metadata is invalid: ${JSON.stringify(debugSymbolsMetadata)}`)
  await Promise.all(
    [
      "debug-symbols/package.json",
      "debug-symbols/dist/turen_debug_symbols_wasm.js",
      "debug-symbols/dist/turen_debug_symbols_wasm.d.ts",
      "debug-symbols/dist/turen_debug_symbols_wasm_bg.wasm",
    ].map(async (file) => {
      const built = await readFile(path.join(mainOutput, "chunks", file))
      const packaged = await readFile(path.join(resources, file))
      if (built.equals(packaged)) return
      throw new Error(`Packaged debug-symbols artifact differs from the desktop build: ${file}`)
    }),
  )
  const binwalkScanMetadata = JSON.parse(await readFile(path.join(resources, "binwalk-scan/package.json"), "utf8"))
  if (binwalkScanMetadata.name !== "@turenlabs/binwalk-scan-wasm" || binwalkScanMetadata.type !== "module")
    throw new Error(`Packaged binwalk-scan metadata is invalid: ${JSON.stringify(binwalkScanMetadata)}`)
  await Promise.all(
    [
      "binwalk-scan/package.json",
      "binwalk-scan/dist/turen_binwalk_scan_wasm.js",
      "binwalk-scan/dist/turen_binwalk_scan_wasm.d.ts",
      "binwalk-scan/dist/turen_binwalk_scan_wasm_bg.wasm",
    ].map(async (file) => {
      const built = await readFile(path.join(mainOutput, "chunks", file))
      const packaged = await readFile(path.join(resources, file))
      if (built.equals(packaged)) return
      throw new Error(`Packaged binwalk-scan artifact differs from the desktop build: ${file}`)
    }),
  )

  const wasmAssets = await referencedWasmAssets(mainOutput)
  const missingParserRuntimes = missingTreeSitterAssets(wasmAssets)
  if (missingParserRuntimes.length > 0)
    throw new Error(`Desktop Tree-sitter artifacts are missing: ${missingParserRuntimes.join(", ")}`)

  const archive = path.join(resources, "app.asar")
  await Promise.all(
    wasmAssets.map(async (file) => {
      const packaged = extractFile(archive, path.join("out", "main", file))
      if ((await readFile(path.join(mainOutput, file))).equals(packaged)) return
      throw new Error(`Packaged WASM artifact differs from the desktop build: ${file}`)
    }),
  )
  if (context.electronPlatformName !== "darwin") return
  const result = await execFileAsync("plutil", [
    "-extract",
    "NSLocalNetworkUsageDescription",
    "raw",
    path.join(resources, "../Info.plist"),
  ])
  if (result.stdout.trim() !== localNetworkUsage)
    throw new Error(`Packaged NSLocalNetworkUsageDescription is invalid: ${result.stdout.trim()}`)
}

const channel = (() => {
  const raw = process.env.FORGE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (raw === "latest") return "prod"
  return "dev"
})()

const APP_IDS = {
  dev: "com.turenlabs.forge.dev",
  beta: "com.turenlabs.forge.beta",
  prod: "com.turenlabs.forge",
} as const

const artifactArch = process.env.RUST_TARGET?.startsWith("x86_64")
  ? "x64"
  : process.env.RUST_TARGET?.startsWith("aarch64")
    ? "arm64"
    : "${arch}"

const getBase = (appId: string): Configuration => ({
  artifactName: `turenos-desktop-\${os}-${artifactArch}.\${ext}`,
  // Every shipped native module has per-arch prebuilds (installed via
  // --cpu="*" on cross builds); the only module without one — optional
  // msgpackr-extract on win32-arm64 — falls back to JS. Rebuilding would
  // need an ARM64 MSVC toolset on the x64 cross-build runner.
  npmRebuild: false,
  afterPack: verifyPackage,
  publish: [
    {
      provider: "github",
      owner: "turenlabs",
      repo: "turenos",
      channel: `latest-${artifactArch === "${arch}" ? process.arch : artifactArch}`,
    },
  ],
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name.
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "!out/main/chunks/decompiler-worker.js",
    "!out/main/chunks/ghidra-decompiler/**/*",
    "!out/main/chunks/yara-worker.js",
    "!out/main/chunks/yara-x/**/*",
    "!out/main/chunks/email-authenticate/**/*",
    "!out/main/chunks/wasm-inspect-worker.js",
    "!out/main/chunks/wasm-inspect/**/*",
    "!out/main/chunks/protocol-inspect/**/*",
    "!out/main/chunks/debug-symbols/**/*",
    "!out/main/chunks/binwalk-scan/**/*",
    "!out/main/chunks/binary-tools/**/*",
    "!out/main/chunks/static-analysis/**/*",
    "!out/main/chunks/forensic-tools/**/*",
    ...wasmToolLeaves.map((name) => `!out/main/chunks/${name}/**/*`),
    "resources/**/*",
    "!resources/forge-cli*",
  ],
  extraResources: [
    {
      from: "resources/",
      to: ".",
      filter: ["forge-cli*", "vigil/**"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    decompilerWorkerResource,
    decompilerAssetsResource,
    yaraWorkerResource,
    yaraAssetsResource,
    emailSecurityWorkerResource,
    emailSecurityAssetsResource,
    emailAuthenticateWorkerResource,
    emailAuthenticateAssetsResource,
    wasmInspectWorkerResource,
    wasmInspectAssetsResource,
    protocolInspectWorkerResource,
    protocolInspectAssetsResource,
    debugSymbolsWorkerResource,
    debugSymbolsAssetsResource,
    binwalkScanWorkerResource,
    binwalkScanAssetsResource,
    binaryToolsResource,
    staticAnalysisWorkerResource,
    staticAnalysisAssetsResource,
    forensicToolsResource,
    ...wasmToolLeaves.map((name) => ({
      from: `out/main/chunks/${name}/`,
      to: `${name}/`,
    })),
    {
      from: noticeFile,
      to: "licenses/TurenOS-NOTICE.txt",
    },
    {
      from: thinkingOrbsLicense,
      to: "licenses/Thinking-Orbs-MIT.txt",
    },
    {
      from: thirdPartyNotices,
      to: "licenses/THIRD_PARTY_NOTICES.txt",
    },
    {
      from: thirdPartyInventory,
      to: "licenses/THIRD_PARTY_LICENSES.json",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    // Resource trees that ship only wasm/js/json data (no Mach-O), so the
    // hardened-runtime sign pass would otherwise spend a codesign spawn per
    // file for no benefit. Native payloads (vigil, forge-cli, native/) and
    // app.asar.unpacked stay signed. If a listed dir ever gains a Mach-O,
    // notarization fails visibly rather than shipping unsigned code.
    signIgnore: [
      "decompiler/",
      "yara/",
      "binary-tools/",
      "static-analysis/",
      "forensic-tools/",
      "email-security/",
      "email-authenticate/",
      "wasm-inspect/",
      "protocol-inspect/",
      "debug-symbols/",
      "binwalk-scan/",
      ...wasmToolLeaves,
    ].map((name) => `/Resources/${name}`),
    hardenedRuntime: true,
    gatekeeperAssess: false,
    extendInfo: {
      NSLocalNetworkUsageDescription: localNetworkUsage,
    },
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "TurenOS",
    schemes: ["forge"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
      publisherName: "Turen Labs, Inc",
    },
    target: ["nsis"],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "TurenOS Dev",
        deb: { packageName: "forge-dev" },
        rpm: { packageName: "forge-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "TurenOS Beta",
        protocols: { name: "TurenOS Beta", schemes: ["forge"] },
        deb: { packageName: "forge-beta" },
        rpm: { packageName: "forge-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "TurenOS",
        protocols: { name: "TurenOS", schemes: ["forge"] },
        deb: { packageName: "forge", fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "forge", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
