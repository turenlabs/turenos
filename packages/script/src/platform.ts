export * as Platform from "./platform"

export const targets = [
  { rustTarget: "aarch64-apple-darwin", platform: "darwin", arch: "arm64", bun: "darwin-aarch64" },
  { rustTarget: "x86_64-apple-darwin", platform: "darwin", arch: "x64", bun: "darwin-x64-baseline" },
  { rustTarget: "aarch64-pc-windows-msvc", platform: "win32", arch: "arm64", bun: "windows-aarch64" },
  { rustTarget: "x86_64-pc-windows-msvc", platform: "win32", arch: "x64", bun: "windows-x64-baseline" },
  { rustTarget: "x86_64-unknown-linux-gnu", platform: "linux", arch: "x64", bun: "linux-x64-baseline" },
  { rustTarget: "aarch64-unknown-linux-gnu", platform: "linux", arch: "arm64", bun: "linux-aarch64" },
] as const

export function get(rustTarget = process.env.RUST_TARGET) {
  const target = targets.find((item) =>
    rustTarget ? item.rustTarget === rustTarget : item.platform === process.platform && item.arch === process.arch,
  )
  if (!target) throw new Error(`Unsupported runtime target: ${rustTarget ?? `${process.platform}/${process.arch}`}`)
  return target
}
