# Secure storage

TurenOS-managed credentials and small sensitive files must be encrypted with `SecretVault` before they are persisted. The
vault uses one random application key protected by the operating system and exposes authenticated encryption to Core and
TurenOS services.

## Security boundary

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
never written to the database, app config, renderer storage, or any command line. Native `forge serve` backends (WSL,
SSH, and headless) do receive it in their startup environment, as described next.

The desktop sidecar receives the raw key in the utility-process `start` message and installs it with
`SecretVault.configure` before the server layer graph builds. The WSL and SSH backends receive it as
`export` lines in a startup script piped over stdin (see [WSL backends](../operations/wsl.md) and
[SSH remote servers](../operations/ssh-remote/README.md)), so it reaches the native server's environment without
appearing in a command line. These bootstrap environment variables (`FORGE_SECRET_VAULT_KEY_ID`,
`FORGE_SECRET_VAULT_KEY`) are removed after vault configuration and before child tools are started. The removal clears
both `process.env` and, under Bun on Linux and macOS, the native environment through `unsetenv`
([`packages/core/src/process-env.ts`](../../packages/core/src/process-env.ts)), because terminals started with
`bun-pty` begin from the native environment; under Bun on Windows only `process.env` is cleared. That environment
bootstrap exists only for the Desktop's WSL and SSH quick-connect backends and for development. Removing a variable
does not remove it from `/proc/<pid>/environ` or `ps eww`, so it is **not supported for persistent servers**. Without
key material, non-test startup fails instead of using an ephemeral or plaintext key.

The Desktop main process checks the same two variables in its own environment before it touches `safeStorage`. When
both are set and the key decodes to 32 bytes, it uses that key instead of unwrapping the one in `forge.settings`
([`packages/desktop/src/main/index.ts`](../../packages/desktop/src/main/index.ts)). A Desktop launched with a different
key cannot read secrets sealed with the stored one.

### Host-owned key sources (persistent servers)

A persistent server loads its own key on the host. `forge serve --key-source <source>` (or
`FORGE_SECRET_VAULT_KEY_SOURCE`) selects the source; without one, `serve` uses the environment bootstrap. `serve`
loads the key and builds only a configuration runtime. `Server.listen` then installs the key with
`SecretVault.configure` and takes the database owner lock (`ServerOwnership.acquire`) before it builds the listener's
layer graph, the first one that can open the database:

- `systemd-credentials` reads the base64 key and key ID from the `forge-secret-vault-key` and
  `forge-secret-vault-key-id` credentials in `$CREDENTIALS_DIRECTORY`. Persistent mode requires this source.
- `env` selects the legacy environment bootstrap explicitly.

A macOS Keychain source is not implemented yet. It is waiting on the stage 0 LaunchDaemon test.

Set `FORGE_SERVER_MODE=persistent` and a stable, non-secret `FORGE_SERVER_ID` for a persistent server. The HTTP password
comes from the systemd credential named by `FORGE_SERVER_PASSWORD_CREDENTIAL`. `serve` passes it to `Server.listen`,
which keeps it in memory only: `ServerAuth.claimPassword` stores it in the in-process flag (removing any
`FORGE_SERVER_PASSWORD` from `process.env`), and `ServerAuth.listenerLayer` gives it to the listener's auth check and to
the in-process plugin SDK client. The password is never added to `process.env`.
Persistent startup refuses to start if the vault key or the HTTP password appears in the initial environment. It also
refuses an `env` key source or a missing server ID.

Key material must decode from canonical base64 to exactly 32 bytes, and the key ID must contain 1–128 letters, digits,
`.`, `_`, or `-`. A missing source, an inaccessible file, invalid material, a wrong key, multiple key IDs, or a database
owned by another server stops startup. None of these cases creates a key or falls back to a plaintext or ephemeral key.

### Database identity, ownership, and verification

- **Identity.** The database stores a random UUID in `storage_state` (`internal/database`, `uuid`). The data identity is
  the database path plus that UUID.
