# @turenlabs/codemode

Effect-native confined code execution over explicit, schema-described host tools. A program can call only the tools its host supplies; the host retains authorization and durable-side-effect policy.

```ts
import { CodeMode, Tool } from "@turenlabs/codemode"

const runtime = CodeMode.make({ tools })
const result = yield * runtime.execute(code)
```

## Install

Within this workspace:

```json
{
  "dependencies": {
    "@turenlabs/codemode": "workspace:*"
  }
}
```

Hosts also depend on `effect` for tool implementations and results.

## Documentation

- [CodeMode overview](../../docs/systems/codemode/README.md): quick start, host authority, and scope.
- [API and result contract](../../docs/systems/codemode/api.md)
- [Tool discovery](../../docs/systems/codemode/discovery.md)
- [Language, limits, and diagnostics](../../docs/systems/codemode/execution.md)

## Testing

From this package directory:

```sh
bun test
bun run typecheck
```
