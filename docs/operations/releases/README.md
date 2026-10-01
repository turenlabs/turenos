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
lockfile. Bumping `VERSION` alone fails the `packages (linux)` CI job —
`version.test.ts` requires them synchronized.

Current versioned manifests:

```
VERSION
package.json
packages/{app,codemode,core,desktop,effect-drizzle-sqlite,effect-sqlite-node}/package.json
packages/{forge,http-recorder,llm,plugin,sdk/js,script,server,session-ui,ui}/package.json
```

```sh
# Set VERSION, update each manifest's "version" field, then:
bun install            # refreshes bun.lock workspace versions
bun --cwd packages/script version:check
```

Commit the result and merge it to public `main` through the normal review and
CI process. The private repository does not need a source mirror.

## 2. Wait for CI on main HEAD

The release gates on the checks of public `main` HEAD, not of the bump commit.
Confirm before dispatching:

```sh
gh run list --repo turenlabs/turenos --branch main --limit 2
```

Confirm that both `test` and `typecheck` are green on the current `main` HEAD. The
workflow's gate is weaker than that: it collects the conclusions of every `test` and
`typecheck` check run, removes duplicates, and passes when the only conclusion left
is `success`, so one green check with the other missing also passes. Commits
merged after the bump are built and shipped in the release as long as they
leave `VERSION` unchanged. If HEAD's checks are all missing, or any is still
running or failed, the build, publish, and distribute jobs are skipped and the run still
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