- **Owner lock.** Server startup holds an exclusive SQLite lock on `<realpath(db)>.owner.lock` for the life of the
  process. The OS releases it if the process dies. Every `Server.listen` caller takes it: the desktop sidecar,
  `forge serve` in either mode, and `forge acp`. So two current servers can't both run on one database. A CLI command
  that opens a quick-connect database without listening doesn't take the lock. In persistent mode
  (`FORGE_SERVER_MODE=persistent`), any open outside the process that holds the lock fails.
- **Owner record.** `internal/server-owner` records the server ID, key ID, mode (`quick-connect` or `persistent`), pid,
  and start time. Every database open checks it before migrations run, including CLI commands that don't take the lock.
  A persistent record requires the configured persistent mode and server ID. A quick-connect database becomes
  persistent only through explicit promotion by `forge persistent install`.
- **Verification.** When the lock carries the key, an existing database is inspected read-only before WAL setup or
  migrations; a wrong key cannot migrate it. After migrations the database layer seals or checks the sentinel before
  any service reads or writes a secret. `Auth` runs the same check for other entry points; when the database layer has
  already checked the same key ID, `Auth` only decrypts the sentinel to confirm the key bytes. The check scans every sealed
  store: `storage_state` (auth, MCP auth, extensions, security proxy), `credential`, `account`, `control_account`, and
  `session_share`. It refuses more than one key ID and opens every sealed value. On the first successful
  start it seals a sentinel bound to the database UUID. Every later start decrypts that sentinel. As a result, wrong key
  bytes under the correct key ID fail even when the provider-credentials record is empty.

`forge persistent verify-key --db <path>` runs the same inspection read-only, with the key on stdin. Use it before
promoting or restoring a database. See [Persistent server](../operations/persistent-server.md).

## On-disk locations

| Artifact                | Location                                                                    | Contents                                                                                               |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Wrapped application key | `forge.settings` (electron-store) in Electron `userData`                    | `credential-secret-key` record: `{version, keyID, wrappedKey}`; `wrappedKey` is safeStorage ciphertext |
| Sealed secret values    | `storage_state` table in the channel SQLite database                        | `forge-secret:v1:...` envelopes addressed by scope and logical key                                     |
| Legacy MCP auth file    | `mcp-auth.json` in `Global.Path.data` (staged as `mcp-auth.json.migrating`) | Plaintext predecessor of the sealed MCP auth row; migrated and removed                                 |

Concrete roots:

- macOS `userData`: `~/Library/Application Support/com.turenlabs.forge` (`com.turenlabs.forge.dev`,
  `com.turenlabs.forge.beta` for the other channels).
- Windows `userData`: `%APPDATA%\com.turenlabs.forge`.
- Linux `userData`: `~/.config/com.turenlabs.forge`.
- Database: `$XDG_DATA_HOME/forge/forge.db`, defaulting to `~/.local/share/forge/forge.db`. Non-release channels use
  `forge-<channel>.db` unless `FORGE_DISABLE_CHANNEL_DB` is set; `FORGE_DB` overrides the path entirely. The database,
  WAL, and SHM files are chmod `0600` where the platform supports it.

Electron derives the OS keychain item from `app.getName()` as `"<name> Safe Storage"`: "Forge Safe Storage" for the
prod channel, "Forge Beta Safe Storage" for beta, and "Forge Dev Safe Storage" for dev and unpackaged builds. The
internal app names deliberately keep `Forge` after the TurenOS rename so the existing Keychain item keeps decrypting the
wrapped key; changing them requires a credential migration.

## Platform behavior

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

## Cryptographic format

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

## String values

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

## Sensitive files

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

## Scope and key rules

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

## MCP credentials

Two durable shapes carry MCP secrets:

