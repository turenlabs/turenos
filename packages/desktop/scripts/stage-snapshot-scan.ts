#!/usr/bin/env bun
import { $ } from "bun"
import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { Platform } from "@turenlabs/script/platform"

const target = Platform.get()
const source = path.resolve(import.meta.dir, "../../core/native/snapshot-scan")
const destination = path.resolve(import.meta.dir, "../resources/snapshot-scan")
await rm(destination, { recursive: true, force: true })
if (target.platform !== process.platform || target.arch !== process.arch || target.platform === "win32") process.exit(0)

const cargo = Bun.which("rustup") ? ["rustup", "run", process.env.RUSTUP_TOOLCHAIN ?? "stable", "cargo"] : ["cargo"]
if (!Bun.which(cargo[0]!)) process.exit(0)
const env = {
  ...process.env,
  LIBGIT2_NO_VENDOR: "0",
  LIBZ_SYS_STATIC: "1",
  CARGO_TARGET_DIR: path.join(source, "target"),
}
const build = await $`${cargo} build --locked --release --target ${target.rustTarget}`.cwd(source).env(env).nothrow()
if (build.exitCode !== 0) {
  console.warn("Snapshot scanner build unavailable. Desktop will use Git.")
  process.exit(0)
}

const metadata: {
  packages: {
    name: string
    version: string
    manifest_path: string
    repository?: string
    license?: string
    source?: string
  }[]
} = await $`${cargo} metadata --locked --format-version=1 --filter-platform ${target.rustTarget}`.cwd(source).json()
const licenses = path.join(destination, "licenses")
await mkdir(licenses, { recursive: true })
await Promise.all(
  metadata.packages
    .filter((dependency) => dependency.source)
    .map(async (dependency) => {
      const directory = path.dirname(dependency.manifest_path)
      const output = path.join(licenses, `${dependency.name}-${dependency.version}`)
      await mkdir(output)
      const entries = (await readdir(directory)).filter((name) => /^(license|copying|notice)/i.test(name))
      if (dependency.name === "libgit2-sys")
        entries.push("libgit2/COPYING", "libgit2/AUTHORS", "libgit2/deps/pcre2/LICENCE.md")
      if (dependency.name === "libz-sys") entries.push("src/zlib/LICENSE")
      if (!entries.length) throw new Error(`Missing license text for ${dependency.name}`)
      await Promise.all(
        entries.map((name) => copyFile(path.join(directory, name), path.join(output, name.replaceAll("/", "-")))),
      )
      await Bun.write(
        path.join(output, "PROVENANCE.txt"),
        [dependency.name, dependency.version, dependency.license, dependency.repository, dependency.source]
          .filter(Boolean)
          .join("\n") + "\n",
      )
    }),
)
await copyFile(path.join(source, "snapshot-scan.gitconfig"), path.join(destination, "snapshot-scan.gitconfig"))
await copyFile(
  path.join(source, "target", target.rustTarget, "release", "turen-snapshot"),
  path.join(destination, "turen-snapshot"),
)
console.log(`Staged the snapshot scanner for ${target.rustTarget}`)
