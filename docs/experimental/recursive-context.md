# Recursive context plugin

Status: prototype, as of 2026-09-25 (opt-in; TurenOS does not register it by default).

`@turenlabs/plugin/rlm-plugin` is a small, opt-in RLM-style context
externalizer. It is intentionally a context-management primitive, not an
automatic recursive model runner: it moves explicitly tagged prompt content
out of the provider message and gives the model bounded search and read tools.

## Setup

Create a local plugin module such as `.forge/plugins/rlm.ts`:

```ts
import { createRlmPlugin } from "@turenlabs/plugin/rlm-plugin"

export default createRlmPlugin({
  maxContextChars: 8_000_000,
  maxContextsPerSession: 32,
})
```

Add the module to the project's `forge.json`:

```json
{
  "$schema": "https://github.com/turenlabs/forge/config.json",
  "plugin": ["./.forge/plugins/rlm.ts"]
}
```

Mark a long input block explicitly so the plugin can preserve the surrounding
question while externalizing the bulk context:

```text
Compare the deployment behavior described in this context.

<!-- rlm-context name="deployment-notes" -->
...long context...
<!-- /rlm-context -->
```

## Behavior

The plugin replaces the marked block with a context handle and registers:

- `rlm_context_search` for focused lexical discovery
- `rlm_context_read` for bounded exact line ranges

Contexts are kept in memory for the plugin lifetime and scoped to the session
that created them. Search and read request the `rlm.context.read` permission.
The defaults bound one context to 8,000,000 characters, retain at most 32
contexts per session, return at most 20 search matches, and read at most 200
lines per call. The plugin does not execute generated code, call a second
model, or persist prompt content to disk.

After changing a plugin or `forge.json`, quit and restart TurenOS so the plugin
loader picks up the change.

## Source

- [`packages/plugin/src/rlm-plugin.ts`](../../packages/plugin/src/rlm-plugin.ts)
