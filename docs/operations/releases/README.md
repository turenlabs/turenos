# Release guide

Operator checklist for cutting a TurenOS release. For architecture, safeguards,
and failure semantics see [automated releases](./automation.md); for
credential and certificate policy see [release signing](./signing.md).

The release source is the `turenlabs/turenos` `main` HEAD at dispatch time: the
workflow builds that commit, requires its `VERSION` to equal the requested
version and its CI to be green, and the release tag names it. An existing draft
for the version pins the source to the draft's target commit instead.
`./script/release` can run from any checkout and dispatches the private
`turenio/turen` workflow, which builds and signs that public source.

## Prerequisites

- The changes to ship are merged to public `main` with green `test`/`typecheck`.
- `PUBLIC_RELEASE_TOKEN` (Actions secret in `turenio/turen`) is unexpired and has
  **Contents: Read and write** on `turenlabs/turenos` and
  `turenlabs/homebrew-turenos`.
- Signing secrets (`APPLE_*`, `AZURE_*`, `GPG_*`) are configured in `turenio/turen`.
- An operator with access to `turenio/turen` has confirmed that its deployed `release.yml` matches the
  [checked-in workflow](../../../.github/workflows/release.yml). This repository cannot establish the private
  workflow revision; the CI gate, signing steps, and `--publish-existing` recovery below describe the checked-in
  workflow and must be rechecked if the private copy differs.

## 1. Bump the version

A release version is the root `VERSION` file **plus** every entry in
`VERSIONED_PACKAGE_FILES` (`packages/script/src/version.ts`) **plus** the
lockfile. The same change must include bundled notes for that exact version.
Bumping `VERSION` alone fails CI: `version.test.ts` requires synchronized
versions and valid release notes.

Current versioned manifests:

```
VERSION
package.json
packages/{app,codemode,core,desktop,effect-drizzle-sqlite,effect-sqlite-node}/package.json
packages/{forge,http-recorder,llm,plugin,sdk/js,script,server,session-ui,ui}/package.json
```

```sh
# Set VERSION, update each manifest's "version" field and bundled notes, then:
bun install            # refreshes bun.lock workspace versions
bun --cwd packages/script version:check
```

Commit the result and merge it to public `main` through the normal review and
CI process. The private repository does not need a source mirror.

### Bundle the release notes

Add an entry to [the bundled content](../../../packages/app/src/release-notes/content.ts)
in the version-bump change. Use the exact stable `VERSION`, a short summary,
and plain-text arrays under `changes.new`, `changes.improved`, and `changes.fixed`.
Describe verified user-facing changes since the preceding release; do not claim
unreleased work shipped in an older version. No image, video, or remote-content
fields are accepted.

`version:check` and the Script package's version tests run the same
[pure validator](../../../packages/app/src/release-notes.ts). Release preparation fails for:

- A missing exact `VERSION`, duplicate versions, noncanonical or prerelease versions,
  or an entry newer than `VERSION`.
- Blank summaries or change items, or text longer than 240 characters.
- Missing change groups, more than 10 items in any group, or fewer than one or
  more than 20 changes across the entry. Individual groups may be empty.
- An empty bundle, more than 50 retained releases, or unexpected content fields.

Retain recent entries when adding a release; once the bundle reaches 50, remove
the oldest entries to stay within the bound. The initial history starts at
1.0.44; do not invent entries to fill gaps. The selection helper displays at
most the latest five available entries in `previous < version <= installed`,
newest first. Without a previous version it selects only the installed version.
If that exact stable version is absent, either version is malformed, or this is
a downgrade or unchanged version, automatic selection returns no notes rather
than substituting another release.

The structured text ships with the app and is available offline without a
startup request or remote media. Full release links use validated stable tags
in the fixed `turenlabs/turenos` GitHub repository; opening a link still requires
network access. Keep older release details there rather than growing the bundle
without limit.

## 2. Wait for CI on main HEAD

The release gates on the checks of public `main` HEAD, not of the bump commit.
Confirm before dispatching:

```sh
gh run list --repo turenlabs/turenos --branch main --limit 2
```

