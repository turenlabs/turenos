# Antigravity ACP provider

TurenOS can drive an installed Google Antigravity ACP server
(`agy_acp_server.par` on macOS/Linux, `agy_acp_server.exe` on Windows) over the
standard Agent Client Protocol (ACP v1 JSON-RPC 2.0 over stdio). Select
`Antigravity ACP (local)` and one of its Gemini models in the model picker after
installing the official `agy_acp_server` runtime and using **Sign in with Google**
in TurenOS to complete the runtime's `oauth-personal` sign-in. Installation
discovery does not verify authentication or account access to a model.

## Transport and model scope

Supply the official, unmodified runtime from the
[ACP Registry](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp).
Executable discovery checks that a command is available; it does not verify the
binary's publisher or checksum. Google's [extension setup guidance](https://antigravity.google/docs/ide/extensions/zed/)
and [Antigravity terms](https://antigravity.google/terms) describe the upstream
service and its conditions of use.

- TurenOS launches the configured ACP executable and uses JSON-RPC 2.0
  (`initialize`, `authenticate`, `session/new`, `session/set_config_option`,
  `session/set_model`, `session/prompt`, `session/cancel`). It does not wrap `agy -p`.
- The official runtime handles Google OAuth and persists its credentials.
  TurenOS holds the short-lived sign-in attempt state and browser authorization
  URL, without copying the runtime's Google access or refresh tokens into its
  credential store.
- The static Gemini catalog contains `gemini-3.8-flash`, `gemini-4-argon`,
  `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`, and `gemini-3-flash`.
  It offers `low`, `medium`, and `high` thinking-effort variants, except
  `gemini-3.1-pro`, which offers `low` and `high`.

These catalog entries are not an account-specific list from the running server.
Model and effort availability depend on the installed server and the account;
see Google's [model availability](https://antigravity.google/docs/models/).

## Setup

1. Install the official `antigravity-acp` archive from the ACP Registry, keeping
   its runtime files together (including `localharness_external` on macOS), so one of
   `agy_acp_server.par`, `agy_acp_server`, `antigravity-acp`, or
   `~/.local/opt/agy-acp/current/agy_acp_server.par` (`agy_acp_server.exe` on
   Windows) is available, or set `AGY_ACP_BIN` or the global configuration key
   `providers.antigravity-acp.request.body.executable`. Project configuration
   cannot choose the executable.
2. Open **Settings > Local Providers**. Choose **Sign in with Google** on the
   connected **Antigravity ACP (local)** row, or **Connect** if it is listed under
   available providers. Installation discovery can list it as connected before
   Google authentication has completed.
3. In the connection dialog, choose **Sign in with Google**, then use
   **Open Google sign-in** when the runtime supplies its browser link. Complete
   Google's consent flow in that browser while leaving the dialog open.
4. TurenOS verifies that the runtime can create an ACP session, then enables and
   refreshes the provider. Select an available Gemini model and start a turn.

TurenOS selects the runtime's advertised `oauth-personal` authentication method;
this setup does not require editing its settings file or installing another ACP
client. The existing runtime settings and credential files remain owned by the
runtime. A signed-in `agy` CLI alone is not a readiness check for the standalone
ACP server; this flow verifies ACP session creation instead.

The sign-in subprocess preserves the same `HOME` and `GEMINI_HOME` environment
values as model turns, so the runtime can use its native account profile in
both paths. TurenOS does not rewrite its settings file to select the method.

Use a browser that can reach the callback listener on the machine running the
TurenOS backend. The runtime's supported callback URL is HTTP on `127.0.0.1`,
`localhost`, or `::1`. If the backend is remote, the browser's loopback address
refers to the browser's machine; forward the runtime's callback port or complete
the browser flow on the backend host.

### Terminal client

In the TUI, open the model picker with `m`, then provider setup with `F2`.
Choose **Antigravity ACP (local)** and press `Enter` to sign in. The dialog
shows the runtime's Google authorization URL and polls until native session
creation verifies the login. Press `C` to cancel and wait for confirmation, or
`Esc` to go back and request cancellation. A late authorization response is
still cancelled by its attempt ID. The TUI does not launch a browser.

## Sign-in lifecycle

The backend starts one sign-in attempt per instance and keeps the ACP subprocess
alive while the browser flow is pending. Repeated starts join an active attempt.
Each instance spaces new runtime launches at least three seconds apart. Joining
a pending attempt is immediate, and rejected retries do not extend the delay.
Missing-runtime errors do not start a delay. There is no cumulative attempt limit.
It initializes ACP, checks that `oauth-personal` is advertised, calls
`authenticate`, and verifies completion with `session/new`. No model prompt is
sent during sign-in.

Only HTTPS Google authorization URLs on `accounts.google.com` with a supported
OAuth path and a loopback callback are sent to the connection dialog. Raw runtime
diagnostics are not returned as sign-in errors. Sign-in URLs are not added to the
conversation transcript.

**Cancel** requests cancellation of the matching pending attempt and waits for
the backend. **Back** and closing the dialog stop polling and send a cancellation
request. If cancellation cannot be confirmed while the dialog is open, it shows
an error rather than claiming that the process stopped. Instance disposal also
interrupts the attempt. Cancellation, failure, timeout, and success terminate the
runtime and its POSIX process group, then remove the temporary working directory. A failed or cancelled
attempt can be retried.

During a model turn, an explicit browser-authentication instruction from the
runtime ends that turn with sign-in guidance rather than waiting for browser
authentication inside the conversation. Google account links in ordinary startup
diagnostics do not trigger sign-in guidance. Return to the provider's sign-in dialog, then retry the turn.
If a fresh model subprocess requires authentication, the bridge calls its
advertised `oauth-personal` method once so the runtime can use its saved login,
then retries session creation. It does not copy tokens or loop on rejected login.

On Linux, the bridge passes `--uid=` when spawning `agy_acp_server.par` so the
self-extracting archive does not fail on `LookupGIDByGroupName`. On macOS, when
`~/.gemini/antigravity-acp/acp_token.json` exists and `AGY_ACP_FORCE_FILE_STORAGE`
is unset, the bridge sets `AGY_ACP_FORCE_FILE_STORAGE=1` so headless subprocesses
do not hang on Keychain prompts.

## Tool routing and isolation

Each provider turn runs in a private temporary directory with isolated
`XDG_CONFIG_HOME` and `XDG_DATA_HOME`. Ambient provider API keys
(`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and
process-injection variables (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`,
`NODE_OPTIONS`, `BASH_ENV`) are stripped from the child environment.
This changes the working directory and environment; it is not an OS sandbox.
The runtime remains a subprocess with the user's OS privileges.

During the ACP handshake:

- `initialize` advertises `clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`
  so client-side ACP filesystem and terminal callbacks are disabled.
- `session/new` registers the session-scoped loopback `forge` HTTP MCP server
  with its per-turn bearer token when the session turn has tools enabled.
- A server-to-client `session/request_permission` can select an advertised
  `allow_once` option only while a prompt is active, its session ID matches, a
  host MCP server is registered, and the tool has a programmatic Forge identity.
  The official runtime supplies `_meta.is_mcp_tool_call: true` and
  `_meta.mcp: { server: "forge", tool: "<tool>" }`; the bridge also accepts
  `toolCall.name: "mcp__forge__<tool>"` when metadata is absent. Tool names contain
  letters, digits, `_`, `.`, or `-`. Conflicting identities, display titles, and
  call IDs do not authorize execution. Other requests are rejected or cancelled;
  persistent approval is not selected.
- Calls through the authenticated `forge` MCP endpoint enter TurenOS's normal
  `PermissionV2` and tool-execution pipeline.

ACP completes its own tool loop inside a provider turn. TurenOS does not start
an extra todo-reconciliation turn after that loop completes.

Interrupting a turn sends `session/cancel` over stdio when an ACP session has
been created, closes stdin, terminates the runtime (`SIGTERM` then `SIGKILL`,
targeting its process group on POSIX), and removes the temporary directory.

## Verification

Run from the repository root:

```sh
(cd packages/core && bun test \
  test/provider-antigravity-acp-auth.test.ts \
  test/session-runner-antigravity-acp.test.ts \
  test/session-runner-antigravity-acp-mcp.test.ts \
  test/plugin/antigravity-acp.test.ts \
  test/plugin/provider-local-e2e.test.ts)
(cd packages/forge && bun test test/provider/antigravity-acp.test.ts)
(cd packages/client && bun test test/acp-login.test.ts)
(cd packages/tui && bun test test/model-connections-acp.test.ts test/providers-acp.test.ts --timeout 30000)
```

The authentication and transport tests use synthetic ACP subprocesses. They do
not establish signed-in Google model availability or successful live inference.

## Limits

- Text-only prompts and responses; media attachments fail explicitly before the
  ACP server subprocess starts.
- Prompts are bounded to 4 MiB, individual stdout lines to 8 MiB, and total
  stdout per turn to 32 MiB.
- Initialization, session creation, and model configuration must reach the
  prompt phase within 60 seconds. A timeout ends the turn with setup guidance
  and subprocess cleanup; this deadline does not limit an active prompt.
- The separate sign-in flow allows 60 seconds for ACP initialization, five
  minutes for Google authentication, and 60 seconds to verify session creation.
  Reaching a deadline ends the attempt with an error and subprocess cleanup.
- Sign-in output is bounded separately: 256 KiB per line and 2 MiB combined
  stdout and stderr for the attempt.
- The bridge does not record token usage from ACP `session/prompt` responses;
  usage is left absent and cost is recorded as `$0` (subscription-backed).
- Each provider turn starts a fresh ACP session and replays TurenOS's
  projected transcript.

## Source

- [`packages/core/src/provider/antigravity-acp.ts`](../../packages/core/src/provider/antigravity-acp.ts)
- [`packages/core/src/provider/antigravity-acp-auth.ts`](../../packages/core/src/provider/antigravity-acp-auth.ts)
- [`packages/core/src/session/runner/antigravity-acp-bridge.ts`](../../packages/core/src/session/runner/antigravity-acp-bridge.ts)
- [`packages/core/src/plugin/provider/antigravity-acp.ts`](../../packages/core/src/plugin/provider/antigravity-acp.ts)
- [`packages/core/src/config/plugin/provider.ts`](../../packages/core/src/config/plugin/provider.ts)
- [`packages/forge/src/provider/antigravity-acp.ts`](../../packages/forge/src/provider/antigravity-acp.ts)
- [`packages/forge/src/provider/antigravity-acp-auth.ts`](../../packages/forge/src/provider/antigravity-acp-auth.ts)
- [`packages/forge/src/server/routes/instance/httpapi/groups/provider.ts`](../../packages/forge/src/server/routes/instance/httpapi/groups/provider.ts)
- [`packages/app/src/components/dialog-antigravity-acp.tsx`](../../packages/app/src/components/dialog-antigravity-acp.tsx)
- [`packages/client/src/acp-login.ts`](../../packages/client/src/acp-login.ts)
- [`packages/app/src/components/settings-v2/local-providers.tsx`](../../packages/app/src/components/settings-v2/local-providers.tsx)

- [`packages/tui/src/model-connections/acp.ts`](../../packages/tui/src/model-connections/acp.ts)
- [`packages/tui/src/providers/acp.ts`](../../packages/tui/src/providers/acp.ts)
