# Devin CLI provider

TurenOS Session V2 can use an installed Devin CLI and its existing login. This local preview accepts qualified CLI builds and routes project tools through TurenOS.

## Setup

1. Install Devin on the machine that runs the TurenOS backend.
2. Run `devin --version` on that machine.
3. Check that it reports a [qualified build](#qualified-builds).
4. Run `devin auth login` if login is needed.
5. Open **Settings > Local Providers** in TurenOS.
6. Select **Devin CLI (local)** and select **Refresh**.
7. Choose a Devin model in the model picker. **Devin default** follows the CLI's default selection.
8. Choose a variant for reasoning effort, mode, or speed when Devin offers those options.

See the [Devin installation guide](https://docs.devin.ai/cli) for installation options. TurenOS does not install, update, or sign in to Devin. For SSH or WSL, install and authenticate it on that backend, not only on the Desktop machine.

Discovery checks whether the configured executable is installed. With an existing login file, TurenOS opens an isolated ACP session to read the available models and their options. Discovery sends no model prompt and caches the model list for 30 seconds. **Devin default** is available while discovery is unavailable.

ACP reports the options for the current model. TurenOS checks the default model and a bounded set of initial choices during discovery. It learns additional options when those models run. Refresh Local Providers to show newly learned options.

Variants combine the advertised reasoning effort, speed, and Code, Smart, Ask, or Plan mode. For example, `plan-high-fast` selects Plan mode, High reasoning, and Fast speed where the model supports that combination. TurenOS validates the selected values against ACP before sending the prompt. The host MCP bridge applies TurenOS tool permissions in each mode.

## Tool routing

Each TurenOS provider turn starts a new private ACP process and session. On builds with a shared daemon, TurenOS passes `--process-model in-process` to keep the agent in that process. TurenOS replays its durable history as text. The adapter does not resume a saved Devin session or use private mid-turn extensions. Queued inputs and steers use normal TurenOS provider-turn boundaries.

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

The runtime checks the exact build before ACP startup. ACP does not provide a client setting that disables the agent's native tools. Requalify each new build before adding it to `SUPPORTED_BUILDS`.

Authentication errors direct the user to `devin auth login`. Protocol errors, timeouts, and incomplete turns stop visibly without automatic prompt replay. Raw CLI diagnostics are not forwarded to the conversation.

## Verification

Run from `packages/core`:

```sh
bun test test/plugin/provider-devin-cli.test.ts test/session-runner-devin-cli.test.ts test/session-runner-claude-code-mcp.test.ts
FORGE_TEST_DEVIN=1 bun test --timeout 70000 test/session-runner-devin-cli-live.test.ts -t 'without inference'
FORGE_TEST_DEVIN=1 FORGE_TEST_DEVIN_LIVE=1 bun test --timeout 150000 test/session-runner-devin-cli-live.test.ts
bun typecheck
```

The unit tests include startup cancellation, text-only history replay, and MCP shutdown with an active notification stream. The first live command checks isolated startup and the existing login without a model prompt. The full live suite uses the signed-in account and consumes provider usage. It tests a tool-free summary, native read blocking with working and failed hooks, and access to the private MCP bridge.

Live tests restore the real credential data root because the normal Core test preload isolates XDG paths. Set `FORGE_LIVE_DEVIN_DATA_HOME` for a non-default data root. Product code uses the backend's configured `XDG_DATA_HOME` or the normal home-directory fallback.

Set `FORGE_TEST_DEVIN_EXECUTABLE` to test a specific CLI executable instead of the one on `PATH`.

## Qualified builds

These builds passed the live suite on macOS on 2026-11-22:

- `devin 3000.14.30821 (a09cd7f323ee)`
- `devin 3000.12.57 (96542e930752)`
- `devin 3000.12.32 (1126aba4a596)`
- `devin 3000.12.28 (91c3aec41579)`

Linux, WSL, and packaged Desktop execution still need qualification. See the [Devin CLI changelog](https://docs.devin.ai/cli/changelog/stable) for changes to the ACP process model and tool controls.

## Limits

- Input and output are text-only. Historical images and file tool results become explicit text placeholders. Direct unsupported media requests fail.
- Native Windows execution fails explicitly. Use a WSL backend.
- ACP initialization and session creation each have a 30-second deadline. A model prompt has a 15-minute deadline.
- Prompt and system text each have a 4 MiB limit. ACP output has an 8 MiB frame limit and 32 MiB total limit.
- TurenOS budgets the messages it replays in the ACP prompt. A fixed model starts with estimated limits of 32,768 context tokens and 8,192 output tokens. When ACP reports a window size, TurenOS uses that size for the same selection for ten minutes. Adaptive routing uses the fallback because its underlying model can change.
- ACP turn usage supplies processed-token totals. TurenOS uses those totals as context occupancy when they match the separate ACP context report. Devin's account plan controls billing.
- This provider targets Core Session V2. It does not add a Devin route to the legacy Forge session processor.
- Cloud sessions, `/handoff`, saved Devin-session loading, and live model switching are outside this preview.

The [adopted research](../experimental/devin-cli/README.md) records protocol evidence and vendor terms considerations.

## Source

- [`packages/core/src/provider/devin-cli.ts`](../../packages/core/src/provider/devin-cli.ts)
- [`packages/core/src/plugin/provider/devin-cli.ts`](../../packages/core/src/plugin/provider/devin-cli.ts)
- [`packages/core/src/plugin/provider.ts`](../../packages/core/src/plugin/provider.ts)
- [`packages/core/src/session/runner/devin-acp.ts`](../../packages/core/src/session/runner/devin-acp.ts)
- [`packages/core/src/session/runner/devin-options.ts`](../../packages/core/src/session/runner/devin-options.ts)
- [`packages/core/src/session/runner/model.ts`](../../packages/core/src/session/runner/model.ts)
- [`packages/core/src/session/runner/llm.ts`](../../packages/core/src/session/runner/llm.ts)
- [`packages/core/src/session/runner/claude-code-mcp.ts`](../../packages/core/src/session/runner/claude-code-mcp.ts)
- [`packages/core/test/session-runner-devin-cli-live.test.ts`](../../packages/core/test/session-runner-devin-cli-live.test.ts)
- [`packages/app/src/hooks/provider-visibility.ts`](../../packages/app/src/hooks/provider-visibility.ts)
- [`packages/app/src/components/dialog-connect-provider.tsx`](../../packages/app/src/components/dialog-connect-provider.tsx)
