import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertMirrorDiff,
  assertPublicInventory,
  MIRROR_EXCLUSIONS,
  updateHomebrewFormula,
  validateVersion,
  verifyRelease,
  verifySignedManifest,
  type ReleaseAsset,
  type ReleaseManifest,
} from "../src/release"

const version = "1.0.11"
const source = "a".repeat(40)
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const platforms = [
  "forge-darwin-arm64.zip",
  "forge-darwin-x64-baseline.zip",
  "forge-linux-arm64.tar.gz",
  "forge-linux-x64-baseline.tar.gz",
]
const manifest: ReleaseManifest = {
  version,
  commit: source,
  assets: platforms.map((name) => ({ name, size: 10, sha256: digest(name) })),
}
const formula = `class Turenos < Formula
  desc "Keep this unchanged"
  version "1.0.10"
${platforms.map((name) => `  url "https://github.com/turenlabs/turenos/releases/download/v1.0.10/${name}"\n  sha256 "${"0".repeat(64)}"`).join("\n")}
  def install
    bin.install "forge" => "turen"
  end
end
`

describe("release support", () => {
  test("accepts stable versions only", () => {
    expect(validateVersion(version)).toBe(version)
    for (const value of [
      "v1.0.11",
      "01.0.11",
      "1.0",
      "1.0.11-rc.1",
      "1.0.11+build",
      "../1.0.11",
      "1.0.11;id",
      "1.0.11\n",
      " 1.0.11",
      "999999999999999999.0.1",
    ]) {
      expect(() => validateVersion(value)).toThrow()
    }
  })
  test("mirror diff allows exactly six deletions, in either order", () => {
    const diff = MIRROR_EXCLUSIONS.map((name) => `D\t${name}`).join("\n")
    expect(() => assertMirrorDiff(`${diff}\n`)).not.toThrow()
    expect(() => assertMirrorDiff(diff.split("\n").reverse().join("\n"))).not.toThrow()
    for (const value of [
      "",
      diff.replace("D\t", "M\t"),
      `${diff}\nD\tother`,
      diff.split("\n").slice(1).join("\n"),
      `${diff}\n${diff}`,
      `${diff}\n\n`,
    ]) {
      expect(() => assertMirrorDiff(value)).toThrow()
    }
  })
  test("public inventory compares all metadata and rejects ambiguous assets", () => {
    const asset: ReleaseAsset = { name: "forge.zip", size: 2, digest: `sha256:${digest("ok")}`, state: "uploaded" }
    expect(() => assertPublicInventory([asset], [{ ...asset }])).not.toThrow()
    for (const actual of [
      [],
      [asset, asset],
      [{ ...asset, size: 3 }],
      [{ ...asset, digest: null }],
      [{ ...asset, digest: `sha256:${digest("no")}` }],
      [{ ...asset, state: "new" }],
      [{ ...asset, name: "../forge.zip" }],
      [{ ...asset, name: "a\\b" }],
      [{ ...asset, name: "a\n" }],
    ]) {
      expect(() => assertPublicInventory([asset], actual)).toThrow()
    }
    expect(() => assertPublicInventory([asset, asset], [asset])).toThrow()
    expect(() => assertPublicInventory([asset], [{ ...asset, state: undefined }])).toThrow("Asset is not uploaded")
    expect(() => assertPublicInventory([{ ...asset, state: undefined }], [asset])).toThrow("Asset is not uploaded")
    expect(() => assertPublicInventory([{ ...asset, digest: undefined }], [asset])).toThrow()
  })
  test("Homebrew update is surgical and same-version idempotent", () => {
    const updated = updateHomebrewFormula(formula, version, manifest)
    expect(updated).toBe(
      platforms.reduce(
        (value, name) => value.replace(`sha256 "${"0".repeat(64)}"`, `sha256 "${digest(name)}"`),
        formula.replaceAll("1.0.10", version),
      ),
    )
    expect(updateHomebrewFormula(updated, version, manifest)).toBe(updated)
  })
  test("Homebrew rejects downgrade, unknown, duplicate, absent and malformed URLs", () => {
    for (const value of [
      formula.replaceAll("1.0.10", "1.0.12"),
      formula.replace(platforms[0]!, "unknown.zip"),
      formula.replace(platforms[0]!, platforms[1]!),
      formula.replace(/^  url.*\n/m, ""),
      formula.replace("sha256", "sha512"),
      formula.replace("https://github.com", "https://evil.example"),
    ]) {
      expect(() => updateHomebrewFormula(value, version, manifest)).toThrow()
    }
    expect(() => updateHomebrewFormula(formula, version, { ...manifest, assets: manifest.assets.slice(1) })).toThrow()
    expect(() => updateHomebrewFormula(formula, version, { ...manifest, version: "1.0.12" })).toThrow()
  })
})