Both `test` and `typecheck` must be green on the current `main` HEAD. The workflow
checks each name separately and counts only the latest attempt of each, so a
passing re-run replaces an earlier failure, but a missing check blocks. Commits
merged after the bump are built and shipped in the release as long as they
leave `VERSION` unchanged. If either check is missing, still running or failed
on HEAD, the build, publish, and distribute jobs are skipped and the run still
finishes green with nothing published, so check the run's job list rather than
its overall status.

## 3. Dispatch

From a checkout with the prepared `VERSION`, run:

```sh
release_version=$(tr -d '[:space:]' < VERSION)
./script/release "$release_version"
```

You can also pass the prepared version explicitly from another checkout. The
equivalent direct dispatch is:

```sh
gh workflow run release.yml --repo turenio/turen -f version="$release_version"
```

The workflow validates the public commit, builds and signs platform artifacts,
uploads them to a public **draft** release, re-downloads and verifies the assets,
enforces the release chain, then publishes and updates Homebrew.

Monitor with occasional bounded checks — do not stream `gh run watch`:

```sh
gh run list --repo turenio/turen --workflow release.yml --limit 1
```

## 4. Verify

A complete release means all of:

```sh
gh release view "v$release_version" --repo turenlabs/turenos --json isDraft   # draft=false
gh api "repos/turenlabs/turenos/git/refs/tags/v$release_version" --jq .object.sha  # release source commit
curl -s https://raw.githubusercontent.com/turenlabs/homebrew-turenos/main/Formula/turenos.rb | grep "$release_version"
```

The workflow itself verifies anonymous downloads, update feeds, and the formula
read-back; the checks above confirm externally.

## Recovery

| Symptom                                            | Action                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build/sign or `publish` (upload) job failed        | `gh run rerun <id> --failed` — same draft resumes                                                                                                                                                                                                |
| `distribute` (verify and publish) job failed       | **Do not rerun** — reruns reuse the run's original checkout, so a `script/release-distribute.ts` fix won't be picked up. Merge the fix to the `turenio/turen` default branch, then `./script/release <v> --publish-existing` to resume the draft |
| Draft exists with wrong/corrupt assets             | `--publish-existing` never uploads, so it fails on a draft with a missing asset. While it is still a draft (a draft has no tag), delete the whole draft, then dispatch a normal release to rebuild it. Never publish a partial draft by hand     |
| `VERSION does not match`                           | The release source's `VERSION` (public `main` HEAD, or an existing draft's target) must equal the requested version — merge the bump or request the version `main` carries                                                                       |
| Public release already published                   | `--publish-existing` verifies it; rebuilding/re-signing a published version is rejected — never force it                                                                                                                                         |
| `Release source is not an ancestor of public main` | The tag/commit isn't on public history — investigate, don't bypass                                                                                                                                                                               |
| Homebrew formula stale                             | `--publish-existing` re-runs the formula update idempotently                                                                                                                                                                                     |

`--publish-existing` skips every build and upload job and runs only the
verify→publish→Homebrew stage, so it is the cheap resume for any failure after
the draft is fully uploaded. It cannot add or replace a draft asset. It also
bypasses the CI gate: `distribute` runs even when the source's `test`/`typecheck`
checks are missing, pending, or failed.

The release workflow and `script/release-distribute.ts` run from the private
repository's own checkout (`Checkout trusted workflow revision` in
`.github/workflows/release.yml`), and the workflow refuses any dispatch ref
other than that repository's default branch. The product source it builds is
always checked out from `turenlabs/turenos` at the release commit. A fix to the
orchestrator therefore takes effect only once it is on the private default
branch. See [automated releases](./automation.md#recovery-without-rebuilding)
for the full semantics.

## Read-only diagnosis

```sh
PRIVATE_GH_TOKEN="$(gh auth token)" bun script/release-distribute.ts \
  --verify-only --version "$release_version"
```

Re-verifies a published release and formula without remote writes. Downloads all
assets — allow a few GB of disk.

## Never

- Rebuild or re-sign an already-published version.
- Force-push to public `main` or move a release tag.
- Publish a partial draft manually.
- Put a developer's personal `gh` token in Actions secrets — `PUBLIC_RELEASE_TOKEN`
  is a dedicated fine-grained PAT.
- Add public-repo signing secrets. Signing stays private; public gets only
  `PUBLIC_RELEASE_TOKEN` operations.
