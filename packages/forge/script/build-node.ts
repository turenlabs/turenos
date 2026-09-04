#!/usr/bin/env bun

import { Script } from "@turenlabs/script"
import { createRequire } from "node:module"
import path from "path"
import { cp, rm } from "node:fs/promises"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

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
  ["static-analysis", "@turenlabs/static-analysis-wasm"],
  ["protocol-inspect", "@turenlabs/protocol-inspect-wasm"],
  ["wifi-offline", "@turenlabs/wifi-offline-wasm"],
  ["windows-artifacts", "@turenlabs/windows-artifacts-wasm"],
  ["rebuild-timeline", "@turenlabs/rebuild-timeline-wasm"],
  ["binwalk-scan", "@turenlabs/binwalk-scan-wasm"],
].map(([name, packageName]) => ({
  name,
  root: path.dirname(createRequire(path.join(dir, "../core/package.json")).resolve(packageName)),
}))

const generated = await import("./generate.ts")

// Chunk names are content-hashed, so without this every build leaves the last
// build's chunks behind and the directory grows without bound.
await rm("./dist/node", { recursive: true, force: true })

const nodeBuild = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  // Without splitting, Bun inlines dynamic imports back into the entry, so
  // deferred modules would still be parsed on every server start.
  splitting: true,
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    FORGE_MODELS_DEV: generated.modelsData,
    FORGE_VERSION: JSON.stringify(Script.version),
    FORGE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "forge-web-ui.gen.ts": "",
  },
})

if (!nodeBuild.success) throw new Error("Forge Node build failed")

const workerBuild = await Bun.build({
  target: "node",
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
  ],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  splitting: true,
  naming: {
    entry: "[name].js",
    chunk: "chunk-[hash].js",
    asset: "asset-[hash][ext]",
  },
})

if (!workerBuild.success) throw new Error("Forge worker build failed")

await cp(ghidraRoot, "./dist/node/ghidra-decompiler/dist", { recursive: true })
await cp(path.join(ghidraRoot, "../package.json"), "./dist/node/ghidra-decompiler/package.json")
await cp(yaraRoot, "./dist/node/yara-x/dist", { recursive: true })
await cp(path.join(yaraRoot, "../package.json"), "./dist/node/yara-x/package.json")
await cp(emailSecurityRoot, "./dist/node/email-security/dist", { recursive: true })
await cp(path.join(emailSecurityRoot, "../package.json"), "./dist/node/email-security/package.json")
await cp(emailAuthenticateRoot, "./dist/node/email-authenticate/dist", { recursive: true })
await cp(path.join(emailAuthenticateRoot, "../package.json"), "./dist/node/email-authenticate/package.json")
await cp(path.join(wasmInspectRoot, ".."), "./dist/node/wasm-inspect", { recursive: true })
await cp(path.join(debugSymbolsRoot, ".."), "./dist/node/debug-symbols", { recursive: true })
for (const item of binaryPackages)
  await cp(path.join(item.root, ".."), path.join("./dist/node", item.name), { recursive: true })

console.log("Build complete")
