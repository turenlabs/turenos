#!/usr/bin/env bun

import { $ } from "bun"
import { createRequire } from "node:module"
import path from "path"
import { cp, mkdir } from "node:fs/promises"

const dir = path.resolve(import.meta.dirname, "..")

process.chdir(dir)

const ghidraRoot = path.dirname(
  createRequire(path.join(dir, "../core/package.json")).resolve("@turenlabs/ghidra-decompiler-wasm"),
)
const yaraRoot = path.dirname(createRequire(path.join(dir, "../core/package.json")).resolve("@turenlabs/yara-x-wasm"))
const emailSecurityRoot = path.dirname(
  createRequire(path.join(dir, "../core/package.json")).resolve("@turenlabs/email-security-wasm"),
)
const emailAuthenticateRoot = path.dirname(
  createRequire(path.join(dir, "../core/package.json")).resolve("@turenlabs/email-authenticate-wasm"),
)
const wasmInspectRoot = path.dirname(
  createRequire(path.join(dir, "../core/package.json")).resolve("@turenlabs/wasm-inspect-wasm"),
)
const debugSymbolsRoot = path.dirname(
  createRequire(path.join(dir, "../core/package.json")).resolve("@turenlabs/debug-symbols-wasm"),
)
const binaryPackages = [
  ["goblin", "@turenlabs/goblin-wasm"],
  ["stng-core", "@turenlabs/stng-core-wasm"],
  ["libpcap", "@turenlabs/libpcap-wasm"],
  ["static-unpack", "@turenlabs/static-unpack-wasm"],
  ["monodis", "@turenlabs/monodis-wasm"],
  ["static-analysis", "@turenlabs/static-analysis-wasm"],
  ["protocol-inspect", "@turenlabs/protocol-inspect-wasm"],
  ["wifi-offline", "@turenlabs/wifi-offline-wasm"],
  ["windows-artifacts", "@turenlabs/windows-artifacts-wasm"],
  ["rebuild-timeline", "@turenlabs/rebuild-timeline-wasm"],
  ["binwalk-scan", "@turenlabs/binwalk-scan-wasm"],
  ["ripgrep-wasm", "@turenlabs/ripgrep-wasm"],
].map(([name, packageName]) => ({
  name,
  root: path.dirname(createRequire(path.join(dir, "../core/package.json")).resolve(packageName)),
}))
const wasmLeaves = [
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
  "rtf-inspect",
  "sourcemap",
  "sqlite-inspect",
  "squashfs",
  "unicode-audit",
  "wasm-toolkit",
]
const wasmLeafPackages = wasmLeaves.map((name) => ({
  name,
  root: path.dirname(createRequire(path.join(dir, "../core/package.json")).resolve(`@turenlabs/${name}-wasm`)),
}))
const generated = await import("./generate.ts")

import { Script } from "@turenlabs/script"
import pkg from "../package.json"
import { stageVigil } from "./vigil"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const platformFlag = process.argv.includes("--platform")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const rustTargets: Record<string, (typeof allTargets)[number]> = {
  "aarch64-apple-darwin": { os: "darwin", arch: "arm64" },
  "x86_64-apple-darwin": { os: "darwin", arch: "x64", avx2: false },
  "aarch64-pc-windows-msvc": { os: "win32", arch: "arm64" },
  "x86_64-pc-windows-msvc": { os: "win32", arch: "x64", avx2: false },
  "aarch64-unknown-linux-gnu": { os: "linux", arch: "arm64" },
  "x86_64-unknown-linux-gnu": { os: "linux", arch: "x64", avx2: false },
}
const requestedTarget = process.env.RUST_TARGET ? rustTargets[process.env.RUST_TARGET] : undefined

if (singleFlag && process.env.RUST_TARGET && !requestedTarget) {
  throw new Error(`Unsupported RUST_TARGET: ${process.env.RUST_TARGET}`)
}

