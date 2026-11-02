# Devin CLI provider

TurenOS Session V2 can use an installed Devin CLI and its existing login. This local preview accepts one qualified CLI build and routes project tools through TurenOS.

## Setup

1. Install Devin on the machine that runs the TurenOS backend.
2. Run `devin --version` on that machine.
3. Check that it reports `devin 3000.11.228 (053434014dbd)`.
4. Run `devin auth login` if login is needed.
5. Open **Settings > Local Providers** in TurenOS.
6. Select **Devin CLI (local)** and select **Refresh**.
7. Select **Devin default** (`devin-cli/default`) in the model picker.

See the [Devin installation guide](https://docs.devin.ai/cli) for installation options. TurenOS does not install, update, or sign in to Devin. For SSH or WSL, install and authenticate it on that backend, not only on the Desktop machine.

Discovery checks the executable without starting Devin or reading credentials. A connected provider means installed, not authenticated. The first request checks CLI compatibility, login, and model access. Refresh after installing the executable or changing its global configuration.

The catalog exposes one model, `default`. The adapter omits `--model`, so Devin selects its account default. It does not enumerate models or import the user's Devin model configuration.

## Tool routing

Each TurenOS provider turn starts a new private ACP process and session. TurenOS replays its durable history as text. The adapter does not resume a saved Devin session or use private mid-turn extensions. Queued inputs and steers use normal TurenOS provider-turn boundaries.

The CLI receives a temporary home, XDG directories, session store, and empty working directory. The adapter links the existing `credentials.toml` for Devin to read. It does not parse the token or import an API credential into TurenOS. Inherited API keys, custom model routing, and shell startup overrides are not forwarded.

Private settings disable native tools, Codex tools, subagents, automatic updates, and local or foreign configuration imports. A fail-closed `PreToolUse` hook permits only the private `mcp__forge__*` namespace. ACP permission requests are rejected. TurenOS advertises no ACP filesystem or terminal capabilities.

Project tool calls use the existing authenticated loopback MCP bridge. It serves the current turn's filtered tool definitions and applies TurenOS permissions and settlement. ACP tool reports do not execute tools again or add duplicate tool cards.

The CLI is trusted host software. These settings are not an OS sandbox for the whole process. Organization-required plugins and startup hooks were not qualified; do not use this preview with policies that require them.

Cancellation stops the owned process group and closes its scoped MCP server. Normal completion and cancellation remove the temporary directory. A process or host crash can leave temporary files behind.

## Configuration

The provider ID is `devin-cli`. Its native API marker is `local://devin-cli`; this is not an HTTP endpoint.

By default, discovery resolves `devin` from the backend's `PATH`. A global TurenOS configuration can select another executable:

```json
{
  "providers": {
    "devin-cli": {
      "request": {
        "body": {
          "executable": "/absolute/path/to/devin"
        }
      }
    }
  }
}
```

Project configuration cannot select the executable. See [Configuration](../systems/configuration.md) for global configuration paths.

The runtime checks the exact qualified build before ACP startup. Another build fails rather than using untested tool controls. Requalify a new build before changing `SUPPORTED_VERSION`.

Authentication errors direct the user to `devin auth login`. Protocol errors, timeouts, and incomplete turns stop visibly without automatic prompt replay. Raw CLI diagnostics are not forwarded to the conversation.

## Verification

Run from `packages/core`:

```sh
bun test test/plugin/provider-devin-cli.test.ts test/session-runner-devin-cli.test.ts test/session-runner-claude-code-mcp.test.ts
FORGE_TEST_DEVIN=1 bun test --timeout 70000 test/session-runner-devin-cli-live.test.ts -t 'without inference'
FORGE_TEST_DEVIN=1 FORGE_TEST_DEVIN_LIVE=1 bun test --timeout 150000 test/session-runner-devin-cli-live.test.ts
bun typecheck
```

The unit tests include startup cancellation, text-only history replay, and MCP shutdown with an active notification stream. The first live command checks isolated startup and the existing login without a model prompt. The full live suite uses the signed-in account and consumes provider usage. It checks a blocked native read with working and failed hooks, then calls the private host MCP bridge.

Live tests restore the real credential data root because the normal Core test preload isolates XDG paths. Set `FORGE_LIVE_DEVIN_DATA_HOME` for a non-default data root. Product code uses the backend's configured `XDG_DATA_HOME` or the normal home-directory fallback.

The installed build passed these real-CLI checks on macOS on 2026-10-28. Linux, WSL, and packaged Desktop execution still need qualification.

## Limits

- Input and output are text-only. Historical images and file tool results become explicit text placeholders. Direct unsupported media requests fail.
- Native Windows execution fails explicitly. Use a WSL backend.
- ACP initialization and session creation each have a 30-second deadline. A model prompt has a 15-minute deadline.
- Prompt and system text each have a 4 MiB limit. ACP output has an 8 MiB frame limit and 32 MiB total limit.
- The catalog uses conservative context/output fallbacks of 32,768/8,192 tokens. These are not verified Devin model limits.
- Token usage and API costs remain unavailable. Devin's account plan controls billing; local execution does not mean offline inference.
- This provider targets Core Session V2. It does not add a Devin route to the legacy Forge session processor.
- Cloud sessions, `/handoff`, saved Devin-session loading, and live model switching are outside this preview.

The [adopted research](../experimental/devin-cli/README.md) records protocol evidence and vendor terms considerations.

## Source

- [`packages/core/src/provider/devin-cli.ts`](../../packages/core/src/provider/devin-cli.ts)
- [`packages/core/src/plugin/provider/devin-cli.ts`](../../packages/core/src/plugin/provider/devin-cli.ts)
- [`packages/core/src/plugin/provider.ts`](../../packages/core/src/plugin/provider.ts)
- [`packages/core/src/session/runner/devin-acp.ts`](../../packages/core/src/session/runner/devin-acp.ts)
- [`packages/core/src/session/runner/model.ts`](../../packages/core/src/session/runner/model.ts)
- [`packages/core/src/session/runner/llm.ts`](../../packages/core/src/session/runner/llm.ts)
- [`packages/core/src/session/runner/claude-code-mcp.ts`](../../packages/core/src/session/runner/claude-code-mcp.ts)
- [`packages/core/test/session-runner-devin-cli-live.test.ts`](../../packages/core/test/session-runner-devin-cli-live.test.ts)
- [`packages/app/src/hooks/provider-visibility.ts`](../../packages/app/src/hooks/provider-visibility.ts)
- [`packages/app/src/components/dialog-connect-provider.tsx`](../../packages/app/src/components/dialog-connect-provider.tsx)
