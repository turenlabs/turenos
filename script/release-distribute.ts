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
  MIRROR_EXCLUSIONS,
  RELEASE_FINGERPRINT,
  assertMirrorDiff,
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

export function createPublicMirror(
  input: { source: string; parent: string; version: string; index: string },
  git: (args: string[], env?: Record<string, string>) => string,
) {
  validateVersion(input.version)
  assert.match(input.source, /^[a-f0-9]{40}$/)
  assert.match(input.parent, /^[a-f0-9]{40}$/)
  const index = { GIT_INDEX_FILE: input.index }
  git(["read-tree", input.source], index)
  git(["update-index", "--force-remove", ...MIRROR_EXCLUSIONS], index)
  const tree = git(["write-tree"], index)
  assertMirrorDiff(git(["diff", "--name-status", input.source, tree]))
  const commit = git(["commit-tree", tree, "-p", input.parent, "-m", `chore: release ${input.version}`])
  assert.equal(git(["show", "-s", "--format=%P", commit]), input.parent)
  return commit
}

export function missingReleaseAssets(expected: readonly ReleaseAsset[], release: Pick<Release, "draft" | "assets">) {
  assertPublicInventory(expected, expected)
  if (!release.draft) {
    assertPublicInventory(expected, release.assets)
    return []
  }
  const present = new Set(release.assets.map((asset) => asset.name))
  assertPublicInventory(
    expected.filter((asset) => present.has(asset.name)),
    release.assets,
  )
  return expected.filter((asset) => !present.has(asset.name))
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
    assert.equal(process.env.GITHUB_REF, "refs/heads/dev", "Publishing must run from dev")
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
    assert.equal(info.default_branch, isPrivate ? "dev" : "main")
    if (!isPrivate && !verifyOnly) {
      const ref = `refs/remotes/release-access/${repository.replace("/", "-")}`
      const remote = `https://github.com/${repository}.git`
      git(["fetch", "--no-tags", remote, `+refs/heads/main:${ref}`], publicToken)
      // Probe write authentication with the target's own existing commit, never private history.
      git(["push", "--dry-run", remote, `${ref}:refs/heads/main`], publicToken)
    }
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
  await validateRepository(PRIVATE_REPOSITORY, true)
  await validateRepository(PUBLIC_REPOSITORY, false)
  await validateRepository(HOMEBREW_REPOSITORY, false)
  if (!args.preflight || args["publish-existing"]) {
    git(
      [
        "fetch",
        "--no-tags",
        `https://github.com/${PRIVATE_REPOSITORY}.git`,
        `refs/tags/${tag}:refs/remotes/release-private/target`,
      ],
      privateToken,
    )
  }
  const source =
    args.source ??
    git([
      "rev-parse",
      args["publish-existing"] || !args.preflight ? "refs/remotes/release-private/target^{commit}" : "HEAD",
    ])
  assert.match(source, /^[a-f0-9]{40}$/)
  assert.equal(git(["show", `${source}:VERSION`]), version, "Release tag/source VERSION does not match")
  if (!args.preflight)
    assert.equal(git(["rev-parse", "refs/remotes/release-private/target^{commit}"]), source, "Private tag moved")
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
    const privateRelease = (await releases(PRIVATE_REPOSITORY)).find((release) => release.tag_name === tag)
    assert.ok(
      privateRelease && !privateRelease.draft && !privateRelease.prerelease,
      "Private release must be published and stable",
    )
    console.log(`Downloading and verifying private ${tag}`)
    const privateDirectory = path.join(work, "private")
    download(PRIVATE_REPOSITORY, privateRelease, privateDirectory)
    const verified = await verifyRelease({
      directory: privateDirectory,
      version,
      source,
      assets: privateRelease.assets,
      gnupgHome,
    })
    await verifyUpdateArtifacts(privateDirectory, version)

    const published = await releases(PUBLIC_REPOSITORY)
    if (!verifyOnly) assertNotDowngrade(version, published)
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
      keyFile: path.join(privateDirectory, "RELEASE_SIGNING_KEY.asc"),
      gnupgHome,
    })
    assert.equal(previousManifest.version, previousTag.slice(1))
    assert.match(previousManifest.commit, /^[a-f0-9]{40}$/)
    assert.equal(
      git(["rev-parse", `${previousTag}^{commit}`]),
      previousManifest.commit,
      "Previous private tag/manifest mismatch",
    )
    const parent = fetchRef(`refs/tags/${previousTag}`, "refs/remotes/release-public/previous")
    assertMirrorDiff(git(["diff", "--name-status", previousManifest.commit, parent]))
    const head = fetchRef("refs/heads/main", "refs/remotes/release-public/main")
    const existingTag = publicTag()
    const existing = published.find((release) => release.tag_name === tag)
    let publicSource: string
    if (existingTag) {
      assertMirrorDiff(git(["diff", "--name-status", source, existingTag]))
      assert.equal(git(["show", "-s", "--format=%P", existingTag]), parent, "Public release has unexpected ancestry")
      if (!verifyOnly) assert.equal(head, existingTag, "Public main has unrelated changes; refusing to overwrite")
      publicSource = existingTag
    } else {
      assert.ok(!existing, "A release exists without its public tag")
      assert.ok(!verifyOnly, "Public release does not exist yet")
      assert.equal(head, parent, "Public main has unrelated changes; refusing to overwrite")
      git(["merge-base", "--is-ancestor", previousManifest.commit, source])
      publicSource = createPublicMirror(
        { source, parent, version, index: path.join(work, "mirror.index") },
        (args, env) => git(args, undefined, env),
      )
      const ref = `refs/release-public/${tag}`
      git(["update-ref", ref, publicSource])
      console.log("Publishing sanitized source with public-only ancestry")
      git(
        [
          "push",
          "--atomic",
          `https://github.com/${PUBLIC_REPOSITORY}.git`,
          `${ref}:refs/heads/main`,
          `${ref}:refs/tags/${tag}`,
        ],
        publicToken,
      )
    }
    assert.equal(publicTag(), publicSource, "Public tag changed during publication")

    const release =
      existing ??
      (await api<Release>(PUBLIC_REPOSITORY, "releases", "POST", {
        tag_name: tag,
        target_commitish: publicSource,
        draft: true,
        name: `TurenOS ${version}`,
        body: `Signed TurenOS Desktop and CLI release for macOS, Windows, and Linux.\n\n[Source changes](https://github.com/${PUBLIC_REPOSITORY}/compare/${previousTag}...${tag})\n\nSee SHA256SUMS, release-manifest.json, and detached signatures below.\n\nSigning key: \`${RELEASE_FINGERPRINT}\`.`,
      }))
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0)
    assert.equal(release.tag_name, tag)
    if (release.draft && !verifyOnly) {
      console.log("Uploading missing verified artifacts without replacing existing assets")
      for (const asset of missingReleaseAssets(privateRelease.assets, release)) {
        const current = await api<Release>(PUBLIC_REPOSITORY, `releases/${release.id}`)
        assert.equal(current.tag_name, tag, "Release tag changed during upload")
        if (!missingReleaseAssets(privateRelease.assets, current).some((item) => item.name === asset.name)) continue
        // The API rejects duplicate names. Never DELETE an asset or use --clobber,
        // even if another operator publishes the draft during a long upload.
        const upload = await fetch(
          `https://uploads.github.com/repos/${PUBLIC_REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${publicToken}`,
              "Content-Type": "application/octet-stream",
              "Content-Length": String(asset.size),
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: Bun.file(path.join(privateDirectory, asset.name)),
            signal: AbortSignal.timeout(15 * 60_000),
          },
        )
        if (!upload.ok)
          throw new Error(
            `Asset upload ${asset.name} returned HTTP ${upload.status}; existing assets were not replaced`,
          )
        assertPublicInventory([asset], [(await upload.json()) as ReleaseAsset])
      }
    }
    const uploaded = await api<Release>(PUBLIC_REPOSITORY, `releases/${release.id}`)
    assertPublicInventory(privateRelease.assets, uploaded.assets)
    const publicDirectory = path.join(work, "public")
    console.log("Re-downloading and verifying every public artifact")
    download(PUBLIC_REPOSITORY, uploaded, publicDirectory)
    const publicVerified = await verifyRelease({
      directory: publicDirectory,
      version,
      source,
      assets: uploaded.assets,
      gnupgHome,
    })
    assert.deepEqual(publicVerified.hashes, verified.hashes)
    await verifyUpdateArtifacts(publicDirectory, version)
    if (!verifyOnly) {
      assertNotDowngrade(version, await releases(PUBLIC_REPOSITORY))
      assert.equal(publicTag(), publicSource)
      const latest = await api<Release>(PUBLIC_REPOSITORY, "releases/latest")
      if (uploaded.draft || latest.id !== release.id) {
        await api(PUBLIC_REPOSITORY, `releases/${release.id}`, "PATCH", { draft: false, make_latest: "true" })
      }
    }
    if (verifyOnly && uploaded.draft) throw new Error("Public release is still a draft")
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
    const summary = `## TurenOS ${version}\n\n- [Public release](https://github.com/${PUBLIC_REPOSITORY}/releases/tag/${tag})\n- Private source: \`${source}\`\n- Public source: \`${publicSource}\`\n- ${verified.files.length} verified assets (${verified.bytes} bytes)\n- Six anonymous update feeds and payload probes verified\n- [Homebrew formula](https://github.com/${HOMEBREW_REPOSITORY}/blob/main/Formula/turenos.rb) verified\n`
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