// Small independent fixtures exercise the complete inventory/hash path without any release downloads or signing keys.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-test-"))
  roots.push(root)
  const directory = path.join(root, "assets")
  await mkdir(directory)
  const contents = new Map<string, string>()
  for (const os of ["darwin", "windows", "linux"]) {
    for (const arch of ["arm64", "x64", "x64-baseline"]) {
      contents.set(`forge-${os}-${arch}.${os === "linux" ? "tar.gz" : "zip"}`, "payload")
      if (os === "linux") contents.set(`forge-linux-${arch}-musl.tar.gz`, "payload")
    }
  }
  for (const arch of ["arm64", "x64"]) {
    for (const suffix of ["-mac", "", arch === "arm64" ? "-linux-arm64" : "-linux"])
      contents.set(`latest-${arch}${suffix}.yml`, "feed")
    for (const extension of ["dmg", "zip"]) {
      contents.set(`turenos-desktop-mac-${arch}.${extension}`, "desktop")
      contents.set(`turenos-desktop-mac-${arch}.${extension}.blockmap`, "blockmap")
    }
    contents.set(`turenos-desktop-win-${arch}.exe`, "desktop")
    contents.set(`turenos-desktop-win-${arch}.exe.blockmap`, "blockmap")
    for (const extension of ["AppImage", "deb", "rpm"])
      contents.set(`turenos-desktop-linux-${arch}.${extension}`, "desktop")
  }
  expect(contents.size).toBe(36)
  contents.set("RELEASE_SIGNING_KEY.asc", "invalid public key")
  const data: ReleaseManifest = {
    version,
    commit: source,
    assets: [...contents].map(([name, value]) => ({ name, size: Buffer.byteLength(value), sha256: digest(value) })),
  }
  contents.set("release-manifest.json", JSON.stringify(data))
  contents.set("SHA256SUMS", [...contents].map(([name, value]) => `${digest(value)}  ${name}\n`).join(""))
  for (const name of [...contents.keys()]) {
    if (name !== "RELEASE_SIGNING_KEY.asc") contents.set(`${name}.asc`, "signature")
  }
  const assets: ReleaseAsset[] = [...contents].map(([name, value]) => ({
    name,
    size: Buffer.byteLength(value),
    digest: `sha256:${digest(value)}`,
    state: "uploaded",
  }))
  await Promise.all([...contents].map(([name, value]) => Bun.write(path.join(directory, name), value)))
  const input = { directory, version, source, assets, gnupgHome: path.join(root, "gnupg") }
  const rewrite = async (name: string, value: string) => {
    await Bun.write(path.join(directory, name), value)
    Object.assign(assets.find((asset) => asset.name === name)!, {
      size: Buffer.byteLength(value),
      digest: `sha256:${digest(value)}`,
    })
  }
  return { input, data, contents, rewrite }
}

