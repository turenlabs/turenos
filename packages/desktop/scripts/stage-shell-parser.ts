#!/usr/bin/env bun
import { $ } from "bun"
import { cp, readdir } from "node:fs/promises"
import path from "node:path"

const target = "aarch64-apple-darwin"
const selected = process.env.RUST_TARGET ?? (process.arch === "arm64" ? target : "")
if (process.platform !== "darwin" || selected !== target) process.exit(0)

const crate = path.resolve(import.meta.dir, "../../core/native/shell-parser")
const dist = path.resolve(import.meta.dir, "../../forge/dist")
const output = path.join(dist, "node")
const targetDir = path.join(dist, "shell-parser-target")
const library = "libturen_shell_parser.dylib"
const toolchain = process.env.RUSTUP_TOOLCHAIN
const tools = toolchain
  ? await Promise.all(
      ["cargo", "rustc"].map(async (name) => (await $`rustup which --toolchain ${toolchain} ${name}`.text()).trim()),
    )
  : undefined
const cargo = tools?.[0] ?? "cargo"
const env = tools ? { ...process.env, RUSTC: tools[1] } : process.env
await $`${cargo} build --release --locked --target ${target} --target-dir ${targetDir}`.cwd(crate).env(env)

const metadata: { packages: { name: string; version: string; manifest_path: string; source: string | null }[] } =
  await $`${cargo} metadata --locked --filter-platform ${target} --format-version 1`.cwd(crate).env(env).json()
const notices = await Promise.all(
  metadata.packages
    .filter((pkg) => pkg.source !== null)
    .map(async (pkg) => {
      // The tree-sitter crate omits the upstream MIT text included by the matching npm runtime.
      const root =
        pkg.name === "tree-sitter"
          ? path.resolve(crate, "../../node_modules/web-tree-sitter")
          : path.dirname(pkg.manifest_path)
      const files = (await readdir(root)).filter((file) => /^(LICENSE|COPYING|NOTICE)([-_.]|$)/i.test(file)).sort()
      if (!files.length) throw new Error(`Shell parser dependency has no license text: ${pkg.name}`)
      return [
        `## ${pkg.name} ${pkg.version}`,
        ...(await Promise.all(files.map(async (file) => `${file}\n${await Bun.file(path.join(root, file)).text()}`))),
      ].join("\n\n")
    }),
)
await Bun.write(path.join(output, "shell-parser-licenses.txt"), notices.join("\n\n") + "\n")
await cp(path.join(targetDir, target, "release", library), path.join(output, library))
