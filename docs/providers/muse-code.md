# Muse Code provider

TurenOS can use the installed Muse Code CLI and its existing Meta login. Select
`Muse Code (local)` and `muse-code/muse-spark-1.3` in the model picker after
installing Muse and running `muse login` on the same machine.

The non-interactive command is `muse exec --json`, not `muse -p`. No Meta API key
is stored in TurenOS. Discovery checks installation only; login and model access
are verified when the first request runs. Restart or refresh the provider list
after installing the CLI.

## Supported Build

The initial bridge is qualified for **Muse Code 1.0.3 (1.0.3-R2198.1)**. Other
builds fail before a model turn starts. This is an intentional safety boundary:
Muse currently exposes native-tool exclusions rather than an MCP-only allowlist.
A new build must pass the real-CLI isolation test before it is enabled.

## Tool Routing

TurenOS replays its transcript on each provider turn. Muse receives a private
temporary workspace and settings, not the actual project directory or the user's
Muse settings, MCP servers, plugins, or workspace hooks. The bridge retains the
existing login through Muse's credential storage and does not copy credentials
into TurenOS. Ambient provider API keys and custom routing variables are not
forwarded.

All project tools run through the existing authenticated loopback MCP bridge and
TurenOS's normal permissions and settlement path. Muse's native work tools are
excluded from both its model-facing schema and executable registry. Shell, file
writes, and web tools are additionally disabled at launch. Muse's own approval
prompt is disabled only because the exposed work tools route to the host, which
still enforces approvals. The OS sandbox remains enabled.

This Muse build always injects its in-memory `write_todos` tool even when it is
excluded. It cannot modify the host project, but its updates are not TurenOS
todos; the bridge instructs Muse to use the host `todowrite` instead.

Interrupting a turn terminates the CLI process group on Unix and closes the
scoped MCP server. Prompt and output sizes are bounded; malformed JSONL, missing
terminal events, and unsuccessful exits fail visibly. Temporary files are
removed after completion or cancellation.

## Limitations

- Text-only input and output; attachments fail explicitly instead of being silently omitted.
- `exec` does not report token usage, so the bridge leaves usage unavailable rather than inventing counts or API costs.
- Each provider turn starts a fresh CLI session; CLI-side resume is not used.
- Model window limits use the exact Meta catalog entry when present, with conservative offline fallbacks.
- The signed-in and isolation checks have been run on macOS. File-backed login uses a symlink; platforms that disallow creating it fail rather than copying credentials.

## Verification

Run from `packages/core`:

```sh
bun test test/session-runner-muse-code.test.ts
FORGE_TEST_MUSE=1 bun test test/session-runner-muse-code-isolation.test.ts
FORGE_LIVE_MUSE=1 bun test test/session-runner-muse-code-live.test.ts
```

The isolation check runs the real installed CLI against a local scripted provider
with a dummy credential. It forces native tool calls and checks that they are
rejected while a host MCP call succeeds. It does not use subscription quota.
The live check uses the signed-in account and consumes provider usage. Set
`FORGE_LIVE_MUSE_CONFIG_HOME` for a non-default Muse configuration root; this is
needed only by the test because the normal test preload isolates XDG paths.
