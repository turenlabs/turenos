export * as ProcessEnv from "./process-env"

/**
 * Removes variables from `process.env` and from the native process environment.
 *
 * Under Bun, `delete process.env.X` leaves the native `environ` untouched. `bun-pty` starts from that
 * native copy and adds the caller's `env` on top, so a deleted secret comes back in every terminal.
 * `Bun.spawn` without an explicit `env` reads a copy taken at startup that `unsetenv` does not reach,
 * so spawn with `env: process.env` instead. Under Node, `delete process.env.X` already calls `unsetenv`, so nothing more is
 * needed. Windows under Bun is not handled: it keeps the `process.env` deletion only.
 *
 * Failing to reach libc is not an error; the `process.env` deletion has already happened.
 */
export function remove(names: readonly string[], libraries = defaultLibraries()) {
  names.forEach((name) => delete process.env[name])
  if (typeof Bun === "undefined" || libraries.length === 0) return
  try {
    // `bun:ffi` is only resolvable under Bun and this runs synchronously, so require it lazily.
    const { dlopen } = require("bun:ffi") as typeof import("bun:ffi")
    const library = libraries
      .flatMap((file) => {
        try {
          return [dlopen(file, { unsetenv: { args: ["cstring"], returns: "int" } })]
        } catch {
          return []
        }
      })
      .at(0)
    if (!library) return
    names.forEach((name) => library.symbols.unsetenv(Buffer.from(`${name}\0`)))
    library.close()
  } catch {}
}

function defaultLibraries() {
  if (process.platform === "darwin") return ["/usr/lib/libSystem.B.dylib"]
  if (process.platform !== "linux") return []
  const musl = process.arch === "arm64" ? "aarch64" : "x86_64"
  return ["libc.so.6", "libc.so", `libc.musl-${musl}.so.1`]
}
