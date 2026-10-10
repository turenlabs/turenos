#!/usr/bin/env bun

// Fails when a source map would be packed into app.asar. Third-party wasm maps under the
// extraResources trees are shipped outside the asar on purpose and are skipped.
import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const out = path.join(fileURLToPath(new URL("..", import.meta.url)), "out")
const extraResources = ["binary-tools", "ghidra-decompiler"].map((name) => path.join(out, "main", "chunks", name))

const maps = (await readdir(out, { recursive: true }))
  .filter((file) => file.endsWith(".map"))
  .map((file) => path.join(out, file))
  .filter((file) => !extraResources.some((dir) => file.startsWith(dir + path.sep)))

if (maps.length > 0) {
  console.error(`[no-sourcemaps] FAIL ${maps.length} source map(s) in out/, for example ${path.relative(out, maps[0])}`)
  process.exit(1)
}
console.log("[no-sourcemaps] PASS no source maps in out/")
