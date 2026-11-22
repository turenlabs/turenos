import { chmod } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const output = "src/components/markdown-links.wasm"
const build = Bun.spawn(
  [
    "rustup",
    "run",
    "1.97.1",
    "rustc",
    "--edition",
    "2021",
    "--target",
    "wasm32-unknown-unknown",
    "--crate-type",
    "cdylib",
    "-C",
    "opt-level=3",
    "-C",
    "lto=fat",
    "-C",
    "panic=abort",
    "-C",
    "strip=symbols",
    "rust/markdown-links.rs",
    "-o",
    output,
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
)
const status = await build.exited
if (status !== 0) process.exit(status)
await chmod(path.join(root, output), 0o644)
