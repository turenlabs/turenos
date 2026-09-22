#!/usr/bin/env bun
import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import {
  PRIVATE_REPOSITORY,
  PUBLIC_REPOSITORY,
  HOMEBREW_REPOSITORY,
  RELEASE_FINGERPRINT,
  assertPublicInventory,
  updateHomebrewFormula,
  validateVersion,
  releaseTagVersion,
  compareReleaseVersions,
  verifyRelease,
  verifySignedManifest,
  type ReleaseAsset,
} from "../packages/script/src/release"
import { verifyUpdateArtifacts, updateFeeds } from "../packages/desktop/scripts/update-artifacts"

type Release = {
  id: number
  tag_name: string
  draft: boolean
  prerelease: boolean
  target_commitish: string
  assets: ReleaseAsset[]
}
type Repository = { full_name: string; private: boolean; default_branch: string }
type Contents = { type: string; content: string; encoding: string; sha: string }

export function assertNotDowngrade(version: string, releases: readonly Release[]) {
  const newer = releases.find((release) => {
    const current = releaseTagVersion(release.tag_name)
    return (
      !release.draft && !release.prerelease && current !== undefined && compareReleaseVersions(current, version) > 0
    )
  })
  if (newer) throw new Error(`Refusing to publish ${version} over ${newer.tag_name}`)
}

export function previousRelease(version: string, releases: readonly Release[]) {
  return releases
    .filter((release) => {
      const current = releaseTagVersion(release.tag_name)
      return (
        !release.draft && !release.prerelease && current !== undefined && compareReleaseVersions(current, version) < 0
      )
    })
    .toSorted((left, right) => compareReleaseVersions(right.tag_name.slice(1), left.tag_name.slice(1)))[0]
}