describe("release disk verification", () => {
  test.skipIf(!Bun.which("gpg"))("verifies a real published signature and rejects changed signed bytes", async () => {
    const root = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "release-gpg-test-"))
    roots.push(root)
    const fixture = path.join(import.meta.dir, "fixtures", "release-1.0.11")
    const input = {
      file: path.join(fixture, "release-manifest.json"),
      signature: path.join(fixture, "release-manifest.json.asc"),
      keyFile: path.join(fixture, "RELEASE_SIGNING_KEY.asc"),
      gnupgHome: root,
    }
    expect(await verifySignedManifest(input)).toMatchObject({
      version: "1.0.11",
      commit: "eac7dbe7a9919592f2399c1f4515906b8ef6845c",
    })
    const altered = path.join(root, "altered.json")
    await Bun.write(altered, `${await Bun.file(input.file).text()}\n`)
    await expect(verifySignedManifest({ ...input, file: altered })).rejects.toThrow("GPG release verification failed")
  })
  test("bounds release metadata before parsing or GPG", async () => {
    for (const name of [
      "release-manifest.json",
      "SHA256SUMS",
      "RELEASE_SIGNING_KEY.asc",
      "release-manifest.json.asc",
    ]) {
      const { input, rewrite } = await fixture()
      await rewrite(name, "x".repeat((name.endsWith(".asc") ? 64 * 1024 : 1024 * 1024) + 1))
      await expect(verifyRelease(input)).rejects.toThrow("Release metadata exceeds size limit")
      if (name === "SHA256SUMS") continue
      await expect(
        verifySignedManifest({
          file: path.join(input.directory, "release-manifest.json"),
          signature: path.join(input.directory, "release-manifest.json.asc"),
          keyFile: path.join(input.directory, "RELEASE_SIGNING_KEY.asc"),
          gnupgHome: input.gnupgHome,
        }),
      ).rejects.toThrow("Release metadata exceeds size limit")
    }
  })
  test("standalone manifest verification rejects malformed metadata and untrusted keys", async () => {
    const { input, data, rewrite } = await fixture()
    const request = {
      file: path.join(input.directory, "release-manifest.json"),
      signature: path.join(input.directory, "release-manifest.json.asc"),
      keyFile: path.join(input.directory, "RELEASE_SIGNING_KEY.asc"),
      gnupgHome: input.gnupgHome,
    }
    await expect(verifySignedManifest(request)).rejects.toThrow("Expected public signing key only")
    await rewrite("release-manifest.json", JSON.stringify({ ...data, commit: "HEAD" }))
    await expect(verifySignedManifest(request)).rejects.toThrow("Expected full manifest source commit")
    await rewrite("release-manifest.json", JSON.stringify({ ...data, version: "1.0.11-rc.1" }))
    await expect(verifySignedManifest(request)).rejects.toThrow("Expected stable version")
    await rewrite("release-manifest.json", JSON.stringify({ ...data, assets: [data.assets[0], data.assets[0]] }))
    await expect(verifySignedManifest(request)).rejects.toThrow("Duplicate manifest asset")
    await rewrite("release-manifest.json", "null")
    await expect(verifySignedManifest(request)).rejects.toThrow("Invalid release manifest")
    await rm(request.signature)
    await mkdir(request.signature)
    await expect(verifySignedManifest(request)).rejects.toThrow("must be regular files")
  })
  test("complete 77-file fixture reaches public-key validation, not a signing operation", async () => {
    const { input } = await fixture()
    expect(input.assets).toHaveLength(77)
    await expect(verifyRelease(input)).rejects.toThrow("Expected public signing key only")
  })
  test("rejects missing and extra API or disk files", async () => {
    const { input } = await fixture()
    await expect(verifyRelease({ ...input, assets: input.assets.slice(1) })).rejects.toThrow(
      "Required release inventory",
    )
    await Bun.write(path.join(input.directory, "extra"), "extra")
    await expect(verifyRelease(input)).rejects.toThrow("Disk inventory")
    await rm(path.join(input.directory, "extra"))
    await rm(path.join(input.directory, input.assets[0]!.name))
    await expect(verifyRelease(input)).rejects.toThrow("Disk inventory")
  })
  test("rejects payload and signature byte tampering", async () => {
    for (const name of ["forge-darwin-arm64.zip", "SHA256SUMS.asc"]) {
      const { input } = await fixture()
      await Bun.write(path.join(input.directory, name), name.endsWith(".asc") ? "SIGNATURE" : "PAYLOAD")
      await expect(verifyRelease(input)).rejects.toThrow("API digest mismatch")
    }
  })
  test("rejects directories and symlinks even with exact filenames", async () => {
    const { input } = await fixture()
    const file = path.join(input.directory, input.assets[0]!.name)
    await rm(file)
    await mkdir(file)
    await expect(verifyRelease(input)).rejects.toThrow("Not a regular file")
    await rm(file, { recursive: true })
    // Windows CI may not grant symlink creation; regular-directory coverage still runs there.
    if (process.platform === "win32") return
    await symlink(path.join(input.directory, "SHA256SUMS"), file)
    await expect(verifyRelease(input)).rejects.toThrow("Not a regular file")
  })
  test("rejects wrong version/source before trusting manifest", async () => {
    const { input } = await fixture()
    await expect(verifyRelease({ ...input, version: "1.0.12" })).rejects.toThrow("Manifest version")
    await expect(verifyRelease({ ...input, source: "b".repeat(40) })).rejects.toThrow("Manifest source")
    await expect(verifyRelease({ ...input, source: "HEAD" })).rejects.toThrow("Expected full source")
  })
  test("rejects manifest membership, unsafe names, sizes and hashes despite matching API digests", async () => {
    for (const change of ["missing", "duplicate", "unsafe", "size", "hash"]) {
      const { input, data, rewrite } = await fixture()
      if (change === "missing") data.assets.pop()
      if (change === "duplicate") data.assets.push(data.assets[0]!)
      if (change === "unsafe") data.assets[0]!.name = "../escape"
      if (change === "size") data.assets[0]!.size++
      if (change === "hash") data.assets[0]!.sha256 = "0".repeat(64)
      await rewrite("release-manifest.json", JSON.stringify(data))
      await expect(verifyRelease(input)).rejects.toThrow()
    }
  })
  test("rejects missing, duplicate, malformed and tampered checksum entries", async () => {
    for (const change of ["missing", "duplicate", "unsafe", "hash"]) {
      const { input, contents, rewrite } = await fixture()
      const lines = contents.get("SHA256SUMS")!.trimEnd().split("\n")
      if (change === "missing") lines.pop()
      if (change === "duplicate") lines.push(lines[0]!)
      if (change === "unsafe") lines[0] = `${"0".repeat(64)}  ../escape`
      if (change === "hash") lines[0] = lines[0]!.replace(/^[a-f0-9]{64}/, "0".repeat(64))
      await rewrite("SHA256SUMS", `${lines.join("\n")}\n`)
      await expect(verifyRelease(input)).rejects.toThrow()
    }
  })
})
