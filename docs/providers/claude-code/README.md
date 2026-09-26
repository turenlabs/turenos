# Claude Code provider

TurenOS can drive a locally installed Claude Code and reuse its existing Claude
subscription session, so no Anthropic API key is involved.

For how Claude Code's tool calls are routed through TurenOS's policy and
settlement boundary once a session is running, see
[Claude Code tool routing](./tool-routing.md).

## Setup

Install Claude Code and authenticate it once:

```bash
claude auth login
claude auth status
```

TurenOS then discovers `Claude Code (local)` automatically in the Desktop model
picker, exposing `claude-code/fable`, `sonnet`, `opus`, and `haiku`, plus pinned older model versions from the
Anthropic catalog.

## What it does

The provider launches the local Claude Code executable and uses the Claude
subscription session that `claude auth login` established.

TurenOS removes every `ANTHROPIC_*` variable, every `CLAUDE_CODE_USE_*`
variable, `CLAUDE_CODE_API_BASE_URL`, and `CLAUDE_CODE_OAUTH_TOKEN` from the
child environment, so the executable cannot silently fall back to API-key,
proxy, or alternate-provider billing. Claude's native tools are disabled
(`--tools ""`). Claude calls TurenOS's own tools through a private, turn-scoped
MCP server, so every call goes through TurenOS's permissions and tool
settlement.

## Configuration

To point at a non-standard executable, set it in `forge.json`:

```json
{
  "provider": {
    "claude-code": {
      "options": {
        "executable": "/path/to/claude"
      }
    }
  }
}
```

The configured path is what runs each turn: it is migrated into the provider's request body and applied after the
provider plugin. Availability is decided separately. The catalog plugin probes the default `claude` on `PATH` with
`claude auth status --json` (cached for 60 seconds) and enables the provider only when that install is signed in. A
non-standard executable therefore still needs a signed-in default `claude` on `PATH` for `Claude Code (local)` to
appear.
