# Keys and security

Which keychains and keys take part in a remote connection, and the security properties that result.

## Keychain and key material

Two different keychains touch this path, and neither one stores the remote's credentials.

**The OS keychain, through the credential vault.** The desktop's root secret is a random 32-byte key
wrapped by Electron `safeStorage` — the macOS Keychain item `Forge Safe Storage`, Windows DPAPI, or
libsecret/KWallet on Linux — and stored in `forge.settings` as `{version, keyID, wrappedKey}`. It is
unwrapped once at startup by
[`loadCredentialSecretKey`](../../../packages/desktop/src/main/secret-key.ts), so keychain prompts (if any)
happen at app launch, never per connect. A remote host has no keychain of its own: the SSH connect
ships `FORGE_SECRET_VAULT_KEY_ID` and the base64 key into the remote `ensure` command, and the
headless server reads exactly those two variables in
[`secret-vault.ts`](../../../packages/core/src/secret-vault.ts), deleting them from `process.env` as the
vault layer initializes. Without them, non-test startup fails rather than falling back to plaintext.

The consequence is that a remote's sealed credentials belong to _this desktop's_ keychain item. The
remote records the `keyID` it was first sealed with (`claimVault` in
[`packages/forge/src/auth/index.ts`](../../../packages/forge/src/auth/index.ts)); connecting with a
different key fails with `Stored credentials belong to another OS-protected key`. A second machine
therefore cannot silently adopt a remote that already holds credentials, and losing or rotating the
desktop keychain item strands the remote's sealed data. See
[Secure storage](../../systems/secure-storage.md) for the vault format and platform prompt behavior.

**The user's SSH keychain and agent — unmanaged.** TurenOS never runs `ssh-add`, never sets
`UseKeychain` or `AddKeysToAgent`, and never stores an SSH secret. Child processes inherit the
desktop's environment, so `SSH_AUTH_SOCK` is whatever launched the app; on macOS a Dock or Finder
launch inherits launchd's agent, which is where `ssh-add --apple-use-keychain` keys live. When the
key is loaded there, batch auth succeeds and the user sees no prompt at all. When it is not, the
in-app prompt collects the passphrase, writes it to the pty, and drops it — it is never persisted,
so the same passphrase is requested on the next connect. Loading the key into the agent, not
TurenOS, is what makes that prompt go away.

**The remote's HTTP password is not keychain material.** It is minted per start on the remote, kept
0600 in `~/.forge/run/server.auth`, returned over the SSH channel, and held only in main-process
memory and the mirrored renderer state. It is never written to local storage, and a remote restart
mints a new one.

**Key material never reaches argv.** The `ensure` call is the only step that carries the vault key,
and it is delivered the way the WSL backend delivers it — as a short script on stdin, built by
`remoteEnsureScript` and piped to `sh -s`:

```sh
FORGE_REMOTE_CORS='forge://- http://localhost:5173'
FORGE_SECRET_VAULT_KEY_ID='...'
FORGE_SECRET_VAULT_KEY='...'
export FORGE_REMOTE_CORS FORGE_SECRET_VAULT_KEY_ID FORGE_SECRET_VAULT_KEY
exec sh "$HOME/.forge/bin/forge-remote" ensure
```

The ssh command argument is the literal string `sh -s`, so neither the local `ssh` process nor the
remote login shell ever holds the key in a command line where `ps` could read it. Values are
single-quote escaped, so a quote in an origin cannot break out into the remote shell. Passing the
assignments as a `VAR=value cmd` prefix would also have required a POSIX login shell; piping works
under csh-family shells too.

The key enters the remote server through its startup environment. The vault removes both variables
from `process.env` when it initializes, limiting subsequent child-process inheritance. This does not
protect the key from the remote account or root: connecting trusts that host with the desktop vault
key, and clearing environment variables is not a guarantee of erasing the initial process environment.

## Security properties

- The remote listener binds `127.0.0.1` with a kernel-assigned port and is reachable only through
  the SSH forward from the desktop. Other processes on the remote can reach loopback too, so
  authentication remains required; its state files are 0600 under a 0700 directory.
- Every request must carry the per-start 16-byte random password. Most send it as an HTTP Basic
  `Authorization` header; the server also accepts the same base64 credentials in an `auth_token` query
  parameter, which the terminal WebSocket uses, so the password can appear in request URLs and any log
  that records them. Startup
  fails if secure password generation fails; new state and log files use a private umask.
- CORS allows the renderer origins passed in `FORGE_REMOTE_CORS`, but also any `http://localhost:*` or
  `http://127.0.0.1:*` origin, `forge-internal://renderer`, and the Tauri origins (`packages/server/src/cors.ts`).
  CORS is not the barrier; the password is.
- Destination arguments cannot inject ssh options; the destination is always the final argv element.
- Host keys are never silently accepted — the user confirms a new key with the fingerprint in view,
  and changed keys fail.
- The credential vault key is propagated so remote-stored secrets share the desktop's OS-protected
  key, and it travels on stdin rather than in any command line.
- Renderer IPC arrives through `TrustedIpc` and is validated before use.
