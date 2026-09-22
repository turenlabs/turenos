import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"
import semver from "semver"

export const PRIVATE_REPOSITORY = "turenio/turen"
export const PUBLIC_REPOSITORY = "turenlabs/turenos"
export const HOMEBREW_REPOSITORY = "turenlabs/homebrew-turenos"
export const RELEASE_FINGERPRINT = "4A4B11E5E42582D722479A23FCADF0D9BC66D36C"


export type ReleaseAsset = { id: number; name: string; size: number; digest?: string | null; state?: string }
export type ReleaseManifest = {
  version: string
  commit: string
  assets: Array<{ name: string; size: number; sha256: string }>
}
export type VerifiedRelease = {
  manifest: ReleaseManifest
  hashes: Record<string, string>
  files: string[]
  bytes: number
}

const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*$(?![\s\S])/
const sha256 = /^[a-f0-9]{64}$(?![\s\S])/
const key = "RELEASE_SIGNING_KEY.asc"
const payloads = [
  ...["darwin", "windows"].flatMap((os) => ["arm64", "x64", "x64-baseline"].map((arch) => `forge-${os}-${arch}.zip`)),
  ...["arm64", "x64", "x64-baseline"].flatMap((arch) =>
    ["", "-musl"].map((libc) => `forge-linux-${arch}${libc}.tar.gz`),
  ),
  ...["arm64", "x64"].flatMap((arch) => [
    `latest-${arch}-mac.yml`,
    `latest-${arch}.yml`,
    arch === "arm64" ? "latest-arm64-linux-arm64.yml" : "latest-x64-linux.yml",
    ...["dmg", "zip"].flatMap((extension) => [
      `turenos-desktop-mac-${arch}.${extension}`,
      `turenos-desktop-mac-${arch}.${extension}.blockmap`,
    ]),
    `turenos-desktop-win-${arch}.exe`,
    `turenos-desktop-win-${arch}.exe.blockmap`,
    ...["AppImage", "deb", "rpm"].map((extension) => `turenos-desktop-linux-${arch}.${extension}`),
  ]),
]
const signedFiles = [...payloads, "release-manifest.json", "SHA256SUMS"]
const requiredFiles = [...signedFiles, ...signedFiles.map((name) => `${name}.asc`), key].sort()

export function validateVersion(value: string): string {
  assert.ok(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && semver.valid(value) === value,
    "Expected stable version X.Y.Z",
  )
  return value
}

export function releaseTagVersion(tag: string): string | undefined {
  if (!tag.startsWith("v")) return
  const version = tag.slice(1)
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) && semver.valid(version) === version
    ? version
    : undefined
}

export function compareReleaseVersions(left: string, right: string): number {
  return semver.compare(validateVersion(left), validateVersion(right))
}

export function assertPublicInventory(expected: readonly ReleaseAsset[], actual: readonly ReleaseAsset[]): void {
  const wanted = assetMap(expected)
  const found = assetMap(actual)
  assert.deepEqual([...found.keys()].sort(), [...wanted.keys()].sort(), "Release asset inventory mismatch")
  for (const [name, asset] of wanted) {
    assert.equal(found.get(name)!.size, asset.size, `Size mismatch: ${name}`)
    assert.equal(found.get(name)!.digest, asset.digest, `Digest mismatch: ${name}`)
  }
}

export function updateHomebrewFormula(formula: string, version: string, manifest: ReleaseManifest): string {
  validateVersion(version)
  assert.equal(manifest.version, version, "Manifest version mismatch")
  const platforms = [
    "forge-darwin-arm64.zip",
    "forge-darwin-x64-baseline.zip",
    "forge-linux-arm64.tar.gz",
    "forge-linux-x64-baseline.tar.gz",
  ]
  const assets = manifestMap(manifest)
  const seen = new Set<string>()
  const urls = [...formula.matchAll(/^\s*url\s+.*$/gm)]
  assert.equal(urls.length, 4, "Expected exactly four formula URLs")
  // Only replace adjacent URL/checksum literals; leave installation and platform logic untouched.
  const updated = formula.replace(
    /(^[ \t]*url ")([^"\r\n]+)("[ \t]*\r?\n[ \t]*sha256 ")([a-f0-9]{64})(")/gm,
    (whole, prefix: string, url: string, middle: string, hash: string, suffix: string) => {
      const parsed = /^https:\/\/github\.com\/turenlabs\/turenos\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(url)
      assert.ok(parsed, "Unknown formula URL")
      validateVersion(parsed[1]!)
      assert.ok(!semver.gt(parsed[1]!, version), "Refusing Homebrew downgrade")
      const name = parsed[2]!
      assert.ok(platforms.includes(name) && !seen.has(name), "Unknown or duplicate formula platform")
      seen.add(name)
      const asset = assets.get(name)
      assert.ok(asset, `Missing formula asset: ${name}`)
      return `${prefix}https://github.com/${PUBLIC_REPOSITORY}/releases/download/v${version}/${name}${middle}${asset.sha256}${suffix}`
    },
  )
  assert.equal(seen.size, 4, "Missing or malformed formula URL/checksum pair")
  for (const match of formula.matchAll(/^[ \t]*version\s+"([^"]+)"/gm)) {
    validateVersion(match[1]!)
    assert.ok(!semver.gt(match[1]!, version), "Refusing Homebrew downgrade")
  }
  return updated.replace(
    /(^[ \t]*version\s+")[^"]+("[ \t]*$)/gm,
    (_, prefix: string, suffix: string) => `${prefix}${version}${suffix}`,
  )
}

