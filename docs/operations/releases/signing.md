# Release signing

TurenOS releases are built from public `turenlabs/turenos` `main` HEAD at
dispatch, whose `VERSION` must equal the requested release (see the
[release guide](./README.md)). The workflow fails before building when a
signing input is absent or malformed.

The same workflow publishes the public release and updates Homebrew. Use the
[automated release runbook](./automation.md) for dispatch, the dedicated
`PUBLIC_RELEASE_TOKEN`, and recovery without rebuilding.

## Platform policy

| Platform | Native signature                                                                | Additional release signature  |
| -------- | ------------------------------------------------------------------------------- | ----------------------------- |
| macOS    | Developer ID signing and Apple notarization for Desktop and standalone runtimes | Detached OpenPGP signature    |
| Windows  | Azure Trusted Signing Authenticode signature with RFC 3161 timestamp            | Detached OpenPGP signature    |
| Linux    | Detached OpenPGP signatures for AppImage, deb, rpm, and runtime archives        | Signed checksums and manifest |

`release-manifest.json` lists every payload and `RELEASE_SIGNING_KEY.asc`.
`SHA256SUMS` covers the same files plus `release-manifest.json`. Every payload,
the manifest, and the checksum list receives an armored detached `.asc`
signature; the signatures themselves are in neither list, and `SHA256SUMS` is
not in the manifest. `RELEASE_SIGNING_KEY.asc` contains the corresponding
public key and is not signed.

## GitHub secrets

Configure these as GitHub Actions secrets. Never commit certificates, private
keys, passwords, or decoded temporary files.

### Apple

- `APPLE_CERTIFICATE_APPLICATION_P12`: base64-encoded Developer ID Application `.p12` export.
- `APPLE_CERTIFICATE_PASSWORD`: password protecting the `.p12`.
- `APPLE_ID`: Apple account that submits notarization jobs.
- `APPLE_ID_PASSWORD`: app-specific password for that Apple account.
- `APPLE_TEAM_ID`: Apple Developer team ID (`5Q9UJQ9MPK`).

The certificate must include its private key and remain valid through the
release window. The app-specific password must be able to submit notarization
jobs. TurenOS ships DMG and ZIP bundles, so a Developer ID Installer certificate
is not required.

### Windows

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_TRUSTED_SIGNING_ACCOUNT`
- `AZURE_TRUSTED_SIGNING_PROFILE`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`

Windows signing uses GitHub OIDC and Azure Trusted Signing. Do not create or
store an Azure client secret. The Azure federated credential must trust the
`turenio/turen` `release.yml` workflow on that repository's default branch, the
only ref the workflow accepts a dispatch from.

### Release OpenPGP key

- `RELEASE_GPG_PRIVATE_KEY_B64`: base64-encoded exported private key.
- `RELEASE_GPG_PASSPHRASE`: private-key passphrase.
- `RELEASE_GPG_FINGERPRINT`: full uppercase fingerprint without spaces.

Example preparation commands:

```bash
gpg --armor --export-secret-keys KEY_ID > release-signing-private.asc
base64 < release-signing-private.asc | tr -d '\n'
gpg --with-colons --fingerprint KEY_ID | awk -F: '$1 == "fpr" { print $10; exit }'
```

Store the private export outside the repository and delete temporary exports
after the GitHub secret has been configured.

## Release targets

Desktop produces signed x64 and arm64 bundles for macOS and Windows, plus x64
and arm64 AppImage, deb, and rpm bundles for Linux. Standalone runtimes include
macOS, Windows, Linux glibc, and Linux musl variants.

Run the workflow only after the version bump has merged to public `main` with
green CI — see the [release guide](./README.md). From a checkout with the
prepared `VERSION`:

```bash
./script/release "$(tr -d '[:space:]' < VERSION)"
```

The equivalent direct dispatch must name the private repository:

```bash
gh workflow run release.yml --repo turenio/turen -f version="$(tr -d '[:space:]' < VERSION)"
```

Do not publish a draft until every platform job, signature verification,
notarization submission, checksum verification, and downloaded-release
verification has passed.

## Public Desktop updates

Production Desktop builds check public GitHub Releases in `turenlabs/turenos` at
launch and every ten minutes. Updates download in the background; installation
requires the user's restart action.

The **Update channel** setting (Latest, One release behind, Two releases behind)
changes where the check goes. Latest uses the GitHub provider's
`releases/latest` feed. Either "behind" option first requests
`https://api.github.com/repos/turenlabs/turenos/releases?per_page=10`
anonymously on every check, skips drafts, prereleases, and non-`vX.Y.Z` tags,
and pins the feed to that tag's own `latest-*.yml` assets. A failed or
rate-limited listing fails that check, though an update already downloaded
stays installable. The preference is stored as
`updater-lag` in Desktop product storage
([`updater.ts`](../../../packages/desktop/src/main/updater.ts),
[`updater-feed.ts`](../../../packages/desktop/src/main/updater-feed.ts)). Development and beta builds do not
auto-update. Builds older than 1.0.5 predate this feed and must install a
current release manually once.

Build and sign in `turenio/turen`. Its publish job uploads the signed assets
directly to a public draft release; the distribution job re-downloads and
verifies them before publishing, without rebuilding or renaming assets.
The desktop package embeds the public repository, not a GitHub token.

The private release workflow includes and verifies six architecture-specific
update manifests, plus the generated `.blockmap` files. Separate channels avoid
parallel x64/arm64 builds overwriting one another's metadata:

| Platform | x64                    | arm64                          |
| -------- | ---------------------- | ------------------------------ |
| macOS    | `latest-x64-mac.yml`   | `latest-arm64-mac.yml`         |
| Windows  | `latest-x64.yml`       | `latest-arm64.yml`             |
| Linux    | `latest-x64-linux.yml` | `latest-arm64-linux-arm64.yml` |

The publish job uploads **every release asset**, including manifests, blockmaps,
checksums, and detached signatures. It keeps the public release a draft until the
complete upload has been downloaded again and verified. For manual diagnosis,
this verifier remains available against downloaded artifacts:

```bash
bun packages/desktop/scripts/update-artifacts.ts /path/to/downloaded-public-draft "$VERSION"
```

The verifier checks all six feeds, their version, architecture, referenced
artifacts, SHA-512 hashes, and required blockmaps. Linux feeds must include
AppImage, deb, and rpm artifacts. The workflow publishes the verified public draft
with its matching version tag so clients can discover it. Future releases
must retain these feeds and artifact naming conventions.

Before shipping, smoke-test signed packaged apps on supported platforms:
install the candidate, point a test installation at a newer draft/test feed,
download an update, explicitly restart, and verify version, retained user data,
and sidecar shutdown. Never publish a fake newer stable version to exercise the
production feed. Windows updates require the `Turen Labs, Inc` signer;
macOS retains Electron's native signature checks.

## Verifying downloads

Import the published key once, then verify the checksums and detached
signatures:

```bash
gpg --import RELEASE_SIGNING_KEY.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
gpg --verify release-manifest.json.asc release-manifest.json
```

macOS users can additionally run `codesign --verify --deep --strict` and
`spctl --assess`; Windows users can inspect Authenticode with
`Get-AuthenticodeSignature`.
