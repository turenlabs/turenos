# Secure Storage

TurenOS-managed credentials and small sensitive files must be encrypted with `SecretVault` before they are persisted. The
vault uses one random application key protected by the operating system and exposes authenticated encryption to Core and
TurenOS services.

## Security Boundary

The vault protects TurenOS-managed data at rest against accidental disclosure, copied application data, backups that do not
include the operating-system key, and access by other OS users. Plaintext exists in trusted process memory while TurenOS is
using a credential.

The vault does not protect against arbitrary code execution in the Electron main process or server sidecar, same-user
process compromise on Windows, OS swap or hibernation files, kernel crash dumps, or secrets deliberately written to a
user-authored config or environment file.

## Architecture

```text
macOS Keychain / Windows DPAPI / Linux Secret Service or KWallet
  -> Electron safeStorage
  -> wrapped random 32-byte application key in electron-store
  -> Electron utility-process startup message
  -> SecretVault Effect service
  -> AES-256-GCM ciphertext in SQLite or a managed file
```

The wrapped key record contains only a format version, a non-secret key ID, and `safeStorage` ciphertext. The raw key is
never written to the database, app config, renderer storage, command-line arguments, or native sidecar environment.

The WSL sidecar receives the key through its startup input. Its temporary bootstrap environment variables are deleted when
the Secret Vault layer initializes and before normal child tools are started.

## Platform Behavior

| Platform | Protection                                                         | Expected prompt behavior                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS    | Keychain through Electron `safeStorage`                            | A normal update signed with the same identity should continue using the existing Keychain item without prompting. A prompt can occur on first use, when the login keychain is locked, after signing or app-identity changes, after Keychain reset, or when the user changed the item's access decision. Development and unsigned builds are more likely to prompt. |
| Windows  | User-scoped DPAPI through Electron `safeStorage`                   | Normal operation and updates are non-interactive. The wrapped key is normally tied to the Windows user and machine. An administrator password reset or loss of Electron's Local State can make existing ciphertext unrecoverable.                                                                                                                                  |
| Linux    | Secret Service/libsecret or KWallet through Electron `safeStorage` | An unlocked login keyring is normally silent. The desktop may prompt when the keyring is locked, after login/session changes, or when wallet access has not been approved. Prompts are not tied to TurenOS updates.                                                                                                                                                |

TurenOS accepts these Linux backends:

- `gnome_libsecret`
- `kwallet`
- `kwallet5`
- `kwallet6`

TurenOS rejects `basic_text`, `unknown`, an absent backend, and unrecognized future backends. There is no plaintext fallback.

## Cryptographic Format

`SecretVault` produces an opaque versioned string:

```text
forge-secret:v1:<key-id>:<nonce>:<ciphertext-and-tag>
```

Version 1 uses:

- A random 256-bit root key.
- HKDF-SHA-256 to derive a key for each scope.
- AES-256-GCM.
- A fresh 96-bit nonce for every write.
- A 128-bit authentication tag.
- Authenticated data binding the format, version, key ID, scope, and logical record key.
- A maximum plaintext size of 1 MiB.

Ciphertext cannot be moved to another scope or logical key and still authenticate. Use immutable identifiers for both.

## String Values

Use the Effect service inside repositories:

```ts
import { SecretVault } from "@turenlabs/core/secret-vault"

const vault = yield * SecretVault.Service
const value = yield * vault.seal("provider-auth", providerID, JSON.stringify(credential))

yield * storage.set({ scope, key, value })
```

Open the value only at the runtime boundary that needs the plaintext:

```ts
const stored = yield * storage.get({ scope, key })
if (!stored) return

const plaintext = yield * vault.open("provider-auth", providerID, stored.value)
const credential = yield * Schema.decodeUnknown(Schema.fromJsonString(Credential))(plaintext)
```

Always validate decrypted structured data with its existing schema. Do not return decrypted values from public HTTP
projections or include them in errors, logs, events, telemetry, or debug exports.

