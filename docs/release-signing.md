# Release signing

TurenOS releases are built from the exact `dev` commit selected by the manual
GitHub `release` workflow. The workflow fails before building when a signing
input is absent or malformed.

## Platform policy

| Platform | Native signature | Additional release signature |
| --- | --- | --- |
| macOS | Developer ID signing and Apple notarization for Desktop and standalone runtimes | Detached OpenPGP signature |
| Windows | Azure Trusted Signing Authenticode signature with RFC 3161 timestamp | Detached OpenPGP signature |
| Linux | Detached OpenPGP signatures for AppImage, deb, rpm, and runtime archives | Signed checksums and manifest |

Every published file is covered by `release-manifest.json` and `SHA256SUMS`.
Each file, the manifest, and the checksum list receives an armored detached
signature. `RELEASE_SIGNING_KEY.asc` contains the corresponding public key.

## GitHub secrets

Configure these as GitHub Actions secrets. Never commit certificates, private
keys, passwords, or decoded temporary files.

### Apple

- `APPLE_CERTIFICATE_APPLICATION_P12`: base64-encoded Developer ID Application `.p12` export.
- `APPLE_CERTIFICATE_PASSWORD`: password protecting the `.p12`.
- `APPLE_ID`: Apple account used by the existing agent release pipeline.
- `APPLE_ID_PASSWORD`: app-specific password for that Apple account.
- `APPLE_TEAM_ID`: Apple Developer team ID (`5Q9UJQ9MPK`).

The certificate must include its private key and remain valid through the
release window. The app-specific password must be able to submit notarization
jobs. TurenOS ships DMG and ZIP bundles, so the agent pipeline's separate
Developer ID Installer certificate is not required.

### Windows

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_TRUSTED_SIGNING_ACCOUNT`
- `AZURE_TRUSTED_SIGNING_PROFILE`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`

Windows signing uses GitHub OIDC and Azure Trusted Signing. Do not create or
store an Azure client secret. The Azure federated credential must trust this
repository's `release.yml` workflow on `dev`.

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

Run the workflow only from a clean, synchronized `dev` branch after updating
the root `VERSION` file:

```bash
gh workflow run release.yml --ref dev -f version="$(tr -d '[:space:]' < VERSION)"
```

Do not publish a draft until every platform job, signature verification,
notarization submission, checksum verification, and downloaded-release
verification has passed.

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
