# Claude Code provider

TurenOS can drive a locally installed Claude Code and reuse its existing Claude
subscription session, so no Anthropic API key is involved.

For how Claude Code's native tools are routed through TurenOS's policy and
settlement boundary once a session is running, see
[Claude Code tool routing](./tool-routing.md).

## Setup

Install Claude Code and authenticate it once:

```bash
claude auth login
claude auth status
```

TurenOS then discovers `Claude Code (local)` automatically in the Desktop model
picker, exposing `claude-code/fable`, `sonnet`, `opus`, and `haiku`.

## What it does

The provider launches the local Claude Code executable and uses the Claude
subscription session that `claude auth login` established.

TurenOS removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and
`ANTHROPIC_BASE_URL` from the child environment, so the executable cannot
silently fall back to API-key or proxy billing. Claude's native tools run
locally; TurenOS records their results and mediates permission requests.

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