## Sensitive Files

`sealBytes` and `openBytes` support binary values up to 1 MiB:

```ts
const envelope = yield * vault.sealBytes("integration-files", fileID, content)
yield * fs.writeFileString(path, envelope)

const stored = yield * fs.readFileString(path)
const content = yield * vault.openBytes("integration-files", fileID, stored)
```

The file on disk contains only the text envelope. Continue to use owner-only file and directory permissions because
encryption does not replace access control.

The current API is intentionally for credentials and small files. Large or streaming files need a chunked authenticated
format rather than increasing the one MiB limit or buffering unbounded content.

## Scope And Key Rules

The scope provides domain separation. The logical key binds ciphertext to one record.

Good examples:

```text
scope = credential, key = cred_123
scope = internal/account/acct_123, key = access-token
scope = internal/mcp-auth/servers, key = entries
scope = session-share, key = share_123
```

Rules:

- Use stable domain names for scopes.
- Use immutable record IDs or field names for keys.
- Do not use labels, display names, timestamps, mutable file paths, or array positions.
- Do not reuse one ciphertext under another scope or key.
- Do not inspect or construct the envelope outside `SecretVault`.
- Do not use `SecretVault.ephemeral` outside tests.

## Existing Plaintext Migration

Repository startup migrations follow this sequence:

1. Read the existing value.
2. If it is a valid `forge-secret:v1` envelope, authenticate it before use.
3. Otherwise, validate it with the strict legacy schema.
4. Seal the validated value.
5. Replace the value transactionally or with the repository's existing compare-and-swap revision.

Never treat arbitrary non-envelope text as a valid legacy secret. Validation must happen before sealing so corrupt data is
not converted into apparently valid ciphertext.

`auth.json` and `mcp-auth.json` are atomically moved to unique staging paths before cleanup. A staged file is deleted only
when its exact contents are represented in encrypted storage. Conflicts or changed files are retained.

SQLite uses `PRAGMA secure_delete = ON`, but migration cannot guarantee forensic erasure from SSD wear leveling,
copy-on-write snapshots, external backups, or previously copied files. High-value credentials should be rotated when prior
plaintext exposure is a concern.

## Key Loading And Failure

Desktop startup loads or creates the wrapped key after `app.whenReady()` and after the final Electron `userData` path is
configured. A corrupt wrapped-key record is never overwritten automatically.

The encrypted database contains a non-secret active-key marker. If the OS-protected key ID does not match, startup fails
instead of creating mixed ciphertext with a new key.

If the OS key is permanently lost, existing local ciphertext cannot be recovered. Recovery means explicitly resetting the
local encrypted credentials and reconnecting providers. Do not silently regenerate a replacement key over an initialized
credential store.

## Tests

Tests should provide a deterministic 32-byte key through a layer:

```ts
const vault = SecretVault.layer({
  keyID: "test-key",
  key: new Uint8Array(32).fill(7),
})
```

Required coverage for a new secret repository includes:

- The durable value starts with `forge-secret:v1:`.
- The durable value does not contain the plaintext.
- Round-trip decoding returns the original typed value.
- A different scope or key fails authentication.
- Tampering fails authentication.
- Existing valid plaintext is migrated.
- A migration conflict does not overwrite a newer value.
- Public projections do not expose the decrypted value.

## Current Integrations

The vault currently protects:

- Provider API keys and OAuth access and refresh tokens.
- V2 integration credentials.
- MCP OAuth tokens and dynamic client secrets.
- TurenOS account access and refresh tokens.
- Legacy control-account tokens.
- Security-integration secrets.
- Legacy share revocation secrets.

Literal secrets in user-authored `forge.json` or `forge.jsonc`, shell profiles, and external environment files remain outside
the managed vault. New UI flows should persist such values in a credential repository and leave only an opaque reference in
configuration.
