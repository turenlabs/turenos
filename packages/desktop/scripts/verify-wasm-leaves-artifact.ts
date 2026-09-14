#!/usr/bin/env bun

import assert from "node:assert/strict"
import path from "node:path"
import { readdir } from "node:fs/promises"

const root = path.resolve("out/main/chunks")
const leaves = [
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

for (const name of leaves) {
  assert(await Bun.file(path.join(root, name, `${name}-worker.js`)).exists(), `Desktop wasm tool worker is missing: ${name}`)
  assert(await Bun.file(path.join(root, name, "package.json")).exists(), `Desktop wasm tool package is missing: ${name}`)
  const dist = await readdir(path.join(root, name, "dist")).catch(() => [] as string[])
  assert(
    dist.some((file) => file.endsWith(".wasm")),
    `Desktop wasm tool artifact is missing: ${name}/dist/*.wasm`,
  )
}

console.log(`Verified ${leaves.length} wasm tool leaf artifacts`)