- Extension-declared secrets — API keys, hosted header bindings, and managed-package credentials such as
  `AUTOMOX_API_KEY` or `FALCON_CLIENT_SECRET` — live at scope `internal/extensions/<extension-id>`, key
  `secret/<declared-name>`. `ExtensionRuntime.update` seals them and writes them alongside the desired-state record in
  one guarded batch; `ExtensionRuntime.secret` returns a value only when the stored text is a valid `forge-secret:v1`
  envelope, so a plaintext or corrupted row reads as unset.
- Remote-server OAuth results live at scope `internal/mcp-auth/servers`, key `entries`: one sealed JSON map of server
  name to `{tokens, clientInfo, serverUrl, generation}`. PKCE verifiers and OAuth CSRF state for in-flight authorization
  are process-memory only and never persisted. The generation field fences stale writers during credential handoff.

At connect time `packages/forge/src/mcp` resolves declared secrets through `ExtensionRuntime.secret`, maps them into
transport headers or the child-process/container environment via `McpRuntime`, and attaches the resolved values to the
in-memory config entry under a private symbol. Resolved secret values are never written back to configuration or
storage, and connection diagnostics pass through `McpRuntime.redactDiagnostic` before surfacing.

A plaintext `mcp-auth.json` in `Global.Path.data` is atomically renamed to `mcp-auth.json.migrating`, imported under a
fingerprinted migration receipt, and deleted only when every imported name verifies in sealed storage. Unreadable or
conflicting staging files are restored, not dropped.

## Existing plaintext migration

Repository startup migrations follow this sequence:

1. Read the existing value.
2. If it is a valid `forge-secret:v1` envelope, authenticate it before use.
3. Otherwise, validate it with the strict legacy schema.
4. Seal the validated value.
5. Replace the value transactionally or with the repository's existing compare-and-swap revision.

Never treat arbitrary non-envelope text as a valid legacy secret. Validation must happen before sealing so corrupt data is
not converted into apparently valid ciphertext.

`auth.json` is atomically moved to a unique staging path (`auth.json.migrating-<pid>-<uuid>`) and `mcp-auth.json` to the
fixed `mcp-auth.json.migrating` before cleanup. A staged file is deleted only when its exact contents are represented in
encrypted storage. Conflicts or changed files are retained.

SQLite uses `PRAGMA secure_delete = ON`, but migration cannot guarantee forensic erasure from SSD wear leveling,
copy-on-write snapshots, external backups, or previously copied files. High-value credentials should be rotated when prior
plaintext exposure is a concern.

## Key loading and failure

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

## Current integrations

The vault currently protects:

- Provider API keys and OAuth access and refresh tokens.
- V2 integration credentials.
- Extension-declared MCP secrets and security-integration secrets (`internal/extensions/<extension-id>` scope).
- MCP OAuth tokens and dynamic client secrets (`internal/mcp-auth/servers` scope).
- TurenOS account access and refresh tokens.
- Legacy control-account tokens.
- Legacy share revocation secrets.

Literal secrets in user-authored `forge.json` or `forge.jsonc` (`environment`, `headers`, `oauth.clientSecret` fields in
`mcp` entries), shell profiles, and external environment files remain outside the managed vault. New UI flows should
persist such values in a credential repository and leave only an opaque reference in configuration.

## Source

- [`packages/core/src/secret-vault.ts`](../../packages/core/src/secret-vault.ts)
- [`packages/desktop/src/main/secret-key.ts`](../../packages/desktop/src/main/secret-key.ts)
- [`packages/forge/src/cli/secret-vault-key.ts`](../../packages/forge/src/cli/secret-vault-key.ts) and
  [`packages/forge/src/cli/server-password.ts`](../../packages/forge/src/cli/server-password.ts): host key and
  password sources.
- [`packages/forge/src/server/ownership.ts`](../../packages/forge/src/server/ownership.ts): persistent-mode checks and
  the owner lock.
- [`packages/core/src/database/server-owner.ts`](../../packages/core/src/database/server-owner.ts) and
  [`packages/core/src/database/vault-verification.ts`](../../packages/core/src/database/vault-verification.ts): the
  owner record and the key check before migrations.