export async function verifyRelease(input: {
  directory: string
  version: string
  source: string
  assets: readonly ReleaseAsset[]
  gnupgHome: string
}): Promise<VerifiedRelease> {
  validateVersion(input.version)
  assert.match(input.source, /^[a-f0-9]{40}$(?![\s\S])/, "Expected full source commit")
  const assets = assetMap(input.assets)
  assert.deepEqual([...assets.keys()].sort(), requiredFiles, "Required release inventory mismatch")
  const directory = path.resolve(input.directory)
  assert.ok((await lstat(directory)).isDirectory(), "Release directory must not be a symlink")
  const files = (await readdir(directory)).sort()
  assert.deepEqual(files, requiredFiles, "Disk inventory mismatch")
  const hashes: Record<string, string> = Object.create(null)
  for (const name of files) {
    const file = path.join(directory, name)
    const stat = await lstat(file)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Not a regular file: ${name}`)
    assert.equal(stat.size, assets.get(name)!.size, `Size mismatch: ${name}`)
    const limit = name.endsWith(".asc")
      ? 64 * 1024
      : ["release-manifest.json", "SHA256SUMS"].includes(name)
        ? 1024 * 1024
        : Infinity
    assert.ok(stat.size <= limit, `Release metadata exceeds size limit: ${name}`)
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    hashes[name] = hash.digest("hex")
    assert.equal(assets.get(name)!.digest, `sha256:${hashes[name]}`, `API digest mismatch: ${name}`)
  }
  const manifest: ReleaseManifest = await Bun.file(path.join(directory, "release-manifest.json")).json()
  assert.equal(manifest.version, input.version, "Manifest version mismatch")
  assert.equal(manifest.commit, input.source, "Manifest source mismatch")
  const entries = manifestMap(manifest)
  assert.deepEqual([...entries.keys()].sort(), [...payloads, key].sort(), "Manifest membership mismatch")
  for (const [name, asset] of entries) {
    assert.equal(asset.size, assets.get(name)!.size, `Manifest size mismatch: ${name}`)
    assert.equal(asset.sha256, hashes[name], `Manifest hash mismatch: ${name}`)
  }
  const checksums = new Map<string, string>()
  const text = await Bun.file(path.join(directory, "SHA256SUMS")).text()
  for (const line of text.replace(/\r?\n$/, "").split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line)
    assert.ok(match, "Invalid checksum entry")
    assert.ok(!checksums.has(match[2]!), "Duplicate checksum entry")
    checksums.set(match[2]!, match[1]!)
  }
  assert.deepEqual(
    [...checksums.keys()].sort(),
    [...payloads, key, "release-manifest.json"].sort(),
    "Checksum membership mismatch",
  )
  for (const [name, hash] of checksums) assert.equal(hash, hashes[name], `Checksum mismatch: ${name}`)

  await verifySignatures(
    input.gnupgHome,
    path.join(directory, key),
    signedFiles.map((name) => ({
      file: path.join(directory, name),
      signature: path.join(directory, `${name}.asc`),
    })),
  )
  return { manifest, hashes, files, bytes: input.assets.reduce((total, asset) => total + asset.size, 0) }
}

export async function verifySignedManifest(input: {
  file: string
  signature: string
  keyFile: string
  gnupgHome: string
}): Promise<ReleaseManifest> {
  for (const file of [input.file, input.signature, input.keyFile]) {
    const stat = await lstat(file)
    assert.ok(stat.isFile(), "Signed manifest inputs must be regular files")
    assert.ok(stat.size <= (file === input.file ? 1024 * 1024 : 64 * 1024), "Release metadata exceeds size limit")
  }
  const manifest: ReleaseManifest = await Bun.file(input.file).json()
  manifestMap(manifest)
  validateVersion(manifest.version)
  assert.match(manifest.commit, /^[a-f0-9]{40}$(?![\s\S])/, "Expected full manifest source commit")
  await verifySignatures(input.gnupgHome, path.resolve(input.keyFile), [
    {
      file: path.resolve(input.file),
      signature: path.resolve(input.signature),
    },
  ])
  return manifest
}

async function verifySignatures(
  gnupgHome: string,
  keyFile: string,
  files: readonly { file: string; signature: string }[],
) {
  // Never reuse a user's keyring or configuration, even when gnupgHome already exists.
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 })
  const home = await mkdtemp(path.join(path.resolve(gnupgHome), "verify-"))
  try {
    const publicKey = await Bun.file(keyFile).text()
    assert.ok(
      publicKey.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") && !publicKey.includes("PRIVATE KEY"),
      "Expected public signing key only",
    )
    const preview = await gpg(home, ["--with-colons", "--import-options", "show-only", "--import", keyFile])
    assert.equal(
      preview.split("\n").filter((line) => line.startsWith("pub:")).length,
      1,
      "Expected one public signing key",
    )
    assert.ok(!/^(sec|ssb):/m.test(preview), "Secret key material is forbidden")
    assert.equal(
      preview
        .split("\n")
        .find((line) => line.startsWith("fpr:"))
        ?.split(":")[9],
      RELEASE_FINGERPRINT,
      "Wrong signing key fingerprint",
    )
    await gpg(home, ["--import", keyFile])
    for (const entry of files) {
      const status = await gpg(home, ["--status-fd", "1", "--verify", entry.signature, entry.file])
      assert.ok(
        status.split("\n").some((line) => line.startsWith(`[GNUPG:] VALIDSIG ${RELEASE_FINGERPRINT} `)),
        "Wrong signature key",
      )
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

function assetMap(assets: readonly ReleaseAsset[]) {
  const result = new Map<string, ReleaseAsset>()
  for (const asset of assets) {
    assert.match(asset.name, filename, "Unsafe asset name")
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, "Invalid asset size")
    assert.equal(asset.state, "uploaded", "Asset is not uploaded")
    assert.ok(
      typeof asset.digest === "string" && asset.digest.startsWith("sha256:") && sha256.test(asset.digest.slice(7)),
      "Missing or invalid API digest",
    )
    assert.ok(!result.has(asset.name), "Duplicate asset name")
    result.set(asset.name, asset)
  }
  return result
}

function manifestMap(manifest: ReleaseManifest) {
  assert.ok(manifest && Array.isArray(manifest.assets), "Invalid release manifest")
  const result = new Map<string, ReleaseManifest["assets"][number]>()
  for (const asset of manifest.assets) {
    assert.match(asset.name, filename, "Unsafe manifest name")
    assert.match(asset.sha256, sha256, "Invalid manifest hash")
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, "Invalid manifest size")
    assert.ok(!result.has(asset.name), "Duplicate manifest asset")
    result.set(asset.name, asset)
  }
  return result
}

async function gpg(home: string, args: string[]) {
  const executable = Bun.which("gpg") ?? "gpg"
  const candidate = process.platform === "win32" ? path.join(path.dirname(executable), "cygpath.exe") : undefined
  const converter = candidate && (await Bun.file(candidate).exists()) ? candidate : undefined
  // Git for Windows ships an MSYS GPG. Native Gpg4win needs no translation.
  const convert = (value: string) => {
    if (!converter || !path.isAbsolute(value)) return value
    const result = Bun.spawnSync([converter, "-u", value], {
      env: { PATH: process.env.PATH, LC_ALL: "C" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    assert.equal(result.exitCode, 0, "GPG path conversion failed")
    return result.stdout.toString().trim()
  }
  const keyring = convert(home)
  const child = Bun.spawn(
    [
      executable,
      "--no-options",
      "--homedir",
      keyring,
      "--batch",
      "--no-tty",
      "--no-auto-key-retrieve",
      ...args.map(convert),
    ],
    {
      env: { PATH: process.env.PATH, GNUPGHOME: keyring, LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000)
  try {
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    assert.equal(exit, 0, `GPG release verification failed or timed out: ${error.slice(-2000)}`)
    return output
  } finally {
    clearTimeout(timeout)
  }
}
