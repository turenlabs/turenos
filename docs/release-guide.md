# Release guide

Operator checklist for cutting a TurenOS release. For architecture, safeguards,
and failure semantics see [release-automation.md](./release-automation.md); for
credential and certificate policy see [release-signing.md](./release-signing.md).

Releases are dispatched from this private repository (`turenio/turen`), but the
release source is `turenlabs/turenos` `main`. Public `main` is canonical: it is
where the version bump lands, where CI gates, and where the release tag is
created. This repo only builds that public source privately and signs it.

## Prerequisites

- The changes to ship are merged to public `main` with green `test`/`typecheck`.
- `PUBLIC_RELEASE_TOKEN` (Actions secret here) is unexpired and has
  **Contents: Read and write** on `turenlabs/turenos` and
  `turenlabs/homebrew-turenos`.
- Signing secrets (`APPLE_*`, `AZURE_*`, `GPG_*`) are configured here.
- Your local checkout is clean and on `dev` — `./script/release` only
  dispatches; it never commits or pushes.

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

Commit the result to public `main` (direct commit or PR — both work):

```sh
git commit -am "chore: release 1.0.29"
git push github main    # or the public remote
```

Mirror the same bump to private `dev` so the trees stay in parity.

## 2. Wait for CI on the bump commit

The release gates on the public commit's checks. Confirm before dispatching:

```sh
gh run list --repo turenlabs/turenos --branch main --limit 2
```

Both `test` and `typecheck` must be green on the version-bump commit. If the
bump commit is no longer `main` HEAD that's fine — the orchestrator resolves the
release source as the `main` commit whose `VERSION` matches.

## 3. Dispatch

```sh
./script/release 1.0.29
```

Equivalent: `gh workflow run release.yml --repo turenio/turen -f version=1.0.29`.

The workflow validates, builds/signs ~15 platform jobs against the public
commit, uploads all assets to a public **draft** release, re-downloads and
verifies everything, enforces the release chain, then publishes and updates
Homebrew. Expect roughly an hour; desktop builds dominate.

Monitor with occasional bounded checks — do not stream `gh run watch`:

```sh
gh run list --repo turenio/turen --workflow release.yml --limit 1
```

## 4. Verify

A complete release means all of:

```sh
gh release view v1.0.29 --repo turenlabs/turenos --json isDraft   # draft=false
gh api repos/turenlabs/turenos/git/refs/tags/v1.0.29 --jq .object.sha  # = the version-bump commit on main
curl -s https://raw.githubusercontent.com/turenlabs/homebrew-turenos/main/Formula/turenos.rb | grep 1.0.29
```

The workflow itself verifies anonymous downloads, update feeds, and the formula
read-back; the checks above confirm externally.

## Recovery

| Symptom | Action |
| --- | --- |
| Build/sign job failed before publish | `gh run rerun <id> --failed` — same draft resumes |
| Publish/verify job failed | **Do not rerun** — reruns reuse the run's original checkout, so a `script/release-distribute.ts` fix won't be picked up. Push the fix to `dev`, then `./script/release <v> --publish-existing` to resume the draft |
| Draft exists with wrong/corrupt assets | While it is still a draft, delete the bad asset manually, then `--publish-existing`. Never publish a partial draft by hand |
| `VERSION does not match` | The release commit's `VERSION` must equal the requested version — dispatch against the right commit or fix the bump |
| Public release already published | `--publish-existing` verifies it; rebuilding/re-signing a published version is rejected — never force it |
| `Release source is not an ancestor of public main` | The tag/commit isn't on public history — investigate, don't bypass |
| Homebrew formula stale | `--publish-existing` re-runs the formula update idempotently |

`--publish-existing` skips every build job and runs only the
verify→publish→Homebrew stage, so it is the cheap resume for any post-build
failure. See [release-automation.md](./release-automation.md#recovery-without-rebuilding)
for the full semantics.

## Read-only diagnosis

```sh
PRIVATE_GH_TOKEN="$(gh auth token)" bun script/release-distribute.ts \
  --verify-only --version 1.0.29
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