const targets = platformFlag
  ? allTargets.filter((item) => item.os === process.platform && item.arch === process.arch)
  : singleFlag
    ? allTargets.filter((item) => {
        if (requestedTarget) {
          return (
            item.os === requestedTarget.os &&
            item.arch === requestedTarget.arch &&
            item.avx2 === requestedTarget.avx2 &&
            item.abi === undefined
          )
        }
        if (item.os !== process.platform || item.arch !== process.arch) {
          return false
        }

        // When building for the current platform, prefer a single native binary by default.
        // Baseline binaries require additional Bun artifacts and can be flaky to download.
        if (item.avx2 === false) {
          return baselineFlag
        }

        // also skip abi-specific builds for the same reason
        if (item.abi !== undefined) {
          return false
        }

        return true
      })
    : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = [
    "forge",
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace("forge", "bun") as any,
      outfile: `dist/${name}/bin/forge`,
      execArgv: [`--user-agent=forge/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    entrypoints: ["./src/index.ts"],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      FORGE_VERSION: `'${Script.version}'`,
      FORGE_MODELS_DEV: generated.modelsData,
      FORGE_CHANNEL: `'${Script.channel}'`,
      FORGE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
    },
  })

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    target: "bun",
    entrypoints: [
      "../core/src/tool/decompiler-worker.ts",
      "../core/src/tool/yara-worker.ts",
      "../core/src/tool/binary-analysis-worker.ts",
      "../core/src/tool/static-analysis-worker.ts",
      "../core/src/tool/protocol-inspect-worker.ts",
      "../core/src/tool/forensic-worker.ts",
      "../core/src/tool/email-security-worker.ts",
      "../core/src/tool/email-authenticate-worker.ts",
      "../core/src/tool/wasm-inspect-worker.ts",
      "../core/src/tool/debug-symbols-worker.ts",
      "../core/src/tool/binwalk-scan-worker.ts",
      "../core/src/ripgrep/wasm/ripgrep-wasm-worker.ts",
      ...wasmLeaves.map((leaf) => `../core/src/tool/${leaf}-worker.ts`),
    ],
    outdir: `dist/${name}/bin`,
    naming: {
      entry: "[name].js",
      chunk: "chunk-[hash].js",
      asset: "asset-[hash][ext]",
    },
  })

  await cp(ghidraRoot, path.join("dist", name, "bin", "ghidra-decompiler", "dist"), { recursive: true })
  await cp(
    path.join(ghidraRoot, "../package.json"),
    path.join("dist", name, "bin", "ghidra-decompiler", "package.json"),
  )
  await cp(yaraRoot, path.join("dist", name, "bin", "yara-x", "dist"), { recursive: true })
  await cp(path.join(yaraRoot, "../package.json"), path.join("dist", name, "bin", "yara-x", "package.json"))
  await cp(path.join(emailSecurityRoot, ".."), path.join("dist", name, "bin", "email-security"), { recursive: true })
  await cp(emailAuthenticateRoot, path.join("dist", name, "bin", "email-authenticate", "dist"), { recursive: true })
  await cp(
    path.join(emailAuthenticateRoot, "../package.json"),
    path.join("dist", name, "bin", "email-authenticate", "package.json"),
  )
  await cp(path.join(wasmInspectRoot, ".."), path.join("dist", name, "bin", "wasm-inspect"), { recursive: true })
  await cp(path.join(debugSymbolsRoot, ".."), path.join("dist", name, "bin", "debug-symbols"), { recursive: true })
  for (const binaryPackage of binaryPackages)
    await cp(path.join(binaryPackage.root, ".."), path.join("dist", name, "bin", binaryPackage.name), {
      recursive: true,
    })
  for (const leaf of wasmLeafPackages)
    await cp(path.join(leaf.root, ".."), path.join("dist", name, "bin", leaf.name), { recursive: true })
  await stageVigil(item, path.join("dist", name, "bin", "vigil"))
  await Bun.write(path.join("dist", name, "bin", "package.json"), JSON.stringify({ type: "module" }, null, 2))

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/forge`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  const licenseDirectory = `dist/${name}/bin/licenses`
  await mkdir(licenseDirectory, { recursive: true })
  for (const file of [
    { from: "../../LICENSE", to: "Turen-LICENSE.txt" },
    { from: "../../NOTICE", to: "Turen-NOTICE.txt" },
    { from: "../desktop/resources/licenses/THIRD_PARTY_NOTICES.txt", to: "THIRD_PARTY_NOTICES.txt" },
    { from: "../desktop/resources/licenses/THIRD_PARTY_LICENSES.json", to: "THIRD_PARTY_LICENSES.json" },
  ]) {
    await Bun.write(path.join(licenseDirectory, file.to), Bun.file(file.from))
  }

  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
