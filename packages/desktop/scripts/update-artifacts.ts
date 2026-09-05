import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"
import { Schema } from "effect"

const Manifest = Schema.Struct({
  version: Schema.String,
  files: Schema.Array(
    Schema.Struct({ url: Schema.String, sha512: Schema.String, size: Schema.optional(Schema.Number) }),
  ),
  path: Schema.String,
  sha512: Schema.String,
})

export const updateFeeds = [
  { name: "latest-x64-mac.yml", artifact: "turenos-desktop-mac-x64.zip", blockmap: true },
  { name: "latest-arm64-mac.yml", artifact: "turenos-desktop-mac-arm64.zip", blockmap: true },
  { name: "latest-x64.yml", artifact: "turenos-desktop-win-x64.exe", blockmap: true },
  { name: "latest-arm64.yml", artifact: "turenos-desktop-win-arm64.exe", blockmap: true },
  { name: "latest-x64-linux.yml", artifact: "turenos-desktop-linux-x64.AppImage", blockmap: false },
  { name: "latest-arm64-linux-arm64.yml", artifact: "turenos-desktop-linux-arm64.AppImage", blockmap: false },
] as const

export async function verifyUpdateArtifacts(directory: string, version: string) {
  for (const feed of updateFeeds) {
    const manifest = Schema.decodeUnknownSync(Manifest)(
      Bun.YAML.parse(await Bun.file(path.join(directory, feed.name)).text()),
    )
    if (manifest.version !== version) throw new Error(`${feed.name}: expected version ${version}`)
    const required = feed.artifact.endsWith(".AppImage")
      ? ["AppImage", "deb", "rpm"].map((extension) => feed.artifact.replace(/AppImage$/, extension))
      : [feed.artifact]
    for (const artifact of required) {
      if (!manifest.files.some((file) => file.url === artifact)) throw new Error(`${feed.name}: missing ${artifact}`)
    }
    if (!manifest.files.some((file) => file.url === manifest.path && file.sha512 === manifest.sha512)) {
      throw new Error(`${feed.name}: legacy path/checksum does not match files`)
    }
    for (const file of manifest.files) {
      // Release assets are flat filenames, never arbitrary paths or external URLs.
      if (
        !/^turenos-desktop-[a-z0-9-]+\.(zip|dmg|exe|AppImage|deb|rpm)$/.test(file.url) ||
        !file.url.startsWith(`${feed.artifact.slice(0, feed.artifact.lastIndexOf("."))}.`)
      ) {
        throw new Error(`${feed.name}: invalid asset ${file.url}`)
      }
      const asset = Bun.file(path.join(directory, file.url))
      if (!(await asset.exists()) || !asset.size || (file.size !== undefined && asset.size !== file.size)) {
        throw new Error(`${feed.name}: missing or incorrect size for ${file.url}`)
      }
      const hash = createHash("sha512")
      for await (const chunk of createReadStream(path.join(directory, file.url))) hash.update(chunk)
      if (hash.digest("base64") !== file.sha512) throw new Error(`${feed.name}: checksum mismatch for ${file.url}`)
    }
    if (feed.blockmap) {
      const blockmap = Bun.file(path.join(directory, `${feed.artifact}.blockmap`))
      if (!(await blockmap.exists()) || !blockmap.size) throw new Error(`${feed.name}: missing blockmap`)
    }
  }
}

if (import.meta.main) {
  const [directory, version] = process.argv.slice(2)
  if (!directory || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("Usage: bun packages/desktop/scripts/update-artifacts.ts <directory> <version>")
  }
  await verifyUpdateArtifacts(directory, version)
  console.log(`Verified ${updateFeeds.length} Desktop update feeds for ${version}`)
}
