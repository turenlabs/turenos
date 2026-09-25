# Automated releases

The `turenio/turen` release workflow builds, signs, and publishes from the
canonical `turenlabs/turenos` `main` source. It runs privately and publishes the
verified assets to the public repository.

1. Validate the committed version on public `main`, repository identities, and
   publishing access.
2. Require the release commit's public `test`/`typecheck` checks to be green.
3. Check out `turenlabs/turenos` at the release commit, build every platform on
   private runners, and sign/notarize with private credentials.
4. Create a public **draft** release and upload all signed assets to it.
5. Re-download the draft, verify every byte, checksum, detached signature, and
   update feed against the pinned signing key.
6. Verify the release chain: the previous release's signed manifest names the
   previous tag's commit, which must be an ancestor of this release's source.
7. Publish the stable public release and verify anonymous downloads.
8. Update and read back `turenlabs/homebrew-turenos/Formula/turenos.rb`.

The workflow is successful only after public publication and Homebrew verification succeed.
It writes release/source links and the verified artifact count to the Actions job summary.

## Normal release

Review and merge product changes, the root `VERSION`, all entries in
`VERSIONED_PACKAGE_FILES`, and the matching lockfile versions through normal CI on
public `main` first. The release command intentionally does not commit a dirty
worktree, bump versions, merge unreviewed changes, or bypass branch protection.

Once the version-bump commit is on public `main` with green CI:

```sh
./script/release 1.0.12
```

Use the actual prepared stable version, not necessarily the example above. The equivalent
Actions dispatch is:

```sh
gh workflow run release.yml --repo turenio/turen -f version=1.0.12
```

GitHub Actions does the remaining work. No local signing/export, artifact copying, public
Git push, or Homebrew edit is needed. Monitor the Actions summary or make occasional bounded
status requests; do not stream `gh run watch` output into an agent conversation.

## One-time publishing credential

The private build's `GITHUB_TOKEN` cannot write to the other repositories. Configure a
dedicated **fine-grained personal access token** as the `PUBLIC_RELEASE_TOKEN` Actions secret
in **turenio/turen**:

- Resource owner: `turenlabs`.
- Selected repositories: `turenos` and `homebrew-turenos` only.
- Repository permission: **Contents: Read and write**.
- Set an appropriate expiration and rotate the secret before it expires.

Do not copy a developer's general-purpose `gh` login token into Actions. The token is used
only by target-validation and distribution steps. It is never written into Git remote URLs
or persisted checkout credentials. Native signing keys remain in the existing private build
jobs; the distribution job receives only a read token for the private repository and the
separate public publishing token. Public repositories receive no signing secrets.

Repository access and contents-write authentication are checked before building with
no-change dry-run pushes of each target's own existing commit.

## Recovery without rebuilding

If the public release already exists — as a partial draft or already published — finish
distribution with:

```sh
./script/release 1.0.11 --publish-existing
```

Or dispatch directly:

```sh
gh workflow run release.yml --repo turenio/turen \
  -f version=1.0.11 -f publish_existing=true
```

This runs the current trusted orchestrator but resolves source from the existing public
release target or tag. It does not rebuild binaries or require `VERSION` on current public
`main` to equal the recovered version; the release commit's `VERSION` must match.

Recovery verifies remote state rather than trusting a local checkpoint:

- A draft release is reused only when it targets the release source commit. The publish
  job's upload loop resumes incomplete uploads without replacing finished assets.
- Different, incomplete, or unexpected draft assets cause failure rather than deletion;
  investigate and remove a bad asset manually only while the release is still a draft,
  then retry.
- An already-published public release is downloaded and verified, never overwritten.
- A missing Homebrew update can be completed after public publication.
- An already-correct Homebrew formula is left unchanged.
- A newer public release or Homebrew version prevents a downgrade.

Do not publish a partial draft manually. The orchestrator never deletes or overwrites an
uploaded public asset. If a partial release is published concurrently, verification fails;
it is not repaired by modifying published artifacts.

For a build/signing failure before publication, rerun the failed Actions jobs on
the same source commit. Diagnose actual product failures; do not blindly retry them or
disable gates. Full rebuilds of already-published versions are rejected.

## Source and artifact boundaries

`script/release-distribute.ts` is the orchestrator. Its tested validation policy lives in
`packages/script/src/release.ts`; the existing Desktop update verifier is reused.

The repository targets and signing fingerprint are code-reviewed constants. Publication
refuses the wrong repository or a non-default dispatch ref. There is no source mirror: the
release tag is created on the public `main` commit directly, so public history is the only
history. The release source must be an ancestor of public `main`, its `VERSION` file must
match the requested version, and the previous release's signed manifest must name the
previous public tag's commit.

Unrelated edits on public `main` never block a release — the release source is the
version-bump commit, wherever `main` has since advanced. Moved tags, unexpected draft
targets, extra assets, malformed filenames, invalid signatures, missing formats, and
mismatched hashes stop publication. Do not force-push around these checks.

Artifact verification requires the current complete 77-file inventory, regular files only,
bounded metadata, all 38 checksum entries, every detached signature, and the pinned public
key. Payload hashing is streamed. Verification uses a fresh isolated keyring and never a
private signing key. A format or signing-key rotation requires a reviewed policy update.

After publication, anonymous verification checks the latest release inventory, all six
update-feed bytes, and a size-checked range request for every desktop architecture. Homebrew
edits change only the four platform URLs/checksums and an existing version field. The GitHub
Contents API's blob SHA prevents overwriting a concurrent formula edit.

## Local verification and tests

A read-only diagnostic can recheck an existing published release and formula:

```sh
PRIVATE_GH_TOKEN="$(gh auth token)" bun script/release-distribute.ts \
  --verify-only --version 1.0.11
```

This uses the local login only for reads in that process; it does not save credentials to
Actions or make remote changes. It downloads the public assets, so allow disk space for a
full copy. Temporary verification files are cleaned up afterward.

Run the automated tests from their packages:

```sh
bun run --cwd packages/script test
bun run --cwd packages/script typecheck
bun test --cwd packages/forge test/installation/release-signing.test.ts
```

Tests cover malformed/tampered artifacts, inventory membership, path and symlink rejection,
downgrade prevention, release-chain ancestry, formula updates, and workflow
recovery/credential wiring. The Script package is already included in Linux and Windows CI.