async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: "string" },
      source: { type: "string" },
      preflight: { type: "boolean", default: false },
      "publish-existing": { type: "boolean", default: false },
      "verify-only": { type: "boolean", default: false },
    },
    strict: true,
  }).values
  const version = validateVersion(args.version ?? "")
  const tag = `v${version}`
  const verifyOnly = args["verify-only"]
  const privateToken = process.env.PRIVATE_GH_TOKEN ?? process.env.GH_TOKEN
  const publicToken = process.env.PUBLIC_RELEASE_TOKEN ?? (verifyOnly ? privateToken : undefined)
  if (!privateToken) throw new Error("PRIVATE_GH_TOKEN (or GH_TOKEN) is required for private release reads")
  if (!verifyOnly) {
    assert.equal(
      process.env.GITHUB_REPOSITORY,
      PRIVATE_REPOSITORY,
      "Publishing must run in the private GitHub repository",
    )
    if (!publicToken?.startsWith("github_pat_"))
      throw new Error("Configure PUBLIC_RELEASE_TOKEN with a dedicated fine-grained token")
  }
  const root = process.cwd()

  // Credentials stay in child environments, never command arguments or Git config files.
  const environment = (token?: string) => ({
    ...process.env,
    GH_TOKEN: token ?? "",
    GITHUB_TOKEN: "",
    GH_DEBUG: "",
    GIT_TRACE: "",
    GIT_CURL_VERBOSE: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: token
      ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
      : "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_AUTHOR_NAME: "github-actions[bot]",
    GIT_COMMITTER_NAME: "github-actions[bot]",
    GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  })
  const run = (command: string[], token?: string, extra?: Record<string, string>) => {
    const result = Bun.spawnSync(command, {
      cwd: root,
      env: { ...environment(token), ...extra },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20 * 60_000,
    })
    if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString().slice(-4000)}`)
    return result.stdout.toString().trim()
  }
  const git = (args: string[], token?: string, extra?: Record<string, string>) => run(["git", ...args], token, extra)
  const isAncestor = (commit: string, descendant: string) =>
    Bun.spawnSync(["git", "merge-base", "--is-ancestor", commit, descendant], {
      cwd: root,
      env: environment(),
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  const api = async <T>(repository: string, endpoint: string, method = "GET", body?: unknown): Promise<T> => {
    if (verifyOnly && method !== "GET") throw new Error("Verify-only mode forbids remote mutations")
    const token = repository === PRIVATE_REPOSITORY ? privateToken : publicToken
    const response = await fetch(`https://api.github.com/repos/${repository}${endpoint ? `/${endpoint}` : ""}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`${method} ${repository}/${endpoint} returned HTTP ${response.status}`)
    return (await response.json()) as T
  }
  const releases = async (repository: string) => {
    const result: Release[] = []
    for (let page = 1; page <= 100; page++) {
      const batch = await api<Release[]>(repository, `releases?per_page=100&page=${page}`)
      assert.ok(Array.isArray(batch), "Invalid release list")
      result.push(...batch)
      if (batch.length < 100) return result
    }
    throw new Error("Release history exceeds the bounded lookup; refusing ambiguous publication")
  }
  const validateRepository = async (repository: string, isPrivate: boolean) => {
    const info = await api<Repository>(repository, "")
    assert.equal(info.full_name, repository)
    assert.equal(info.private, isPrivate)
    if (!isPrivate) assert.equal(info.default_branch, "main")
    if (!isPrivate && !verifyOnly) {
      const ref = `refs/remotes/release-access/${repository.replace("/", "-")}`
      const remote = `https://github.com/${repository}.git`
      git(["fetch", "--no-tags", remote, `+refs/heads/main:${ref}`], publicToken)
      // Probe write authentication with the target's own existing commit.
      git(["push", "--dry-run", remote, `${ref}:refs/heads/main`], publicToken)
    }
    return info
  }
  const download = (repository: string, release: Release, directory: string) => {
    assert.equal(release.tag_name, tag)
    assertPublicInventory(release.assets, release.assets)
    run(
      ["gh", "release", "download", tag, "--repo", repository, "--dir", directory],
      repository === PRIVATE_REPOSITORY ? privateToken : publicToken,
    )
  }
  const fetchRef = (ref: string, destination: string) => {
    git(["fetch", "--no-tags", `https://github.com/${PUBLIC_REPOSITORY}.git`, `+${ref}:${destination}`], publicToken)
    return git(["rev-parse", `${destination}^{commit}`])
  }
  const publicTag = () => {
    const remote = git(["ls-remote", `https://github.com/${PUBLIC_REPOSITORY}.git`, `refs/tags/${tag}`], publicToken)
    if (!remote) return undefined
    return fetchRef(`refs/tags/${tag}`, "refs/remotes/release-public/target")
  }
  const privateInfo = await validateRepository(PRIVATE_REPOSITORY, true)
  await validateRepository(PUBLIC_REPOSITORY, false)
  await validateRepository(HOMEBREW_REPOSITORY, false)
  if (!verifyOnly)
    assert.equal(
      process.env.GITHUB_REF,
      `refs/heads/${privateInfo.default_branch}`,
      "Publishing must run from the private default branch",
    )

  // The public repository owns release history. The release source is the
  // public main commit whose VERSION matches, or an already-created release
  // target/tag for --publish-existing and verification.
  const head = fetchRef("refs/heads/main", "refs/remotes/release-public/main")
  const published = await releases(PUBLIC_REPOSITORY)
  const existing = published.find((release) => release.tag_name === tag)
  const existingTagSha = publicTag()
  const source =
    args.source ??
    existingTagSha ??
    existing?.target_commitish ??
    (() => {
      if (args["publish-existing"]) throw new Error(`--publish-existing requires an existing ${tag} release`)
      return head
    })()
  assert.match(source, /^[a-f0-9]{40}$/)
  if (existing && !existing.draft && !args["publish-existing"] && !verifyOnly)
    throw new Error(`${tag} is already published; use --publish-existing to verify it`)
  assert.equal(git(["show", `${source}:VERSION`]), version, "Release source VERSION does not match")
  assert.ok(isAncestor(source, head), "Release source is not an ancestor of public main")
  if (!verifyOnly) assertNotDowngrade(version, published)
  if (args.preflight) {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `sha=${source}\nversion=${version}\n`)
    console.log(`Release targets and source validated for ${version}`)
    return
  }

  const work = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "turen-release-"))
  // macOS's long per-user temp path can exceed gpg-agent's Unix socket limit.
  const gpgRoot = process.platform === "darwin" ? await mkdtemp("/tmp/turen-gpg-") : work
  const gnupgHome = path.join(gpgRoot, "gnupg")
  try {
    await mkdir(gnupgHome, { mode: 0o700 })

    // The publish job owns release creation and asset uploads. Here we only
    // verify the existing draft/published release — never synthesize assets.
    assert.ok(existing, `Public ${tag} does not exist; the publish job must create the draft release`)
    assert.ok(Number.isSafeInteger(existing.id) && existing.id > 0)
    if (verifyOnly && existing.draft) throw new Error("Public release is still a draft")
    assert.equal(existing.target_commitish, source, "Public release does not target the release source")
    if (existingTagSha) assert.equal(existingTagSha, source, "Public tag does not point at the release source")
    const uploaded = await api<Release>(PUBLIC_REPOSITORY, `releases/${existing.id}`)
    assert.equal(uploaded.tag_name, tag)
    const publicDirectory = path.join(work, "public")
    console.log("Downloading and verifying every public artifact")
    download(PUBLIC_REPOSITORY, uploaded, publicDirectory)
    // Pre-inversion manifests record a private source commit that is not part
    // of public history. When the manifest's signed commit is absent from the
    // public object store, it is that commit the manifest authentically attests.
    let expectedSource = source
    const manifestText = await Bun.file(path.join(publicDirectory, "release-manifest.json")).text()
    const manifestCommit = /"commit"\s*:\s*"([a-f0-9]{40})"/.exec(manifestText)?.[1]
    if (
      manifestCommit &&
      manifestCommit !== source &&
      Bun.spawnSync(["git", "cat-file", "-e", `${manifestCommit}^{commit}`], {
        cwd: root,
        env: environment(),
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode !== 0
    ) {
      expectedSource = manifestCommit
    }
    const verified = await verifyRelease({
      directory: publicDirectory,
      version,
      source: expectedSource,
      assets: uploaded.assets,
      gnupgHome,
    })
    await verifyUpdateArtifacts(publicDirectory, version)

    // Chain of custody: the previous public release's signed manifest must name
    // the previous public tag's commit, and that commit must be an ancestor of
    // this release's source on public main. The current release's verified key
    // (fingerprint-pinned above) authenticates the previous manifest.
    const previous = previousRelease(version, published)
    assert.ok(previous, "Public release history must be bootstrapped manually before automated publication")
    const previousTag = previous.tag_name
    validateVersion(previousTag.replace(/^v/, ""))
    assertPublicInventory(previous.assets, previous.assets)
    const previousDirectory = path.join(work, "previous")
    run(
      [
        "gh",
        "release",
        "download",
        previousTag,
        "--repo",
        PUBLIC_REPOSITORY,
        "--dir",
        previousDirectory,
        "--pattern",
        "release-manifest.json",
        "--pattern",
        "release-manifest.json.asc",
      ],
      publicToken,
    )
    const previousManifest = await verifySignedManifest({
      file: path.join(previousDirectory, "release-manifest.json"),
      signature: path.join(previousDirectory, "release-manifest.json.asc"),
      keyFile: path.join(publicDirectory, "RELEASE_SIGNING_KEY.asc"),
      gnupgHome,
    })
    assert.equal(previousManifest.version, previousTag.slice(1))
    assert.match(previousManifest.commit, /^[a-f0-9]{40}$/)
    const previousCommit = fetchRef(`refs/tags/${previousTag}`, "refs/remotes/release-public/previous")
    // Pre-inversion manifests record a private commit that never existed in
    // public history; the signature still binds it. Once a manifest names a
    // public commit, it must be exactly the previous tag's target.
    const manifestCommitInPublic =
      Bun.spawnSync(["git", "cat-file", "-e", `${previousManifest.commit}^{commit}`], {
        cwd: root,
        env: environment(),
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    if (manifestCommitInPublic) {
      assert.equal(previousCommit, previousManifest.commit, "Previous public tag/manifest mismatch")
    }
    assert.ok(isAncestor(previousCommit, source), "Release source does not build on the previous release")
    if (!verifyOnly) {
      assertNotDowngrade(version, await releases(PUBLIC_REPOSITORY))
      const latest = await api<Release>(PUBLIC_REPOSITORY, "releases/latest")
      if (uploaded.draft || latest.id !== existing.id) {
        await api(PUBLIC_REPOSITORY, `releases/${existing.id}`, "PATCH", {
          draft: false,
          make_latest: "true",
          name: `TurenOS ${version}`,
          body: `Signed TurenOS Desktop and CLI release for macOS, Windows, and Linux.\n\n[Source changes](https://github.com/${PUBLIC_REPOSITORY}/compare/${previousTag}...${tag})\n\nSee SHA256SUMS, release-manifest.json, and detached signatures below.\n\nSigning key: \`${RELEASE_FINGERPRINT}\`.`,
        })
      }
      // Publishing the release materializes the tag on the public source commit.
      assert.equal(publicTag(), source, "Published tag does not point at the release source")
    }
    await verifyPublic(version, uploaded, publicDirectory)

    console.log("Verifying Homebrew formula")
    const formula = await api<Contents>(HOMEBREW_REPOSITORY, "contents/Formula/turenos.rb?ref=main")
    assert.equal(formula.type, "file")
    assert.equal(formula.encoding, "base64")
    const before = Buffer.from(formula.content, "base64").toString("utf8")
    const after = updateHomebrewFormula(before, version, verified.manifest)
    if (verifyOnly) assert.equal(before, after, "Homebrew has not been updated")
    if (before !== after) {
      await api(HOMEBREW_REPOSITORY, "contents/Formula/turenos.rb", "PUT", {
        message: `chore: update turenos to ${version}`,
        branch: "main",
        sha: formula.sha,
        content: Buffer.from(after).toString("base64"),
      })
    }
    const current = await api<Contents>(HOMEBREW_REPOSITORY, "contents/Formula/turenos.rb?ref=main")
    assert.equal(Buffer.from(current.content, "base64").toString("utf8"), after)
    const summary = `## TurenOS ${version}\n\n- [Public release](https://github.com/${PUBLIC_REPOSITORY}/releases/tag/${tag})\n- Source: \`${source}\` (public main)\n- ${verified.files.length} verified assets (${verified.bytes} bytes)\n- Six anonymous update feeds and payload probes verified\n- [Homebrew formula](https://github.com/${HOMEBREW_REPOSITORY}/blob/main/Formula/turenos.rb) verified\n`
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
    console.log(`${verifyOnly ? "Verified" : "Published"} ${tag}: public release, update feeds, and Homebrew are ready`)
  } finally {
    if (gpgRoot !== work) await rm(gpgRoot, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  }
}

async function verifyPublic(version: string, expected: Release, directory: string) {
  // GitHub's latest redirects can briefly lag publication. Retries remain bounded.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`https://api.github.com/repos/${PUBLIC_REPOSITORY}/releases/latest`, {
        signal: AbortSignal.timeout(30_000),
      })
      assert.equal(response.status, 200)
      const latest = (await response.json()) as Release
      assert.equal(latest.id, expected.id)
      assert.equal(latest.tag_name, `v${version}`)
      assert.equal(latest.draft, false)
      assert.equal(latest.prerelease, false)
      assertPublicInventory(expected.assets, latest.assets)
      for (const feed of updateFeeds) {
        const current = await fetch(`https://github.com/${PUBLIC_REPOSITORY}/releases/latest/download/${feed.name}`, {
          signal: AbortSignal.timeout(30_000),
        })
        assert.equal(current.status, 200)
        assert.ok(
          Buffer.from(await current.arrayBuffer()).equals(
            Buffer.from(await Bun.file(path.join(directory, feed.name)).arrayBuffer()),
          ),
          `Stale or altered update feed: ${feed.name}`,
        )
        const asset = expected.assets.find((asset) => asset.name === feed.artifact)
        assert.ok(asset)
        const payload = await fetch(
          `https://github.com/${PUBLIC_REPOSITORY}/releases/download/v${version}/${feed.artifact}`,
          { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(30_000) },
        )
        if (payload.status !== 206) {
          await payload.body?.cancel()
          throw new Error(`Payload probe returned HTTP ${payload.status}: ${feed.artifact}`)
        }
        assert.equal(payload.headers.get("content-range"), `bytes 0-0/${asset.size}`)
        assert.equal((await payload.arrayBuffer()).byteLength, 1)
      }
      return
    } catch (error) {
      if (attempt === 5) throw error
      await Bun.sleep(30_000)
    }
  }
}

if (import.meta.main) await main()
