// OpenTUI defaults to glibc. Compiled binaries must use their build target instead of the host environment.
export function tuiNativeDefines(target: { abi?: "musl" }) {
  return { "process.env.OPENTUI_LIBC": JSON.stringify(target.abi ?? "glibc") }
}
