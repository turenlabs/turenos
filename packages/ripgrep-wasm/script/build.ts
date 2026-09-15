#!/usr/bin/env bun
// Rebuild the vendored artifact from the workbench crate and refresh
// SHA256SUMS. Run from anywhere: bun run --cwd packages/ripgrep-wasm build
import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const crate = path.resolve(dir, "../../workbench/ripgrep-wasm/crate")

await $`cargo build --release --target wasm32-unknown-unknown`.cwd(crate)
await $`cp ${path.join(crate, "target/wasm32-unknown-unknown/release/rgwasm.wasm")} ${path.join(dir, "dist/rgwasm.wasm")}`
const sums = (await $`shasum -a 256 ${path.join(dir, "dist/rgwasm.wasm")}`.text()).trim()
await Bun.write(path.join(dir, "SHA256SUMS"), `${sums.split(" ")[0]}  rgwasm.wasm\n`)
console.log(sums)
