import fs from "node:fs/promises"
import path from "node:path"

const targets = {
  "darwin-arm64": "vigil-compact-darwin-arm64",
  "darwin-x64": "vigil-compact-darwin-amd64",
  "linux-arm64": "vigil-compact-linux-arm64",
  "linux-x64": "vigil-compact-linux-amd64",
  "linux-arm64-musl": "vigil-compact-linux-arm64-musl",
  "linux-x64-musl": "vigil-compact-linux-amd64-musl",
  "win32-arm64": "vigil-compact-windows-arm64",
  "win32-x64": "vigil-compact-windows-amd64",
} as const

export async function stageVigil(
  target: { os: string; arch: "arm64" | "x64"; abi?: string },
  destination: string,
) {
  const name = targets[
    `${target.os}-${target.arch}${target.abi === "musl" ? "-musl" : ""}` as keyof typeof targets
  ]
  if (!name) throw new Error(`Vigil runtime is unavailable for ${target.os}/${target.arch}`)

  const archive = path.join(import.meta.dirname, "../../vigil-runtime/runtime", `${name}.tar.gz`)
  const expected = (await Bun.file(path.join(import.meta.dirname, "../../vigil-runtime/SHA256SUMS")).text())
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(`runtime/${name}.tar.gz`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`Vigil checksum is missing for ${name}`)

  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).bytes()).digest("hex")
  if (digest !== expected) throw new Error(`Vigil checksum mismatch for ${name}`)

  const staging = `${destination}.staging-${crypto.randomUUID()}`
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  try {
    await new Bun.Archive(await Bun.file(archive).bytes()).extract(staging)
    await fs.rm(destination, { recursive: true, force: true })
    await fs.cp(path.join(staging, name), destination, { recursive: true })
    const checksums = (await Bun.file(path.join(destination, "SHA256SUMS")).text())
      .split("\n")
      .flatMap((line) => {
        const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/)
        return match ? [{ digest: match[1], file: match[2] }] : []
      })
    if (checksums.length === 0) throw new Error(`Vigil package checksums are missing for ${name}`)
    for (const item of checksums) {
      if (path.basename(item.file) !== item.file) throw new Error(`Unsafe Vigil package path: ${item.file}`)
      const digest = new Bun.CryptoHasher("sha256")
        .update(await Bun.file(path.join(destination, item.file)).bytes())
        .digest("hex")
      if (digest !== item.digest) throw new Error(`Vigil package checksum mismatch: ${item.file}`)
    }
    await fs.chmod(path.join(destination, target.os === "win32" ? "vigil-compact.exe" : "vigil-compact"), 0o755)
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}
